/**
 * C3 (agent operator wave): `gbrain reindex-frontmatter` asks before it
 * rewrites stored dates, and its preview, plan hash and apply share one
 * selection.
 *
 * Protects: `--json` never implies consent (it used to skip the prompt, so a
 * non-interactive `--json` run rewrote every page); `--source` scopes the
 * apply, not just the count (the apply used to walk every source); the
 * approval binds the exact rows the preview listed (`--yes --expect`), a
 * changed row re-asks with `preview_changed`, and a page that starts matching
 * after the preview is not touched. Fails on the base at the --json and
 * two-source assertions.
 */
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runReindexFrontmatter } from '../src/commands/reindex-frontmatter.ts';
import { backfillEffectiveDate } from '../src/core/backfill-effective-date.ts';
import { currentExitCode, setCliExitVerdict } from '../src/core/cli-force-exit.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other','other') ON CONFLICT DO NOTHING");
});

const page = (date: string) => `---\ntype: note\ntitle: t\nevent_date: '${date}'\n---\n\nBody.\n`;

/** Two sources, each with a page whose stored date is stale (the fallback). */
async function seed() {
  await importFromContent(engine, 'notes/a', page('2001-02-03'), { noEmbed: true });
  await importFromContent(engine, 'notes/b', page('2004-05-06'), { noEmbed: true, sourceId: 'other' });
  await engine.executeRaw("UPDATE pages SET effective_date = '2020-01-01', effective_date_source = 'fallback'");
}

const dates = async () => Object.fromEntries((await engine.executeRaw<{ k: string; d: string }>(
  "SELECT source_id || ':' || slug AS k, to_char(effective_date AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d FROM pages ORDER BY 1")).map(r => [r.k, r.d]));

async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; stdout: string; exit: number }> {
  let stdout = '';
  const out = spyOn(process.stdout, 'write').mockImplementation(((c: string | Uint8Array) => { stdout += String(c); return true; }) as never);
  const err = spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  setCliExitVerdict(0);
  try {
    const value = await withEnv({ GBRAIN_NON_INTERACTIVE: '1' }, fn);
    return { value, stdout, exit: currentExitCode() };
  } finally {
    out.mockRestore(); err.mockRestore(); setCliExitVerdict(0);
  }
}

test('--json never implies consent: a non-interactive apply changes nothing and exits 3 with the consent payload', async () => {
  await seed();
  const before = await dates();
  const r = await quiet(() => runReindexFrontmatter(engine, { json: true }));
  expect(r.value.status).toBe('confirmation_required');
  expect(r.exit).toBe(3);
  const payload = JSON.parse(r.stdout);
  expect(payload).toMatchObject({ code: 'confirmation_required', effects: ['destructive'], actor: 'agent' });
  expect(payload.fix.argv).toEqual(['gbrain', 'reindex-frontmatter', '--json', '--yes', '--expect', payload.plan_hash]);
  expect(payload.preview.argv).toEqual(['gbrain', 'reindex-frontmatter', '--dry-run', '--json']);
  expect(payload.user_message).toContain('2 page(s)');
  expect(await dates()).toEqual(before);

  // A bare --yes retry is not the approval: the destructive plan must be named.
  const bare = await quiet(() => runReindexFrontmatter(engine, { yes: true, json: true }));
  expect(bare.value.status).toBe('confirmation_required');
  expect(await dates()).toEqual(before);
});

test('two sources: --source scopes preview, hash and apply; the unselected source is unchanged', async () => {
  await seed();
  const preview = await runReindexFrontmatter(engine, { sourceId: 'other', dryRun: true, json: true });
  expect(preview).toMatchObject({ status: 'dry_run', examined: 1, updated: 1, source_filter: 'other' });
  const applied = await quiet(() => runReindexFrontmatter(engine, { sourceId: 'other', yes: true, expect: preview.plan_hash, json: true }));
  expect(applied.value).toMatchObject({ status: 'ok', updated: 1 });
  expect(await dates()).toEqual({ 'default:notes/a': '2020-01-01', 'other:notes/b': '2004-05-06' });
});

test('the approval binds the previewed rows: a changed row re-asks; a newly matching row is not touched', async () => {
  await seed();
  const { plan_hash } = await runReindexFrontmatter(engine, { dryRun: true, json: true });
  await engine.executeRaw("UPDATE pages SET effective_date = '2019-01-01' WHERE slug = 'notes/a'");
  await expect(quiet(() => runReindexFrontmatter(engine, { yes: true, expect: plan_hash, json: true })))
    .rejects.toMatchObject({ code: 'preview_changed' });
  expect(await dates()).toEqual({ 'default:notes/a': '2019-01-01', 'other:notes/b': '2020-01-01' });

  const fresh = await runReindexFrontmatter(engine, { sourceId: 'default', dryRun: true, json: true });
  const ok = await quiet(() => runReindexFrontmatter(engine, { sourceId: 'default', yes: true, expect: fresh.plan_hash, json: true }));
  expect(ok.value).toMatchObject({ status: 'ok', updated: 1 });
  expect((await dates())['default:notes/a']).toBe('2001-02-03');

  // The apply writes only the approved ids: a stale row outside them stays as it is.
  const r = await backfillEffectiveDate(engine, { onlyIds: new Set<number>(), fresh: true });
  expect(r.updated).toBe(0);
  expect((await dates())['other:notes/b']).toBe('2020-01-01');
});
