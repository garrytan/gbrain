/** #9521: worker sessions with a speaker sidecar that replay an owner's prompt do not make the owner's session a repeated_opening match. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { classifyAgentSessionFacts } from '../src/core/repair/agent-session-facts.ts';
import { writeSpeakerSidecar } from '../src/core/context/session-speaker.ts';

describe('#9521 replayed owner prompt', () => {
  let engine: PGLiteEngine;
  let base: string;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    base = mkdtempSync(join(tmpdir(), 'gbrain-replay-9521-'));
  });
  afterAll(async () => {
    await engine.disconnect();
    rmSync(base, { recursive: true, force: true });
  });

  test('owner session is not ambiguous when its replays carry sidecars', async () => {
    const corpus = join(base, 'corpus');
    mkdirSync(corpus, { recursive: true });
    const prompt = 'Please walk me through why the nightly export got slower this week.';
    const write = (id: string) => writeFileSync(join(corpus, `${id}.txt`), `[user]\n${prompt}\n\n[assistant]\nOk.`);
    write('sess-owner');
    for (const n of [1, 2, 3]) {
      write(`sess-replay${n}`);
      writeSpeakerSidecar(corpus, `sess-replay${n}`, { principal: 'agent-launched', source: 'detected' }, 'claude');
    }
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_session, attributed_to)
      VALUES ('default', 'people/alice-example', 'Prefers short agendas', 'preference', 'private', 'hook:writeback', 'sess-owner', 'user')`);
    const result = await classifyAgentSessionFacts(engine, ['default'], { corpusDir: corpus });
    expect(result.candidates.map(c => `${c.session}:${c.class}`)).toEqual([]);
  });
});
