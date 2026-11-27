/**
 * Engine parity: a page update saves the page as it was read (`createVersion` with a `preimage`, src/core/import-file.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every put_page update of an existing page commits and snapshots the old page; get_versions lists the
 *    same history (body, title, frontmatter, tags, reason) and get_page as_of reads the same old edition on every
 *    engine. A reason given on an update stays on the version it archived. A direct `createVersion` with a preimage
 *    snapshots the preimage's columns, not the stored page's, with its tags in the given order.
 *  - Regression: the Rust createVersion member refused `preimage`, so every update failed at publication and stayed
 *    queued (write_pending), and no version was written.
 *  - Why existing coverage misses it: test/engine-parity/versions-raw.test.ts calls createVersion without a preimage,
 *    and no other Rust-arm case updates a page through put_page.
 *  - Seam: none. Real engines; the put_page/get_versions/get_page operation handlers and the MCP dispatcher.
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';

const { parityTest } = parityArms(testBackends());

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const ctxFor = (engine: BrainEngine) => ({ engine, sourceId: 'default', remote: false as const, writeWaitMs: 8000,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger });
const op = async (engine: BrainEngine, name: string, params: Record<string, unknown>) => {
  try {
    return { ok: true, value: await operations.find(o => o.name === name)!.handler(ctxFor(engine) as never, params) as Record<string, unknown> };
  } catch (error) { return { ok: false, code: (error as { code?: string }).code ?? String(error) }; }
};
const page = (title: string, validFrom: string, body: string) => `---\ntitle: ${title}\ntype: person\nvalid_from: ${validFrom}\ntags: [zeta, alpha]\n---\n${body}\n`;
const REQ_A = 'a0000000-0000-4000-8000-0000000000a7';
const WRITER = 'd0000000-0000-4000-8000-0000000000d7';
const STALE_REVISION = 'B0000000-0000-4000-8000-0000000000C2';
const SETTINGS = ['gbrain.write_request', 'gbrain.write_principal_kind', 'gbrain.write_principal_id'];

/** Admits one queued put_page request of the principal `local_cli:principalId`; returns its journal id. */
async function admit(engine: BrainEngine, requestId: string, principalId: string): Promise<string> {
  const source = await engine.readSourceMembership('default');
  const keys = [`principal:local_cli:${principalId}`, 'brain'];
  await engine.lockPersistenceCounters(keys);
  const row = await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId, requestId, operation: 'put_page', sourceId: 'default', sourceIncarnation: source!.incarnation,
    pageId: null, slug: 'notes/attr', worktreeId: null, topologyGeneration: null, digest: 'd'.repeat(64), intent: { kind: 'put_page', slug: 'notes/attr' },
    authority: { scopes: ['write'], agentLabel: 'agent-put_page' }, intentBytes: 100, terminalReservation: 4096, targetKind: 'page',
    protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: keys, clientRequestId: null, state: 'queued',
    deferredRefreshId: null,
  });
  return row.id;
}
type Version = { compiled_truth?: string; title?: string; type?: string; frontmatter?: unknown; tags?: unknown; replaced_because?: string | null; change_reason?: string | null };
const view = (v: Version) => ({ compiled_truth: v.compiled_truth, title: v.title, type: v.type, frontmatter: v.frontmatter, tags: v.tags,
  replaced_because: v.replaced_because ?? null });
/** The page's current revision, as an agent reads it before it replaces the page (put_page's description). */
const revisionOf = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;
const committed = (r: { ok: boolean; value?: Record<string, unknown>; code?: string }) => r.ok ? { ok: true, state: r.value?.state ?? null } : r;

