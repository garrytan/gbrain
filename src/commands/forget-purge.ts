/**
 * `gbrain forget <id> --purge` (#5575 C1, DX-11, DX-12): the CLI front of the
 * owner-only `purge_fact` operation.
 *
 *   gbrain forget <id> --purge [--dry-run] [--yes --request-id <uuid>] [--reason <text>]
 *                              [--all-subjects] [--vacuum] [--source <id>] [--json]
 *   gbrain forget --purge --match "<text>"            # list candidate ids; never purges
 *   gbrain forget --purge --status --request-id <uuid> # completion of an earlier purge
 *
 * It always runs the dry run first. On a terminal it prints that receipt
 * (residuals first) and asks the user to type the fact's 8-character token;
 * without a terminal it needs --yes and an explicit --request-id. The token
 * and the dry run's revision travel with the real call, so the owner (this
 * process or the resident owner behind its 0600 socket) purges exactly what
 * the user saw. Exit codes: 0 complete, 10 committed with effects still
 * pending, 75 incomplete (retry with the same request id), 3 not confirmed.
 */

import type { BrainEngine } from '../core/engine.ts';
import { loadConfig, isThinClient } from '../core/config.ts';
import { opError } from '../core/ops/contract.ts';
import { isInteractive, readLine } from '../core/interaction.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { CONFIRMATION_REQUIRED_EXIT_CODE } from '../core/exit-codes.ts';
import { resolveSourceId } from '../core/source-resolver.ts';

export const PURGE_FAMILY_HELP = `Purge family (remove content from live stores; never physical erasure):
  gbrain forget <id> --purge            purge one fact's claim (dry-run receipt, then a typed token)
  gbrain delete <slug> --purge          purge a page and its derived rows, with a page tombstone
  gbrain pages purge-deleted            hard-delete pages soft-deleted more than 72h ago
  gbrain sources purge <id>             remove a whole source
  gbrain pages purges list              list page purge tombstones
  gbrain pages unpurge <slug>           clear a page tombstone so the content can be imported again
`;

const USAGE = `Usage: gbrain forget <fact-id> [--reason <text>] [--source <id>] [--request-id <uuid>] [--json]
       (withdraws the fact: it expires and cannot be re-saved; the text stays in history and backups)
       gbrain forget <fact-id> --purge [--dry-run] [--yes --request-id <uuid>] [--reason <text>] [--all-subjects] [--vacuum] [--source <id>] [--json]
       gbrain forget --purge --match "<text>"
       gbrain forget --purge --status --request-id <uuid>

${PURGE_FAMILY_HELP}`;

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.findIndex(a => a === name || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  return args[i].startsWith(`${name}=`) ? args[i].slice(name.length + 1) : args[i + 1];
}

type Invoke = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Run purge_fact on this host: through the resident owner when one holds the brain, else in-process as the trusted CLI. */
function invoker(engine: BrainEngine | (() => Promise<BrainEngine>), source: string | null): Invoke {
  return async params => {
    const cfg = loadConfig();
    const { maybeDelegateLocalOperation } = await import('../core/persistence/local-client.ts');
    const { getCliOptions } = await import('../core/cli-options.ts');
    const cli = getCliOptions();
    const delegated = await maybeDelegateLocalOperation('purge_fact', params, cfg, { brain: cli.brain, source, timeoutMs: cli.timeoutMs ?? undefined });
    if (delegated.handled) return delegated.result as Record<string, unknown>;
    const connected = typeof engine === 'function' ? await engine() : engine;
    const sourceId = await resolveSourceId(connected, source);
    const { operations } = await import('../core/operations.ts');
    const op = operations.find(o => o.name === 'purge_fact')!;
    return await op.handler({ engine: connected, config: cfg ?? { engine: 'pglite' }, remote: false, dryRun: false, sourceId,
      logger: { info: console.log, warn: console.warn, error: console.error } }, params) as Record<string, unknown>;
  };
}

type Report = { store: string; status: string; removed?: number; remaining?: number; reason?: string; detail?: string };

/** Human receipt: residuals first, then each swept store. Never prints claim text. */
export function renderPurgeReceipt(r: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`${r.dry_run ? 'Purge dry run' : 'Purge'} for fact ${r.fact_id} (hash ${r.hash8}, subject ${r.subject}, ${r.visibility})`);
  if (typeof r.summary === 'string') lines.push(r.summary);
  lines.push('', 'Residuals (not removed by purge):');
  for (const s of (r.residuals as Report[] | undefined) ?? []) {
    lines.push(`  - ${s.store}: ${s.status}${s.reason ? ` (${s.reason})` : ''}${s.remaining ? `, ${s.remaining} found` : ''}${s.detail ? ` — ${s.detail}` : ''}`);
  }
  lines.push('', `Live stores${r.dry_run ? ' (would remove)' : ''}:`);
  for (const s of (r.stores as Report[] | undefined) ?? []) {
    if (s.status === 'not_present') continue;
    lines.push(`  - ${s.store}: ${s.status}${s.removed !== undefined ? `, ${s.removed}` : ''}${s.remaining ? `, ${s.remaining} remaining` : ''}${s.reason ? ` (${s.reason})` : ''}`);
  }
  if (typeof r.completion === 'string') lines.push('', `Completion: ${r.completion}${r.request_id ? ` (request ${r.request_id})` : ''}`);
  for (const n of (r.next as string[] | undefined) ?? []) lines.push(`Next: ${n}`);
  return lines.join('\n') + '\n';
}

