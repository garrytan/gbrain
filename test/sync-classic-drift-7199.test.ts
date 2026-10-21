/**
 * #7199: after a classic brain turns managed, a file edited before the first managed pass has a page with no import
 * record. The pass used to hold every such file as file_drift side unknown, needs_human, and report plain synced.
 *
 * Protects:
 * - a record-less page whose database copy still equals the file at the source's last synced commit imports the newer
 *   file with no hold (the classic sync that last wrote the page read that blob);
 * - a record-less page whose database copy moved stays held, and the hold names what it compared and that no import
 *   record says which side moved (message, fix text and the sync status verdict), never that the database moved;
 * - an existing side-unknown hold written before that comparison (no baseline_screened) is re-screened once: one that
 *   meets the proof imports and clears, one that does not stays held, records the comparison and is not re-screened again;
 * - a pass that holds files a person must decide reports reason held_needs_human with their count, not plain synced.
 * PGLite always; Postgres too when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { MANAGED_SYNC_PASS_OP } from '../src/core/persistence/sync-pass-row.ts';
import { printHoldNotes } from '../src/commands/sync-diagnostics.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { waitFor } from './helpers/wait-for.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const committed = (slug: string) => note(slug, `The committed body of ${slug}.`);
const SLUGS = ['notes/a', 'notes/b', 'notes/c', 'notes/d'];
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of SLUGS) writeFileSync(join(root, `${slug}.md`), committed(slug));
  commit(root, 'notes');
};
const bodyOf = async (engine: BrainEngine, slug: string) => (await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth ?? '';
async function holds(engine: BrainEngine) {
  const rows = await engine.executeRaw<{ fingerprint: string; record: { code: string; message: string; meta: Record<string, unknown> } }>(
    "SELECT fingerprint, completed_keys->0 AS record FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint");
  return Object.fromEntries(rows.map(row => [row.fingerprint.split(':').slice(2).join(':'), row.record]));
}
/** Pages as a classic sync left them: no import record, and no managed pass row yet. */
async function classicPages(engine: BrainEngine) {
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op IN ($1,$2)', [SYNC_IMPORT_PROVENANCE_OP, MANAGED_SYNC_PASS_OP]);
}
async function dbEdit(engine: BrainEngine, ctx: OperationContext, slug: string, content: string) {
  const requestId = randomUUID();
  const current = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: requestId, expected_revision: current!.revision, content } });
  await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.state === 'committed',
    { timeoutMs: 20_000, label: `request ${requestId} commits` });
}
const PAGE_COLUMNS = ['title', 'type', 'compiled_truth', 'timeline', 'frontmatter', 'content_hash'] as const;
const pageRow = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<Record<string, unknown>>(
  `SELECT ${PAGE_COLUMNS.join(', ')} FROM pages WHERE source_id='default' AND slug=$1`, [slug]))[0]!;
/** Writes a page row back as an older gbrain left it: managed persistence off around the write. */
async function restorePage(engine: BrainEngine, slug: string, row: Record<string, unknown>) {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try {
    await engine.executeRaw(`UPDATE pages SET title=$2, type=$3, compiled_truth=$4, timeline=$5, frontmatter=$6::jsonb, content_hash=$7 WHERE source_id='default' AND slug=$1`,
      [slug, row.title, row.type, row.compiled_truth, row.timeline, JSON.stringify(row.frontmatter), row.content_hash]);
  } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}
