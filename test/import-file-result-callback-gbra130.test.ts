/**
 * GBRA-130 A-66 (#6712 PR 4b): `runImport` awaited the caller's `onFileResult` callback bare, both for a file's result
 * and inside the catch that turns a thrown import into a per-file failure. A callback that threw (full sync's hold
 * bookkeeping) escaped processFile and rejected the whole import, so one file's bookkeeping failure stopped every file.
 *
 * Protects (red before: runImport rejects with the callback's error): a throwing callback is logged and the file is
 * counted by its own outcome (an imported page stays imported, a refused or thrown import is a failure ledger row);
 * the other files import. Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';
import * as importFileModule from '../src/core/import-file.ts';
import { PAGE_MAX_BYTES } from '../src/core/page-size-policy.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

for (const backend of backends) test(`[${backend}] a throwing onFileResult counts that file by its own outcome; the import resolves and the other files import`, async () => {
  const engine = engines[backends.indexOf(backend)]!;
  const repo = mkdtempSync(join(tmpdir(), 'gbrain-a66-'));
  execFileSync('git', ['-C', repo, 'init', '-q']);
  writeFileSync(join(repo, 'alpha.md'), '---\ntype: note\n---\n# Alpha\n\nbody\n');
  writeFileSync(join(repo, 'boom.md'), '---\ntype: note\n---\n# Boom\n\nbody\n');
  writeFileSync(join(repo, 'huge.md'), '---\ntype: note\n---\n' + 'x'.repeat(PAGE_MAX_BYTES + 1));
  writeFileSync(join(repo, 'zeta.md'), '---\ntype: note\n---\n# Zeta\n\nbody\n');
  execFileSync('git', ['-C', repo, 'add', '-A']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed']);
  const real = importFileModule.importFile;
  const thrower = spyOn(importFileModule, 'importFile').mockImplementation((async (...args: Parameters<typeof real>) => {
    if (String(args[2]).endsWith('boom.md')) throw new Error('simulated import failure');
    return await real(...args);
  }) as typeof real);
  const logged: string[] = [];
  const err = spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { logged.push(parts.map(String).join(' ')); });
  const seen: string[] = [];
  try {
    const result = await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-a66-home-')) }, () => runImport(engine, [repo, '--no-embed', '--json'], {
      managedBookmark: true,
      onFileResult: async path => { seen.push(path); throw new Error('simulated hold bookkeeping failure'); },
    }));
    expect(seen.sort()).toEqual(['alpha.md', 'boom.md', 'huge.md', 'zeta.md']);
    expect(result.imported).toBe(2);
    expect(result.failures.map(f => f.path).sort()).toEqual(['boom.md', 'huge.md']);
    expect(logged.some(line => line.includes('could not record the outcome of boom.md'))).toBe(true);
    expect((await engine.getPage('zeta'))?.title).toBe('Zeta');
  } finally {
    thrower.mockRestore();
    err.mockRestore();
  }
}, 120_000);
