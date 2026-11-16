/**
 * #9469: doctor `purge_mirror` warns when a purge of the last 30 days has no line in the purge mirror of this process's
 * config directory (a writer run in a throwaway home), names the mirror path and counts only, and is quiet when the
 * mirror holds every recent purge or when the only purges are older than the window. Never a failure.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PURGE_MIRROR_FILE } from '../src/core/belief/purge-mirror.ts';
import { checkPurgeMirror } from '../src/commands/doctor/checks/purge-mirror.ts';

const SLUG = 'notes/purged-mirror-example';

describe('doctor purge_mirror', () => {
  let engine: PGLiteEngine;
  const root = mkdtempSync(join(tmpdir(), 'gbrain-purge-mirror-'));
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); rmSync(root, { recursive: true, force: true }); });

  const home = (lines: object[]) => {
    const dir = join(root, randomUUID().slice(0, 8));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{}');
    if (lines.length) writeFileSync(join(dir, PURGE_MIRROR_FILE), lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    return dir;
  };

  test('no recent purge: ok; an old purge outside the window: ok', async () => {
    expect((await checkPurgeMirror(engine, home([]))).status).toBe('ok');
    await engine.executeRaw(`INSERT INTO page_purges (source_id, content_hash, slug, request_id, purged_at) VALUES ('default', 'hash-old-example', $1, $2::uuid, now() - interval '40 days')`,
      [SLUG, randomUUID()]);
    const check = await checkPurgeMirror(engine, home([]));
    expect(check.status).toBe('ok');
    expect(check.details).toMatchObject({ recent: 0, missing: 0 });
  });

  test('a recent purge the mirror lacks warns with counts and the fix, never the slug; the mirror that holds it is ok', async () => {
    const request = randomUUID();
    await engine.executeRaw(`INSERT INTO page_purges (source_id, content_hash, slug, request_id) VALUES ('default', 'hash-new-example', $1, $2::uuid)`, [SLUG, request]);
    await engine.executeRaw(`INSERT INTO fact_purges (source_id, visibility, subject, fact_hash, request_id, actor, reason) VALUES ('default', 'world', $1, 'fp-example', $2::uuid, 'cli:owner-example', 'page purge')`,
      [SLUG, request]);
    const empty = home([]);
    const warned = await checkPurgeMirror(engine, empty);
    expect(warned.status).toBe('warn');
    expect(warned.details).toMatchObject({ recent: 1, missing: 1, readable: true });
    expect(warned.message).toContain('GBRAIN_HOME');
    expect(warned.message).toContain(join(empty, PURGE_MIRROR_FILE));
    expect(JSON.stringify(warned)).not.toContain(SLUG);
    expect(JSON.stringify(warned)).not.toContain(request);
    const held = await checkPurgeMirror(engine, home([{ kind: 'intent', request, request_id: randomUUID(), source_id: 'default', scope: 'page', recorded_at: new Date().toISOString() },
      { kind: 'committed', request, recorded_at: new Date().toISOString() }]));
    expect(held.status).toBe('ok');
    expect(held.details).toMatchObject({ recent: 1, missing: 0 });
  });

  test('a home with no brain config and no mirror reads as unavailable and still only warns', async () => {
    const gone = join(root, 'missing-home');
    const check = await checkPurgeMirror(engine, gone);
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ missing: 1, readable: false });
  });
});
