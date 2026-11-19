/**
 * GST-2988 PR 2: the database half of a publish redaction (redact-unpushed.ts) and its upkeep.
 *
 * The route itself needs no database: it seals originals into this machine's encrypted spool (redact-unpushed.ts `spoolSealer`, D9), which
 * also leaves values the owner restored (spool.ts allowedLocally). `settlePublishRedactions` drains the spool into the
 * store as soon as a brain is at hand (the owner right after its push, maintenance otherwise). Each route appends its old-to-new commit map to `<git common dir>/gbrain/redactions.jsonl`;
 * `finishRedactions` applies an entry once a brain is at hand: `sources.last_commit` follows the rebuilt commit, and
 * every page whose file was redacted gets the same field redaction in the database (repair/secret-spans.ts
 * `redactPageForPublish`), so the database and the file agree and repair sees no file drift. Then it marks the entry done.
 *
 * `secretPublishMaintenance` (the bookkeeping_gc phase) moves spooled originals into the store, uploads an encrypted
 * store backup after new entries when a storage backend is configured (secret-store/backup.ts), finishes pending
 * entries for every checkout a source uses, deletes `refs/gbrain/backup/redact-*` refs older than 7 days, and (with
 * `secrets.on_push` redact) retries the Git effects parked on `publish_secret_found`, which now go out redacted (D7a).
 */
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { execFileSync } from '../spawn.ts';
import { gitChildEnv } from '../git-env.ts';
import { resolveSlugForPath } from '../sync.ts';
import { drainSpool, undrainedCount } from '../secret-store/spool.ts';
import { ledgerLocation } from './commit-ledger.ts';
import { relativeEscapesRoot } from '../path-confine.ts';
import { BACKUP_KEEP_DAYS, BACKUP_REF_PREFIX, onPushMode, REDACTIONS_FILE } from './redact-unpushed.ts';

const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Sources whose checkout is `root`, inside it, or holds it (the sources table and this host's worktree bindings), nearest first. */
async function sourceRoots(engine: BrainEngine, root: string): Promise<Array<{ id: string; path: string }>> {
  const target = canonical(root);
  const rows = await engine.executeRaw<{ id: string; local_path: string }>('SELECT id, local_path FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE ORDER BY id');
  try {
    rows.push(...await engine.executeRaw<{ id: string; local_path: string }>(`SELECT s.source_id AS id, h.local_path FROM persistence_host_bindings h
      JOIN persistence_source_bindings s ON s.worktree_id=h.worktree_id WHERE h.local_path IS NOT NULL ORDER BY s.source_id`));
  } catch { /* a brain without persistence bindings */ }
  const out = new Map<string, string>();
  for (const row of rows) {
    const path = canonical(row.local_path);
    if ((inside(path, target) || inside(target, path)) && !out.has(row.id)) out.set(row.id, path);
  }
  return [...out].map(([id, path]) => ({ id, path })).sort((a, b) => Number(b.path === target) - Number(a.path === target) || a.id.localeCompare(b.id));
}
/** The source whose checkout holds `path` (relative to `root`) most closely, else the first source of `root`. */
export async function sourceForPath(engine: BrainEngine, root: string, path: string | null): Promise<string | null> {
  const sources = await sourceRoots(engine, root);
  const target = path ? join(canonical(root), path) : null;
  const holding = target ? sources.filter(s => inside(target, s.path)).sort((a, b) => b.path.length - a.path.length) : [];
  return (holding[0] ?? sources[0])?.id ?? null;
}

export type RuleCounts = Record<string, { values: number; hits: number; signed_link: number; bare: number }>;
/** What the publish redactions journaled beside the checkouts of these sources counted, by rule (summed over redactions). */
export async function publishRedactionCounts(engine: BrainEngine, sourceId?: string): Promise<{ redactions: number; rules: RuleCounts }> {
  const out = { redactions: 0, rules: {} as RuleCounts };
  const rows = await engine.executeRaw<{ local_path: string }>('SELECT local_path FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE AND ($1::text IS NULL OR id=$1)', [sourceId ?? null]);
  const seen = new Set<string>();
  for (const { local_path } of rows) {
    const loc = ledgerLocation(local_path);
    if (!loc || seen.has(loc.common)) continue;
    seen.add(loc.common);
    let lines: string[] = [];
    try { lines = readFileSync(join(loc.common, 'gbrain', REDACTIONS_FILE), 'utf8').split('\n').filter(Boolean); } catch { continue; }
    for (const line of lines) {
      let entry: { old_head?: string; rules?: RuleCounts };
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry.old_head) continue;
      out.redactions++;
      for (const [rule, c] of Object.entries(entry.rules ?? {})) {
        const sum = out.rules[rule] ??= { values: 0, hits: 0, signed_link: 0, bare: 0 };
        sum.values += c.values; sum.hits += c.hits; sum.signed_link += c.signed_link; sum.bare += c.bare;
      }
    }
  }
  return out;
}
export async function sourcesForRoot(engine: BrainEngine, root: string): Promise<string[]> {
  return (await sourceRoots(engine, root)).map(s => s.id);
}

