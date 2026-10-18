/**
 * Managed-brain builder for the cycle-phase pathological cases (GBRA-130
 * A-21, A-22): a fresh engine per arm, one source whose worktree this host
 * owns, seeded through ordinary page writes while persistence is off, then
 * switched to managed mode so the phase under test publishes through the
 * coordinator exactly as it does in production.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';

export interface ManagedSource { engine: BrainEngine; sourceId: string; root: string; put(slug: string, content: string): Promise<void> }

export async function managedSource(databaseUrl: string | undefined, seed: (s: ManagedSource) => Promise<void>, run: (s: ManagedSource) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-pathological-managed-'));
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      const root = join(dir, 'brain'); mkdirSync(root);
      const sourceId = `patho-${randomUUID().slice(0, 8)}`;
      try {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
          dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        const source: ManagedSource = { engine, sourceId, root, put: async (slug, content) => {
          const prior = await engine.readPageSnapshot(slug, { sourceId });
          await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID(),
            ...(prior ? { expected_revision: prior.revision } : {}) } });
        } };
        await seed(source);
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run(source);
      } finally {
        await disposePersistenceConsumer(engine);
        await close();
      }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export const FACTS_FENCE = (rows: string) => `## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
<!--- gbrain:facts:end -->
`;
export const PERSON = (title: string, body = '', extra = '') => `---\ntitle: ${title}\ntype: person\n${extra}---\n# ${title}\n\n${body}`;
