/**
 * GST-2312 (#9024) on a company-brain source, which never holds: a committed file a Git filter owns stops the managed
 * connect with content_filter_owned, nothing imports it, and neither the filter nor `core.fsmonitor` runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { inspectCompanyBrain } from '../src/core/company-brain/inspection.ts';
import { connectCompanyBrain } from '../src/core/company-brain/runtime.ts';
import { __setCheckAttrSourceForTests } from '../src/core/persistence/sync-blobs.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-company-9024-'));
const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-C', root, ...args], { encoding: 'utf8' }).trim();
beforeAll(async () => {
  if (backends.includes('pglite')) { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engines.push(pglite); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

for (const backend of backends) describe('[' + backend + '] a company-brain source with a Git-filtered file (#9024)', () => {
  for (const source of [true, false]) test('the managed connect stops with content_filter_owned; no filter and no fsmonitor runs (' + (source ? 'check-attr --source' : 'git before 2.40: a temporary index') + ')', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const restore = __setCheckAttrSourceForTests(source);
    try {
      const engine = engines[backends.indexOf(backend)]!;
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const root = mkdtempSync(join(home, 'repo-')), bin = mkdtempSync(join(home, 'bin-')), marker = join(bin, 'ran');
      writeFileSync(join(bin, 'clean'), '#!/bin/sh\ntouch ' + marker + '.clean\nbase64\n');
      writeFileSync(join(bin, 'smudge'), '#!/bin/sh\ntouch ' + marker + '.smudge\nbase64 -d\n');
      writeFileSync(join(bin, 'fsmonitor'), '#!/bin/sh\ntouch ' + marker + '.fsmonitor\nexit 1\n');
      for (const name of ['clean', 'smudge', 'fsmonitor']) chmodSync(join(bin, name), 0o755);
      git(root, 'init', '-q');
      git(root, 'config', 'filter.secret.clean', join(bin, 'clean')); git(root, 'config', 'filter.secret.smudge', join(bin, 'smudge'));
      writeFileSync(join(root, '.gitattributes'), 'customers/secret.md filter=secret\n');
      mkdirSync(join(root, 'people')); mkdirSync(join(root, 'customers'));
      writeFileSync(join(root, 'people/operator.md'), '---\ntype: person\ntitle: Example Operator\n---\n# Example Operator\nOwns the account.\n');
      writeFileSync(join(root, 'customers/secret.md'), '---\ntype: customer\ntitle: Example Secret\n---\n# Example Secret\nA synthetic account.\n');
      git(root, 'add', '-A'); git(root, 'commit', '-qm', 'Synthetic source fixture');
      expect(existsSync(marker + '.clean')).toBe(true);
      // A checkout where the filter never ran on checkout (a server clone without the key) holds the stored bytes.
      writeFileSync(join(root, 'customers/secret.md'), execFileSync('git', ['-C', root, 'cat-file', 'blob', 'HEAD:customers/secret.md']));
      git(root, 'config', 'core.fsmonitor', join(bin, 'fsmonitor'));
      const plan = await inspectCompanyBrain({ path: root, profile: 'company-brain' });
      expect(plan.ready).toBe(true);
      const sourceId = 'company-' + randomUUID().slice(0, 8);
      const result = await connectCompanyBrain(engine, { brainId: 'company-example', sourceId, path: root, plan, remote: false, requestId: randomUUID() });
      expect(result).toMatchObject({ ok: false, code: 'content_filter_owned' });
      expect(await engine.getPage('customers/secret', { sourceId })).toBeNull();
      expect(existsSync(marker + '.smudge')).toBe(false);
      expect(existsSync(marker + '.fsmonitor')).toBe(false);
    } finally { restore(); }
  }), 120_000);
});