/**
 * After an owner's push (effect-git.ts pushGitRoot): settle a redaction it carries, and drain anything an earlier run
 * left in the spool (a process that stopped between its push and its drain). Never throws.
 */
export async function settleIfRedacted(engine: BrainEngine, root: string, outcome: unknown): Promise<void> {
  const redacted = !!(outcome && typeof outcome === 'object' && (outcome as { redaction?: unknown }).redaction);
  if (redacted || undrainedCount() > 0) await settlePublishRedactions(engine, root);
}

/** The database half right after a publish redaction: originals into the store, then the pending entries. Never throws. */
export async function settlePublishRedactions(engine: BrainEngine, root: string): Promise<void> {
  try { await drainSpool(engine); } catch { /* maintenance retries */ }
  try { await finishRedactions(engine, root); } catch { /* maintenance retries */ }
}

interface Redaction { t: string; root: string; top: string; branch: string; backup_ref: string; old_head: string; new_head: string; push_target: string; map: Record<string, string>; paths: string[] }

function journal(root: string): { file: string; pending: Redaction[] } | null {
  const loc = ledgerLocation(root);
  if (!loc) return null;
  const file = join(loc.common, 'gbrain', REDACTIONS_FILE);
  let lines: string[] = [];
  try { lines = readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return { file, pending: [] }; }
  const parsed = lines.flatMap(line => { try { return [JSON.parse(line) as Redaction & { done?: string }]; } catch { return []; } });
  const done = new Set(parsed.flatMap(entry => entry.done ? [entry.done] : []));
  return { file, pending: parsed.filter(entry => !entry.done && entry.old_head && !done.has(`${entry.old_head}>${entry.new_head}`)) };
}

/**
 * Applies the pending redactions of the checkout holding `root` to the database: `sources.last_commit` moves to the
 * rebuilt commit, and every redacted page file's page gets the same field redaction.
 */
