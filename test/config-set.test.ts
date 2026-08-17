/**
 * T8 — `gbrain config set` strict unknown-key rejection + --force + Levenshtein.
 *
 * These tests probe the pure helpers (KNOWN_CONFIG_KEYS list, prefix list,
 * Levenshtein suggestion against the list). The full `runConfig` CLI
 * integration that calls `engine.setConfig` is exercised E2E in T12.
 */

import { describe, test, expect, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { KNOWN_CONFIG_KEYS, KNOWN_CONFIG_KEY_PREFIXES, isConfigTruthy } from '../src/core/config.ts';
import { suggestNearest } from '../src/core/levenshtein.ts';
import { runConfig } from '../src/commands/config.ts';
import { checkSubagentCapability } from '../src/commands/doctor.ts';
import { withEnv } from './helpers/with-env.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('KNOWN_CONFIG_KEYS', () => {
  test('contains the canonical embedding keys', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('embedding_model');
    expect(KNOWN_CONFIG_KEYS).toContain('embedding_dimensions');
    expect(KNOWN_CONFIG_KEYS).toContain('embedding_disabled');  // v0.37 D9
    expect(KNOWN_CONFIG_KEYS).toContain('expansion_model');
    expect(KNOWN_CONFIG_KEYS).toContain('chat_model');
    expect(KNOWN_CONFIG_KEYS).toContain('openrouter_api_key');
    expect(KNOWN_CONFIG_KEYS).toContain('provider_chat_options');
  });

  test('contains the search-mode keys (v0.32.3)', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('search.mode');
    expect(KNOWN_CONFIG_KEYS).toContain('search.cache.enabled');
  });

  // Regression: `sources.default` is read by source-resolver.ts tier 5 on
  // every unqualified call and written by `gbrain sources default <id>`, yet
  // it was absent from this list — so `gbrain config set sources.default`
  // warned "Nothing in gbrain reads this", which is false and misdirects an
  // operator away from the one knob that pins brain-level source routing.
  test('contains sources.default (read by the resolver, written by `sources default`)', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('sources.default');
  });

  // The fix registers the ONE key the resolver reads, not a `sources.` prefix:
  // a prefix would bless arbitrary unread `sources.*` keys and weaken the
  // unknown-key guard this list exists to provide.
  test('does not bless arbitrary sources.* keys', () => {
    expect(KNOWN_CONFIG_KEYS).not.toContain('sources.anything-else');
    expect(KNOWN_CONFIG_KEY_PREFIXES).not.toContain('sources.');
  });

  test('contains the models-tier keys (v0.31.12)', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('models.default');
    expect(KNOWN_CONFIG_KEYS).toContain('models.tier.subagent');
  });

  test('allows the contextual synopsis model key', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('models.contextual_synopsis');
  });

  test('contains the dream synthesize timeout keys (#1594)', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('dream.synthesize.subagent_timeout_ms');
    expect(KNOWN_CONFIG_KEYS).toContain('dream.synthesize.subagent_wait_timeout_ms');
  });

  test('contains the spend-control keys (v0.42.42.0, #2139) — no --force archaeology', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('spend.posture');
    expect(KNOWN_CONFIG_KEYS).toContain('sync.cost_gate_min_usd');
    expect(KNOWN_CONFIG_KEYS).toContain('sync.federated_v2');
    expect(KNOWN_CONFIG_KEYS).toContain('embed.backfill_cooldown_min');
    expect(KNOWN_CONFIG_KEYS).toContain('embed.backfill_max_usd_per_source_24h');
    expect(KNOWN_CONFIG_KEYS).toContain('embed.backfill_max_usd');
  });

  test('includes the gateway-loop toggle and provider API keys the wave wires', () => {
    // The subagent handler's error message tells users to run
    // `gbrain config set agent.use_gateway_loop true`; it must be a known key
    // or `config set` rejects the wave's own enable command without --force.
    expect(KNOWN_CONFIG_KEYS).toContain('agent.use_gateway_loop');
    expect(KNOWN_CONFIG_KEYS).toContain('openrouter_api_key');
    expect(KNOWN_CONFIG_KEYS).toContain('zeroentropy_api_key');
  });

  test('registers the provider_sunset suppression key (v0.46.3 documented command)', () => {
    // doctor.ts + docs/guides/embedding-migration.md both document
    // `gbrain config set doctor.suppress_provider_sunset true`; the key must
    // be registered or the documented command exits 1 with "Unknown config
    // key". Exact key, deliberately not a 'doctor.' prefix.
    expect(KNOWN_CONFIG_KEYS).toContain('doctor.suppress_provider_sunset');
  });

  test('registers only the live conversation-parser fallback key', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('conversation_parser.llm_fallback_enabled');
    expect(KNOWN_CONFIG_KEY_PREFIXES).not.toContain('conversation_parser.');
    expect(KNOWN_CONFIG_KEYS).not.toContain('conversation_parser.llm_polish_enabled');
  });

  test('contains orphan-reporting override keys', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('orphans.exclude_prefixes');
    expect(KNOWN_CONFIG_KEYS).toContain('orphans.exclude_slugs');
  });

  test('no duplicate entries', () => {
    const set = new Set(KNOWN_CONFIG_KEYS);
    expect(set.size).toBe(KNOWN_CONFIG_KEYS.length);
  });
});

