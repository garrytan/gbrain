/**
 * Tests for `scanStaleMentions` (src/core/by-mention.ts) and the doctor
 * `stale_mentions` check that formats it — issue #3674.
 *
 * The gap being covered: `extract links --by-mention` writes through
 * addLinksBatch, which is additive, and put_page reconciliation deliberately
 * excludes 'mentions'. So a mentions row outlives its own justification, and
 * re-running the scan adds correct links alongside the stale ones instead of
 * replacing them. This check is the read-only half — it makes the drift
 * visible; it must never delete anything.
 *
 * Hermetic via PGLite.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { scanStaleMentions } from '../src/core/by-mention.ts';
import { runDoctor, type DoctorReport } from '../src/commands/doctor.ts';
import { setCliOptions } from '../src/core/cli-options.ts';
import { BRAIN_CHECK_NAMES, categorizeCheck } from '../src/core/doctor-categories.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  restoreCli();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM links');
  await engine.executeRaw('DELETE FROM pages');
  await engine.executeRaw("DELETE FROM sources WHERE id != 'default'");
});

async function putEntity(slug: string, title: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'company', title, compiled_truth: `${title} is a company.`,
    timeline: '', frontmatter: {},
  });
}

async function putNote(slug: string, body: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'note', title: slug, compiled_truth: body, timeline: '', frontmatter: {},
  });
}

async function link(from: string, to: string, kind: string | null = 'plain'): Promise<void> {
  await engine.addLinksBatch([{
    from_slug: from, to_slug: to, link_type: 'mentions',
    link_source: 'mentions', ...(kind === null ? {} : { link_kind: kind }),
  }]);
}

async function countLinks(): Promise<number> {
  const r = await engine.executeRaw<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM links WHERE link_source = 'mentions'`, []);
  return r[0]?.count ?? 0;
}

describe('scanStaleMentions', () => {
  test('empty brain — nothing to report, no gazetteer build implied', async () => {
    const res = await scanStaleMentions(engine);
    expect(res.totalPagesWithMentions).toBe(0);
    expect(res.staleLinks).toBe(0);
    expect(res.pagesScanned).toBe(0);
  });

  test('a link the current gazetteer still produces is NOT stale', async () => {
    await putEntity('companies/acme-example', 'Acme Example');
    await putNote('notes/meeting', 'Met with Acme Example about the widget deal.');
    await link('notes/meeting', 'companies/acme-example');

    const res = await scanStaleMentions(engine);
    expect(res.totalPagesWithMentions).toBe(1);
    expect(res.linksScanned).toBe(1);
    expect(res.staleLinks).toBe(0);
    expect(res.emptyGazetteer).toBe(false);
  });

  test('body rewritten so it no longer names the entity — link goes stale', async () => {
    // This is the exact reproduction in the issue: put_page reconciliation
    // excludes 'mentions', so rewriting the body leaves the row behind.
    await putEntity('companies/acme-example', 'Acme Example');
    await putNote('notes/meeting', 'Met with Acme Example about the widget deal.');
    await link('notes/meeting', 'companies/acme-example');
    await putNote('notes/meeting', 'Met with nobody today. Quiet day.');

    const res = await scanStaleMentions(engine);
    expect(res.staleLinks).toBe(1);
    expect(res.staleByKind).toEqual({ plain: 1 });
    expect(res.examples).toEqual([
      { from: 'notes/meeting', to: 'companies/acme-example', kind: 'plain' },
    ]);
  });

  test('entity page soft-deleted — link goes stale', async () => {
    await putEntity('companies/acme-example', 'Acme Example');
    await putNote('notes/meeting', 'Met with Acme Example about the widget deal.');
    await link('notes/meeting', 'companies/acme-example');
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() WHERE slug = 'companies/acme-example'`, []);

    const res = await scanStaleMentions(engine);
    expect(res.staleLinks).toBe(1);
    // Deleting the only entity empties the gazetteer — the caller needs to
    // distinguish that from ordinary drift.
    expect(res.emptyGazetteer).toBe(true);
  });

  test('typed_ner rows are counted, and reported separately from plain', async () => {
    // extract-ner shares link_source='mentions' with link_kind='typed_ner',
    // which is precisely why a cleanup cannot delete by link_source alone.
    await putEntity('companies/acme-example', 'Acme Example');
    await putNote('notes/meeting', 'Met with Acme Example about the widget deal.');
    await link('notes/meeting', 'companies/acme-example', 'plain');
    await engine.addLinksBatch([{
      from_slug: 'notes/meeting', to_slug: 'companies/acme-example',
      link_type: 'works_at', link_source: 'mentions', link_kind: 'typed_ner',
    }]);
    await putNote('notes/meeting', 'Met with nobody today. Quiet day.');

    const res = await scanStaleMentions(engine);
    expect(res.staleLinks).toBe(2);
    expect(res.staleByKind).toEqual({ plain: 1, typed_ner: 1 });
  });

  test('legacy NULL link_kind reports as plain, not as a missing bucket', async () => {
    await putEntity('companies/acme-example', 'Acme Example');
    await putNote('notes/meeting', 'Met with Acme Example about the widget deal.');
    await link('notes/meeting', 'companies/acme-example', null);
    await putNote('notes/meeting', 'Nothing here.');

    const res = await scanStaleMentions(engine);
    expect(res.staleLinks).toBe(1);
    expect(res.staleByKind).toEqual({ plain: 1 });
  });

  test('is strictly read-only — a stale row is still there afterwards', async () => {
    await putEntity('companies/acme-example', 'Acme Example');
    await putNote('notes/meeting', 'Met with Acme Example about the widget deal.');
    await link('notes/meeting', 'companies/acme-example');
    await putNote('notes/meeting', 'Nothing here.');

    expect(await countLinks()).toBe(1);
    const res = await scanStaleMentions(engine);
    expect(res.staleLinks).toBe(1);
    expect(await countLinks()).toBe(1);   // the check must not repair
    // Idempotent: a second run reports the same thing.
    expect((await scanStaleMentions(engine)).staleLinks).toBe(1);
    expect(await countLinks()).toBe(1);
  });

  test('limit bounds the scan and totalPagesWithMentions stays unbounded', async () => {
    // Coverage must be disclosable — a bounded scan that reported the bounded
    // total would read as full coverage.
    await putEntity('companies/acme-example', 'Acme Example');
    for (const n of ['a', 'b', 'c']) {
      await putNote(`notes/${n}`, 'Nothing here.');
      await link(`notes/${n}`, 'companies/acme-example');
    }
    const res = await scanStaleMentions(engine, { limit: 2 });
    expect(res.totalPagesWithMentions).toBe(3);
    expect(res.pagesScanned).toBe(2);
    expect(res.linksScanned).toBe(2);
    expect(res.staleLinks).toBe(2);
  });

  test('self-link and cross-source guards are honoured, as in the real scan', async () => {
    // findMentionedEntities suppresses both, so neither can ever be produced
    // — a stored row of either shape is stale by construction.
    await putEntity('companies/acme-example', 'Acme Example');
    await putNote('notes/meeting', 'Acme Example is great.');
    await link('notes/meeting', 'companies/acme-example');
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING`, []);
    await engine.executeRaw(
      `UPDATE pages SET source_id = 'other' WHERE slug = 'companies/acme-example'`, []);

    const res = await scanStaleMentions(engine);
    expect(res.staleLinks).toBe(1);   // cross-source: no longer produced
  });
});

// ============================================================
// Doctor surface — the check is emitted, worded, and categorized
// ============================================================

let stdoutBuffer: string[] = [];
const origLog = console.log;
const origErr = console.error;
const origExit = process.exit;

function captureCli(): void {
  stdoutBuffer = [];
  console.log = (msg?: unknown) => { stdoutBuffer.push(typeof msg === 'string' ? msg : String(msg)); };
  console.error = () => {};
  (process as { exit: unknown }).exit = (() => { throw new Error('__exit'); }) as unknown as typeof process.exit;
}

function restoreCli(): void {
  console.log = origLog;
  console.error = origErr;
  (process as { exit: unknown }).exit = origExit;
}

async function runDoctorJson(): Promise<DoctorReport> {
  captureCli();
  try {
    // No --fast: stale_mentions sits in the DB-checks group that --fast skips.
    await runDoctor(engine, ['--json']);
  } catch (e) {
    if (!(e instanceof Error && e.message === '__exit')) throw e;
  } finally {
    restoreCli();
  }
  for (let i = stdoutBuffer.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(stdoutBuffer[i]!);
      if (parsed && typeof parsed === 'object' && 'checks' in parsed) return parsed as DoctorReport;
    } catch { /* skip non-JSON lines */ }
  }
  throw new Error('No DoctorReport JSON found in stdout');
}

