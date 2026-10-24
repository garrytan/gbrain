#!/usr/bin/env bun
/**
 * Stable channel promotion (.github/workflows/promote-stable.yml).
 *
 *   PROMOTE_VERSION=<v> PROMOTE_SOAK_RUN_URL=<url> [PROMOTE_SCOREBOARD_URL=<url>]
 *   [PROMOTE_ROLLBACK=true PROMOTE_REASON=<why>] bun run scripts/promote-stable.ts
 *
 * Promotes an already published release (the immutable `v<VERSION>` tag that
 * release.yml minted) to the stable channel, only after the production-shaped
 * soak passed on its exact git tree:
 *
 * 1. the dispatching actor has the admin or maintain role;
 * 2. `refs/tags/v<VERSION>` exists, its VERSION file says <VERSION>, and its
 *    GitHub release is published (not a draft); its commit and tree are the
 *    release;
 * 3. the soak run URL names a run of this repository whose workflow file is
 *    the STABLE_SOAK_WORKFLOW repository variable, completed with success;
 * 4. the run's head commit has the release tree (the same bytes, not merely
 *    the same version);
 * 5. the version is strictly newer than the current stable, unless this is a
 *    rollback with a reason; re-promoting the current stable is a no-op;
 * 6. the annotated record tag `stable-v<VERSION>` is created (once per
 *    version, never moved) and the annotated `stable` tag is moved to the
 *    release commit, both carrying renderTagMessage(). One atomic push moves
 *    both, `stable` leased on the value read in step 5, so a failed push
 *    leaves the remote unchanged and a re-run starts clean.
 *
 * Clients peel `refs/tags/stable^{}`; the update check reads
 * https://raw.githubusercontent.com/garrytan/gbrain/stable/VERSION, the same
 * pattern as `latest-stable` (src/commands/check-update.ts RELEASE_REF_RAW).
 * Side effects (gh, git, clock, log, step summary) come in through
 * PromoteDeps, so the decisions are tested without network or a real remote
 * (test/scripts/promote-stable.test.ts). Every refusal exits 1 with one
 * sentence saying what to do. Docs: docs/RELEASING.md#stable-channel-promotion
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

export const DOCS = 'docs/RELEASING.md#stable-channel-promotion';
export const STABLE_REF = 'refs/tags/stable';
const VERSION_RE = /^\d+\.\d+\.\d+(\.\d+)?$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const PROMOTER_ROLES = new Set(['admin', 'maintain']);
const ROLLBACK_NEEDS_REASON = 'A rollback needs a reason: re-run with the reason input saying why stable moves back.';

export class Refusal extends Error {}

export interface PromoteInputs {
  version: string;
  soakRunUrl: string;
  scoreboardUrl: string;
  rollback: boolean;
  reason: string;
}

export interface GitResult { code: number; stdout: string; stderr: string }

export interface PromoteDeps {
  repo: string;
  actor: string;
  soakWorkflow: string;
  ghApi(path: string): Promise<unknown>;
  git(args: string[]): Promise<GitResult>;
  now(): Date;
  log(line: string): void;
  summary(markdown: string): void;
}

export interface SoakRun {
  status?: string | null;
  conclusion?: string | null;
  path?: string | null;
  head_sha?: string | null;
}

export interface TagFields {
  version: string;
  commit: string;
  tree: string;
  soakRun: string;
  scoreboard: string;
  promotedBy: string;
  promotedAt: string;
  previous: string | null;
  rollback: boolean;
  reason: string;
}

export interface Promotion extends TagFields { recordCreated: boolean }

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export function parseRunUrl(url: string, repo: string): { runId: string; attempt: string | null } {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)(?:\/attempts\/(\d+))?\/?$/.exec(url.trim());
  if (!m) throw new Refusal(`soak_run_url "${url}" is not a GitHub Actions run URL; pass https://github.com/${repo}/actions/runs/<run id> (optionally /attempts/<n>) of the soak run.`);
  if (m[1]!.toLowerCase() !== repo.toLowerCase()) throw new Refusal(`soak_run_url names a run of ${m[1]}, not ${repo}; pass the soak run from this repository's Actions tab.`);
  return { runId: m[2]!, attempt: m[3] ?? null };
}

export function normaliseWorkflowPath(value: string): string {
  const bare = value.trim().replace(/@.*$/, '').replace(/^\.\//, '');
  return bare.startsWith('.github/workflows/') ? bare : `.github/workflows/${bare}`;
}

export function requireSoakWorkflow(soakWorkflow: string): string {
  if (!soakWorkflow.trim()) throw new Refusal('The soak workflow is not configured: set the repository variable STABLE_SOAK_WORKFLOW to the soak workflow\'s file (Settings → Secrets and variables → Actions → Variables), then re-run this workflow.');
  return normaliseWorkflowPath(soakWorkflow);
}

export function checkSoakRun(run: SoakRun, soakWorkflow: string, url: string): void {
  const expected = requireSoakWorkflow(soakWorkflow);
  const actual = normaliseWorkflowPath(run.path ?? '');
  if (actual !== expected) throw new Refusal(`Soak run ${url} ran ${actual}, not the soak workflow ${expected}; pass a run of ${expected} (or fix the STABLE_SOAK_WORKFLOW repository variable).`);
  if (run.status !== 'completed') throw new Refusal(`Soak run ${url} is ${run.status ?? 'in an unknown state'}, not completed; wait for it to finish, then re-run this workflow.`);
  if (run.conclusion !== 'success') throw new Refusal(`Soak run ${url} concluded ${run.conclusion ?? 'without a conclusion'}, not success; promote only a release whose soak passed.`);
}

export function checkOrder(next: string, current: string | null, rollback: boolean, reason: string): void {
  if (rollback && !reason.trim()) throw new Refusal(ROLLBACK_NEEDS_REASON);
  if (current === null) return;
  const cmp = compareVersions(next, current);
  if (cmp === 0) throw new Refusal(`v${next} is already the stable release, so there is nothing to promote.`);
  if (cmp < 0 && !rollback) throw new Refusal(`v${next} is older than the current stable v${current}; to move stable back, re-run with rollback=true and a reason.`);
}

export function renderTagMessage(f: TagFields): string {
  return [
    `gbrain stable channel: v${f.version}`,
    '',
    `version: ${f.version}`,
    `commit: ${f.commit}`,
    `tree: ${f.tree}`,
    `soak_run: ${f.soakRun}`,
    `scoreboard: ${f.scoreboard}`,
    `promoted_by: ${f.promotedBy}`,
    `promoted_at: ${f.promotedAt}`,
    `previous: ${f.previous ?? 'none'}`,
    `rollback: ${f.rollback}`,
    `reason: ${f.reason.trim().replace(/\s+/g, ' ') || '-'}`,
    '',
  ].join('\n');
}

export function renderSummary(p: Promotion): string {
  const rows: Array<[string, string]> = [
    ['Version', `v${p.version}`],
    ['Commit', `\`${p.commit}\``],
    ['Tree', `\`${p.tree}\``],
    ['Soak run', p.soakRun],
    ['Scoreboard', p.scoreboard],
    ['Previous stable', p.previous ? `v${p.previous}` : 'none'],
    ['Rollback', p.rollback ? `yes: ${p.reason.trim()}` : 'no'],
    ['Record tag', p.recordCreated ? `\`stable-v${p.version}\` created` : `\`stable-v${p.version}\` already existed (re-promotion)`],
    ['Promoted by', `${p.promotedBy} at ${p.promotedAt}`],
  ];
  const cell = (v: string) => v.replace(/\s+/g, ' ').replace(/\|/g, '\\|');
  return [`## Stable channel: v${p.version}`, '', '| Field | Value |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`), ''].join('\n');
}

async function gitOut(deps: PromoteDeps, args: string[], refusal: string): Promise<string> {
  const r = await deps.git(args);
  if (r.code !== 0) throw new Refusal(`${refusal}${r.stderr.trim() ? ` (git: ${r.stderr.trim().split('\n').at(-1)})` : ''}`);
  return r.stdout.trim();
}

async function refExists(deps: PromoteDeps, ref: string): Promise<boolean> {
  return (await deps.git(['rev-parse', '--verify', '--quiet', ref])).code === 0;
}

/** The current stable: the highest `v*` tag on the commit `refs/tags/stable` peels to (plus the tag object, for the push lease), or null when stable does not exist. */
export async function currentStable(deps: PromoteDeps): Promise<{ version: string; tagObject: string } | null> {
  if (!(await refExists(deps, STABLE_REF))) return null;
  const tagObject = await gitOut(deps, ['rev-parse', STABLE_REF], `Could not read ${STABLE_REF}; re-run this workflow.`);
  const commit = await gitOut(deps, ['rev-parse', `${STABLE_REF}^{commit}`], `Could not peel ${STABLE_REF} to a commit; repair the tag by hand (${DOCS}).`);
  const versions = (await gitOut(deps, ['tag', '--points-at', commit, '--list', 'v*'], `Could not list the tags on ${commit}; re-run this workflow.`))
    .split('\n').map(t => t.trim().replace(/^v/, '')).filter(v => VERSION_RE.test(v));
  if (versions.length === 0) throw new Refusal(`${STABLE_REF} points at ${commit}, which carries no v<VERSION> release tag; repair the stable tag by hand before promoting (${DOCS}).`);
  return { version: versions.sort(compareVersions).at(-1)!, tagObject };
}

