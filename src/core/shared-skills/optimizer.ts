import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { configDir } from '../config.ts';
import { opError, OperationError, type OperationContext } from '../ops/contract.ts';
import { hostFix } from '../ops/op-fix.ts';
import { skillHeadFix } from './fixes.ts';
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

const EVAL_INPUT_HINT = `Keep each benchmark and held-out file under ${SHARED_SKILL_LIMITS.bundleBytes} bytes (trim or sample the tasks); nothing ran and nothing was spent.`;

export async function sharedOptimizerSkillsDir(ctx: OperationContext, sourceId: string, incarnation: string): Promise<string> {
  if (ctx.remote !== false && (ctx.auth?.sourceId ?? ctx.sourceId) !== sourceId) {
    throw opError('permission_denied', 'The selected optimizer source is outside the caller grant.',
      `This connection's grant is bound to a different source than ${sourceId}; optimize a skill from the granted source, or ask the brain host's operator to grant ${sourceId}.`);
  }
  const binding = await getWorktreeBinding(ctx.engine, sourceId);
  const ownerFix = { fix: hostFix(ctx, ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'],
    `Shows source ${sourceId}'s designated canonical owner and binding; optimization runs only on that host.`) };
  if (!binding || binding.source_incarnation !== incarnation || binding.state !== 'active' || binding.owner_host_id !== localHostId() || !binding.local_path) {
    throw opError('owner_unavailable', 'Shared optimization must run on the active canonical owner.',
      `Source ${sourceId}'s skills are optimized only on its active canonical owner host, and this host is not it (or the binding is inactive). Nothing ran and nothing was spent; run the optimization there.`, ownerFix);
  }
  const root = resolve(binding.local_path, binding.relative_path);
  if (realpathSync(root) !== root) {
    throw opError('local_conflict', 'The canonical source root contains a symlink.',
      `Source ${sourceId}'s registered checkout resolves through a symlink; the brain host's operator re-registers it at its real path before optimization can run.`, ownerFix);
  }
  return join(root, 'skills');
}

async function authorize(ctx: OperationContext, opts: SkillOptOpts): Promise<void> {
  const target = opts.sharedSkill!;
  let active = ctx;
  if (ctx.remote !== false) {
    active = await authorizeSkillRead(ctx, 'run_skillopt');
    if (!hasScope(active.auth?.scopes ?? [], 'admin') || !active.auth?.allowedOperations?.includes('run_skillopt')) {
      throw opError('permission_denied', 'Shared optimization requires current admin and an explicit run_skillopt operation grant.',
        'This connection needs admin scope and run_skillopt in its allowed operations. Ask the brain host\'s operator to grant both; nothing ran and nothing was spent.');
    }
    let allowed: unknown;
    try { allowed = JSON.parse(await ctx.engine.getConfig('skillopt.allowed_skills') ?? '[]'); } catch { allowed = []; }
    if (!Array.isArray(allowed) || !allowed.includes(opts.skillName)) {
      throw opError('permission_denied', 'The skill is not in skillopt.allowed_skills.',
        `Remote optimization is limited to the skills listed in skillopt.allowed_skills, and ${opts.skillName} is not one of them. Ask the user whether the brain host's operator should add it; nothing ran and nothing was spent.`,
        { fix: hostFix(ctx, ['gbrain', 'config', 'get', 'skillopt.allowed_skills'], 'Shows which skills remote callers may optimize; adding one is the operator\'s decision.') });
    }
  }
  assertSkillCapability(active, 'skill_editor', 'put_skill');
  await initializeLocalPersistence(active);
  const authority = await submissionAuthority(active, 'put_skill', target.source_id, target.source_incarnation, `skills/${opts.skillName}/SKILL.md`);
  await assertStoredSkillCapability(ctx.engine, authority, 'skill_editor');
}

function lintCandidate(before: string, after: string): void {
  const original = splitFrontmatter(before), candidate = splitFrontmatter(after);
  if (!candidate.body.trim() || after.includes('\0') || before.slice(0, original.bodyStart) !== after.slice(0, candidate.bodyStart)) {
    throw opError('skill_candidate_invalid', 'The optimized candidate changed protected frontmatter or has an empty/invalid body.',
      'The optimizer\'s candidate was not published; the retained proposal (named in detail) shows what it produced. Ask the user before running the paid optimization again.');
  }
  let fence: { character: string; length: number } | null = null;
  for (const line of candidate.body.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    if (!fence) fence = { character: match[1][0], length: match[1].length };
    else if (match[1][0] === fence.character && match[1].length >= fence.length && !match[2].trim()) fence = null;
  }
  if (fence) {
    throw opError('skill_candidate_invalid', 'The optimized candidate contains an unclosed Markdown code fence.',
      'The optimizer\'s candidate was not published; the retained proposal (named in detail) shows the unclosed fence. Ask the user before running the paid optimization again.');
  }
}

