/**
 * #9027: a fenced fact on a page stored in segments is not rewritten by `repair agent-session-facts`, and the apply
 * must say so instead of reporting `changed_since_preview` for a page that did not change.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { writeSpeakerSidecar } from '../src/core/context/session-speaker.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const SLUG = 'companies/segmented-example';

describe('repair agent-session-facts on a segmented page (#9027)', () => {
  let engine: PGLiteEngine;
  let base: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => {
    await engine.disconnect();
    if (base) rmSync(base, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    base = mkdtempSync(join(tmpdir(), 'gbrain-asf-9027-'));
    const corpus = join(base, 'corpus');
    mkdirSync(corpus, { recursive: true });
    writeFileSync(join(corpus, 'sess-a.txt'), '[user]\nPlease triage the open issues.\n\n[assistant]\nOn it.');
    writeSpeakerSidecar(corpus, 'sess-a', { principal: 'worker-a', source: 'env' }, 'claude');
    await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
  });

  test('apply names the segmented page instead of reporting a change since the preview', async () => {
    await engine.putPage(SLUG, { type: 'company', title: 'Segmented Example', compiled_truth: '# Segmented Example' }, { sourceId: 'default' });
    const [fact] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_session, attributed_to, row_num)
        VALUES ('default', $1, 'Prefers terse updates', 'preference', 'private', 'hook:writeback', 'sess-a', 'user', 1) RETURNING id`, [SLUG]);
    await engine.executeRaw("UPDATE pages SET body_storage='segmented', compiled_truth=NULL, timeline=NULL, body_bytes=1 WHERE source_id='default' AND slug=$1", [SLUG]);

    const run = async (args: string[]) => {
      const lines: string[] = [];
      const original = console.log;
      console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
      try { await runRepairCommand(engine, ['agent-session-facts', ...args, '--json']); } finally { console.log = original; }
      return JSON.parse(lines.join('\n')) as { results: Array<{ apply_command: string; outcomes?: Record<string, number>;
        outcome_items?: Array<{ outcome: string; reason?: string }> }> };
    };
    const preview = await run([]);
    const applied = await run(preview.results[0].apply_command.split(' ').slice(3));
    const outcome = applied.results[0].outcome_items?.[0];
    expect(Object.keys(applied.results[0].outcomes ?? {})).not.toContain('changed_since_preview');
    expect(outcome?.reason ?? '').toContain('segments');
    expect(Number(fact!.id)).toBeGreaterThan(0);
  }, 60_000);
});
