import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { runSharedSkillsMigration } from '../src/core/shared-skills/migration.ts';
import { readSharedSkillsSourceView, setSourceSharedSkills } from '../src/core/shared-skills/source-opt-out.ts';
import { DEFAULT_INVENTORY_LIMITS, INVENTORY_LIMIT_CEILINGS, parseInventoryLimitValue, readInventoryLimits } from '../src/core/shared-skills/inventory-limits.ts';
import { inventorySkillpack } from '../src/core/shared-skills/setup-files.ts';
import { checkSharedSkillsSources } from '../src/commands/doctor/checks/shared-skills.ts';
import { runSourcesSharedSkills } from '../src/commands/sources-shared-skills.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-shared-optout-'));
const engines: Array<{ name: string; engine: BrainEngine }> = [];
let closePg: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
  engines.push({ name: 'pglite', engine: pglite });
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push({ name: 'postgres', engine: pg.engine });
    closePg = pg.close;
  }
}, 120_000);

afterAll(async () => {
  for (const { name, engine } of engines) if (name === 'pglite') await engine.disconnect();
  await closePg?.();
  rmSync(home, { recursive: true, force: true });
});

const ctxFor = (engine: BrainEngine): OperationContext => ({ engine, config: { engine: 'pglite' }, sourceId: 'default', remote: false, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } });
const resetDefault = (engine: BrainEngine) => engine.executeRaw("UPDATE sources SET config='{}'::jsonb, local_path=NULL WHERE id='default'");
const sourceRow = async (engine: BrainEngine, id = 'default') => (await runSharedSkillsMigration(ctxFor(engine))).sources.find(row => row.source_id === id)!;

function oversizedPack(name: string): string {
  const root = join(home, name);
  mkdirSync(join(root, 'skills', 'big'), { recursive: true });
  writeFileSync(join(root, 'skillpack.json'), JSON.stringify({ skills: ['skills/big'] }));
  writeFileSync(join(root, 'skills', 'big', 'SKILL.md'), `# Big\n${'x'.repeat(300_000)}\n`);
  return root;
}

test('on/off/status write and clear config.shared_skills and the migration policy follows, on both engines', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const { name, engine } of engines) {
    await resetDefault(engine);
    const initial = await readSharedSkillsSourceView(engine, 'default');
    expect({ name, configured: initial.configured, mode: initial.mode, parked: initial.parked }).toEqual({ name, configured: null, mode: 'content', parked: null });

    const off = await setSourceSharedSkills({ engine, remote: false }, 'default', false);
    expect({ name, changed: off.changed, configured: off.configured, mode: off.mode, code: off.reason_code })
      .toEqual({ name, changed: true, configured: false, mode: 'preserve_files', code: 'source_shared_skills_disabled' });
    expect(off.reason).toContain('gbrain sources shared-skills default on');
    expect(off.reason).toContain('docs/guides/shared-brain-skills.md#choose-which-sources-adopt-shared-skills');
    const [stored] = await engine.executeRaw<{ kind: string; value: string }>("SELECT jsonb_typeof(config->'shared_skills') AS kind, config->>'shared_skills' AS value FROM sources WHERE id='default'");
    expect({ name, ...stored }).toEqual({ name, kind: 'boolean', value: 'false' });
    expect((await sourceRow(engine)).stages[0]!.reason).toContain('source_shared_skills_disabled');
    expect((await setSourceSharedSkills({ engine, remote: false }, 'default', false)).changed).toBe(false);

    const on = await setSourceSharedSkills({ engine, remote: false }, 'default', true);
    expect({ name, changed: on.changed, configured: on.configured, mode: on.mode }).toEqual({ name, changed: true, configured: null, mode: 'content' });
    const [cleared] = await engine.executeRaw<{ present: boolean }>("SELECT config ? 'shared_skills' AS present FROM sources WHERE id='default'");
    expect(cleared!.present).toBe(false);
    expect((await sourceRow(engine)).stages[0]!.reason ?? '').not.toContain('source_shared_skills_disabled');
    expect((await setSourceSharedSkills({ engine, remote: false }, 'default', true)).changed).toBe(false);
  }
}), 120_000);

