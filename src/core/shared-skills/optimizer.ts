import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { configDir } from '../config.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { initializeLocalPersistence, requestPrincipalForContext } from '../persistence/page-mutations.ts';
import { getWriteRequest } from '../persistence/journal.ts';
import { submissionAuthority } from '../persistence/authority.ts';
import { requireUuid, sha256 } from '../persistence/digest.ts';
import { getWorktreeBinding } from '../persistence/ownership.ts';
import { localHostId } from '../persistence/identity.ts';
import { hasScope } from '../scope.ts';
import { getWorkingTreeStatusForFile, splitFrontmatter } from '../skillopt/apply-edits.ts';
import { assertBundledMutationHeldOut, getBundledSkillContext, shouldMutateSkillFile } from '../skillopt/bundled-skill-gate.ts';
import { loadHeldOut } from '../skillopt/held-out.ts';
import type { SkillOptOpts } from '../skillopt/types.ts';
import type { RunSkillOptResult } from '../skillopt/orchestrator.ts';
import { assertLegacySkillFilesystemWrite } from '../skillpack/writer-guard.ts';
import { getSharedSkill, getSharedSkillAsset } from './catalog.ts';
import { normalizeSkillFiles, skillName, skillPath } from './manifest.ts';
import { SHARED_SKILL_LIMITS, type StoredSkillRevision } from './model.ts';
import { approvedFiles, assertSkillCapability, assertStoredSkillCapability, authorizeSkillRead, publicationEnabled, readSharedSkillPolicy, skillPrincipal } from './policy.ts';
import { submitSharedSkillMutation } from './publication.ts';

export async function sharedOptimizerSkillsDir(ctx: OperationContext, sourceId: string, incarnation: string): Promise<string> {
  if (ctx.remote !== false && (ctx.auth?.sourceId ?? ctx.sourceId) !== sourceId) throw new OperationError('permission_denied', 'The selected optimizer source is outside the caller grant.');
  const binding = await getWorktreeBinding(ctx.engine, sourceId);
  if (!binding || binding.source_incarnation !== incarnation || binding.state !== 'active' || binding.owner_host_id !== localHostId() || !binding.local_path) {
    throw new OperationError('owner_unavailable', 'Shared optimization must run on the active canonical owner.');
  }
  const root = resolve(binding.local_path, binding.relative_path);
  if (realpathSync(root) !== root) throw new OperationError('local_conflict', 'The canonical source root contains a symlink.');
  return join(root, 'skills');
}

async function authorize(ctx: OperationContext, opts: SkillOptOpts): Promise<void> {
  const target = opts.sharedSkill!;
  let active = ctx;
  if (ctx.remote !== false) {
    active = await authorizeSkillRead(ctx, 'run_skillopt');
    if (!hasScope(active.auth?.scopes ?? [], 'admin') || !active.auth?.allowedOperations?.includes('run_skillopt')) {
      throw new OperationError('permission_denied', 'Shared optimization requires current admin and an explicit run_skillopt operation grant.');
    }
    let allowed: unknown;
    try { allowed = JSON.parse(await ctx.engine.getConfig('skillopt.allowed_skills') ?? '[]'); } catch { allowed = []; }
    if (!Array.isArray(allowed) || !allowed.includes(opts.skillName)) throw new OperationError('permission_denied', 'The skill is not in skillopt.allowed_skills.');
  }
  assertSkillCapability(active, 'skill_editor', 'put_skill');
  await initializeLocalPersistence(active);
  const authority = await submissionAuthority(active, 'put_skill', target.source_id, target.source_incarnation, `skills/${opts.skillName}/SKILL.md`);
  await assertStoredSkillCapability(ctx.engine, authority, 'skill_editor');
}

