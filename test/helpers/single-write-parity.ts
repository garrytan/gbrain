/**
 * Phase 4.1 parity: one scenario of page writes (local and remote callers;
 * aliases, frontmatter, tags, timeline, takes and facts fences, links and
 * wanted links, an update, a delete and a database-only write without a
 * binding) run on a fresh managed brain, then every row it produced dumped
 * with run-specific identities (ids, timestamps, revisions, request ids,
 * writer and host ids) replaced by stable names. Two runs of the scenario,
 * one per publication path, must dump the same rows, effects, receipts,
 * attribution and files.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../../src/core/persistence/identity.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { renderTakesFence } from '../../src/core/takes-fence.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { expect } from 'bun:test';
import { managedBrain } from './managed-brain.ts';
import { withEnv } from './with-env.ts';
import { resetWriteSwitches } from '../../src/core/persistence/switches.ts';

const facts = renderFactsTable([{ rowNum: 1, claim: 'Alice Example leads the platform team', kind: 'fact', confidence: 0.9,
  visibility: 'world', notability: 'medium', source: 'notes/standup', context: 'team update', active: true }]);
const takes = renderTakesFence([{ rowNum: 1, claim: 'Acme Example will ship the beta this quarter', kind: 'bet',
  holder: 'world', weight: 0.6, source: 'notes/standup', active: true }]);
const person = (body: string) => `---\ntitle: Alice Example\ntype: person\naliases: [Alice E, A. Example]\ntags: [team, platform]\nrole: lead\n---\n\n${body}`;
const ALICE_V1 = person(`# Alice Example\n\nAlice works with [[companies/acme-example]] and [[people/bob-example]] (no page yet).\n\n## Facts\n\n${facts}\n\n## Takes\n\n${takes}\n\n## Timeline\n\n- **2026-01-02** | standup — Joined [[companies/acme-example]]\n- **2026-02-03** | standup — Led the platform review\n`);
const ALICE_V2 = person(`# Alice Example\n\nAlice now advises [[companies/acme-example]].\n\n## Timeline\n\n- **2026-01-02** | standup — Joined [[companies/acme-example]]\n- **2026-03-04** | standup — Moved to an advisory role\n`);

export type ParityDump = Record<string, unknown>;

async function waitCommitted(engine: BrainEngine): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const [open] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE state NOT IN ('committed','conflict','failed','cancelled')");
    if (open!.n === 0) return;
    await Bun.sleep(50);
  }
  throw new Error('writes did not settle');
}

/**
 * Runs the scenario on a fresh managed brain (PGLite unless `databaseUrl`) and returns its normalized dump,
 * plus `groupCompletions`: how many publications completed through the group path (not compared).
 */
