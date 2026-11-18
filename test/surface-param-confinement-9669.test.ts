/**
 * #9669: a remote caller's tool surface confines the parameters it may pass, not only the tools it may call.
 *
 * 1. Protects: a remote caller on a narrower surface (starter) that passes a parameter its tool schema leaves out is
 *    refused at dispatch (param_not_on_surface) before the handler runs, unless the parameter is on the reviewed
 *    STARTER_CALLABLE_PARAMS list. The reported case: a starter client passing include_deleted to get_page or
 *    list_pages read soft-deleted pages, and page_not_found told it to. A full-surface remote caller and the trusted
 *    local CLI keep reading tombstones exactly as before.
 * 2. Fails when: any hidden parameter of any operation on a narrower surface reaches its handler without being on the
 *    reviewed list, the refusal offers a widen past an operator pin, or a rendered fix names a parameter the caller's
 *    surface refuses.
 * 3. Real seams: dispatchToolCall (the dispatch path both MCP transports share) on in-memory PGLite, and on Postgres
 *    when DATABASE_URL is set; the census stubs handlers so it walks every operation in the manifest.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { OPERATION_MANIFEST } from '../src/core/operation-manifest.generated.ts';
import type { AuthInfo, ParamDef } from '../src/core/ops/contract.ts';
import { dispatchToolCall, dispatchRenderContext } from '../src/mcp/dispatch.ts';
import * as surfaces from '../src/mcp/surface.ts';
import { allowedOpNames, filterOpsForSurface, type McpSurface } from '../src/mcp/surface.ts';
import { renderAction } from '../src/core/agent-output.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const CODE = 'param_not_on_surface';
const GONE = { slug: 'notes/gone-example', canary: 'canarytombstonealpha' };
const LIVE = { slug: 'notes/live-example', canary: 'canarylivebeta' };
const CALLABLE: Readonly<Record<string, Readonly<Record<string, string>>>> =
  (surfaces as unknown as { STARTER_CALLABLE_PARAMS?: Record<string, Record<string, string>> }).STARTER_CALLABLE_PARAMS ?? {};

type Opts = NonNullable<Parameters<typeof dispatchToolCall>[3]>;
type Result = Awaited<ReturnType<typeof dispatchToolCall>>;

function stdio(surface: McpSurface): Opts {
  return { remote: true, transport: 'stdio', surface, allowedOps: allowedOpNames(operations, surface), sourceId: 'default' };
}

function pinnedHttp(surface: McpSurface): Opts {
  const auth = { token: 't', clientId: 'client-example', principal: { kind: 'oauth_client', id: 'client-example' },
    scopes: ['read'], surfaceSetBy: 'operator' } as AuthInfo;
  return { remote: true, transport: 'http', surface, surfaceCeiling: 'full', allowedOps: allowedOpNames(operations, surface), auth, sourceId: 'default' };
}

const all = (res: Result) => res.content.map(c => c.text).join('\n');

function envelope(res: Result): Record<string, any> {
  try { return JSON.parse(res.content[0]!.text); } catch { return { text: all(res) }; }
}

for (const kind of testBackends()) {
  describe(`include_deleted on the starter surface (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      for (const p of [GONE, LIVE]) {
        await engine.putPage(p.slug, { type: 'note' as never, title: p.slug, compiled_truth: `Notes ${p.canary}.`, timeline: '', frontmatter: {} });
      }
      expect(await engine.softDeletePage(GONE.slug)).not.toBeNull();
    }, 120_000);

    afterAll(async () => { await close?.(); }, 60_000);

    test('a starter client passing include_deleted to get_page is refused before the read', async () => {
      const res = await dispatchToolCall(engine, 'get_page', { slug: GONE.slug, include_deleted: true }, stdio('starter'));
      expect(all(res)).not.toContain(GONE.canary);
      expect(envelope(res).code).toBe(CODE);
    });

    test('a starter client passing include_deleted to list_pages is refused before the listing', async () => {
      const res = await dispatchToolCall(engine, 'list_pages', { include_deleted: true }, stdio('starter'));
      expect(all(res)).not.toContain(GONE.slug);
      expect(envelope(res).code).toBe(CODE);
    });

    test('an operator-pinned HTTP starter client is refused the same way and is never offered a widen', async () => {
      const res = await dispatchToolCall(engine, 'get_page', { slug: GONE.slug, include_deleted: true }, pinnedHttp('starter'));
      expect(all(res)).not.toContain(GONE.canary);
      expect(envelope(res).code).toBe(CODE);
      expect(all(res)).not.toContain('request_tools');
    });

    test('a starter stdio session that may widen is told the exact request_tools call', async () => {
      const env = envelope(await dispatchToolCall(engine, 'get_page', { slug: GONE.slug, include_deleted: true }, stdio('starter')));
      expect(env.code).toBe(CODE);
      expect(env.fix?.mcp).toEqual({ tool: 'request_tools', arguments: { surface: 'full' } });
      expect(env.fix?.next).toBe('run');
      expect(String(env.message)).toContain('include_deleted');
    });

    test('page_not_found on starter does not offer include_deleted', async () => {
      const res = await dispatchToolCall(engine, 'get_page', { slug: GONE.slug }, stdio('starter'));
      expect(envelope(res).code).toBe('page_not_found');
      expect(all(res)).not.toContain('include_deleted');
      expect(all(res)).not.toContain('include-deleted');
    });

    test('page_not_found on the full surface still offers include_deleted', async () => {
      const res = await dispatchToolCall(engine, 'get_page', { slug: GONE.slug }, stdio('full'));
      expect(envelope(res).code).toBe('page_not_found');
      expect(all(res)).toContain('include_deleted');
    });

    test('a full-surface remote caller and the local CLI still read the tombstone', async () => {
      for (const opts of [stdio('full'), { remote: false, sourceId: 'default' } as Opts]) {
        expect(all(await dispatchToolCall(engine, 'get_page', { slug: GONE.slug, include_deleted: true }, opts))).toContain(GONE.canary);
        expect(all(await dispatchToolCall(engine, 'list_pages', { include_deleted: true }, opts))).toContain(GONE.slug);
      }
    });

    test('a starter client still reads live pages with the parameters its schema lists', async () => {
      const res = await dispatchToolCall(engine, 'get_page', { slug: LIVE.slug, include_content: true }, stdio('starter'));
      expect(res.isError).toBeFalsy();
      expect(all(res)).toContain(LIVE.canary);
    });
  });
}

/** One value per declared parameter that normalizeOptionalParams keeps (never reads as omitted). */
function example(def: ParamDef): unknown {
  if (def.enum?.length) return def.type === 'array' ? [def.enum[0]] : def.enum[0];
  switch (def.type) {
    case 'boolean': return true;
    case 'number': case 'integer': return Math.max(def.minimum ?? 1, (def.exclusiveMinimum ?? 0) + 1, 1);
    case 'array': return [def.items ? example(def.items) : 'x'];
    case 'object': return Object.fromEntries(Object.entries(def.properties ?? { k: { type: 'string' } as ParamDef }).map(([k, d]) => [k, example(d)]));
    default: return 'x';
  }
}