test('a remote caller is refused with a host_admin fix and a read-only verify; a missing source is not_found', async () => {
  const { engine } = engines[0]!;
  const refusal = await setSourceSharedSkills({ engine, remote: true }, 'default', false).catch(error => error);
  expect(refusal.code).toBe('trusted_local_only');
  expect(refusal.fix).toMatchObject({ argv: ['gbrain', 'sources', 'shared-skills', 'default', 'off'], actor: 'host_admin',
    verify: { argv: ['gbrain', 'sources', 'shared-skills', 'default', 'status', '--json'] } });
  expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='default' AND config ? 'shared_skills'")).toEqual([]);
  await expect(readSharedSkillsSourceView(engine, 'absent-source')).rejects.toMatchObject({ code: 'not_found' });
  await expect(setSourceSharedSkills({ engine, remote: false }, 'absent-source', false)).rejects.toMatchObject({ code: 'not_found' });
});

test('a connector or external source with shared skills on explains why it keeps its effective mode', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const { name, engine } of engines) {
    for (const [config, mode] of [[{ kind: 'google', shared_skills: false }, 'preserve_files'], [{ remote_url: 'https://example.com/acme-example.git', managed_clone: true }, 'explicit_pack_required']] as const) {
      await engine.executeRaw("UPDATE sources SET config=$1::text::jsonb WHERE id='default'", [JSON.stringify(config)]);
      const view = await setSourceSharedSkills({ engine, remote: false }, 'default', true);
      expect({ name, mode: view.mode, code: view.reason_code, configured: view.configured }).toEqual({ name, mode, code: 'source_skill_adoption_required', configured: null });
      expect(view.explanation).toContain('turning shared skills on cannot change that');
      expect(view.reason).toContain('gbrain sources shared-skills default status');
      const [kept] = await engine.executeRaw<{ kind: string | null; remote: string | null }>("SELECT config->>'kind' AS kind, config->>'remote_url' AS remote FROM sources WHERE id='default'");
      expect({ name, ...kept }).toEqual({ name, kind: 'kind' in config ? config.kind : null, remote: 'remote_url' in config ? config.remote_url : null });
    }
    await resetDefault(engine);
  }
}), 120_000);

test('an oversized pack parks once, is not retried, and resumes after the bound is raised or the source opts out', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  for (const { name, engine } of engines) {
    await resetDefault(engine);
    const root = oversizedPack(`pack-${name}`);
    await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
    expect(await checkSharedSkillsSources(engine)).toBeNull();

    const report = await runSharedSkillsMigration(ctxFor(engine));
    expect(report.status).not.toBe('conflict');
    const parked = report.sources.find(row => row.source_id === 'default')!;
    expect({ name, status: parked.status, limit: parked.parked?.limit }).toEqual({ name, status: 'action_required', limit: 'shared_skills.inventory.max_file_bytes' });
    expect(parked.stages[0]!.reason).toContain('gbrain apply-migrations --migration 0.53.0 --yes');
    expect(parked.stages[0]!.reason).toContain('gbrain sources shared-skills default off');
    const view = await readSharedSkillsSourceView(engine, 'default');
    expect(view.parked?.parked_at).toBe(parked.parked!.parked_at);
    const doctor = await checkSharedSkillsSources(engine);
    expect({ name, status: doctor?.status, parked: (doctor?.details as { parked: Array<{ source_id: string }> }).parked.map(row => row.source_id) })
      .toEqual({ name, status: 'warn', parked: ['default'] });

    // Not retried: a pack that would now fail confinement stays parked instead of turning into a conflict.
    const skill = join(root, 'skills', 'big', 'SKILL.md');
    unlinkSync(skill);
    symlinkSync(join(root, 'skillpack.json'), skill);
    const again = await sourceRow(engine);
    expect({ name, status: again.status, parked_at: again.parked?.parked_at }).toEqual({ name, status: 'action_required', parked_at: parked.parked!.parked_at });
    unlinkSync(skill);
    writeFileSync(skill, `# Big\n${'x'.repeat(300_000)}\n`);

    await engine.setConfig('shared_skills.inventory.max_file_bytes', '524288');
    const resumed = await sourceRow(engine);
    expect({ name, parked: resumed.parked, inventory: resumed.stages.find(stage => stage.stage === 'inventory')?.status })
      .toEqual({ name, parked: undefined, inventory: 'complete' });
    expect(resumed.inventory?.hashes['skills/big/SKILL.md']).toMatch(/^[a-f0-9]{64}$/);

    await engine.executeRaw("DELETE FROM config WHERE key='shared_skills.inventory.max_file_bytes'");
    expect((await sourceRow(engine)).parked?.limit).toBe('shared_skills.inventory.max_file_bytes');
    await setSourceSharedSkills({ engine, remote: false }, 'default', false);
    expect((await readSharedSkillsSourceView(engine, 'default')).parked).toBeNull();
    const optedOut = await sourceRow(engine);
    expect({ name, parked: optedOut.parked, status: optedOut.status }).toEqual({ name, parked: undefined, status: 'action_required' });
    expect(optedOut.stages[0]!.reason).toContain('source_shared_skills_disabled');
    expect((await checkSharedSkillsSources(engine))).toMatchObject({ status: 'ok', details: { opted_out: ['default'], parked: [] } });

    expect((await setSourceSharedSkills({ engine, remote: false }, 'default', true)).released_parked).toBe(false);
    const reparked = await sourceRow(engine);
    expect(reparked.parked?.limit).toBe('shared_skills.inventory.max_file_bytes');
    const released = await setSourceSharedSkills({ engine, remote: false }, 'default', true);
    expect({ name, released: released.released_parked, parked: released.parked }).toEqual({ name, released: true, parked: null });
    await resetDefault(engine);
    await engine.executeRaw("DELETE FROM config WHERE key LIKE 'shared_skills.migration.v1%'");
    rmSync(root, { recursive: true, force: true });
  }
}), 180_000);