export async function runSingleWriteParityScenario(databaseUrl?: string): Promise<{ dump: ParityDump; groupCompletions: number }> {
  let dump: ParityDump = {};
  let groupCompletions = 0;
  await managedBrain(async ({ engine, ctx, root }) => {
    const proto = Object.getPrototypeOf(engine) as { executeRaw: (sql: string, ...rest: unknown[]) => Promise<unknown> };
    const original = proto.executeRaw;
    proto.executeRaw = function (this: unknown, sql: string, ...rest: unknown[]) {
      if (typeof sql === 'string' && sql.includes("UPDATE persistence_requests r SET state='committed'")) groupCompletions++;
      return original.call(this, sql, ...rest);
    };
    try {
    await engine.setConfig('unbound_writes.policy', 'database_only').catch(() => undefined);
    const local = (params: Record<string, unknown>, operation = 'put_page', sourceId?: string) =>
      submitPageMutation({ ...ctx, ...(sourceId ? { sourceId } : {}) }, { operation, params: { request_id: randomUUID(), ...params }, waitMs: 30_000 });
    const remoteWriter = await registerLocalWriter(engine, 'stdio', { sourceIds: ['default'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['notes'] });
    const remote = (params: Record<string, unknown>) => withVerifiedLocalRegistration(engine, remoteWriter, () => dispatchToolCall(engine, 'put_page',
      { request_id: randomUUID(), wait_ms: 30_000, ...params }, { remote: true, config: ctx.config, sourceId: 'default',
        auth: { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes'] },
        logger: { info() {}, warn() {}, error() {} } }));
    await local({ slug: 'companies/acme-example', content: '---\ntitle: Acme Example\ntype: company\n---\n\nAcme Example builds tools.\n' });
    await local({ slug: 'people/alice-example', content: ALICE_V1 });
    const [alice] = await engine.executeRaw<{ revision: string }>("SELECT knowledge_revision::text AS revision FROM pages WHERE slug='people/alice-example'");
    await local({ slug: 'people/alice-example', content: ALICE_V2, expected_revision: alice!.revision });
    await local({ slug: 'people/carol-example', content: ALICE_V1.replaceAll('Alice', 'Carol') });
    await remote({ slug: 'notes/remote-note', content: '---\ntitle: Remote note\ntags: [inbox]\n---\n\nMentions Acme Example and [[people/alice-example]].\n' });
    await local({ slug: 'notes/doomed', content: '---\ntitle: Doomed\n---\n\nShort-lived page.\n' });
    const [doomed] = await engine.executeRaw<{ revision: string }>("SELECT knowledge_revision::text AS revision FROM pages WHERE slug='notes/doomed'");
    await local({ slug: 'notes/doomed', expected_revision: doomed!.revision }, 'delete_page');
    await local({ slug: 'notes/db-only', content: '---\ntitle: Database only\n---\n\nNo binding for this source.\n' }, 'put_page', 'scratch').catch(error => ({ refused: (error as { code?: string }).code }));
    await waitCommitted(engine);
    await disposePersistenceConsumer(engine);
    dump = await normalizedDump(engine, root);
    } finally { proto.executeRaw = original; }
  }, { databaseUrl, setup: async ({ engine }) => {
    await engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('scratch', 'scratch', '{}'::jsonb) ON CONFLICT (id) DO NOTHING");
  } });
  return { dump, groupCompletions };
}

const VOLATILE = /(^id$|_at$|^effective_date$|^valid_from$|^expected_hash$|^sequence$|knowledge_revision|text_projection_revision|^revision$|execution_token|_host_id$|^search_vector$|^embedding)/;
const ISO_TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)/g;
const PAGE_REF = /^(page_id|from_page_id|to_page_id|origin_page_id|event_page_id|target_page_id)$/;

async function normalizedDump(engine: BrainEngine, root: string): Promise<ParityDump> {
  const rows = async (sql: string) => (await engine.executeRaw<{ j: Record<string, unknown> }>(sql)).map(r => typeof r.j === 'string' ? JSON.parse(r.j) : r.j);
  const pages = await rows('SELECT row_to_json(p) AS j FROM pages p ORDER BY source_id,slug');
  const requests = await rows('SELECT row_to_json(r) AS j FROM persistence_requests r ORDER BY sequence');
  const names = new Map<string, string>();
  pages.forEach(p => names.set(`page:${p.id}`, `${p.source_id}/${p.slug}`));
  requests.forEach((r, i) => names.set(String(r.id), `request#${i}`));
  for (const w of await rows('SELECT row_to_json(w) AS j FROM persistence_local_writers w')) names.set(String(w.id), `writer:${w.lane}`);
  for (const w of await rows('SELECT row_to_json(w) AS j FROM persistence_worktrees w')) names.set(String(w.id), 'worktree');
  for (const s of await rows('SELECT row_to_json(s) AS j FROM sources s')) names.set(String(s.incarnation), `incarnation:${s.id}`);
  const normalize = (value: unknown, key = ''): unknown => {
    if (PAGE_REF.test(key) && (typeof value === 'number' || typeof value === 'string')) return names.get(`page:${value}`) ?? value;
    if (typeof value === 'string') {
      const named = names.get(value);
      if (named) return named;
      return value.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, id => names.get(id) ?? 'uuid').replace(ISO_TIME, 'time');
    }
    if (Array.isArray(value)) return value.map(item => normalize(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !VOLATILE.test(k)).map(([k, v]) => [k, normalize(v, k)]));
    return value;
  };
  const table = async (name: string) => (await rows(`SELECT row_to_json(t) AS j FROM ${name} t`)).map(r => normalize(r))
    .map(r => JSON.stringify(r)).sort().map(r => JSON.parse(r));
  const files: Record<string, string> = {};
  const walk = (dir: string) => { for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry.startsWith('.')) continue;
    if (statSync(path).isDirectory()) walk(path); else files[relative(root, path)] = readFileSync(path, 'utf8').replace(ISO_TIME, 'time');
  } };
  if (existsSync(root)) walk(root);
  return {
    pages: pages.map(p => normalize(p)),
    requests: requests.map(r => normalize({ operation: r.operation, slug: r.slug, source_id: r.source_id, state: r.state, error_code: r.error_code,
      blocked_reason: r.blocked_reason, outcome: r.outcome, intent: r.intent, authority: r.authority, publication_started: r.publication_started,
      recovery: r.recovery, recovery_bytes: r.recovery_bytes, intent_bytes: r.intent_bytes, terminal_reservation: r.terminal_reservation, worktree_id: r.worktree_id })),
    effects: (await rows('SELECT row_to_json(e) AS j FROM persistence_effects e ORDER BY id')).map(e => normalize({ request_id: e.request_id, kind: e.kind, data: e.data, source_id: e.source_id, worktree_id: e.worktree_id }))
      .map(e => JSON.stringify(e)).sort().map(e => JSON.parse(e)),
    counters: (await rows('SELECT row_to_json(c) AS j FROM persistence_counters c')).map(c => normalize(c)).map(c => JSON.stringify(c)).sort(),
    content_chunks: await table('content_chunks'), page_aliases: await table('page_aliases'), tags: await table('tags'),
    timeline_entries: await table('timeline_entries'), facts: await table('facts'), takes: await table('takes'),
    links: await table('links'), wanted_links: await table('wanted_links'), link_transitions: await table('link_transitions'),
    page_versions: await table('page_versions'), files,
  };
}

