/**
 * WP3 (T6) — strict/warn param validation + unknown_tool did-you-mean.
 *
 * Covers, per the plan's verify list:
 *   1. normalize→validate call order: null/'' optional-absence idioms are
 *      normalized away BEFORE unknown-key detection (never reported unknown);
 *   2. warn mode: unknown keys accepted, `_meta.warnings` collected with the
 *      amendment-13 shape, model-visible warn block appended;
 *   3. reject mode: invalid_params envelope, did-you-mean in `suggestion`,
 *      raw unknown key NEVER in `message` (the one field persisted to
 *      mcp_request_log.error_message);
 *   4. enum membership rejects in BOTH modes (type error, not unknown key);
 *   5. `_meta` / `dry_run` allowlist;
 *   6. unknown_tool leak pins: gated + localOnly names never suggested;
 *      hidden-vs-nonexistent envelopes identical (same builder, same
 *      candidate set).
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import {
  normalizeOptionalParams,
  validateParams,
  findUnknownParams,
  buildUnknownParamWarnBlock,
  resolveStrictParamsMode,
  resetStrictParamsModeCache,
  parseStrictParamsMode,
  UNKNOWN_PARAM_ALLOWLIST,
} from '../src/mcp/validate-params.ts';
import { operations, operationsByName } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

/**
 * Minimal engine stub. `mcp.strict_params` resolves from the DB plane first,
 * so pinning the stub's getConfig makes each test deterministic regardless of
 * the runner's file config. resolveSlugs/getStats back the two trivial op
 * handlers the dispatch-level tests exercise.
 */
function stubEngine(strictMode: 'warn' | 'reject' | null): BrainEngine {
  return {
    kind: 'pglite',
    getConfig: async (k: string) => (k === 'mcp.strict_params' ? strictMode : null),
    resolveSlugs: async () => [],
    getStats: async () => ({ pages: 0 }),
    getTimeline: async () => [],
  } as unknown as BrainEngine;
}

const DISPATCH_OPTS = { remote: true, transport: 'http' as const, sourceId: 'default' };

