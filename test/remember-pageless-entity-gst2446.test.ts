/**
 * GST-2446: `remember` on an entity slug that has no page.
 *
 * 1. Protects: a fact saved for an entity with no page is stored in the database alone, and the reply says so:
 *    it names no `page`, the batch item carries the same `persistence` and `write_through` as the single form, the
 *    skip reason is `entity_page_missing` wherever the source has a checkout (never `no_repo_configured`), and on a
 *    source whose pages are in Git one `entity_page_missing` notice asks the user whether to create the page
 *    (`next: ask_user`, with the `put_page` call that creates it).
 *    Once the page exists, the extract_facts fence step moves the fact into its Facts table and its file.
 * 2. Fails when: the reply names a page that does not exist, a batch hides where an item landed, a source with a
 *    checkout is told it has no repository, the caller is not told how to give the fact a file, the page is created
 *    without asking the user (`next: run`), or a brain with no
 *    Git repository (where the database is the record) is told to create one.
 * 3. Existing coverage: test/remember-share-gst2243.test.ts pins `page` for facts that do land on a page;
 *    test/pathological/b-7-facts-pageless-entity.test.ts covers re-homing page-less facts.
 * 4. Real seams: the coordinated write on PGLite and Postgres (DATABASE_URL), a managed checkout with and without
 *    Git, a source with no checkout, the operation handler as the local CLI calls it and MCP dispatch as a remote caller.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { operationsByName } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { fenceUnfencedFacts, planUnfencedFacts } from '../src/core/facts/unfenced-facts.ts';
import { formatRememberResult } from '../src/cli/remember-format.ts';
import { cliRenderContext, renderNotice } from '../src/core/agent-output.ts';
import { renderCliNotices } from '../src/core/agent-markers.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects, type ManagedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const PAGED = 'people/hana-example';
const PAGELESS = 'notes/kitchen-remodel';
const NOTICE = 'entity_page_missing';
const page = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\nNotes about ${title}.\n`;
const gitRepo = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };

interface Caller { ctx: OperationContext; notices: Notice[] }
const caller = (base: OperationContext): Caller => {
  const notices: Notice[] = [];
  return { notices, ctx: { ...base, emitNotice: n => { if (n) notices.push(n); } } };
};
const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const remember = (ctx: OperationContext, fact: string, entity: string) => call(ctx, 'remember', { fact, entity, provenance: 'chat 2026-11-11' });
const batch = (ctx: OperationContext) => call(ctx, 'remember', { provenance: 'chat 2026-11-11', items: [
  { fact: 'Hana Example cycles to work.', entity: PAGED }, { fact: 'The remodel budget is 40,000 USD.', entity: PAGELESS }] });
async function overMcp(engine: BrainEngine, params: Record<string, unknown>) {
  const out = await dispatchToolCall(engine, 'remember', { provenance: 'chat 2026-11-11', ...params }, { remote: true, transport: 'stdio', sourceId: 'default' });
  expect(out.isError).not.toBe(true);
  return { body: JSON.parse(out.content[0]!.text) as Record<string, any>, blocks: out.content.slice(1).map(block => block.text) };
}
const putPage = (ctx: OperationContext, slug: string, title: string) => call(ctx, 'put_page', { slug, content: page(title) });

for (const backend of testBackends()) describe(`[${backend}] remember on an entity with no page (GST-2446)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  /** A managed brain whose default source is a checkout: a Git repository (pages are committed) or a plain content folder. */
  const checkout = (kind: 'git' | 'folder', run: (brain: ManagedBrain) => Promise<void>) =>
    managedBrain(async brain => { await putPage(brain.ctx, PAGED, 'Hana Example'); await run(brain); }, { databaseUrl, ...(kind === 'git' ? { setup: gitRepo } : {}) });
  /** A brain whose source has no checkout at all: the database is the record. */
  async function noCheckout(run: (brain: { engine: BrainEngine; ctx: OperationContext }) => Promise<void>): Promise<void> {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      const ctx: OperationContext = { engine, config: { engine: engine.kind, embedding_disabled: true } as never, sourceId: 'default', remote: false, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } };
      await putPage(ctx, PAGED, 'Hana Example');
      await run({ engine, ctx });
    } finally { await disposePersistenceConsumer(engine); await close(); }
  }

  test('the reply names a page only when the fact is on one', () => checkout('git', async ({ engine, ctx }) => {
    const pageless = await remember(ctx, 'The kitchen remodel starts in March.', PAGELESS);
    expect(pageless).toMatchObject({ status: 'inserted', entity_slug: PAGELESS, visibility: 'world' });
    expect(pageless).not.toHaveProperty('page');
    expect(await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1', [PAGELESS])).toHaveLength(0);
    const paged = await remember(ctx, 'Hana Example prefers tea.', PAGED);
    expect(paged).toMatchObject({ status: 'inserted', page: PAGED });
    // A replay of that request names the page again.
    expect(await call(ctx, 'remember', { fact: 'Hana Example prefers tea.', entity: PAGED, provenance: 'chat 2026-11-11', request_id: paged.request_id })).toMatchObject({ page: PAGED });
    const { items } = await batch(ctx);
    expect(items[0]).toMatchObject({ status: 'inserted', entity_slug: PAGED, page: PAGED });
    expect(items[1]).toMatchObject({ status: 'inserted', entity_slug: PAGELESS });
    expect(items[1]).not.toHaveProperty('page');
    const mcp = await overMcp(engine, { fact: 'The remodel contractor is acme-example.', entity: PAGELESS });
    expect(mcp.body).toMatchObject({ status: 'inserted', entity_slug: PAGELESS });
    expect(mcp.body).not.toHaveProperty('page');
  }), 180_000);

  test('a batch item carries the same persistence and write_through as the single form', () => checkout('git', async ({ ctx }) => {
    const { items } = await batch(ctx);
    expect(items[0].persistence).toMatchObject({ mode: 'filesystem', file_written: true });
    expect(items[0].write_through).toEqual({ written: true });
    const single = await remember(ctx, 'The kitchen remodel starts in March.', PAGELESS);
    expect(items[1].persistence).toEqual(single.persistence);
    expect(items[1].write_through).toEqual(single.write_through);
    expect(items[1].persistence).toEqual({ mode: 'database' });
  }), 180_000);

  test('the skip reason says the entity has no page, in the reply, the batch and the receipt', () => checkout('git', async ({ ctx }) => {
    const single = await remember(ctx, 'The kitchen remodel starts in March.', PAGELESS);
    expect(single.write_through).toEqual({ written: false, skipped: NOTICE });
    expect((await batch(ctx)).items[1].write_through).toEqual({ written: false, skipped: NOTICE });
    const receipt = await call(ctx, 'get_write_request', { request_id: single.request_id });
    expect(receipt.outcome.write_through).toEqual({ written: false, skipped: NOTICE });
    expect(formatRememberResult(single)).toContain('note: the entity has no page, so this fact is stored in the database only');
    expect(formatRememberResult(await batch(ctx))).toContain(`entity: ${PAGELESS} (no page: database only)`);
  }), 180_000);

  test('on a Git checkout the reply says how to give the fact a file: one notice with the put_page call', () => checkout('git', async ({ engine, ctx }) => {
    const local = caller(ctx);
    const single = await remember(local.ctx, 'The kitchen remodel starts in March.', PAGELESS);
    const [notice] = local.notices.filter(n => n.code === NOTICE);
    expect(notice).toMatchObject({ kind: 'info', dedupe_key: `default\0${PAGELESS}` });
    expect(notice!.why).toContain(`${PAGELESS} has no page`);
    expect(notice!.why).toContain('database only');
    expect(notice!.user_message).toBe(`The fact is saved in the database only: ${PAGELESS} has no page, so it is in no file in Git. Should I create a page for ${PAGELESS}?`);
    expect(notice!.fix).toMatchObject({ ask_user: true, actor: 'agent', consent: [], argv: ['gbrain', 'put', PAGELESS],
      mcp: { tool: 'put_page', arguments: { slug: PAGELESS, content: '<content>' } }, inputs: [{ name: 'content' }],
      verify: { mcp: { tool: 'get_page', arguments: { slug: PAGELESS } } } });
    // On the CLI the [AGENT] block asks first and fences the question for the user.
    const agent = renderCliNotices([renderNotice(notice!, cliRenderContext())], { json: false, tty: false }).stdout!;
    expect(agent).toContain(`next: ask_user: gbrain put ${PAGELESS}`);
    expect(agent).toContain(`[SHOW USER]\n${notice!.user_message}\n[/SHOW USER]`);
    // A fact that lands on a page carries no such notice.
    const paged = caller(ctx);
    await remember(paged.ctx, 'Hana Example prefers tea.', PAGED);
    expect(paged.notices.map(n => n.code)).not.toContain(NOTICE);
    // A batch says it once per entity, and a replayed request says it again.
    const both = caller(ctx);
    await batch(both.ctx);
    expect(both.notices.filter(n => n.code === NOTICE)).toHaveLength(1);
    expect(both.notices.find(n => n.code === NOTICE)).toMatchObject({ user_message: expect.stringContaining('database only'), fix: { ask_user: true } });
    const replay = caller(ctx);
    await call(replay.ctx, 'remember', { fact: 'The kitchen remodel starts in March.', entity: PAGELESS, provenance: 'chat 2026-11-11', request_id: single.request_id });
    expect(replay.notices.filter(n => n.code === NOTICE)).toHaveLength(1);
    // Over MCP the notice is a text block after the body, with the call to make (shown once per entity per session, so this entity is new).
    const unseen = `notes/garden-plan-${randomUUID().slice(0, 8)}`;
    const mcp = await overMcp(engine, { fact: 'The garden plan adds two raised beds.', entity: unseen });
    const block = mcp.blocks.find(text => text.startsWith(`[gbrain notice ${NOTICE} kind=info]`));
    expect(block).toBeDefined();
    expect(block).toContain(`fix: put_page {"slug":"${unseen}","content":"<content>"}`);
    expect(block).toContain('next: ask_user');
    expect(block).toContain(`user_message: The fact is saved in the database only: ${unseen} has no page`);
    const inBatch = `notes/pond-plan-${randomUUID().slice(0, 8)}`;
    const mcpBatch = await overMcp(engine, { items: [{ fact: 'Hana Example keeps bees.', entity: PAGED }, { fact: 'The pond plan needs a liner.', entity: inBatch }] });
    expect(mcpBatch.body.items[1].write_through).toEqual({ written: false, skipped: NOTICE });
    const batchBlocks = mcpBatch.blocks.filter(text => text.startsWith(`[gbrain notice ${NOTICE} kind=info]`) && text.includes(inBatch));
    expect(batchBlocks).toHaveLength(1);
    expect(batchBlocks[0]).toContain('next: ask_user');
    expect(batchBlocks[0]).not.toContain('next: run');
  }), 180_000);

  test('once the page exists, the extract_facts fence step moves the fact into its Facts table and its file', () => checkout('git', async ({ engine, ctx, root }) => {
    const saved = await remember(ctx, 'The kitchen remodel starts in March.', PAGELESS);
    await putPage(ctx, PAGELESS, 'Kitchen remodel');
    const outcome = await fenceUnfencedFacts(engine, await planUnfencedFacts(engine, { sourceId: 'default' }));
    expect(outcome).toMatchObject({ fenced: 1, fenced_slugs: [PAGELESS], failed_pages: [] });
    const [fact] = await engine.executeRaw<{ row_num: number | null; source_markdown_slug: string | null; expired_at: unknown }>(
      'SELECT row_num, source_markdown_slug, expired_at FROM facts WHERE id=$1', [Number(saved.id)]);
    expect(fact).toMatchObject({ row_num: 1, source_markdown_slug: PAGELESS, expired_at: null });
    await settleManagedGitEffects(engine);
    expect(readFileSync(join(root, `${PAGELESS}.md`), 'utf8')).toContain('| 1 | The kitchen remodel starts in March. |');
    expect(git(root, 'show', `HEAD:${PAGELESS}.md`)).toContain('The kitchen remodel starts in March.');
  }), 180_000);

  test('a content folder with no Git: the reason is the missing page, and nothing says the fact is at risk', () => checkout('folder', async ({ engine, ctx }) => {
    const local = caller(ctx);
    const single = await remember(local.ctx, 'The kitchen remodel starts in March.', PAGELESS);
    expect(single).toMatchObject({ status: 'inserted', persistence: { mode: 'database' }, write_through: { written: false, skipped: NOTICE } });
    expect(single).not.toHaveProperty('page');
    const { items } = await batch(local.ctx);
    expect(items[1]).toMatchObject({ persistence: { mode: 'database' }, write_through: { written: false, skipped: NOTICE } });
    expect(items[1]).not.toHaveProperty('page');
    expect(local.notices.map(n => n.code)).not.toContain(NOTICE);
    const mcp = await overMcp(engine, { fact: 'The remodel contractor is acme-example.', entity: PAGELESS });
    expect(mcp.blocks.join('\n')).not.toContain(NOTICE);
    // Once the owner records that it commits this checkout's pages to Git, the reply says how to give the fact a file.
    await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled'");
    const durable = caller(ctx);
    await remember(durable.ctx, 'The remodel permit was filed in November.', PAGELESS);
    expect(durable.notices.filter(n => n.code === NOTICE)).toHaveLength(1);
  }), 180_000);

  test('a source with no checkout: the database is the record, so the reply asks for nothing', () => noCheckout(async ({ engine, ctx }) => {
    const local = caller(ctx);
    const single = await remember(local.ctx, 'The kitchen remodel starts in March.', PAGELESS);
    expect(single).toMatchObject({ status: 'inserted', persistence: { mode: 'database' }, write_through: { written: false, skipped: 'no_repo_configured' } });
    expect(single).not.toHaveProperty('page');
    expect(formatRememberResult(single)).not.toContain('no page');
    // A fact that lands on a database-only page still names it.
    expect(await remember(local.ctx, 'Hana Example prefers tea.', PAGED)).toMatchObject({ page: PAGED, persistence: { mode: 'database' } });
    const { items } = await batch(local.ctx);
    expect(items[0]).toMatchObject({ page: PAGED, persistence: { mode: 'database' }, write_through: { written: false, skipped: 'no_repo_configured' } });
    expect(items[1]).toMatchObject({ persistence: { mode: 'database' }, write_through: { written: false, skipped: 'no_repo_configured' } });
    expect(items[1]).not.toHaveProperty('page');
    expect(local.notices.map(n => n.code)).not.toContain(NOTICE);
    const mcp = await overMcp(engine, { fact: 'The remodel contractor is acme-example.', entity: PAGELESS });
    expect(mcp.body).not.toHaveProperty('page');
    expect(mcp.body.write_through).toEqual({ written: false, skipped: 'no_repo_configured' });
    expect(mcp.blocks.join('\n')).not.toContain(NOTICE);
    expect(mcp.blocks.join('\n')).not.toContain('put_page');
  }), 180_000);
});
