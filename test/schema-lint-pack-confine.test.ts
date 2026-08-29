/**
 * schema_lint pack-name traversal confinement (pre-landing review fix).
 *
 * Pre-fix, schema_lint (scope: read, NOT localOnly — remote-reachable) joined
 * the caller-supplied `pack` straight into
 * $GBRAIN_HOME/schema-packs/<pack>/pack.{yaml,yml,json}: `pack: '..'` aimed
 * the join one level ABOVE the packs dir and, when a pack file existed there,
 * PARSED + LINTED it (existence oracle + arbitrary pack.yaml parse). The fix
 * reuses the mutate path's name guard (isValidPackName in
 * schema-pack/mutate.ts) BEFORE any join.
 *
 * Anti-enumeration contract: invalid names answer EXACTLY like missing packs
 * ({error:'pack_not_found', pack}), never a distinct "bad name" shape and
 * never a resolved path.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

const schema_lint = operations.find(o => o.name === 'schema_lint')!;

const home = mkdtempSync(join(tmpdir(), 'gbrain-lint-confine-'));
const packsDir = join(home, '.gbrain', 'schema-packs');
// Sentinel one level ABOVE the packs dir — exactly where `pack: '..'` aims
// the join (baseDir = schema-packs/.. = .gbrain, candidate .gbrain/pack.yaml).
// It is a VALID manifest on purpose: pre-fix, `pack: '..'` returned this
// file's clean lint report ({ok:true}) instead of pack_not_found.
const sentinelPath = join(home, '.gbrain', 'pack.yaml');
const SENTINEL_BYTES = [
  'api_version: gbrain-schema-pack-v1',
  'name: escaped-sentinel',
  'version: 1.0.0',
  '',
].join('\n');

function validManifest(name: string): string {
  return [
    'api_version: gbrain-schema-pack-v1',
    `name: ${name}`,
    'version: 1.0.0',
    '',
  ].join('\n');
}

// No engine needed: the `pack` branch of schema_lint never touches ctx.engine.
function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: { getConfig: async () => null } as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    ...overrides,
  } as OperationContext;
}

beforeAll(() => {
  // Legit installed packs, including the dot/underscore shapes the manifest
  // schema blesses (/^[a-z0-9._-]+$/) — the guard must keep linting them.
  for (const legit of ['my-fork', 'my_pack', 'notes.v2']) {
    mkdirSync(join(packsDir, legit), { recursive: true });
    writeFileSync(join(packsDir, legit, 'pack.yaml'), validManifest(legit));
  }
  writeFileSync(sentinelPath, SENTINEL_BYTES);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

// '' is deliberately absent: `if (p.pack)` treats it as "no pack param" and
// lints the ACTIVE pack (documented default) — it never reaches the join.
const BAD_NAMES = ['../evil', '..', '.hidden', 'a/b', '/etc/gbrain', 'x\0y', 'A-Upper', 'a'.repeat(129)];

describe('schema_lint pack-name confinement', () => {
  test('traversal/charset/NUL names → pack_not_found envelope; sentinel above packs dir is never parsed', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      for (const bad of BAD_NAMES) {
        const res = await schema_lint.handler(ctxOf(), { pack: bad }) as Record<string, unknown>;
        // Pre-fix, `pack: '..'` came back as the SENTINEL's lint report
        // ({ok:true, errors:[], warnings:[]}) — the escape this pins shut.
        expect(res.error).toBe('pack_not_found');
        expect(res.pack).toBe(bad);
        expect(res.ok).toBeUndefined();
        // Existence-oracle discipline: no resolved path in the envelope.
        expect(JSON.stringify(res)).not.toContain(home);
      }
      // The sentinel was neither modified nor consumed.
      expect(readFileSync(sentinelPath, 'utf8')).toBe(SENTINEL_BYTES);
    });
  });

  test('anti-enumeration: an invalid name answers byte-identically to a missing pack (modulo the echoed name)', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const invalid = await schema_lint.handler(ctxOf(), { pack: '../evil' }) as Record<string, unknown>;
      const missing = await schema_lint.handler(ctxOf(), { pack: 'no-such-pack' }) as Record<string, unknown>;
      const sub = (r: Record<string, unknown>) => JSON.stringify({ ...r, pack: '<name>' });
      expect(sub(invalid)).toBe(sub(missing));
    });
  });

  test('positive-accept: legit names still lint — including dot/underscore shapes the manifest schema blesses', async () => {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      for (const legit of ['my-fork', 'my_pack', 'notes.v2']) {
        const res = await schema_lint.handler(ctxOf(), { pack: legit }) as Record<string, unknown>;
        expect(res.error).toBeUndefined();
        expect(res).toHaveProperty('ok');
      }
    });
  });
});
