/**
 * openai-latest — latest-model discovery: id grammar, priced-only ranking,
 * cache round-trip, TTL throttle, fail-open refresh. Serial: mutates
 * GBRAIN_HOME + process env + module memo state.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseOpenAIChatId,
  rankOpenAIChatModels,
  latestOpenAITiers,
  refreshLatestOpenAIModels,
  _resetOpenAILatestForTests,
} from '../src/core/ai/openai-latest.ts';
import { resolveTierDefault, openaiStaticTierFallback } from '../src/core/model-config.ts';

const PINNED = ['GBRAIN_HOME', 'GBRAIN_MODEL_DISCOVERY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const;
let saved: Record<string, string | undefined>;
let tmpHome: string;

beforeEach(() => {
  saved = {};
  for (const k of PINNED) { saved[k] = process.env[k]; delete process.env[k]; }
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-latest-'));
  process.env.GBRAIN_HOME = tmpHome;
  _resetOpenAILatestForTests();
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  for (const k of PINNED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function fetchReturning(ids: string[]): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })
  ) as unknown as typeof fetch;
}

describe('parseOpenAIChatId — conservative grammar', () => {
  test('bare family aliases and known tier suffixes parse', () => {
    expect(parseOpenAIChatId('gpt-5.6')).toEqual({ id: 'gpt-5.6', family: [5, 6], suffix: '' });
    expect(parseOpenAIChatId('gpt-5.6-sol')?.suffix).toBe('sol');
    expect(parseOpenAIChatId('gpt-5.6-terra')?.suffix).toBe('terra');
    expect(parseOpenAIChatId('gpt-5.6-luna')?.suffix).toBe('luna');
    expect(parseOpenAIChatId('gpt-4o-mini')).toBeNull(); // 4o is not \d.\d grammar
    expect(parseOpenAIChatId('gpt-5-mini')?.suffix).toBe('mini');
  });

  test('non-chat, snapshot, and unknown-suffix ids are ignored (fail-safe rot)', () => {
    for (const id of [
      'gpt-5.6-cyber',            // unknown future suffix → ignored, never mis-tiered
      'gpt-5.5-2026-04-24',       // dated snapshot
      'gpt-5-chat-latest',        // ChatGPT-Instant class (weak strict-JSON)
      'chat-latest',
      'gpt-realtime-2.1',
      'gpt-image-2',
      'text-embedding-3-large',
      'o4-mini',
    ]) {
      expect(parseOpenAIChatId(id)).toBeNull();
    }
  });
});

describe('rankOpenAIChatModels — newest PRICED family, tier ladder', () => {
  const allPriced = () => true;

  test('named tiers map to the ladder (5.6 family shape)', () => {
    const { tiers } = rankOpenAIChatModels(
      ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6', 'gpt-5.5', 'gpt-4o'],
      allPriced,
    );
    expect(tiers).toEqual({
      utility: 'openai:gpt-5.6-luna',
      reasoning: 'openai:gpt-5.6-terra',
      deep: 'openai:gpt-5.6-sol',
      subagent: 'openai:gpt-5.6-terra',
    });
  });

  test('bare-alias-only family serves every tier (5.2-era shape)', () => {
    const { tiers } = rankOpenAIChatModels(['gpt-5.2', 'gpt-5-mini'], allPriced);
    expect(tiers).toEqual({
      utility: 'openai:gpt-5.2',   // no cheap tier in the newest family → mid
      reasoning: 'openai:gpt-5.2',
      deep: 'openai:gpt-5.2',
      subagent: 'openai:gpt-5.2',
    });
  });

  test('unpriced newer family is skipped (budget caps must not fail closed) and reported', () => {
    const priced = (id: string) => !id.startsWith('gpt-5.7');
    const { tiers, newestUnpriced } = rankOpenAIChatModels(
      ['gpt-5.7', 'gpt-5.7-luna', 'gpt-5.6', 'gpt-5.6-luna'],
      priced,
    );
    expect(tiers?.deep).toBe('openai:gpt-5.6');
    expect(tiers?.utility).toBe('openai:gpt-5.6-luna');
    expect(newestUnpriced).toBe('gpt-5.7');
  });

  test('partial family (no top tier, no bare alias) still serves every tier', () => {
    // An account entitled to only terra/luna of the newest family must get
    // usable tiers, not tiers:null + a static fallback it may not serve.
    const { tiers } = rankOpenAIChatModels(['gpt-5.6-terra', 'gpt-5.6-luna'], allPriced);
    expect(tiers).toEqual({
      utility: 'openai:gpt-5.6-luna',
      reasoning: 'openai:gpt-5.6-terra',
      deep: 'openai:gpt-5.6-terra',
      subagent: 'openai:gpt-5.6-terra',
    });
    // Cheap-only family: everything degrades to the one available model.
    const only = rankOpenAIChatModels(['gpt-5.6-luna'], allPriced).tiers;
    expect(only?.deep).toBe('openai:gpt-5.6-luna');
  });

  test('OLDER unpriced families are not reported (no obsolete-model pricing nags)', () => {
    // Accounts still list legacy unpriced ids; warning about them would tell
    // a release engineer to price a model nobody should adopt.
    const priced = (id: string) => id.startsWith('gpt-5.6');
    const { tiers, newestUnpriced } = rankOpenAIChatModels(
      ['gpt-5', 'gpt-5.1', 'gpt-5.6', 'gpt-5.6-luna'],
      priced,
    );
    expect(tiers?.deep).toBe('openai:gpt-5.6');
    expect(newestUnpriced).toBeUndefined();
  });

  test('nothing usable → null tiers', () => {
    expect(rankOpenAIChatModels(['gpt-realtime-2.1', 'davinci'], allPriced).tiers).toBeNull();
    expect(rankOpenAIChatModels([], allPriced).tiers).toBeNull();
  });

  test('default priced-filter uses the canonical pricing table', () => {
    // gpt-5.6 has a pricing row (load-bearing for discovery); a made-up
    // family does not and must lose eligibility.
    const { tiers } = rankOpenAIChatModels(['gpt-9.9', 'gpt-5.6']);
    expect(tiers?.deep).toBe('openai:gpt-5.6');
  });
});

describe('refresh + cache + resolution overlay', () => {
  test('discovered tiers overlay the static fallback in resolveTierDefault', async () => {
    await refreshLatestOpenAIModels({
      env: { OPENAI_API_KEY: 'sk-test' },
      fetchImpl: fetchReturning(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']),
      force: true,
    });
    expect(latestOpenAITiers('reasoning')).toBe('openai:gpt-5.6-terra');
    expect(resolveTierDefault('reasoning', { OPENAI_API_KEY: 'sk-test' })).toBe('openai:gpt-5.6-terra');
    expect(resolveTierDefault('deep', { OPENAI_API_KEY: 'sk-test' })).toBe('openai:gpt-5.6-sol');
    // Anthropic-first is untouched by the overlay.
    expect(resolveTierDefault('reasoning', { ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-test' }))
      .toBe('anthropic:claude-sonnet-4-6');
  });

  test('no cache → static recipe-ranked fallback', () => {
    expect(latestOpenAITiers('reasoning')).toBeNull();
    expect(resolveTierDefault('reasoning', { OPENAI_API_KEY: 'sk-test' }))
      .toBe(openaiStaticTierFallback().reasoning);
  });

  test('TTL throttle: a fresh cache suppresses refetch; force bypasses', async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5.6' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await refreshLatestOpenAIModels({ env: { OPENAI_API_KEY: 'k' }, fetchImpl: counting, force: true });
    expect(calls).toBe(1);
    await refreshLatestOpenAIModels({ env: { OPENAI_API_KEY: 'k' }, fetchImpl: counting });
    expect(calls).toBe(1); // fresh cache → throttled
    await refreshLatestOpenAIModels({ env: { OPENAI_API_KEY: 'k' }, fetchImpl: counting, force: true });
    expect(calls).toBe(2);
  });

  test('fail-open: keyless, disabled, HTTP error, and throwing fetch never write or throw', async () => {
    const boom = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await refreshLatestOpenAIModels({ env: {}, fetchImpl: boom, force: true }); // keyless → no-op
    process.env.GBRAIN_MODEL_DISCOVERY = 'off';
    await refreshLatestOpenAIModels({ env: { OPENAI_API_KEY: 'k' }, fetchImpl: boom, force: true });
    delete process.env.GBRAIN_MODEL_DISCOVERY;
    await refreshLatestOpenAIModels({ env: { OPENAI_API_KEY: 'k' }, fetchImpl: boom, force: true }); // throws inside → absorbed
    const err401 = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    await refreshLatestOpenAIModels({ env: { OPENAI_API_KEY: 'k' }, fetchImpl: err401, force: true });
    // Failures persist ONLY the attempt stamp (durable backoff) — never
    // tiers. The overlay must still see nothing.
    expect(latestOpenAITiers()).toBeNull();
    const raw = JSON.parse(readFileSync(join(tmpHome, '.gbrain', 'model-cache.json'), 'utf8'));
    expect(raw.openai).toBeUndefined();
    expect(typeof raw.last_attempt_at).toBe('string');
  });

  test('unpriced-newer warning fires once and cache still lands on the priced family', async () => {
    let stderrCapture = '';
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrCapture += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      await refreshLatestOpenAIModels({
        env: { OPENAI_API_KEY: 'k' },
        fetchImpl: fetchReturning(['gpt-9.9', 'gpt-5.6', 'gpt-5.6-luna']),
        force: true,
      });
      expect(stderrCapture).toContain('gpt-9.9');
      expect(stderrCapture).toContain('model-pricing');
      expect(latestOpenAITiers('deep')).toBe('openai:gpt-5.6');
      const before = stderrCapture.length;
      await refreshLatestOpenAIModels({
        env: { OPENAI_API_KEY: 'k' },
        fetchImpl: fetchReturning(['gpt-9.9', 'gpt-5.6']),
        force: true,
      });
      expect(stderrCapture.length).toBe(before); // warned once per id per process
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

describe('review-army additions', () => {
  test('numeric family compare: gpt-10 beats gpt-9.9 (no lexicographic rot)', () => {
    const { tiers } = rankOpenAIChatModels(['gpt-9.9', 'gpt-10'], () => true);
    expect(tiers?.deep).toBe('openai:gpt-10');
    const minors = rankOpenAIChatModels(['gpt-5.9', 'gpt-5.10'], () => true);
    expect(minors.tiers?.deep).toBe('openai:gpt-5.10');
  });

  test('gpt alias tracks the discovered flagship; recipe-ranked floor otherwise', async () => {
    const { resolveAlias } = await import('../src/core/model-config.ts');
    // No cache in this hermetic tmp home → static floor.
    expect(await resolveAlias(null, 'gpt')).toBe(openaiStaticTierFallback().deep);
    await refreshLatestOpenAIModels({
      env: { OPENAI_API_KEY: 'k' },
      fetchImpl: fetchReturning(['gpt-5.6-sol', 'gpt-5.6', 'gpt-5.6-luna']),
      force: true,
    });
    expect(await resolveAlias(null, 'gpt')).toBe('openai:gpt-5.6-sol');
  });
});

describe('coverage-gap additions (ship review)', () => {
  test('failure backoff: a failed non-force refresh suppresses refetch within the window', async () => {
    let calls = 0;
    const failing = (async () => { calls++; throw new Error('offline'); }) as unknown as typeof fetch;
    await refreshLatestOpenAIModels({ env: { OPENAI_API_KEY: 'k' }, fetchImpl: failing });
    expect(calls).toBe(1);
    await refreshLatestOpenAIModels({ env: { OPENAI_API_KEY: 'k' }, fetchImpl: failing });
    expect(calls).toBe(1); // within FAILURE_BACKOFF_MS → no second attempt
    await refreshLatestOpenAIModels({ env: { OPENAI_API_KEY: 'k' }, fetchImpl: failing, force: true });
    expect(calls).toBe(2); // force bypasses the backoff
  });

  test('identity switch (key/endpoint) bypasses TTL and replaces the cache', async () => {
    await refreshLatestOpenAIModels({
      env: { OPENAI_API_KEY: 'sk-account-a' },
      fetchImpl: fetchReturning(['gpt-5.6', 'gpt-5.6-luna']),
    });
    expect(latestOpenAITiers('deep')).toBe('openai:gpt-5.6');
    // Same identity, fresh cache → TTL suppresses (no force).
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ id: 'gpt-5.5' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await refreshLatestOpenAIModels({ env: { OPENAI_API_KEY: 'sk-account-a' }, fetchImpl: counting });
    expect(calls).toBe(0);
    // DIFFERENT key → the cached tiers belong to another account; the TTL
    // must not serve them. Refresh fires and overwrites.
    await refreshLatestOpenAIModels({ env: { OPENAI_API_KEY: 'sk-account-b' }, fetchImpl: counting });
    expect(calls).toBe(1);
    expect(latestOpenAITiers('deep')).toBe('openai:gpt-5.5');
  });

  test('identity switch + failed refresh drops the other account\'s tiers (static floor)', async () => {
    await refreshLatestOpenAIModels({
      env: { OPENAI_API_KEY: 'sk-account-a' },
      fetchImpl: fetchReturning(['gpt-5.6']),
    });
    expect(latestOpenAITiers('deep')).toBe('openai:gpt-5.6');
    const failing = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await refreshLatestOpenAIModels({ env: { OPENAI_API_KEY: 'sk-account-b' }, fetchImpl: failing });
    // Account A's tiers must not serve account B — honest state is the
    // static floor until B's own discovery succeeds.
    expect(latestOpenAITiers()).toBeNull();
  });

  test('atomic replacement with the same mtime invalidates the memo by inode', async () => {
    await refreshLatestOpenAIModels({
      env: { OPENAI_API_KEY: 'sk-account-a' },
      fetchImpl: fetchReturning(['gpt-5.6']),
      force: true,
    });
    const path = join(tmpHome, '.gbrain', 'model-cache.json');
    // Pin BOTH files to an integer-second timestamp before priming the memo.
    // Reusing `before.mtime` through utimesSync is not portable: Linux can
    // round the source stat's fractional nanoseconds differently from macOS.
    const fixedSeconds = 1_700_000_000;
    utimesSync(path, fixedSeconds, fixedSeconds);
    expect(latestOpenAITiers('deep')).toBe('openai:gpt-5.6'); // prime fixed-mtime memo
    const before = statSync(path);
    const replacement = `${path}.external-replacement`;
    const current = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(replacement, JSON.stringify({
      ...current,
      openai: {
        ...current.openai,
        tiers: {
          utility: 'openai:gpt-5.5',
          reasoning: 'openai:gpt-5.5',
          deep: 'openai:gpt-5.5',
          subagent: 'openai:gpt-5.5',
        },
      },
    }, null, 2));
    utimesSync(replacement, fixedSeconds, fixedSeconds);
    renameSync(replacement, path);

    const after = statSync(path);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).not.toBe(before.ino);
    expect(latestOpenAITiers('deep')).toBe('openai:gpt-5.5');
  });

  test('failure backoff survives a process boundary (persisted attempt stamp)', async () => {
    let calls = 0;
    const failing = (async () => { calls++; throw new Error('offline'); }) as unknown as typeof fetch;
    await refreshLatestOpenAIModels({ env: { OPENAI_API_KEY: 'k' }, fetchImpl: failing });
    expect(calls).toBe(1);
    // Simulate a fresh process: module state cleared, cache file intact
    // (the reset touches only module state, never the file). Short-lived CLI
    // invocations on a blackholed network must not each re-pay the fetch
    // timeout — the stamp in model-cache.json carries the backoff across
    // processes.
    _resetOpenAILatestForTests();
    await refreshLatestOpenAIModels({ env: { OPENAI_API_KEY: 'k' }, fetchImpl: failing });
    expect(calls).toBe(1);
  });

  test('empty/malformed bodies never write the cache', async () => {
    await refreshLatestOpenAIModels({ env: { OPENAI_API_KEY: 'k' }, fetchImpl: fetchReturning([]), force: true });
    expect(latestOpenAITiers()).toBeNull();
    const noData = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    await refreshLatestOpenAIModels({ env: { OPENAI_API_KEY: 'k' }, fetchImpl: noData, force: true });
    expect(latestOpenAITiers()).toBeNull();
  });
});
