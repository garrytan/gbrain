import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { adoptSharedSkillpack } from '../src/core/shared-skills/publication.ts';
import { listSharedSkills } from '../src/core/shared-skills/catalog.ts';
import { packagedSharedSkills } from '../src/core/shared-skills/setup-bundle.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';

// #7734: the packaged pack is adopted under a fixed request_id. The adoption
// key must be bound to the payload: an exact replay resumes the same durable
// request, while a different release payload (or a different preserved
// README/LICENSE set) never reuses a key an earlier payload was admitted under.

interface Fixture { engine: BrainEngine; local: OperationContext; reader: OperationContext }
async function fixture(run: (f: Fixture) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-packaged-key-7734-'));
  await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined }, async () => {
    const isolated = await isolatedSharedSkillsEngine();
    const engine = isolated.engine;
    try {
      const root = join(dir, 'default'); mkdirSync(root);
      await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
      await claimWorktree(engine, 'default', root);
      await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
      await engine.setConfig('mcp.publish_skills', 'true');
      const local: OperationContext = { engine, config: { engine: 'pglite' }, remote: false, sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      const operations = ['list_skills', 'get_skill'];
      await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,allowed_operations) VALUES('reader','Synthetic reader','read','default',$1::text[])`, [operations]);
      const reader: OperationContext = { ...local, remote: true, auth: { token: 'synthetic', clientId: 'reader', principal: { kind: 'oauth_client', id: 'reader' }, scopes: ['read'], sourceId: 'default', allowedOperations: operations } } as OperationContext;
      await run({ engine, local, reader });
    } finally { await disposePersistenceConsumer(engine); await isolated.close(); }
  });
  rmSync(dir, { recursive: true, force: true });
}

function packaged(edit?: (files: Record<string, string>) => void) {
  const initial_files = packagedSharedSkills();
  edit?.(initial_files);
  const paths: string[] = JSON.parse(initial_files['skillpack.json']).skills;
  return { request_id: 'gbrain-default-content-v1', pack_id: 'gbrain-memory', initial_files,
    skills: paths.map((path) => ({ pack_id: 'gbrain-memory', name: path.slice(7), expected_revision: null,
      files: [{ path: `${path}/SKILL.md`, content: initial_files[`${path}/SKILL.md`], file_class: 'prose' as const }] })) };
}

/** Admits the adoption, then fails its canonical apply, leaving the accepted request uncommitted (host work pending). */
function interrupted(ctx: OperationContext): OperationContext {
  const failing = new Proxy(ctx.engine, { get(target, key) {
    if (key === 'transaction') return async (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction((real) => fn(new Proxy(real, { get(tx, prop) {
      if (prop === 'executeRaw') return async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO shared_skill_revisions')) throw new Error('synthetic storage interruption');
        return tx.executeRaw(sql, params);
      };
      const value = Reflect.get(tx, prop); return typeof value === 'function' ? value.bind(tx) : value;
    } })));
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { ...ctx, engine: failing };
}

const requestIds = async (engine: BrainEngine) => (await engine.executeRaw<{ request_id: string }>(
  "SELECT request_id FROM persistence_requests WHERE operation='put_skill' ORDER BY request_id")).map((r) => r.request_id);

test('a changed packaged payload gets its own adoption key instead of idempotency_conflict', () => fixture(async (f) => {
  const older = packaged((files) => { files['skills/memory-recall/SKILL.md'] += '\nOlder release wording.\n'; });
  const broken = interrupted(f.local);
  await adoptSharedSkillpack(broken, 'default', older).catch(() => undefined);
  await disposePersistenceConsumer(broken.engine);
  await disposePersistenceConsumer(f.engine);
  const admitted = await requestIds(f.engine);
  expect(admitted).toHaveLength(1);
  const current = packaged();
  const result = await adoptSharedSkillpack(f.local, 'default', current);
  expect(result.receipts).toHaveLength(1);
  expect((await listSharedSkills(f.reader)).skills.length).toBeGreaterThan(0);
  expect((await requestIds(f.engine)).filter((id) => !admitted.includes(id))).toHaveLength(1);
}), 120_000);

test('an exact replay of the packaged payload resumes the same request', () => fixture(async (f) => {
  const first = await adoptSharedSkillpack(f.local, 'default', packaged());
  const replay = await adoptSharedSkillpack(f.local, 'default', packaged());
  expect(replay.receipts[0].revision).toBe(first.receipts[0].revision);
  expect(await requestIds(f.engine)).toHaveLength(1);
}), 120_000);
