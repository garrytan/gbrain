/**
 * Onboard + SkillOpt operation cluster — pure move from operations.ts
 * (v0.46.x tranche 3): the v0.41.18.0 run_onboard remediation op and the
 * v0.41.20.0 run_skillopt optimization op (adjacent slots at the tail of the
 * canonical array). Op consts stay module-private; `skilloptOperations`
 * below lists them in EXACTLY the order they appear in the canonical
 * `operations` array in ../operations.ts. Never import from
 * '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { OperationError } from './contract.ts';

// v0.41.18.0 (A7 + T16, codex finding #5): MCP op for federated / thin-client
// brain installs to drive `gbrain onboard --auto` over MCP. Admin scope
// (NOT localOnly) so remote agents authenticated via OAuth can probe
// brain health + submit auto-eligible remediation handlers.
//
// Critical security gate (codex #5): admin scope alone is NOT sufficient
// to submit handlers in PROTECTED_JOB_NAMES (synthesize, patterns,
// consolidate, extract-takes-from-pages, contextual_reindex_per_chunk).
// Without this gate, an admin-scoped OAuth token would bypass the same
// guard that `submit_job` enforces. The new NAMED scope
// `run_protected_onboard` MUST be granted IN ADDITION TO admin for any
// protected child handler to fire.
//
// Behavior:
//   - mode='check' (default): returns the OnboardReport JSON envelope,
//     never submits jobs. Admin scope sufficient.
//   - mode='auto':            submits auto_apply tier. Admin + non-protected
//                             handlers only.
//   - mode='auto-with-prompt': submits auto_apply + prompt_required tier.
//                             Same protection check.
//
// Any LLM-bearing handler the plan would have submitted gets filtered out
// unless the caller has run_protected_onboard. Filtered items appear in
// the response with status='skipped_missing_scope' so the caller knows
// what they would have gotten with the right grants.
const run_onboard: Operation = {
  name: 'run_onboard',
  description: 'Probe brain health + optionally submit onboard remediations. Admin scope required. Protected handlers (LLM-bearing) require run_protected_onboard scope ADDITIONALLY.',
  params: {
    mode: { type: 'string', description: "'check' (default), 'auto', or 'auto-with-prompt'" },
    target_score: { type: 'number', description: 'Target brain_score (default 90)' },
    max_usd: { type: 'number', description: 'USD cap for autopilot path (required for auto modes)' },
  },
  mutating: true,
  scope: 'admin',
  handler: async (ctx, p) => {
    const mode = (typeof p.mode === 'string' ? p.mode : 'check') as 'check' | 'auto' | 'auto-with-prompt';
    const targetScore = typeof p.target_score === 'number' ? p.target_score : 90;
    const maxUsd = typeof p.max_usd === 'number' ? p.max_usd : undefined;

    const { computeRemediationPlan, runRemediation } = await import('../remediation/index.ts');
    const { runAllOnboardChecks } = await import('../onboard/checks.ts');
    const { buildOnboardReport } = await import('../onboard/render.ts');

    // Per A26: source-scope via sourceScopeOpts(ctx). The recommendation
    // planner is brain-wide today; future extension can scope by reading
    // ctx.sourceId / ctx.auth.allowedSources for per-source plans.

    let extraRemediations: import('../remediation-step.ts').RemediationStep[] = [];
    try {
      const checkResults = await runAllOnboardChecks(ctx.engine);
      extraRemediations = checkResults.flatMap((r) => r.remediations);
    } catch {
      // Fail-open per A19 — return plan without extras rather than error.
    }

    // 'check' mode: just return the plan + JSON envelope. No submission.
    if (mode === 'check') {
      const plan = await computeRemediationPlan(ctx.engine, { targetScore, extraRemediations });
      const report = buildOnboardReport(plan);
      return report;
    }

    // 'auto' and 'auto-with-prompt' modes: require --max-usd per A12 + A20
    // safety posture (cron-safety; refuses surprise spend).
    if (maxUsd === undefined) {
      throw new OperationError('invalid_params', `mode='${mode}' requires max_usd (cron-safety cap)`);
    }

    // Critical T16 + codex #5 security gate: filter out PROTECTED_JOB_NAMES
    // unless the caller has the run_protected_onboard scope IN ADDITION
    // to admin. Admin alone is insufficient.
    const grantedScopes = ctx.auth?.scopes ?? [];
    const canRunProtected = grantedScopes.includes('run_protected_onboard');
    const { isProtectedJobName } = await import('../minions/protected-names.ts');

    const skippedMissingScope: Array<{ id: string; job: string; reason: string }> = [];
    const allowedExtras = extraRemediations.filter((r) => {
      if (canRunProtected) return true;
      if (isProtectedJobName(r.job)) {
        skippedMissingScope.push({ id: r.id, job: r.job, reason: 'requires run_protected_onboard scope' });
        return false;
      }
      return true;
    });

    // Run remediation with filtered extras. Hooks emit nothing — MCP
    // returns structured result. Per A23 client_id attribution: stamp
    // job.data.client_id on each submission so the spend chain (T10)
    // attributes correctly. The library doesn't do this today; the
    // upstream submit-side gating in submit_job filters protected names
    // for ctx.remote !== false callers, so even if MCP run_onboard had a
    // typo, the underlying queue.add would reject. Defense-in-depth.
    const result = await runRemediation(
      ctx.engine,
      { targetScore, maxUsd, extraRemediations: allowedExtras },
      {},
    );

    return {
      ...result,
      skipped_missing_scope: skippedMissingScope,
    };
  },
};

// v0.41.20.0 SkillOpt — MCP exposure (admin scope + per-skill allowlist
// via `skillopt.allowed_skills` config, DEFAULT DENY-ALL for remote
// callers; CLI bypasses via ctx.remote === false). Designed for trusted
// admin tokens that want to drive optimization remotely; the same trust
// gates as the CLI fire (working tree, install path, lock acquisition,
// bundled-skill guard). NOT localOnly so admin HTTP MCP clients can invoke.
const run_skillopt: Operation = {
  name: 'run_skillopt',
  description: 'Run SkillOpt against a single skill. Admin scope; mutating; rate-limited per-skill via DB lock. See gbrain skillopt CLI for the full flag surface.',
  params: {
    skill_name: { type: 'string', required: true, description: 'Kebab-case skill name (resolves to skills/<name>/SKILL.md)' },
    benchmark_path: { type: 'string', description: 'Absolute path to benchmark JSONL; defaults to skills/<name>/skillopt-benchmark.jsonl' },
    epochs: { type: 'number', description: 'Default 4' },
    batch_size: { type: 'number', description: 'Default 8' },
    lr: { type: 'number', description: 'Default 4' },
    max_cost_usd: { type: 'number', description: 'Default 5.00' },
    no_mutate: { type: 'boolean', description: 'Write proposed.md without replacing SKILL.md' },
    allow_mutate_bundled: { type: 'boolean', description: 'Required to mutate bundled skills' },
    held_out_path: { type: 'string', description: 'Path to a held-out test set (JSONL). REQUIRED (>=5 rows) to mutate a bundled skill in place — otherwise the run hard-refuses. Remote callers: must resolve within the skills directory.' },
    dry_run: { type: 'boolean', description: 'Cost preview, no LLM calls' },
  },
  mutating: true,
  scope: 'admin',
  localOnly: false,
  handler: async (ctx, p) => {
    // SECURITY: skill_name is joined into filesystem paths (SKILL.md, default
    // benchmark, checkpoint, history, best.md, proposed.md). A traversal-shaped
    // name (`../`, absolute) would escape the skills dir even WITH the
    // caller-supplied-path confinement below. Validate kebab-only up front so
    // every derived path is contained by construction. Applies to all callers.
    const skillNameRaw = (p.skill_name as string) ?? '';
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skillNameRaw)) {
      throw new OperationError('invalid_params', `run_skillopt: skill_name must be kebab-case (matching ^[a-z0-9][a-z0-9-]*$); got '${skillNameRaw}'`);
    }
    if (ctx.remote !== false) {
      // Remote: enforce per-skill allowlist read from config.
      // `skillopt.allowed_skills` is a JSON-array config of skill names
      // an admin-scoped OAuth client may target. Default DENY-ALL: when
      // unset, MCP cannot drive skillopt on any skill.
      const allowedRaw = await ctx.engine.getConfig('skillopt.allowed_skills');
      let allowed: string[] = [];
      try {
        if (allowedRaw) allowed = JSON.parse(allowedRaw) as string[];
      } catch { /* fall through to deny */ }
      const skillName = (p.skill_name as string) ?? '';
      if (!allowed.includes(skillName)) {
        throw new OperationError('permission_denied', `run_skillopt: skill '${skillName}' is not in skillopt.allowed_skills allowlist (default deny-all for remote callers)`);
      }
    }
    const { runSkillOpt } = await import('../skillopt/orchestrator.ts');
    const { autoDetectSkillsDirReadOnly } = await import('../repo-root.ts');
    const { resolveModel } = await import('../model-config.ts');
    const detected = autoDetectSkillsDirReadOnly(process.cwd());
    const skillsDir = detected.dir;
    if (!skillsDir) {
      throw new OperationError('config_error', 'run_skillopt: skills directory not found');
    }
    const optimizerModel = await resolveModel(ctx.engine, { tier: 'deep', fallback: 'anthropic:claude-opus-4-7' });
    const targetModel = await resolveModel(ctx.engine, { tier: 'subagent', fallback: 'anthropic:claude-sonnet-4-6' });
    const judgeModel = await resolveModel(ctx.engine, { tier: 'reasoning', fallback: 'anthropic:claude-sonnet-4-6' });
    const skillName = p.skill_name as string;
    const benchmarkPath = (p.benchmark_path as string) ??
      `${skillsDir}/${skillName}/skillopt-benchmark.jsonl`;
    const heldOutPath = p.held_out_path as string | undefined;
    // SECURITY: remote callers must NOT be able to point benchmark/held-out at
    // arbitrary host files (loadBenchmark → fs.readFileSync would otherwise be an
    // arbitrary-read + existence oracle). Confine any caller-supplied path to the
    // skills directory. Local CLI callers (ctx.remote === false) are unconfined.
    if (ctx.remote !== false) {
      const nodePath = await import('node:path');
      const nodeFs = await import('node:fs');
      const rootReal = (() => {
        try { return nodeFs.realpathSync(skillsDir); } catch { return nodePath.resolve(skillsDir); }
      })();
      const confine = (label: string, candidate: string | undefined): void => {
        if (!candidate) return;
        const resolved = nodePath.resolve(candidate);
        let real = resolved;
        try {
          real = nodeFs.realpathSync(resolved);
        } catch {
          // Not yet present: canonicalize the nearest existing ancestor so a
          // legit in-dir path under a symlinked skillsDir (e.g. macOS /tmp ->
          // /private/tmp, Conductor worktrees) isn't wrongly rejected.
          try { real = nodePath.join(nodeFs.realpathSync(nodePath.dirname(resolved)), nodePath.basename(resolved)); }
          catch { /* parent also missing; fall back to resolved form */ }
        }
        if (real !== rootReal && !real.startsWith(rootReal + nodePath.sep)) {
          throw new OperationError('permission_denied', `run_skillopt: ${label} must resolve within the skills directory for remote callers`);
        }
      };
      confine('benchmark_path', p.benchmark_path as string | undefined);
      confine('held_out_path', heldOutPath);
    }
    const result = await runSkillOpt({
      engine: ctx.engine,
      skillName,
      skillsDir,
      benchmarkPath,
      epochs: (p.epochs as number) ?? 4,
      batchSize: (p.batch_size as number) ?? 8,
      lr: (p.lr as number) ?? 4,
      lrSchedule: 'cosine',
      split: [4, 1, 5],
      optimizerModel,
      targetModel,
      judgeModel,
      mode: 'patch',
      dryRun: (p.dry_run as boolean) === true,
      noMutate: (p.no_mutate as boolean) === true,
      allowMutateBundled: (p.allow_mutate_bundled as boolean) === true,
      bootstrapReviewed: false,
      ...(heldOutPath ? { heldOutPath } : {}),
      json: true,
      maxCostUsd: (p.max_cost_usd as number) ?? 5.0,
      maxRuntimeMin: 30,
      force: false,
    });
    return {
      outcome: result.outcome,
      receipt: result.receipt,
      mutated_skill_file: result.mutatedSkillFile,
      proposed_path: result.proposedPath,
    };
  },
};

export const skilloptOperations: Operation[] = [run_onboard, run_skillopt];