describe('runDoctor — stale_mentions check', () => {
  test('clean brain → ok, and the check is actually present', async () => {
    await putEntity('companies/acme-example', 'Acme Example');
    await putNote('notes/meeting', 'Met with Acme Example about the widget deal.');
    await link('notes/meeting', 'companies/acme-example');

    const check = (await runDoctorJson()).checks.find(c => c.name === 'stale_mentions');
    expect(check).toBeDefined();
    expect(check!.status).toBe('ok');
  });

  test('drifted brain → warn, names the additive write path and the workaround', async () => {
    await putEntity('companies/acme-example', 'Acme Example');
    await putNote('notes/meeting', 'Met with Acme Example about the widget deal.');
    await link('notes/meeting', 'companies/acme-example');
    await putNote('notes/meeting', 'Met with nobody today. Quiet day.');

    const check = (await runDoctorJson()).checks.find(c => c.name === 'stale_mentions');
    expect(check!.status).toBe('warn');
    // The operator has to learn two things from this message or it is useless:
    // that re-running the scan will NOT fix it, and what to do instead.
    expect(check!.message).toContain('will NOT remove them');
    expect(check!.message).toContain('gbrain unlink');
    expect(check!.message).toContain('notes/meeting -> companies/acme-example');
    // Read-only: no repair is offered, because none exists yet (#3674).
    expect(check!.remediation ?? []).toEqual([]);
  });

  test('is categorized — not silently degraded to meta', () => {
    expect(BRAIN_CHECK_NAMES.has('stale_mentions')).toBe(true);
    expect(categorizeCheck('stale_mentions')).toBe('brain');
  });
});