function lintCandidate(before: string, after: string): void {
  const original = splitFrontmatter(before), candidate = splitFrontmatter(after);
  if (!candidate.body.trim() || after.includes('\0') || before.slice(0, original.bodyStart) !== after.slice(0, candidate.bodyStart)) {
    throw new OperationError('skill_candidate_invalid', 'The optimized candidate changed protected frontmatter or has an empty/invalid body.');
  }
  let fence: { character: string; length: number } | null = null;
  for (const line of candidate.body.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    if (!fence) fence = { character: match[1][0], length: match[1].length };
    else if (match[1][0] === fence.character && match[1].length >= fence.length && !match[2].trim()) fence = null;
  }
  if (fence) throw new OperationError('skill_candidate_invalid', 'The optimized candidate contains an unclosed Markdown code fence.');
}

export async function optimizeSharedSkill(opts: SkillOptOpts, run: (opts: SkillOptOpts) => Promise<RunSkillOptResult>): Promise<RunSkillOptResult> {
  const target = opts.sharedSkill;
  const ctx = opts.operationContext && target ? { ...opts.operationContext, sourceId: target.source_id } : undefined;
  if (!ctx || ctx.engine !== opts.engine || !target) throw new OperationError('permission_denied', 'Shared optimization requires the original operation context.');
  skillName(opts.skillName); skillName(target.pack_id, 'pack_id');
  requireUuid(target.source_incarnation); requireUuid(target.expected_revision); requireUuid(target.request_id);
  if (opts.resumeRunId || opts.writeCapture || opts.disableValidationGate || opts.optimizerMode || opts.reflectMode) {
    throw new OperationError('invalid_params', 'Shared optimization does not permit legacy resume, write capture, or evaluation ablations.');
  }
  await authorize(ctx, opts);
  if (await getWriteRequest(ctx.engine, await requestPrincipalForContext(ctx), target.request_id)) {
    throw new OperationError('request_already_submitted', 'This optimizer publication request has already been submitted.',
      `Read get_write_request with request_id=${target.request_id}; do not rerun paid optimization to poll a publication.`);
  }
  const skillsDir = await sharedOptimizerSkillsDir(ctx, target.source_id, target.source_incarnation);
  if (realpathSync(opts.skillsDir) !== realpathSync(skillsDir)) throw new OperationError('source_changed', 'The optimizer directory does not match the selected canonical source.');
  const selector = { source_id: target.source_id, source_incarnation: target.source_incarnation, pack_id: target.pack_id, name: opts.skillName };
  const skill = await getSharedSkill(ctx, selector);
  if (skill.revision !== target.expected_revision) throw new OperationError('revision_conflict', 'The selected skill changed before optimization.');
  if (skill.delivery !== 'complete') throw new OperationError('approval_required', 'Optimization requires the complete owner-approved dependency closure.');
  const [stored] = await ctx.engine.executeRaw<StoredSkillRevision>(`SELECT * FROM shared_skill_revisions
    WHERE source_id=$1 AND source_incarnation=$2::uuid AND pack_id=$3 AND name=$4 AND revision=$5::uuid AND NOT deleted`,
  [target.source_id, target.source_incarnation, target.pack_id, opts.skillName, target.expected_revision]);
  const policy = await readSharedSkillPolicy(ctx.engine, target.source_id, target.source_incarnation, await publicationEnabled(ctx));
  if (!stored || approvedFiles(stored.files, policy.policy, skillPrincipal(ctx)).length !== stored.files.length) {
    throw new OperationError('approval_required', 'The original complete skill closure is no longer approved.');
  }
  const files = normalizeSkillFiles(opts.skillName, stored.files.map(file => ({ ...file, encoding: 'base64' })));
  const evaluationInputs: Buffer[] = [];
  for (const input of [opts.benchmarkPath, ...(opts.heldOutPath ? [opts.heldOutPath] : [])]) {
    let bytes: Buffer;
    if (ctx.remote !== false) {
      const path = skillPath(relative(dirname(skillsDir), resolve(input)).split(sep).join('/'));
      const asset = await getSharedSkillAsset(ctx, { ...selector, revision: target.expected_revision, path });
      bytes = Buffer.from(asset.content, 'base64');
      const sealed = files.find(file => file.path === path);
      if (!sealed || asset.sha256 !== sealed.sha256 || sha256(bytes) !== sealed.sha256 || bytes.length !== asset.size) {
        throw new OperationError('revision_unavailable', 'The evaluation input does not match the selected approved skill revision.');
      }
    } else {
      if (lstatSync(realpathSync(input)).size > SHARED_SKILL_LIMITS.bundleBytes) throw new OperationError('invalid_params', 'The evaluation input exceeds the bounded staging size.');
      bytes = readFileSync(input);
    }
    if (bytes.length > SHARED_SKILL_LIMITS.bundleBytes) throw new OperationError('invalid_params', 'The evaluation input exceeds the bounded staging size.');
    evaluationInputs.push(bytes);
  }
  const canonicalFile = join(skillsDir, opts.skillName, 'SKILL.md');
  for (const file of files) {
    const path = join(dirname(skillsDir), file.path), stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || realpathSync(path) !== path || sha256(readFileSync(path)) !== file.sha256) {
      throw new OperationError('local_conflict', 'Canonical skill bytes differ from the selected approved revision.');
    }
  }
  if (!opts.force && getWorkingTreeStatusForFile(canonicalFile) === 'dirty') throw new OperationError('dirty_tree', 'Commit or stash canonical skill edits before optimization.');
  const bundled = getBundledSkillContext(skillsDir, opts.skillName);
  const mutate = shouldMutateSkillFile(bundled, opts).mutate;
  const proposalId = randomUUID(), root = join(configDir(), 'skillopt-proposals', proposalId);
  assertLegacySkillFilesystemWrite(root);
  mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
  const write = (path: string, bytes: Uint8Array | string) => {
    assertLegacySkillFilesystemWrite(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
  };
  for (const file of files) write(join(root, file.path), Buffer.from(file.content, 'base64'));
  const benchmarkPath = join(root, 'benchmark.jsonl'), heldOutPath = opts.heldOutPath ? join(root, 'held-out.jsonl') : undefined;
  write(benchmarkPath, evaluationInputs[0]);
  if (heldOutPath) write(heldOutPath, evaluationInputs[1]);
  write(join(root, 'publication.json'), JSON.stringify({ ...target, name: opts.skillName, proposal_id: proposalId }));
  try {
    assertBundledMutationHeldOut({ isBundled: bundled.isBundled,
      willMutate: mutate, heldOutCount: heldOutPath ? loadHeldOut(heldOutPath).length : 0, skillName: opts.skillName });
    const result = await run({ ...opts, operationContext: ctx, sharedSkill: undefined, skillsDir: join(root, 'skills'), benchmarkPath, heldOutPath, noMutate: true });
    const response: RunSkillOptResult = { ...result, mutatedSkillFile: false, sharedOptimization: { proposal_id: proposalId },
      ...(ctx.remote !== false ? { proposedPath: undefined } : {}) };
    if (opts.dryRun || !mutate || result.outcome !== 'accepted' || result.finalText === skill.body) return response;
    lintCandidate(skill.body, result.finalText);
    await authorize(ctx, opts);
    const input = files.map(file => ({ ...file, encoding: 'base64' as const,
      content: file.path === `skills/${opts.skillName}/SKILL.md` ? Buffer.from(result.finalText).toString('base64') : file.content }));
    const publication = await submitSharedSkillMutation(ctx, 'put_skill', { ...target, name: opts.skillName, files: input,
      description: stored.metadata.description, triggers: stored.metadata.triggers, requirements: stored.metadata.requirements, private: stored.metadata.private });
    response.sharedOptimization!.publication = publication;
    response.mutatedSkillFile = publication.state === 'committed';
    return response;
  } catch (error) {
    if (error instanceof OperationError) error.detail = `Proposal retained: ${proposalId}`;
    throw error;
  }
}
