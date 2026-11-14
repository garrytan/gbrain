/**
 * #9213 sweep fixture: every mutating op of the registry, classified as one that loads the page it targets (PAGE_OPS,
 * with the call that drives it) or one that loads none (NO_PAGE_TARGET, with the reason), and a repo-less brain with a
 * credential per binding (local CLI, unbound token, member-bound, owner-bound, attested actor) to run them under.
 * Used by test/large-pages/segmented-write-sweep.test.ts (below the 24 MiB ceiling) and
 * test/large-pages/segmented-write-sweep-over-ceiling.slow.test.ts.
 */
import { expect } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { OperationError, type AuthInfo, type OperationContext } from '../../src/core/ops/contract.ts';
import { __resetPrivateVisibilityCacheForTests } from '../../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { setOwner } from '../../src/core/access/owner.ts';
import { linkMember } from '../../src/core/access/actor.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import type { TestBackend } from './test-backends.ts';
import { isolatedPersistencePostgres } from './persistence-postgres.ts';

export const SRC = 'source-a';
export const OWNER = 'carol-example';
export const OTHER = 'companies/globex-example';
const QM_ALICE = 'U0ALICE';
const MEMORY_OPS = ['forget', 'forget_fact', 'get_write_request', 'memory_propose', 'memory_recall', 'memory_write', 'remember'];
const DIMS = 1536;
const WRITE_WAIT_MS = 60_000;
/** An upload part under the remote HTTP frame cap. */
const UPLOAD_PART_CHARS = 256 * 1024;
/** Lines of a body just over the 1 MiB inline bound: stored in segments, read back whole by a write that needs it. */
export const SEGMENTED_LINES = 16_000;

export type Who = 'local' | 'plain' | 'alice' | 'owner' | 'qm';
export type Call = { isError: boolean; text: string; json: Record<string, any>; dispatched: boolean };
export type Fixture = {
  call: (who: Who, op: string, params: Record<string, unknown>) => Promise<Call>;
  revision: (slug: string) => Promise<string>;
  localFact: (slug: string) => Promise<number>;
  localTake: (slug: string) => Promise<number>;
  versionId: (slug: string) => Promise<number>;
};
export interface Case {
  /** Bindings this op runs under; remote ones go through MCP dispatch with remote = true. */
  who: readonly Who[];
  /** The op's own call on page slug; setup reads and writes run locally. */
  run: (f: Fixture, slug: string, who: Who) => Promise<Call>;
  /** Replaces, deletes or restores the page: the over-ceiling pass gives it a page of its own. */
  replaces?: true;
  /** Why the over-ceiling pass does not run this op. */
  skipOver?: string;
}

const REMOTE: readonly Who[] = ['local', 'plain', 'alice', 'owner'];
const LOCAL: readonly Who[] = ['local'];
const MEMORY: readonly Who[] = ['local', 'plain', 'alice', 'owner', 'qm'];
const NO_FENCE_ROW = 'an over-ceiling page holds no facts or takes fence (its streamed import refuses one), so there is no row to target';
const op = (name: string, params: (f: Fixture, slug: string, who: Who) => Promise<Record<string, unknown>> | Record<string, unknown>) =>
  async (f: Fixture, slug: string, who: Who) => f.call(who, name, await params(f, slug, who));
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export function pageBody(lines: number, title: string, type = 'company'): string {
  const prose = Array.from({ length: lines }, (_, i) => 'Line ' + i + ' of a long note kept on the page so it is stored in segments.').join('\n');
  return '---\ntype: ' + type + '\ntitle: ' + title + '\n---\n# ' + title + '\n\n' + prose + '\n';
}

