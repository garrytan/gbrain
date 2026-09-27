import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { DesktopLogger } from './logs.js';
import {
  cleanDatabaseEnvironment,
  formatProcessExit,
  packagedRuntimeRoot,
  projectRoot,
  type CliRuntime,
} from './cli-runner.js';
import { getDesktopRuntimeContract } from './runtime-contract.js';
import {
  classifySidecarStartupError,
  SidecarExitedBeforeHealthyError,
  SidecarHealthTimeoutError,
  type SidecarErrorCategory,
} from '../../../src/core/pglite-errors.js';

const HEALTH_TIMEOUT_MS = 45_000;
const HEALTH_INTERVAL_MS = 500;
const HEALTH_PROGRESS_LOG_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;
const FORCE_STOP_TIMEOUT_MS = 2_000;
const RESTART_WINDOW_MS = 30_000;
const MAX_RESTARTS = 3;
const MCP_BEARER_VERIFY_TIMEOUT_MS = 3_000;
const ADMIN_REQUEST_TIMEOUT_MS = 5_000;
const STDERR_TAIL_LIMIT = 64_000;
const EMPTY_STDERR = '(empty)';

export type SidecarState =
  | { phase: 'starting'; port: number }
  | { phase: 'ready'; port: number; adminUrl: string }
  | { phase: 'stopped'; port: number }
  | {
      phase: 'failed';
      port: number;
      message: string;
      category?: SidecarErrorCategory;
      categoryLabelZh?: string;
      details?: SidecarFailureDetails;
    };

export interface SidecarFailureDetails {
  healthUrl?: string;
  lastHealthError?: string;
  sidecarPid?: number | null;
  exitCode?: number | null;
  signal?: string | null;
  recentStderr?: string;
  databasePath?: string;
  retryable?: boolean;
}

export interface HealthCheckObservation {
  url: string;
  startedAt: string;
  durationMs: number;
  httpStatus?: number;
  bodySummary?: string;
  networkError?: string;
  sidecarAlive: boolean;
  sidecarPid: number | null;
  recentStderr: string;
}

interface SidecarManagerOptions extends CliRuntime {
  port: number;
  bootstrapToken: string;
  clientVersion: string;
  adminRequestTimeoutMs?: number;
  /** Override /health wait. PGLite upgrades need minutes, not 45s. */
  healthTimeoutMs?: number;
  /** Extra argv after `serve` (e.g. --diagnostic-mode). */
  extraServeArgs?: string[];
  /** When true, never auto-restart after crash. */
  disableAutoRestart?: boolean;
  logger: DesktopLogger;
  onState?: (state: SidecarState) => void;
  onHealthObservation?: (observation: HealthCheckObservation) => void;
  onStderr?: (chunk: string, recentStderr: string) => void;
}

export { classifySidecarStartupError };

export class SidecarManager {
  readonly port: number;
  readonly bootstrapToken: string;
  private readonly options: SidecarManagerOptions;
  private child: ChildProcess | null = null;
  private stopping = false;
  private recovering = false;
  private restartTimes: number[] = [];
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private adminCookie: string | null = null;
  private adminCookieRequest: Promise<string> | null = null;
  private recentStderr = '';
  private lastExitMessage: string | null = null;
  private lastExitCode: number | null = null;
  private lastExitSignal: string | null = null;
  private lastSidecarPid: number | null = null;
  private lastFailureDetails: SidecarFailureDetails | null = null;

  constructor(options: SidecarManagerOptions) {
    this.options = options;
    this.port = options.port;
    this.bootstrapToken = options.bootstrapToken;
  }

  private queueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.lifecycleQueue.then(operation, operation);
    this.lifecycleQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async start(): Promise<string> {
    return this.queueLifecycle(() => this.startNow());
  }

