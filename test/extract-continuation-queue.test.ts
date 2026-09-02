/**
 * Documents CM3 (e) of the brain-plane repair plan: when a queued `extract`
 * stale sweep hits its internal budget with work remaining, the handler
 * chains ONE continuation job and does not name a queue, so the continuation
 * lands on the DEFAULT queue: whichever worker drains `--queue default`
 * (the Modal worker lane) picks it up. A dedicated-queue submitter must
 * expect its continuations there.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

describe('extract stale-sweep continuation', () => {
  test('the continuation add names no queue (structural pin on jobs.ts)', () => {
    // test-reads-source-ok: pins the continuation add's option shape (no queue key); the behavioral half is the PGLite test below
    const src = readFileSync(new URL('../src/commands/jobs.ts', import.meta.url), 'utf8');
    const m = src.match(/await queue\.add\(\s*'extract',\s*\{ \.\.\.job\.data, continuation_of: job\.id \},\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    const opts = m![1];
    expect(opts).toContain('timeout_ms');
    expect(opts).not.toContain('queue');
  });

  describe('MinionQueue.add without a queue option lands on default (PGLite)', () => {
    let engine: PGLiteEngine;
    beforeAll(async () => {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      // No resetPgliteState here: it truncates the config table (schema
      // version row) and MinionQueue then refuses the minion_jobs table.
    }, 30_000);
    afterAll(async () => { await engine.disconnect(); });

    test('queue column reads default', async () => {
      const queue = new MinionQueue(engine);
      const job = await queue.add('extract', { stale: true, continuation_of: 1 }, { timeout_ms: 60_000 });
      const rows = await engine.executeRaw<{ queue: string }>(`SELECT queue FROM minion_jobs WHERE id = $1`, [job.id]);
      expect(rows[0]?.queue).toBe('default');
    });
  });
});