export async function promote(deps: PromoteDeps, inputs: PromoteInputs): Promise<Promotion> {
  const { version, rollback, reason } = inputs;

  // `permission` is the legacy base role (maintain reads as write); `role_name` names maintain.
  const perm = await deps.ghApi(`repos/${deps.repo}/collaborators/${encodeURIComponent(deps.actor)}/permission`) as { permission?: string; role_name?: string };
  const role = perm.role_name || perm.permission || 'none';
  if (perm.permission !== 'admin' && !PROMOTER_ROLES.has(role)) throw new Refusal(`${deps.actor} has the ${role} role on ${deps.repo}; only admins and maintainers promote to stable, so ask one to dispatch this workflow.`);
  deps.log(`[promote-stable] ${deps.actor} has the ${role} role: allowed to promote.`);

  if (!VERSION_RE.test(version)) throw new Refusal(`version "${version}" is not a release version; pass the VERSION of a published release, like 0.60.361.0.`);
  if (rollback && !reason.trim()) throw new Refusal(ROLLBACK_NEEDS_REASON);
  const releaseRef = `refs/tags/v${version}`;
  if (!(await refExists(deps, `${releaseRef}^{commit}`))) throw new Refusal(`There is no release tag v${version}; promote a version release.yml has already published.`);
  const commit = await gitOut(deps, ['rev-parse', `${releaseRef}^{commit}`], `Could not resolve ${releaseRef}; re-run this workflow.`);
  const tree = await gitOut(deps, ['rev-parse', `${releaseRef}^{tree}`], `Could not resolve the tree of ${releaseRef}; re-run this workflow.`);
  const taggedVersion = (await deps.git(['show', `${releaseRef}:VERSION`])).stdout.trim();
  if (taggedVersion !== version) throw new Refusal(`v${version}'s VERSION file says "${taggedVersion || 'nothing'}"; promote a tag release.yml minted for its own VERSION.`);
  let release: { draft?: boolean };
  try {
    release = await deps.ghApi(`repos/${deps.repo}/releases/tags/v${version}`) as { draft?: boolean };
  } catch (error) {
    throw new Refusal(`v${version} has no published GitHub release (${(error as Error).message.split('\n')[0]}); wait for release.yml to publish it, then promote.`);
  }
  if (release.draft) throw new Refusal(`The GitHub release for v${version} is still a draft; publish it (release.yml does), then promote.`);
  deps.log(`[promote-stable] v${version} is commit ${commit}, tree ${tree}, and its GitHub release is published.`);

  const { runId, attempt } = parseRunUrl(inputs.soakRunUrl, deps.repo);
  const soakPath = requireSoakWorkflow(deps.soakWorkflow);
  const run = await deps.ghApi(`repos/${deps.repo}/actions/runs/${runId}${attempt ? `/attempts/${attempt}` : ''}`) as SoakRun;
  checkSoakRun(run, deps.soakWorkflow, inputs.soakRunUrl);
  const headSha = run.head_sha ?? '';
  if (!SHA_RE.test(headSha)) throw new Refusal(`Soak run ${inputs.soakRunUrl} reports no head commit; pass a run that checked out a commit.`);
  deps.log(`[promote-stable] soak run ${runId}${attempt ? ` attempt ${attempt}` : ''} of ${soakPath} succeeded on ${headSha}.`);

  if (!(await refExists(deps, `${headSha}^{commit}`))) await deps.git(['fetch', '--no-tags', 'origin', headSha]);
  const soakTree = await gitOut(deps, ['rev-parse', `${headSha}^{tree}`], `Could not fetch the soak run's head commit ${headSha}; check it still exists on the remote, then re-run this workflow.`);
  if (soakTree !== tree) throw new Refusal(`The soak ran tree ${soakTree} (run head ${headSha}) but v${version} is tree ${tree}; soak this exact release, then promote that run.`);
  deps.log(`[promote-stable] the soak ran the release's exact tree ${tree}.`);

  const current = await currentStable(deps);
  checkOrder(version, current?.version ?? null, rollback, reason);
  deps.log(`[promote-stable] current stable is ${current ? `v${current.version}` : 'none'}; ${rollback ? `rollback to v${version}: ${reason.trim()}` : `v${version} is newer`}.`);

  const recordRef = `refs/tags/stable-v${version}`;
  const recordExists = await refExists(deps, recordRef);
  if (recordExists && !rollback) throw new Refusal(`stable-v${version} already exists, so v${version} was promoted before; to make it stable again, re-run with rollback=true and a reason.`);
  if (recordExists) {
    const recordCommit = await gitOut(deps, ['rev-parse', `${recordRef}^{commit}`], `Could not resolve ${recordRef}; re-run this workflow.`);
    if (recordCommit !== commit) throw new Refusal(`stable-v${version} points at ${recordCommit}, not the release commit ${commit}; investigate the tags before promoting.`);
  }
  deps.log(`[promote-stable] record tag stable-v${version} ${recordExists ? 'exists (rollback re-promotion): keeping it' : 'is new: creating it'}.`);

  const fields: TagFields = {
    version, commit, tree,
    soakRun: inputs.soakRunUrl.trim(),
    scoreboard: inputs.scoreboardUrl.trim() || inputs.soakRunUrl.trim(),
    promotedBy: deps.actor,
    promotedAt: deps.now().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    previous: current?.version ?? null,
    rollback, reason,
  };
  const message = renderTagMessage(fields);
  if (!recordExists) {
    await gitOut(deps, ['tag', '-a', '--cleanup=verbatim', '-m', message, `stable-v${version}`, commit], `Could not create the tag stable-v${version}; re-run this workflow.`);
  }
  await gitOut(deps, ['tag', '-a', '-f', '--cleanup=verbatim', '-m', message, 'stable', commit], 'Could not create the stable tag; re-run this workflow.');
  // One atomic push: the record tag and stable land together or not at all. stable is leased on the tag object read above
  // (empty: stable must not exist yet), so a concurrent move refuses instead of being overwritten.
  await gitOut(deps, ['push', '--atomic', `--force-with-lease=${STABLE_REF}:${current?.tagObject ?? ''}`, 'origin',
    ...(recordExists ? [] : [`${recordRef}:${recordRef}`]), `${STABLE_REF}:${STABLE_REF}`],
    'Moving the stable tag failed and nothing changed on the remote (stable may have moved since this run read it); re-run this workflow, which re-reads the current stable.');
  if (!recordExists) deps.log(`[promote-stable] pushed record tag stable-v${version}.`);
  deps.log(`[promote-stable] stable now points at v${version} (${commit}).`);

  const promotion: Promotion = { ...fields, recordCreated: !recordExists };
  deps.summary(renderSummary(promotion));
  return promotion;
}

