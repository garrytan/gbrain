/**
 * A harness that times out a slow read must not read silence as an empty result.
 *
 * 1. Protects: a slow read prints its start line on stderr at once and a progress line on every interval; SIGTERM,
 *    SIGINT or SIGHUP mid-read prints one stderr line and, under --json, one `interrupted` document on stdout saying how
 *    long it ran and that nothing was read; a harness that follows SIGTERM with SIGKILL still gets both; a guarded
 *    command killed outside a read gets the `interrupted` fallback, not `command_failed`. Real CLI: `doctor --json`
 *    prints the start line on stderr and `elapsed_ms`/`complete` in its document, stdout staying one JSON document.
 * 2. Fails when: the heartbeat waits for the result, the note runs only after cleanup, or the fallback calls a signal a
 *    command failure.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXTURE = join(import.meta.dir, 'fixtures', 'slow-read-cli.ts');
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

async function readUntil(stream: ReadableStream<Uint8Array>, sink: { text: string }, needle: string, timeoutMs = 20_000): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; sink.text += decoder.decode(value); } })();
  while (!sink.text.includes(needle)) {
    if (Date.now() > deadline) throw new Error(`never saw ${JSON.stringify(needle)} in: ${sink.text}`);
    await Bun.sleep(20);
  }
}

async function harness(opts: { json: boolean; signal: NodeJS.Signals; killAfterMs?: number; env?: Record<string, string>; waitFor?: string }) {
  const proc = Bun.spawn([process.execPath, FIXTURE, ...(opts.json ? ['--json'] : [])], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...opts.env } });
  const err = { text: '' };
  await readUntil(proc.stderr, err, opts.waitFor ?? 'fixture: ready');
  proc.kill(opts.signal);
  if (opts.killAfterMs !== undefined) setTimeout(() => proc.kill('SIGKILL'), opts.killAfterMs);
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  await Bun.sleep(50);
  return { stdout, stderr: err.text, code };
}

describe('slow read heartbeat and interrupt note', () => {
  test('the start line prints at once and a progress line on every interval, before any result', async () => {
    const r = await harness({ json: true, signal: 'SIGTERM', env: { READ_EVERY_MS: '200' }, waitFor: 'still reading' });
    const lines = r.stderr.split('\n');
    expect(lines[0]).toContain('[gbrain] reading sync status for source alpha-example; large brains can take minutes.');
    expect(lines.some(l => /\[gbrain\] still reading sync status for source alpha-example \(\d+ s so far\); no result yet\./.test(l))).toBe(true);
  }, 30_000);

  for (const [signal, exit] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]] as const) {
    test(`${signal} mid-read: one stderr line and one interrupted document, never an empty result`, async () => {
      const r = await harness({ json: true, signal });
      expect(r.code).toBe(exit);
      expect(r.stderr).toMatch(new RegExp(`\\[gbrain\\] Interrupted by ${signal} after \\d+ s while reading sync status for source alpha-example, before the result was ready\\. Nothing was read, so this is not an empty result\\.`));
      const doc = JSON.parse(r.stdout);
      expect(doc).toMatchObject({ error: 'interrupted', code: 'interrupted', signal, read: 'sync status for source alpha-example', complete: false, contract_version: 1 });
      expect(typeof doc.elapsed_ms).toBe('number');
      expect(r.stdout.trim().split('\n').join('')).toBe(JSON.stringify(doc, null, 2).split('\n').join(''));
    }, 30_000);
  }

  test('a harness that sends SIGKILL 200 ms after SIGTERM still gets the note and the document', async () => {
    const r = await harness({ json: true, signal: 'SIGTERM', killAfterMs: 200 });
    expect(r.stderr).toContain('Interrupted by SIGTERM');
    expect(JSON.parse(r.stdout)).toMatchObject({ code: 'interrupted', complete: false });
  }, 30_000);

  test('without --json the note goes to stderr only and stdout stays empty', async () => {
    const r = await harness({ json: false, signal: 'SIGTERM' });
    expect(r.code).toBe(143);
    expect(r.stderr).toContain('Interrupted by SIGTERM');
    expect(r.stdout).toBe('');
  }, 30_000);

  test('a guarded command killed outside a read gets the interrupted fallback, not command_failed', async () => {
    const r = await harness({ json: true, signal: 'SIGTERM', env: { NO_READ: '1' } });
    expect(r.code).toBe(143);
    expect(JSON.parse(r.stdout)).toMatchObject({ error: 'interrupted', code: 'interrupted', exit_code: 143 });
    expect(r.stderr).not.toContain('[gbrain] reading');
  }, 30_000);
});

describe('real CLI: doctor --json', () => {
  test('prints the start line on stderr and elapsed_ms/complete in its one document', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-slow-read-'));
    try {
      const env = { ...process.env, GBRAIN_HOME: home, GBRAIN_NO_UPDATE_CHECK: '1', GBRAIN_TELEMETRY: '0' } as Record<string, string>;
      delete env.DATABASE_URL; delete env.GBRAIN_DATABASE_URL; delete env.OPENAI_API_KEY;
      expect(Bun.spawnSync([process.execPath, CLI, 'init', '--pglite', '--no-embedding'], { env, stdout: 'ignore', stderr: 'ignore' }).exitCode).toBe(0);
      const r = Bun.spawnSync([process.execPath, CLI, 'doctor', '--json', '--only', 'connection'], { env, stdout: 'pipe', stderr: 'pipe' });
      expect(r.stderr.toString().split('\n')[0]).toContain('[gbrain] reading doctor checks; large brains can take minutes.');
      const doc = JSON.parse(r.stdout.toString());
      expect(typeof doc.elapsed_ms).toBe('number');
      expect(doc.complete).toBe(true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
});
