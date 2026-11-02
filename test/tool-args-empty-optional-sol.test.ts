/**
 * GPT-6.1 Sol fills every optional tool argument with an empty value (`known_as_of: ""`, `cursor: ""`,
 * `section: ""`, `grep: ""`, or `null`) instead of leaving it out. The shared absent-idiom step
 * (`normalizeOptionalParams`: `""` on an optional string param and `null` on any optional param mean "not
 * provided") ran on MCP dispatch and the subagent registry, but the SkillOpt rollout and write-capture
 * registries and `gbrain call` handed the model's raw arguments to the handler. There `known_as_of: ""` took
 * get_page into its recorded-time branch and refused every call ("known_as_of must be an ISO 8601 instant").
 *
 * 1. Protects: on every tool-call entry point, a call whose optional arguments are `""` or `null` behaves exactly
 *    like the same call with them omitted, while a missing required argument and a non-empty invalid value still
 *    refuse with `invalid_params`.
 * 2. Fails when: any registry that runs model tool calls skips the normalize-then-validate step (the SkillOpt
 *    rollout and write-capture registries and `gbrain call` did).
 * 3. Existing coverage: test/mcp-dispatch-optional-params.test.ts pins recall through dispatchToolCall only; nothing
 *    drove the agent-loop registries or `gbrain call` with Sol-style arguments, or swept every read op.
 * 4. Real seams: the production registries over a repo-less PGLite brain; the SkillOpt model loop is the
 *    `toolLoopFn` injection seam, which hands back the real tool handlers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall, normalizeOptionalParams } from '../src/mcp/dispatch.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { runRollout } from '../src/core/skillopt/rollout.ts';
import { buildWriteCaptureRegistry } from '../src/core/skillopt/write-capture.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { operations, operationsByName, type Operation, type ParamDef } from '../src/core/operations.ts';
import type { BenchmarkTask } from '../src/core/skillopt/types.ts';
import type { ToolHandler } from '../src/core/ai/gateway.ts';

const SLUG = 'notes/alpha-example';
const BODY_MARKER = 'Alpha example body marker';
const READ_OPS = operations.filter(op => op.mutating === false);

type Outcome = { ok: true; text: string } | { ok: false; code: string; text: string };
type Caller = (op: string, args: Record<string, unknown>) => Promise<Outcome>;

let engine: PGLiteEngine;
const paths: Record<string, Caller> = {};

function thrown(e: unknown): Outcome {
  const err = e as { code?: unknown; message?: unknown };
  return { ok: false, code: typeof err?.code === 'string' ? err.code : 'error', text: String(err?.message ?? e) };
}

function fromDispatch(r: { isError?: boolean; content: Array<{ text: string }> }): Outcome {
  const text = r.content.map(c => c.text).join('\n');
  if (!r.isError) return { ok: true, text };
  try {
    const body = JSON.parse(r.content[0]!.text) as { code?: string; error?: string };
    return { ok: false, code: body.code ?? body.error ?? 'error', text };
  } catch {
    return { ok: false, code: 'error', text };
  }
}

function viaHandlers(handlers: Map<string, ToolHandler>): Caller {
  return async (op, args) => {
    const h = handlers.get(`brain_${op}`);
    if (!h) return { ok: false, code: 'not_registered', text: op };
    try { return { ok: true, text: JSON.stringify(await h.execute(args, {} as never)) }; } catch (e) { return thrown(e); }
  };
}

async function rolloutHandlers(): Promise<Map<string, ToolHandler>> {
  let captured: Map<string, ToolHandler> | undefined;
  const task: BenchmarkTask = { task_id: 'sol', task: 'read a page', judge: { kind: 'rule', checks: [] } };
  await runRollout({
    engine, skillText: 'skill', task, targetModel: 'openai:gpt-6.1-sol',
    allowedTools: new Set(READ_OPS.map(op => op.name)),
    toolLoopFn: (async (o: { toolHandlers: Map<string, ToolHandler> }) => {
      captured = o.toolHandlers;
      return { messages: [], totalUsage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, totalTurns: 1, stopReason: 'end' };
    }) as never,
  });
  return captured!;
}

/** A plausible value for a required param, so a sweep call reaches the handler instead of stopping at validation. */
function requiredValue(name: string, def: ParamDef): unknown {
  if (def.enum?.length) return def.enum[0];
  if (def.type === 'number') return 1;
  if (def.type === 'boolean') return true;
  if (def.type === 'array') return ['alpha'];
  if (def.type === 'object') return {};
  return name.includes('slug') ? SLUG : 'alpha';
}

