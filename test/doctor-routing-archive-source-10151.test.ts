/**
 * #10151: the conversation archive registers its target source (transcripts.archive.source, default
 * `conversations`, and its `<source>-owner` twin) before its first archived day, so the source legitimately holds no
 * pages. source_routing_health warned about it forever, and the only way to silence it was to turn the archive off.
 * Protects: an empty archive target is not a routing collapse; every other empty non-default source still warns,
 * including the default archive name once the archive points somewhere else. Real PGLite, no seams.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSourceRoutingHealth } from '../src/commands/doctor.ts';
import { ARCHIVE_SOURCE_KEY } from '../src/core/transcripts/archive.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine?.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
  await engine.executeRaw('DELETE FROM config WHERE key = $1', [ARCHIVE_SOURCE_KEY]);
});

const addSources = async (...ids: string[]) => {
  for (const id of ids) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [id]);
};

describe('#10151: source_routing_health and the conversation archive target', () => {
  test('the default archive source and its owner twin, both empty, do not warn', async () => {
    await addSources('conversations', 'conversations-owner');
    const check = await checkSourceRoutingHealth(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toContain('conversations');
  });

  test('a configured archive source is the one exempted', async () => {
    await engine.setConfig(ARCHIVE_SOURCE_KEY, 'chats-example');
    await addSources('chats-example', 'conversations');
    const check = await checkSourceRoutingHealth(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('1 non-default source(s) have zero pages: conversations.');
  });

  test('any other empty source still warns beside the archive target', async () => {
    await addSources('conversations', 'notes-example');
    const check = await checkSourceRoutingHealth(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('zero pages: notes-example.');
  });
});
