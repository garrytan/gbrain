/**
 * #6712 PR 4a: the read-only convergence shadow on a real managed brain (PGLite plus a Git checkout).
 *
 * Authoring gate: (1) protects \`gbrain sync --dry-run --json\`'s new \`convergence\` receipt and \`--redact-paths\`, and
 * the PR 4a promise that the shadow writes and admits nothing; (2) a shadow that writes a row, misreads a level (a
 * staged file, an uncommitted edit, a parser bump, a database-only edit), or leaks a path under redaction fails here;
 * (3) the pure classifier test cannot see the reads; (4) no seam: the CLI entry point and the library reads run as
 * production calls them.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { runSync } from '../src/commands/sync.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { shadowConvergence } from '../src/core/persistence/sync-pass.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { currentExitCode, setCliExitVerdict } from '../src/core/cli-force-exit.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntitle: ${title}\n---\n\n${body}\n`;
const setup = ({ root }: { root: string }) => {
  git(root, 'init', '-q');
  mkdirSync(join(root, 'notes'), { recursive: true });
  for (const name of ['alpha', 'beta', 'gamma']) writeFileSync(join(root, 'notes', name + '.md'), note(name, 'Synthetic ' + name + ' one.'));
  commit(root, 'notes');
};
const SYNC = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };

/** Every row a shadow could write: request, effect, checkpoint (holds, markers, records, pass rows, cursors) and page rows. */
async function footprint(engine: BrainEngine): Promise<string> {
  const rows = await engine.executeRaw<{ t: string; n: number; h: string | null }>(`SELECT 'requests' AS t, count(*)::int AS n, md5(string_agg(id::text||state, ',' ORDER BY id)) AS h FROM persistence_requests
    UNION ALL SELECT 'effects', count(*)::int, md5(string_agg(id::text||state, ',' ORDER BY id)) FROM persistence_effects
    UNION ALL SELECT 'checkpoints', count(*)::int, md5(string_agg(op||fingerprint||completed_keys::text, ',' ORDER BY op, fingerprint)) FROM op_checkpoints
    UNION ALL SELECT 'pages', count(*)::int, md5(string_agg(id::text||knowledge_revision::text||coalesce(deleted_at::text,''), ',' ORDER BY id)) FROM pages`);
  return JSON.stringify(rows);
}

class CliExit extends Error { constructor(readonly code: number) { super('exit ' + code); } }
async function cliSync(engine: BrainEngine, args: string[]): Promise<{ json: Record<string, unknown>; exit: number }> {
  const out: string[] = [];
  const spies = [spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as never),
    spyOn(process.stderr, 'write').mockImplementation((() => true) as never), spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { out.push(parts.map(String).join(' ')); }), spyOn(console, 'error').mockImplementation(() => {}),
    spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new CliExit(code ?? 0); }) as never)];
  setCliExitVerdict(0);
  let exit = 0;
  try { await runSync(engine, args); exit = currentExitCode(); } catch (caught) { if (!(caught instanceof CliExit)) throw caught; exit = caught.code; }
  finally { for (const spy of spies) spy.mockRestore(); setCliExitVerdict(0); }
  const text = out.join('');
  return { json: JSON.parse(text.slice(text.indexOf('{'))), exit };
}

