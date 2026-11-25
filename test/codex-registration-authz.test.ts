// I1: `gbrain setup codex` registers `serve --surface full` by default. This file proves that the
// wider registration grants a Codex connection nothing an owner's starter session could not already
// reach by calling request_tools {surface:"full"} (stdio widens itself unless mcp.allow_session_widen
// is false), and that every check that is not the surface still holds on the full surface: read-only
// sessions, credential scopes, publish gates, page readers and the source a session is pinned to.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { addMember } from '../src/core/access/members.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { OPERATION_MANIFEST } from '../src/core/operation-manifest.generated.ts';
import type { OperationMeta } from '../src/core/ops/contract.ts';
import { registrationProfile, STARTER_PROFILE } from '../src/core/mcp-registration.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { stdioVisibleTools } from '../src/mcp/server.ts';
import { disabledOpsForPublishGates } from '../src/mcp/publish-gates.ts';
import { loadConfig } from '../src/core/config.ts';
import { createStdioSurfaceState, filterOpsForSurface, isReadOnlyOperation, paramCallable, paramCeiling, type StdioSurfaceState } from '../src/mcp/surface.ts';

const OPS = OPERATION_MANIFEST as unknown as OperationMeta[];
const BOB_SLUG = 'notes/bob-plan';
const BOB_CANARY = 'canaryreaderbob';
const BOB_TAG = 'canarytagbob';
const DEFAULT_SLUG = 'notes/default-only';
const DEFAULT_CANARY = 'canarysourcedefault';
const DEFAULT_TAG = 'canarytagdefault';

const names = (ops: OperationMeta[]) => ops.map(op => op.name).sort();
const session = (surface: 'starter' | 'full', readOnly = false) => createStdioSurfaceState(OPS, { surface, source: 'flag', readOnly });
const codexSession = (readOnly = false) => session(registrationProfile('codex').surface as 'full', readOnly);
const widenedStarter = (readOnly = false) => { const s = session(STARTER_PROFILE.surface as 'starter', readOnly); s.widen('full'); return s; };