/** Every op whose handler loads a page it is pointed at (by slug, entity, target or a row on the page). */
export const PAGE_OPS: Record<string, Case> = {
  remember: { who: MEMORY, run: op('remember', (_f, slug) => ({ fact: 'Rule ' + randomUUID(), entity: slug, provenance: 'sweep' })) },
  forget: { who: MEMORY, skipOver: NO_FENCE_ROW, run: op('forget', async (f, slug) => ({ id: String(await f.localFact(slug)), reason: 'sweep' })) },
  forget_fact: { who: MEMORY, skipOver: NO_FENCE_ROW, run: op('forget_fact', async (f, slug) => ({ id: await f.localFact(slug), reason: 'sweep' })) },
  memory_propose: { who: ['qm'], run: op('memory_propose', (_f, slug) => ({ kind: 'timeline', target: slug, idempotency_key: randomUUID(), date: '2026-01-02', summary: 'Proposed ' + randomUUID() })) },
  put_page: { who: REMOTE, replaces: true, run: op('put_page', async (f, slug) => ({ slug, content: pageBody(SEGMENTED_LINES, 'Acme Example') + '\nOne more line.\n', expected_revision: await f.revision(slug) })) },
  put_pages: { who: REMOTE, replaces: true, run: op('put_pages', (_f, slug) => ({ pages: [{ slug, content: pageBody(SEGMENTED_LINES, 'Acme Example') + '\nOne more line.\n' }], request_id: randomUUID() })) },
  capture: { who: REMOTE, replaces: true, run: op('capture', async (f, slug) => ({ slug, content: pageBody(SEGMENTED_LINES, 'Acme Example') + '\nCaptured line.\n', expected_revision: await f.revision(slug) })) },
  begin_page_upload: { who: REMOTE, replaces: true, run: async (f, slug, who) => {
    const text = pageBody(SEGMENTED_LINES, 'Acme Example') + '\nUploaded line.\n';
    const begun = await f.call(who, 'begin_page_upload', { slug, mode: 'replace', total_bytes: Buffer.byteLength(text), sha256: sha(text), expected_revision: await f.revision(slug), request_id: randomUUID() });
    if (begun.isError) return begun;
    for (let at = 0, part = 0; at < text.length; at += UPLOAD_PART_CHARS, part++) {
      const piece = text.slice(at, at + UPLOAD_PART_CHARS);
      const sent = await f.call(who, 'upload_page_part', { upload_id: begun.json.upload_id, part, text: piece, part_sha256: sha(piece) });
      if (sent.isError) return sent;
    }
    return f.call(who, 'commit_page_upload', { upload_id: begun.json.upload_id });
  } },
  edit_page: { who: REMOTE, run: op('edit_page', async (f, slug, who) => {
    const line = 'Line ' + (100 + MEMORY.indexOf(who)) + ' of a long note';
    return { slug, expected_revision: await f.revision(slug), edits: [{ old_text: line, new_text: line + ', edited' }] };
  }) },
  append_page: { who: REMOTE, run: op('append_page', (_f, slug) => ({ slug, text: 'Appended ' + randomUUID() + '.', request_id: randomUUID() })) },
  add_tag: { who: REMOTE, run: op('add_tag', (_f, slug) => ({ slug, tag: 'sweep-tag' })) },
  remove_tag: { who: REMOTE, run: async (f, slug, who) => {
    await f.call('local', 'add_tag', { slug, tag: 'sweep-gone' });
    return f.call(who, 'remove_tag', { slug, tag: 'sweep-gone' });
  } },
  add_link: { who: REMOTE, run: op('add_link', (_f, slug) => ({ from: slug, to: OTHER, link_type: 'mentions' })) },
  remove_link: { who: REMOTE, run: async (f, slug, who) => {
    await f.call('local', 'add_link', { from: slug, to: OTHER, link_type: 'mentions' });
    return f.call(who, 'remove_link', { from: slug, to: OTHER, link_type: 'mentions' });
  } },
  add_timeline_entry: { who: REMOTE, run: op('add_timeline_entry', (_f, slug) => ({ slug, date: '2026-01-02', summary: 'Entry ' + randomUUID() })) },
  revert_version: { who: REMOTE, run: async (f, slug, who) => {
    await f.call('local', 'add_tag', { slug, tag: 'sweep-version-' + who });
    return f.call(who, 'revert_version', { slug, version_id: await f.versionId(slug), expected_revision: await f.revision(slug) });
  } },
  put_raw_data: { who: REMOTE, run: op('put_raw_data', (_f, slug) => ({ slug, source: 'sweep', data: { note: 'raw' } })) },
  ontology_propose: { who: REMOTE, run: op('ontology_propose', (_f, slug) => ({ entity: slug, dimension: 'industry', value: 'ledgers', visibility: 'world' })) },
  extract_entities: { who: REMOTE, run: op('extract_entities', (_f, slug) => ({ text: 'Globex Example met the team.', source_slug: slug })) },
  extract_facts: { who: REMOTE, run: op('extract_facts', (_f, slug) => ({ turn_text: 'Acme Example ships ledgers.', source_slug: slug, entity_hints: [slug], visibility: 'world' })) },
  takes_add: { who: REMOTE, run: op('takes_add', (_f, slug) => ({ slug, claim: 'Acme Example will grow ' + randomUUID(), kind: 'take', holder: 'world', weight: 0.6 })) },
  takes_update: { who: REMOTE, skipOver: NO_FENCE_ROW, run: async (f, slug, who) => f.call(who, 'takes_update', { slug, row_num: await f.localTake(slug), weight: 0.7 }) },
  takes_resolve: { who: REMOTE, skipOver: NO_FENCE_ROW, run: async (f, slug, who) => f.call(who, 'takes_resolve', { slug, row_num: await f.localTake(slug), quality: 'correct' }) },
  takes_supersede: { who: REMOTE, skipOver: NO_FENCE_ROW, run: async (f, slug, who) => f.call(who, 'takes_supersede', { slug, row_num: await f.localTake(slug), claim: 'Acme Example will grow faster ' + randomUUID() }) },
  takes_remove: { who: LOCAL, skipOver: NO_FENCE_ROW, run: async (f, slug, who) => f.call(who, 'takes_remove', { slug, row_num: await f.localTake(slug) }) },
  takes_rebuild: { who: LOCAL, run: op('takes_rebuild', (_f, slug) => ({ slug })) },
  confirm_memory: { who: REMOTE, run: op('confirm_memory', (_f, slug) => ({ ref: 'p:' + SRC + '/' + slug })) },
  extraction_review: { who: LOCAL, run: op('extraction_review', (_f, slug) => ({ action: 'distinct', slugs: [slug], of: OTHER })) },
  entity_identity_link: { who: LOCAL, run: op('entity_identity_link', (_f, slug) => ({ entity_id: 'acme-example', slug, source_id: SRC })) },
  delete_page: { who: REMOTE, replaces: true, run: op('delete_page', async (f, slug) => ({ slug, expected_revision: await f.revision(slug) })) },
  restore_page: { who: REMOTE, replaces: true, run: async (f, slug, who) => {
    await f.call('local', 'delete_page', { slug, expected_revision: await f.revision(slug) });
    return f.call(who, 'restore_page', { slug, expected_revision: await f.revision(slug) });
  } },
};