function body(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// 1. normalize → validate → unknown-detection order
// ---------------------------------------------------------------------------

describe('normalize→validate order (absence idioms are not unknown keys)', () => {
  test('null / empty-string optional idioms are normalized away before unknown detection', () => {
    const recall = operationsByName['recall'];
    const normalized = normalizeOptionalParams(recall, { since: '', entity: null, query: 'x' });
    expect('since' in normalized).toBe(false);
    expect('entity' in normalized).toBe(false);
    expect(normalized.query).toBe('x');
    // The normalized object carries no unknown keys — the idioms were
    // DECLARED optionals, not stray keys.
    expect(findUnknownParams(recall, normalized)).toEqual([]);
    expect(validateParams(recall, normalized)).toBeNull();
  });

  test('dispatch accepts null/"" optional idioms without warnings (order pin)', async () => {
    const out = await dispatchToolCall(stubEngine('warn'), 'get_timeline', {
      slug: 'people/alice-example',
      since: null,
      until: '',
    }, DISPATCH_OPTS);
    expect(out.isError ?? false).toBe(false);
    expect(out._meta?.warnings).toBeUndefined();
    expect(out.content.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. warn mode
// ---------------------------------------------------------------------------

describe('warn mode (default) — accept + _meta.warnings + model-visible block', () => {
  test('unknown key collected with amendment-13 shape and nearest-declared suggestion', async () => {
    const out = await dispatchToolCall(stubEngine('warn'), 'resolve_slugs', {
      partial: 'alice-ex',
      partal: 'typo-key',
    }, DISPATCH_OPTS);
    expect(out.isError ?? false).toBe(false);
    expect(out._meta?.warnings).toEqual([
      { code: 'unknown_param', param: 'partal', suggestion: 'partial' },
    ]);
    // D8 second-block mechanism carries the grace-period notice.
    expect(out.content.length).toBe(2);
    expect(out.content[1].text).toBe(
      'warning: unknown parameter "partal" ignored — did you mean "partial"? A future release rejects unknown parameters.',
    );
  });

  test('unresolved (absent) config defaults to warn', async () => {
    const out = await dispatchToolCall(stubEngine(null), 'resolve_slugs', {
      partial: 'a',
      totally_unrelated_key: 1,
    }, DISPATCH_OPTS);
    expect(out.isError ?? false).toBe(false);
    const warnings = out._meta?.warnings as Array<{ param: string; suggestion?: string }>;
    expect(warnings.length).toBe(1);
    expect(warnings[0].param).toBe('totally_unrelated_key');
    // Nothing within edit distance → no suggestion key at all.
    expect('suggestion' in warnings[0]).toBe(false);
    expect(out.content[1].text).toBe(
      'warning: unknown parameter "totally_unrelated_key" ignored. A future release rejects unknown parameters.',
    );
  });

  test('suggestion candidates are the op\'s DECLARED params only', () => {
    // 'quer' is nearest to resolve_slugs' declared 'partial'? No — nothing
    // within distance; but against the search op it suggests 'query'. The
    // candidate pool is per-op, never the global param namespace.
    const search = operationsByName['search'];
    const found = findUnknownParams(search, { query: 'x', quer: 'y' });
    expect(found).toEqual([{ code: 'unknown_param', param: 'quer', suggestion: 'query' }]);
    const resolveSlugs = operationsByName['resolve_slugs'];
    const foreign = findUnknownParams(resolveSlugs, { partial: 'x', quer: 'y' });
    expect(foreign.length).toBe(1);
    expect(foreign[0].suggestion).not.toBe('query');
  });

  test('buildUnknownParamWarnBlock joins one line per unknown key', () => {
    const block = buildUnknownParamWarnBlock([
      { code: 'unknown_param', param: 'a', suggestion: 'b' },
      { code: 'unknown_param', param: 'c' },
    ]);
    const lines = block.split('\n');
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('"a"');
    expect(lines[0]).toContain('did you mean "b"');
    expect(lines[1]).toContain('"c"');
    expect(lines[1]).not.toContain('did you mean');
  });
});

// ---------------------------------------------------------------------------
// 3. reject mode
// ---------------------------------------------------------------------------

describe('reject mode — invalid_params envelope, raw key only in suggestion', () => {
  test('unknown key → invalid_params with did-you-mean in suggestion', async () => {
    const out = await dispatchToolCall(stubEngine('reject'), 'resolve_slugs', {
      partial: 'alice-ex',
      partal: 'typo-key',
    }, DISPATCH_OPTS);
    expect(out.isError).toBe(true);
    const envelope = body(out);
    expect(envelope.error).toBe('invalid_params');
    expect(envelope.suggestion).toContain('"partal"');
    expect(envelope.suggestion).toContain('did you mean "partial"');
    // Privacy (amendment 11): serve-http persists `message` to
    // mcp_request_log.error_message — the raw unknown key must not be there.
    expect(envelope.message).not.toContain('partal');
    expect(envelope.message).toContain('unknown parameter');
  });

  test('declared params + allowlisted keys still dispatch under reject', async () => {
    const out = await dispatchToolCall(stubEngine('reject'), 'resolve_slugs', {
      partial: 'alice-ex',
      _meta: { session_id: 'topic-1' },
      dry_run: false,
    }, DISPATCH_OPTS);
    expect(out.isError ?? false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. enum membership — both modes
// ---------------------------------------------------------------------------

describe('enum membership rejects in BOTH strict modes', () => {
  for (const mode of ['warn', 'reject'] as const) {
    test(`list_pages sort=bogus → invalid_params naming the allowed values (${mode} mode)`, async () => {
      const out = await dispatchToolCall(stubEngine(mode), 'list_pages', {
        sort: 'bogus_order',
      }, DISPATCH_OPTS);
      expect(out.isError).toBe(true);
      const envelope = body(out);
      expect(envelope.error).toBe('invalid_params');
      expect(envelope.message).toBe(
        'Parameter "sort" must be one of: updated_desc, updated_asc, created_desc, slug',
      );
    });
  }

  test('validateParams: valid enum value passes, non-member fails', () => {
    const listPages = operationsByName['list_pages'];
    expect(validateParams(listPages, { sort: 'slug' })).toBeNull();
    expect(validateParams(listPages, { sort: 'name' })).toContain('must be one of');
  });
});

// ---------------------------------------------------------------------------
// 5. `_meta` / `dry_run` allowlist
// ---------------------------------------------------------------------------

describe('_meta / dry_run allowlist', () => {
  test('the allowlist is exactly the two dispatch passthrough keys', () => {
    expect([...UNKNOWN_PARAM_ALLOWLIST].sort()).toEqual(['_meta', 'dry_run']);
  });

  test('allowlisted keys are never flagged (op with an empty param schema)', async () => {
    const out = await dispatchToolCall(stubEngine('warn'), 'get_stats', {
      _meta: { session_id: 'topic-1' },
      dry_run: false,
    }, DISPATCH_OPTS);
    expect(out.isError ?? false).toBe(false);
    expect(out._meta?.warnings).toBeUndefined();
    expect(out.content.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. unknown_tool did-you-mean — leak pins
// ---------------------------------------------------------------------------

const EXCLUDED_FROM_SUGGESTIONS = new Set(
  operations
    .filter(op => op.localOnly || op.publishGateKey)
    .map(op => op.name),
);

function suggestedName(envelope: { suggestion?: string }): string | null {
  const m = envelope.suggestion?.match(/^Did you mean "(.+)"\?$/);
  return m ? m[1] : null;
}

describe('unknown_tool did-you-mean (leak-hardened)', () => {
  test('a near-miss of a visible op gets a suggestion', async () => {
    const out = await dispatchToolCall(stubEngine(null), 'get_pag', {}, DISPATCH_OPTS);
    expect(out.isError).toBe(true);
    const envelope = body(out);
    expect(envelope.error).toBe('unknown_tool');
    expect(envelope.suggestion).toBe('Did you mean "get_page"?');
  });

  test('gated + localOnly names are NEVER suggested (near-miss sweep)', async () => {
    for (const hidden of EXCLUDED_FROM_SUGGESTIONS) {
      // Probe with the hidden name minus its last character — within edit
      // distance 1 of the hidden op, so it WOULD be the best suggestion if
      // the candidate set failed to exclude it.
      const probe = hidden.slice(0, -1);
      const out = await dispatchToolCall(stubEngine(null), probe, {}, DISPATCH_OPTS);
      expect(out.isError).toBe(true);
      const envelope = body(out);
      expect(envelope.error).toBe('unknown_tool');
      const suggested = suggestedName(envelope);
      if (suggested !== null) {
        expect(EXCLUDED_FROM_SUGGESTIONS.has(suggested)).toBe(false);
      }
    }
  });

  test('hidden-op path (allowedOps miss) and nonexistent path emit byte-identical envelopes', async () => {
    // Same input name through BOTH code paths: 'get_pag' does not exist
    // (nonexistent path when allowedOps admits it / is unset) and is not in
    // the allow set (hidden path when allowedOps is set). The builder and
    // candidate set are shared, so the envelopes must match byte-for-byte
    // when the candidate pools coincide.
    const viaNonexistent = await dispatchToolCall(stubEngine(null), 'get_pag', {}, DISPATCH_OPTS);
    const viaHidden = await dispatchToolCall(stubEngine(null), 'get_pag', {}, {
      ...DISPATCH_OPTS,
      allowedOps: new Set(operations.filter(op => !op.localOnly).map(o => o.name)),
    });
    expect(viaHidden.content[0].text).toBe(viaNonexistent.content[0].text);
    expect(viaHidden.isError).toBe(true);
  });

  test('a REAL hidden op is indistinguishable from a nonexistent one (same shape, no oracle)', async () => {
    const allowed: ReadonlySet<string> = new Set(['recall', 'remember', 'entity']);
    const hiddenReal = await dispatchToolCall(stubEngine(null), 'get_page', { slug: 'x' }, {
      ...DISPATCH_OPTS, allowedOps: allowed,
    });
    const nonexistent = await dispatchToolCall(stubEngine(null), 'zz_no_such_op', {}, {
      ...DISPATCH_OPTS, allowedOps: allowed,
    });
    expect(hiddenReal.isError).toBe(true);
    expect(nonexistent.isError).toBe(true);
    const a = body(hiddenReal);
    const b = body(nonexistent);
    // Identical key sets — no extra field betrays that get_page exists.
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(a.error).toBe('unknown_tool');
    expect(b.error).toBe('unknown_tool');
  });

  test('localOnly op over HTTP uses the same builder (suggestion never names it)', async () => {
    const out = await dispatchToolCall(stubEngine(null), 'file_list', {}, DISPATCH_OPTS);
    expect(out.isError).toBe(true);
    const envelope = body(out);
    expect(envelope.error).toBe('unknown_tool');
    const suggested = suggestedName(envelope);
    if (suggested !== null) {
      expect(EXCLUDED_FROM_SUGGESTIONS.has(suggested)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveStrictParamsMode — dual-plane resolution
// ---------------------------------------------------------------------------

describe('resolveStrictParamsMode (DB > file > warn)', () => {
  const engineWith = (v: unknown) =>
    ({ getConfig: async () => v } as unknown as BrainEngine);
  const throwingEngine = {
    getConfig: async () => { throw new Error('no config table'); },
  } as unknown as BrainEngine;

  // The resolver holds the last successfully read DB mode per process
  // (adversarial fix: a transient outage must not re-open warn mode) —
  // isolate each case from its neighbors.
  beforeEach(() => resetStrictParamsModeCache());

  test('a failed DB read holds the last-known-good DB mode (reject survives an outage)', async () => {
    expect(await resolveStrictParamsMode(engineWith('reject'), null)).toBe('reject');
    // DB now unreadable + file plane says warn → cached reject still wins.
    expect(await resolveStrictParamsMode(throwingEngine, { engine: 'pglite', mcp: { strict_params: 'warn' } } as never)).toBe('reject');
    // A later successful read of "unset" clears the cache → file plane decides.
    expect(await resolveStrictParamsMode(engineWith(null), { engine: 'pglite', mcp: { strict_params: 'warn' } } as never)).toBe('warn');
    expect(await resolveStrictParamsMode(throwingEngine, null)).toBe('warn');
  });

  test('DB plane wins over the file plane', async () => {
    expect(await resolveStrictParamsMode(engineWith('reject'), { engine: 'pglite', mcp: { strict_params: 'warn' } } as never)).toBe('reject');
  });

  test('file plane decides when DB is unset or unreadable', async () => {
    expect(await resolveStrictParamsMode(engineWith(null), { engine: 'pglite', mcp: { strict_params: 'reject' } } as never)).toBe('reject');
    expect(await resolveStrictParamsMode(throwingEngine, { engine: 'pglite', mcp: { strict_params: 'reject' } } as never)).toBe('reject');
  });

  test('absent / garbage on both planes → warn (grace-period default)', async () => {
    expect(await resolveStrictParamsMode(engineWith(null), null)).toBe('warn');
    expect(await resolveStrictParamsMode(engineWith('yes'), { engine: 'pglite', mcp: { strict_params: 'strict' } } as never)).toBe('warn');
  });

  test('parseStrictParamsMode admits only the two modes', () => {
    expect(parseStrictParamsMode('warn')).toBe('warn');
    expect(parseStrictParamsMode('reject')).toBe('reject');
    expect(parseStrictParamsMode('true')).toBeNull();
    expect(parseStrictParamsMode(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// query op guard — neither `query` nor `image` → typed invalid_params
// ---------------------------------------------------------------------------

describe('query op with neither `query` nor `image` (WP3 typed envelope)', () => {
  test('dispatch classifies the caller mistake as invalid_params, never internal_error', async () => {
    // Both params are optional in the schema (image is the alternative entry
    // point), so validation passes and the HANDLER must throw the typed
    // OperationError — before any search runs (the stub engine has no search
    // methods; reaching one would blow up as internal_error).
    const out = await dispatchToolCall(stubEngine('reject'), 'query', {}, DISPATCH_OPTS);
    expect(out.isError).toBe(true);
    const envelope = body(out);
    expect(envelope.error).toBe('invalid_params');
    expect(envelope.message).toContain('either `query`');
    expect(envelope.message).toContain('`image`');
  });
});