describe('I1: the Codex full registration grants what a widened starter session already reaches', () => {
  let engine: BrainEngine;

  async function call(s: StdioSurfaceState, name: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const out = await dispatchToolCall(engine, name, params, {
      remote: true, transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: 'default', ...extra,
      ...(s.allowedOps ? { allowedOps: s.allowedOps } : {}),
      surface: s.surface, surfaceCeiling: s.surface, stdioSurface: s,
    });
    return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
  }

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    __resetPrivateVisibilityCacheForTests();
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT (id) DO NOTHING");
    await importFromContent(engine, BOB_SLUG, `---\ntype: note\ntitle: Bob plan\ntags: [${BOB_TAG}]\nreadable_by: [bob-example]\n---\n# Bob plan\n\nPlanning notes ${BOB_CANARY}.`, { sourceId: 'default', noEmbed: true });
    await importFromContent(engine, DEFAULT_SLUG, `---\ntype: note\ntitle: Default only\ntags: [${DEFAULT_TAG}]\n---\n# Default only\n\nOnly in the default source ${DEFAULT_CANARY}.`, { sourceId: 'default', noEmbed: true });
    await addMember(engine, 'alice-example');
    await addMember(engine, 'bob-example');
  }, 120_000);

  afterAll(async () => { await engine?.disconnect(); }, 60_000);

  test('Codex registers full, which is the starter registration after request_tools {surface:"full"}, writable and read-only', async () => {
    expect(registrationProfile('codex')).toEqual({ surface: 'full', advertise: null });
    expect(STARTER_PROFILE).toEqual({ surface: 'starter', advertise: 'verbs' });
    for (const readOnly of [false, true]) {
      const after = codexSession(readOnly);
      const before = widenedStarter(readOnly);
      expect(names(after.surfacedOps)).toEqual(names(before.surfacedOps));
      expect(after.allowedOps ? [...after.allowedOps].sort() : null).toEqual(before.allowedOps ? [...before.allowedOps].sort() : null);
      expect(names(await stdioVisibleTools(engine, after.surfacedOps))).toEqual(names(await stdioVisibleTools(engine, before.surfacedOps)));
    }
    const starter = session('starter');
    const widened = await call(starter, 'request_tools', { surface: 'full' });
    expect(widened.isError).toBe(false);
    expect(starter.surface).toBe('full');
    expect(names(starter.surfacedOps)).toEqual(names(codexSession().surfacedOps));
  });

  test('a read-only connection on full lists no write and refuses one', async () => {
    const ro = codexSession(true);
    expect(ro.surfacedOps.length).toBeGreaterThan(filterOpsForSurface(OPS, 'starter').filter(isReadOnlyOperation).length);
    expect(ro.surfacedOps.every(isReadOnlyOperation)).toBe(true);
    for (const op of ['add_tag', 'delete_page', 'put_raw_data', 'add_link']) expect(ro.allowedOps!.has(op)).toBe(false);
    const refused = await call(ro, 'add_tag', { slug: DEFAULT_SLUG, tag: 'ro-written' });
    expect(refused.isError).toBe(true);
    expect(await engine.getTags(DEFAULT_SLUG, { sourceId: 'default' })).not.toContain('ro-written');
  });

  test('ops that need a credential scope or a publish gate that is off stay unlisted on full and are refused', async () => {
    const visible = new Set(names(await stdioVisibleTools(engine, codexSession().surfacedOps)));
    const scoped = OPS.filter(op => op.requiredScopes?.length).map(op => op.name);
    const gatedOff = [...await disabledOpsForPublishGates(engine, loadConfig(), { transport: 'stdio' })];
    expect(scoped.length).toBeGreaterThan(0);
    expect(gatedOff).toContain('list_watches');
    for (const op of [...scoped, ...gatedOff]) expect(visible.has(op)).toBe(false);
    for (const [op, params] of [['get_skill_policy', { source_id: 'default' }], ['set_skill_policy', { source_id: 'default', policy: 'open' }], ['list_watches', {}]] as const) {
      expect((await call(codexSession(), op, params as Record<string, unknown>)).isError).toBe(true);
    }
  });

  const NEW_SLUG_READS: Array<[string, Record<string, unknown>]> = [
    ['get_chunks', {}], ['get_versions', { include_body: true }], ['get_raw_data', {}], ['get_tags', {}],
    ['get_timeline', {}], ['get_links', {}], ['find_contradictions', {}], ['get_write_attribution', {}],
  ];

  test('each of these slug reads is hidden from starter by the surface alone and is listed on full', () => {
    const starter = new Set(names(filterOpsForSurface(OPS, 'starter')));
    const full = new Set(names(codexSession().surfacedOps));
    const readOnly = new Set(names(codexSession(true).surfacedOps));
    for (const [op] of NEW_SLUG_READS) {
      expect(starter.has(op)).toBe(false);
      expect(full.has(op)).toBe(true);
      expect(readOnly.has(op)).toBe(op !== 'get_write_attribution');
    }
  });

  test('a page readable only by bob-example stays out of every newly listed read for alice-example and an unbound session', async () => {
    expect((await call(codexSession(), 'get_page', { slug: BOB_SLUG }, { stdioMember: 'bob-example' })).text).toContain(BOB_CANARY);
    expect((await call(codexSession(), 'get_chunks', { slug: BOB_SLUG }, { stdioMember: 'bob-example' })).text).toContain(BOB_CANARY);
    expect((await call(codexSession(), 'get_tags', { slug: BOB_SLUG }, { stdioMember: 'bob-example' })).text).toContain(BOB_TAG);
    for (const member of [{ stdioMember: 'alice-example' }, {}]) {
      for (const [op, params] of [...NEW_SLUG_READS, ['get_page', { include_deleted: true }] as [string, Record<string, unknown>]]) {
        const out = await call(codexSession(), op, { slug: BOB_SLUG, ...params }, member);
        expect(`${op}: ${out.text}`).not.toContain(BOB_CANARY);
        expect(`${op}: ${out.text}`).not.toContain(BOB_TAG);
      }
      const found = await call(codexSession(), 'find_pages', { pattern: 'notes/*' }, member);
      expect(found.text).not.toContain(BOB_SLUG);
      expect(found.text).toContain(DEFAULT_SLUG);
    }
  });

  test('a session pinned to source-b neither reads nor writes a default-only page through the newly listed tools', async () => {
    const pin = { sourceId: 'source-b' };
    expect((await call(codexSession(), 'get_tags', { slug: DEFAULT_SLUG })).text).toContain(DEFAULT_TAG);
    for (const [op, params] of NEW_SLUG_READS) {
      const out = await call(codexSession(), op, { slug: DEFAULT_SLUG, ...params }, pin);
      expect(`${op}: ${out.text}`).not.toContain(DEFAULT_CANARY);
      expect(`${op}: ${out.text}`).not.toContain(DEFAULT_TAG);
    }
    await call(codexSession(), 'add_tag', { slug: DEFAULT_SLUG, tag: 'pinned-written' }, pin);
    await call(codexSession(), 'delete_page', { slug: DEFAULT_SLUG }, pin);
    expect(await engine.getTags(DEFAULT_SLUG, { sourceId: 'default' })).not.toContain('pinned-written');
    expect((await call(codexSession(), 'get_page', { slug: DEFAULT_SLUG })).text).toContain(DEFAULT_CANARY);
  });

  test('the parameter limits full lifts are the ones request_tools already lifts: submit_agent.max_turns and the starter-hidden params', () => {
    const lifted: string[] = [];
    const unhidden: string[] = [];
    const widened = widenedStarter();
    const after = codexSession();
    for (const op of OPS) {
      for (const param of Object.keys(op.params)) {
        if (paramCeiling(op, param, 'starter') !== undefined) lifted.push(`${op.name}.${param}`);
        if (filterOpsForSurface([op], 'starter').length && !paramCallable(op, param, 'starter')) unhidden.push(`${op.name}.${param}`);
        expect(paramCeiling(op, param, after.surface)).toBe(paramCeiling(op, param, widened.surface));
        expect(paramCallable(op, param, after.surface)).toBe(paramCallable(op, param, widened.surface));
        expect(paramCeiling(op, param, after.surface)).toBeUndefined();
        expect(paramCallable(op, param, after.surface)).toBe(true);
      }
    }
    expect(lifted).toEqual(['submit_agent.max_turns']);
    expect(unhidden).toContain('get_page.include_deleted');
  });
});
