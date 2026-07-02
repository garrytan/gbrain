/**
 * Office-ingest sidecar degradation contract.
 *
 * Every other office test drives the adapter through the `_parseForTest` seam,
 * so the REAL failure path — Docling sidecar down / not installable / broken —
 * had no coverage. This file pins the degradation contract:
 *
 *   1. office disabled (default)      → clean ImportResult error, no sidecar contact
 *   2. enabled + sidecar unreachable  → clean ImportResult error (never a throw), fast
 *   3. one broken office file         → does NOT poison subsequent imports
 *   4. ensureSidecarUp venv missing   → false fast (no spawn, no health-poll wait)
 *   5. ensureSidecarUp spawn failure  → false via the 'error' handler (no unhandled
 *      'error' crash, no waiting out the full health-poll deadline)
 *
 * No HTTP sidecar, no embedding provider, no lock on the user's brain: the
 * "sidecar" is a freshly-freed localhost port with nothing listening, and the
 * configured python paths are deliberately invalid so auto-start can't spawn
 * anything real.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importOfficeFile } from '../src/core/office/adapter.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { ensureSidecarUp } from '../src/core/office/sidecar-manage.ts';

let engine: PGLiteEngine;
let dir: string;
let deadUrl: string; // localhost URL with nothing listening

/** Bind an ephemeral port, release it, return it — a port that refuses fast. */
async function freeLocalPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'office-degrade-'));
  deadUrl = `http://127.0.0.1:${await freeLocalPort()}`;
});

afterAll(async () => {
  try { await engine.disconnect(); } catch { /* best effort */ }
  rmSync(dir, { recursive: true, force: true });
});

test('office disabled (default): clean error result telling the user how to enable', async () => {
  const fp = join(dir, 'off.docx');
  writeFileSync(fp, Buffer.from([0x50, 0x4b, 0x03, 0x04]));

  // No _parseForTest: this is the real path, gated before any sidecar contact.
  const res = await importOfficeFile(engine, fp, 'off.docx', { noEmbed: true });
  expect(res.status).toBe('error');
  expect(res.error).toContain('office ingest disabled');
  expect(res.error).toContain('ingest.docling.enabled');
});

test('enabled + sidecar unreachable: error result, never a throw, and fail-fast', async () => {
  await engine.setConfig('ingest.docling.enabled', 'true');
  await engine.setConfig('ingest.docling.url', deadUrl);
  // Nonexistent python keeps auto-start from spawning anything on this machine.
  await engine.setConfig('ingest.docling.python', join(dir, 'no-such-python'));

  const fp = join(dir, 'down.pdf');
  writeFileSync(fp, Buffer.from('%PDF-1.4 not really'));

  const t0 = Date.now();
  const res = await importOfficeFile(engine, fp, 'down.pdf', { noEmbed: true });
  const elapsed = Date.now() - t0;

  expect(res.status).toBe('error');
  expect(res.chunks).toBe(0);
  expect(res.error).toContain('docling sidecar');
  // Venv-missing must short-circuit auto-start: no spawn, no 180s health poll.
  expect(elapsed).toBeLessThan(15_000);

  // Nothing half-written: the failed import must not create the page.
  expect(await engine.getPage('down.pdf')).toBeFalsy();
}, 30_000);

test('a broken office file does not poison subsequent imports through importFromFile', async () => {
  const officePath = join(dir, 'broken.pdf');
  writeFileSync(officePath, Buffer.from('%PDF-1.4 nope'));
  const mdPath = join(dir, 'note.md');
  writeFileSync(mdPath, '# Hello\n\nA plain note that must still import.\n');

  const officeRes = await importFromFile(engine, officePath, 'broken.pdf', { noEmbed: true });
  expect(officeRes.status).toBe('error');

  const mdRes = await importFromFile(engine, mdPath, 'note.md', { noEmbed: true });
  expect(mdRes.status).toBe('imported');
  expect(mdRes.chunks).toBeGreaterThan(0);
}, 30_000);

test('ensureSidecarUp: missing venv python returns false fast without spawning', async () => {
  const logs: string[] = [];
  const t0 = Date.now();
  const up = await ensureSidecarUp(
    { url: deadUrl, python: join(dir, 'still-no-python'), waitMs: 10_000 },
    (l) => logs.push(l),
  );
  expect(up).toBe(false);
  expect(Date.now() - t0).toBeLessThan(10_000);
  expect(logs.some((l) => l.includes('setup-docling'))).toBe(true);
}, 15_000);

test('ensureSidecarUp: spawn failure resolves false — no unhandled error crash, no full deadline wait', async () => {
  // An existing but non-executable "python": spawn emits 'error' on every
  // platform (EACCES on POSIX, UNKNOWN/EINVAL on Windows). Before the error
  // handler landed, this crashed the process via the unhandled 'error' event.
  const fakePy = join(dir, 'not-python.txt');
  writeFileSync(fakePy, 'definitely not an interpreter\n');

  const t0 = Date.now();
  const up = await ensureSidecarUp({ url: deadUrl, python: fakePy, waitMs: 12_000 }, () => {});
  expect(up).toBe(false);
  expect(Date.now() - t0).toBeLessThan(20_000);
}, 30_000);