describe('engine parity: a page update saves the page as it was read', () => {
  parityTest('put_page updates snapshot each old page; get_versions and get_page as_of read the same history; a reason stays', {
    methods: ['readPageSnapshot', 'getVersions'],
    timeout: 60_000,
  }, async (engine) => {
    try {
      const writes = [
        await op(engine, 'put_page', { slug: 'people/dana-example', content: page('Dana one', '2024-01-01', 'Dana works at acme-example.') }),
        await op(engine, 'put_page', { slug: 'people/dana-example', content: page('Dana two', '2025-01-01', 'Dana moved to widget-co.'),
          expected_revision: await revisionOf(engine, 'people/dana-example') }),
        await op(engine, 'put_page', { slug: 'people/dana-example', content: page('Dana three', '2026-01-01', 'Dana founded a-company.'),
          expected_revision: await revisionOf(engine, 'people/dana-example'), reason: 'She founded a company' }),
      ].map(committed);
      expect(writes).toEqual([{ ok: true, state: 'committed' }, { ok: true, state: 'committed' }, { ok: true, state: 'committed' }]);
      const versions = (await engine.getVersions('people/dana-example', { sourceId: 'default' })).map(v => view(v as Version));
      expect(versions.map(v => v.compiled_truth)).toEqual(['Dana moved to widget-co.', 'Dana works at acme-example.']);
      expect(versions[0]!.replaced_because).toBe('She founded a company');
      const listed = await op(engine, 'get_versions', { slug: 'people/dana-example' });
      expect(listed.ok && (listed.value as unknown as Version[]).map(v => v.replaced_because ?? null)).toEqual(['She founded a company', null]);
      const asOf = await Promise.all(['2024-06-01', '2025-06-01', '2026-06-01'].map(async date => {
        const r = await op(engine, 'get_page', { slug: 'people/dana-example', as_of: date });
        if (!r.ok) return r;
        // recorded_since is the wall-clock time the version was written: its shape is compared, not its value.
        const { recorded_since, ...validTime } = (r.value?.valid_time ?? {}) as Record<string, unknown>;
        return { title: r.value?.title, compiled_truth: r.value?.compiled_truth, valid_time: validTime,
          recorded_since_is_iso: typeof recorded_since === 'string' && !Number.isNaN(Date.parse(recorded_since)) };
      }));
      expect(asOf.map(r => (r as { compiled_truth?: string }).compiled_truth)).toEqual(
        ['Dana works at acme-example.', 'Dana moved to widget-co.', 'Dana founded a-company.']);
      return {
        writes,
        versions,
        listed: listed.ok ? (listed.value as unknown as Version[]).map(view) : listed,
        asOf,
      };
    } finally { await disposePersistenceConsumer(engine); }
  });

  parityTest('createVersion with a preimage snapshots the preimage, not the stored page, and keeps its tag order', {
    methods: ['putPage', 'readPageSnapshot', 'createVersion', 'getVersions'],
  }, async (engine) => {
    await engine.putPage('notes/pre', { type: 'note', title: 'Read title', compiled_truth: 'Read body.', timeline: '- 2026-01-01: read',
      frontmatter: { stage: 'read', nested: { b: 2, a: 1 } } });
    const snapshot = (await engine.readPageSnapshot('notes/pre', { sourceId: 'default' }))!;
    await engine.putPage('notes/pre', { type: 'note', title: 'Stored title', compiled_truth: 'Stored body.', timeline: '', frontmatter: { stage: 'stored' } });
    const created = await engine.createVersion('notes/pre', { sourceId: 'default', reason: 'kept', preimage: { ...snapshot, tags: ['zeta', 'alpha'] } });
    const listed = await engine.getVersions('notes/pre', { sourceId: 'default' });
    const mine = listed.find(v => v.id === created.id)!;
    expect(mine.compiled_truth).toBe('Read body.');
    expect(mine.title).toBe('Read title');
    expect((await engine.getPage('notes/pre'))!.compiled_truth).toBe('Stored body.');
    const pick = (v: Version & { timeline?: string }) => ({ ...view(v), timeline: v.timeline, change_reason: v.change_reason ?? null });
    return { created: pick(created as Version), listed: pick(mine as Version), live: (await engine.getPage('notes/pre'))!.title };
  });

  parityTest('createVersion with a preimage takes the writer of its own revision only, and stores the revision lower-case', {
    methods: ['putPage', 'readPageSnapshot', 'createVersion', 'readVersionAttributions', 'applyTransactionSettings'],
  }, async (engine) => {
    const request = await admit(engine, REQ_A, WRITER);
    const written = await engine.transaction(async (tx) => {
      await tx.applyTransactionSettings(SETTINGS, [request, 'local_cli', WRITER]);
      return tx.putPage('notes/attr', { type: 'note', title: 'Attributed', compiled_truth: 'Written body.', timeline: '' });
    });
    const snapshot = (await engine.readPageSnapshot('notes/attr', { sourceId: 'default' }))!;
    // The stored revision spelled upper-case is still the stored revision; another revision is a stale preimage.
    const current = await engine.createVersion('notes/attr', { sourceId: 'default', preimage: { ...snapshot, revision: snapshot.revision.toUpperCase() } });
    const stale = await engine.createVersion('notes/attr', { sourceId: 'default', preimage: { ...snapshot, revision: STALE_REVISION } });
    const rows = await engine.readVersionAttributions([current, stale].map(v => ({ id: Number(v.id), page_id: Number(written.id) })));
    const writer = (id: unknown) => {
      const row = rows.find(r => Number(r.id) === Number(id));
      return row && { request: row.w_req === request ? 'reqA' : row.w_req, principal: row.w_id };
    };
    const revisions = [current, stale].map(v => (v as { knowledge_revision?: string }).knowledge_revision);
    const answers = { current: writer(current.id), stale: writer(stale.id), revisions: revisions.map(r => r === snapshot.revision ? 'stored' : r) };
    // PGLite's version trigger copies the page's receipt only for the stored revision, and the uuid cast lower-cases it.
    expect(answers).toEqual({ current: { request: 'reqA', principal: WRITER }, stale: { request: null, principal: null },
      revisions: ['stored', STALE_REVISION.toLowerCase()] });
    return answers;
  });

  parityTest('the MCP dispatcher commits a put_page update over stdio and http and get_versions lists the old page', {
    methods: ['readPageSnapshot'],
    timeout: 60_000,
  }, async (engine) => {
    try {
      const answers: Record<string, unknown> = {};
      for (const transport of ['stdio', 'http'] as const) {
        const slug = `people/erin-example-${transport}`;
        const call = async (name: string, params: Record<string, unknown>) => {
          const result = await dispatchToolCall(engine, name, params, { remote: false, transport, sourceId: 'default', writeWaitMs: 8000,
            config: { engine: engine.kind, embedding_disabled: true } as never, logger });
          const text = (result.content[0] as { text: string }).text;
          let body: unknown = text;
          try { body = JSON.parse(text); } catch { /* an error result is text */ }
          return { isError: result.isError === true, body };
        };
        const created = await call('put_page', { slug, content: page('Erin one', '2024-01-01', 'Erin v1.') });
        const updated = await call('put_page', { slug, content: page('Erin two', '2025-01-01', 'Erin v2.'), reason: 'Erin changed jobs',
          expected_revision: await revisionOf(engine, slug) });
        const listed = await call('get_versions', { slug });
        const state = (r: { isError: boolean; body: unknown }) => ({ isError: r.isError, state: (r.body as { state?: string })?.state ?? null });
        const versions = Array.isArray(listed.body) ? (listed.body as Version[]).map(view) : listed.body;
        expect(state(created)).toEqual({ isError: false, state: 'committed' });
        expect(state(updated)).toEqual({ isError: false, state: 'committed' });
        expect(listed.isError).toBe(false);
        answers[transport] = { created: state(created), updated: state(updated), versions };
      }
      return answers;
    } finally { await disposePersistenceConsumer(engine); }
  });
});
