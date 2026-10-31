import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { adoptSharedSkillpack } from '../src/core/shared-skills/publication.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';

test('packaged adoption keys bind exact payloads and preserve exact replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-idempotency-7734-'));
  await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined }, async () => {
    const isolated = await isolatedSharedSkillsEngine();
    const { engine } = isolated;
    try {
      const root = join(dir, 'source'); mkdirSync(root);
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
      await claimWorktree(engine, 'default', root);
      await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
      await engine.setConfig('mcp.publish_skills', 'true');
      const ctx: OperationContext = { engine, config: { engine: 'pglite' }, sourceId: 'default', remote: false,
        dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      const options = (body: string) => ({ request_id: 'gbrain-default-content-v1', pack_id: 'gbrain-memory',
        initial_files: { 'skillpack.json': '{"name":"gbrain-memory","brain_resident":true,"skills":["skills/alpha"]}', 'skills/alpha/SKILL.md': body },
        skills: [{ pack_id: 'gbrain-memory', name: 'alpha', expected_revision: null, files: [{ path: 'skills/alpha/SKILL.md', content: body, file_class: 'prose' as const }] }] });
      const first = await adoptSharedSkillpack(ctx, 'default', options('Original packaged instructions'));
      const replay = await adoptSharedSkillpack(ctx, 'default', options('Original packaged instructions'));
      await expect(adoptSharedSkillpack(ctx, 'default', options('Changed packaged instructions')))
        .rejects.toMatchObject({ code: 'revision_conflict' });
      expect(replay.receipts[0]!.request_id).toBe(first.receipts[0]!.request_id);
    } finally { await disposePersistenceConsumer(engine); await isolated.close(); }
  });
  rmSync(dir, { recursive: true, force: true });
}, 120_000);
