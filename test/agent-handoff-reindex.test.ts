/**
 * Agent handoff state is markdown-first: re-indexing from the markdown files
 * rebuilds threads, tasks, agents and routing state identically.
 *
 * Brain A has `sync.repo_path` set, so every handoff write publishes its
 * canonical file through the ordinary page write path. A full scenario runs
 * there (turns, checkpoint, delegate, claim, complete, release, fan_out,
 * pick_result, heartbeats, a routing page). Brain B starts empty and imports
 * only those files with the ordinary importer, then extracts their links the
 * way `gbrain sync` does after an import. Every handoff view (pickup
 * packets, inbox, routing_stats, route, parsed task and agent state) must be
 * equal on both, and each file must be exactly what its parsed state renders.
 *
 * Protects the "Postgres/PGLite is only the index" contract for handoff
 * state: a regression that keeps any of it only in the database (a lease, a
 * claim, a pick, a heartbeat, a turn) makes brain B differ.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { extractLinksForSlugs } from '../src/commands/extract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { parseAgent, parseTask, parseThread, renderAgent, renderTask, renderThread } from '../src/core/handoff/format.ts';
import { parseMarkdownHead } from '../src/core/markdown.ts';
import { __setHandoffClockForTests } from '../src/core/handoff/store.ts';

let a: PGLiteEngine;
let b: PGLiteEngine;
const repo = mkdtempSync(join(tmpdir(), 'gbrain-handoff-reindex-'));

beforeAll(async () => {
  a = new PGLiteEngine();
  await a.connect({});
  await a.initSchema();
  b = new PGLiteEngine();
  await b.connect({});
  await b.initSchema();
  await a.setConfig('sync.repo_path', repo);
}, 120_000);

afterAll(async () => {
  __setHandoffClockForTests(null);
  await disposePersistenceConsumer(a);
  await a.disconnect();
  await b.disconnect();
  rmSync(repo, { recursive: true, force: true });
});

const ctxFor = (engine: PGLiteEngine): OperationContext => ({
  engine: engine as never, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false,
} as unknown as OperationContext);
const call = async (engine: PGLiteEngine, name: string, params: Record<string, unknown>) =>
  await operationsByName[name]!.handler(ctxFor(engine), params) as Record<string, any>;

function markdownFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? markdownFiles(join(dir, e.name), `${prefix}${e.name}/`)
    : e.name.endsWith('.md') ? [`${prefix}${e.name}`] : []).sort();
}

async function views(engine: PGLiteEngine, threadIds: string[], agents: string[]) {
  const out: Record<string, unknown> = {};
  for (const id of threadIds) out[`pickup:${id}`] = await call(engine, 'pickup', { thread_id: id });
  for (const agent of agents) out[`inbox:${agent}`] = await call(engine, 'inbox', { agent, include_closed: true });
  out.stats = await call(engine, 'routing_stats', {});
  out.route = await call(engine, 'route', { tags: ['deck'] });
  out.find = await call(engine, 'find_thread', { query: '12 Oak St listing deck', agent: 'grok-bot' });
  return out;
}

test('importing the handoff markdown into an empty brain rebuilds every handoff view identically', async () => {
  let clock = Date.parse('2026-11-08T09:00:00Z');
  const tick = () => { clock += 60_000; };
  __setHandoffClockForTests(() => clock);

  // Entity and routing pages go through put_page too, so they reach the repo as files.
  await call(a, 'put_page', { slug: 'properties/12-oak-st', content: '---\ntype: property\ntitle: 12 Oak St\n---\n# 12 Oak St\n\nA listing.\n' });
  await call(a, 'put_page', { slug: 'routing', content: '---\ntype: note\nhandoff_type: routing\ntitle: Agent routing\nlive_window_minutes: 120\nrules:\n  - when:\n      tags: [deck]\n    prefer: [claude]\n    fallback: [chatgpt]\n---\n# Agent routing\n\nDeck work goes to claude first.\n' });
  for (const [name, model] of [['grok-bot', 'grok-4'], ['claude', 'claude-opus-5-5'], ['chatgpt', 'gpt-5']]) { await call(a, 'register_agent', { name, model, capabilities: ['decks'] }); tick(); }

  await call(a, 'log_turn', { agent: 'grok-bot', model: 'grok-4', title: '12 Oak St listing deck', summary: 'Outline drafted.',
    decisions: ['Blue template'], open_questions: ['Which comps?'], entities: ['properties/12-oak-st'] }); tick();
  await call(a, 'checkpoint', { thread_id: '12-oak-st-listing-deck', agent: 'grok-bot', next_up: 'Hand off slides', summary: 'Deck for 12 Oak St.' }); tick();
  const d = await call(a, 'delegate', { from_agent: 'grok-bot', to_agent: 'claude', title: 'Build the deck', instructions: 'Ten slides.',
    thread_id: '12-oak-st-listing-deck', context: ['properties/12-oak-st'], tags: ['deck'], priority: 'high', due: '2026-11-10' }); tick();
  await call(a, 'claim_task', { task_id: d.task_id, agent: 'claude' }); tick();
  await call(a, 'pickup', { thread_id: '12-oak-st-listing-deck', agent: 'claude', model: 'claude-opus-5-5' }); tick();
  await call(a, 'complete_task', { task_id: d.task_id, agent: 'claude', result: 'Deck at decks/12-oak-st.', files: ['decks/12-oak-st'] }); tick();
  const r = await call(a, 'delegate', { from_agent: 'claude', to_model: 'gpt-5', title: 'Proofread', instructions: 'Check typos.' }); tick();
  await call(a, 'claim_task', { task_id: r.task_id, agent: 'chatgpt' }); tick();
  await call(a, 'release_task', { task_id: r.task_id, agent: 'chatgpt', reason: 'No access to the deck file' }); tick();
  const fan = await call(a, 'fan_out', { from_agent: 'grok-bot', agents: ['claude', 'chatgpt'], title: 'Headline options', instructions: 'Three headlines.' }); tick();
  for (const t of fan.tasks) { await call(a, 'claim_task', { task_id: t.task_id, agent: t.to_agent }); tick(); await call(a, 'complete_task', { task_id: t.task_id, agent: t.to_agent, result: `${t.to_agent} headlines` }); tick(); }
  await call(a, 'pick_result', { task_id: fan.tasks[1].task_id }); tick();
  const open = await call(a, 'delegate', { from_agent: 'grok-bot', to_agent: 'claude', title: 'Leased and abandoned', instructions: 'x' }); tick();
  const abandoned = await call(a, 'claim_task', { task_id: open.task_id, agent: 'claude', lease_minutes: 5 }); tick();
  for (const name of ['grok-bot', 'claude', 'chatgpt']) { await call(a, 'heartbeat', { name }); tick(); }

  const files = markdownFiles(repo);
  expect(files.filter(f => f.startsWith('threads/'))).toEqual(['threads/12-oak-st-listing-deck.md', 'threads/headline-options.md']);
  expect(files.filter(f => f.startsWith('delegations/'))).toHaveLength(5);
  expect(files.filter(f => f.startsWith('agents/'))).toEqual(['agents/chatgpt.md', 'agents/claude.md', 'agents/grok-bot.md']);

  // Brain B: only the files, then the link extraction sync runs after an import.
  for (const file of files) {
    const res = await importFromFile(b, join(repo, file), file, { noEmbed: true });
    expect(res.error ?? null).toBeNull();
  }
  await extractLinksForSlugs(b, repo, files.map(f => f.replace(/\.md$/, '')), { sourceId: 'default' });

  const threadIds = ['12-oak-st-listing-deck', 'headline-options'];
  const agents = ['grok-bot', 'claude', 'chatgpt'];
  const before = await views(a, threadIds, agents);
  const after = await views(b, threadIds, agents);
  expect(after).toEqual(before);
  expect((before['pickup:12-oak-st-listing-deck'] as any).history).toBe('grok-bot -> claude');
  const deckTask = (after['inbox:claude'] as any).closed.find((t: any) => t.task_id === d.task_id);
  expect(deckTask).toMatchObject({ tags: ['deck'], priority: 'high', due: '2026-11-10', result: 'Deck at decks/12-oak-st.', files: ['decks/12-oak-st'] });
  expect((before.stats as any).agents.find((x: any) => x.agent === 'chatgpt')).toMatchObject({ released: 1, done: 1, fan_out: { wins: 1 } });
  // The abandoned claim and its lease are in the file: brain B sees the task held by claude
  // until the lease runs out, then open again, at the same moment as brain A.
  expect((await call(b, 'inbox', { agent: 'claude' })).claimed.map((t: any) => [t.task_id, t.lease_until]))
    .toEqual([[open.task_id, abandoned.task.lease_until]]);
  clock += 10 * 60_000;
  const lapsed = (await call(b, 'inbox', { agent: 'claude' })).open.map((t: any) => [t.task_id, t.lease_expired ?? false]);
  expect(lapsed).toContainEqual([open.task_id, true]);
  expect(lapsed).toEqual((await call(a, 'inbox', { agent: 'claude' })).open.map((t: any) => [t.task_id, t.lease_expired ?? false]));

  // Every handoff file is exactly what its parsed state renders (after the keys gbrain owns).
  for (const file of files.filter(f => /^(threads|delegations|agents)\//.test(f))) {
    const slug = file.replace(/\.md$/, '');
    const snap = await b.readPageSnapshot(slug, { sourceId: 'default' });
    const stored = { title: snap!.page.title, frontmatter: snap!.page.frontmatter, body: snap!.page.compiled_truth, tags: snap!.tags };
    const rendered = slug.startsWith('threads/') ? renderThread(parseThread(stored))
      : slug.startsWith('delegations/') ? renderTask(parseTask(stored)) : renderAgent(parseAgent(slug.slice('agents/'.length), stored));
    const raw = readFileSync(join(repo, file), 'utf8');
    const bodyOf = (text: string) => text.slice(text.indexOf('\n---\n') + 5).trim();
    expect(bodyOf(rendered)).toBe(bodyOf(raw));
    const fmOf = (text: string) => {
      const fm = { ...parseMarkdownHead(text).frontmatter };
      for (const key of ['source_kind', 'source_uri', 'ingested_via', 'ingested_at', 'trust_tier']) delete fm[key];
      return fm;
    };
    expect(fmOf(rendered)).toEqual(fmOf(raw));
  }
}, 120_000);