test('inventory bounds are config-backed with today\'s defaults, capped, and confinement stays immutable', async () => {
  const { engine } = engines[0]!;
  expect(await readInventoryLimits(engine)).toEqual({ ...DEFAULT_INVENTORY_LIMITS });
  expect(DEFAULT_INVENTORY_LIMITS).toEqual({ max_files: 256, max_total_bytes: 4 * 1024 * 1024, max_file_bytes: 262_144, max_entries: 1024 });
  for (const value of ['0', '-1', '1.5', 'many', String(INVENTORY_LIMIT_CEILINGS.max_file_bytes + 1)]) {
    expect(() => parseInventoryLimitValue('shared_skills.inventory.max_file_bytes', value)).toThrow(expect.objectContaining({ code: 'invalid_params' }));
  }
  expect(parseInventoryLimitValue('shared_skills.inventory.max_files', '4096')).toBe(4096);
  await engine.setConfig('shared_skills.inventory.max_files', '2');
  expect((await readInventoryLimits(engine)).max_files).toBe(2);
  await engine.executeRaw("DELETE FROM config WHERE key='shared_skills.inventory.max_files'");

  const root = join(home, 'limits');
  mkdirSync(join(root, 'skills', 'small'), { recursive: true });
  writeFileSync(join(root, 'skillpack.json'), JSON.stringify({ skills: ['skills/small'] }));
  writeFileSync(join(root, 'skills', 'small', 'SKILL.md'), '# Small\n');
  writeFileSync(join(root, 'skills', 'small', 'notes.md'), 'notes\n');
  expect(() => inventorySkillpack(root, { ...DEFAULT_INVENTORY_LIMITS, max_files: 2 })).toThrow(expect.objectContaining({ code: 'payload_too_large', detail: 'shared_skills.inventory.max_files' }));
  expect(() => inventorySkillpack(root, { ...DEFAULT_INVENTORY_LIMITS, max_total_bytes: 20 })).toThrow(expect.objectContaining({ code: 'payload_too_large', detail: 'shared_skills.inventory.max_total_bytes' }));
  expect(() => inventorySkillpack(root, { ...DEFAULT_INVENTORY_LIMITS, max_entries: 1 })).toThrow(expect.objectContaining({ code: 'payload_too_large', detail: 'shared_skills.inventory.max_entries' }));
  expect(Object.keys(inventorySkillpack(root)!.hashes).sort()).toEqual(['skillpack.json', 'skills/small/SKILL.md', 'skills/small/notes.md']);
  symlinkSync(join(root, 'skills', 'small', 'SKILL.md'), join(root, 'skills', 'small', 'link.md'));
  expect(() => inventorySkillpack(root, INVENTORY_LIMIT_CEILINGS)).toThrow(expect.objectContaining({ code: 'local_conflict' }));
  rmSync(root, { recursive: true, force: true });
});

test('sources shared-skills refuses invalid input with opError codes', async () => {
  const { engine } = engines[0]!;
  await expect(runSourcesSharedSkills(engine, ['default', 'maybe'])).rejects.toMatchObject({ code: 'invalid_params', fix: { argv: ['gbrain', 'sources', 'shared-skills', 'default', 'status', '--json'] } });
  await expect(runSourcesSharedSkills(engine, [])).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(runSourcesSharedSkills(engine, ['default', 'off', 'extra'])).rejects.toMatchObject({ code: 'invalid_params' });
  await expect(runSourcesSharedSkills(engine, ['default', 'off', '--force'])).rejects.toMatchObject({ code: 'unknown_flag' });
  expect(await engine.executeRaw("SELECT 1 FROM sources WHERE id='default' AND config ? 'shared_skills'")).toEqual([]);
});
