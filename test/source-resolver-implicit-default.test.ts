/**
 * #4700 review fix — resolveImplicitDefaultSourceId must be fail-open on a
 * stale `sources.default` (the configured source was deleted or archived
 * after the config row was set).
 *
 * Tier-5 posture (same as resolveLinkFallbackDefault): an invalid/stale
 * config value is treated as ABSENT — warn once on stderr, fall through to
 * the legacy sole-non-default routing — never a crash. Bare `gbrain dream`
 * (and any future bare-command caller) keeps working on a brain whose
 * default source went away.
 *
 * Hermetic: stub engines answer the three queries the resolution runs
 * (assertSourceExists probe, sole-non-default listing, default-emptiness
 * guard).
 */

import { describe, test, expect, beforeEach, spyOn } from 'bun:test';
import { resolveImplicitDefaultSourceId, __testing } from '../src/core/source-resolver.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function makeStub(opts: {
  defaultKey: string | null;
  activeSources: string[];
  soleNonDefault?: string | null;
  defaultHasPages?: boolean;
}): BrainEngine {
  return {
    kind: 'pglite',
    executeRaw: async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (sql.includes('SELECT id FROM sources WHERE id = $1')) {
        const target = params?.[0] as string;
        return opts.activeSources.includes(target) ? ([{ id: target }] as unknown as T[]) : [];
      }
      if (sql.includes("local_path IS NOT NULL AND id != 'default'")) {
        return opts.soleNonDefault ? ([{ id: opts.soleNonDefault }] as unknown as T[]) : [];
      }
      if (sql.includes("FROM pages WHERE source_id = 'default'")) {
        return opts.defaultHasPages ? ([{ one: 1 }] as unknown as T[]) : [];
      }
      return [];
    },
    getConfig: async (key: string) => (key === 'sources.default' ? opts.defaultKey : null),
  } as unknown as BrainEngine;
}

beforeEach(() => {
  __testing.resetStaleImplicitDefaultWarnings();
});

describe('resolveImplicitDefaultSourceId — stale sources.default is fail-open (#4700 review fix)', () => {
  test('a valid sources.default still resolves', async () => {
    const engine = makeStub({ defaultKey: 'primary', activeSources: ['primary'] });
    expect(await resolveImplicitDefaultSourceId(engine)).toBe('primary');
  });

  test('a stale sources.default falls back to the sole non-default source instead of throwing', async () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const engine = makeStub({
        defaultKey: 'ghost-a',
        activeSources: ['solo'],
        soleNonDefault: 'solo',
      });
      expect(await resolveImplicitDefaultSourceId(engine)).toBe('solo');
    } finally {
      errSpy.mockRestore();
    }
  });

  test('a stale sources.default with no fallback source resolves to null instead of throwing', async () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const engine = makeStub({ defaultKey: 'ghost-b', activeSources: [] });
      expect(await resolveImplicitDefaultSourceId(engine)).toBeNull();
    } finally {
      errSpy.mockRestore();
    }
  });

  test('warns once per process per stale id on stderr, naming the stale value', async () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const engine = makeStub({
        defaultKey: 'ghost-c',
        activeSources: ['solo'],
        soleNonDefault: 'solo',
      });
      await resolveImplicitDefaultSourceId(engine);
      await resolveImplicitDefaultSourceId(engine);
      const warns = errSpy.mock.calls.flat().filter(
        (line) => typeof line === 'string' && line.includes('ghost-c'),
      );
      expect(warns.length).toBe(1);
      expect(warns[0]).toMatch(/sources\.default/);
    } finally {
      errSpy.mockRestore();
    }
  });

  test('a genuine engine failure still propagates (fail-open covers stale config only)', async () => {
    const engine = {
      kind: 'pglite',
      executeRaw: async () => { throw new TypeError('connection torn down'); },
      getConfig: async (key: string) => (key === 'sources.default' ? 'primary' : null),
    } as unknown as BrainEngine;
    await expect(resolveImplicitDefaultSourceId(engine)).rejects.toThrow('connection torn down');
  });

  // Ship-review gaps (#4745): the two remaining arms of the fail-open chain.
  test('a FORMAT-invalid sources.default falls through to the sole non-default source without throwing', async () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const engine = makeStub({
        defaultKey: 'not a valid id!',
        activeSources: ['solo'],
        soleNonDefault: 'solo',
      });
      // isValidSourceId rejects the value before any DB probe — no throw from
      // the resolver-error path (which a bare `gbrain dream` would surface as
      // exit 1), and the legacy sole-non-default routing takes over.
      await expect(resolveImplicitDefaultSourceId(engine)).resolves.toBe('solo');
      // Pinned current posture: the malformed value is skipped SILENTLY (it is
      // not a stale-but-well-formed id, so the stale-config warning naming it
      // does not fire) — it never reaches the assertSourceExists probe.
      const printed = errSpy.mock.calls.flat().filter((l) => typeof l === 'string').join('\n');
      expect(printed).not.toContain('not a valid id!');
    } finally {
      errSpy.mockRestore();
    }
  });

  test('the quiet lane: a stale sources.default warns, but the sole-non-default emptiness-guard flip nudge stays silent', async () => {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Stale default + one sole side-source + a NON-EMPTY 'default': the
      // #3070 emptiness guard refuses the flip (→ null). In the loud lanes
      // that prints a "routing to 'default'" nudge; resolveImplicitDefaultSourceId
      // runs pickSoleNonDefaultSource with quiet:true, so only the stale-config
      // warning may fire here.
      const engine = makeStub({
        defaultKey: 'ghost-quiet',
        activeSources: ['solo'],
        soleNonDefault: 'solo',
        defaultHasPages: true,
      });
      expect(await resolveImplicitDefaultSourceId(engine)).toBeNull();
      const lines = errSpy.mock.calls.flat().filter((l): l is string => typeof l === 'string');
      expect(lines.some((l) => l.includes('ghost-quiet') && l.includes('sources.default'))).toBe(true);
      expect(lines.some((l) => l.includes('emptiness guard') || l.includes("routing to 'default'"))).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});
