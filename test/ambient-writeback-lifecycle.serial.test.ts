/**
 * Ambient-writeback hermetic lifecycle (the brief's 5-step fixture) — ZERO
 * LLM, temp-everything, never touches a real brain (bunfig preload guards +
 * explicit temp GBRAIN_HOME/HOME here):
 *
 *   1. init a fresh personal PGLite brain → the one-time consent ask fires
 *      ([AGENT] block) — then the operator-relayed enable (config set).
 *   2. A stdio MCP session receives the ambient instructions; the scripted
 *      "agent" obeys them: remember("prefers dark mode…") with provenance
 *      → inserted, durable (valid_until NULL).
 *   3. A FRESH session recalls it, provenance intact.
 *   4. "Thanks" through the Stop hook produces no memory (no wb file, no
 *      fact rows).
 *   5. "mild cough" gets ttl 3d → valid_until ≈ +3d; backdating it makes
 *      active reads exclude it IMMEDIATELY (read-time validity — no sweep).
 *
 *   Plus: the managed instruction block is idempotent (splice twice ⇒
 *   byte-identical) — the full bootstrap-harness lifecycle is pinned in
 *   test/bootstrap-harness.serial.test.ts.
 *
 * The "agent" is this test following the served contract — deterministic
 * proof of the wiring; the auth-gated real-Codex door test (non-gating
 * evidence) covers live behavior outside CI.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runHook } from '../src/commands/hook.ts';
import {
  installAmbientWritebackBlockAt,
  renderAmbientInstructionBlock,
} from '../src/core/bootstrap/instructions-block.ts';
import { withEnv } from './helpers/with-env.ts';

const REPO = join(import.meta.dir, '..');
let parent: string;      // GBRAIN_HOME parent
let homeDir: string;     // fake HOME
let dataDir: string;     // pglite data dir (from init)

function childEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    GBRAIN_HOME: parent,
    HOME: homeDir,
    DATABASE_URL: undefined,
    GBRAIN_DATABASE_URL: undefined,
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_NO_SKILL_NAG: '1',
  } as Record<string, string | undefined>;
}

/** One stdio MCP session against `gbrain serve` (ndjson JSON-RPC). */
class StdioSession {
  private child: ChildProcess;
  private buf = '';
  private pending = new Map<number, (msg: Record<string, unknown>) => void>();
  initialize?: Record<string, unknown>;

  constructor() {
    this.child = spawn('bun', ['run', join(REPO, 'src/cli.ts'), 'serve'], {
      env: childEnv() as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout!.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8');
      let idx: number;
      while ((idx = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          const id = msg.id as number | undefined;
          if (id !== undefined && this.pending.has(id)) {
            this.pending.get(id)!(msg);
            this.pending.delete(id);
          }
        } catch { /* non-JSON serve chatter */ }
      }
    });
  }

  private send(msg: Record<string, unknown>): void {
    this.child.stdin!.write(JSON.stringify(msg) + '\n');
  }

  request(id: number, method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`rpc ${id} (${method}) timed out`)), timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async start(): Promise<void> {
    const init = await this.request(1, 'initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'wb-fixture', version: '1' },
    });
    this.initialize = init.result as Record<string, unknown>;
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async call(id: number, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.request(id, 'tools/call', { name, arguments: args });
    const result = res.result as { content?: Array<{ text?: string }> } | undefined;
    const text = result?.content?.[0]?.text;
    if (!text) throw new Error(`no content from ${name}: ${JSON.stringify(res).slice(0, 400)}`);
    return JSON.parse(text) as Record<string, unknown>;
  }

  async stop(): Promise<void> {
    this.child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { this.child.kill('SIGKILL'); resolve(); }, 4000);
      this.child.once('exit', () => { clearTimeout(t); resolve(); });
    });
    // PGLite single-writer: give the lock a beat to release.
    await new Promise((r) => setTimeout(r, 300));
  }
}

beforeAll(() => {
  parent = mkdtempSync(join(tmpdir(), 'gb-wb-e2e-'));
  homeDir = mkdtempSync(join(tmpdir(), 'gb-wb-home-'));
}, 20_000);

