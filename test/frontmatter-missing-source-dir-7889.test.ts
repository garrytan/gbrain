/**
 * #7889: a registered source whose local_path does not exist was reported `scanned` with zero files, so both frontmatter
 * doctor checks called it clean. It is now `missing`: the audit is not ok, both checks warn with the path and the
 * restore / set-path step, and neither blames a timeout. An existing empty directory stays clean.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { scanBrainSources } from '../src/core/brain-writer.ts';
import { frontmatterEntry } from '../src/commands/doctor/checks/content-quality.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
let root: string;
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-7889-'));
  mkdirSync(join(root, 'empty'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); });

const runChecks = async () => await frontmatterEntry.run({ engine, args: [], progress: { heartbeat() {} } } as never) as Check[];

test('an existing empty directory is a clean scan', async () => {
  await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('source-empty','source-empty',$1)", [join(root, 'empty')]);
  const report = await scanBrainSources(engine);
  expect(report).toMatchObject({ ok: true, partial: false });
  expect(report.missing_sources).toBeUndefined();
  expect((await runChecks()).map(c => [c.name, c.status])).toEqual([['frontmatter_integrity', 'ok'], ['frontmatter_repairable', 'ok']]);
});

// Value: protects=a registered source with a missing directory is never reported frontmatter-clean (#7889);
// fails_when=scanBrainSources records a nonexistent local_path as status 'scanned' or the checks fold it into the timeout story;
// why_new=the missing-path scanner test only asserted zero counts; seam=scanBrainSources + frontmatterEntry.run on PGLite;
// no_claim=the deadline/partial paths, covered by doctor-frontmatter-partial and brain-writer-partial-scan.
test('a registered source whose directory is missing is unverified in the audit and in both doctor checks', async () => {
  const absent = join(root, 'absent');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path) VALUES('source-ghost','source-ghost',$1)", [absent]);
  const report = await scanBrainSources(engine);
  expect(report).toMatchObject({ ok: false, partial: false, aborted_at_source: null, missing_sources: ['source-ghost'] });
  expect(report.per_source.find(s => s.source_id === 'source-ghost')).toMatchObject({ status: 'missing', files_scanned: 0 });
  expect(report.per_source.find(s => s.source_id === 'source-empty')).toMatchObject({ status: 'scanned' });

  const checks = await runChecks();
  for (const check of checks) {
    expect(check.status).toBe('warn');
    expect(check.message).toContain(absent);
    expect(check.message).toContain('missing');
    expect(check.message).toContain('gbrain sources set-path');
    expect(check.message).not.toContain('timeout');
    expect(check.message).not.toContain('GBRAIN_DOCTOR_FM_TIMEOUT_MS');
    expect(check.fix_unavailable_reason).toBe('operator_judgement');
  }
  expect(checks.find(c => c.name === 'frontmatter_integrity')!.details).toMatchObject({ missing_sources: ['source-ghost'], partial: false, exact: false });
});
