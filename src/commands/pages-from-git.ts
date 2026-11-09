/**
 * Wave C 1I-a (spec §2.6, §3.6, dx-r3-native-8; unsplit pages): the two per-page repair verbs of a strict source.
 *
 * - `gbrain pages verify <slug> [--source <id>] [--json]` (read-only) answers "does the database's view of this page equal
 *   Git's committed bytes?" with the git-gap census's equality contract (sources-git-gap.ts `censusGitGap` scoped to the
 *   one slug: the page's export view against its blob at HEAD). A page whose committed head waits for its index step, or
 *   was held by it, is not equal: its rows show the generation before it. Exit 0 with `ok: true`, or 1 with the state, the
 *   differing fields and the fix (the receipt while indexing, else the reindex preview).
 * - `gbrain pages reindex <slug> --from-git [--source <id>] [--dry-run | --apply --expect <hash>] [--no-embed] [--json]` re-derives
 *   one page from the file HEAD commits. The default preview names HEAD, the blob, the page's state and a hash bound to all
 *   of them; `--apply --expect <hash>` refuses `preview_changed` when any moved, then imports the committed file through the
 *   source's owner (the import the index step runs, so it is not refused while the head is pending) and flips a pending or
 *   held head to that commit. The working-tree file must be the committed blob. Trusted local CLI only: it prints paths.
 *
 * Split pages (over PAGE_MAX_BYTES) and `--deep` are PR 5's and 3A's.
 */
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { exitCodeForCode } from '../core/error-catalogue.ts';
import { cliRenderContext, renderAction, toAgentError, type Action } from '../core/agent-output.ts';
import { OperationError, opError } from '../core/ops/contract.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { readPendingHead, type PendingHead } from '../core/persistence/git-first.ts';
import { importManagedFile } from '../core/persistence/import-mutations.ts';
import { getWorktreeBinding } from '../core/persistence/ownership.ts';
import { committedBlob, headBlob } from '../core/persistence/pending-import.ts';
import { previewChangedError, previewHash } from '../core/persistence/preview-approval.ts';
import { declarePersistenceProtocol } from '../core/persistence/protocol.ts';
import { censusGitGap, type GitGapPage } from './sources-git-gap.ts';
import { exportBodyLedger, readExportPage, readExportWithdrawals, segmentedExportHead, segmentedExportMarkdown } from '../core/export-snapshot.ts';
import { gitChildEnv } from '../core/git-env.ts';
import { parseMarkdown } from '../core/markdown.ts';
import { PAGE_MAX_BYTES } from '../core/page-size-policy.ts';
import { digest } from '../core/persistence/digest.ts';
import { execFileSync } from '../core/spawn.ts';

export const PAGES_VERIFY_USAGE = 'Usage: gbrain pages verify <slug> [--source <id>] [--json]';
export const PAGES_REINDEX_USAGE = 'Usage: gbrain pages reindex <slug> --from-git [--source <id>] [--dry-run | --apply --expect <hash>] [--no-embed] [--json]';
const DOCS = 'docs/architecture/key-files/large-page-writes.md';

export type VerifyState = GitGapPage['state'] | 'indexing' | 'index_held';

export interface PageVerification {
  ok: boolean;
  source_id: string;
  slug: string;
  /** The commit compared against (HEAD of the source's checkout). */
  head: string | null;
  state: VerifyState;
  /** The page's file, relative to the source's checkout. */
  path: string | null;
  /** The canonical fields that differ (git-gap's drift paths), when the page and its blob differ. */
  differing: string[];
  indexed_commit: string | null;
  pending: { request_id: string; commit: string; hold_code: string | null } | null;
  why: string;
  fix: Action | null;
}

interface Located { verification: PageVerification; page: GitGapPage | null; pending: PendingHead | null; revision: string | null }

function parse(args: readonly string[], usage: string, flags: readonly string[]): { slug: string; source: string | null; json: boolean; flags: Set<string>; expect: string | null } {
  const positional: string[] = [];
  let source: string | null = null, expect: string | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--source') { source = args[++i] ?? null; if (!source || source.startsWith('-')) throw opError('invalid_params', '--source needs a source id.', usage); continue; }
    if (arg === '--expect' && flags.includes('--expect')) { expect = args[++i] ?? null; if (!expect) throw opError('invalid_params', '--expect needs the preview hash.', usage); continue; }
    if (arg === '--json') { seen.add(arg); continue; }
    if (flags.includes(arg)) { seen.add(arg); continue; }
    if (arg.startsWith('-')) throw opError('invalid_params', `Unknown option: ${arg}.`, usage);
    positional.push(arg);
  }
  if (positional.length !== 1) throw opError('invalid_params', 'Name exactly one page slug.', usage);
  return { slug: positional[0]!, source, json: seen.has('--json'), flags: seen, expect };
}

