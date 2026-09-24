import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setChatTransportForTests, type ChatOpts, type ChatResult } from '../src/core/ai/gateway.ts';
import { BudgetExhausted } from '../src/core/budget/budget-tracker.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { skilloptOperations } from '../src/core/ops/skillopt.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { getSharedSkill, getSharedSkillAsset } from '../src/core/shared-skills/catalog.ts';
import { optimizeSharedSkill } from '../src/core/shared-skills/optimizer.ts';
import { setSharedSkillPolicy } from '../src/core/shared-skills/policy.ts';
import { submitSharedSkillMutation } from '../src/core/shared-skills/publication.ts';
import type { SharedSkillFileInput } from '../src/core/shared-skills/model.ts';
import { runSkillOpt } from '../src/core/skillopt/orchestrator.ts';
import type { SkillOptOpts } from '../src/core/skillopt/types.ts';
import { _resetAuditWriterForTests } from '../src/core/skillopt/audit.ts';
import { buildWriteCaptureRegistry } from '../src/core/skillopt/write-capture.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { withEnv } from './helpers/with-env.ts';

const source = 'team-example';
const original = '---\nname: alpha\ndescription: Synthetic optimizer fixture\n---\n\n# Task\n\nBASELINE instructions.\n';
const benchmark = Array.from({ length: 50 }, (_, i) => JSON.stringify({ task_id: `task-${String(i).padStart(2, '0')}`, task: 'Read the context and answer.',
  judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'PASS' }] } })).join('\n');
