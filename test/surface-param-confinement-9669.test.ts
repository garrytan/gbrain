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
import { PARAM_NOT_ON_SURFACE_CODE } from '../src/mcp/hidden-tool-hint.ts';
import { CODES } from '../src/core/error-registry.ts';
import { SUBMIT_AGENT_DEFAULT_MAX_TURNS } from '../src/core/ops/jobs.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { renderAction } from '../src/core/agent-output.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const CODE = PARAM_NOT_ON_SURFACE_CODE;
const GONE = { slug: 'notes/gone-example', canary: 'canarytombstonealpha' };
const LIVE = { slug: 'notes/live-example', canary: 'canarylivebeta' };
const PRIV = { slug: 'notes/private-example', canary: 'canaryprivategamma' };
const QUAR = { slug: 'notes/quarantined-example', canary: 'canaryquarantinedelta' };
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
        await engine.putPage(p.slug, { type: 'note' as never, title: p.slug, compiled_truth: `Notes ${p.canary}.`, timeline: '', frontmatter: { status: 'active' } });
      }
      expect(await engine.softDeletePage(GONE.slug)).not.toBeNull();
      await importFromContent(engine, PRIV.slug, `---\nstatus: active\nvisibility: private\n---\n# Private\nNotes ${PRIV.canary}.`, { sourceId: 'default', noEmbed: true });
      await importFromContent(engine, QUAR.slug, `---\nstatus: active\n---\n# Held\nNotes ${QUAR.canary}.`, { sourceId: 'default', noEmbed: true });
      await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"quarantine": {"reason": "junk_pattern"}}'::jsonb WHERE source_id = 'default' AND slug = $1`, [QUAR.slug]);
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

    // Condition from review: slug_prefix and where stay callable on starter, so pin that they only filter what the plain
    // starter listing already shows. A quarantined page is listed by slug and title to every caller as before (#6259 holds
    // back its body, not its listing), so the filters add nothing there either; no listing carries a body.
    test('list_pages slug_prefix and where never return a soft-deleted or private page to a starter client, nor more than the plain list', async () => {
      const slugs = async (args: Record<string, unknown>) => {
        const res = await dispatchToolCall(engine, 'list_pages', args, stdio('starter'));
        expect(res.isError).toBeFalsy();
        for (const canary of [GONE.canary, PRIV.canary, QUAR.canary]) expect(all(res)).not.toContain(canary);
        return (JSON.parse(res.content[0]!.text) as Array<{ slug: string }>).map(row => row.slug).sort();
      };
      const plain = await slugs({});
      expect(plain).toContain(LIVE.slug);
      for (const args of [{ slug_prefix: 'notes/' }, { slug_prefix: GONE.slug }, { slug_prefix: PRIV.slug }, { slug_prefix: QUAR.slug },
        { where: { status: 'active' } }, { where: { visibility: 'private' } }, { where: { quarantine: 'junk_pattern' } },
        { slug_prefix: 'notes/', where: { status: 'active' } }]) {
        const got = await slugs(args);
        expect({ args, extra: got.filter(slug => !plain.includes(slug)) }).toEqual({ args, extra: [] });
        expect({ args, deleted: got.includes(GONE.slug), priv: got.includes(PRIV.slug) }).toEqual({ args, deleted: false, priv: false });
      }
      expect(await slugs({ slug_prefix: 'notes/' })).toContain(LIVE.slug);
      expect(await slugs({ where: { status: 'active' } })).toContain(LIVE.slug);
      expect(all(await dispatchToolCall(engine, 'list_pages', { slug_prefix: 'notes/' }, { remote: false, sourceId: 'default' } as Opts))).toContain(PRIV.slug);
    });

    test('a starter client pages list_pages through pagination.next.offset and gets page two', async () => {
      const slugs = (res: Result) => (JSON.parse(res.content[0]!.text) as Array<{ slug: string }>).map(row => row.slug);
      const first = await dispatchToolCall(engine, 'list_pages', { limit: 1 }, stdio('starter'));
      expect(first.isError).toBeFalsy();
      const next = (first._meta as { pagination?: { next?: Record<string, unknown> } } | undefined)?.pagination?.next;
      expect(next).toEqual({ offset: 1 });
      const second = await dispatchToolCall(engine, 'list_pages', { limit: 1, ...next }, stdio('starter'));
      expect(envelope(second).code).not.toBe(CODE);
      expect(second.isError).toBeFalsy();
      expect(slugs(second)).toHaveLength(1);
      expect(slugs(second)[0]).not.toBe(slugs(first)[0]);
    });

    test('submit_agent max_turns on starter may only lower the turns a call without it gets', async () => {
      expect(SUBMIT_AGENT_DEFAULT_MAX_TURNS).toBe(20);
      const call = (max_turns: number, surface: McpSurface) =>
        dispatchToolCall(engine, 'submit_agent', { prompt: 'Summarize this week.', max_turns }, stdio(surface)).then(envelope);
      for (const max_turns of [SUBMIT_AGENT_DEFAULT_MAX_TURNS + 1, 100]) {
        const env = await call(max_turns, 'starter');
        expect(env.code).toBe(CODE);
        expect(String(env.message)).toContain(`max_turns above ${SUBMIT_AGENT_DEFAULT_MAX_TURNS}`);
        expect(env.fix?.mcp).toEqual({ tool: 'request_tools', arguments: { surface: 'full' } });
      }
      for (const max_turns of [1, SUBMIT_AGENT_DEFAULT_MAX_TURNS]) expect((await call(max_turns, 'starter')).code).not.toBe(CODE);
      expect((await call(100, 'full')).code).not.toBe(CODE);
    });

    test('GST-3186: a starter client dates a remembered fact with valid_from, as items[].valid_from already could', async () => {
      const stored = async (fact: string) => (await engine.executeRaw<{ valid_from: Date | string }>(
        `SELECT valid_from FROM facts WHERE source_id = 'default' AND fact = $1`, [fact]))[0];
      const single = await dispatchToolCall(engine, 'remember',
        { fact: 'acme-example signed the lease', entity: 'acme-example', provenance: 'meeting notes', valid_from: '2025-03-01' }, stdio('starter'));
      expect(envelope(single).code).not.toBe(CODE);
      expect(single.isError).toBeFalsy();
      const batch = await dispatchToolCall(engine, 'remember',
        { items: [{ fact: 'acme-example opened an office', entity: 'acme-example', provenance: 'meeting notes', valid_from: '2025-03-01' }] }, stdio('starter'));
      expect(batch.isError).toBeFalsy();
      const [a, b] = [await stored('acme-example signed the lease'), await stored('acme-example opened an office')];
      expect(new Date(a!.valid_from).toISOString()).toBe('2025-03-01T00:00:00.000Z');
      expect(new Date(b!.valid_from).toISOString()).toBe(new Date(a!.valid_from).toISOString());
      expect(filterOpsForSurface(operations.filter(op => op.name === 'remember'), 'starter')[0]!.params).not.toHaveProperty('valid_from');
    });

    test('GST-3170: a starter client cannot pass a typed-claim key its schema hides inside remember items either', async () => {
      const hidden = Object.keys(operations.find(op => op.name === 'remember')!.params).filter(key => key.startsWith('claim_')
        && !(key in filterOpsForSurface(operations.filter(op => op.name === 'remember'), 'starter')[0]!.params) && !(CALLABLE.remember?.[key]));
      expect(hidden.length).toBeGreaterThan(0);
      const fact = 'acme-example closed a round canaryitemclaim';
      for (const key of hidden) {
        const res = await dispatchToolCall(engine, 'remember',
          { items: [{ fact, entity: 'acme-example', provenance: 'meeting notes', [key]: key === 'claim_value' ? 5 : 'fundraise' }] }, stdio('starter'));
        expect({ key, code: envelope(res).code, text: all(res).includes(key) }).toEqual({ key, code: CODE, text: true });
      }
      expect((await engine.executeRaw('SELECT 1 FROM facts WHERE fact = $1', [fact])).length).toBe(0);
      const full = await dispatchToolCall(engine, 'remember',
        { items: [{ fact, entity: 'acme-example', provenance: 'meeting notes', claim_metric: 'fundraise', claim_value: 5 }] }, stdio('full'));
      expect(full.isError).toBeFalsy();
    });

    test('param_not_on_surface is one registered code, and a call to a hidden tool still gets unknown_tool', async () => {
      expect(CODE in CODES).toBe(true);
      expect(operations.some(op => op.name === 'get_versions') && !allowedOpNames(operations, 'starter').has('get_versions')).toBe(true);
      for (const opts of [stdio('starter'), pinnedHttp('starter')]) {
        expect(envelope(await dispatchToolCall(engine, 'get_versions', { slug: LIVE.slug }, opts)).code).toBe('unknown_tool');
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

// Captain's condition on the three delegation parameters starter keeps (STARTER_CALLABLE_PARAMS.submit_agent): each is
// usable and each keeps its bound. The finite-budget rule for a model with no known price is pinned by
// test/minions/delegated-execution.serial.test.ts ('finite caps refuse unknown prices or absent enforced bounds before IO').
for (const kind of testBackends()) {
  describe(`submit_agent delegation parameters on the starter surface (${kind}, repo-less)`, () => {
    const CLIENT = 'delegating-client-example';
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, scope, source_id) VALUES ($1, 'x', $1, 'read', 'default')`, [CLIENT]);
      await engine.executeRaw(`UPDATE oauth_clients SET scope = 'read agent', bound_tools = ARRAY['get_page'], delegated_namespace = 'prefixes',
        delegated_slug_prefixes = ARRAY['wiki/'], bound_source_id = 'default', federated_read = ARRAY['default'], bound_max_concurrent = 3 WHERE client_id = $1`, [CLIENT]);
    }, 120_000);

    afterAll(async () => { await close?.(); }, 60_000);

    const submit = (args: Record<string, unknown>) => {
      const auth = { token: 't', clientId: CLIENT, principal: { kind: 'oauth_client', id: CLIENT }, scopes: ['read', 'agent'], sourceId: 'default' } as AuthInfo;
      return dispatchToolCall(engine, 'submit_agent', { prompt: 'Summarize the example notes.', dry_run: true, ...args },
        { remote: true, transport: 'http', surface: 'starter', allowedOps: allowedOpNames(operations, 'starter'), auth, sourceId: 'default' }).then(envelope);
    };

    test('queue, a supported model and a narrower prefix are accepted', async () => {
      const env = await submit({ queue: 'delegate-example', model: 'anthropic:claude-sonnet-4-6', allowed_slug_prefixes: ['wiki/notes/'] });
      expect(env.code).toBeUndefined();
      expect(env).toMatchObject({ dry_run: true, resolved_model: 'anthropic:claude-sonnet-4-6', resolved_slug_prefixes: ['wiki/notes/*'] });
    });

    test('allowed_slug_prefixes wider than the grant is refused', async () => {
      for (const prefixes of [['other/'], ['wiki/', 'other/']]) {
        const env = await submit({ allowed_slug_prefixes: prefixes });
        expect(env.code).not.toBe(CODE);
        expect(JSON.stringify(env)).toContain('delegated_prefixes_invalid');
      }
    });

    test('an unsupported model is refused', async () => {
      const env = await submit({ model: 'custom:unknown-example' });
      expect(env.code).toBe('invalid_params');
      expect(String(env.message)).toContain('model must name a supported agent tool-loop model');
    });
  });
}
