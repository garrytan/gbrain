import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { seedBrainForAgent } from './helpers/agent-harness.ts';
import { withEnv } from './helpers/with-env.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';

test('agent fixture inside a Git-initialized home publishes to a separate canonical worktree and reopens', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-agent-seed-'));
  const sourceId = 'workspace';
  const slug = 'notes/seed-example';
  const fact = 'The synthetic fixture uses the sample storage room.';
  try {
    execFileSync('git', ['init', '-q', home]);
    await withEnv({ GBRAIN_HOME: home, HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await seedBrainForAgent(home, sourceId, { slug, entity: 'Fixture Example', fact });
      // A second distinct seed exercises the existing-source path without
      // swallowing admission, ownership or storage failures.
      await seedBrainForAgent(home, sourceId, { slug: 'notes/second-example', entity: 'Second Fixture', fact });
      const engine = new PGLiteEngine();
      await engine.connect({ engine: 'pglite', database_path: join(home, '.gbrain/brain.pglite') });
      try {
        const page = await engine.getPage(slug, { sourceId });
        expect(page?.compiled_truth).toContain(fact);
        expect(page?.knowledge_revision).toMatch(/^[0-9a-f-]{36}$/i);
        const binding = await getWorktreeBinding(engine, sourceId);
        const root = realpathSync(join(home, `source-${sourceId}`));
        expect(binding?.local_path).toBe(root);
        expect(relative(root, binding!.coordination_path!)).toStartWith('..');
        expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain(fact);
        const requests = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId]);
        expect(requests.map(row => row.state)).toEqual(['committed', 'committed']);
      } finally { await engine.disconnect(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 60_000);