describe('#6712 PR 4a convergence shadow (pglite)', () => {
  test('a synced source is fully matched, and the shadow writes nothing', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    const before = await footprint(engine);
    const receipt = (await shadowConvergence(engine, { sourceId: 'default' }))!;
    expect(receipt).toMatchObject({ dry_run: true, kind: 'full', mode: 'committed', candidates: 0, remaining: 0, counts: { matched: 3 },
      classes: { matched: { count: 3, action: 'none' } }, decisions: { both: 0, unknown: 0, deleted: 0 }, would_hold: 0 });
    expect(receipt.kind_blockers).toContain('no_converged_state');
    expect(await footprint(engine)).toBe(before);
  }, { setup }), 120_000);

  test('the level drives every class: a committed edit, a database-only edit, a two-sided edit, a deletion', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    for (const name of ['delta', 'epsilon']) writeFileSync(join(root, 'notes', name + '.md'), note(name, 'Synthetic ' + name + ' one.'));
    commit(root, 'more notes');
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    const { submitPageMutation } = await import('../src/core/persistence/page-mutations.ts');
    const { waitFor } = await import('./helpers/wait-for.ts');
    for (const slug of ['notes/beta', 'notes/gamma']) {
      const current = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      const requestId = crypto.randomUUID();
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: requestId, expected_revision: current!.revision, content: note(slug, 'A database-only edit.') } });
      await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.state === 'committed',
        { timeoutMs: 20_000, label: 'the database-only edit commits' });
    }
    writeFileSync(join(root, 'notes', 'alpha.md'), note('alpha', 'Synthetic alpha two.'));
    writeFileSync(join(root, 'notes', 'gamma.md'), note('gamma', 'Synthetic gamma two.'));
    rmSync(join(root, 'notes', 'delta.md'));
    commit(root, 'edits');
    // The edits' effects settle in the background consumer first, so the footprint only moves if the dry run writes.
    await waitFor(async () => !(await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE state IN ('queued','running')")).length,
      { timeoutMs: 30_000, label: 'the database-only edits settle their effects' });
    const before = await footprint(engine);
    const { json, exit } = await cliSync(engine, ['--source', 'default', '--no-pull', '--dry-run', '--json', '--no-embed']);
    expect(exit).toBe(0);
    const convergence = json.convergence as Record<string, any>;
    expect(convergence).toMatchObject({ dry_run: true, counts: { matched: 1, import: 1, db_ahead: 1, drift: 1, delete: 1 },
      db_ahead: { db_only: 1, pending: 0, unproven: 0, by_prefix: { 'notes/': 1 } }, deletes: { count: 1, verdict: 'apply' } });
    // The two-sided page is screened read-only: the file differs from the database, so it is a predicted decision.
    expect(convergence.decisions).toEqual({ both: 1, unknown: 0, deleted: 0 });
    expect(convergence.classes.drift.action).toBe('repair');
    expect(convergence.samples.import[0]).toMatchObject({ path: 'notes/alpha.md', slug: 'notes/alpha', action: 'owner' });
    // The existing dry-run keys stay (additive only).
    expect(json.sync_status).toBe('dry_run');
    expect(await footprint(engine)).toBe(before);

    const redacted = await cliSync(engine, ['--source', 'default', '--no-pull', '--dry-run', '--json', '--no-embed', '--redact-paths']);
    const text = JSON.stringify(redacted.json.convergence);
    expect(text).not.toContain('notes/');
    expect(text).not.toMatch(/alpha|beta|gamma|delta|epsilon/);
    expect((redacted.json.convergence as Record<string, any>).samples.import[0]).toEqual({ path: expect.stringMatching(/^sha256:[0-9a-f]{16}$/), reason: expect.any(String), action: 'owner' });
    expect(await footprint(engine)).toBe(before);
  }, { setup }), 180_000);

  test('committed mode: an uncommitted edit of a synced file is no hold (probe 24); a dirty file whose commit moved is held, not imported', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes', 'alpha.md'), note('alpha', 'An uncommitted draft.'));
    let receipt = (await shadowConvergence(engine, { sourceId: 'default' }))!;
    expect(receipt.counts).toEqual({ matched: 3 });
    expect(receipt.would_hold).toBe(0);
    writeFileSync(join(root, 'notes', 'beta.md'), note('beta', 'Synthetic beta two.'));
    git(root, 'add', 'notes/beta.md'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'beta two');
    writeFileSync(join(root, 'notes', 'beta.md'), note('beta', 'An uncommitted draft on top.'));
    receipt = (await shadowConvergence(engine, { sourceId: 'default' }))!;
    expect(receipt.counts).toMatchObject({ matched: 2, dirty: 1 });
    expect(receipt.samples.dirty![0]).toMatchObject({ path: 'notes/beta.md', reason: 'working copy modified', action: 'repair' });
    expect(receipt.would_hold).toBe(1);
  }, { setup }), 120_000);

  test('probe 41: working mode imports the physical bytes of a staged edit, a staged new file and a git rm --cached file', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    writeFileSync(join(root, 'notes', 'alpha.md'), note('alpha', 'A staged edit.'));
    writeFileSync(join(root, 'notes', 'zeta.md'), note('zeta', 'A staged new file.'));
    git(root, 'add', 'notes/alpha.md', 'notes/zeta.md');
    git(root, 'rm', '-q', '--cached', 'notes/beta.md');
    const receipt = (await shadowConvergence(engine, { sourceId: 'default', workingTree: true }))!;
    expect(receipt.mode).toBe('working');
    // alpha and zeta import from disk; beta's bytes are still the synced ones, so it matches (nothing deletes it).
    expect(receipt.counts).toEqual({ matched: 2, import: 2 });
    expect(receipt.samples.import!.map(sample => sample.path).sort()).toEqual(['notes/alpha.md', 'notes/zeta.md']);
    // The same tree in committed mode imports nothing: the staged changes are not committed.
    const committed = (await shadowConvergence(engine, { sourceId: 'default' }))!;
    expect(committed.counts.import ?? 0).toBe(0);
  }, { setup }), 120_000);

  test('probe 46: a parser change on fileSame ∧ dbSame pages is reparse with zero decisions; --full makes every page reparse that is not already current', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys, '{0,parser,parser_version}', '"import=0"')
      WHERE op=$1 AND completed_keys->0->>'origin'='notes/alpha.md'`, [SYNC_IMPORT_PROVENANCE_OP]);
    const receipt = (await shadowConvergence(engine, { sourceId: 'default' }))!;
    expect(receipt.counts).toEqual({ matched: 2, reparse: 1 });
    expect(receipt.decisions).toEqual({ both: 0, unknown: 0, deleted: 0 });
    expect(receipt.samples.reparse![0]).toMatchObject({ path: 'notes/alpha.md', reason: 'parser or schema pack changed', action: 'owner' });
    // A current page satisfies the full obligation in place (sync-classify.ts `inPlace`); one chunked at an older chunker
    // version, which a plain pass leaves matched, is reparsed under --full.
    expect((await shadowConvergence(engine, { sourceId: 'default', full: true }))!.counts).toEqual({ matched: 2, reparse: 1 });
    await engine.executeRaw("UPDATE pages SET chunker_version=chunker_version-1 WHERE source_id='default'");
    expect((await shadowConvergence(engine, { sourceId: 'default' }))!.counts).toEqual({ matched: 2, reparse: 1 });
    expect((await shadowConvergence(engine, { sourceId: 'default', full: true }))!.counts).toEqual({ reparse: 3 });
  }, { setup }), 120_000);

  test('probe 38: a page whose record predates PR 0 and whose receipt was compacted is counted legacy_unverified, never held or written', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_build_array((completed_keys->0) - 'revision' - 'disk_blob_oid' - 'parser' - 'blob_oid')
      WHERE op=$1 AND completed_keys->0->>'origin'='notes/gamma.md'`, [SYNC_IMPORT_PROVENANCE_OP]);
    // Receipt compaction NULLs the intent (journal.ts), as a release before PR 0 left it.
    await engine.transaction(async tx => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw("UPDATE persistence_requests SET intent=NULL, compacted=true WHERE slug='notes/gamma'");
    });
    const before = await footprint(engine);
    const receipt = (await shadowConvergence(engine, { sourceId: 'default' }))!;
    expect(receipt.counts).toEqual({ matched: 2, legacy_unverified: 1 });
    expect(receipt.legacy_unverified).toBe(1);
    expect(receipt.would_hold).toBe(0);
    expect(await footprint(engine)).toBe(before);
  }, { setup }), 120_000);

  test('probe 38, arm 1: a record without a revision whose sync receipt survives is adopted on the attestation (A), not left unverified', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_build_array((completed_keys->0) - 'revision')
      WHERE op=$1 AND completed_keys->0->>'origin'='notes/gamma.md'`, [SYNC_IMPORT_PROVENANCE_OP]);
    const before = await footprint(engine);
    const receipt = (await shadowConvergence(engine, { sourceId: 'default' }))!;
    expect(receipt.counts).toEqual({ matched: 2, adopt: 1 });
    expect(receipt.legacy_unverified).toBe(0);
    expect(await footprint(engine)).toBe(before);
  }, { setup }), 120_000);

  test('sync status: plain status reports the live pass row, and without one it skips the heavy convergence read; --detail reports it with dry_run: true', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    // #6712 PR 4b: a live pass's row is the convergence plain status reports, read in the status's own statements.
    const live = await readSyncStatus(engine, 'default', { detail: false });
    expect(live.convergence_read).toEqual({ status: 'read' });
    expect(live.convergence).toMatchObject({ dry_run: false, outcome: 'synced', candidates: 3, settled: 3 });
    // A source with no pass row (no pass has run there yet) keeps the 4a contract.
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync-pass' AND completed_keys->0->>'source_id'='default'");
    const plain = await readSyncStatus(engine, 'default', { detail: false });
    expect(plain.convergence).toBeNull();
    expect(plain.convergence_read).toMatchObject({ status: 'not_read', fix: { argv: ['gbrain', 'sync', 'status', '--source', 'default', '--detail', '--json'] } });
    const detail = await readSyncStatus(engine, 'default', { detail: true });
    expect(detail.convergence_read).toEqual({ status: 'read' });
    expect(detail.convergence).toMatchObject({ dry_run: true, counts: { matched: 3 } });
    expect((detail.convergence as Record<string, unknown>).screen_skipped).toBeUndefined();
  }, { setup }), 120_000);

  test('sync status: a non-company source synced by the pass has no cursor, so run_id, cursor, rate_pages_per_min and eta_seconds read null', () => managedBrain(async ({ engine }) => {
    expect((await performManagedSync(engine, SYNC)).status).toBe('first_sync');
    expect(Number((await engine.executeRaw<{ n: number | string }>("SELECT count(*) AS n FROM op_checkpoints WHERE op='managed-sync'"))[0]!.n)).toBe(0);
    for (const detail of [false, true]) {
      const status = await readSyncStatus(engine, 'default', { detail });
      expect(status).toMatchObject({ run_id: null, cursor: null, rate_pages_per_min: null, eta_seconds: null });
      expect(status.convergence).toMatchObject({ outcome: 'synced' });
    }
  }, { setup }), 120_000);
});