afterAll(() => {
  rmSync(parent, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

describe('ambient writeback — hermetic 5-step lifecycle', () => {
  test('the whole story', async () => {
    // ── 1. Fresh personal brain: init fires the one-time consent ask. ──────
    const initOut = execFileSync('bun', ['run', join(REPO, 'src/cli.ts'), 'init', '--pglite', '--no-embedding', '--non-interactive'], {
      env: childEnv() as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 180_000,
    });
    expect(initOut).toContain('[AGENT] One-time ask');
    expect(initOut).toContain('gbrain config set memory.auto_writeback salient');

    // The ask fires ONCE: a second init pass over the same brain stays quiet
    // (sentinel stamped) — checked implicitly by step 2's config set instead
    // of re-running init (re-init prompts on an existing brain).

    // Operator said yes → the agent runs the enable (dual-plane write).
    const setOut = execFileSync('bun', ['run', join(REPO, 'src/cli.ts'), 'config', 'set', 'memory.auto_writeback', 'salient'], {
      env: childEnv() as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 120_000,
    });
    expect(setOut).toContain('file + db planes');
    const cfgRaw = JSON.parse(readFileSync(join(parent, '.gbrain', 'config.json'), 'utf8')) as {
      database_path?: string; memory?: { auto_writeback?: string };
    };
    expect(cfgRaw.memory?.auto_writeback).toBe('salient');
    dataDir = cfgRaw.database_path!;
    expect(dataDir).toBeTruthy();

    // Managed instruction block: idempotent splice (harness-lane invariant).
    const agentsPath = join(parent, 'codex-home', 'AGENTS.md');
    mkdirSync(join(parent, 'codex-home'), { recursive: true });
    const body = renderAmbientInstructionBlock({ mode: 'salient', transientTtl: '3d', visibility: 'world', serveUrl: 'http://127.0.0.1:0' });
    installAmbientWritebackBlockAt(agentsPath, body);
    const once = readFileSync(agentsPath, 'utf8');
    expect(once).toContain('gbrain:ambient-writeback:begin');
    installAmbientWritebackBlockAt(agentsPath, body);
    expect(readFileSync(agentsPath, 'utf8')).toBe(once);

    // ── 2. stdio session: instructions carry the contract; scripted agent obeys. ──
    const s1 = new StdioSession();
    try {
      await s1.start();
      const instructions = String(s1.initialize?.instructions ?? '');
      expect(instructions).toContain('Ambient memory writeback');
      expect(instructions).toContain('mode: salient');
      expect(instructions).toContain('ttl: "3d"');
      expect(instructions).toContain('not the public internet');

      const remembered = await s1.call(2, 'remember', {
        fact: 'prefers dark mode in every editor',
        kind: 'preference',
        entity: 'people/alice-example',
        provenance: 'codex session e2e-1, 2026-09-01',
        visibility: 'world',
      });
      expect(remembered.status).toBe('inserted');
      expect(remembered.valid_until).toBeNull(); // durable: no TTL (test bullet 5)
    } finally {
      await s1.stop();
    }

    // ── 3. FRESH session recalls it, provenance intact. ────────────────────
    const s2 = new StdioSession();
    let coughId: string;
    try {
      await s2.start();
      const recalled = await s2.call(3, 'recall', { entity: 'people/alice-example' }) as {
        facts?: Array<{ fact: string; provenance?: string }>;
      };
      const hit = (recalled.facts ?? []).find((f) => f.fact.includes('dark mode'));
      expect(hit).toBeTruthy();
      expect(hit!.provenance).toBe('codex session e2e-1, 2026-09-01');

      // ── 5a. Transient fact gets the configured TTL. ───────────────────────
      const cough = await s2.call(4, 'remember', {
        fact: 'has a mild cough today',
        kind: 'event',
        entity: 'people/alice-example',
        ttl: '3d',
        provenance: 'codex session e2e-2, 2026-09-01',
        visibility: 'world',
      }) as { id: string; status: string; valid_until: string | null };
      expect(cough.status).toBe('inserted');
      coughId = cough.id;
      const until = Date.parse(String(cough.valid_until));
      const expected = Date.now() + 3 * 24 * 60 * 60 * 1000;
      expect(Math.abs(until - expected)).toBeLessThan(60_000);
    } finally {
      await s2.stop();
    }

    // ── 4. "Thanks" produces no memory (Stop hook, zero LLM). ──────────────
    const projRoot = join(parent, 'projects-root');
    mkdirSync(projRoot, { recursive: true });
    const transcript = join(projRoot, 'sess.jsonl');
    writeFileSync(transcript, JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: 'Thanks' }, uuid: 'u-1', sessionId: 's-fix',
      timestamp: '2026-09-01T10:00:00.000Z',
    }) + '\n');
    await withEnv({ GBRAIN_HOME: parent, HOME: homeDir }, async () => {
      const code = await runHook(['stop'], {
        write: () => {}, transcriptRoot: projRoot,
        stdin: JSON.stringify({ session_id: 's-fix', transcript_path: transcript }),
      });
      expect(code).toBe(0);
    });
    const corpusDir = join(parent, '.gbrain', 'transcripts', 'corpus');
    const wbFiles = existsSync(corpusDir) ? readdirSync(corpusDir).filter((f) => f.includes('.wb-')) : [];
    expect(wbFiles).toEqual([]);

    // ── 5b. Backdate the cough → active reads exclude it IMMEDIATELY. ──────
    // (read-time validity: no sweep dependency; serves are stopped, so the
    // trusted local engine can hold the PGLite single-writer lock.)
    const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir });
    try {
      // Exactly the two facts the story wrote — "Thanks" added nothing.
      const all = await engine.executeRaw<{ n: number | string }>(`SELECT count(*)::int AS n FROM facts`);
      expect(Number(all[0].n)).toBe(2);

      await engine.executeRaw(`UPDATE facts SET valid_until = now() - interval '1 hour' WHERE id = $1`, [Number(coughId)]);
      const active = await engine.listFactsByEntity('default', 'people/alice-example', { activeOnly: true });
      const texts = active.map((f) => f.fact);
      expect(texts.some((t) => t.includes('dark mode'))).toBe(true);
      expect(texts.some((t) => t.includes('cough'))).toBe(false);
    } finally {
      await engine.disconnect();
    }

    // ── 6. OAuth lane (OV-A5/OV2-14): a write-scope token receives the
    // section; a READ-ONLY token gets the byte-identical base contract —
    // instructions must never order a call the token cannot make. ─────────
    const env = childEnv() as NodeJS.ProcessEnv;
    const rwOut = execFileSync('bun', ['run', join(REPO, 'src/cli.ts'), 'auth', 'create', 'wb-rw', '--scopes', 'read,write'], { env, encoding: 'utf8' });
    const roOut = execFileSync('bun', ['run', join(REPO, 'src/cli.ts'), 'auth', 'create', 'wb-ro', '--scopes', 'read'], { env, encoding: 'utf8' });
    const rwToken = (rwOut.match(/gbrain_[a-f0-9]{64}/) ?? [''])[0];
    const roToken = (roOut.match(/gbrain_[a-f0-9]{64}/) ?? [''])[0];
    expect(rwToken).toBeTruthy();
    expect(roToken).toBeTruthy();

    const PORT = 19753; // unique per suite (see bootstrap-harness-lifecycle's list)
    const httpServe = spawn('bun', ['run', join(REPO, 'src/cli.ts'), 'serve', '--http', '--bind', '127.0.0.1', '--port', String(PORT)], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const base = `http://127.0.0.1:${PORT}`;
      let healthy = false;
      for (let i = 0; i < 120 && !healthy; i++) {
        try {
          const r = await fetch(`${base}/health`);
          healthy = r.ok;
        } catch { /* booting */ }
        if (!healthy) await new Promise((r) => setTimeout(r, 500));
      }
      expect(healthy).toBe(true);

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      const initWith = async (token: string): Promise<string> => {
        const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        });
        const client = new Client({ name: 'wb-fixture-oauth', version: '1' }, { capabilities: {} });
        try {
          await client.connect(transport);
          return String(client.getInstructions() ?? '');
        } finally {
          try { await client.close(); } catch { /* best-effort */ }
        }
      };

      const rwInstructions = await initWith(rwToken);
      expect(rwInstructions).toContain('Ambient memory writeback');
      expect(rwInstructions).toContain('mode: salient');

      const roInstructions = await initWith(roToken);
      expect(roInstructions).not.toContain('Ambient memory writeback');
      expect(roInstructions).toContain('GBrain agent operating contract');
    } finally {
      httpServe.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { httpServe.kill('SIGKILL'); resolve(); }, 4000);
        httpServe.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
  }, 300_000);
});
