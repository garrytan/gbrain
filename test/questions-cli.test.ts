/**
 * `gbrain questions` CLI: the human and --json renderings of the pinned-question
 * receipts, the exit verdict (1 when the answer is blocked), and engine-free
 * --help. Protects the CLI contract the docs and agents rely on (verbs, flags,
 * the next-step line). Keyless, so a pin answers awaiting_refresh /
 * no_model_key without any model call; PGLite in-memory.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runQuestions } from '../src/commands/questions.ts';
import { currentExitCode, _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv, emptyHome } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('models.standing_questions', 'anthropic:claude-sonnet-4-6');
}, 120_000);
afterAll(async () => { await engine?.disconnect(); }, 60_000);

async function cli(args: string[]): Promise<{ out: string; exit: number }> {
  _resetCliExitVerdictForTests();
  const chunks: string[] = [];
  const write = process.stdout.write;
  process.stdout.write = ((c: string | Uint8Array) => { chunks.push(String(c)); return true; }) as typeof write;
  try {
    await withEnv({ ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: emptyHome() }, () => runQuestions(engine, args));
  } finally { process.stdout.write = write; }
  return { out: chunks.join(''), exit: currentExitCode() };
}

describe('gbrain questions', () => {
  test('pin on a keyless brain keeps the pin, prints the key next step and exits 1', async () => {
    const r = await cli(['pin', 'Who leads acme-example?', '--entity', 'companies/acme-example']);
    expect(r.exit).toBe(1);
    expect(r.out).toContain('Pinned: default:questions/who-leads-acme-example-');
    expect(r.out).toContain('[awaiting_refresh]');
    expect(r.out).toContain('blocked: no_model_key');
    expect(r.out).toContain('next: gbrain providers list');
  });

  test('--json carries the receipt; list counts it; pin again is idempotent; unpin archives', async () => {
    const pinned = JSON.parse((await cli(['pin', 'Who leads acme-example?', '--entity', 'companies/acme-example', '--json'])).out);
    expect(pinned).toMatchObject({ ok: false, created: false, receipt: { freshness: 'awaiting_refresh', blocked_reason: 'no_model_key', scope: { source: 'default', entity: 'companies/acme-example' } } });
    const id = pinned.receipt.id as string;
    const list = JSON.parse((await cli(['list', '--json'])).out);
    expect(list.counts).toMatchObject({ total: 1, awaiting_refresh: 1, blocked: 1 });
    const status = await cli(['status', id]);
    expect(status.out).toContain('Q: Who leads acme-example?');
    const unpin = await cli(['unpin', id]);
    expect(unpin).toMatchObject({ exit: 0 });
    expect(unpin.out).toContain(`Unpinned ${id}`);
    expect(JSON.parse((await cli(['list', '--json'])).out).counts.total).toBe(0);
    expect(JSON.parse((await cli(['list', '--include-archived', '--json'])).out).counts.archived).toBe(1);
  });

  test('--help answers without a brain', async () => {
    const r = await runCli(['questions', '--help'], { home: emptyHome() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('pin "<question>"');
    expect(r.stdout).toContain('docs/guides/pinned-questions.md');
  });
});
