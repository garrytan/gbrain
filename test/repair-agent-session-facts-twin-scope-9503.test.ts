/**
 * #9503: the agent-session-facts preview timed out on a large brain.
 *
 * Protects: the owner-twin lookup (a fingerprint scan of the source's facts per row) runs only for the facts of suspect
 * sessions, so a fact of a session that is not suspect never pays for it.
 * Fails when: the classification query computes the twin lookup for every capture-lane fact.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { classifyAgentSessionFacts } from '../src/core/repair/agent-session-facts.ts';
import { writeSpeakerSidecar } from '../src/core/context/session-speaker.ts';

describe('agent-session-facts twin lookup scope (#9503)', () => {
  let engine: PGLiteEngine;
  let base: string;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    base = mkdtempSync(join(tmpdir(), 'gbrain-asf-9503-'));
  });
  afterAll(async () => {
    await engine.disconnect();
    rmSync(base, { recursive: true, force: true });
  });

  test('only facts of suspect sessions reach the twin lookup', async () => {
    const corpus = join(base, 'corpus');
    mkdirSync(corpus, { recursive: true });
    writeFileSync(join(corpus, 'sess-sidecar.txt'), '[user]\nPlease triage the open issues for the docs lane.\n\n[assistant]\nOn it.');
    writeFileSync(join(corpus, 'sess-owner.txt'), '[user]\nAlice Example and I talked about the launch plan today.\n\n[assistant]\nOn it.');
    writeSpeakerSidecar(corpus, 'sess-sidecar', { principal: 'worker-a', source: 'env' }, 'claude');
    const insert = async (fact: string, session: string) => Number((await engine.executeRaw<{ id: number }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_session, attributed_to)
        VALUES ('default', 'people/alice-example', $1, 'preference', 'private', 'hook:writeback', $2, 'user') RETURNING id`, [fact, session]))[0]!.id);
    const suspect = await insert('Prefers terse status updates', 'sess-sidecar');
    await insert('Is planning the launch', 'sess-owner');

    const spy = spyOn(engine, 'executeRaw');
    let result: Awaited<ReturnType<typeof classifyAgentSessionFacts>>;
    let calls: unknown[][];
    try { result = await classifyAgentSessionFacts(engine, ['default'], { corpusDir: corpus }); calls = [...spy.mock.calls]; } finally { spy.mockRestore(); }
    const lookups = calls.filter(([sql]) => String(sql).includes('gbrain_fact_fingerprint'));
    const scoped = lookups.flatMap(([, params]) => (params as unknown[]).filter(p => Array.isArray(p) && p.length > 0 && p.every(x => typeof x === 'number')));
    expect(result.candidates.map(c => c.id)).toEqual([suspect]);
    expect(result.not_suspect).toBe(1);
    expect(scoped).toEqual([[suspect]]);
  });
});
