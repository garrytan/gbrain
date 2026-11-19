/**
 * `foresights jobs submit enrich|subagent` asks for consent like the producing
 * commands, so the consent payload of `enrich --background` has no
 * unconsented alternative.
 *
 * Protects: without authorization a non-TTY submit exits 3 with the consent
 * payload and queues nothing; with `--yes` the row carries an `authorized`
 * record (never in job data); `--dry-run` needs no consent.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCli } from './helpers/cli-spawn.ts';

let home: string;
let brainPath: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-jobs-submit-consent-'));
  brainPath = join(home, '.gbrain', 'brain.pglite');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: brainPath, embedding_disabled: true }));
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: brainPath });
  await engine.initSchema();
  await engine.disconnect();
}, 120_000);

afterAll(() => rmSync(home, { recursive: true, force: true }));

async function queued(): Promise<Array<{ name: string; spend_authorization: Record<string, unknown> | null; data: Record<string, unknown> }>> {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: brainPath });
  try {
    return await engine.executeRaw(`SELECT name, spend_authorization, data FROM minion_jobs ORDER BY id`);
  } finally { await engine.disconnect(); }
}

const submit = (...args: string[]) => runCli(['jobs', 'submit', ...args], { home, env: { GBRAIN_INTERACTIVE: undefined }, timeoutMs: 90_000 });

describe('jobs submit consent for paid job names', () => {
  test('non-TTY enrich without --yes exits 3 with the consent payload and queues nothing', async () => {
    const r = await submit('enrich', '--params', '{"sourceId":"default"}', '--queue-only', '--json');
    expect(r.exitCode).toBe(3);
    const payload = JSON.parse(r.stdout);
    expect(payload).toMatchObject({ code: 'confirmation_required', effects: ['paid'], est_usd: 0.5 });
    expect(payload.fix.argv).toContain('--yes');
    expect(await queued()).toEqual([]);
  }, 120_000);

  test('subagent without --yes is refused the same way', async () => {
    const r = await submit('subagent', '--params', '{"prompt":"x","model":"anthropic:claude-sonnet-5"}', '--queue-only', '--json');
    expect(r.exitCode).toBe(3);
    expect(JSON.parse(r.stdout).risk).toContain('$5 cap');
    expect(await queued()).toEqual([]);
  }, 120_000);

  test('--dry-run needs no consent and queues nothing', async () => {
    const r = await submit('enrich', '--params', '{"sourceId":"default"}', '--dry-run');
    expect(r.exitCode).toBe(0);
    expect(await queued()).toEqual([]);
  }, 120_000);

  test('--yes queues the job with an authorized record on the row', async () => {
    const r = await submit('enrich', '--params', '{"sourceId":"default","limit":10}', '--queue-only', '--yes');
    expect(r.exitCode).toBe(0);
    const rows = await queued();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.spend_authorization).toMatchObject({ kind: 'authorized', command: 'jobs submit enrich', cap_usd: 0.25, cap_source: 'derived', est_usd: 0.1, of: 1 });
    expect(rows[0]!.data).not.toHaveProperty('spend_authorization');
  }, 120_000);
});