const files: SharedSkillFileInput[] = [
  { path: 'skills/alpha/SKILL.md', content: original, file_class: 'prose', depends_on: ['skills/alpha/references/guide.md', 'skills/alpha/skillopt-benchmark.jsonl'] },
  { path: 'skills/alpha/references/guide.md', content: 'Approved immutable reference.', file_class: 'reference' },
  { path: 'skills/alpha/skillopt-benchmark.jsonl', content: benchmark, file_class: 'reference' },
];
interface Fixture {
  local: OperationContext; remote: OperationContext; opts: SkillOptOpts; root: string; home: string;
  calls: () => number; tools: Set<string>; sourceReads: () => number;
  candidateHook: (fn: () => Promise<void>) => void;
  mode: (value: 'normal' | 'provider_error' | 'budget_error' | 'invalid') => void;
}
async function fixture(run: (f: Fixture) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-shared-optimizer-'));
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined }, async () => {
      const isolated = await isolatedSharedSkillsEngine(), engine = isolated.engine;
      let calls = 0, sourceReads = 0, mode = 'normal';
      let hook: (() => Promise<void>) | undefined;
      const tools = new Set<string>();
      try {
        const root = join(dir, 'brain'); mkdirSync(root);
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
        for (const id of [source, 'default']) await engine.putPage('notes/context', { type: 'note', title: 'Synthetic context',
          compiled_truth: id === source ? 'TEAM_CONTEXT' : 'DEFAULT_CONTEXT', timeline: '', frontmatter: {} }, { sourceId: id });
        await claimWorktree(engine, source, root);
        await activateSharedSkillPersistence(engine, { confirmQuiesced: true });
        const local: OperationContext = { engine, config: { engine: 'pglite' }, remote: false, sourceId: source, dryRun: false,
          logger: { info() {}, warn() {}, error() {} } };
        await engine.setConfig('mcp.publish_skills', 'true');
        await engine.setConfig('skillopt.allowed_skills', JSON.stringify(['alpha']));
        await setSharedSkillPolicy(local, source, { version: 1, enabled: true, classes: ['prose', 'reference'], audiences: ['readers'], requirements: [], allow_follow: true }, null);
        await submitSharedSkillMutation(local, 'put_skill', { name: 'alpha', pack_id: 'example-pack', expected_revision: null, files });
        const detail = await getSharedSkill(local, { name: 'alpha' });
        const operations = ['run_skillopt', 'put_skill', 'get_skill', 'get_skill_asset', 'get_page'];
        await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,scope,source_id,allowed_operations)
          VALUES('optimizer-fixture','Synthetic optimizer','read write admin skill_editor',$1,$2::text[])`, [source, operations]);
        const remote: OperationContext = { ...local, remote: true, auth: { token: 'fixture', principal: { kind: 'oauth_client', id: 'optimizer-fixture' },
          clientId: 'optimizer-fixture', sourceId: source, scopes: ['read', 'write', 'admin', 'skill_editor'], allowedOperations: operations } };
        const opts: SkillOptOpts = { engine, operationContext: remote, sharedSkill: { source_id: source, source_incarnation: detail.source_incarnation,
          pack_id: detail.pack_id, expected_revision: detail.revision, request_id: randomUUID() }, skillName: 'alpha', skillsDir: join(root, 'skills'),
          benchmarkPath: join(root, 'skills/alpha/skillopt-benchmark.jsonl'), epochs: 1, batchSize: 100, lr: 1, lrSchedule: 'constant', split: [4, 1, 5],
          optimizerModel: 'anthropic:claude-opus-4-7', targetModel: 'anthropic:claude-sonnet-4-6', judgeModel: 'anthropic:claude-sonnet-4-6',
          mode: 'patch', dryRun: false, noMutate: false, allowMutateBundled: false, bootstrapReviewed: true, json: true, maxCostUsd: 1000, maxRuntimeMin: 5, force: false };
        const reply = (request: ChatOpts, text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: request.model ?? opts.targetModel, providerId: 'synthetic' });
        __setChatTransportForTests(async request => {
          calls++;
          if (mode === 'provider_error') throw new Error('Synthetic provider failure');
          if (mode === 'budget_error') throw new BudgetExhausted('Synthetic budget exhausted', { reason: 'cost', spent: 1, cap: 1 });
          if (request.system?.includes("SkillOpt's optimizer")) return reply(request, JSON.stringify({ edits: [
            { op: 'replace', target: 'BASELINE instructions.', replacement: mode === 'invalid' ? 'IMPROVED instructions.\n```\nunclosed' : 'IMPROVED instructions.' },
          ] }));
          for (const tool of request.tools ?? []) tools.add(tool.name);
          const results = request.messages.flatMap(message => typeof message.content === 'string' ? [] : message.content.filter(block => block.type === 'tool-result'));
          if (!results.length) return { ...reply(request, ''), stopReason: 'tool_calls', blocks: [
            { type: 'tool-call', toolCallId: randomUUID(), toolName: 'brain_get_page', input: { slug: 'notes/context', include_content: true } },
          ] };
          const output = JSON.stringify(results);
          expect(output).toContain('TEAM_CONTEXT'); expect(output).not.toContain('DEFAULT_CONTEXT'); sourceReads++;
          if (request.system?.includes('IMPROVED') && hook) { const once = hook; hook = undefined; await once(); }
          return reply(request, request.system?.includes('IMPROVED') ? 'PASS' : 'FAIL');
        });
        _resetAuditWriterForTests();
        await run({ local, remote, opts, root, home: join(dir, 'home', '.gbrain'), calls: () => calls, tools,
          sourceReads: () => sourceReads, candidateHook: fn => { hook = fn; }, mode: value => { mode = value; } });
      } finally { __setChatTransportForTests(null); await disposePersistenceConsumer(engine); await isolated.close(); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
async function snapshot(f: Fixture) {
  return { bytes: [...files.map(file => file.path), 'skillpack.json'].map(path => readFileSync(join(f.root, path), 'base64')),
    heads: await f.local.engine.executeRaw('SELECT * FROM shared_skill_heads ORDER BY source_id,name'),
    revisions: await f.local.engine.executeRaw('SELECT * FROM shared_skill_revisions ORDER BY revision'),
    packs: await f.local.engine.executeRaw('SELECT * FROM shared_skill_packs ORDER BY source_id') };
}
function proposals(f: Fixture) { return readdirSync(join(f.home, 'skillopt-proposals')).map(id => join(f.home, 'skillopt-proposals', id)); }

test('explicit remote operation optimizes privately then publishes one complete bundle using original source grants and CAS', () => fixture(async f => {
  const operation = skilloptOperations.find(op => op.name === 'run_skillopt')!;
  const result = await operation.handler(f.remote, { skill_name: 'alpha', shared_skill: true, ...f.opts.sharedSkill,
    epochs: 1, batch_size: 100, lr: 1, max_cost_usd: 1000 }) as { outcome: string; mutated_skill_file: boolean; shared_optimization: { publication: { state: string } } };
  expect(result.outcome).toBe('accepted'); expect(result.mutated_skill_file).toBe(true);
  expect(result.shared_optimization.publication.state).toBe('committed');
  expect((await getSharedSkill(f.local, { name: 'alpha' })).body).toBe(original.replace('BASELINE', 'IMPROVED'));
  for (const file of files.slice(1)) expect(readFileSync(join(f.root, file.path), 'utf8')).toBe(file.content);
  expect(existsSync(join(f.root, 'skills/alpha/skillopt'))).toBe(false);
  expect([...f.tools]).toEqual(['brain_get_page']); expect(f.sourceReads()).toBeGreaterThan(0);
  expect(statSync(proposals(f)[0]).mode & 0o777).toBe(0o700);
  const [row] = await f.local.engine.executeRaw<{ target_kind: string; request_id: string; principal_id: string }>('SELECT target_kind,request_id,principal_id FROM persistence_requests WHERE request_id=$1::uuid', [f.opts.sharedSkill!.request_id]);
  expect(row).toEqual({ target_kind: 'skill_bundle', request_id: f.opts.sharedSkill!.request_id, principal_id: 'optimizer-fixture' });
  const calls = f.calls();
  await expect(runSkillOpt(f.opts)).rejects.toMatchObject({ code: 'request_already_submitted' });
  expect(f.calls()).toBe(calls);
}), 120_000);

test('revoked editor retains an accepted proposal without changing canonical bytes or catalog', () => fixture(async f => {
  const before = await snapshot(f);
  f.candidateHook(async () => { await f.local.engine.executeRaw("UPDATE oauth_clients SET scope='read write admin' WHERE client_id='optimizer-fixture'"); });
  await expect(runSkillOpt(f.opts)).rejects.toMatchObject({ code: 'permission_denied' });
  expect(await snapshot(f)).toEqual(before);
  expect(readFileSync(join(proposals(f)[0], 'skills/alpha/skillopt/proposed.md'), 'utf8')).toContain('IMPROVED');
}), 120_000);

test('concurrent canonical revision wins and CAS conflict leaves the optimizer proposal available', () => fixture(async f => {
  let afterConcurrent: Awaited<ReturnType<typeof snapshot>>;
  f.candidateHook(async () => {
    await submitSharedSkillMutation(f.local, 'put_skill', { name: 'alpha', pack_id: 'example-pack', expected_revision: f.opts.sharedSkill!.expected_revision,
      files: files.map(file => file.file_class === 'prose' ? { ...file, content: original.replace('BASELINE', 'CONCURRENT') } : file) });
    afterConcurrent = await snapshot(f);
  });
  await expect(runSkillOpt(f.opts)).rejects.toMatchObject({ code: 'revision_conflict' });
  expect(await snapshot(f)).toEqual(afterConcurrent!);
  expect(readFileSync(join(proposals(f)[0], 'skills/alpha/skillopt/proposed.md'), 'utf8')).toContain('IMPROVED');
}), 120_000);

test('admin without editor or put_skill grant is refused before provider calls', () => fixture(async f => {
  const before = await snapshot(f), operation = skilloptOperations.find(op => op.name === 'run_skillopt')!;
  for (const auth of [{ ...f.remote.auth!, scopes: ['admin'] }, { ...f.remote.auth!, allowedOperations: ['run_skillopt', 'get_skill', 'get_page'] }]) {
    await expect(operation.handler({ ...f.remote, auth }, { skill_name: 'alpha', shared_skill: true, ...f.opts.sharedSkill })).rejects.toMatchObject({ code: 'permission_denied' });
  }
  expect(f.calls()).toBe(0); expect(await snapshot(f)).toEqual(before);
  expect(existsSync(join(f.home, 'skillopt-proposals'))).toBe(false);
}), 120_000);

test('budget preview rejection and provider failure cannot publish canonical instructions', () => fixture(async f => {
  const before = await snapshot(f);
  await expect(runSkillOpt({ ...f.opts, maxCostUsd: 0.000001 })).rejects.toMatchObject({ envelope: { code: 'cost_cap_exceeded' } });
  expect(f.calls()).toBe(0);
  f.mode('provider_error'); expect((await runSkillOpt(f.opts)).outcome).toBe('errored');
  f.mode('budget_error'); expect((await runSkillOpt(f.opts)).outcome).toBe('aborted');
  expect(await snapshot(f)).toEqual(before); expect(existsSync(join(f.root, 'skills/alpha/skillopt'))).toBe(false);
}), 120_000);

test('candidate Markdown lint failure retains the proposal without publishing', () => fixture(async f => {
  const before = await snapshot(f); f.mode('invalid');
  await expect(runSkillOpt(f.opts)).rejects.toMatchObject({ code: 'skill_candidate_invalid' });
  expect(await snapshot(f)).toEqual(before);
  expect(readFileSync(join(proposals(f)[0], 'skills/alpha/skillopt/proposed.md'), 'utf8')).toContain('unclosed');
}), 120_000);

test('explicit no-mutate keeps an accepted proposal private and does not advance the catalog', () => fixture(async f => {
  const before = await snapshot(f);
  const result = await runSkillOpt({ ...f.opts, noMutate: true });
  expect(result.outcome).toBe('accepted'); expect(result.mutatedSkillFile).toBe(false);
  expect(result.sharedOptimization?.publication).toBeUndefined(); expect(await snapshot(f)).toEqual(before);
}), 120_000);

test('trusted local optimization uses the explicit selected source rather than ambient default context', () => fixture(async f => {
  await f.local.engine.setConfig('skillopt.allowed_skills', '[]');
  const result = await runSkillOpt({ ...f.opts, operationContext: { ...f.local, sourceId: 'default' } });
  expect(result.outcome).toBe('accepted'); expect(result.mutatedSkillFile).toBe(true);
  expect(result.sharedOptimization?.publication?.state).toBe('committed');
  expect((await getSharedSkill(f.local, { name: 'alpha' })).body).toContain('IMPROVED');
  expect([...f.tools]).not.toContain('brain_put_page'); expect([...f.tools]).not.toContain('brain_submit_job');
  expect([...f.tools]).not.toContain('brain_add_timeline_entry');
  expect(buildWriteCaptureRegistry(f.local.engine).defs.map(tool => tool.name)).not.toContain('brain_add_timeline_entry');
  expect(f.sourceReads()).toBeGreaterThan(0);
}), 120_000);

const heldOut = Array.from({ length: 6 }, (_, i) => JSON.stringify({ task_id: `held-out-${i}`, task: 'Independent held-out task.',
  judge: { kind: 'rule', checks: [{ op: 'contains', arg: 'PASS' }] } })).join('\n');
async function publishHeldOut(f: Fixture) {
  const path = 'skills/alpha/held-out.jsonl';
  await submitSharedSkillMutation(f.local, 'put_skill', { name: 'alpha', pack_id: 'example-pack', expected_revision: f.opts.sharedSkill!.expected_revision,
    files: [{ ...files[0], depends_on: [...files[0].depends_on!, path] }, ...files.slice(1), { path, content: heldOut, file_class: 'reference' }] });
  f.opts.sharedSkill!.expected_revision = (await getSharedSkill(f.local, { name: 'alpha' })).revision;
  f.opts.heldOutPath = join(f.root, path);
}

test('remote evaluation inputs reject sibling and unpublished paths without filesystem reads or provider work', () => fixture(async f => {
  const unauthorized = [join(f.root, 'skills/beta/private-benchmark.jsonl'), join(f.root, 'skills/alpha/unpublished.jsonl')];
  for (const path of unauthorized) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'SYNTHETIC_UNPUBLISHED_INPUT'); }
  const before = await snapshot(f);
  const reads = spyOn(fs, 'readFileSync'), stats = spyOn(fs, 'lstatSync'), resolves = spyOn(fs, 'realpathSync');
  let invoked = 0;
  try {
    for (const path of unauthorized) for (const key of ['benchmarkPath', 'heldOutPath'] as const) {
      const options = { ...f.opts, [key]: path };
      await expect(optimizeSharedSkill(options, async () => { invoked++; throw new Error('Unauthorized input reached evaluation'); }))
        .rejects.toMatchObject({ code: 'skill_asset_not_found' });
    }
    for (const calls of [reads.mock.calls, stats.mock.calls, resolves.mock.calls]) {
      expect(calls.filter(args => unauthorized.includes(String(args[0])))).toHaveLength(0);
    }
  } finally { reads.mockRestore(); stats.mockRestore(); resolves.mockRestore(); }
  expect(invoked).toBe(0); expect(f.calls()).toBe(0);
  expect(existsSync(join(f.home, 'skillopt-proposals'))).toBe(false);
  expect(await snapshot(f)).toEqual(before);
}), 120_000);

