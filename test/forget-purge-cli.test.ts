/**
 * `gbrain forget <id> --purge` (#5575 DX-11, DX-12): on a terminal the CLI
 * prints the dry-run receipt (residuals first) and purges only after the user
 * types the fact's token; without a terminal it needs --yes and --request-id;
 * --match lists candidates and never purges; --status reports completion.
 * In-process against real PGLite (no config file, so no resident owner).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { routesToForgetPurge, runForgetPurge } from '../src/commands/forget-purge.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';

const CLAIM = 'Garage code is 9921';
const home = mkdtempSync(join(tmpdir(), 'gbrain-forget-purge-cli-'));
let engine: PGLiteEngine;
let factId: number;

async function capture(fn: () => Promise<void>): Promise<{ out: string; err: string; code: number }> {
  const out: string[] = [], err: string[] = [];
  const o = process.stdout.write.bind(process.stdout), e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  _resetCliExitVerdictForTests();
  try { await withEnv({ GBRAIN_HOME: home }, fn); } finally { process.stdout.write = o; process.stderr.write = e; }
  return { out: out.join(''), err: err.join(''), code: currentExitCode() };
}

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await registerLocalWriter(engine, 'cli');
}), 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });
beforeEach(async () => {
  const slug = `people/${randomUUID().slice(0, 8)}-example`;
  await importFromContent(engine, slug, `---\ntitle: X\ntype: person\n---\n# X\n\n<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${CLAIM} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->\n`, { noEmbed: true, sourceId: 'default' });
  await runExtractFacts(engine, { slugs: [slug] });
  [{ id: factId }] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE entity_slug=$1', [slug]);
  factId = Number(factId);
});

describe('gbrain forget --purge', () => {
  test('terminal: prints residuals first, a wrong token cancels with exit 3, the right token purges', async () => {
    const cancelled = await capture(() => runForgetPurge(engine, [String(factId), '--purge'], { interactive: () => true, readToken: async () => 'nope' }));
    expect(cancelled.code).toBe(3);
    expect(cancelled.out.indexOf('Residuals')).toBeLessThan(cancelled.out.indexOf('Live stores'));
    expect(cancelled.out).not.toContain(CLAIM);
    expect(await engine.executeRaw('SELECT 1 FROM facts WHERE id=$1', [factId])).toHaveLength(1);
    let prompt = '';
    const done = await capture(() => runForgetPurge(engine, [String(factId), '--purge', '--json'], { interactive: () => true,
      readToken: async p => { prompt = p; return /Type ([0-9a-f]{8})/.exec(p)![1]!; } }));
    expect(prompt).toContain(`purge fact ${factId}`);
    expect([0, 10]).toContain(done.code);
    expect(await engine.executeRaw('SELECT 1 FROM facts WHERE id=$1', [factId])).toHaveLength(0);
  }, 60_000);

  test('no terminal: refuses without --yes and --request-id (exit 3); with both it purges and --status reports it', async () => {
    const refused = await capture(() => runForgetPurge(engine, [String(factId), '--purge', '--yes', '--json'], { interactive: () => false }));
    expect(refused.code).toBe(3);
    expect(await engine.executeRaw('SELECT 1 FROM facts WHERE id=$1', [factId])).toHaveLength(1);
    const requestId = randomUUID();
    const done = await capture(() => runForgetPurge(engine, [String(factId), '--purge', '--yes', '--request-id', requestId, '--json'], { interactive: () => false }));
    const receipt = JSON.parse(done.out);
    expect(receipt.request_id).toBe(requestId);
    expect(['committed', 'complete']).toContain(receipt.completion);
    const status = await capture(() => runForgetPurge(engine, ['--purge', '--status', '--request-id', requestId, '--json'], { interactive: () => false }));
    expect(JSON.parse(status.out)).toMatchObject({ request_id: requestId, state: 'committed', fingerprint_probe: { facts: 0, takes: 0 } });
  }, 60_000);

  test('--match lists candidate ids and never purges; --dry-run changes nothing', async () => {
    const listed = await capture(() => runForgetPurge(engine, ['--purge', '--match', 'garage code', '--json'], { interactive: () => false }));
    expect(JSON.parse(listed.out).candidates.map((c: { id: number }) => c.id)).toContain(factId);
    const dry = await capture(() => runForgetPurge(engine, [String(factId), '--purge', '--dry-run'], { interactive: () => false }));
    expect(dry.out).toContain('Purge dry run');
    expect(await engine.executeRaw('SELECT 1 FROM facts WHERE id=$1', [factId])).toHaveLength(1);
  }, 60_000);

  test('a plain forget with --dry-run is refused before anything changes (a dry run exists only for --purge)', async () => {
    expect(routesToForgetPurge([String(factId), '--dry-run'])).toBe(true);
    const refused = await capture(() => runForgetPurge(engine, [String(factId), '--dry-run', '--json'], { interactive: () => false }));
    expect(refused.code).not.toBe(0);
    const [row] = await engine.executeRaw<{ expired_at: unknown }>('SELECT expired_at FROM facts WHERE id=$1', [factId]);
    expect(row?.expired_at).toBeNull();
  }, 60_000);
});
