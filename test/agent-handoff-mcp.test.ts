/**
 * Agent handoff end to end over real MCP stdio sessions (SDK client against a
 * spawned `gbrain serve`) on a hermetic keyless PGLite brain.
 *
 * Journey: "grok-bot" logs turns on the "12 Oak St listing deck" thread and
 * delegates the deck to "claude", then disconnects. In a second session
 * "claude" heartbeats, sees the task in its inbox, claims it, picks up the
 * thread, logs a turn and completes it; the thread history reads
 * grok-bot -> claude. A starter-surface session (what new stdio registrations
 * pin) reaches the handoff tools after request_tools widens it, as the
 * activation prompt in docs/agent-handoff.md tells it to.
 *
 * Protects the tool contract every agent app sees: names, argument shapes,
 * result shapes and the handoff across two separate connections. A handoff
 * page written with an undeclared page type would also show up here as a
 * page_type_undeclared line on serve's stderr.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { keylessBrainEnv } from './helpers/provider-env.ts';

let home: string;
let env: Record<string, string>;

function cli(args: string[]) {
  return spawnSync('bun', ['--no-env-file', 'run', 'src/cli.ts', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
}

interface Session { client: Client; stderr: () => string; close: () => Promise<void> }

async function session(args: string[] = []): Promise<Session> {
  const transport = new StdioClientTransport({
    command: 'bun', args: ['--no-env-file', 'run', 'src/cli.ts', 'serve', ...args], cwd: process.cwd(), env, stderr: 'pipe',
  });
  let err = '';
  transport.stderr?.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
  const client = new Client({ name: 'gbrain-agent-handoff-e2e', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return { client, stderr: () => err, close: async () => { await client.close().catch(() => {}); await transport.close().catch(() => {}); } };
}

async function tool(s: Session, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await s.client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> };
  const body = JSON.parse(res.content[0]!.text) as Record<string, any>;
  if (res.isError) throw new Error(`${name} failed: ${res.content[0]!.text.slice(0, 400)}`);
  return body;
}

const HANDOFF_TOOLS = ['log_turn', 'update_thread_summary', 'checkpoint', 'find_thread', 'pickup', 'register_agent', 'heartbeat', 'delegate',
  'inbox', 'claim_task', 'complete_task', 'release_task', 'fan_out', 'pick_result', 'route', 'routing_stats'];

beforeAll(() => {
  // realpath: on macOS tmpdir() sits under the /var symlink, which init refuses as a content root.
  home = mkdtempSync(join(realpathSync(tmpdir()), 'gbrain-agent-handoff-mcp-'));
  env = keylessBrainEnv(process.env, home, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined,
    GBRAIN_SURFACE: undefined, GBRAIN_MCP_FORCE_SURFACE: undefined, GBRAIN_NO_ONBOARD_NUDGE: '1' });
  delete env.GBRAIN_SOURCE;
  expect(cli(['init', '--pglite', '--no-embedding', '--non-interactive']).status).toBe(0);
}, 120_000);

afterAll(() => { if (home) rmSync(home, { recursive: true, force: true }); });

describe('agent handoff over MCP stdio', () => {
  test('grok-bot logs and delegates; claude heartbeats, claims, picks up and completes; history shows grok-bot -> claude', async () => {
    const grok = await session();
    let taskId: string;
    try {
      const listed = (await grok.client.listTools()).tools.map(t => t.name);
      for (const name of HANDOFF_TOOLS) expect(listed).toContain(name);

      await tool(grok, 'put_page', { slug: 'properties/12-oak-st', content: '---\ntype: note\ntitle: 12 Oak St\n---\n# 12 Oak St\n\nThree-bed listing.\n' });
      const t1 = await tool(grok, 'log_turn', { agent: 'grok-bot', model: 'grok-4', title: '12 Oak St listing deck', summary: 'Drafted the deck outline.',
        decisions: ['Use the blue template'], open_questions: ['Which comps?'], entities: ['properties/12-oak-st'] });
      expect(t1).toMatchObject({ thread_id: '12-oak-st-listing-deck', created: true, turn: 1, linked: ['properties/12-oak-st'] });
      await tool(grok, 'log_turn', { agent: 'grok-bot', thread_id: '12-oak-st-listing-deck', summary: 'Picked three comps within 1km.',
        decisions: ['Three comps'], open_questions: [], next_up: 'Build the 10 slides' });
      const d = await tool(grok, 'delegate', { from_agent: 'grok-bot', to_agent: 'claude', title: 'Build the 12 Oak St deck',
        instructions: 'Build 10 slides from the outline and comps on the thread.', thread_id: '12-oak-st-listing-deck', context: ['properties/12-oak-st'] });
      expect(d).toMatchObject({ to_agent: 'claude', thread: 'threads/12-oak-st-listing-deck', thread_noted: true });
      taskId = d.task_id as string;
      expect(grok.stderr()).not.toContain('page_type_undeclared');
    } finally {
      await grok.close();
    }

    const claude = await session();
    try {
      const hb = await tool(claude, 'heartbeat', { name: 'claude', model: 'claude-opus-5-5' });
      expect(hb).toMatchObject({ agent: 'claude', created: true, inbox_open: 1 });
      const box = await tool(claude, 'inbox', { agent: 'claude' });
      expect(box.open).toHaveLength(1);
      expect(box.open[0]).toMatchObject({ task_id: taskId, from_agent: 'grok-bot', status: 'open',
        ask_user: 'Delegated from grok-bot: Build the 12 Oak St deck. Want me to take it?' });
      const claim = await tool(claude, 'claim_task', { task_id: taskId, agent: 'claude' });
      expect(claim.task).toMatchObject({ status: 'claimed', claimed_by: 'claude', attempts: 1,
        instructions: 'Build 10 slides from the outline and comps on the thread.', thread: 'threads/12-oak-st-listing-deck' });
      const packet = await tool(claude, 'pickup', { thread_id: '12-oak-st-listing-deck', agent: 'claude', model: 'claude-opus-5-5' });
      expect(packet).toMatchObject({ history: 'grok-bot -> claude', summary: 'Drafted the deck outline.', next_up: 'Build the 10 slides',
        decisions: ['Use the blue template', 'Three comps'], open_questions: [] });
      expect(packet.linked_pages).toContainEqual(expect.objectContaining({ slug: 'properties/12-oak-st', title: '12 Oak St', exists: true }));
      expect(packet.delegations).toEqual([expect.objectContaining({ task_id: taskId, status: 'claimed', claimed_by: 'claude' })]);
      await tool(claude, 'log_turn', { agent: 'claude', model: 'claude-opus-5-5', thread_id: '12-oak-st-listing-deck', summary: 'Built the 10-slide deck.' });
      const done = await tool(claude, 'complete_task', { task_id: taskId, agent: 'claude', result: 'Deck at decks/12-oak-st.', files: ['decks/12-oak-st'] });
      expect(done).toMatchObject({ status: 'done', thread_noted: true });

      const after = await tool(claude, 'pickup', { thread_id: '12-oak-st-listing-deck' });
      expect(after.history).toBe('grok-bot -> claude');
      expect(after.last_turns.map((t: any) => [t.agent, t.kind])).toEqual([
        ['grok-bot', 'turn'], ['grok-bot', 'turn'], ['grok-bot', 'delegate'], ['claude', 'turn'], ['claude', 'complete']]);
      expect((await tool(claude, 'inbox', { agent: 'claude' })).open).toEqual([]);
      const found = await tool(claude, 'find_thread', { query: '12 Oak St listing deck', agent: 'grok-bot' });
      expect(found.matches[0]).toMatchObject({ thread_id: '12-oak-st-listing-deck', history: 'grok-bot -> claude' });
      expect(claude.stderr()).not.toContain('page_type_undeclared');
    } finally {
      await claude.close();
    }
  }, 120_000);

  test('a starter-surface session reaches the handoff tools after request_tools widens it', async () => {
    const s = await session(['--surface', 'starter']);
    try {
      expect((await s.client.listTools()).tools.map(t => t.name)).not.toContain('heartbeat');
      const widened = await tool(s, 'request_tools', { surface: 'full' });
      expect(widened).toMatchObject({ surface: 'full', persisted: false });
      expect((await tool(s, 'heartbeat', { name: 'chatgpt', model: 'gpt-5' })).agent).toBe('chatgpt');
    } finally {
      await s.close();
    }
  }, 60_000);
});
