/**
 * The large-page bench receipt (scripts/bench-large-pages-receipt.ts; Wave C PR 1G, record-only).
 *
 * 1. Protects: validateReceipt accepts a conforming receipt and names each problem with a broken one (schema, version,
 *    unknown or duplicate stages, a publishing door stage without its lock hold or Git sizes, a group run in part,
 *    needles that are not one per decile inside the page); and a small real run of the bench's door stages
 *    (`--stages door`, a temporary strict source with a bare remote) writes a receipt that conforms, whose 10 decile
 *    probes all hit, whose lock holds are positive and fit inside their stages, whose queued small write was measured,
 *    and whose loose Git bytes grow with each publication.
 * 2. Fails when: the receipt shape drifts from its schema, or the bench stops writing through the door.
 * 3. The small run uses PGLite, and Postgres when DATABASE_URL is set.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DOOR_STAGES, RECEIPT_SCHEMA, RECEIPT_VERSION, validateReceipt, type Receipt, type ReceiptStage } from '../../scripts/bench-large-pages-receipt.ts';
import { testBackends } from '../helpers/test-backends.ts';

const dir = mkdtempSync(join(tmpdir(), 'gbrain-bench-receipt-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const git = { loose_objects: 3, loose_bytes: 4096, packs: 0, packed_bytes: 0 };
const needles = Array.from({ length: 10 }, (_, decile) => ({ decile, word: `gbneedle${decile}s1`, offset: decile * 1000 + 10 }));
const doorStage = (name: ReceiptStage['name']): ReceiptStage => name === 'door_probes'
  ? { name, ms: 12, rss_peak_bytes: 1 << 20, rows: { found: 10, total: 10 } }
  : { name, ms: 120.5, rss_peak_bytes: 1 << 26, rows: { pages: 2, chunks: 40 }, git, lock_hold_ms: 30.2, detail: { committed_ms: 100 } };
const valid = (): Receipt => ({ schema: RECEIPT_SCHEMA, version: RECEIPT_VERSION, engine: 'pglite', commit: 'a'.repeat(40), started_at: '2026-10-25T10:05:00.000Z',
  wall_ms: 900, rss_peak_bytes: 1 << 26, pages: [{ slug: 'bench/door-page', bytes: 10_240, seed: 2, sha256: 'b'.repeat(64), needles }],
  stages: DOOR_STAGES.map(doorStage) });

describe('bench receipt schema', () => {
  test('a conforming receipt has no problems', () => {
    expect(validateReceipt(valid())).toEqual([]);
    expect(validateReceipt({ ...valid(), commit: null, engine: 'postgres' })).toEqual([]);
  });

  test('each broken field is named', () => {
    const cases: Array<[string, (r: Receipt) => unknown, string]> = [
      ['schema', r => ({ ...r, schema: 'other' }), 'schema is "other"'],
      ['version', r => ({ ...r, version: 2 }), 'version is 2'],
      ['engine', r => ({ ...r, engine: 'sqlite' }), 'engine is "sqlite"'],
      ['wall_ms', r => ({ ...r, wall_ms: -1 }), 'wall_ms is not a duration'],
      ['unknown stage', r => ({ ...r, stages: [...r.stages, { ...doorStage('door_put'), name: 'door_rebuild' }] }), 'unknown stage name'],
      ['duplicate stage', r => ({ ...r, stages: [...r.stages, doorStage('door_put')] }), 'duplicate stage'],
      ['lock hold', r => ({ ...r, stages: r.stages.map(s => s.name === 'door_append' ? { ...s, lock_hold_ms: undefined } : s) }), 'door_append): lock_hold_ms is not a duration'],
      ['git sizes', r => ({ ...r, stages: r.stages.map(s => s.name === 'door_splice' ? { ...s, git: { ...git, packed_bytes: -1 } } : s) }), 'door_splice): git needs'],
      ['rows', r => ({ ...r, stages: r.stages.map(s => s.name === 'door_put' ? { ...s, rows: { chunks: 1.5 } } : s) }), 'door_put): rows is not a map of counts'],
      ['part of a group', r => ({ ...r, stages: r.stages.filter(s => s.name !== 'door_splice') }), 'missing door_splice'],
      ['needles', r => ({ ...r, pages: [{ ...r.pages[0]!, needles: needles.slice(0, 9) }] }), 'pages[0] needs 10 needles'],
      ['needle outside', r => ({ ...r, pages: [{ ...r.pages[0]!, needles: needles.map(n => n.decile === 9 ? { ...n, offset: 10_240 } : n) }] }), 'pages[0] needs 10 needles'],
      ['no stages', r => ({ ...r, stages: [] }), 'stages is not a non-empty array'],
    ];
    for (const [label, broken, problem] of cases) {
      const problems = validateReceipt(broken(valid()));
      expect({ label, hit: problems.some(p => p.includes(problem)) }).toEqual({ label, hit: true });
    }
    expect(validateReceipt(null)).toEqual(['receipt is not an object']);
  });
});

for (const kind of testBackends()) describe(`bench door stages, a small run (${kind})`, () => {
  test('writes a conforming receipt through the door', async () => {
    const out = join(dir, `receipt-${kind}.json`);
    const env: Record<string, string | undefined> = { ...process.env, DATABASE_URL: kind === 'postgres' ? process.env.DATABASE_URL : undefined };
    const run = Bun.spawn([process.execPath, resolve(import.meta.dir, '../../scripts/bench-large-pages.ts'), '--engine', kind, '--stages', 'door',
      '--put', '256KiB', '--door-page', '2MiB', '--out', out], { env, stdout: 'pipe', stderr: 'pipe' });
    const [code, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);
    expect({ code, stderr: code === 0 ? '' : stderr }).toEqual({ code: 0, stderr: '' });
    const receipt = JSON.parse(readFileSync(out, 'utf8')) as Receipt;
    expect(validateReceipt(receipt)).toEqual([]);
    expect({ engine: receipt.engine, stages: receipt.stages.map(s => s.name), pages: receipt.pages.map(p => [p.slug, p.bytes]) })
      .toEqual({ engine: kind, stages: [...DOOR_STAGES], pages: [['bench/door-put', 256 * 1024], ['bench/door-page', 2 * 1024 ** 2]] });
    const stage = (name: string) => receipt.stages.find(s => s.name === name)!;
    expect(stage('door_probes').rows).toEqual({ found: 10, total: 10 });
    const publishing = receipt.stages.filter(s => s.lock_hold_ms !== undefined);
    expect(publishing.map(s => s.name)).toEqual(['door_put', 'door_create', 'door_append', 'door_splice']);
    for (const s of publishing) {
      expect(s.lock_hold_ms!).toBeGreaterThan(0);
      expect(s.lock_hold_ms!).toBeLessThanOrEqual(s.ms);
    }
    expect(stage('door_put').detail?.queued_small_write_ms as number).toBeGreaterThan(0);
    const loose = publishing.map(s => s.git!.loose_bytes);
    expect(loose).toEqual([...loose].sort((a, b) => a - b));
    expect(new Set(loose).size).toBe(loose.length);
  }, 300_000);
});