/** Mutating ops that never load an existing page as a Page object, with the reason; a new op must land in one list. */
export const NO_PAGE_TARGET: Record<string, string> = {
  purge_deleted_pages: 'bulk retention purge; its over-ceiling shared-origin case is pinned in segmented-write-sweep-over-ceiling.slow',
  upload_page_part: 'a part of an upload begin_page_upload opened (driven there)',
  commit_page_upload: 'commits an upload begin_page_upload opened (driven there)',
  abort_page_upload: 'drops an open upload; no page read',
  cancel_write_request: 'cancels a write request row',
  rate_answer: 'stores feedback on an answer; page slugs are recorded as text',
  put_skill: 'skill packs, not pages', delete_skill: 'skill packs, not pages', set_skill_policy: 'skill packs, not pages',
  prune_skill_revisions: 'skill packs, not pages', retain_skill_revision: 'skill packs, not pages', import_skill_proposal: 'skill packs, not pages',
  join_brain: 'brain membership', sync_brain_skills: 'brain membership', leave_brain: 'brain membership',
  sync_brain: 'repository sync; its segmented paths are pinned by the managed-sync segmented suites',
  log_ingest: 'appends an ingest log row; page slugs are text',
  file_upload: 'files row keyed by page slug; the page id is read by SQL, no Page object',
  file_register: 'files row keyed by page slug; the page id is read by SQL, no Page object',
  submit_job: 'job queue', cancel_job: 'job queue', retry_job: 'job queue', pause_job: 'job queue', resume_job: 'job queue',
  replay_job: 'job queue', send_job_message: 'job queue', submit_agent: 'job queue', watch_job: 'job queue', unwatch: 'job queue',
  think: 'creates its own answer page; it reads pages as search results, not snapshots',
  sources_add: 'source registry', sources_remove: 'source registry',
  request_tools: 'tool surface request', connector_sync: 'connector pages it creates; its segmented holds are pinned by connector-segmented-page-9062',
  chronicle_backfill: 'admin backfill over search results',
  entity_identity_unlink: 'removes an identity row by entity id and slug; no page read',
  purge_fact: 'admin purge of fact rows; a segmented fence read is pinned by the withdrawal suites',
  unpurge_page: 'clears a purge tombstone; the page no longer exists',
  memory_write: 'writes only to the caller\'s member page or memory/scope; the segmented scope page is pinned in remember-segmented-entity-9213',
  set_memory_writeback: 'config', memory_conversation_mode: 'config', mute_notice: 'config',
  code_traversal_cache_clear: 'cache', migrate_embeddings: 'embeddings', schema_apply_mutations: 'schema pack',
  run_onboard: 'onboarding job', run_skillopt: 'skill optimizer',
  loops_close: 'open-loop rows', loops_mute: 'open-loop rows', loops_unmute: 'open-loop rows',
  questions_pin: 'pinned questions', questions_refresh: 'pinned questions', questions_unpin: 'pinned questions',
  storage_register: 'storage cards on the storage shelf, keyed by card id; a card (details capped at 64 KiB) is never segmented',
  storage_update: 'storage cards on the storage shelf, keyed by card id; a card (details capped at 64 KiB) is never segmented',
};

