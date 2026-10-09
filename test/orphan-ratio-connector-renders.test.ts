/**
 * #5877 (Cl8, D5): connector renders (email/meeting pages of a google or
 * github source) are islanded by construction — participants are raw
 * addresses, never wikilinks — so they leave the orphan ratio's numerator
 * and denominator and are reported apart as `connector_renders_excluded`.
 * The fix hint names `--source db` (and `--source-id` when scoped) and says
 * what the metric measures: no links in either direction.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { findOrphans } from '../src/commands/orphans.ts';
import { runDoctor, type DoctorReport } from '../src/commands/doctor.ts';
import { setCliOptions } from '../src/core/cli-options.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';

let engine: PGLiteEngine;

const page = (title: string, type: string) => ({ type: type as 'note', title, compiled_truth: 'body', timeline: '', frontmatter: {} });

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await resetPgliteState(engine);
  setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null });
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES
    ('mail-example', 'mail-example', '{"kind":"google"}'::jsonb),
    ('notes-example', 'notes-example', '{}'::jsonb) ON CONFLICT DO NOTHING`);
  for (let i = 0; i < 5; i++) await engine.putPage(`emails/thread-${i}`, page(`Thread ${i}`, 'email'), { sourceId: 'mail-example' });
  await engine.putPage('calendar/standup', page('Standup', 'meeting'), { sourceId: 'mail-example' });
  // A connector-source page that is not a render still counts.
  await engine.putPage('notes/mail-digest', page('Digest', 'note'), { sourceId: 'mail-example' });
  // A git-source email page is not a connector render.
  await engine.putPage('emails/hand-written', page('Hand written', 'email'), { sourceId: 'notes-example' });
  await engine.putPage('notes/orphan', page('Orphan note', 'note'), { sourceId: 'notes-example' });
  await engine.putPage('notes/orphan-2', page('Orphan note 2', 'note'), { sourceId: 'notes-example' });
  await engine.putPage('notes/linked-a', page('Linked A', 'note'), { sourceId: 'notes-example' });
  await engine.putPage('notes/linked-b', page('Linked B', 'note'), { sourceId: 'notes-example' });
  await engine.addLinksBatch([{ from_slug: 'notes/linked-a', to_slug: 'notes/linked-b', link_type: 'mentions', link_source: 'markdown', context: '',
    from_source_id: 'notes-example', to_source_id: 'notes-example', origin_source_id: 'notes-example' }]);
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

async function doctorCheck(args: string[]) {
  const out: string[] = [];
  const log = console.log;
  const err = console.error;
  const exit = process.exit;
  console.log = (msg?: unknown) => { out.push(String(msg)); };
  console.error = () => {};
  (process as { exit: unknown }).exit = (() => { throw new Error('__exit'); }) as unknown as typeof process.exit;
  try {
    await runDoctor(engine, ['--json', ...args]);
  } catch (e) {
    if (!(e instanceof Error && e.message === '__exit')) throw e;
  } finally {
    console.log = log; console.error = err; (process as { exit: unknown }).exit = exit;
    _resetCliExitVerdictForTests();
  }
  for (let i = out.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(out[i]!) as DoctorReport;
      if (parsed && 'checks' in parsed) return parsed.checks.find(c => c.name === 'orphan_ratio')!;
    } catch { /* not the report */ }
  }
  throw new Error('no doctor report');
}

describe('#5877 connector renders', () => {
  test('connector email/meeting renders are counted apart; only real orphans count', async () => {
    const result = await findOrphans(engine, {});
    expect(result.orphans.map(o => o.slug).sort()).toEqual(['emails/hand-written', 'notes/mail-digest', 'notes/orphan', 'notes/orphan-2']);
    expect(result.connector_renders_excluded).toBe(6);
    expect(result.total_pages).toBe(12);
    expect(result.total_linkable).toBe(6);
  });

  test('--include-pseudo keeps every islanded page', async () => {
    const result = await findOrphans(engine, { includePseudo: true });
    expect(result.orphans).toHaveLength(10);
    expect(result.connector_renders_excluded).toBe(0);
  });

  test('a connector source of only renders is not reported as a failing orphan ratio', async () => {
    const result = await findOrphans(engine, { sourceId: 'mail-example' });
    expect(result.orphans.map(o => o.slug)).toEqual(['notes/mail-digest']);
    expect(result.connector_renders_excluded).toBe(6);
    expect(result.total_linkable).toBe(1);
  });

  test('doctor orphan_ratio reports connector_renders_excluded and leaves them out of the ratio', async () => {
    const check = await doctorCheck(['--source', 'mail-example']);
    expect(check.details).toEqual({ connector_renders_excluded: 6 });
    expect(check.message).toContain('Orphan ratio 100% in source \'mail-example\' (1/1 linkable pages have no links in either direction');
    expect(check.message).toContain('6 connector email/meeting renders are reported apart');
  }, 60_000);

  test('scoped hint names --source db and --source-id; wording is honest', async () => {
    const check = await doctorCheck(['--source', 'notes-example']);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('have no links in either direction');
    expect(check.message).not.toContain('no inbound links');
    expect(check.message).toContain('Run: gbrain extract links --by-mention --source db --source-id notes-example');
    expect(check.message).toContain('Run gbrain orphans --source notes-example for the list.');
    expect(check.details).toEqual({ connector_renders_excluded: 0 });
  }, 60_000);
});
