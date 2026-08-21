/**
 * #1475 — `gbrain config set eval.capture true` must actually turn capture on.
 *
 * The reported symptom is that the write persists and `config get` reads it
 * back as `true` (printing `source: db plane`), yet capture stays off unless
 * `GBRAIN_CONTRIBUTOR_MODE=1` is also exported. Three people reproduced it
 * independently, most recently on 0.46.1.0.
 *
 * There are two halves to it, and fixing either one alone leaves the symptom:
 *
 *   1. `loadConfigWithEngine` merges a fixed set of DB-plane keys and had no
 *      `eval.*` branch — so even an explicit DB-merge produced nothing.
 *   2. `makeContext` built `ctx.config` from the sync, file-only `loadConfig()`.
 *      `connectEngine` does re-merge after connect, but keeps the result to
 *      itself (env stashes + gateway reconfigure) and returns only the engine.
 *
 * The gate the runtime actually consults is `isEvalCaptureEnabled(ctx.config)`
 * (src/core/operations.ts), so this test asserts on that composition rather
 * than on either half — a unit test of the merge alone would have passed while
 * the reported symptom survived.
 *
 * Serial because it mutates process.env (GBRAIN_CONTRIBUTOR_MODE / GBRAIN_HOME).
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { makeContext } from '../src/cli.ts';
import { isEvalCaptureEnabled, isEvalScrubEnabled } from '../src/core/eval-capture.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/**
 * Stub engine whose config table holds exactly `dbConfig`. Mirrors the shape
 * `makeContext` touches: `getConfig` for the DB plane and `executeRaw` for the
 * source resolver (no rows — the brain has no `sources` entries).
 */
function makeStub(dbConfig: Record<string, string>): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async <T>(): Promise<T[]> => [],
    getConfig: async (key: string) => dbConfig[key] ?? null,
    listConfigKeys: async (prefix: string) =>
      Object.keys(dbConfig).filter(k => k.startsWith(prefix)),
  } as unknown as BrainEngine;
}

/** An empty GBRAIN_HOME so the file plane cannot supply eval.* from the machine. */
function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), 'gbrain-1475-'));
}

