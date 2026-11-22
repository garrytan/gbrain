/**
 * Shadow replay minimizer (src/shadow/minimize.ts) and the saved synthetic cases (test/fixtures/shadow-replay/).
 *
 * Protects: synthesis replaces every input string, word, key, number and vector (short and non-ASCII names
 * included) and the leak gate refuses a case that keeps any of them, plain or base64/hex encoded; a difference that
 * survives synthesis becomes a case that still differs on fresh brains; one that does not is `not_minimizable` and
 * nothing is exported; every saved case still behaves as its file says (open: still differs the same way; fixed:
 * every arm agrees), on fresh PGLite and, when the addon is built, Rust brains.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import type { EngineConfig } from '../src/core/types.ts';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine } from '../src/core/rust-engine.ts';
import { encodeValue } from '../src/shadow/codec.ts';
import type { CaptureRecord } from '../src/shadow/capture.ts';
import { assertNoLeak, caseSignature, minimizeDifference, Synthesizer, type ReproCase } from '../src/shadow/minimize.ts';
import type { ArmName } from '../src/shadow/replay.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'gbrain-minimize-')); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const VECTOR = Array.from({ length: 16 }, (_, i) => 0.123456 + i / 97);
const SENSITIVE = [
  'people/zoë-ñandú',
  { type: 'person', title: 'Al Zoë Ñandú', compiled_truth: 'Al met Bo about project nightjar, invoice 48213.', frontmatter: { secret_key: 'Bo', employee_id: 48213 } },
  { $typed: 'Float32Array', v: VECTOR },
  { limit: 10, since: '2026-11-03T08:00:00.000Z' },
];

describe('synthesis and the leak gate', () => {
  test('every input string, word, key, number and vector is replaced, short and non-ASCII ones included', () => {
    const out = new Synthesizer([SENSITIVE]).value(SENSITIVE);
    expect(() => assertNoLeak([SENSITIVE], out)).not.toThrow();
    const text = JSON.stringify(out);
    for (const s of ['zoë', 'ñandú', 'nightjar', 'secret_key', 'employee_id', '48213', '2026-11-03', String(VECTOR[3])]) expect(text.toLowerCase()).not.toContain(s.toLowerCase());
    expect(text).not.toMatch(/\bAl\b|\bBo\b/);
    expect((out as unknown[])[1]).toMatchObject({ type: 'person' });
    expect((out as Array<Record<string, unknown>>)[3]!.limit).toBe(10);
    expect(((out as Array<{ v: number[] }>)[2]!.v).length).toBe(16);
  });

  test('the gate refuses a case that keeps a short word, an encoded string, a number or a vector value', () => {
    const leak = (o: unknown) => () => assertNoLeak([SENSITIVE], o);
    expect(leak({ title: 'zqa Al zqb' })).toThrow(/shadow_replay_minimizer_leak/);
    expect(leak({ text: Buffer.from('nightjar').toString('base64') })).toThrow(/shadow_replay_minimizer_leak/);
    expect(leak({ text: Buffer.from('nightjar').toString('hex') })).toThrow(/shadow_replay_minimizer_leak/);
    expect(leak({ n: 48213 })).toThrow(/shadow_replay_minimizer_leak/);
    expect(leak({ v: [0.5, VECTOR[7]] })).toThrow(/shadow_replay_minimizer_leak/);
    expect(leak({ text: 'zqa zqb', limit: 10 })).not.toThrow();
  });
});

/** In-memory arms: `rust` changes frontmatter values (always, or only when the title holds a given word). */
function memoryArm(opts: { alterFrontmatter?: boolean; onlyWhenTitleHas?: string } = {}): BrainEngine {
  const pages = new Map<string, Record<string, unknown>>();
  const tags = new Map<string, string[]>();
  return {
    async putPage(slug: string, p: Record<string, unknown>) {
      const alter = opts.alterFrontmatter && (!opts.onlyWhenTitleHas || String(p.title).includes(opts.onlyWhenTitleHas));
      const fm = alter ? Object.fromEntries(Object.keys((p.frontmatter ?? {}) as object).map(k => [k, 'changed'])) : p.frontmatter;
      pages.set(slug, { slug, title: p.title, type: p.type, compiled_truth: p.compiled_truth, frontmatter: fm });
      return { slug };
    },
    async getPage(slug: string) { return pages.get(slug) ?? null; },
    async addTag(slug: string, tag: string) { tags.set(slug, [...(tags.get(slug) ?? []), tag]); },
    async getTags(slug: string) { return tags.get(slug) ?? []; },
    async disconnect() {},
  } as unknown as BrainEngine;
}