const reindexPreviewFix = (slug: string, sourceId: string): Action => ({ argv: ['gbrain', 'pages', 'reindex', slug, '--source', sourceId, '--from-git', '--dry-run'],
  consent: [], actor: 'agent', requires_exclusive: false, why: 'Read-only preview of re-indexing the page from its committed file; apply it with the --expect hash it prints.',
  verify: { argv: ['gbrain', 'pages', 'verify', slug, '--source', sourceId, '--json'] } });

/**
 * The census compares a segmented page byte for byte, but its export renders frontmatter in the database's key order (jsonb
 * reorders keys), so a committed file whose keys are in another order reads as different. An unsplit page (at most
 * PAGE_MAX_BYTES) is read whole on both sides instead and compared by its parsed fields: frontmatter (key order aside),
 * title, type and body.
 */
async function unsplitSegmentedEqual(engine: BrainEngine, sourceId: string, page: GitGapPage, root: string): Promise<boolean> {
  if (!page.segmented || !page.headBlob) return false;
  const [size] = await engine.executeRaw<{ bytes: number }>('SELECT body_bytes AS bytes FROM pages WHERE id = $1::bigint', [page.id]);
  if (Number(size?.bytes ?? Infinity) > PAGE_MAX_BYTES) return false;
  const blob = execFileSync('git', ['-C', root, 'cat-file', 'blob', page.headBlob], { encoding: 'utf8', env: gitChildEnv(), maxBuffer: 2 * PAGE_MAX_BYTES, stdio: ['ignore', 'pipe', 'ignore'] }) as string;
  const withdrawals = await readExportWithdrawals(engine, sourceId);
  const snapshot = await readExportPage(engine, { id: page.id, source_id: sourceId, slug: page.slug }, withdrawals);
  let exported = '';
  for await (const piece of segmentedExportMarkdown(engine, snapshot.page, exportBodyLedger(page.slug, withdrawals), segmentedExportHead(snapshot))) {
    exported += typeof piece === 'string' ? piece : Buffer.from(piece).toString('utf8');
  }
  const fields = (text: string) => { const parsed = parseMarkdown(text, `${page.slug}.md`); return digest({ frontmatter: parsed.frontmatter, title: parsed.title, type: parsed.type, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline }); };
  return fields(blob) === fields(exported);
}