  private async startNow(): Promise<string> {
    if (this.child && this.child.exitCode === null) return this.issueMagicLink();
    this.stopping = false;
    this.spawnProcess();
    this.options.onState?.({ phase: 'starting', port: this.port });
    try {
      await this.waitUntilHealthy();
    } catch (error) {
      this.logSidecarFailure('before-stop', error);
      this.stopping = true;
      await this.terminateChild();
      this.logSidecarFailure('after-stop', error);
      const classified = classifySidecarStartupError(error);
      this.lastFailureDetails = this.buildFailureDetails(error, classified.retryable);
      const message = this.formatUserFacingFailure(error, classified.labelZh);
      this.options.onState?.({
        phase: 'failed',
        port: this.port,
        message,
        category: classified.category,
        categoryLabelZh: classified.labelZh,
        details: this.lastFailureDetails,
      });
      throw error;
    }
    const adminUrl = await this.issueMagicLink();
    this.options.onState?.({ phase: 'ready', port: this.port, adminUrl });
    return adminUrl;
  }

  async restart(): Promise<string> {
    this.stopping = true;
    return this.queueLifecycle(async () => {
      await this.stopNow();
      return this.startNow();
    });
  }

  get mcpUrl(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  get lastFailure(): SidecarFailureDetails | null {
    return this.lastFailureDetails;
  }

  async createAdminLink(): Promise<string> {
    return this.issueMagicLink();
  }

  async verifyMcpBearer(authorizationHeader: string): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MCP_BEARER_VERIFY_TIMEOUT_MS);
    try {
      const response = await fetch(this.mcpUrl, {
        method: 'POST',
        headers: {
          Authorization: authorizationHeader,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'pmbrain-lan-auth-check',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'pmbrain-lan-gateway', version: this.options.clientVersion },
          },
        }),
        signal: controller.signal,
      });
      if (response.body) await response.body.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) return false;
      if (!response.ok) throw new Error(`本机 MCP 凭证验证返回 HTTP ${response.status}`);
      return true;
    } finally {
      clearTimeout(timeout);
    }
  }

  async adminRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.adminResponse(path, init);
    const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string };
    if (!response.ok) throw new Error(body.message || body.error || `Admin API 返回 HTTP ${response.status}`);
    return body;
  }

  async adminResponse(path: string, init: RequestInit = {}): Promise<Response> {
    const request = async (cookie: string) => fetch(`http://127.0.0.1:${this.port}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        ...(init.headers ?? {}),
      },
    });

    let cookie = await this.getAdminCookie();
    let response = await request(cookie);
    if (response.status === 401) {
      this.adminCookie = null;
      this.adminCookieRequest = null;
      cookie = await this.getAdminCookie();
      response = await request(cookie);
    }
    return response;
  }

  private async getAdminCookie(): Promise<string> {
    if (this.adminCookie) return this.adminCookie;
    if (this.adminCookieRequest) return this.adminCookieRequest;
    this.adminCookieRequest = (async () => {
      const link = await this.issueMagicLink();
      const authResponse = await fetch(link, { redirect: 'manual' });
      const cookie = authResponse.headers.get('set-cookie')?.split(';', 1)[0];
      if (!cookie) throw new Error('无法创建桌面管理员会话。');
      this.adminCookie = cookie;
      return cookie;
    })();
    try {
      return await this.adminCookieRequest;
    } finally {
      this.adminCookieRequest = null;
    }
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
    return { toolCount: Array.isArray(tools.result?.tools) ? tools.result.tools.length : 0, statsOk: !stats.error && !stats.result?.isError };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    return this.queueLifecycle(() => this.stopNow());
  }

  private async stopNow(): Promise<void> {
    this.stopping = true;
    await this.terminateChild();
    this.options.onState?.({ phase: 'stopped', port: this.port });
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null) return;

    this.requestProcessTreeStop(child, false);
    if (await this.waitForChildExit(child, STOP_TIMEOUT_MS)) return;

    this.requestProcessTreeStop(child, true);
    if (!await this.waitForChildExit(child, FORCE_STOP_TIMEOUT_MS)) {
      throw new Error(`PMBrain sidecar process tree (PID ${child.pid ?? 'unknown'}) did not stop.`);
    }
  }

  private requestProcessTreeStop(child: ChildProcess, force: boolean): void {
    if (process.platform === 'win32' && child.pid) {
      const args = ['/PID', String(child.pid), '/T'];
      if (force) args.push('/F');
      const killer = spawn('taskkill', args, {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', error => {
        this.options.logger.write('desktop', `Unable to stop sidecar process tree: ${error.message}`);
      });
      return;
    }
    child.kill(force ? 'SIGKILL' : 'SIGTERM');
  }

  private async waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null) return true;
    return new Promise<boolean>((resolveDone) => {
      const onExit = () => {
        clearTimeout(timeout);
        resolveDone(true);
      };
      const timeout = setTimeout(() => {
        child.off('exit', onExit);
        resolveDone(child.exitCode !== null);
      }, timeoutMs);
      child.once('exit', onExit);
    });
  }

  private spawnProcess(): void {
    this.adminCookie = null;
    this.adminCookieRequest = null;
    this.recentStderr = '';
    this.lastExitMessage = null;
    this.lastExitCode = null;
    this.lastExitSignal = null;
    this.lastSidecarPid = null;
    const root = projectRoot(this.options);
    const workingDirectory = this.options.packaged ? packagedRuntimeRoot(this.options) : root;
    const runtimeContract = this.options.packaged ? getDesktopRuntimeContract() : null;
    const command = this.options.packaged
      ? join(workingDirectory, runtimeContract!.runtimeExecutableName)
      : process.env.PMBRAIN_DESKTOP_BUN || 'bun';
    const extra = this.options.extraServeArgs ?? [];
    const args = this.options.packaged
      ? [join(workingDirectory, 'pmbrain-sidecar.js'), 'serve', '--http', '--port', String(this.port), '--bind', '127.0.0.1', '--suppress-bootstrap-token', ...extra]
      : ['run', join(root, 'src', 'cli.ts'), 'serve', '--http', '--port', String(this.port), '--bind', '127.0.0.1', '--suppress-bootstrap-token', ...extra];

    this.options.logger.write('desktop', `Starting sidecar on 127.0.0.1:${this.port}`);
    const child = spawn(command, args, {
      cwd: workingDirectory,
      env: {
        ...cleanDatabaseEnvironment(),
        PMBRAIN_ADMIN_BOOTSTRAP_TOKEN: this.bootstrapToken,
        PMBRAIN_PGLITE_OWNER_TYPE: 'desktop-sidecar',
        // Desktop sidecar is the sole PGLite owner; fail fast if another owner is live.
        PMBRAIN_PGLITE_LOCK_FAIL_FAST: '1',
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.lastSidecarPid = child.pid ?? null;
    this.options.logger.write(
      'desktop',
      `sidecar spawned pid=${child.pid ?? 'none'} command=${command}`,
    );
    child.stdout?.on('data', (value) => this.options.logger.write('sidecar:stdout', value));
    child.stderr?.on('data', (value) => {
      const text = String(value);
      this.recentStderr = `${this.recentStderr}${text}`.slice(-STDERR_TAIL_LIMIT);
      this.options.logger.write('sidecar:stderr', value);
      this.options.onStderr?.(text, this.recentStderr);
    });
    child.once('error', (error) => {
      this.lastExitMessage = `Sidecar failed to start: ${error.message}`;
      this.handleCrash(this.lastExitMessage);
    });
    child.once('exit', (code, signal) => {
      const stderr = this.recentStderr.trim();
      this.lastExitCode = code;
      this.lastExitSignal = signal;
      this.lastExitMessage = `Sidecar exited (${formatProcessExit(code, signal)}).${stderr ? ` ${stderr}` : ''}`;
      if (this.child === child) this.child = null;
      if (!this.stopping) this.handleCrash(this.lastExitMessage);
    });
  }

  private handleCrash(message: string): void {
    this.options.logger.write('desktop', message);
    if (this.stopping || this.recovering) return;

    const classified = classifySidecarStartupError(message);
    if (!classified.retryable || this.options.disableAutoRestart) {
      this.lastFailureDetails = {
        recentStderr: this.recentStderr.trim(),
        sidecarPid: this.lastSidecarPid,
        exitCode: this.lastExitCode,
        signal: this.lastExitSignal,
        lastHealthError: message,
        retryable: false,
      };
      this.options.onState?.({
        phase: 'failed',
        port: this.port,
        message: this.formatUserFacingFailure(message, classified.labelZh),
        category: classified.category,
        categoryLabelZh: classified.labelZh,
        details: this.lastFailureDetails,
      });
      return;
    }

    this.recovering = true;
    void this.queueLifecycle(async () => {
      try {
        await this.recoverAfterCrash(message);
      } finally {
        this.recovering = false;
      }
    });
  }

  private async recoverAfterCrash(lastMessage: string): Promise<void> {
    let failure = lastMessage;
    while (!this.stopping) {
      const classified = classifySidecarStartupError(failure);
      if (!classified.retryable) {
        this.lastFailureDetails = this.buildFailureDetails(failure, false);
        this.options.onState?.({
          phase: 'failed',
          port: this.port,
          message: this.formatUserFacingFailure(failure, classified.labelZh),
          category: classified.category,
          categoryLabelZh: classified.labelZh,
          details: this.lastFailureDetails,
        });
        return;
      }

      const now = Date.now();
      this.restartTimes = this.restartTimes.filter((time) => now - time <= RESTART_WINDOW_MS);
      if (this.restartTimes.length >= MAX_RESTARTS) {
        this.lastFailureDetails = this.buildFailureDetails(failure, true);
        const finalClassified = classifySidecarStartupError(failure);
        this.options.onState?.({
          phase: 'failed',
          port: this.port,
          message: this.formatUserFacingFailure(failure, finalClassified.labelZh),
          category: finalClassified.category,
          categoryLabelZh: finalClassified.labelZh,
          details: this.lastFailureDetails,
        });
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
        const recoveredClassified = classifySidecarStartupError(error);
        if (!recoveredClassified.retryable) {
          this.lastFailureDetails = this.buildFailureDetails(error, false);
          this.options.onState?.({
            phase: 'failed',
            port: this.port,
            message: this.formatUserFacingFailure(error, recoveredClassified.labelZh),
            category: recoveredClassified.category,
            categoryLabelZh: recoveredClassified.labelZh,
            details: this.lastFailureDetails,
          });
          return;
        }
      }
    }
  }

  private healthTimeoutMs(): number {
    return this.options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
  }

  private stderrForLog(): string {
    const stderr = this.recentStderr.trim();
    return stderr || EMPTY_STDERR;
  }

  private logSidecarFailure(stage: string, error?: unknown): void {
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error ?? 'unknown');
    const pid = this.child?.pid ?? this.lastSidecarPid;
    const alive = Boolean(this.child && this.child.exitCode === null);
    const exitCode = this.lastExitCode ?? this.child?.exitCode ?? null;
    const signal = this.lastExitSignal ?? null;
    const stderr = this.stderrForLog();
    this.options.logger.write(
      'desktop',
      `sidecar startup failure stage=${stage} reason=${reason} pid=${pid ?? 'none'} alive=${alive} exitCode=${exitCode ?? 'none'} signal=${signal ?? 'none'} stderrBytes=${this.recentStderr.length}`,
    );
    this.options.logger.write('sidecar:stderr', stderr);
  }

  private async waitUntilHealthy(): Promise<void> {
    const timeoutMs = this.healthTimeoutMs();
    const deadline = Date.now() + timeoutMs;
    const healthUrl = `http://127.0.0.1:${this.port}/health`;
    let lastError = 'PMBrain did not report healthy.';
    let lastObservation: HealthCheckObservation | null = null;
    let lastProgressLog = 0;

    while (Date.now() < deadline) {
      if (this.stopping) throw new Error('PMBrain sidecar startup was stopped.');

      // If sidecar already exited, fail immediately — do not wait out the timeout.
      if (!this.child || this.child.exitCode !== null) {
        const stderr = this.recentStderr.trim();
        this.logSidecarFailure('exited-before-healthy');
        const message = this.lastExitMessage
          ?? `PMBrain sidecar exited before it became healthy.${stderr ? ` ${stderr}` : ''}`;
        const classified = classifySidecarStartupError(message);
        throw new SidecarExitedBeforeHealthyError({
          message,
          exitCode: this.lastExitCode,
          signal: this.lastExitSignal,
          stderr,
          category: classified.category,
        });
      }

      const startedAt = new Date().toISOString();
      const t0 = Date.now();
      try {
        const response = await fetch(healthUrl, {
          signal: AbortSignal.timeout(2_000),
        });
        const bodyText = await response.text().catch(() => '');
        const observation: HealthCheckObservation = {
          url: healthUrl,
          startedAt,
          durationMs: Date.now() - t0,
          httpStatus: response.status,
          bodySummary: bodyText.slice(0, 200),
          sidecarAlive: true,
          sidecarPid: this.child.pid ?? null,
          recentStderr: this.recentStderr.trim().slice(-500),
        };
        lastObservation = observation;
        this.options.onHealthObservation?.(observation);
        this.options.logger.write(
          'desktop',
          `health check url=${healthUrl} status=${response.status} ms=${observation.durationMs} pid=${observation.sidecarPid}`,
        );
        if (response.ok) return;
        lastError = `Health check returned HTTP ${response.status}. body=${observation.bodySummary}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        const observation: HealthCheckObservation = {
          url: healthUrl,
          startedAt,
          durationMs: Date.now() - t0,
          networkError: lastError,
          sidecarAlive: Boolean(this.child && this.child.exitCode === null),
          sidecarPid: this.child?.pid ?? null,
          recentStderr: this.recentStderr.trim().slice(-500),
        };
        lastObservation = observation;
        this.options.onHealthObservation?.(observation);
        if (Date.now() - lastProgressLog >= HEALTH_PROGRESS_LOG_MS) {
          lastProgressLog = Date.now();
          this.options.logger.write(
            'desktop',
            `health check still waiting url=${healthUrl} error=${lastError} pid=${this.child?.pid ?? 'none'} alive=${observation.sidecarAlive} stderrBytes=${this.recentStderr.length}`,
          );
        }
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, HEALTH_INTERVAL_MS));
    }

    const classified = classifySidecarStartupError(lastError);
    const sidecarAlive = Boolean(this.child && this.child.exitCode === null);
    const sidecarPid = this.child?.pid ?? lastObservation?.sidecarPid ?? null;
    const recentStderr = this.recentStderr.trim();
    this.logSidecarFailure('health-timeout');
    throw new SidecarHealthTimeoutError({
      healthUrl,
      lastError,
      sidecarAlive,
      sidecarPid,
      recentStderr,
      category: classified.category,
      message: [
        `本地服务启动失败：健康检查超时。最后错误：${lastError}`,
        `sidecar pid：${sidecarPid ?? 'none'}`,
        `sidecar 仍在运行：${sidecarAlive ? 'yes' : 'no'}`,
        `sidecar 退出码：${this.lastExitCode ?? 'none'}`,
        `sidecar stderr：${recentStderr || EMPTY_STDERR}`,
      ].join('\n'),
    });
  }

  private buildFailureDetails(error: unknown, retryable: boolean): SidecarFailureDetails {
    const text = error instanceof Error ? error.message : String(error);
    return {
      healthUrl: `http://127.0.0.1:${this.port}/health`,
      lastHealthError: text,
      sidecarPid: this.child?.pid ?? this.lastSidecarPid,
      exitCode: this.lastExitCode,
      signal: this.lastExitSignal,
      recentStderr: this.recentStderr.trim(),
      retryable,
    };
  }

  private formatUserFacingFailure(error: unknown, categoryLabelZh: string): string {
    const text = error instanceof Error ? error.message : String(error);
    const stderr = this.stderrForLog();
    const pid = this.child?.pid ?? this.lastSidecarPid;
    const parts = [
      '本地服务启动失败',
      `失败类别：${categoryLabelZh}`,
      `详细信息：${text}`,
      `sidecar pid：${pid ?? 'none'}`,
      `sidecar 退出码：${this.lastExitCode ?? 'none'}`,
    ];
    if (this.lastExitSignal) parts.push(`sidecar signal：${this.lastExitSignal}`);
    parts.push(`sidecar stderr：${stderr.slice(-STDERR_TAIL_LIMIT)}`);
    return parts.join('\n');
  }

  private async issueMagicLink(): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.port}/admin/api/issue-magic-link`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.bootstrapToken}` },
        signal: AbortSignal.timeout(this.options.adminRequestTimeoutMs ?? ADMIN_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new Error(
        `Could not create an administrator session within ${this.options.adminRequestTimeoutMs ?? ADMIN_REQUEST_TIMEOUT_MS} ms.`,
        { cause: error },
      );
    }
    if (!response.ok) throw new Error(`Could not create an administrator session (HTTP ${response.status}).`);
    const body = await response.json() as { url?: string };
    if (!body.url) throw new Error('PMBrain returned an invalid administrator link.');
    return body.url.replace('http://localhost:', 'http://127.0.0.1:');
  }
}