function requiredArgs(op: Operation): Record<string, unknown> {
  return Object.fromEntries(Object.entries(op.params).filter(([, d]) => d.required).map(([k, d]) => [k, requiredValue(k, d)]));
}

function emptied(op: Operation, value: '' | null): Record<string, unknown> {
  return Object.fromEntries(Object.entries(op.params)
    .filter(([, d]) => !d.required && (value === null || d.type === 'string'))
    .map(([k]) => [k, value]));
}

const summary = (o: Outcome) => (o.ok ? 'ok' : o.code);
/** The subagent registry reports a schema failure as a plain Error naming the param; every other path as invalid_params. */
const refusal = (o: Outcome) => (!o.ok && (o.code === 'invalid_params' || /^brain_\w+: (Missing required parameter|Parameter ")/.test(o.text)) ? 'invalid_params' : summary(o));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const put = await dispatchToolCall(engine, 'put_page', { slug: SLUG, content: `---\ntitle: Alpha Example\n---\n# Alpha Example\n\n${BODY_MARKER}.\n` }, { remote: false, sourceId: 'default' });
  expect(put.isError).toBeFalsy();

  paths['mcp remote (http)'] = async (op, args) => fromDispatch(await dispatchToolCall(engine, op, args, { remote: true, transport: 'http', sourceId: 'default' }));
  paths['mcp local (stdio)'] = async (op, args) => fromDispatch(await dispatchToolCall(engine, op, args, { remote: false, transport: 'stdio', sourceId: 'default' }));
  paths['gbrain call'] = async (op, args) => {
    try { return { ok: true, text: JSON.stringify(await handleToolCall(engine, op, args)) }; } catch (e) { return thrown(e); }
  };
  paths['skillopt rollout'] = viaHandlers(await rolloutHandlers());
  paths['skillopt write-capture'] = viaHandlers(buildWriteCaptureRegistry(engine).handlers);
  const subagent = buildBrainTools({ subagentId: 1, engine, config: { engine: 'pglite' } as never, sourceId: 'default' });
  paths['subagent'] = async (op, args) => {
    const tool = subagent.find(t => t.name === `brain_${op}`);
    if (!tool) return { ok: false, code: 'not_registered', text: op };
    try { return { ok: true, text: JSON.stringify(await tool.execute(args, { engine, jobId: 1, remote: true } as never)) }; } catch (e) { return thrown(e); }
  };
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('get_page with Sol-style empty optional arguments', () => {
  const op = operationsByName.get_page!;

  test('every optional string set to "" reads the page on every entry point', async () => {
    const results: Record<string, string> = {};
    for (const [name, call] of Object.entries(paths)) {
      const out = await call('get_page', { slug: SLUG, ...emptied(op, '') });
      results[name] = out.ok && out.text.includes(BODY_MARKER) ? 'read' : `${summary(out)}: ${out.text.slice(0, 160)}`;
    }
    expect(results).toEqual(Object.fromEntries(Object.keys(paths).map(k => [k, 'read'])));
  });

  test('every optional argument set to null reads the page on every entry point', async () => {
    const results: Record<string, string> = {};
    for (const [name, call] of Object.entries(paths)) {
      const out = await call('get_page', { slug: SLUG, ...emptied(op, null) });
      results[name] = out.ok && out.text.includes(BODY_MARKER) ? 'read' : `${summary(out)}: ${out.text.slice(0, 160)}`;
    }
    expect(results).toEqual(Object.fromEntries(Object.keys(paths).map(k => [k, 'read'])));
  });

  test('a missing required slug and non-empty invalid values still refuse with invalid_params', async () => {
    const refusals: Record<string, string[]> = {};
    for (const [name, call] of Object.entries(paths)) {
      refusals[name] = [
        refusal(await call('get_page', { slug: null, ...emptied(op, '') })),
        refusal(await call('get_page', { slug: SLUG, body: 'bogus' })),
        refusal(await call('get_page', { slug: SLUG, known_as_of: 'yesterday' })),
        refusal(await call('get_page', { slug: SLUG, max_bytes: 'lots' })),
      ];
    }
    expect(refusals).toEqual(Object.fromEntries(Object.keys(paths).map(k => [k, ['invalid_params', 'invalid_params', 'invalid_params', 'invalid_params']])));
  });
});

describe('sweep: every read op treats "" and null on optional args as omitted', () => {
  const swept = READ_OPS.filter(op => Object.values(op.params).some(d => !d.required));

  test('the sweep covers get_page and the other read ops with optional string args', () => {
    expect(swept.map(op => op.name)).toContain('get_page');
    expect(swept.filter(op => Object.values(op.params).some(d => !d.required && d.type === 'string')).length).toBeGreaterThan(20);
  });

  for (const value of ['', null] as const) {
    test(`optional args set to ${JSON.stringify(value)} match the omitted call on every entry point`, async () => {
      const mismatches: string[] = [];
      for (const op of swept) {
        const empties = emptied(op, value);
        if (Object.keys(empties).length === 0) continue;
        const base = requiredArgs(op);
        for (const [name, call] of Object.entries(paths)) {
          const omitted = summary(await call(op.name, base));
          const filled = await call(op.name, { ...base, ...empties });
          if (summary(filled) !== omitted) mismatches.push(`${name} ${op.name}: omitted=${omitted} filled=${summary(filled)} (${filled.text.slice(0, 120)})`);
        }
      }
      expect(mismatches).toEqual([]);
    }, 300_000);
  }
});

/**
 * GST-927: the non-string empty values GPT-6.1 Sol fills in, GBRA-278's sweep list (21 zeros, 5 empty arrays,
 * 2 empty objects, 1 false). Each read as absent only because the param's schema rules it out (minimum,
 * exclusiveMinimum, minItems, an object with a required member, actsWhenTrue): on master every one refused.
 */
const SWEEP: Array<[op: string, param: string, value: unknown]> = [
  ['get_page', 'around_chunk_id', 0], ['get_page', 'max_bytes', 0], ['get_page', 'context', 0],
  ['list_write_conflicts', 'limit', 0], ['search_exact', 'limit', 0], ['get_links', 'limit', 0], ['get_backlinks', 'limit', 0],
  ['wanted_pages', 'limit', 0], ['get_versions', 'limit', 0], ['get_chunks', 'limit', 0], ['find_orphans', 'limit', 0],
  ['rank_entities', 'limit', 0], ['search', 'return_window', 0], ['search_exact', 'max_seconds', 0],
  ['get_write_attribution', 'fact', 0], ['get_write_attribution', 'take', 0], ['get_write_attribution', 'timeline', 0],
  ['list_skills', 'schema_version', 0], ['get_skill', 'schema_version', 0], ['takes_scorecard', 'min_n', 0], ['open_loops', 'id', 0],
  ['search_exact', 'types', []], ['traverse_graph', 'hops', []], ['run_doctor', 'only', []], ['whois', 'types', []], ['rank_entities', 'types', []],
  ['get_page', 'lines', {}], ['get_page', 'bytes', {}],
  ['get_versions', 'diff', false],
];

describe('GST-927: schema-ruled-out empty values (0, [], {}, false) read as omitted', () => {
  test('the table is GBRA-278\'s sweep list', () => {
    const count = (pred: (v: unknown) => boolean) => SWEEP.filter(([, , v]) => pred(v)).length;
    expect([count(v => v === 0), count(v => Array.isArray(v)), count(v => !!v && typeof v === 'object' && !Array.isArray(v)), count(v => v === false)]).toEqual([21, 5, 2, 1]);
    for (const [op, param] of SWEEP) expect(operationsByName[op]?.params[param]?.required).not.toBe(true);
  });

  test('every sweep value matches the call with the argument omitted, on every entry point', async () => {
    const mismatches: string[] = [];
    for (const [opName, param, value] of SWEEP) {
      const op = operationsByName[opName]!;
      const base = { ...requiredArgs(op), ...(opName === 'get_page' || opName === 'get_versions' || opName === 'get_write_attribution' ? { slug: SLUG } : {}) };
      for (const [name, call] of Object.entries(paths)) {
        const omitted = await call(opName, base);
        const filled = await call(opName, { ...base, [param]: value });
        if (summary(filled) !== summary(omitted)) mismatches.push(`${name} ${opName} ${param}=${JSON.stringify(value)}: omitted=${summary(omitted)} filled=${summary(filled)} (${filled.text.slice(0, 120)})`);
      }
    }
    expect(mismatches).toEqual([]);
  }, 300_000);

  test('a value inside the valid range, a negative number and a non-empty list are never dropped', async () => {
    const outcomes: Record<string, string[]> = {};
    for (const [name, call] of Object.entries(paths)) {
      outcomes[name] = [
        refusal(await call('get_page', { slug: SLUG, around_chunk_id: -1 })),
        refusal(await call('get_page', { slug: SLUG, max_bytes: -5 })),
        refusal(await call('list_write_conflicts', { limit: 101 })),
        refusal(await call('get_page', { slug: SLUG, lines: { from: 1, count: 2 }, bytes: { offset: 0, length: 10 } })),
        refusal(await call('traverse_graph', { slug: SLUG, depth: 1, hops: [{ link_type: 'founded', toward: 'object' }] })),
        refusal(await call('get_versions', { slug: SLUG, diff: true })),
      ];
    }
    const refused = Object.fromEntries(Object.entries(outcomes).map(([k, v]) => [k, v.filter(o => o !== 'not_registered')]));
    expect(refused).toEqual(Object.fromEntries(Object.entries(outcomes).map(([k, v]) => [k, Array(v.filter(o => o !== 'not_registered').length).fill('invalid_params')])));
    expect(refused['mcp remote (http)']).toHaveLength(6);
  }, 120_000);
});

/**
 * GST-927: the shapes GBEV-3 replayed from 651 recorded Sol calls (gbrain-evals
 * test/eval/skillopt-rollout-empty-args.test.ts). On master, get_page refused `context` without `grep` and
 * traverse_graph refused `hops: []` beside depth/link_type/direction.
 */
const SOL_GET_PAGE = {
  fuzzy: false, include_content: true, content_only: false, body: 'full', lines: {}, bytes: {}, around_chunk_id: 0,
  context_lines: 20, cursor: '', outline_from: 0, section: '', grep: '', context: 1, include_deleted: false,
  include_timeline_entries: false, grammar_diagnostics: false, include_quarantined: false, known_as_of: '', source_id: 'default',
};

describe("GST-927: GBEV-3's replayed Sol shapes", () => {
  test('get_page with context but no grep, and every other optional filled Sol-style, reads the page on every entry point', async () => {
    const results: Record<string, string> = {};
    for (const [name, call] of Object.entries(paths)) {
      const out = await call('get_page', { slug: SLUG, ...SOL_GET_PAGE });
      results[name] = out.ok && out.text.includes(BODY_MARKER) ? 'read' : `${summary(out)}: ${out.text.slice(0, 160)}`;
    }
    expect(results).toEqual(Object.fromEntries(Object.keys(paths).map(k => [k, 'read'])));
  });

  test('context with grep still applies, and context with a real grep is never dropped', async () => {
    const out = await paths['mcp remote (http)']!('get_page', { slug: SLUG, grep: 'marker', context: 0 });
    expect(out.ok).toBe(true);
    expect(out.text).toContain('"context":0');
  });

  test('traverse_graph with hops: [] beside depth, link_type and direction walks the graph on every entry point', async () => {
    const results: Record<string, string> = {};
    for (const [name, call] of Object.entries(paths)) {
      const sol = await call('traverse_graph', { slug: SLUG, depth: 1, link_type: 'founded', direction: 'out', hops: [], source_id: 'default', all_sources: false });
      const plain = await call('traverse_graph', { slug: SLUG, depth: 1, link_type: 'founded', direction: 'out', source_id: 'default', all_sources: false });
      results[name] = sol.ok && summary(sol) === summary(plain) ? 'walked' : `${summary(sol)}: ${sol.text.slice(0, 160)}`;
    }
    expect(results).toEqual(Object.fromEntries(Object.keys(paths).map(k => [k, 'walked'])));
  });

  test("Sol's recorded window arguments still refuse: two window selectors are real values that change the answer", async () => {
    const args = { slug: SLUG, ...SOL_GET_PAGE, lines: { from: 1, count: 200 }, bytes: { offset: 0, length: 40000 }, around_chunk_id: 7, max_bytes: 40000, view: 'read' };
    const out = await paths['mcp remote (http)']!('get_page', args);
    expect(out.ok).toBe(false);
    expect(out.text).toContain('pass one window selector, not 3 (got lines and bytes and around_chunk_id)');
    expect(out.text).toContain('Drop `bytes` and `around_chunk_id` to read the lines window');
    const local = await handleToolCall(engine, 'get_page', args).then(() => null, (e: { fix?: { mcp?: { tool: string; arguments: Record<string, unknown> } } }) => e);
    const fixed = local?.fix?.mcp?.arguments ?? {};
    expect(Object.keys(fixed).filter(k => ['lines', 'bytes', 'around_chunk_id', 'cursor'].includes(k))).toEqual(['lines']);
    expect(fixed).toMatchObject({ slug: SLUG, lines: { from: 1, count: 200 }, body: 'window', max_bytes: 40000, view: 'read', source_id: 'default' });
    expect(fixed.include_content).toBeUndefined();
    expect((local as { fix?: { argv?: string[] } } | null)?.fix?.argv).toEqual(['gbrain', 'get', '--source-id', 'default', '--body', 'window', '--lines', '1-200', '--context-lines', '20', '--max-bytes', '40000', '--view', 'read', '--outline-from', '0', '--', SLUG]);
    const retried = await paths['mcp remote (http)']!('get_page', fixed);
    expect([retried.ok, retried.text.includes(BODY_MARKER)]).toEqual([true, true]);
  });

  test('get_page tells callers up front: at most one window selector, context only with grep', () => {
    const op = operationsByName.get_page!;
    expect(op.description).toContain('Pass at most one window selector: lines, bytes, around_chunk_id or cursor (context only with grep)');
    for (const k of ['lines', 'bytes', 'around_chunk_id', 'cursor']) expect(op.params[k]!.description).toContain('One window selector only');
    expect(op.params.context!.description).toContain('Applies only with grep');
  });

  test('known_as_of beside read-view arguments refuses, naming each argument to drop, with a fix that keeps only recorded-time arguments', async () => {
    const args = { slug: SLUG, ...SOL_GET_PAGE, known_as_of: '2026-10-01T12:00:00Z', max_bytes: 40000, view: 'read' };
    for (const [name, call] of Object.entries(paths)) {
      const out = await call('get_page', args);
      expect([name, refusal(out)]).toEqual([name, 'invalid_params']);
      expect(out.text).toContain('get_page: known_as_of does not combine with include_content');
    }
    expect((await paths['mcp remote (http)']!('get_page', args)).text).toContain('known_as_of does not combine with include_content, context_lines, max_bytes, view, outline_from.');
    const remote = JSON.parse((await dispatchToolCall(engine, 'get_page', args, { remote: true, transport: 'http', sourceId: 'default' })).content[0]!.text) as { suggestion?: string };
    expect(remote.suggestion).toContain('Drop `include_content`, `context_lines`, `max_bytes`, `view`, `outline_from` to read the page as recorded');
    const local = await handleToolCall(engine, 'get_page', args).then(() => null, (e: { suggestion?: string; fix?: { mcp?: { tool: string; arguments: Record<string, unknown> } } }) => e);
    expect(local?.suggestion).toContain('Drop --include-content, --context-lines, --max-bytes, --view, --outline-from to read the page as recorded');
    expect((local as { fix?: { argv?: string[] } } | null)?.fix?.argv).toEqual(['gbrain', 'get', '--known-as-of', '2026-10-01T12:00:00Z', '--source-id', 'default', '--body', 'full', '--', SLUG]);
    expect(local?.fix?.mcp).toEqual({ tool: 'get_page', arguments: { slug: SLUG, known_as_of: '2026-10-01T12:00:00Z', source_id: 'default', include_deleted: false, body: 'full' } });
    const retried = await dispatchToolCall(engine, 'get_page', local!.fix!.mcp!.arguments, { remote: true, transport: 'http', sourceId: 'default' });
    expect(retried.content[0]!.text).not.toContain('does not combine with');
  });
});


test('GST-927: the absence annotations sit only on optional params of read ops, so normalization never drops a write argument', () => {
  const keys = ['minimum', 'exclusiveMinimum', 'minItems', 'actsWhenTrue', 'appliesWith'] as const;
  const misplaced = operations.flatMap(op => Object.entries(op.params)
    .filter(([, d]) => keys.some(k => d[k] !== undefined) && (op.mutating !== false || d.required))
    .map(([k]) => `${op.name}.${k}`));
  expect(misplaced).toEqual([]);
});

describe('GST-927: refusal fixes keep only arguments the target read takes', () => {
  const fixOf = (args: Record<string, unknown>) => handleToolCall(engine, 'get_page', args).then(() => null,
    (e: { message?: string; suggestion?: string; fix?: { argv?: string[]; mcp?: { arguments: Record<string, unknown> } } }) => e);

  test('two selectors: the fix drops undeclared keys, and around_chunk_id kept first drops view: markdown', async () => {
    const e = await fixOf({ slug: SLUG, around_chunk_id: 3, cursor: 'gpw1.x', view: 'markdown', json: true, stray: 'x' });
    expect(e?.message).toContain('pass one window selector, not 2 (got around_chunk_id and cursor)');
    expect(e?.fix?.mcp?.arguments).toEqual({ slug: SLUG, around_chunk_id: 3, body: 'window' });
    expect(e?.fix?.argv).toEqual(['gbrain', 'get', '--around-chunk-id', '3', '--body', 'window', '--', SLUG]);
  });

  test('known_as_of with body: window names body to drop, and the fix leaves body out', async () => {
    const e = await fixOf({ slug: SLUG, known_as_of: '2026-10-01T12:00:00Z', body: 'window' });
    expect(e?.message).toContain('known_as_of does not combine with body: window');
    expect(e?.suggestion).toContain('Drop --body to read the page as recorded');
    expect(e?.fix?.mcp?.arguments).toEqual({ slug: SLUG, known_as_of: '2026-10-01T12:00:00Z' });
  });
});

test('GST-927: normalization drops no schema-empty value (0, [], {}, false) from a write op', () => {
  const dropped = operations.filter(op => op.mutating !== false).flatMap(op => Object.entries(op.params)
    .filter(([, d]) => !d.required)
    .flatMap(([k]) => [0, [], {}, false].filter(v => !(k in normalizeOptionalParams(op, { [k]: v }))).map(v => `${op.name}.${k}=${JSON.stringify(v)}`)));
  expect(dropped).toEqual([]);
});

test('GST-927: edit_page within: {} still refuses instead of editing the whole page', async () => {
  const opts = { remote: true, transport: 'http', sourceId: 'default' } as const;
  const page = JSON.parse(fromDispatch(await dispatchToolCall(engine, 'get_page', { slug: SLUG, include_content: true }, opts)).text);
  const e = fromDispatch(await dispatchToolCall(engine, 'edit_page', { slug: SLUG, expected_revision: page.revision, edits: [{ old_text: BODY_MARKER, new_text: 'replaced' }], within: {} }, opts));
  expect(e.ok).toBe(false);
  expect(e.text).toContain('edit_invalid');
});

