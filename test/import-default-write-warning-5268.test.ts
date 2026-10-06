/**
 * #5268: an unscoped import on a multi-source brain stays advisory (rc 0,
 * the page is imported) and the warning names the commands that scope or
 * confirm the destination. Authoring gate: (1) protects the warning text and
 * the import result; (2) fails when the warning drops the scoping commands
 * or turns into a refusal; (3) import-default-write-warn-destination pins
 * only the destination; (4) no production seam.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runImport } from '../src/commands/import.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('alpha', 'alpha') ON CONFLICT DO NOTHING");
  await engine.putPage('notes/default-example', { type: 'note', title: 'Default example', compiled_truth: 'Default.' });
  for (const slug of ['notes/alpha-one', 'notes/alpha-two', 'notes/alpha-three']) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Alpha.' }, { sourceId: 'alpha' });
  }
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

test('an unscoped import on a multi-source brain warns, names the scoping commands, and still imports', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'import-default-warning-')));
  const stderr = spyOn(console, 'error').mockImplementation(() => {});
  try {
    writeFileSync(join(root, 'beta-example.md'), '# Beta example\n');
    const result = await withEnv({ GBRAIN_SOURCE: undefined, GBRAIN_ALLOW_DEFAULT_WRITE: undefined }, () => runImport(engine, ['--no-embed', root]));
    expect(result.errors).toBe(0);
    const printed = stderr.mock.calls.map(call => call.join(' ')).join('\n');
    expect(printed).toContain("WARNING: writing to source 'default' on a multi-source brain");
    expect(printed).toContain('Pass --source-id <id>');
    expect(printed).toContain('GBRAIN_SOURCE=<id> works too');
    expect(printed).toContain('GBRAIN_ALLOW_DEFAULT_WRITE=1');
  } finally {
    stderr.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
