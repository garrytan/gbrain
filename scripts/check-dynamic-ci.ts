#!/usr/bin/env bun
/**
 * Trunk Dynamic CI wiring guard (registered in scripts/guards-manifest.tsv;
 * docs/ci-event-parity.md#trunk-dynamic-ci).
 *
 * A filter job runs trunk-io/dynamic-ci and writes one output per gated job;
 * a gated job runs unless its output is exactly 'false'. Merge and release
 * evidence (the full-ci dispatch, master pushes, the merge queue, schedules)
 * must never be filtered, and a filter outage must never skip a job. So, in
 * every workflow under .github/workflows:
 *
 *   - a filter job (any job with a trunk-io/dynamic-ci step) runs only with
 *     `if: github.event_name == 'pull_request'`, in a workflow that has a
 *     pull_request trigger, with the action pinned to a commit SHA, the token
 *     from secrets.TRUNK_API_TOKEN, and `job-keys` naming exactly the jobs
 *     its `outputs` re-export as `steps.<id>.outputs.<key>`, and
 *     `continue-on-error: true` plus a step timeout below the job's on that
 *     step, so a failed or hung step reads as "run";
 *   - a gated job (one whose key is a filter output and that needs the filter)
 *     has an `if` that starts `!cancelled() && needs.<filter>.outputs.<key>
 *     != 'false' &&`, requires `needs.<other>.result == 'success'` for each
 *     other job it needs (what the implicit success() checked before), uses
 *     no other status function, and has no top-level || after the prefix;
 *   - every other job that needs a filter only reads its outputs: its `if`
 *     starts with always(), and it is not a filter output;
 *   - every filter output is a job that needs that filter, and no merge or
 *     release aggregate (full-suite, e2e-full-suite, test-status, e2e-status,
 *     executed-receipts, reused-full-suite, cheap-tier) is gated.
 *
 * Fix: copy the form of an existing gated job in .github/workflows/test.yml.
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

type Step = { id?: string; uses?: string; with?: Record<string, unknown>; 'continue-on-error'?: unknown; 'timeout-minutes'?: unknown };
type Job = { 'timeout-minutes'?: unknown; if?: unknown; needs?: string | string[]; outputs?: Record<string, unknown>; steps?: Step[] };
type Workflow = { on?: unknown; jobs?: Record<string, Job> };

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const ACTION = 'trunk-io/dynamic-ci@';
const NEVER_GATED = new Set(['full-suite', 'e2e-full-suite', 'test-status', 'e2e-status', 'executed-receipts', 'reused-full-suite', 'cheap-tier']);

const expr = (value: unknown) => String(value ?? '').trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, '$1').replace(/\s+/g, ' ');
const needsOf = (job: Job) => (job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]);
const hasPullRequest = (on: unknown) =>
  on === 'pull_request' || (Array.isArray(on) && on.includes('pull_request')) || (typeof on === 'object' && on !== null && 'pull_request' in on);

function topLevelOr(expression: string): boolean {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i];
    if (c === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && c === '|' && expression[i + 1] === '|') return true;
  }
  return false;
}

export function checkWorkflow(file: string, doc: Workflow): string[] {
  const problems: string[] = [];
  const jobs = doc.jobs ?? {};
  const filters = new Map<string, { stepId: string; outputs: string[] }>();
  for (const [key, job] of Object.entries(jobs)) {
    const step = (job.steps ?? []).find(s => typeof s.uses === 'string' && s.uses.startsWith(ACTION));
    if (!step) continue;
    const at = `${file} › ${key}`;
    if (expr(job.if) !== "github.event_name == 'pull_request'") problems.push(`${at}: the filter job must have if: github.event_name == 'pull_request' (got ${JSON.stringify(expr(job.if))}); on any other event it must be skipped so every gated job runs`);
    if (!hasPullRequest(doc.on)) problems.push(`${at}: the workflow has no pull_request trigger, so it carries merge or release evidence and must not filter jobs`);
    if (!/^trunk-io\/dynamic-ci@[0-9a-f]{40}$/.test(step.uses!)) problems.push(`${at}: pin ${step.uses} to a full commit SHA`);
    if (String(step.with?.token ?? '').trim() !== '${{ secrets.TRUNK_API_TOKEN }}') problems.push(`${at}: the token must be \${{ secrets.TRUNK_API_TOKEN }}`);
    if (step['continue-on-error'] !== true) problems.push(`${at}: the dynamic-ci step needs continue-on-error: true, so a failed step leaves the outputs empty (run) instead of a red check on the head`);
    if (!(Number(step['timeout-minutes']) > 0 && Number(step['timeout-minutes']) < Number(job['timeout-minutes'] ?? 360))) problems.push(`${at}: the dynamic-ci step needs a timeout-minutes below the job's, so a hanging Trunk call times out the step (absorbed by continue-on-error) before it times out the job`);
    if (!step.id) { problems.push(`${at}: the dynamic-ci step needs an id`); continue; }
    const outputs = Object.keys(job.outputs ?? {}).sort();
    const keys = String(step.with?.['job-keys'] ?? '').split(',').map(k => k.trim()).filter(Boolean).sort();
    if (JSON.stringify(keys) !== JSON.stringify(outputs)) problems.push(`${at}: job-keys [${keys.join(', ')}] must name exactly the re-exported outputs [${outputs.join(', ')}]`);
    for (const out of outputs) {
      const want = `\${{ steps.${step.id}.outputs.${out} }}`;
      if (String(job.outputs![out]).trim() !== want) problems.push(`${at}: output ${out} must be ${want}`);
    }
    filters.set(key, { stepId: step.id, outputs });
  }
  for (const [filter, { outputs }] of filters) {
    for (const out of outputs) {
      if (!jobs[out]) problems.push(`${file} › ${filter}: output ${out} names no job`);
      else if (!needsOf(jobs[out]!).includes(filter)) problems.push(`${file} › ${out}: a gated job must list ${filter} in needs`);
      if (NEVER_GATED.has(out)) problems.push(`${file} › ${out}: merge and release aggregates are never gated by Dynamic CI`);
    }
  }
  for (const [key, job] of Object.entries(jobs)) {
    const needs = needsOf(job);
    for (const filter of needs.filter(n => filters.has(n))) {
      const at = `${file} › ${key}`;
      const condition = expr(job.if);
      if (!filters.get(filter)!.outputs.includes(key)) {
        if (!condition.startsWith('always()')) problems.push(`${at}: needs ${filter} but is not one of its outputs; only an aggregate whose if starts with always() may read the verdicts`);
        continue;
      }
      const prefix = `!cancelled() && needs.${filter}.outputs.${key} != 'false' && `;
      if (!condition.startsWith(prefix)) {
        problems.push(`${at}: a gated job's if must start with "${prefix}" (got ${JSON.stringify(condition)}); without !cancelled() a skipped or failed filter skips the job, and only an exact 'false' verdict may skip it`);
        continue;
      }
      const rest = condition.slice(prefix.length);
      if (/\b(?:always|success|failure|cancelled)\(\)/.test(rest)) problems.push(`${at}: no other status function may follow the gate prefix`);
      if (topLevelOr(rest)) problems.push(`${at}: wrap the condition after the gate prefix in parentheses; a top-level || would run the job past a 'false' verdict or a failed need`);
      for (const other of needs.filter(n => n !== filter)) {
        if (!rest.includes(`needs.${other}.result == 'success'`)) problems.push(`${at}: add needs.${other}.result == 'success' after the gate prefix; !cancelled() drops the implicit success() that kept the job from running when ${other} failed`);
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const dir = join(ROOT, '.github/workflows');
  const files = existsSync(dir) ? readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort() : [];
  const problems = files.flatMap(f => checkWorkflow(f, load(readFileSync(join(dir, f), 'utf8')) as Workflow));
  if (problems.length) {
    console.error(`check-dynamic-ci: ${problems.length} problem(s)\n${problems.map(p => `  ✗ ${p}`).join('\n')}\nFix: copy the form of an existing gated job in .github/workflows/test.yml (docs/ci-event-parity.md#trunk-dynamic-ci).`);
    process.exit(1);
  }
  console.log(`check-dynamic-ci: ok (${files.length} workflows)`);
}
