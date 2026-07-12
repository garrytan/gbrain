import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { DesktopLogger } from './logs.js';
import { cleanDatabaseEnvironment, packagedRuntimeRoot, projectRoot, type CliRuntime } from './cli-runner.js';

const HEALTH_TIMEOUT_MS = 45_000;
const HEALTH_INTERVAL_MS = 500;
const STOP_TIMEOUT_MS = 5_000;
const RESTART_WINDOW_MS = 30_000;
const MAX_RESTARTS = 3;

export type SidecarState =
  | { phase: 'starting'; port: number }
  | { phase: 'ready'; port: number; adminUrl: string }
  | { phase: 'stopped'; port: number }
  | { phase: 'failed'; port: number; message: string };

interface SidecarManagerOptions extends CliRuntime {
  port: number;
  bootstrapToken: string;
  clientVersion: string;
  logger: DesktopLogger;
  onState?: (state: SidecarState) => void;
}

export class SidecarManager {
  readonly port: number;
  readonly bootstrapToken: string;
  private readonly options: SidecarManagerOptions;
  private child: ChildProcess | null = null;
  private stopping = false;
  private recovering = false;
  private restartTimes: number[] = [];

  constructor(options: SidecarManagerOptions) {
    this.options = options;
    this.port = options.port;
    this.bootstrapToken = options.bootstrapToken;
  }

  async start(): Promise<string> {
    this.stopping = false;
    this.spawnProcess();
    this.options.onState?.({ phase: 'starting', port: this.port });
    try {
      await this.waitUntilHealthy();
    } catch (error) {
      this.stopping = true;
      await this.terminateChild();
      throw error;
    }
    const adminUrl = await this.issueMagicLink();
    this.options.onState?.({ phase: 'ready', port: this.port, adminUrl });
    return adminUrl;
  }

  async restart(): Promise<string> {
    await this.stop();
    return this.start();
  }

  get mcpUrl(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async createAdminLink(): Promise<string> {
    return this.issueMagicLink();
  }

  async adminRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const link = await this.issueMagicLink();
    const authResponse = await fetch(link, { redirect: 'manual' });
    const cookie = authResponse.headers.get('set-cookie')?.split(';', 1)[0];
    if (!cookie) throw new Error('无法创建桌面管理员会话。');
    const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        ...(init.headers ?? {}),
      },
    });
    const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
    if (!response.ok) throw new Error(body.message || body.error || `Admin API 返回 HTTP ${response.status}`);
    return body;
  }

  async smokeTest(token: string): Promise<{ toolCount: number; statsOk: boolean }> {
    const call = async (method: string, params: Record<string, unknown>, id: number) => {
      const response = await fetch(this.mcpUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id }),
      });
      if (!response.ok) throw new Error(`MCP ${method} 返回 HTTP ${response.status}`);
      const text = await response.text();
      const payloads = text.split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .concat(text.trim().startsWith('{') ? [text.trim()] : [])
        .map((line) => { try { return JSON.parse(line) as Record<string, any>; } catch { return null; } })
        .filter(Boolean) as Record<string, any>[];
      return payloads.find((item) => item.id === id) ?? payloads[0] ?? {};
    };
    await call('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'pmbrain-desktop', version: this.options.clientVersion },
    }, 1);
    const tools = await call('tools/list', {}, 2);
    const stats = await call('tools/call', { name: 'get_stats', arguments: {} }, 3);
    return { toolCount: Array.isArray(tools.result?.tools) ? tools.result.tools.length : 0, statsOk: !stats.error };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.terminateChild();
    this.options.onState?.({ phase: 'stopped', port: this.port });
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;

    child.kill('SIGTERM');
    await new Promise<void>((resolveDone) => {
      const timeout = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
        resolveDone();
      }, STOP_TIMEOUT_MS);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolveDone();
      });
    });
  }

  private spawnProcess(): void {
    const root = projectRoot(this.options);
    const workingDirectory = this.options.packaged ? packagedRuntimeRoot(this.options) : root;
    const command = this.options.packaged
      ? join(workingDirectory, 'bun.exe')
      : process.env.PMBRAIN_DESKTOP_BUN || 'bun';
    const args = this.options.packaged
      ? [join(workingDirectory, 'pmbrain-sidecar.js'), 'serve', '--http', '--port', String(this.port), '--bind', '127.0.0.1', '--suppress-bootstrap-token']
      : ['run', join(root, 'src', 'cli.ts'), 'serve', '--http', '--port', String(this.port), '--bind', '127.0.0.1', '--suppress-bootstrap-token'];

    this.options.logger.write('desktop', `Starting sidecar on 127.0.0.1:${this.port}`);
    const child = spawn(command, args, {
      cwd: workingDirectory,
      env: {
        ...cleanDatabaseEnvironment(),
        PMBRAIN_ADMIN_BOOTSTRAP_TOKEN: this.bootstrapToken,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.on('data', (value) => this.options.logger.write('sidecar:stdout', value));
    child.stderr?.on('data', (value) => this.options.logger.write('sidecar:stderr', value));
    child.once('error', (error) => this.handleCrash(`Sidecar failed to start: ${error.message}`));
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (!this.stopping) this.handleCrash(`Sidecar exited (code ${code ?? 'none'}, signal ${signal ?? 'none'}).`);
    });
  }

  private handleCrash(message: string): void {
    this.options.logger.write('desktop', message);
    if (this.stopping || this.recovering) return;
    void this.recoverAfterCrash(message);
  }

  private async recoverAfterCrash(lastMessage: string): Promise<void> {
    this.recovering = true;
    let failure = lastMessage;
    try {
      while (!this.stopping) {
        const now = Date.now();
        this.restartTimes = this.restartTimes.filter((time) => now - time <= RESTART_WINDOW_MS);
        if (this.restartTimes.length >= MAX_RESTARTS) {
          this.options.onState?.({ phase: 'failed', port: this.port, message: failure });
          return;
        }
        this.restartTimes.push(now);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        if (this.stopping) return;
        this.spawnProcess();
        this.options.onState?.({ phase: 'starting', port: this.port });
        try {
          await this.waitUntilHealthy();
          const adminUrl = await this.issueMagicLink();
          this.options.onState?.({ phase: 'ready', port: this.port, adminUrl });
          return;
        } catch (error) {
          failure = error instanceof Error ? error.message : String(error);
          this.options.logger.write('desktop', `Recovery attempt failed: ${failure}`);
          await this.terminateChild();
        }
      }
    } finally {
      this.recovering = false;
    }
  }

  private async waitUntilHealthy(): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    let lastError = 'PMBrain did not report healthy.';
    while (Date.now() < deadline) {
      if (!this.child) throw new Error('PMBrain sidecar exited before it became healthy.');
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (response.ok) return;
        lastError = `Health check returned HTTP ${response.status}.`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, HEALTH_INTERVAL_MS));
    }
    throw new Error(`PMBrain startup timed out: ${lastError}`);
  }

  private async issueMagicLink(): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${this.port}/admin/api/issue-magic-link`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.bootstrapToken}` },
    });
    if (!response.ok) throw new Error(`Could not create an administrator session (HTTP ${response.status}).`);
    const body = await response.json() as { url?: string };
    if (!body.url) throw new Error('PMBrain returned an invalid administrator link.');
    return body.url.replace('http://localhost:', 'http://127.0.0.1:');
  }
}