/** Test seam: the terminal probe and the typed-token reader (defaults: isInteractive and a stderr prompt). */
export interface PurgeCliIo { interactive?: () => boolean; readToken?: (prompt: string) => Promise<string | null> }

/** `gbrain forget` argv this module handles: a purge, its help, and a --dry-run (which a plain forget refuses here, since it has none). */
export function routesToForgetPurge(args: readonly string[]): boolean {
  return args.includes('--purge') || args.includes('--dry-run') || args.includes('--help') || args.includes('-h');
}

export async function runForgetPurge(engine: BrainEngine | (() => Promise<BrainEngine>), args: string[], io: PurgeCliIo = {}): Promise<void> {
  const json = args.includes('--json');
  const { reportPersistenceCliError } = await import('./persistence-delegate.ts');
  const { parseWriteRequestId } = await import('../core/persistence/preconditions.ts');
  const { purgeHostOnly } = await import('../core/facts/purge.ts');
  const out = (value: Record<string, unknown>, human: string) => process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : human);
  try {
    if (args.includes('--help') || args.includes('-h')) { process.stdout.write(USAGE); return; }
    const idArg = args.find(a => /^\d+$/.test(a));
    if (!args.includes('--purge')) {
      throw opError('invalid_params', '--dry-run previews a purge only; a plain forget has no dry run, so nothing was forgotten.',
        idArg ? `Run gbrain forget ${idArg} --purge --dry-run to preview a purge, or gbrain forget ${idArg} to forget the fact.` : 'Run gbrain forget --help for the forget and purge forms.');
    }
    const cfg = loadConfig();
    if (isThinClient(cfg)) throw purgeHostOnly(idArg);
    const requestId = parseWriteRequestId(flagValue(args, '--request-id'));
    const invoke = invoker(engine, flagValue(args, '--source') ?? null);
    if (args.includes('--status')) {
      if (!requestId) throw opError('invalid_params', '--status needs --request-id.', 'Pass the request id the purge printed.');
      const status = await invoke({ status: true, request_id: requestId });
      out(status, `Purge ${requestId}: ${status.completion} (${status.state})\n${((status.effects as Array<{ kind: string; state: string }>) ?? []).map(e => `  effect ${e.kind}: ${e.state}`).join('\n')}\n`);
      setCliExitVerdict(Number(status.exit_code ?? 0));
      return;
    }
    const match = flagValue(args, '--match');
    if (match !== undefined) {
      const found = await invoke({ match });
      const rows = (found.candidates as Array<{ id: number; entity_slug: string | null; visibility: string; expired: boolean; fact: string }>) ?? [];
      out(found, rows.length ? `${rows.map(c => `  #${c.id} ${c.entity_slug ?? '(no entity)'} [${c.visibility}${c.expired ? ', expired' : ''}] ${c.fact}`).join('\n')}\nPick one id: gbrain forget <id> --purge\n` : 'No fact in this source contains that text.\n');
      return;
    }
    if (!idArg) { process.stderr.write(USAGE); setCliExitVerdict(1); return; }
    const reason = flagValue(args, '--reason');
    const base = { id: Number(idArg), ...(reason !== undefined ? { reason } : {}), ...(args.includes('--all-subjects') ? { all_subjects: true } : {}) };
    const dry = await invoke({ ...base, dry_run: true });
    if (args.includes('--dry-run')) { out(dry, renderPurgeReceipt(dry)); return; }
    const token = String(dry.confirm_token);
    if ((io.interactive ?? isInteractive)() && !args.includes('--yes')) {
      process.stdout.write(renderPurgeReceipt(dry));
      const prompt = `\nType ${token} to purge fact ${idArg} from live stores (anything else cancels): `;
      const answer = io.readToken ? await io.readToken(prompt) : await readLine({ prompt, output: process.stderr }).then(r => r.kind === 'line' ? r.text : null);
      if (answer === null || answer.trim() !== token) {
        process.stderr.write('Not purged.\n');
        setCliExitVerdict(CONFIRMATION_REQUIRED_EXIT_CODE);
        return;
      }
    } else if (!args.includes('--yes') || !requestId) {
      throw opError('confirmation_required', 'A purge without a terminal needs --yes and --request-id.',
        `Show the user the dry run (gbrain forget ${idArg} --purge --dry-run), then, with their agreement, run gbrain forget ${idArg} --purge --yes --request-id <new uuid>. Reuse that request id to retry.`,
        { fix: { argv: ['gbrain', 'forget', idArg, '--purge', '--dry-run', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'Prints what the purge would remove, residuals first, without changing anything.' } });
    }
    const done = await invoke({ ...base, confirm: token, expected_revision: dry.expected_revision, request_id: requestId ?? dry.request_id,
      ...(args.includes('--vacuum') ? { vacuum: true } : {}) });
    out(done, renderPurgeReceipt(done));
    setCliExitVerdict(Number(done.exit_code ?? 0));
  } catch (error) {
    if (!await reportPersistenceCliError(error, json)) throw error;
    // Not confirmed: 3 (ask the user). A pending write blocks the sweep: 75 (retry later with the same request id).
    const code = (error as { canonical?: string; code?: string }).canonical ?? (error as { code?: string }).code;
    if (code === 'confirmation_required') setCliExitVerdict(CONFIRMATION_REQUIRED_EXIT_CODE);
    else if (code === 'purge_blocked_pending_recovery') setCliExitVerdict(75);
  }
}
