/**
 * Protects per-entity assistant reporting past recall's 100-row cap. Without
 * the aggregate, doctor reports healthy capture despite recorded assistant
 * claims. Existing repair tests cover self-capture and paste detection only.
 * Uses isolated real storage; no additional production seam.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { capturedFactsCheck } from '../src/commands/doctor/checks/captured-facts.ts';

let engine: PGLiteEngine;
const root = mkdtempSync(join(tmpdir(), 'capture-quality-'));
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'Other')");
  for (let n = 0; n < 125; n++) {
    await engine.insertFact({ fact: `Project observation ${n}`, entity_slug: 'projects/example',
      source: 'test', attributed_to: n < 50 ? 'assistant' : n < 100 ? 'user' : null }, { source_id: 'default' });
  }
  for (const kind of ['expired', 'lapsed']) {
    const row = await engine.insertFact({ fact: `Retired claim ${kind}`, entity_slug: 'projects/example',
      source: 'test', attributed_to: 'assistant' }, { source_id: 'default' });
    await engine.executeRaw(kind === 'expired'
      ? 'UPDATE facts SET expired_at = now() WHERE id = $1'
      : "UPDATE facts SET valid_until = '2000-01-01' WHERE id = $1", [row.id]);
  }
  await engine.insertFact({ fact: 'Another source claim', entity_slug: 'projects/example',
    source: 'test', attributed_to: 'assistant' }, { source_id: 'other' });
}, 120_000);
afterAll(async () => {
  await engine?.disconnect();
  rmSync(root, { recursive: true, force: true });
});

test('reports the full active share per source and entity without changing facts or checkpoints', async () => {
  const before = await engine.executeRaw('SELECT * FROM facts ORDER BY id');
  const cursors = await engine.executeRaw('SELECT * FROM op_checkpoints');
  const opts = { projectsRoot: root, corpusDir: null };
  const result = await capturedFactsCheck(engine, ['default'], opts);
  expect(result.status).toBe('warn');
  expect(result.message).toContain('default:projects/example: 50/125 active facts attributed to the assistant (40.0%).');
  expect(result.message).not.toContain('other:');
  const other = await capturedFactsCheck(engine, ['other'], opts);
  expect(other.message).toContain('other:projects/example: 1/1 active facts attributed to the assistant (100.0%).');
  expect(other.message).not.toContain('default:');
  expect((await capturedFactsCheck(engine, [], opts)).status).toBe('ok');
  expect(await engine.executeRaw('SELECT * FROM facts ORDER BY id')).toEqual(before);
  expect(await engine.executeRaw('SELECT * FROM op_checkpoints')).toEqual(cursors);
});