test('public run_skillopt rejects unauthorized benchmark and held-out inputs without path probes or provider work', () => fixture(async f => {
  const unauthorized = [join(f.root, 'skills/beta/private-benchmark.jsonl'), join(f.root, 'skills/alpha/unpublished.jsonl')];
  for (const path of unauthorized) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'SYNTHETIC_UNPUBLISHED_INPUT'); }
  const before = await snapshot(f);
  const reads = spyOn(fs, 'readFileSync'), stats = spyOn(fs, 'lstatSync'), resolves = spyOn(fs, 'realpathSync');
  try {
    for (const path of unauthorized) for (const key of ['benchmark_path', 'held_out_path']) {
      await expect(operationsByName.run_skillopt.handler(f.remote, {
        skill_name: 'alpha', shared_skill: true, ...f.opts.sharedSkill, [key]: path,
      })).rejects.toMatchObject({ code: 'skill_asset_not_found' });
      expect(f.calls()).toBe(0);
    }
    for (const calls of [reads.mock.calls, stats.mock.calls, resolves.mock.calls]) {
      expect(calls.filter(args => unauthorized.includes(String(args[0])))).toHaveLength(0);
    }
  } finally { reads.mockRestore(); stats.mockRestore(); resolves.mockRestore(); }
  expect(existsSync(join(f.home, 'skillopt-proposals'))).toBe(false);
  expect(await snapshot(f)).toEqual(before);
}), 120_000);

