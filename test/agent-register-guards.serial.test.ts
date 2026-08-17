/**
 * cathedral-6: the cli.ts PRE-CONNECT guard for `agent register` — a thin
 * client must be refused BEFORE connectEngine (which would otherwise build a
 * scratch PGLite and mint dead credentials into it). Subprocess-level so the
 * guard is exercised where it lives (handleCliOnly, before any engine work):
 * no database exists in the spawned HOME, so reaching the refusal at all
 * proves the guard fires pre-connect.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '..');

describe('agent register pre-connect guards (cli.ts)', () => {
  test('thin client is refused with a structured JSON failure before any engine work', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-thin-'));
    const dir = join(home, '.gbrain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      remote_mcp: {
        issuer_url: 'https://brain.example.com',
        mcp_url: 'https://brain.example.com/mcp',
        oauth_client_id: 'gbrain_cl_thin',
      },
    }));
    const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home };
    delete env.GBRAIN_DATABASE_URL;
    delete env.DATABASE_URL;
    const proc = Bun.spawn([
      'bun', '--no-env-file', 'run', 'src/cli.ts',
      'agent', 'register', 'aurora',
      '--harness', 'codex',
      '--url', 'https://brain.example.com/mcp',
      '--json',
    ], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    expect(code).toBe(1);
    // Structured single-document JSON failure on stdout (notes go to stderr).
    let doc: any;
    try {
      doc = JSON.parse(stdout.trim());
    } catch {
      throw new Error(`expected a single JSON doc on stdout, got:\n${stdout}\nstderr: ${stderr}`);
    }
    expect(doc.ok).toBe(false);
    expect(doc.reason).toBe('thin_client');
    expect(doc.message).toContain('HOST brain');
  }, 30_000);
});

describe('agent register live-serve + duplicate-name refusals (real PGLite brain)', () => {
  /** Shared PGLite brain home for both cases: init once, ~seconds. */
  async function initBrain(): Promise<{ home: string; env: Record<string, string | undefined> }> {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-guards-'));
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, GBRAIN_HOME: home };
    delete env.GBRAIN_DATABASE_URL;
    delete env.DATABASE_URL;
    const init = Bun.spawn(['bun', '--no-env-file', 'run', 'src/cli.ts', 'init', '--pglite'], {
      cwd: REPO, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
    });
    const initOut = await new Response(init.stdout).text();
    const initErr = await new Response(init.stderr).text();
    const code = await init.exited;
    if (code !== 0) throw new Error(`init --pglite failed (${code}):\n${initOut}\n${initErr}`);
    return { home, env };
  }

  // No explicit return annotation: `ReturnType<typeof Bun.spawn>` resolves the
  // generic's DEFAULT io types (stdout: number | ReadableStream | undefined);
  // inference from the literal options gives the precise piped Subprocess.
  function register(env: Record<string, string | undefined>, extra: string[] = []) {
    return Bun.spawn([
      'bun', '--no-env-file', 'run', 'src/cli.ts',
      'agent', 'register', 'aurora-guard',
      '--harness', 'codex', '--url', 'http://localhost:19139/mcp', '--json',
      ...extra,
    ], { cwd: REPO, env, stdout: 'pipe', stderr: 'pipe' });
  }

  test('duplicate name is refused with the existing client id + reissue hint; pglite live serve is refused pre-connect', async () => {
    const { home, env } = await initBrain();

    // First register succeeds (probe against the dead 19139 port is a note, not a failure).
    const first = register(env);
    const firstOut = await new Response(first.stdout).text();
    const firstErr = await new Response(first.stderr).text();
    expect(await first.exited).toBe(0);
    let firstDoc: any;
    try { firstDoc = JSON.parse(firstOut.trim()); } catch {
      throw new Error(`first register: expected JSON stdout, got:\n${firstOut}\nstderr: ${firstErr}`);
    }
    expect(firstDoc.ok).toBe(true);
    expect(firstDoc.client_id).toMatch(/^gbrain_cl_/);

    // Second register with the SAME name → duplicate_name envelope, exit 1,
    // message carries the existing client id + the --reissue hint.
    const dup = register(env);
    const dupOut = await new Response(dup.stdout).text();
    expect(await dup.exited).toBe(1);
    const dupDoc = JSON.parse(dupOut.trim());
    expect(dupDoc.ok).toBe(false);
    expect(dupDoc.reason).toBe('duplicate_name');
    expect(dupDoc.message).toContain(firstDoc.client_id);
    expect(dupDoc.message).toContain('--reissue');

    // Live PGLite serve: spawn `gbrain serve` (stdio) so it takes the
    // single-writer lock, then register must refuse PRE-connect with the
    // typed pglite_live_serve reason (never a 30s lock hang — enforce with
    // a wall-clock ceiling well under the lock timeout).
    const serve = Bun.spawn(['bun', '--no-env-file', 'run', 'src/cli.ts', 'serve'], {
      cwd: REPO, env, stdout: 'pipe', stderr: 'pipe', stdin: 'pipe',
    });
    try {
      // Wait for the serve to hold the lock (lock file appears).
      const lockPath = join(home, '.gbrain', 'brain.pglite', '.gbrain-lock', 'lock');
      const { existsSync, readFileSync } = await import('node:fs');
      const deadline = Date.now() + 20_000;
      let holds = false;
      while (Date.now() < deadline) {
        try {
          const raw = JSON.parse(readFileSync(lockPath, 'utf8'));
          if (raw?.pid && (raw.subcommand === 'serve' || String(raw.command ?? '').includes('serve'))) { holds = true; break; }
        } catch { /* not yet */ }
        await new Promise(r => setTimeout(r, 250));
        if (!existsSync(lockPath)) continue;
      }
      expect(holds).toBe(true);

      const started = Date.now();
      const blocked = register(env, []);
      const blockedOut = await new Response(blocked.stdout).text();
      expect(await blocked.exited).toBe(1);
      const elapsed = Date.now() - started;
      const blockedDoc = JSON.parse(blockedOut.trim());
      expect(blockedDoc.ok).toBe(false);
      expect(blockedDoc.reason).toBe('pglite_live_serve');
      expect(blockedDoc.message).toContain('stop the serve');
      // Pre-connect means no single-writer 30s spin: generous CI ceiling.
      expect(elapsed).toBeLessThan(15_000);
    } finally {
      serve.kill('SIGTERM');
      await serve.exited;
    }
  }, 120_000);
});
