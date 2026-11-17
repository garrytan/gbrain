/** A capture-lane fact whose session id names a Codex rollout is classified, not left unclassifiable. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { classifyCapturedFacts } from '../src/core/repair/captured-facts.ts';
import { withEnv } from './helpers/with-env.ts';

const CODEX_ID = '0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';

describe('captured-facts classifier reads Codex rollouts', () => {
  let engine: PGLiteEngine;
  const base = mkdtempSync(join(tmpdir(), 'gbrain-captured-codex-'));
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); rmSync(base, { recursive: true, force: true }); });

  test('session id matching a Codex rollout is not_suspect; an unknown id stays unclassifiable', async () => {
    const day = join(base, 'codex', 'sessions', '2026', '01', '02');
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, `rollout-2026-01-02T03-04-05-${CODEX_ID}.jsonl`), '{}\n');
    mkdirSync(join(base, 'claude', 'projects'), { recursive: true });
    for (const [fact, session] of [['Alice likes tea', CODEX_ID], ['Bob likes jam', 'no-such-session']]) {
      await engine.executeRaw(`INSERT INTO facts (source_id, fact, kind, visibility, source, source_session)
        VALUES ('default', $1, 'fact', 'private', 'hook:writeback', $2)`, [fact, session]);
    }
    const result = await withEnv({ CODEX_HOME: join(base, 'codex'), CLAUDE_CONFIG_DIR: join(base, 'claude') },
      () => classifyCapturedFacts(engine, ['default'], { corpusDir: null }));
    expect({ not_suspect: result.not_suspect, unclassifiable: result.unclassifiable }).toEqual({ not_suspect: 1, unclassifiable: 1 });
  }, 120_000);
});