describe('eval.capture set on the DB plane reaches the runtime gate (#1475)', () => {
  test('capture is ON when only the DB plane says so, with CONTRIBUTOR_MODE unset', async () => {
    await withEnv(
      { GBRAIN_HOME: scratchHome(), GBRAIN_CONTRIBUTOR_MODE: undefined, GBRAIN_SOURCE: undefined },
      async () => {
        const ctx = await makeContext(makeStub({ 'eval.capture': 'true' }), {});
        expect(ctx.config?.eval?.capture).toBe(true);
        // The assertion that matches the bug report: the gate, not the field.
        expect(isEvalCaptureEnabled(ctx.config)).toBe(true);
      },
    );
  });

  test('control: with no DB value and no CONTRIBUTOR_MODE, capture stays off', async () => {
    // Without this the first test would also pass on a build that turned
    // capture on unconditionally.
    await withEnv(
      { GBRAIN_HOME: scratchHome(), GBRAIN_CONTRIBUTOR_MODE: undefined, GBRAIN_SOURCE: undefined },
      async () => {
        const ctx = await makeContext(makeStub({}), {});
        expect(ctx.config?.eval?.capture).toBeUndefined();
        expect(isEvalCaptureEnabled(ctx.config)).toBe(false);
      },
    );
  });

  test('DB eval.capture=false turns capture OFF even with CONTRIBUTOR_MODE=1', async () => {
    // The opt-out direction has to arrive too: a contributor who exported
    // CONTRIBUTOR_MODE and then asked a specific brain to stop capturing.
    await withEnv(
      { GBRAIN_HOME: scratchHome(), GBRAIN_CONTRIBUTOR_MODE: '1', GBRAIN_SOURCE: undefined },
      async () => {
        const ctx = await makeContext(makeStub({ 'eval.capture': 'false' }), {});
        expect(isEvalCaptureEnabled(ctx.config)).toBe(false);
      },
    );
  });

  test('eval.scrub_pii travels the same path', async () => {
    await withEnv(
      { GBRAIN_HOME: scratchHome(), GBRAIN_CONTRIBUTOR_MODE: undefined, GBRAIN_SOURCE: undefined },
      async () => {
        const ctx = await makeContext(makeStub({ 'eval.scrub_pii': 'false' }), {});
        expect(isEvalScrubEnabled(ctx.config)).toBe(false);
      },
    );
  });

  test('reuses the merge connectEngine already did — zero extra config reads', async () => {
    // The reason this fix does not make #3980 worse. connectEngine already
    // merges the DB plane once per command; makeContext consumes that result
    // instead of re-deriving it. If the publish in connectEngine is ever
    // dropped, this count goes from 0 to the full per-key read set.
    // Imported here rather than at module scope on purpose: a static named
    // import of `__testing` makes this whole FILE fail to link against a tree
    // that lacks the export, which would collapse the other cases' signal to a
    // single load error. Deferring it keeps each case independently
    // meaningful when someone reverts half the fix to see what breaks.
    const { __testing } = await import('../src/cli.ts');

    let keysRead: string[] = [];
    const counting = {
      kind: 'pglite',
      executeRaw: async <T>(): Promise<T[]> => [],
      getConfig: async (key: string) => {
        keysRead.push(key);
        return key === 'eval.capture' ? 'true' : null;
      },
    } as unknown as BrainEngine;

    await withEnv(
      { GBRAIN_HOME: scratchHome(), GBRAIN_CONTRIBUTOR_MODE: undefined, GBRAIN_SOURCE: undefined },
      async () => {
        // Uncached: makeContext falls back to merging itself, so it walks the
        // whole DB-plane key set. Measured at 25 reads on this tree — one for
        // the source resolver plus the merge's 24 keys.
        await makeContext(counting, {});
        const uncached = keysRead;
        expect(uncached).toContain('eval.capture');
        expect(uncached.length).toBeGreaterThan(10);

        // Primed exactly as connectEngine primes it.
        keysRead = [];
        __testing.publishMergedConfig(counting, { engine: 'pglite', eval: { capture: true } });
        const ctx = await makeContext(counting, {});

        // The only surviving read is the source resolver's, which is not
        // config-merge work and predates this change. Asserting the key set
        // rather than a bare count says WHICH read is allowed to remain, so a
        // future reader can tell an intentional addition from a regression.
        expect(keysRead).toEqual(['sources.default']);
        // …and the published value is what the gate sees, so "cheap" did not
        // come at the cost of "correct".
        expect(isEvalCaptureEnabled(ctx.config)).toBe(true);
      },
    );
  });

  test('a mounted brain\'s engine never re-merges the DB plane', async () => {
    // Adversarial-review fixup: the fallback merge above ran unconditionally
    // for ANY unpublished engine, including mount engines — connectEngine
    // only publishes for the host brain (MERGED_CONFIG_BY_ENGINE.set lives in
    // its host-only branch), so every mounted-brain command paid the full
    // per-key DB round-trip AND, worse, would have let the mount's DB-plane
    // config leak into the caller's ctx.config, a leak connectMountEngine's
    // gateway-scoped no-merge guarantee does not by itself prevent. This
    // pins both: no config-merge reads, and the DB's eval.capture=true does
    // not surface. Marks the engine object itself (not module-global brain
    // state) — the same provenance-follows-the-engine binding
    // MERGED_CONFIG_BY_ENGINE already uses, so this stays correct even if a
    // process ever holds a host engine and a mount engine at once.
    const { __testing } = await import('../src/cli.ts');
    let keysRead: string[] = [];
    const counting = {
      kind: 'pglite',
      executeRaw: async <T>(): Promise<T[]> => [],
      getConfig: async (key: string) => {
        keysRead.push(key);
        return key === 'eval.capture' ? 'true' : null;
      },
    } as unknown as BrainEngine;
    __testing.markEngineAsMountForTests(counting);

    await withEnv(
      { GBRAIN_HOME: scratchHome(), GBRAIN_CONTRIBUTOR_MODE: undefined, GBRAIN_SOURCE: undefined },
      async () => {
        const ctx = await makeContext(counting, {});
        // Only the source resolver's read survives — the DB-plane merge
        // branch is skipped entirely for a mount engine.
        expect(keysRead).toEqual(['sources.default']);
        expect(ctx.config?.eval?.capture).toBeUndefined();
        expect(isEvalCaptureEnabled(ctx.config)).toBe(false);
      },
    );
  });

  test('connectEngine still publishes its merge (the half the runtime test cannot reach)', async () => {
    // The test above primes the map directly, so it pins the CONSUMER. If the
    // publish in connectEngine were deleted, production would quietly fall
    // back to re-merging — correct output, 24 extra config reads per command,
    // and nothing red. connectEngine is not exported and needs a live brain,
    // so this is a source-level guard, the same shape test/cycle-abort.test.ts
    // uses for its own hard-to-exercise seam.
    const cli = await Bun.file(new URL('../src/cli.ts', import.meta.url).pathname).text();
    expect(cli).toContain('MERGED_CONFIG_BY_ENGINE.set(engine, merged)');
    // Guard the guard: if the map is ever renamed, the assertion above must
    // not keep passing against a stale literal that no longer exists.
    expect(cli).toContain('const MERGED_CONFIG_BY_ENGINE = new WeakMap');
  });

  test('connectMountEngine still marks its engine as a mount engine', async () => {
    // Mirrors the guard immediately above, for the mount-engine fixup
    // (PR #4186): the test that exercises makeContext's mount branch marks
    // the engine directly via __testing.markEngineAsMountForTests, so it
    // pins the CONSUMER (makeContext honors MOUNT_ENGINES) but not the real
    // wiring — if `MOUNT_ENGINES.add(handle.engine)` were ever deleted from
    // connectMountEngine, that test would still pass while every real mount
    // connection silently re-merged the mount's DB plane again.
    // connectMountEngine is not exported and needs a live BrainRegistry, so
    // this is a source-level guard, same shape as the one above.
    const cli = await Bun.file(new URL('../src/cli.ts', import.meta.url).pathname).text();
    expect(cli).toContain('MOUNT_ENGINES.add(handle.engine)');
    // Guard the guard: if the set is ever renamed, the assertion above must
    // not keep passing against a stale literal that no longer exists.
    expect(cli).toContain('const MOUNT_ENGINES = new WeakSet');
  });

  test('a brain whose config table is missing still builds a context (fail-open)', async () => {
    // Mid-migration brains must not lose the CLI entirely just because the
    // DB-plane read throws.
    const throwing = {
      kind: 'pglite',
      executeRaw: async <T>(): Promise<T[]> => [],
      getConfig: async () => {
        throw new Error('relation "config" does not exist');
      },
    } as unknown as BrainEngine;
    await withEnv(
      { GBRAIN_HOME: scratchHome(), GBRAIN_CONTRIBUTOR_MODE: undefined, GBRAIN_SOURCE: undefined },
      async () => {
        const ctx = await makeContext(throwing, {});
        expect(ctx.config).toBeDefined();
        expect(isEvalCaptureEnabled(ctx.config)).toBe(false);
      },
    );
  });
});
