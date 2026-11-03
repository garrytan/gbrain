import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { purgeStaleCheckpoints } from '../src/core/op-checkpoint.ts';
import { installPackagedSharedSkills } from '../src/core/shared-skills/setup.ts';
import * as bundle from '../src/core/shared-skills/setup-bundle.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

// Process-global bundle spy simulates two real release payloads; run in isolation.
const currentFiles = bundle.packagedSharedSkills();
function release(version: string): Record<string, string> {
  const files = { ...currentFiles };
  const manifest = JSON.parse(files['skillpack.json']);
  manifest.version = manifest.gbrain_min_version = manifest.provenance.release = version;
  files['skillpack.json'] = JSON.stringify(manifest, null, 2) + '\n';
  files['README.md'] = files['README.md'].replace(/GBrain [\d.]+/g, `GBrain ${version}`);
  return files;
}

for (const backend of testBackends()) {
  async function fixture(run: (ctx: OperationContext, root: string) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-packaged-replay-'));
    const url = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: url }, async () => {
        const isolated = await isolatedSharedSkillsEngine(url);
        const engine = isolated.engine;
        try {
          const root = join(dir, 'default'); mkdirSync(root);
          await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
          await claimWorktree(engine, 'default', root);
          await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
          await engine.setConfig('mcp.publish_skills', 'true');
          await run({ engine, config: { engine: backend }, remote: false, sourceId: 'default', dryRun: false,
            logger: { info() {}, warn() {}, error() {} } }, root);
        } finally { await disposePersistenceConsumer(engine); await isolated.close(); }
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  const requests = (engine: BrainEngine) => engine.executeRaw<{ request_id: string; state: string }>(
    "SELECT request_id,state FROM persistence_requests WHERE operation='put_skill' ORDER BY request_id");

  test(`${backend}: interrupted packaged installation resumes the original payload after an upgrade`, () => fixture(async (ctx, root) => {
    const older = release('0.60.1.0');
    const spy = spyOn(bundle, 'packagedSharedSkills').mockImplementation(() => ({ ...older }));
    let interruptions = 0;
    // Keep the real transaction engine, but fail the canonical revision insert.
    const broken = new Proxy(ctx.engine, { get(target, key) {
      if (key === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(tx => fn(new Proxy(tx, { get(real, prop) {
        if (prop === 'executeRaw') return async (sql: string, params?: unknown[]) => {
          if (sql.includes('INSERT INTO shared_skill_revisions')) {
            interruptions++;
            throw Object.assign(new Error('canceling statement due to user request'), { code: '57014' });
          }
          return real.executeRaw(sql, params);
        };
        const value = Reflect.get(real, prop); return typeof value === 'function' ? value.bind(real) : value;
      } })));
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
      await installPackagedSharedSkills({ ...ctx, engine: broken, writeWaitMs: 1_000 }, 'default').catch(() => undefined);
      await disposePersistenceConsumer(broken);
      await disposePersistenceConsumer(ctx.engine);
      const admitted = await requests(ctx.engine);
      expect(admitted).toHaveLength(1);
      expect(interruptions).toBeGreaterThan(0);
      expect(['queued', 'recovering']).toContain(admitted[0].state);
      spy.mockImplementation(() => release('0.60.2.0'));
      await installPackagedSharedSkills(ctx, 'default');
      expect(await requests(ctx.engine)).toEqual([{ request_id: admitted[0].request_id, state: 'committed' }]);
      expect(JSON.parse(readFileSync(join(root, 'skillpack.json'), 'utf8')).provenance.release).toBe('0.60.1.0');
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(older['README.md']);
      for (const [path, content] of Object.entries(older)) {
        if (path.startsWith('skills/')) expect(readFileSync(join(root, path), 'utf8')).toBe(content);
      }
      await installPackagedSharedSkills(ctx, 'default');
      expect(await requests(ctx.engine)).toHaveLength(1);
    } finally { spy.mockRestore(); await disposePersistenceConsumer(broken); }
  }), 120_000);

  test(`${backend}: a committed install remains an exact replay after a release change`, () => fixture(async (ctx, root) => {
    const older = release('0.60.1.0');
    const spy = spyOn(bundle, 'packagedSharedSkills').mockImplementation(() => ({ ...older }));
    try {
      await installPackagedSharedSkills(ctx, 'default');
      const first = await requests(ctx.engine);
      spy.mockImplementation(() => release('0.60.2.0'));
      await installPackagedSharedSkills(ctx, 'default');
      expect(await requests(ctx.engine)).toEqual(first);
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(older['README.md']);
    } finally { spy.mockRestore(); }
  }), 120_000);

  test(`${backend}: remote installation cannot pin a payload`, () => fixture(async (ctx) => {
    await expect(installPackagedSharedSkills({ ...ctx, remote: true }, 'default')).rejects.toMatchObject({ code: 'permission_denied' });
    expect(await ctx.engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='packaged-shared-skills'")).toEqual([]);
    expect(await requests(ctx.engine)).toEqual([]);
  }), 120_000);

  test(`${backend}: a preserved README stays outside the pinned publication across upgrades`, () => fixture(async (ctx, root) => {
    writeFileSync(join(root, 'README.md'), 'Existing owner README.\n');
    const spy = spyOn(bundle, 'packagedSharedSkills').mockImplementation(() => release('0.60.1.0'));
    try {
      await installPackagedSharedSkills(ctx, 'default', ['README.md']);
      const first = await requests(ctx.engine);
      spy.mockImplementation(() => release('0.60.2.0'));
      await installPackagedSharedSkills(ctx, 'default');
      expect(await requests(ctx.engine)).toEqual(first);
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe('Existing owner README.\n');
    } finally { spy.mockRestore(); }
  }), 120_000);

  test(`${backend}: an opted-out source never pins or publishes a default pack`, () => fixture(async (ctx) => {
    await ctx.engine.executeRaw(`UPDATE sources SET config='{"shared_skills":false}'::jsonb WHERE id='default'`);
    await expect(installPackagedSharedSkills(ctx, 'default')).rejects.toMatchObject({ code: 'source_writeback_required' });
    expect(await ctx.engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='packaged-shared-skills'")).toEqual([]);
    expect(await requests(ctx.engine)).toEqual([]);
  }), 120_000);

  test(`${backend}: competing release installers share one immutable payload and request`, () => fixture(async (ctx, root) => {
    let builds = 0;
    const spy = spyOn(bundle, 'packagedSharedSkills').mockImplementation(() => release(++builds === 1 ? '0.60.1.0' : '0.60.2.0'));
    try {
      const outcomes = await Promise.allSettled([
        installPackagedSharedSkills(ctx, 'default'), installPackagedSharedSkills(ctx, 'default'),
      ]);
      for (const result of outcomes) if (result.status === 'rejected') expect(result.reason.code).toBe('publication_pending');
      await installPackagedSharedSkills(ctx, 'default');
      const rows = await requests(ctx.engine);
      expect(rows).toHaveLength(1);
      expect(rows[0].state).toBe('committed');
      const [pin] = await ctx.engine.executeRaw<{ fingerprint: string; completed_keys: [{ files: Record<string, string> }] }>(
        "SELECT fingerprint,completed_keys FROM op_checkpoints WHERE op='packaged-shared-skills'");
      const [source] = await ctx.engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
      expect(JSON.parse(pin.fingerprint)).toEqual(['default', source.incarnation]);
      expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(pin.completed_keys[0].files['README.md']);
      expect(JSON.parse(readFileSync(join(root, 'skillpack.json'), 'utf8')).provenance.release)
        .toBe(JSON.parse(pin.completed_keys[0].files['skillpack.json']).provenance.release);
    } finally { spy.mockRestore(); }
  }), 120_000);

  test(`${backend}: malformed retained payload fails closed without replacing the committed request`, () => fixture(async (ctx) => {
    await installPackagedSharedSkills(ctx, 'default');
    const first = await requests(ctx.engine);
    await ctx.engine.executeRaw("UPDATE op_checkpoints SET completed_keys='[{}]'::jsonb WHERE op='packaged-shared-skills'");
    await expect(installPackagedSharedSkills(ctx, 'default')).rejects.toMatchObject({ code: 'local_conflict' });
    expect(await requests(ctx.engine)).toEqual(first);
  }), 120_000);

  test(`${backend}: ordinary checkpoint expiry retains the live source pin but collects obsolete incarnations`, () => fixture(async (ctx) => {
    await installPackagedSharedSkills(ctx, 'default');
    const before = await requests(ctx.engine);
    await ctx.engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '30 days' WHERE op='packaged-shared-skills'");
    await ctx.engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at)
      SELECT op,'obsolete-incarnation',jsonb_set(completed_keys,'{0,incarnation}','"00000000-0000-0000-0000-000000000000"'::jsonb),updated_at
      FROM op_checkpoints WHERE op='packaged-shared-skills'`);
    expect(await purgeStaleCheckpoints(ctx.engine)).toBe(1);
    expect(await ctx.engine.executeRaw("SELECT fingerprint FROM op_checkpoints WHERE op='packaged-shared-skills'")).toHaveLength(1);
    await installPackagedSharedSkills(ctx, 'default');
    expect(await requests(ctx.engine)).toEqual(before);
  }), 120_000);
}
