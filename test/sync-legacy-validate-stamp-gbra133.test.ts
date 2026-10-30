/**
 * GBRA-133: a legacy page (imported by an older gbrain, so it has no import record) whose database copy carries the
 * v0.13.1 grandfather stamp `validate: false` that its file never had. The stamp is mechanical (grandfather.ts) and a
 * coordinated write keeps it for a file without a `validate:` key (#6429, page-prepare.ts). Before the fix sync's import
 * comparison did not: the legacy sweep could not record the page, and the next commit to its file was held file_drift of
 * unknown side, although only the file had changed.
 *
 * Protects: the sweep records such a page; a later commit to its file imports instead of holding, and the page keeps the
 * stamp; a page whose database copy really differs (a body edit) is still held.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { drainProjections } from '../src/core/page-state/projections.ts';
import { readGitHold, SYNC_IMPORT_PROVENANCE_OP } from '../src/core/persistence/sync-holds.ts';
import { MANAGED_SYNC_PASS_OP } from '../src/core/persistence/sync-pass-row.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const NAMES = ['stamped', 'edited', 'plain'];
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const name of NAMES) writeFileSync(join(root, `notes/${name}.md`), `---\ntype: concept\ntitle: notes/${name}\n---\n\nThe committed body of notes/${name}.\n`);
  commit(root, 'notes');
};

/** The synced pages as an older gbrain left them: no import record and no pass row; the grandfather stamp as v0.13.1's UPDATE wrote it. */
async function legacyPages(engine: BrainEngine, stamped: string[], dbEdited: string[]): Promise<void> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try {
    const cols = 'source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, source_path';
    const rows = await engine.executeRaw<Record<string, unknown>>(`SELECT ${cols} FROM pages WHERE source_id='default'`);
    await engine.executeRaw("DELETE FROM pages WHERE source_id='default'");
    for (const row of rows) await engine.executeRaw(`INSERT INTO pages(${cols}) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
      [row.source_id, row.slug, row.type, row.title, row.compiled_truth, row.timeline, JSON.stringify(row.frontmatter), row.content_hash, row.source_path]);
    for (const slug of stamped) await engine.executeRaw("UPDATE pages SET frontmatter = jsonb_set(COALESCE(frontmatter, '{}'::jsonb), '{validate}', 'false'::jsonb) WHERE source_id='default' AND slug=$1", [slug]);
    for (const slug of dbEdited) await engine.executeRaw("UPDATE pages SET compiled_truth = compiled_truth || ' A database edit.' WHERE source_id='default' AND slug=$1", [slug]);
  } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op IN ($1,$2)', [SYNC_IMPORT_PROVENANCE_OP, MANAGED_SYNC_PASS_OP]);
  while ((await drainProjections(engine, { limit: 100 })).rebuilt > 0);
}

const incarnationOf = async (engine: BrainEngine) => (await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'"))[0]!.incarnation;
const page = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ compiled_truth: string; frontmatter: Record<string, unknown> }>(
  "SELECT compiled_truth, frontmatter FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!;

describe('GBRA-133 legacy page with the database-only grandfather stamp', () => {
  test('a commit to its file imports instead of holding file_drift, and the page keeps validate: false', () => managedBrain(async ({ engine, root }) => {
    await performManagedSync(engine, { ...OPTS, repoPath: root });
    await legacyPages(engine, ['notes/stamped', 'notes/edited'], ['notes/edited']);
    await performManagedSync(engine, { ...OPTS, repoPath: root });
    for (const name of NAMES) writeFileSync(join(root, `notes/${name}.md`), readFileSync(join(root, `notes/${name}.md`), 'utf8') + '\nA line the cron writer added.\n');
    commit(root, 'cron writer');
    await performManagedSync(engine, { ...OPTS, repoPath: root });

    const incarnation = await incarnationOf(engine);
    expect(await readGitHold(engine, 'default', incarnation, 'notes/stamped.md')).toBeNull();
    const stamped = await page(engine, 'notes/stamped');
    expect(stamped.compiled_truth).toContain('A line the cron writer added.');
    expect(stamped.frontmatter.validate).toBe(false);
    expect(readFileSync(join(root, 'notes/stamped.md'), 'utf8')).not.toContain('validate');
    expect(await readGitHold(engine, 'default', incarnation, 'notes/plain.md')).toBeNull();
    expect((await page(engine, 'notes/plain')).compiled_truth).toContain('A line the cron writer added.');
    // A database copy that really moved off the file is still held, and keeps its edit.
    const held = await readGitHold(engine, 'default', incarnation, 'notes/edited.md');
    expect(held).toMatchObject({ code: 'file_drift', meta: { side: 'unknown' } });
    // With no import record and no database write on record, the hold does not claim the database changed.
    expect(held!.message).toBe('notes/edited.md: page notes/edited differs from its file and has no import record to tell whether the file or the database changed, so sync held the import instead of overwriting the database version; the rest of the source synced.');
    expect((await page(engine, 'notes/edited')).compiled_truth).toContain('A database edit.');
  }, { setup }), 120_000);
});
