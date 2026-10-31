/**
 * Upgrade matrix: a minimal stdio MCP client for the serve a cell starts the
 * way an agent harness does (stdin held open, newline-delimited JSON-RPC).
 * It reads the server's reported version from initialize and calls one tool.
 */
import type { Subprocess } from 'bun';

export class StdioMcp {
  private buffer = '';
  private waiters = new Map<number, (msg: any) => void>();
  private nextId = 1;
  readonly stderr: string[] = [];

  constructor(readonly proc: Subprocess<'pipe', 'pipe', 'pipe'>) {
    void this.pump();
    void (async () => { for await (const chunk of proc.stderr) this.stderr.push(new TextDecoder().decode(chunk)); })().catch(() => {});
  }

  private async pump(): Promise<void> {
    try {
      for await (const chunk of this.proc.stdout) {
        this.buffer += new TextDecoder().decode(chunk);
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!line.startsWith('{')) continue;
          try {
            const msg = JSON.parse(line);
            if (typeof msg.id === 'number') this.waiters.get(msg.id)?.(msg);
          } catch { /* not a JSON-RPC line */ }
        }
      }
    } catch { /* stream closed */ }
  }

  get alive(): boolean { return this.proc.exitCode === null && this.proc.signalCode === null; }

  async request(method: string, params: unknown, timeoutMs = 60_000): Promise<any> {
    const id = this.nextId++;
    const reply = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters.delete(id); reject(new Error(method + ' timed out after ' + timeoutMs + ' ms')); }, timeoutMs);
      this.waiters.set(id, msg => { clearTimeout(timer); this.waiters.delete(id); resolve(msg); });
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    this.proc.stdin.flush();
    const msg = await reply;
    if (msg.error) throw new Error(method + ': ' + JSON.stringify(msg.error).slice(0, 400));
    return msg.result;
  }

  /** initialize + initialized; returns serverInfo.version. */
  async initialize(): Promise<string> {
    const result = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gbrain-upgrade-matrix', version: '1' } }, 120_000);
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    this.proc.stdin.flush();
    return String(result?.serverInfo?.version ?? '');
  }

  /** tools/call; returns the concatenated text content. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request('tools/call', { name, arguments: args });
    const text = (result?.content ?? []).map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
    if (result?.isError) throw new Error(name + ' returned an error: ' + text.slice(0, 400));
    return text;
  }

  async close(): Promise<void> {
    try { this.proc.stdin.end(); } catch { /* already closed */ }
    const exited = await Promise.race([this.proc.exited.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 10_000))]);
    if (!exited) { this.proc.kill('SIGTERM'); await Promise.race([this.proc.exited, new Promise(r => setTimeout(r, 5_000))]); }
    if (this.alive) this.proc.kill('SIGKILL');
  }
}