/** segmentedRevertRefusal's message (src/core/page-state/versions.ts). */
const REVERT_REFUSAL = 'is stored in segments, so revert_version cannot restore it yet';

export type Outcome = { op: string; who: Who; segmented: boolean; getter: boolean; ceiling: boolean; readFix: boolean; dispatched: boolean; error: string | null };
export function outcome(name: string, who: Who, out: Call): Outcome {
  return {
    op: name, who, dispatched: out.dispatched,
    segmented: out.text.includes('page_body_segmented'),
    getter: /\.(compiled_truth|timeline|content): page .* stores its body in segments, and this path reads or writes the whole body as one string/.test(out.text),
    ceiling: out.text.includes('24 MiB') || out.text.includes(String(PAGE_MAX_BYTES)) || out.text.includes(REVERT_REFUSAL),
    readFix: out.json.fix?.mcp?.tool === 'get_page',
    error: out.isError ? String(out.json.code ?? out.json.error ?? out.text.slice(0, 160)) : null,
  };
}

export interface SweepBrain extends Fixture { engine: BrainEngine; storage: (slug: string) => Promise<{ body_storage: string; body_bytes: number; deleted: boolean } | undefined>; close: () => Promise<void> }

/** A repo-less brain in source-a with the owner, a member, a linked attested actor and one credential per binding. */
export async function openSweepBrain(kind: TestBackend): Promise<SweepBrain> {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => Array.from({ length: DIMS }, (_, i) => (i === 0 ? 1 : 0))) })) as never);
  let engine: BrainEngine;
  let closeEngine: () => Promise<void>;
  if (kind === 'postgres') ({ engine, close: closeEngine } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
  else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); closeEngine = () => engine.disconnect(); }
  __resetPrivateVisibilityCacheForTests();
  const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
  for (const id of [OWNER, 'alice-example']) await addMember(engine, id);
  await setOwner(engine, OWNER);
  await linkMember(engine, 'alice-example', 'qm', QM_ALICE);
  await importFromContent(engine, OTHER, '---\ntype: company\ntitle: Globex Example\n---\n# Globex Example\n\nGlobex example runs a pilot.\n', { sourceId: SRC });
  const tokens: Partial<Record<Who, string>> = {};
  const bindings: Record<Exclude<Who, 'local'>, Parameters<typeof bindCredential>[2] | null> = {
    owner: { member: OWNER }, alice: { member: 'alice-example' }, plain: null, qm: { attestActor: 'qm', attestOps: MEMORY_OPS },
  };
  for (const [name, binding] of Object.entries(bindings) as Array<[Exclude<Who, 'local'>, Parameters<typeof bindCredential>[2] | null]>) {
    const c = await provider().registerClientManual('sweep-' + name + '-' + randomUUID().slice(0, 8), ['client_credentials'],
      name === 'owner' ? 'read write memory_confirm' : 'read write', [], SRC);
    if (binding) await bindCredential(engine, { kind: 'client', id: c.clientId }, binding);
    tokens[name] = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
  }
  const parse = (text: string) => { try { return JSON.parse(text) as Record<string, any>; } catch { return {}; } };
  async function call(who: Who, name: string, params: Record<string, unknown>): Promise<Call> {
    if (who === 'local' && operationsByName[name]?.localOnly) {
      // A local-only op is not on the MCP surface: run its handler as the trusted CLI does.
      const ctx: OperationContext = { engine, config: { engine: engine.kind, embedding_disabled: true } as never, sourceId: SRC, remote: false, dryRun: false,
        logger: { info() {}, warn() {}, error() {} }, writeWaitMs: WRITE_WAIT_MS };
      try {
        const text = JSON.stringify(await operationsByName[name]!.handler(ctx, { ...params }));
        return { isError: false, text, json: parse(text), dispatched: false };
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        const text = JSON.stringify({ ...error.toJSON(), message: error.message });
        return { isError: true, text, json: parse(text), dispatched: false };
      }
    }
    const remote = who !== 'local';
    const auth = remote ? await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo : undefined;
    const out = await dispatchToolCall(engine, name, { ...params }, remote
      ? { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'], writeWaitMs: WRITE_WAIT_MS, ...(who === 'qm' ? { actor: { header: QM_ALICE } } : {}) }
      : { remote: false, sourceId: SRC, writeWaitMs: WRITE_WAIT_MS });
    return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n'), json: parse(out.content[0]?.text ?? ''), dispatched: true };
  }
  const revision = async (slug: string) => (await engine.executeRaw<{ r: string }>('SELECT knowledge_revision::text AS r FROM pages WHERE source_id = $1 AND slug = $2', [SRC, slug]))[0]!.r;
  return {
    engine, call, revision,
    localFact: async slug => {
      const out = await call('local', 'remember', { fact: 'Sweep fact ' + randomUUID(), entity: slug, provenance: 'sweep', visibility: 'world' });
      expect({ setup: 'remember', isError: out.isError }).toEqual({ setup: 'remember', isError: false });
      return Number(out.json.id);
    },
    localTake: async slug => {
      const out = await call('local', 'takes_add', { slug, claim: 'Acme Example will grow ' + randomUUID(), kind: 'take', holder: 'world', weight: 0.5 });
      expect({ setup: 'takes_add', isError: out.isError }).toEqual({ setup: 'takes_add', isError: false });
      return Number((await engine.executeRaw<{ n: number }>(
        'SELECT max(t.row_num) AS n FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.source_id = $1 AND p.slug = $2', [SRC, slug]))[0]!.n);
    },
    versionId: async slug => Number((await engine.executeRaw<{ id: number }>(
      'SELECT v.id FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.source_id = $1 AND p.slug = $2 ORDER BY v.id DESC LIMIT 1', [SRC, slug]))[0]?.id ?? 0),
    storage: async slug => {
      const [row] = await engine.executeRaw<{ body_storage: string; body_bytes: string | null; deleted: boolean }>(
        'SELECT body_storage, body_bytes::text AS body_bytes, deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id = $1 AND slug = $2', [SRC, slug]);
      return row && { body_storage: row.body_storage, body_bytes: Number(row.body_bytes ?? 0), deleted: row.deleted === true };
    },
    close: async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await disposePersistenceConsumer(engine).catch(() => undefined);
      await closeEngine();
    },
  };
}