/** Runs the scenario with the fast-path switches off, then on, and requires identical dumps. */
export async function expectSingleWriteParity(databaseUrl?: string): Promise<void> {
  const run = (value: string) => withEnv({ GBRAIN_SINGLE_WRITE_GROUP: value, GBRAIN_PREADMIT_CACHE: value }, async () => {
    resetWriteSwitches();
    try { return await runSingleWriteParityScenario(databaseUrl); } finally { resetWriteSwitches(); }
  });
  const { dump: before, groupCompletions: offGroups } = await run('0');
  const { dump: after, groupCompletions: onGroups } = await run('1');
  // Off: every single write takes publishMutation. On: Postgres publishes them as groups of one; PGLite keeps publishMutation.
  expect(offGroups).toBe(0);
  if (databaseUrl) expect(onGroups).toBeGreaterThanOrEqual(7); else expect(onGroups).toBe(0);
  expect((before.requests as Array<{ state: string }>).every(r => r.state === 'committed')).toBe(true);
  expect((before.effects as Array<{ kind: string }>).some(e => e.kind === 'links')).toBe(true);
  for (const table of ['facts', 'takes', 'timeline_entries', 'page_aliases', 'tags', 'wanted_links', 'links']) expect((before[table] as unknown[]).length).toBeGreaterThan(0);
  expect(Object.keys(before.files as object).length).toBeGreaterThan(0);
  for (const key of Object.keys(before)) expect({ [key]: after[key] }).toEqual({ [key]: before[key] });
}