async function locate(engine: BrainEngine, sourceId: string, slug: string): Promise<Located> {
  let page: GitGapPage | null = null;
  const census = await censusGitGap(engine, sourceId, { sample: 1, slugs: [slug], collect: found => { page = found; } });
  const found = page as GitGapPage | null;
  const pending = await readPendingHead(engine, sourceId, slug);
  if (!found && !pending) throw opError('page_not_found', `Page not found: ${slug} (source ${sourceId}).`, `Check the slug with gbrain pages status ${slug} --source ${sourceId}.`);
  const [row] = await engine.executeRaw<{ indexed_commit: string | null }>('SELECT indexed_commit FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, slug]);
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id = $1', [sourceId]);
  const sameFields = !pending && found && (found.state === 'database_ahead' || found.state === 'git_ahead') && census.sample[0]?.fields?.join() === '/body' && source?.local_path
    ? await unsplitSegmentedEqual(engine, sourceId, found, source.local_path) : false;
  const state: VerifyState = pending ? (pending.hold_code ? 'index_held' : 'indexing') : sameFields ? 'equal' : found!.state;
  const ok = state === 'equal';
  const fix: Action | null = ok || state === 'declared_database_only' ? null : state === 'indexing'
    ? { argv: ['gbrain', 'write-request', '--', pending!.request_id], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Read-only: the write\'s receipt says when its index step has flipped the page.', verify: { argv: ['gbrain', 'pages', 'verify', slug, '--source', sourceId, '--json'] } }
    : reindexPreviewFix(slug, sourceId);
  const why = ok ? `Page ${slug} equals its committed file at ${census.head?.slice(0, 12)}.`
    : state === 'indexing' ? `Git has commit ${pending!.commit_oid.slice(0, 12)} of page ${slug} and its index step has not flipped the database yet, which still shows the generation before it.`
    : state === 'index_held' ? `The index step held commit ${pending!.commit_oid.slice(0, 12)} of page ${slug} (${pending!.hold_code}); the database shows the generation before it.`
    : state === 'declared_database_only' ? `Page ${slug} is kept in the database on purpose (${found!.declared}), so Git has no file to compare.`
    : `Page ${slug} differs from its committed file at ${census.head?.slice(0, 12)} (${state}).`;
  return { page: found, pending, revision: found?.revision ?? null, verification: { ok, source_id: sourceId, slug, head: census.head, state, path: found?.path ?? pending?.path ?? null,
    differing: ok ? [] : census.sample[0]?.fields ?? [], indexed_commit: row?.indexed_commit ?? null,
    pending: pending ? { request_id: pending.request_id, commit: pending.commit_oid, hold_code: pending.hold_code } : null, why, fix } };
}

/** Read-only: whether the database's view of the page equals its committed file at HEAD. */
export async function verifyPage(engine: BrainEngine, sourceId: string, slug: string): Promise<PageVerification> {
  return (await locate(engine, sourceId, slug)).verification;
}

export interface PageReindexPreview {
  status: 'preview';
  source_id: string;
  slug: string;
  head: string;
  path: string;
  blob: string;
  state: VerifyState;
  pending: PageVerification['pending'];
  preview_hash: string;
  apply: string[];
}

async function strictSource(engine: BrainEngine, sourceId: string, slug: string): Promise<void> {
  const [source] = await engine.executeRaw<{ strict: boolean }>(`SELECT COALESCE(config->>'canonical','')='git' AS strict FROM sources WHERE id=$1`, [sourceId]);
  if (!source?.strict) throw opError('invalid_params', `Source ${sourceId} is not strict (git-canonical), so Git does not win there and nothing was read.`,
    `Only a source with config.canonical = "git" re-derives a page from Git. gbrain pages verify ${slug} --source ${sourceId} compares it read-only.`);
}

async function previewWithFile(engine: BrainEngine, sourceId: string, slug: string): Promise<{ preview: PageReindexPreview; file: string; located: Located }> {
  await strictSource(engine, sourceId, slug);
  const located = await locate(engine, sourceId, slug);
  const { verification, pending } = located;
  const binding = await getWorktreeBinding(engine, sourceId);
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id = $1', [sourceId]);
  const file = located.page?.path && source?.local_path ? join(source.local_path, located.page.path) : pending && binding?.local_path ? join(binding.local_path, pending.path) : null;
  const root = located.page?.path ? source?.local_path : binding?.local_path;
  if (!file || !root || !verification.head || verification.state === 'declared_database_only') {
    throw opError('invalid_params', `Page ${slug} has no committed file to re-derive from (${verification.state}).`, `gbrain pages verify ${slug} --source ${sourceId} says why.`);
  }
  const blob = await headBlob(root, file);
  if (!blob) throw opError('invalid_params', `HEAD commits no file for page ${slug}, so there is nothing to re-derive and nothing changed.`, `gbrain pages verify ${slug} --source ${sourceId} says why.`);
  if (await committedBlob(root, file) !== blob) throw opError('source_changed', `The working-tree file of page ${slug} is not the blob HEAD commits, so a re-derive would not read Git's bytes; nothing changed.`,
    `Commit or discard the working-tree change (the owner's sync does it for a strict source), then preview again: gbrain pages reindex ${slug} --source ${sourceId} --from-git --dry-run.`);
  const preview_hash = previewHash({ source: sourceId, slug, head: verification.head, blob, state: verification.state, revision: located.revision, pending: verification.pending });
  return { file, located, preview: { status: 'preview', source_id: sourceId, slug, head: verification.head, path: verification.path!, blob, state: verification.state,
    pending: verification.pending, preview_hash, apply: ['gbrain', 'pages', 'reindex', slug, '--source', sourceId, '--from-git', '--apply', '--expect', preview_hash] } };
}

/** The read-only preview of re-deriving one page from its committed file. */
export async function previewPageReindex(engine: BrainEngine, sourceId: string, slug: string): Promise<PageReindexPreview> {
  return (await previewWithFile(engine, sourceId, slug)).preview;
}

/**
 * Applies a preview: the committed file is imported through the source's owner, then a pending or held head of the page
 * is flipped to HEAD's commit (its request's receipt says `indexed`). Refuses `preview_changed` when anything the preview named moved.
 */
export async function applyPageReindex(engine: BrainEngine, sourceId: string, slug: string, expect: string, opts: { noEmbed?: boolean } = {}) {
  const { preview, file, located } = await previewWithFile(engine, sourceId, slug);
  if (preview.preview_hash !== expect) throw previewChangedError(expect, `gbrain pages reindex ${slug} --source ${sourceId} --from-git --dry-run`);
  const imported = await importManagedFile(engine, file, preview.path, { sourceId, ...(opts.noEmbed ? { noEmbed: true } : {}) });
  await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    await tx.executeRaw('UPDATE pages SET indexed_commit = $3 WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, slug, preview.head]);
    const current = located.pending ? await readPendingHead(tx, sourceId, slug, { lock: true }) : null;
    if (!current || current.request_id !== located.pending!.request_id) return;
    await tx.executeRaw('DELETE FROM page_pending_heads WHERE source_id = $1 AND slug = $2 AND request_id = $3::uuid', [sourceId, slug, current.request_id]);
    await tx.executeRaw(`UPDATE persistence_requests SET state = 'committed', updated_at = now(),
        outcome = COALESCE(outcome, '{}'::jsonb) || jsonb_build_object('index', jsonb_build_object('state', 'indexed', 'commit', $2::text, 'reindexed', true))
      WHERE id = $1::uuid AND (state = 'indexing' OR state = 'committed')`, [current.request_id, preview.head]);
  });
  return { status: 'applied' as const, source_id: sourceId, slug, head: preview.head, blob: preview.blob, import: { status: imported.status, chunks: imported.chunks },
    verify: await verifyPage(engine, sourceId, slug) };
}