test('remote evaluation inputs enforce original asset-operation snapshots and current grant revocation', () => fixture(async f => {
  const before = await snapshot(f);
  const withoutAsset = f.remote.auth!.allowedOperations!.filter(name => name !== 'get_skill_asset');
  const snapshotRestricted = { ...f.remote, auth: { ...f.remote.auth!, allowedOperations: withoutAsset } };
  let invoked = 0;
  const evaluate = async () => { invoked++; throw new Error('Denied asset reached evaluation'); };
  await expect(optimizeSharedSkill({ ...f.opts, operationContext: snapshotRestricted }, evaluate)).rejects.toMatchObject({ code: 'permission_denied' });
  await f.local.engine.executeRaw("UPDATE oauth_clients SET allowed_operations=$1::text[] WHERE client_id='optimizer-fixture'", [withoutAsset]);
  await expect(optimizeSharedSkill(f.opts, evaluate)).rejects.toMatchObject({ code: 'permission_denied' });
  expect(invoked).toBe(0); expect(f.calls()).toBe(0);
  expect(existsSync(join(f.home, 'skillopt-proposals'))).toBe(false);
  expect(await snapshot(f)).toEqual(before);
}), 120_000);

test('remote evaluation inputs fail closed on current policy changes and stale revision selection', () => fixture(async f => {
  let invoked = 0;
  const evaluate = async () => { invoked++; throw new Error('Unapproved revision reached evaluation'); };
  const stale = { ...f.opts, sharedSkill: { ...f.opts.sharedSkill! } };
  await publishHeldOut(f);
  await expect(optimizeSharedSkill(stale, evaluate)).rejects.toMatchObject({ code: 'revision_conflict' });
  const [policy] = await f.local.engine.executeRaw<{ epoch: string }>('SELECT epoch FROM shared_skill_policies WHERE source_id=$1', [source]);
  await setSharedSkillPolicy(f.local, source, { version: 1, enabled: true, classes: ['prose'], audiences: ['readers'], requirements: [], allow_follow: true }, policy.epoch);
  const selected = { source_id: source, source_incarnation: f.opts.sharedSkill!.source_incarnation, pack_id: 'example-pack', name: 'alpha', revision: f.opts.sharedSkill!.expected_revision };
  await expect(getSharedSkillAsset(f.remote, { ...selected, path: 'skills/alpha/skillopt-benchmark.jsonl' })).rejects.toMatchObject({ code: 'skill_asset_not_found' });
  await expect(optimizeSharedSkill(f.opts, evaluate)).rejects.toMatchObject({ code: 'approval_required' });
  expect(invoked).toBe(0); expect(f.calls()).toBe(0);
  expect(existsSync(join(f.home, 'skillopt-proposals'))).toBe(false);
}), 120_000);

