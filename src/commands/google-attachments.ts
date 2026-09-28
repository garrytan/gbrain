import type { BrainEngine } from '../core/engine.ts';
import { getCliOptions } from '../core/cli-options.ts';
import { finishCliTeardown, setCliExitVerdict, writeStdoutFinal } from '../core/cli-force-exit.ts';
import { isThinClient, loadConfig, toEngineConfig } from '../core/config.ts';
import { resolveBrainId } from '../core/brain-resolver.ts';
import { loadMounts } from '../core/brain-registry.ts';
import { persistenceConfigForBrain } from '../core/persistence/local-client.ts';
import { readLocalWriter, withVerifiedLocalRegistration } from '../core/persistence/identity.ts';
import { OperationError } from '../core/ops/contract.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { parseGoogleSourceConfig, runGoogleAttachmentBackfill } from '../core/google/google-source.ts';
import type { FetchImpl } from '../core/google/google-clients.ts';
import { managedSyncAuthority } from '../core/persistence/sync-authority.ts';
import { connectorCheckpointKey } from '../core/persistence/connector-sync.ts';
import type { GoogleSourceState } from '../core/google/types.ts';
import { isCredentialError } from '../core/creds/errors.ts';

export const GOOGLE_ATTACHMENTS_HELP = `Usage: gbrain google attachments backfill --source <id> [--brain <id>] [--yes] [--limit 1-25] [--retry-failed] [--json]

Without --yes, inspect the selected source without contacting Google or changing metadata.
With --yes, repair attachment receipts on at most 25 already-imported thread pages.
Managed persistence and an existing trusted local CLI registration are required.
This command never enables persistence/services, downloads attachments, or extracts facts.
It preserves page content and resumes its account-bound historical cursor on the next run.
Complete means traversal of this fixed set, not successful inspection of unavailable messages or the entire mailbox.
Confirmed upstream absence preserves prior receipts, records unavailable identities, and does not block later pages.
Paused/incomplete apply returns a nonzero exit status; repeat the same command to resume a paused batch.
Inspect conflicts before retrying; --retry-failed explicitly approves a terminal failed receipt.
Run on the canonical host with the selected PGLite brain idle; remote delegation is not supported.
See docs/guides/google-connect.md#attachment-receipts-and-historical-repair`;

export function parseGoogleAttachmentsArgs(args: string[]) {
  if (args[0] !== 'backfill') throw new OperationError('invalid_params', 'Select the attachment backfill subcommand.');
  const flags = new Map<string, string | true>();
  for (let i = 1; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (!['--source', '--brain', '--limit', '--yes', '--json', '--retry-failed'].includes(flag) || flags.has(flag)) throw new OperationError('invalid_params', 'Unknown or duplicate attachment repair option.');
    if (['--yes', '--json', '--retry-failed'].includes(flag)) {
      if (inline !== undefined) throw new OperationError('invalid_params', 'Boolean attachment repair options do not accept values.');
      flags.set(flag, true);
    } else {
      const value = inline ?? args[++i];
      if (!value || value.startsWith('-') || value.includes('\0')) throw new OperationError('invalid_params', 'An attachment repair option needs a value.');
      flags.set(flag, value);
    }
  }
  const sourceId = flags.get('--source');
  if (!isValidSourceId(sourceId)) throw new OperationError('invalid_params', 'Select one explicit valid Google source ID.');
  const limit = flags.has('--limit') ? Number(flags.get('--limit')) : 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new OperationError('invalid_params', 'Attachment repair limit must be 1-25.');
  const brain = flags.get('--brain') as string | undefined;
  if (brain && !isValidSourceId(brain)) throw new OperationError('invalid_params', 'Select a valid brain ID.');
  if (flags.has('--retry-failed') && !flags.has('--yes')) throw new OperationError('invalid_params', '--retry-failed requires --yes.');
  return { sourceId, limit, brain, yes: flags.has('--yes'), json: flags.has('--json'), retryFailed: flags.has('--retry-failed') };
}