function refused(error: OperationError, command: string, json: boolean, usage: string): void {
  const env = toAgentError(error, { transport: 'cli', command, render: cliRenderContext() });
  console.log(json ? JSON.stringify({ status: 'refused', ...env }) : `${command} refused (${error.code}): ${error.message}\nFix: ${error.suggestion ?? usage}`);
  setCliExitVerdict(exitCodeForCode(env.code, env.reason));
}

export async function runPagesVerify(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(`${PAGES_VERIFY_USAGE}\nRead-only: compares the page's database view with its committed file at HEAD (${DOCS}).`); return; }
  const json = args.includes('--json');
  try {
    const parsed = parse(args, PAGES_VERIFY_USAGE, []);
    const result = await verifyPage(engine, await resolveSourceId(engine, parsed.source), parsed.slug);
    if (json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`${result.ok ? 'ok' : result.state}: ${result.why}`);
      if (result.differing.length) console.log(`  differing: ${result.differing.join(', ')}`);
      const fix = result.fix ? renderAction(result.fix, cliRenderContext()) : null;
      if (fix?.command) console.log(`  fix (${fix.next.replace(/_/g, ' ')}): ${fix.command}`);
    }
    if (!result.ok) setCliExitVerdict(1);
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    refused(error, 'pages verify', json, PAGES_VERIFY_USAGE);
  }
}

export async function runPagesReindex(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(`${PAGES_REINDEX_USAGE}\nPreview first: re-derives one page of a strict source from the file HEAD commits (${DOCS}).`); return; }
  const json = args.includes('--json');
  try {
    const parsed = parse(args, PAGES_REINDEX_USAGE, ['--from-git', '--dry-run', '--apply', '--expect', '--no-embed']);
    if (!parsed.flags.has('--from-git')) throw opError('invalid_params', 'pages reindex re-derives from Git only: pass --from-git.', PAGES_REINDEX_USAGE);
    const apply = parsed.flags.has('--apply');
    if (apply && parsed.flags.has('--dry-run')) throw opError('invalid_params', '--apply and --dry-run exclude each other.', PAGES_REINDEX_USAGE);
    if (apply && !parsed.expect) throw opError('invalid_params', '--apply needs --expect <hash> from the --dry-run preview.', PAGES_REINDEX_USAGE);
    const sourceId = await resolveSourceId(engine, parsed.source);
    if (!apply) {
      const preview = await previewPageReindex(engine, sourceId, parsed.slug);
      console.log(json ? JSON.stringify(preview, null, 2) : `Page ${preview.slug} (${preview.state}) re-derives from ${preview.path} at ${preview.head.slice(0, 12)} (blob ${preview.blob.slice(0, 12)}).\nNothing changed. To apply: ${preview.apply.join(' ')}`);
      return;
    }
    const result = await applyPageReindex(engine, sourceId, parsed.slug, parsed.expect!, { noEmbed: parsed.flags.has('--no-embed') });
    console.log(json ? JSON.stringify(result, null, 2) : `Page ${result.slug} re-derived from ${result.head.slice(0, 12)} (${result.import.status}); verify: ${result.verify.ok ? 'ok' : result.verify.state}.`);
    if (!result.verify.ok) setCliExitVerdict(1);
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    refused(error, 'pages reindex', json, PAGES_REINDEX_USAGE);
  }
}
