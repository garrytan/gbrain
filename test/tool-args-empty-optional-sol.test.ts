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
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
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