export async function optimizeSharedSkill(opts: SkillOptOpts, run: (opts: SkillOptOpts) => Promise<RunSkillOptResult>): Promise<RunSkillOptResult> {
  const target = opts.sharedSkill;
  const ctx = opts.operationContext && target ? { ...opts.operationContext, sourceId: target.source_id } : undefined;
  if (!ctx || ctx.engine !== opts.engine || !target) {
    throw opError('permission_denied', 'Shared optimization requires the original operation context.',
      'Start shared-skill optimization through the run_skillopt operation (or gbrain skillopt) so its grant and target travel with it; nothing ran and nothing was spent.');
  }
  skillName(opts.skillName); skillName(target.pack_id, 'pack_id');
  requireUuid(target.source_incarnation); requireUuid(target.expected_revision); requireUuid(target.request_id);
  if (opts.resumeRunId || opts.writeCapture || opts.disableValidationGate || opts.optimizerMode || opts.reflectMode) {
    throw opError('invalid_params', 'Shared optimization does not permit legacy resume, write capture, or evaluation ablations.',
      'Drop the resume run id, write capture, validation-gate and optimizer/reflect mode overrides, then start the optimization again; shared skills always run the full gated evaluation.');
  }
  await authorize(ctx, opts);
  if (await getWriteRequest(ctx.engine, await requestPrincipalForContext(ctx), target.request_id)) {
    throw new OperationError('request_already_submitted', 'This optimizer publication request has already been submitted.',
      `Read get_write_request with request_id=${target.request_id}; do not rerun paid optimization to poll a publication.`);
  }
  const skillsDir = await sharedOptimizerSkillsDir(ctx, target.source_id, target.source_incarnation);
  if (realpathSync(opts.skillsDir) !== realpathSync(skillsDir)) {
    throw opError('source_changed', 'The optimizer directory does not match the selected canonical source.',
      `Point the optimizer at source ${target.source_id}'s canonical skills directory (${skillsDir}), or omit the directory override; nothing ran and nothing was spent.`);
  }
  const selector = { source_id: target.source_id, source_incarnation: target.source_incarnation, pack_id: target.pack_id, name: opts.skillName };
  const skill = await getSharedSkill(ctx, selector);
  const headFix = { fix: skillHeadFix(target.source_id, target.pack_id, opts.skillName) };
  if (skill.revision !== target.expected_revision) {
    throw opError('revision_conflict', 'The selected skill changed before optimization.',
      `${target.pack_id}/${opts.skillName} moved to a new revision before optimization started; nothing ran and nothing was spent. Read the current revision and start again with it as expected_revision and a new request_id.`, headFix);
  }
  if (skill.delivery !== 'complete') {
    throw opError('approval_required', 'Optimization requires the complete owner-approved dependency closure.',
      `Part of ${target.pack_id}/${opts.skillName}'s files is not approved for this connection, so the optimizer cannot see the whole skill. Only the publisher can widen source ${target.source_id}'s policy; nothing ran.`, headFix);
  }
  const [stored] = await ctx.engine.executeRaw<StoredSkillRevision>(`SELECT * FROM shared_skill_revisions
    WHERE source_id=$1 AND source_incarnation=$2::uuid AND pack_id=$3 AND name=$4 AND revision=$5::uuid AND NOT deleted`,
  [target.source_id, target.source_incarnation, target.pack_id, opts.skillName, target.expected_revision]);
  const policy = await readSharedSkillPolicy(ctx.engine, target.source_id, target.source_incarnation, await publicationEnabled(ctx));
  if (!stored || approvedFiles(stored.files, policy.policy, skillPrincipal(ctx)).length !== stored.files.length) {
    throw opError('approval_required', 'The original complete skill closure is no longer approved.',
      `Revision ${target.expected_revision} of ${target.pack_id}/${opts.skillName} is gone or no longer fully approved under source ${target.source_id}'s policy; nothing ran. Read the current revision before starting again.`, headFix);
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
        throw opError('revision_unavailable', 'The evaluation input does not match the selected approved skill revision.',
          `Use a benchmark or held-out file that is part of revision ${target.expected_revision} of ${target.pack_id}/${opts.skillName} (get_skill lists its files); nothing ran.`,
          { fix: skillHeadFix(target.source_id, target.pack_id, opts.skillName, target.expected_revision) });
      }
    } else {
      if (lstatSync(realpathSync(input)).size > SHARED_SKILL_LIMITS.bundleBytes) throw opError('invalid_params', 'The evaluation input exceeds the bounded staging size.', EVAL_INPUT_HINT);
      bytes = readFileSync(input);
    }
    if (bytes.length > SHARED_SKILL_LIMITS.bundleBytes) throw opError('invalid_params', 'The evaluation input exceeds the bounded staging size.', EVAL_INPUT_HINT);
    evaluationInputs.push(bytes);
  }
  const canonicalFile = join(skillsDir, opts.skillName, 'SKILL.md');
  for (const file of files) {
    const path = join(dirname(skillsDir), file.path), stat = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || realpathSync(path) !== path || sha256(readFileSync(path)) !== file.sha256) {
      throw opError('local_conflict', 'Canonical skill bytes differ from the selected approved revision.',
        `${file.path} in source ${target.source_id}'s checkout differs from revision ${target.expected_revision}, so the checkout has unpublished edits. Restore the published bytes, or publish the edit through import_skill_proposal, before optimizing; nothing ran.`);
    }
  }
  if (!opts.force && getWorkingTreeStatusForFile(canonicalFile) === 'dirty') {
    throw opError('dirty_tree', 'Commit or stash canonical skill edits before optimization.',
      `${canonicalFile} has uncommitted Git changes. Ask the user whether to commit or stash them, then start the optimization again; nothing ran and nothing was spent.`);
  }
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