export async function runGoogleAttachments(args: string[], connected?: BrainEngine, fetchImpl?: FetchImpl): Promise<void> {
  if (!args.length || args.includes('--help') || args.includes('-h')) { process.stdout.write(GOOGLE_ATTACHMENTS_HELP + '\n'); return; }
  let owned: BrainEngine | undefined;
  let applyAttempted = false;
  try {
    const parsed = parseGoogleAttachmentsArgs(args);
    const brain = resolveBrainId(parsed.brain ?? getCliOptions().brain);
    const config = persistenceConfigForBrain(loadConfig(), brain, brain === 'host' ? [] : loadMounts());
    if (!connected && (!config || isThinClient(config))) throw new OperationError('permission_denied', 'Attachment repair requires the configured canonical host, not a remote token.');
    if (!connected) {
      const { createEngine } = await import('../core/engine-factory.ts');
      owned = await createEngine(toEngineConfig(config!));
      await owned.connect(toEngineConfig(config!));
    }
    const engine = connected ?? owned!;
    const registration = await readLocalWriter(engine, 'cli');
    const result = await withVerifiedLocalRegistration(engine, registration, async () => {
      const [source] = await engine.executeRaw<{ config: Record<string, unknown>; incarnation: string; local_path: string | null; archived: boolean }>('SELECT config,incarnation,local_path,archived FROM sources WHERE id=$1', [parsed.sourceId]);
      if (!source || source.archived || source.config.kind !== 'google') throw new OperationError('invalid_params', 'Select an active Google source.');
      const [mode] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
      if (!mode?.enabled) throw new OperationError('writer_coordinator_required', 'Attachment repair requires already-enabled managed persistence.');
      await managedSyncAuthority(engine, parsed.sourceId, source.incarnation, source.local_path ?? '');
      const cfg = parseGoogleSourceConfig(source.config, source.local_path ?? '');
      if (!parsed.yes) {
        const [count] = await engine.executeRaw<{ count: string }>(`SELECT count(*)::text AS count FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND frontmatter->>'thread_id' IS NOT NULL`, [parsed.sourceId]);
        const [checkpoint] = await engine.executeRaw<{ completed_keys: Array<{ state: GoogleSourceState }> }>(
          "SELECT completed_keys FROM op_checkpoints WHERE op='managed-connector' AND fingerprint=$1",
          [connectorCheckpointKey(parsed.sourceId, source.incarnation, 'google', source.config)]);
        return { status: 'preview' as const, complete: false, imported_thread_pages: Number(count.count), account: cfg.account, writes: 'none',
          historical_inspection: checkpoint?.completed_keys[0]?.state?.gmail_attachment_backfill ?? { status: 'not_inspected' } };
      }
      applyAttempted = true;
      return { ...await runGoogleAttachmentBackfill(engine, parsed.sourceId, cfg, { limit: parsed.limit, retryFailed: parsed.retryFailed }, fetchImpl), account: cfg.account };
    });
    const complete = result.status === 'complete';
    const summary = { ok: !parsed.yes || complete, ...result, brain, source: parsed.sourceId, limit: parsed.limit,
      scope: 'already-imported Gmail thread pages; not mailbox-wide', doc_url: 'docs/guides/google-connect.md#attachment-receipts-and-historical-repair',
      next_action: { user_message: result.status === 'paused' ? 'Repeat the same authorized command to resume the saved cursor.' : result.status === 'incomplete' ? 'Receipt inspection is incomplete. The cursor did not pass the incomplete page; inspect it before retrying.' : result.status === 'complete' && result.unavailable ? `Traversal is complete, but ${result.unavailable} pages contain ${result.unavailableMessages} unavailable historical messages. Prior receipts remain; those identities were not inspected this run.` : parsed.yes ? 'Inspect gmail_attachment_receipts on the authorized message pages.' : 'Review this source/account scope, then pass --yes to apply one bounded batch.' } };
    if (parsed.json) await writeStdoutFinal(JSON.stringify(summary, null, 2) + '\n');
    else process.stdout.write(`[SHOW USER]\nAttachment repair: ${result.status}; brain=${brain}; source=${parsed.sourceId}; account=${result.account}.\n${summary.scope}.\n${summary.next_action.user_message}\n${summary.doc_url}\n[/SHOW USER]\n`);
    if (parsed.yes && !complete) setCliExitVerdict(1);
  } catch (error) {
    const code = error instanceof OperationError || isCredentialError(error) ? error.code : 'repair_failed';
    const failure = { ok: false, status: 'failed', writes: applyAttempted ? 'durable_partial_work_possible' : 'none', error: { code, problem: 'Attachment repair did not complete.', cause: code === 'repair_failed' ? 'unknown' : code,
      fix: 'Inspect the selected canonical source and retained write receipt before retrying. Completed metadata and cursor checkpoints remain durable; no message body is replayed.',
      doc_url: 'docs/guides/google-connect.md#attachment-receipts-and-historical-repair' } };
    if (args.includes('--json')) await writeStdoutFinal(JSON.stringify(failure, null, 2) + '\n');
    else process.stderr.write(`${failure.error.problem} ${failure.error.fix}\n${failure.error.doc_url}\n`);
    setCliExitVerdict(code === 'invalid_params' ? 2 : 1);
  } finally { if (owned) await finishCliTeardown({ engine: owned, drainTimeoutMs: 1000 }); }
}
