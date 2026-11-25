/**
 * A real OpenClaw gateway in an isolated profile, for Tier 2 tests and the
 * skill-resolver bench: its own HOME, GBRAIN_HOME, OPENCLAW_STATE_DIR and
 * OPENCLAW_CONFIG_PATH under one temp directory, a loopback fake model that
 * records every request OpenClaw sends (keyless: no provider key is passed and
 * the provider points at 127.0.0.1), an `openclaw` wrapper on PATH that logs
 * every CLI call gbrain makes, and `openclaw agent` turns sent through the
 * running gateway.
 *
 * A loopback fake Telegram Bot API (startTelegram) lets a test drive real
 * channel turns through OpenClaw's own telegram plugin, DMs and groups, with
 * the sender it chooses; it records every Bot API call OpenClaw makes.
 *
 * The OpenClaw CLI comes from GBRAIN_TEST_OPENCLAW_SKILL_BIN, else `openclaw`
 * on PATH; null when neither exists.
 */
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pumpText, waitForText, type PumpedText } from './stream-text.ts';

export const REPO = resolve(import.meta.dir, '..', '..');

export function openclawBin(): string | null {
  const pinned = process.env.GBRAIN_TEST_OPENCLAW_SKILL_BIN?.trim();
  if (pinned) return pinned;
  return Bun.which('openclaw');
}

export interface ModelRequest { path: string; body: { messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function?: { name?: string } }> } }
export type ModelReply = { text: string } | { tool: string; args: unknown } | { status: number };
export interface TelegramUser { id: number; is_bot: false; first_name: string; username: string }
export interface TelegramMessage { chat: { id: number; type: 'private' | 'supergroup'; title?: string; first_name?: string }; from: TelegramUser; text: string; entities?: Array<{ type: string; offset: number; length: number }> }
export interface Ran { code: number; stdout: string; stderr: string; ms: number }

const contentText = (c: unknown): string => typeof c === 'string' ? c
  : Array.isArray(c) ? c.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('\n') : '';

/**
 * The text of the user message that carries this turn's prompt: OpenClaw joins appendContext to it, and
 * sends its runtime context as a separate user message after it.
 */
export function promptText(r: ModelRequest, prompt: string): string {
  const users = r.body.messages.filter((m) => m.role === 'user').map((m) => contentText(m.content));
  return users.filter((t) => t.includes(prompt)).at(-1) ?? '';
}
/** The system message, where appendSystemContext lands. */
export function systemText(r: ModelRequest): string {
  return r.body.messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => contentText(m.content)).join('\n');
}
/** Skill ids in a <relevant_skills> or <pinned_skills> block of a text, or null when the block is absent. */
export function blockIds(text: string, tag: 'relevant_skills' | 'pinned_skills'): string[] | null {
  const m = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(text);
  return m ? [...m[1]!.matchAll(/- id: "([^"]+)"/g)].map((x) => x[1]!) : null;
}

export class RealOpenclaw {
  readonly dir: string;
  readonly bin: string;
  readonly env: Record<string, string>;
  readonly calls: string;
  readonly workspace: string;
  readonly requests: ModelRequest[] = [];
  readonly replies: ModelReply[] = [];
  readonly telegramCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
  private server: Server | null = null;
  private telegram: Server | null = null;
  private inbox: TelegramMessage[] = [];
  private updateId = 1000;
  private messageId = 1;
  private gateway: { proc: ReturnType<typeof Bun.spawn>; out: PumpedText; err: PumpedText; grouped: boolean } | null = null;
  gatewayPort = 0;

