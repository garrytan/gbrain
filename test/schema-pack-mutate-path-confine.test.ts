/**
 * A3 (test-gap wave 1) — caller-controlled `pack` path traversal in
 * schema_apply_mutations. Pre-fix, `locateMutablePackFile` joined the raw
 * pack name into $GBRAIN_HOME/schema-packs/<name> with no traversal/charset
 * guard; the op is admin-scope but NOT localOnly, so a remote MCP caller
 * could aim the join outside the packs dir. The bundled-name gate
 * (PACK_READONLY) existed; INVALID_PACK_NAME is the new guard.
 *
 * Error taxonomy: the op layer never throws — it returns
 * {error:'mutation_failed', code, ...} — so the op half asserts on the
 * RETURNED envelope, and the unit half on the thrown SchemaPackMutationError.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { locateMutablePackFile, SchemaPackMutationError } from '../src/core/schema-pack/mutate.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

const schema_apply_mutations = operations.find(o => o.name === 'schema_apply_mutations')!;

const home = mkdtempSync(join(tmpdir(), 'gbrain-pack-confine-'));
const packsDir = join(home, '.gbrain', 'schema-packs');
// Sentinel one level ABOVE the packs dir — exactly where `pack: '..'` would
// have aimed the join (baseDir = schema-packs/.. = .gbrain, candidate
// .gbrain/pack.json). Must stay byte-identical through every attack below.
const sentinelPath = join(home, '.gbrain', 'pack.json');
const SENTINEL_BYTES = '{"sentinel":"do-not-touch"}\n';

let engine: PGLiteEngine;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    ...overrides,
  } as OperationContext;
}

beforeAll(async () => {
  // 'my-fork' plus the dot/underscore shapes the manifest schema blesses
  // (/^[a-z0-9._-]+$/ in manifest-v1.ts) and schema init/fork never
  // validated — pre-existing packs with these names exist legally, so the
  // guard must ACCEPT them (refusal would permanently brick their mutation).
  for (const legit of ['my-fork', 'my_pack', 'notes.v2']) {
    mkdirSync(join(packsDir, legit), { recursive: true });
    writeFileSync(join(packsDir, legit, 'pack.json'), '{"not":"a-valid-manifest"}\n');
  }
  writeFileSync(sentinelPath, SENTINEL_BYTES);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
}, 60_000);

// '.hidden' pins the leading-alnum rule: dots are legal INSIDE a name
// ('notes.v2' is accepted below) but a leading dot ('.', '..', dotfiles)
// stays INVALID_PACK_NAME.
const BAD_NAMES = ['../evil', '..', '.hidden', 'a/b', '/etc/gbrain', '', 'x\0y', 'A-Upper', 'a'.repeat(129)];

describe('locateMutablePackFile name guard (unit half)', () => {
  test('traversal/charset/NUL/oversize names throw INVALID_PACK_NAME, no path echo', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      for (const bad of BAD_NAMES) {
        let thrown: unknown;
        try { locateMutablePackFile(bad); } catch (e) { thrown = e; }
        expect(thrown).toBeInstanceOf(SchemaPackMutationError);
        const err = thrown as SchemaPackMutationError;
        expect(err.code).toBe('INVALID_PACK_NAME');
        // Existence-oracle discipline: the NEW guard's message never carries
        // a resolved absolute path.
        expect(err.message).not.toContain(home);
        expect(JSON.stringify(err.details ?? {})).not.toContain(home);
      }
    });
  });

  test('bundled names keep the existing PACK_READONLY contract (never INVALID_PACK_NAME)', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      for (const bundled of ['gbrain-base', 'gbrain-recommended']) {
        let thrown: unknown;
        try { locateMutablePackFile(bundled); } catch (e) { thrown = e; }
        expect((thrown as SchemaPackMutationError).code).toBe('PACK_READONLY');
      }
    });
  });

  test('positive-accept: legit non-bundled names resolve — including dot/underscore shapes the manifest schema blesses', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      // 'my_pack' / 'notes.v2' were INVALID_PACK_NAME under the initial
      // kebab-only guard — a compat break for legally-created packs. The
      // widened guard (^[a-z0-9][a-z0-9._-]*$) accepts them.
      for (const legit of ['my-fork', 'my_pack', 'notes.v2']) {
        const located = locateMutablePackFile(legit);
        expect(located.path).toBe(join(packsDir, legit, 'pack.json'));
        expect(located.format).toBe('json');
      }
    });
  });
});

describe('schema_apply_mutations op envelope (op half)', () => {
  const mutation = [{ op: 'add_alias', alias: 'probe', target: 'note' }];

  test('traversal pack names return code INVALID_PACK_NAME; sentinel stays byte-identical', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      for (const bad of ['../evil', '..', 'a/b', '/etc/gbrain']) {
        const res = await schema_apply_mutations.handler(ctxOf(), { pack: bad, mutations: mutation }) as Record<string, unknown>;
        expect(res.error).toBe('mutation_failed');
        expect(res.code).toBe('INVALID_PACK_NAME');
        expect(JSON.stringify(res)).not.toContain(home);
      }
      expect(readFileSync(sentinelPath, 'utf8')).toBe(SENTINEL_BYTES);
    });
  });

  test('bundled pack name returns code PACK_READONLY through the envelope', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const res = await schema_apply_mutations.handler(ctxOf(), { pack: 'gbrain-base', mutations: mutation }) as Record<string, unknown>;
      expect(res.error).toBe('mutation_failed');
      expect(res.code).toBe('PACK_READONLY');
    });
  });

  test('positive-accept: a legit fork name passes the guard and proceeds to the manifest read', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      // The fixture manifest is deliberately invalid: reaching PACK_CORRUPT
      // proves the name cleared INVALID_PACK_NAME and the op read the file —
      // the guard cannot brick legit forks.
      const res = await schema_apply_mutations.handler(ctxOf(), { pack: 'my-fork', mutations: mutation }) as Record<string, unknown>;
      expect(res.code).not.toBe('INVALID_PACK_NAME');
      expect(res.code).not.toBe('PACK_READONLY');
    });
  });
});