describe('KNOWN_CONFIG_KEY_PREFIXES', () => {
  test('includes the well-known prefixes', () => {
    expect(KNOWN_CONFIG_KEY_PREFIXES).toContain('search.');
    expect(KNOWN_CONFIG_KEY_PREFIXES).toContain('models.');
    expect(KNOWN_CONFIG_KEY_PREFIXES).toContain('dream.');
    expect(KNOWN_CONFIG_KEY_PREFIXES).toContain('provider_chat_options.');
  });

  test('prefixes end in `.` (consistent shape)', () => {
    for (const p of KNOWN_CONFIG_KEY_PREFIXES) {
      expect(p).toMatch(/\.$/);
    }
  });
});

describe('Levenshtein suggestion against KNOWN_CONFIG_KEYS', () => {
  test('bug-reporter case: embedding.model → embedding_model', () => {
    const got = suggestNearest('embedding.model', KNOWN_CONFIG_KEYS, 3);
    expect(got).toBe('embedding_model');
  });

  test('bug-reporter case: embedding.dimensions → embedding_dimensions', () => {
    const got = suggestNearest('embedding.dimensions', KNOWN_CONFIG_KEYS, 3);
    expect(got).toBe('embedding_dimensions');
  });

  test('bug-reporter case: embedding.provider has no perfect match', () => {
    // `embedding.provider` is 6+ edits from any canonical key. Either no
    // suggestion (returns null) OR suggests a close-ish key like
    // `embedding_model`. Either outcome means the user sees a clear
    // "unknown key" message + must pick a different name.
    const got = suggestNearest('embedding.provider', KNOWN_CONFIG_KEYS, 3);
    // The exact mapping depends on Levenshtein bucket; we just verify it
    // doesn't accidentally suggest something completely unrelated.
    if (got !== null) {
      expect(got).toMatch(/^embedding/);
    }
  });

  test('typo: chat_modle → chat_model', () => {
    const got = suggestNearest('chat_modle', KNOWN_CONFIG_KEYS, 3);
    expect(got).toBe('chat_model');
  });

  test('typo: search.modes → search.mode', () => {
    const got = suggestNearest('search.modes', KNOWN_CONFIG_KEYS, 3);
    expect(got).toBe('search.mode');
  });

  test('completely-unrelated key returns null', () => {
    const got = suggestNearest('xyzzy_quux_blah_unrelated', KNOWN_CONFIG_KEYS, 3);
    expect(got).toBeNull();
  });

  test('exact match returns identity (no suggestion noise)', () => {
    const got = suggestNearest('embedding_model', KNOWN_CONFIG_KEYS, 3);
    expect(got).toBe('embedding_model');
  });
});

describe('prefix vs known-key gate logic (mirrored from runConfig)', () => {
  // Replicate the gate logic the CLI uses to validate test coverage of
  // the decision tree.
  function gate(key: string): 'known' | 'prefix' | 'unknown' {
    if (KNOWN_CONFIG_KEYS.includes(key)) return 'known';
    if (KNOWN_CONFIG_KEY_PREFIXES.some(p => key.startsWith(p))) return 'prefix';
    return 'unknown';
  }

  test('explicit known key → "known"', () => {
    expect(gate('embedding_model')).toBe('known');
  });

  test('search.foo.bar (under prefix) → "prefix"', () => {
    expect(gate('search.foo.bar')).toBe('prefix');
  });

  test('models.custom.x (under prefix) → "prefix"', () => {
    expect(gate('models.custom.x')).toBe('prefix');
  });

  test('provider_chat_options.anthropic (under prefix) → "prefix"', () => {
    expect(gate('provider_chat_options.anthropic')).toBe('prefix');
  });

  test('bug-reporter: embedding.provider → "unknown" (no prefix match)', () => {
    expect(gate('embedding.provider')).toBe('unknown');
  });

  test('bug-reporter: embedding.model → "unknown"', () => {
    expect(gate('embedding.model')).toBe('unknown');
  });

  test('bug-reporter: embedding.dimensions → "unknown"', () => {
    expect(gate('embedding.dimensions')).toBe('unknown');
  });
});