describe('census: every parameter a narrower surface leaves out of an operation schema', () => {
  let engine: BrainEngine;
  const original = new Map<string, (typeof operations)[number]['handler']>();
  const reached = new Set<string>();

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    for (const op of operations) {
      original.set(op.name, op.handler);
      op.handler = async () => { reached.add(op.name); return { ok: true }; };
    }
  }, 120_000);

  afterAll(async () => {
    for (const op of operations) op.handler = original.get(op.name)!;
    await engine.disconnect();
  });

  async function walk(surface: McpSurface) {
    const shown = new Map(filterOpsForSurface(OPERATION_MANIFEST, surface).map(op => [op.name, op]));
    const leaked: string[] = [];
    const refused: string[] = [];
    const callable: string[] = [];
    for (const op of OPERATION_MANIFEST) {
      const listed = shown.get(op.name);
      if (!listed) continue;
      for (const [name, def] of Object.entries(op.params)) {
        if (name in listed.params) continue;
        const companion = def.appliesWith ? { [def.appliesWith]: example(op.params[def.appliesWith]!) } : {};
        reached.clear();
        const env = envelope(await dispatchToolCall(engine, op.name, { ...companion, [name]: example(def) }, stdio(surface)));
        const id = `${op.name}.${name}`;
        if (CALLABLE[op.name]?.[name] !== undefined) {
          if (env.code === CODE && String(env.message).includes(' ' + name)) leaked.push(id + ' (listed callable, refused)');
          else callable.push(id);
        } else if (env.code === CODE && String(env.message).includes(name) && !reached.has(op.name)) refused.push(id);
        else leaked.push(id);
      }
    }
    return { leaked, refused, callable };
  }

  test('starter: every hidden parameter is refused at dispatch or is on the reviewed list', async () => {
    const { leaked, refused, callable } = await walk('starter');
    expect(leaked).toEqual([]);
    expect(refused.length).toBeGreaterThan(50);
    expect(callable.sort()).toEqual(Object.entries(CALLABLE).flatMap(([op, ps]) => Object.keys(ps).map(p => `${op}.${p}`)).sort());
  }, 120_000);

  test('verbs: the verbs surface lists every parameter of its operations, so it hides none to enforce', async () => {
    const { leaked, refused, callable } = await walk('verbs');
    expect([...leaked, ...refused, ...callable]).toEqual([]);
  }, 60_000);

  test('every full-surface-only parameter in the manifest is hidden on starter, or its tool is not callable there', async () => {
    const starter = new Map(filterOpsForSurface(OPERATION_MANIFEST, 'starter').map(op => [op.name, op]));
    let counted = 0;
    for (const op of OPERATION_MANIFEST) {
      for (const [name, def] of Object.entries(op.params)) {
        if (!def.fullSurfaceOnly) continue;
        counted++;
        const listed = starter.get(op.name);
        if (listed) expect(name in listed.params).toBe(false);
        else {
          reached.clear();
          const res = await dispatchToolCall(engine, op.name, { [name]: example(def) }, stdio('starter'));
          expect(res.isError).toBe(true);
          expect(reached.has(op.name)).toBe(false);
        }
      }
    }
    expect(counted).toBeGreaterThan(150);
  }, 120_000);

  test('the reviewed list names only parameters that starter hides, each with a reason', () => {
    const starter = new Map(filterOpsForSurface(OPERATION_MANIFEST, 'starter').map(op => [op.name, op]));
    const full = new Map(OPERATION_MANIFEST.map(op => [op.name, op]));
    expect(Object.keys(CALLABLE).length).toBeGreaterThan(0);
    for (const [op, params] of Object.entries(CALLABLE)) {
      for (const [param, why] of Object.entries(params)) {
        expect(full.get(op)?.params[param]).toBeDefined();
        expect(starter.get(op)?.params[param]).toBeUndefined();
        expect(why.length).toBeGreaterThan(20);
      }
    }
  });

  test('local and full-surface callers pass every parameter through to the handler', async () => {
    for (const opts of [stdio('full'), { remote: false, sourceId: 'default' } as Opts]) {
      reached.clear();
      const env = envelope(await dispatchToolCall(engine, 'get_page', { slug: 'notes/x', include_deleted: true, include_quarantined: true }, opts));
      expect(env.code).not.toBe(CODE);
      expect(reached.has('get_page')).toBe(true);
    }
  });
});

describe('rendered fixes never name a parameter the caller surface refuses', () => {
  const fix = { mcp: { tool: 'get_page', arguments: { slug: 'notes/x', include_deleted: true } }, argv: ['gbrain', 'get', 'notes/x', '--include-deleted'],
    consent: [], actor: 'agent' as const, requires_exclusive: false, why: 'Shows the page if it is soft-deleted.' };

  test('starter drops the MCP call; full keeps it', () => {
    expect(renderAction(fix, dispatchRenderContext(stdio('starter'))).mcp).toBeUndefined();
    expect(renderAction(fix, dispatchRenderContext(stdio('full'))).mcp).toEqual(fix.mcp);
  });

  test('a parameter on the reviewed list stays in the call', () => {
    const window = { ...fix, mcp: { tool: 'get_page', arguments: { slug: 'notes/x', cursor: 'gpw1.x' } } };
    expect(renderAction(window, dispatchRenderContext(stdio('starter'))).mcp).toEqual(window.mcp);
  });
});