test('remote evaluation inputs reject preexisting unpublished mutations to both approved assets', () => fixture(async f => {
  await publishHeldOut(f);
  let invoked = 0;
  for (const [path, originalBytes] of [[f.opts.benchmarkPath, benchmark], [f.opts.heldOutPath!, heldOut]]) {
    writeFileSync(path, 'SYNTHETIC_UNPUBLISHED_INPUT');
    const before = await snapshot(f);
    await expect(optimizeSharedSkill(f.opts, async () => { invoked++; throw new Error('Unpublished asset reached evaluation'); }))
      .rejects.toMatchObject({ code: 'local_conflict' });
    expect(await snapshot(f)).toEqual(before); expect(readFileSync(path, 'utf8')).toBe('SYNTHETIC_UNPUBLISHED_INPUT');
    writeFileSync(path, originalBytes);
  }
  expect(invoked).toBe(0); expect(f.calls()).toBe(0);
  expect(existsSync(join(f.home, 'skillopt-proposals'))).toBe(false);
}), 120_000);

test('remote evaluation inputs stage exact authorized sealed bytes across a live-file replacement race', () => fixture(async f => {
  await publishHeldOut(f);
  const read = fs.readFileSync;
  let replaced = false, invoked = 0;
  const reads = spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    const bytes = Reflect.apply(read, fs, args);
    if (String(args[0]) === f.opts.benchmarkPath && !replaced) {
      replaced = true;
      writeFileSync(f.opts.benchmarkPath, 'SYNTHETIC_RACE_BENCHMARK');
      writeFileSync(f.opts.heldOutPath!, 'SYNTHETIC_RACE_HELD_OUT');
    }
    return bytes;
  }) as typeof fs.readFileSync);
  try {
    const result = await optimizeSharedSkill({ ...f.opts, noMutate: true, dryRun: true }, async staged => {
      invoked++;
      expect(replaced).toBe(true);
      expect(readFileSync(staged.benchmarkPath, 'utf8')).toBe(benchmark);
      expect(readFileSync(staged.heldOutPath!, 'utf8')).toBe(heldOut);
      expect(readFileSync(join(staged.skillsDir, 'alpha/skillopt-benchmark.jsonl'), 'utf8')).toBe(benchmark);
      expect(readFileSync(join(staged.skillsDir, 'alpha/held-out.jsonl'), 'utf8')).toBe(heldOut);
      return runSkillOpt(staged);
    });
    expect(result.outcome).toBe('aborted'); expect(result.mutatedSkillFile).toBe(false);
  } finally { reads.mockRestore(); }
  expect(invoked).toBe(1); expect(f.calls()).toBe(0);
  expect(readFileSync(f.opts.benchmarkPath, 'utf8')).toBe('SYNTHETIC_RACE_BENCHMARK');
  expect(readFileSync(f.opts.heldOutPath!, 'utf8')).toBe('SYNTHETIC_RACE_HELD_OUT');
}), 120_000);

test('trusted local evaluation inputs may use bounded explicit files outside the published closure', () => fixture(async f => {
  const benchmarkPath = join(f.home, 'local-benchmark.jsonl'), heldOutPath = join(f.home, 'local-held-out.jsonl');
  writeFileSync(benchmarkPath, benchmark); writeFileSync(heldOutPath, heldOut);
  const before = await snapshot(f);
  let invoked = 0;
  const result = await optimizeSharedSkill({ ...f.opts, operationContext: f.local, benchmarkPath, heldOutPath, noMutate: true, dryRun: true }, async staged => {
    invoked++;
    expect(readFileSync(staged.benchmarkPath, 'utf8')).toBe(benchmark);
    expect(readFileSync(staged.heldOutPath!, 'utf8')).toBe(heldOut);
    return runSkillOpt(staged);
  });
  expect(result.outcome).toBe('aborted'); expect(invoked).toBe(1); expect(f.calls()).toBe(0);
  expect(await snapshot(f)).toEqual(before);
}), 120_000);