export function processDeps(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): PromoteDeps {
  return {
    repo: env.GITHUB_REPOSITORY ?? '',
    actor: env.GITHUB_ACTOR ?? '',
    soakWorkflow: env.STABLE_SOAK_WORKFLOW ?? '',
    async ghApi(path) {
      const r = spawnSync('gh', ['api', path], { cwd, env, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`gh api ${path} failed: ${(r.stderr || r.error?.message || '').trim()}`);
      return JSON.parse(r.stdout);
    },
    async git(args) {
      const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
      return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    },
    now: () => new Date(),
    log: line => console.log(line),
    summary: markdown => { if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown); },
  };
}

if (import.meta.main) {
  const env = process.env;
  const inputs: PromoteInputs = {
    version: (env.PROMOTE_VERSION ?? '').trim().replace(/^v/, ''),
    soakRunUrl: env.PROMOTE_SOAK_RUN_URL ?? '',
    scoreboardUrl: env.PROMOTE_SCOREBOARD_URL ?? '',
    rollback: env.PROMOTE_ROLLBACK === 'true',
    reason: env.PROMOTE_REASON ?? '',
  };
  const deps = processDeps();
  try {
    if (!deps.repo || !deps.actor) throw new Refusal('GITHUB_REPOSITORY and GITHUB_ACTOR are unset; run this from the Promote stable workflow (gh workflow run promote-stable.yml).');
    await promote(deps, inputs);
  } catch (e) {
    const why = e instanceof Refusal ? e.message : `the promotion stopped on an unexpected error (${e instanceof Error ? e.message : String(e)}); re-run this workflow, and read the log above if it repeats.`;
    console.log(`::error::Stable not promoted: ${why} Docs: ${DOCS}`);
    process.exit(1);
  }
}