/** A side-unknown hold as a gbrain before #7199 wrote it: no record of the last-synced-commit comparison. */
async function unscreened(engine: BrainEngine, path: string) {
  await engine.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_build_array((completed_keys->0) #- '{meta,baseline_screened}') WHERE op='sync-hold' AND fingerprint LIKE '%:' || $1", [path]);
}

for (const databaseUrl of process.env.DATABASE_URL ? [undefined, process.env.DATABASE_URL] : [undefined]) describe(`#7199 classic-era edits after managed activation (${databaseUrl ? 'postgres' : 'pglite'})`, () => {
  test('a record-less page equal to its file at the last synced commit imports the newer file; one whose page moved stays held with truthful text, and the pass reports held_needs_human', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const base = git(root, 'rev-parse', 'HEAD');
    await classicPages(engine);
    // c's page moved in the database (no record names the write as sync's); d is untouched on both sides.
    await dbEdit(engine, ctx, 'notes/c', note('notes/c', 'A database-only edit of notes/c.'));
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) writeFileSync(join(root, `${slug}.md`), note(slug, `A newer file body of ${slug}.`));
    commit(root, 'edits after activation');

    const result = await performManagedSync(engine, OPTS);
    expect({ status: result.status, reason: result.reason ?? null, held_needs_human: result.held_needs_human ?? null }).toEqual({ status: 'synced', reason: 'held_needs_human', held_needs_human: 1 });
    expect((result.held ?? []).map(hold => ({ path: hold.path, code: hold.code, side: hold.side }))).toEqual([{ path: 'notes/c.md', code: 'file_drift', side: 'unknown' }]);
    for (const slug of ['notes/a', 'notes/b']) expect(await bodyOf(engine, slug)).toContain(`A newer file body of ${slug}.`);
    expect(await bodyOf(engine, 'notes/c')).toContain('A database-only edit of notes/c.');
    expect(await bodyOf(engine, 'notes/d')).toContain('The committed body of notes/d.');

    const held = await holds(engine);
    expect(Object.keys(held)).toEqual(['notes/c.md']);
    expect(held['notes/c.md']!.meta).toMatchObject({ side: 'unknown', baseline_screened: git(root, 'rev-parse', `${base}:notes/c.md`) });
    expect(held['notes/c.md']!.message).toContain('sync has no import record for page notes/c, so it cannot tell whether the page or the file changed');
    expect(held['notes/c.md']!.message).toContain('the page differs from the file at the last synced commit');
    expect(held['notes/c.md']!.message).not.toContain('changed in the database since');
    expect(result.held![0]!.fix.why).toContain('Sync has no import record for page notes/c');
    expect(result.held![0]!.fix.why).not.toContain('changed in the database');

    const status = await readSyncStatus(engine, 'default');
    const hold = status.holds.find(item => item.path === 'notes/c.md')!;
    expect(hold).toMatchObject({ code: 'file_drift', needs_human: true });
    expect(hold.human_reason).toContain('sync has no import record to tell which one changed');

    const lines: string[] = [];
    printHoldNotes(result, line => lines.push(line));
    expect(lines[0]).toBe('Synced; 1 file(s) held for a person (gbrain sync status --source default).');
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
  }, { databaseUrl, setup }), 240_000);

  test('an older side-unknown hold is re-screened once: the page that meets the proof imports and clears, the one that does not stays held and records the comparison', () => managedBrain(async ({ engine, ctx, root }) => {
    await engine.setConfig('sync.write_through', 'false');
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await classicPages(engine);
    const classic = await pageRow(engine, 'notes/a');
    for (const slug of ['notes/a', 'notes/c']) await dbEdit(engine, ctx, slug, note(slug, `A database-only edit of ${slug}.`));
    for (const slug of ['notes/a', 'notes/c']) writeFileSync(join(root, `${slug}.md`), note(slug, `A newer file body of ${slug}.`));
    commit(root, 'edits after activation');
    expect((await performManagedSync(engine, OPTS)).held?.map(hold => hold.path).sort()).toEqual(['notes/a.md', 'notes/c.md']);
    // a's page row goes back to what the classic import wrote: the page an older gbrain held although it equals an earlier
    // committed version of its file.
    await restorePage(engine, 'notes/a', classic);
    // Control: a hold that recorded its comparison is not re-screened, so a stays held.
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    expect(Object.keys(await holds(engine)).sort()).toEqual(['notes/a.md', 'notes/c.md']);

    await unscreened(engine, 'notes/a.md');
    await unscreened(engine, 'notes/c.md');
    await performManagedSync(engine, OPTS);
    expect(await bodyOf(engine, 'notes/a')).toContain('A newer file body of notes/a.');
    expect(await bodyOf(engine, 'notes/c')).toContain('A database-only edit of notes/c.');
    const held = await holds(engine);
    expect(Object.keys(held)).toEqual(['notes/c.md']);
    expect(held['notes/c.md']!.meta).toMatchObject({ side: 'unknown', baseline_screened: expect.any(String) });
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
  }, { databaseUrl, setup }), 240_000);
});