describe('#2753 — the doctor-proposed gateway-loop command is accepted by `config set`', () => {
  // Pre-fix: `gbrain doctor --full` told users to run `gbrain config set
  // agent.use_gateway_loop true`, but the key wasn't in KNOWN_CONFIG_KEYS,
  // so the exact command doctor recommended failed with "Unknown config
  // key" (or silently no-opped under --force with a false "nothing reads
  // this" warning). This test drives `checkSubagentCapability` (the doctor
  // check that emits the recommendation) end to end, extracts the literal
  // command from its message, and feeds it into the real `runConfig` CLI
  // entry point — so a future edit that lets the two drift apart again
  // fails here instead of shipping.
  const home = mkdtempSync(join(tmpdir(), 'gbrain-config-set-'));
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(
    join(home, '.gbrain', 'config.json'),
    JSON.stringify({ engine: 'pglite', chat_model: 'openai:gpt-5' }),
  );

  function doctorStubEngine(): BrainEngine {
    // models.tier.subagent, models.default, agent.use_gateway_loop: all unset.
    return { getConfig: async () => null } as unknown as BrainEngine;
  }

  function setStubEngine(): { engine: BrainEngine; setCalls: Array<[string, string]> } {
    const setCalls: Array<[string, string]> = [];
    const engine = {
      getConfig: async () => null,
      setConfig: async (key: string, value: string) => { setCalls.push([key, value]); },
    } as unknown as BrainEngine;
    return { engine, setCalls };
  }

  /** Run `runConfig(engine, args)`, capturing console output + exit code
   *  the way `config-get-plane.test.ts` does for the `get` subcommand. */
  async function runConfigCapture(
    engine: BrainEngine,
    args: string[],
  ): Promise<{ logs: string[]; errs: string[]; exit: number | null }> {
    const logs: string[] = [];
    const errs: string[] = [];
    let exit: number | null = null;
    const logSpy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
    const errSpy = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errs.push(a.join(' ')); });
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exit = code ?? 0;
      throw new Error(`EXIT:${code}`);
    }) as never);
    try {
      await runConfig(engine, args);
    } catch (e) {
      if (!(e as Error).message.startsWith('EXIT:')) throw e;
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
    return { logs, errs, exit };
  }

  // `sources.default` is the one config key whose value the resolver
  // dereferences on every unqualified call (tier 5 → assertSourceExists).
  // Registering it in KNOWN_CONFIG_KEYS without a set-time check would make
  // `config set` a way around the validation `gbrain sources default <id>`
  // already performs, and a typo would surface later as a throw on unrelated
  // commands. These pin that `config set` refuses the same inputs.
  function sourcesEngine(registered: string[]): { engine: BrainEngine; setCalls: Array<[string, string]> } {
    const setCalls: Array<[string, string]> = [];
    const engine = {
      getConfig: async () => null,
      setConfig: async (k: string, v: string) => { setCalls.push([k, v]); },
      executeRaw: async (_sql: string, params?: unknown[]) => {
        const id = String((params ?? [])[0] ?? '');
        return registered.includes(id) ? [{ id, name: id }] : [];
      },
    } as unknown as BrainEngine;
    return { engine, setCalls };
  }

  test('sources.default: refuses an id that is not a valid source id', async () => {
    const { engine, setCalls } = sourcesEngine(['wiki']);
    const { errs, exit } = await runConfigCapture(engine, ['set', 'sources.default', 'Not A Source']);
    expect(exit).toBe(1);
    expect(errs.join('\n')).toContain('lowercase alphanumerics');
    expect(setCalls).toEqual([]);
  });

  test('sources.default: refuses an unregistered source instead of writing it', async () => {
    const { engine, setCalls } = sourcesEngine(['wiki']);
    const { errs, exit } = await runConfigCapture(engine, ['set', 'sources.default', 'ghost']);
    expect(exit).toBe(1);
    expect(errs.join('\n')).toContain('not registered');
    expect(setCalls).toEqual([]);
  });

  test('sources.default: accepts a registered source without --force', async () => {
    const { engine, setCalls } = sourcesEngine(['wiki']);
    const { errs, exit } = await runConfigCapture(engine, ['set', 'sources.default', 'wiki']);
    expect(exit).toBeNull();
    // The false "Nothing in gbrain reads this" line is the bug this fixes.
    expect(errs.join('\n')).not.toContain('Nothing in gbrain reads this');
    expect(setCalls).toEqual([['sources.default', 'wiki']]);
  });

  // A DB failure must not be laundered into "source is not registered" — that
  // would send an operator chasing a source-registration problem that doesn't
  // exist while the real fault (connection, permissions, SQL regression) is
  // swallowed.
  test('sources.default: a lookup failure propagates instead of reading as unregistered', async () => {
    const setCalls: Array<[string, string]> = [];
    const engine = {
      getConfig: async () => null,
      setConfig: async (k: string, v: string) => { setCalls.push([k, v]); },
      executeRaw: async () => { throw new Error('connection terminated unexpectedly'); },
    } as unknown as BrainEngine;
    // The real error must escape rather than be reshaped into a validation
    // message, so this rejects instead of returning an exit code.
    await expect(
      runConfigCapture(engine, ['set', 'sources.default', 'wiki']),
    ).rejects.toThrow('connection terminated unexpectedly');
    expect(setCalls).toEqual([]);
  });

  test('doctor-proposed command round-trips through `config set` without --force', async () => {
    const check = await withEnv(
      { GBRAIN_HOME: home, GBRAIN_CHAT_MODEL: undefined, ANTHROPIC_API_KEY: undefined },
      () => checkSubagentCapability(doctorStubEngine()),
    );
    expect(check.status).toBe('warn');
    expect(check.message).toContain('agent.use_gateway_loop');

    // Pull the exact backtick-quoted command out of the doctor message
    // instead of hardcoding it, so the two call sites can't silently drift.
    const match = check.message.match(/`(gbrain config set [^`]+)`/);
    expect(match).not.toBeNull();

    // Tokenize the WHOLE command and feed every argument through, rather than
    // destructuring the first two and dropping the rest. If doctor ever starts
    // recommending a trailing `--force`, that has to fail here — the entire
    // point of #2753 is that the recommended command works without it.
    const tokens = match![1].trim().split(/\s+/);
    expect(tokens.slice(0, 3)).toEqual(['gbrain', 'config', 'set']);
    expect(tokens).not.toContain('--force');
    const args = tokens.slice(1); // ['config','set',key,value,...]
    expect(args).toEqual(['config', 'set', 'agent.use_gateway_loop', 'true']);

    const { engine, setCalls } = setStubEngine();
    const { logs, errs, exit } = await runConfigCapture(engine, args.slice(1));
    expect(exit).toBeNull();
    expect(errs.join('\n')).not.toContain('Unknown config key');
    expect(errs.join('\n')).not.toContain('Nothing in gbrain reads this');
    expect(setCalls).toEqual([['agent.use_gateway_loop', 'true']]);
    expect(logs.join('\n')).toContain('Set agent.use_gateway_loop = true');
  });
});

describe('#2753 — doctor and the subagent worker share one truthiness set', () => {
  // The doctor accepted true/1/yes/on; the worker accepted only true/1. So
  // `gbrain config set agent.use_gateway_loop yes` produced a HEALTHY doctor
  // report and a runtime refusal of the exact job the setting enables. Both
  // now route through isConfigTruthy, so this asserts the shared contract.
  test('accepts the documented on-values, case- and whitespace-insensitively', () => {
    for (const v of ['true', '1', 'yes', 'on', 'TRUE', 'Yes', 'ON', ' true ', '\tyes\n']) {
      expect(isConfigTruthy(v)).toBe(true);
    }
  });

  test('fails closed on unset, non-string, and anything else', () => {
    for (const v of [null, undefined, '', '   ', 'false', '0', 'no', 'off', 'maybe', 1, true, {}]) {
      expect(isConfigTruthy(v)).toBe(false);
    }
  });
});
