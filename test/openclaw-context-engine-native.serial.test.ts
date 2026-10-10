import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from '#postgres'
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const host = process.env.GBRAIN_TEST_OPENCLAW_BIN;
const root = resolve(import.meta.dir, '..');

describe.skipIf(!host)('pinned OpenClaw native context-engine startup', () => {
  test('loads the shipped plugin and injects the correct workspace into new conversations after restart', async () => {
    const databaseUrl = process.env.GBRAIN_TEST_OPENCLAW_DATABASE_URL;
    if (!databaseUrl) throw new Error('GBRAIN_TEST_OPENCLAW_DATABASE_URL must point to an isolated test Postgres');
    assertSafeE2eDatabaseUrl(databaseUrl);
    const database = `gbrain_openclaw_${crypto.randomUUID().replaceAll('-', '')}_test`;
    const fixtureUrl = new URL(databaseUrl);
    fixtureUrl.pathname = `/${database}`;
    const admin = postgres(databaseUrl, { max: 1 });
    const engine = new PostgresEngine();
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-openclaw-native-'));
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      const base = { id: 'fixture-response', object: 'chat.completion.chunk', created: 1, model: 'fixture' };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end([
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Local transport fixture completed.' }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}`,
        'data: [DONE]',
        '',
      ].join('\n\n'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const workspace = join(dir, 'workspace');
    const otherWorkspace = join(dir, 'other-workspace');
    const configPath = join(dir, 'openclaw.json');
    const env = {
      PATH: process.env.PATH ?? '',
      HOME: dir,
      TMPDIR: dir,
      GBRAIN_HOME: dir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: join(dir, '.openclaw'),
      GBRAIN_CI_DISABLE_TEST_ENV_FILE: '1',
    };
    async function run(args: string[]) {
      const child = Bun.spawn([host!, ...args], { env, cwd: otherWorkspace, stdout: 'pipe', stderr: 'pipe' });
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
      try {
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ]);
        expect({ code, stderr }).toEqual({ code: 0, stderr: expect.any(String) });
        expect(stderr).not.toContain('degraded to');
        return stdout;
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      await admin.unsafe(`CREATE DATABASE "${database}"`);
      await engine.connect({ database_url: fixtureUrl.toString() });
      await engine.initSchema();
      for (const [path, task] of [[workspace, 'correct-workspace-canary'], [otherWorkspace, 'wrong-workspace-canary']]) {
        mkdirSync(join(path, 'ops'), { recursive: true });
        writeFileSync(join(path, 'ops', 'tasks.md'), `## Today\n- [ ] ${task}\n`);
      }
      for (const [source, path, synopsis] of [['main-source', workspace, 'main-source-saved-page-canary'], ['other-source', otherWorkspace, 'other-source-saved-page-canary']]) {
        await engine.executeRaw('INSERT INTO sources (id, name, local_path) VALUES ($1, $1, $2)', [source, path]);
        await engine.executeRaw("INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline) VALUES ('people/alice-example', $1, 'person', 'Alice Example', $2, '')", [source, synopsis]);
      }
      await engine.executeRaw("INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline) VALUES ('people/earlier-example', 'main-source', 'person', 'Earlier Example', 'Historical entity only.', '')");
      mkdirSync(join(dir, '.gbrain'), { recursive: true });
      writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({
        engine: 'postgres', database_url: fixtureUrl.toString(),
        retrieval_reflex: true, retrieval_reflex_window_turns: 1, retrieval_reflex_volunteer: false,
      }));
      const manifest = JSON.parse(readFileSync(join(root, 'openclaw.plugin.json'), 'utf8'));
      writeFileSync(configPath, JSON.stringify({
        plugins: {
          allow: [manifest.id], load: { paths: [root] },
          entries: { [manifest.id]: { enabled: true } },
          slots: { contextEngine: manifest.id, memory: 'none' },
        },
        agents: {
          ownership: 'explicit',
          defaults: { workspace, model: { primary: 'fixture/fixture' }, skipBootstrap: true },
          entries: { main: { workspace }, other: { workspace: otherWorkspace } },
        },
        tools: { deny: ['*'] },
        mcp: { servers: { gbrain: { enabled: false } } },
        models: { mode: 'replace', providers: { fixture: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'local-fixture',
          models: [{ id: 'fixture', name: 'Fixture', contextWindow: 32768, maxTokens: 512, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
        } } },
        gateway: { mode: 'local' },
      }));
      expect(await run(['--version'])).toContain('2026.9.4');
      const inspection = JSON.parse(await run(['plugins', 'inspect', manifest.id, '--runtime', '--json']));
      expect(inspection.plugin.status).toBe('loaded');
      expect(inspection.plugin.imported).toBe(true);
      expect(inspection.plugin.activated).toBe(true);
      expect(inspection.plugin.kind).toBe('context-engine');
      expect(inspection.plugin.contextEngineIds).toEqual(['gbrain-context', manifest.id]);
      expect(inspection.diagnostics.filter((diagnostic: { level: string }) => diagnostic.level === 'error')).toEqual([]);
      await run(['config', 'validate']);
      for (const [session, prompt] of [
        ['fresh-conversation-one', 'Tell me about Earlier Example.'],
        ['fresh-conversation-one', 'Tell me about Alice Example.'],
        ['fresh-conversation-two', 'Tell me about Alice Example.'],
      ]) {
        await run(['agent', '--local', '--agent', 'main', '--session-key', `agent:main:${session}`, '--message', prompt, '--thinking', 'off', '--timeout', '60', '--json']);
      }
      await run(['agent', '--local', '--agent', 'other', '--session-key', 'agent:other:fresh-conversation', '--message', 'Tell me about Alice Example.', '--thinking', 'off', '--timeout', '60', '--json']);
      expect(requests).toHaveLength(4);
      for (const request of requests.slice(0, 3)) {
        const messages = JSON.stringify(request.messages);
        expect(messages).toContain('Live Context (deterministic, injected by gbrain-context engine)');
        expect(messages).toContain('correct-workspace-canary');
        expect(messages).not.toContain('wrong-workspace-canary');
      }
      expect(JSON.stringify(requests[0].messages)).toContain('people/earlier-example');
      for (const request of requests.slice(1, 3)) {
        const messages = JSON.stringify(request.messages);
        expect(messages).toContain('people/alice-example');
        expect(messages).toContain('main-source-saved-page-canary');
        expect(messages).not.toContain('other-source-saved-page-canary');
        expect(messages).not.toContain('people/earlier-example');
        expect(messages.split('Tell me about Alice Example.')).toHaveLength(2);
      }
      expect(JSON.stringify(requests[1].messages)).toContain('Tell me about Earlier Example.');
      expect(JSON.stringify(requests[2].messages)).not.toContain('Tell me about Earlier Example.');
      const otherMessages = JSON.stringify(requests[3].messages);
      expect(otherMessages).toContain('wrong-workspace-canary');
      expect(otherMessages).not.toContain('correct-workspace-canary');
      expect(otherMessages).toContain('people/alice-example');
      expect(otherMessages).toContain('other-source-saved-page-canary');
      expect(otherMessages).not.toContain('main-source-saved-page-canary');

      // #6316: a real host compaction (2026.9.x passes sessionTarget, no sessionFile) banks a segment.
      const gatewayPort = 20_000 + Math.floor(Math.random() * 20_000);
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      writeFileSync(configPath, JSON.stringify({ ...config, gateway: { mode: 'local', port: gatewayPort, bind: 'loopback', auth: { mode: 'none' } } }));
      const gateway = Bun.spawn([host!, 'gateway', 'run'], { env, cwd: otherWorkspace, stdout: 'pipe', stderr: 'pipe' });
      try {
        const reader = gateway.stdout.getReader();
        let gatewayLog = '';
        const readyBy = Date.now() + 60_000;
        while (!gatewayLog.includes('[gateway] ready') && Date.now() < readyBy) {
          const chunk = await Promise.race([reader.read(), Bun.sleep(1_000).then(() => null)]);
          if (chunk?.done) break;
          if (chunk?.value) gatewayLog += new TextDecoder().decode(chunk.value);
        }
        reader.releaseLock();
        expect(gatewayLog).toContain('[gateway] ready');
        const compacted = JSON.parse(await run(['sessions', 'compact', 'agent:main:fresh-conversation-one', '--agent', 'main', '--json', '--timeout', '60000']));
        expect(compacted).toMatchObject({ ok: true, compacted: true });
      } finally {
        gateway.kill();
        await gateway.exited;
      }
      const spool = join(dir, '.gbrain', 'transcripts', 'corpus', 'sourced');
      const segments = (existsSync(spool) ? readdirSync(spool) : []).filter((name) => name.includes('.seg-') && name.endsWith('.txt'));
      expect(segments).toHaveLength(1);
      expect(readFileSync(join(spool, segments[0]!), 'utf8')).toContain('Tell me about Alice Example.');
      const heartbeat = join(dir, '.gbrain', 'integrations', 'hooks', 'heartbeat.jsonl');
      const checkpoints = (existsSync(heartbeat) ? readFileSync(heartbeat, 'utf8').trim().split('\n') : [])
        .map((line) => JSON.parse(line)).filter((entry) => entry.event === 'openclaw-compact');
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].segment).not.toBe('skipped');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(dir, { recursive: true, force: true });
      await engine.disconnect();
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.end();
    }
  }, 240_000);
});
