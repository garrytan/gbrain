/**
 * #9889: gbrain access rule import --file <missing path> surfaced the raw ENOENT as an internal error, so a caller
 * could not tell from the structured response that the fix was to pass an existing file.
 *
 * 1. Protects: a missing --file is invalid_params naming the path, and nothing is written.
 * 2. Fails when: the import reads the file without mapping ENOENT.
 * 3. Real seams: the gbrain access rule CLI module on a repo-less PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';

let engine: PGLiteEngine;
let dir: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  dir = mkdtempSync(join(tmpdir(), 'gbrain-access-import-'));
});
afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

describe('access rule import with a missing file (#9889)', () => {
  test('is invalid_params naming the path, and writes no rule', async () => {
    const missing = join(dir, 'nope', 'access.yml');
    const before = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM access_policy_revisions');
    let err: { code?: string; message?: string } | undefined;
    try { await runAccessRules(engine, 'rule', ['import', '--file', missing], false); } catch (e) { err = e as typeof err; }
    expect(err?.code).toBe('invalid_params');
    expect(err?.message).toContain(missing);
    const after = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM access_policy_revisions');
    expect(after).toEqual(before);
  });
});
