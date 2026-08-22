/**
 * #4102 — end-to-end drain of the take_proposals queue over a real PGLite
 * engine: the propose_takes cycle phase PRODUCES pending proposals, and the
 * new `gbrain takes propose` surface CONSUMES them (list → accept → fence).
 *
 * Before this wave the queue had a producer and no consumer: nothing in the
 * codebase ever wrote status='accepted', so proposals accumulated forever
 * and the phase's whole output was unreachable.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseProposeTakes, type ProposeTakesExtractor } from '../src/core/cycle/propose-takes.ts';
import { runTakes } from '../src/commands/takes.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import type { OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let repo: string;

const SLUG = 'companies/drain-example';
const CLAIM = 'Drain-example doubles revenue within 12 months';

function ctx(): OperationContext {
  return {
    engine,
    config: {} as never,
    logger: { info() {}, warn() {}, error() {} } as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  repo = mkdtempSync(join(tmpdir(), 'gbrain-propose-drain-'));
  await engine.setConfig('sync.repo_path', repo);
  await engine.putPage(SLUG, {
    type: 'company',
    title: 'Drain Example',
    compiled_truth: 'I bet drain-example doubles revenue within 12 months. They ship fast.',
  });
  mkdirSync(join(repo, 'companies'), { recursive: true });
  writeFileSync(join(repo, `${SLUG}.md`), `# Drain Example\n\nprose body\n`, 'utf-8');
});

afterAll(async () => {
  await engine.disconnect();
});

describe('propose_takes → takes propose drain (#4102)', () => {
  test('phase inserts a pending proposal; CLI lists, accepts, and stamps promoted_row_num', async () => {
    // 1. Produce: run the phase with an injected extractor (no gateway).
    const extractor: ProposeTakesExtractor = async () => [
      { claim_text: CLAIM, kind: 'bet', holder: 'world', weight: 0.75, domain: 'revenue' },
    ];
    const phase = await runPhaseProposeTakes(ctx(), { extractor });
    expect(phase.status).toBe('ok');
    expect((phase.details as Record<string, unknown>).proposals_inserted).toBe(1);

    const [pending] = await engine.executeRaw<{ id: number; status: string }>(
      `SELECT id, status FROM take_proposals WHERE claim_text = $1`,
      [CLAIM],
    );
    expect(pending.status).toBe('pending');

    // 2. List: the CLI surfaces the pending proposal.
    const listed = await captureStdout(() => runTakes(engine, ['propose']));
    expect(listed).toContain(CLAIM);
    expect(listed).toContain(`#${pending.id}`);

    // 3. Accept: promotes into the markdown fence + DB mirror.
    const accepted = await captureStdout(() =>
      runTakes(engine, ['propose', '--accept', String(pending.id)]));
    expect(accepted).toContain(`Accepted proposal #${pending.id}`);

    const fence = parseTakesFence(readFileSync(join(repo, `${SLUG}.md`), 'utf-8'));
    const row = fence.takes.find((t) => t.claim === CLAIM);
    expect(row).toBeDefined();

    const [acted] = await engine.executeRaw<{ status: string; promoted_row_num: number | null }>(
      `SELECT status, promoted_row_num FROM take_proposals WHERE id = $1`,
      [pending.id],
    );
    expect(acted.status).toBe('accepted');
    expect(acted.promoted_row_num).toBe(row!.rowNum);

    // 4. The queue is drained: nothing pending remains.
    const after = await captureStdout(() => runTakes(engine, ['propose']));
    expect(after).toContain('No pending take proposals');
  });

  test('config off switch stops the phase against a real engine; --once bypasses', async () => {
    await engine.setConfig('cycle.propose_takes.enabled', 'false');
    try {
      let calls = 0;
      const extractor: ProposeTakesExtractor = async () => { calls += 1; return []; };
      const gated = await runPhaseProposeTakes(ctx(), { extractor });
      expect(gated.status).toBe('skipped');
      expect((gated.details as Record<string, unknown>).reason).toBe('disabled');
      expect(calls).toBe(0);

      const once = await runPhaseProposeTakes(ctx(), { extractor, once: true });
      expect(once.status).not.toBe('skipped');
      expect(calls).toBeGreaterThan(0);
    } finally {
      await engine.setConfig('cycle.propose_takes.enabled', 'true');
    }
  });
});