export async function finishRedactions(engine: BrainEngine, root: string): Promise<{ redactions: number; pages: Record<string, number>; last_commit: number }> {
  const out = { redactions: 0, pages: {} as Record<string, number>, last_commit: 0 };
  const found = journal(root);
  if (!found?.pending.length) return out;
  const { redactPageForPublish } = await import('../repair/secret-spans.ts');
  for (const entry of found.pending) {
    let failed = false;
    for (const source of await sourceRoots(engine, entry.top)) {
      const [row] = await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [source.id]);
      const next = row?.last_commit ? entry.map[row.last_commit] : undefined;
      if (next && row?.last_commit) {
        await engine.executeRaw('UPDATE sources SET last_commit=$2 WHERE id=$1 AND last_commit=$3', [source.id, next, row.last_commit]);
        out.last_commit++;
      }
      for (const path of entry.paths) {
        const rel = relative(source.path, join(canonical(entry.top), path));
        if (!rel || relativeEscapesRoot(rel)) continue;
        let outcome: string;
        try { outcome = await redactPageForPublish(engine, source.id, resolveSlugForPath(rel.split(sep).join('/'))); }
        catch (error) { outcome = (error as { code?: string }).code ?? 'failed'; failed = true; }
        out.pages[outcome] = (out.pages[outcome] ?? 0) + 1;
      }
    }
    // A page redaction that threw leaves the entry pending, so a later pass redacts that page too.
    if (failed) continue;
    appendFileSync(found.file, `${JSON.stringify({ t: new Date().toISOString(), done: `${entry.old_head}>${entry.new_head}` })}\n`);
    out.redactions++;
  }
  return out;
}

/** Deletes `refs/gbrain/backup/redact-<utc>-*` refs older than BACKUP_KEEP_DAYS in the checkout holding `root`. */
export function pruneBackupRefs(root: string, now = Date.now()): number {
  const git = (args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, env: gitChildEnv({ LC_ALL: 'C' }) }).toString();
  let deleted = 0;
  for (const line of git(['for-each-ref', '--format', '%(refname) %(objectname)', BACKUP_REF_PREFIX]).split('\n').filter(Boolean)) {
    const [ref, sha] = line.split(' ');
    const m = /redact-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(ref!);
    if (!m || now - Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!) < BACKUP_KEEP_DAYS * 86_400_000) continue;
    try { git(['update-ref', '-d', ref!, sha!]); deleted++; } catch { /* moved or gone */ }
  }
  return deleted;
}

/** The bookkeeping_gc step: spool, pending redactions, old backup refs, and (redact mode) parked secret pushes. Never throws. */
export async function secretPublishMaintenance(engine: BrainEngine): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const add = (key: string, n: number) => { if (n) out[key] = (out[key] ?? 0) + n; };
  try { const spool = await drainSpool(engine); add('secret_spool_moved', spool.moved); add('secret_spool_remaining', spool.remaining); } catch { /* a store migration not applied yet */ }
  try { if (await (await import('../secret-store/backup.ts')).backupIfDue(engine)) add('secret_store_backups', 1); } catch { /* a store migration not applied yet */ }
  let roots: string[] = [];
  try {
    roots = [...new Set((await engine.executeRaw<{ local_path: string }>('SELECT local_path FROM sources WHERE local_path IS NOT NULL AND archived IS NOT TRUE')).map(r => r.local_path))];
    roots.push(...(await engine.executeRaw<{ local_path: string }>('SELECT local_path FROM persistence_host_bindings WHERE local_path IS NOT NULL').catch(() => [])).map(r => r.local_path));
  } catch { /* no sources table yet */ }
  const seen = new Set<string>();
  for (const root of roots) {
    const loc = ledgerLocation(root);
    if (!loc || seen.has(loc.common)) continue;
    seen.add(loc.common);
    try { add('publish_redactions_finished', (await finishRedactions(engine, root)).redactions); } catch { /* retried next pass */ }
    try { add('redact_backup_refs_deleted', pruneBackupRefs(root)); } catch { /* not a checkout git can read */ }
  }
  if (onPushMode() === 'redact') {
    try {
      const { retryParkedPushes } = await import('../persistence/git-durability-administration.ts');
      const worktrees = await engine.executeRaw<{ worktree_id: string }>(`SELECT DISTINCT worktree_id::text AS worktree_id FROM persistence_effects
        WHERE kind='git' AND state='failed' AND worktree_id IS NOT NULL`);
      for (const { worktree_id } of worktrees) add('secret_parked_pushes_retried', (await retryParkedPushes(engine, worktree_id, false, ['publish_secret_found'])).queued);
    } catch { /* no persistence tables, or no owner here */ }
  }
  return out;
}
