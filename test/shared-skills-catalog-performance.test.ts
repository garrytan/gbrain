import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpus } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { getSharedSkill, listSharedSkills } from '../src/core/shared-skills/catalog.ts';
import { normalizeSkillFiles, skillMetadata } from '../src/core/shared-skills/manifest.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';

test.skipIf(process.env.GBRAIN_TEST_SHARED_SKILLS_BENCHMARK !== '1')('measure sealed projection reads at 10/100/1000 skills', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-shared-benchmark-'));
  await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined }, async () => {
    const { engine, close } = await isolatedSharedSkillsEngine();
    try {
      const root = join(dir, 'content'); mkdirSync(root);
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
      await claimWorktree(engine, 'default', root);
      await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
      await engine.setConfig('mcp.publish_skills', 'true');
      const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
      let calls = 0;
      const observed = (target: BrainEngine): BrainEngine => new Proxy(target, { get(value, key) {
        if (key === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => value.transaction(tx => fn(observed(tx)));
        const member = Reflect.get(value, key);
        if (key === 'executeRaw' || key === 'getConfig') return (...args: unknown[]) => { calls++; return member.apply(value, args); };
        return typeof member === 'function' ? member.bind(value) : member;
      } });
      const ctx: OperationContext = { engine: observed(engine), config: { engine: 'pglite' }, remote: false,
        sourceId: 'default', dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      const samples: unknown[] = [];
      for (const size of [10, 100, 1000]) {
        const rows = Array.from({ length: size }, (_, index) => {
          const name = `fixture-${String(index).padStart(4, '0')}`;
          const files = normalizeSkillFiles(name, [{ path: `skills/${name}/SKILL.md`, content: `---\nname: ${name}\n---\nSynthetic benchmark instructions.`, file_class: 'prose' }]);
          return { name, revision: randomUUID(), metadata: skillMetadata(name, files, {}), files };
        });
        await engine.transaction(async tx => {
          await declarePersistenceProtocol(tx);
          await withCoordinatedWrite(tx, ['default'], async () => {
            await tx.executeRaw('DELETE FROM shared_skill_heads'); await tx.executeRaw('DELETE FROM shared_skill_revisions');
            await tx.executeRaw(`INSERT INTO shared_skill_heads(source_id,source_incarnation,pack_id,name,revision,metadata,policy_epoch)
              SELECT 'default',$1::uuid,'benchmark',r.name,r.revision,r.metadata,'legacy-prose'
              FROM jsonb_to_recordset($2::text::jsonb) AS r(name text,revision uuid,metadata jsonb,files jsonb)`, [source.incarnation, JSON.stringify(rows)]);
            await tx.executeRaw(`INSERT INTO shared_skill_revisions(source_id,source_incarnation,pack_id,name,revision,metadata,files,policy_epoch,request_id)
              SELECT 'default',$1::uuid,'benchmark',r.name,r.revision,r.metadata,r.files,'legacy-prose',$3::uuid
              FROM jsonb_to_recordset($2::text::jsonb) AS r(name text,revision uuid,metadata jsonb,files jsonb)`, [source.incarnation, JSON.stringify(rows), randomUUID()]);
          });
        });
        const rssBefore = process.memoryUsage().rss;
        calls = 0;
        const start = performance.now();
        let cursor: string | undefined; let count = 0; let metadataBytes = 0;
        do {
          const page = await listSharedSkills(ctx, { limit: 100, cursor });
          count += page.skills.length; metadataBytes += Buffer.byteLength(JSON.stringify(page)); cursor = page.next_cursor;
        } while (cursor);
        const enumerationMs = performance.now() - start; const enumerationCalls = calls;
        calls = 0;
        const getStart = performance.now();
        const detail = await getSharedSkill(ctx, { source_id: 'default', source_incarnation: source.incarnation, pack_id: 'benchmark', name: 'fixture-0000' });
        const getMs = performance.now() - getStart;
        expect(count).toBe(size); expect(detail.name).toBe('fixture-0000');
        samples.push({ size, enumeration_ms: enumerationMs, enumeration_db_api_calls: enumerationCalls, metadata_bytes: metadataBytes,
          exact_get_ms: getMs, exact_get_db_api_calls: calls, exact_get_bytes: Buffer.byteLength(JSON.stringify(detail)), rss_before: rssBefore, rss_after: process.memoryUsage().rss });
      }
      console.log(JSON.stringify({ benchmark: 'sealed_projection_read_only', runtime: Bun.version, platform: process.platform,
        cpu: cpus()[0]?.model, cores: cpus().length, samples }));
    } finally { await close(); }
  });
  rmSync(dir, { recursive: true, force: true });
}, 120_000);