  constructor(bin: string, label: string) {
    this.bin = realpathSync(bin);
    this.dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-oc-' + label + '-')));
    this.workspace = join(this.dir, 'workspace');
    mkdirSync(join(this.workspace, 'skills'), { recursive: true });
    const binDir = join(this.dir, 'bin');
    mkdirSync(binDir);
    this.calls = join(this.dir, 'openclaw-calls.log');
    writeFileSync(join(binDir, 'openclaw'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> ' + JSON.stringify(this.calls) + '\nexec ' + JSON.stringify(this.bin) + ' "$@"\n');
    writeFileSync(join(binDir, 'gbrain'), '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' --no-env-file ' + JSON.stringify(join(REPO, 'src', 'cli.ts')) + ' "$@"\n');
    chmodSync(join(binDir, 'openclaw'), 0o755);
    chmodSync(join(binDir, 'gbrain'), 0o755);
    this.env = {
      PATH: [binDir, process.env.PATH ?? ''].join(':'),
      HOME: this.dir, TMPDIR: this.dir, GBRAIN_HOME: this.dir,
      OPENCLAW_STATE_DIR: join(this.dir, '.openclaw'), OPENCLAW_CONFIG_PATH: join(this.dir, 'openclaw.json'),
      GBRAIN_CI_DISABLE_TEST_ENV_FILE: '1', NO_COLOR: '1',
    };
  }

  get gbrainBin(): string { return join(this.dir, 'bin', 'gbrain'); }
  get gbrainHome(): string { return join(this.dir, '.gbrain'); }
  get logDir(): string { return join(this.gbrainHome, 'skill-index', 'logs'); }
  get statePath(): string { return join(this.gbrainHome, 'openclaw-skill-resolver.json'); }

  skill(name: string, description: string): void {
    mkdirSync(join(this.workspace, 'skills', name), { recursive: true });
    writeFileSync(join(this.workspace, 'skills', name, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + JSON.stringify(description) + '\n---\n# ' + name + '\n' + description + '.\n');
  }

  /**
   * Start the fake model and write openclaw.json (loopback provider, no update check, no catalog download).
   * OpenClaw's own bundled, custodian and plugin skills stay loaded but hidden from the model, so a test's
   * suggestions come from its synthetic skills alone whatever the OpenClaw version ships.
   */
  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      if (req.method !== 'POST') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[]}'); return; }
      this.requests.push({ path: req.url ?? '', body: JSON.parse(body) });
      const reply = this.replies.shift() ?? { text: 'fixture reply' };
      if ('status' in reply) {
        res.writeHead(reply.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'fixture overloaded', type: 'overloaded_error' } }));
        return;
      }
      const base = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture' };
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      const chunks = 'tool' in reply
        ? [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: reply.tool, arguments: JSON.stringify(reply.args) } }] }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage }]
        : [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: reply.text }, finish_reason: null }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(chunks.map((c) => 'data: ' + JSON.stringify(c)).join('\n\n') + '\n\ndata: [DONE]\n\n');
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    const port = (this.server.address() as { port: number }).port;
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    this.gatewayPort = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => probe.close(() => r()));
    writeFileSync(this.env.OPENCLAW_CONFIG_PATH!, JSON.stringify({
      agents: { defaults: { workspace: this.workspace, model: { primary: 'fixture/fixture' }, skipBootstrap: true } },
      gateway: { mode: 'local', port: this.gatewayPort, bind: 'loopback', auth: { mode: 'none' } },
      update: { checkOnStart: false },
      skills: { allowBundled: [], entries: { 'browser-automation': { enabled: false }, canvas: { enabled: false } } },
      models: { mode: 'replace', catalogRefresh: { enabled: false }, providers: { fixture: {
        baseUrl: 'http://127.0.0.1:' + port + '/v1', api: 'openai-completions', apiKey: 'local-fixture',
        models: [{ id: 'fixture', name: 'Fixture', contextWindow: 65536, maxTokens: 512, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      } } },
    }, null, 2));
  }

  /**
   * Start the fake Bot API and point OpenClaw's telegram channel at it (call before startGateway). DMs are
   * allowed from allowFrom; each group id in groups is allowed with requireMention false, for the senders
   * in groupAllowFrom.
   */
  async startTelegram(opts: { allowFrom: string[]; groupAllowFrom: string[]; groups: string[] }): Promise<void> {
    this.telegram = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const method = /^\/bot[^/]+\/(\w+)$/.exec(url.pathname)?.[1] ?? url.pathname;
      let body: Record<string, unknown> = Object.fromEntries(url.searchParams);
      try { if (raw) body = raw.startsWith('{') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw)); } catch { /* keep the query */ }
      this.telegramCalls.push({ method, body });
      const ok = (result: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); };
      const now = () => Math.floor(Date.now() / 1000);
      if (method === 'getMe') return ok({ id: 7000001, is_bot: true, first_name: 'Fixture', username: 'fixture_bot', can_join_groups: true, can_read_all_group_messages: true, supports_inline_queries: false });
      if (method === 'getUpdates') {
        for (let i = 0; i < 20 && !this.inbox.length; i++) await Bun.sleep(250);
        return ok(this.inbox.splice(0).map((m) => ({ update_id: ++this.updateId, message: { message_id: ++this.messageId, date: now(), ...m } })));
      }
      if (method === 'sendMessage' || method === 'editMessageText') return ok({ message_id: ++this.messageId, date: now(), chat: { id: Number(body.chat_id) || 0, type: 'private' }, text: String(body.text ?? '') });
      if (method === 'getWebhookInfo') return ok({ url: '', has_custom_certificate: false, pending_update_count: 0 });
      if (method === 'getMyCommands') return ok([]);
      return ok(true);
    });
    await new Promise<void>((r) => this.telegram!.listen(0, '127.0.0.1', r));
    const port = (this.telegram.address() as { port: number }).port;
    const config = JSON.parse(readFileSync(this.env.OPENCLAW_CONFIG_PATH!, 'utf8'));
    config.channels = { telegram: {
      enabled: true, botToken: '123456789:fixture-token-not-real', apiRoot: 'http://127.0.0.1:' + port,
      dmPolicy: 'allowlist', allowFrom: opts.allowFrom, groupPolicy: 'allowlist', groupAllowFrom: opts.groupAllowFrom,
      groups: Object.fromEntries(opts.groups.map((g) => [g, { requireMention: false }])),
    } };
    writeFileSync(this.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config, null, 2));
  }

  /** Deliver one inbound Telegram message on the next getUpdates poll. */
  telegramSend(message: TelegramMessage): void { this.inbox.push(message); }

  private async run(argv: string[], timeoutMs: number): Promise<Ran> {
    const t0 = Date.now();
    const child = Bun.spawn(argv, { env: this.env, cwd: this.workspace, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, stdout, stderr, ms: Date.now() - t0 };
    } finally { clearTimeout(timer); }
  }

  openclaw(args: string[], timeoutMs = 120_000): Promise<Ran> { return this.run([join(this.dir, 'bin', 'openclaw'), ...args], timeoutMs); }
  gbrain(args: string[], timeoutMs = 300_000): Promise<Ran> { return this.run([this.gbrainBin, ...args], timeoutMs); }

  /** The openclaw CLI calls made through the wrapper, leaving out the test's own turns and version checks. */
  callLines(): string[] {
    try { return readFileSync(this.calls, 'utf8').split('\n').filter((l) => l && !l.startsWith('agent ') && l !== '--version'); } catch { return []; }
  }

  async startGateway(): Promise<void> {
    if (this.gateway) return;
    const grouped = Bun.which('setsid') !== null;
    const proc = Bun.spawn([...(grouped ? ['setsid'] : []), this.bin, 'gateway', 'run'], { env: this.env, cwd: this.workspace, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const out = pumpText(proc.stdout as ReadableStream<Uint8Array>);
    const err = pumpText(proc.stderr as ReadableStream<Uint8Array>);
    this.gateway = { proc, out, err, grouped };
    if (!(await waitForText(out, '[gateway] ready', 120_000))) throw new Error('the OpenClaw gateway did not get ready:\n' + out.text.slice(-3000) + '\n' + err.text.slice(-3000));
  }

  get gatewayPid(): number | null { return this.gateway?.proc.pid ?? null; }
  get gatewayLog(): string { return (this.gateway?.out.text ?? '') + (this.gateway?.err.text ?? ''); }

  async stopGateway(): Promise<void> {
    if (!this.gateway) return;
    const { proc, grouped } = this.gateway;
    const group = (signal: NodeJS.Signals) => { try { process.kill(grouped ? -proc.pid : proc.pid, signal); } catch { /* the group is gone */ } };
    group('SIGTERM');
    const killer = setTimeout(() => group('SIGKILL'), 10_000);
    await proc.exited;
    clearTimeout(killer);
    for (let i = 0; grouped && i < 50; i++) { group('SIGKILL'); if (!Bun.spawnSync(['sh', '-c', 'pgrep -g ' + proc.pid]).stdout.toString().trim()) break; await Bun.sleep(200); }
    this.gateway = null;
  }

  async restartGateway(): Promise<void> { await this.stopGateway(); await this.startGateway(); }

  /** One real user turn through the gateway; returns the model requests it caused and how long the turn took. */
  async turn(session: string, message: string): Promise<{ ran: Ran; requests: ModelRequest[] }> {
    const before = this.requests.length;
    const ran = await this.openclaw(['agent', '--agent', 'main', '--session-key', 'agent:main:' + session, '--message', message, '--json', '--timeout', '90'], 150_000);
    return { ran, requests: this.requests.slice(before) };
  }

  /** Resolver log lines from the plugin's daily logs (turns and reads), oldest first. */
  logLines(): Array<Record<string, unknown>> {
    try {
      return Bun.spawnSync(['sh', '-c', 'cat "$0"/openclaw-*.jsonl 2>/dev/null', this.logDir]).stdout.toString().split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
    } catch { return []; }
  }

  async waitForLog(count: number, timeoutMs = 10_000): Promise<Array<Record<string, unknown>>> {
    const deadline = Date.now() + timeoutMs;
    let lines = this.logLines();
    while (lines.length < count && Date.now() < deadline) { await Bun.sleep(100); lines = this.logLines(); }
    return lines;
  }

  note(line: string): void { appendFileSync(join(this.dir, 'notes.log'), line + '\n'); }

  async close(): Promise<void> {
    await this.stopGateway();
    if (this.server) { this.server.closeAllConnections(); await new Promise<void>((r) => this.server!.close(() => r())); }
    this.server = null;
    if (this.telegram) { this.telegram.closeAllConnections(); await new Promise<void>((r) => this.telegram!.close(() => r())); }
    this.telegram = null;
    if (!process.env.GBRAIN_TEST_OPENCLAW_KEEP) rmSync(this.dir, { recursive: true, force: true });
  }
}