function rec(member: string, args: unknown[]): CaptureRecord {
  return { v: 1, proc: 'p', seq: 1, t0: 0, t1: 0, kind: 'engine', member, args: encodeValue(args) } as CaptureRecord;
}

describe('minimizeDifference', () => {
  const reference = memoryArm();
  const page = { type: 'person', title: 'Zoë Nightjar', compiled_truth: 'met about nightjar', frontmatter: { secret_key: 'Bo' } };

  test('a difference that survives synthesis becomes a synthetic case that still differs', async () => {
    await reference.putPage('people/zoë-ñandú', page as never);
    const arms = (rustOpts: Parameters<typeof memoryArm>[0]) => ({ freshArm: async (a: ArmName) => memoryArm(a === 'rust' ? rustOpts : {}), reference });
    const r = await minimizeDifference([rec('getPage', ['people/zoë-ñandú'])], [], { class: 'differs', path: ['frontmatter', 'secret_key'] }, arms({ alterFrontmatter: true }));
    expect(r).toMatchObject({ ok: true });
    const c = (r as { case: ReproCase }).case;
    expect(c.expect.class).toBe('differs');
    expect(() => assertNoLeak([page, 'people/zoë-ñandú'], c)).not.toThrow();
    expect(await caseSignature(c, arms({ alterFrontmatter: true }))).not.toBeNull();
  });

  test('a difference that depends on a real word is not_minimizable and exports nothing', async () => {
    const r = await minimizeDifference([rec('getPage', ['people/zoë-ñandú'])], [], { class: 'differs', path: ['frontmatter', 'secret_key'] },
      { freshArm: async (a: ArmName) => memoryArm(a === 'rust' ? { alterFrontmatter: true, onlyWhenTitleHas: 'Nightjar' } : {}), reference });
    expect(r).toEqual({ ok: false, reason: 'not_minimizable' });
  });
});

const TARGET = detectAddonTarget();
const BUILT = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
const FIXTURES = join(import.meta.dir, 'fixtures', 'shadow-replay');

describe('saved synthetic cases', () => {
  for (const file of readdirSync(FIXTURES).filter(f => f.endsWith('.json')).sort()) {
    test.skipIf(!HAVE_ADDON)(`${file} behaves as its status says on fresh PGLite and Rust brains`, async () => {
      const c = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')) as ReproCase;
      const freshArm = async (arm: ArmName): Promise<BrainEngine> => {
        const dir = tmp();
        if (arm === 'rust') {
          const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
          const e = openRustEngine({ addon: addon as never, databasePath: join(dir, 'rust') });
          await e.connect({ engine: 'pglite', database_path: join(dir, 'rust') } as never);
          return e as unknown as BrainEngine;
        }
        const cfg = { engine: 'pglite', database_path: join(dir, 'pglite') } as EngineConfig;
        const e = await createEngine(cfg);
        await e.connect(cfg);
        await e.initSchema();
        return e;
      };
      const sig = await caseSignature(c, { freshArm, reference: null as never });
      if (c.status === 'fixed') expect(sig).toBeNull();
      else expect(sig?.class).toBe(c.expect.class);
    }, 120_000);
  }
});
