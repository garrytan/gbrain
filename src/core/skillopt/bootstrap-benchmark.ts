/**
 * SkillOpt bootstrap benchmark generators (D15).
 *
 * Two generators write `skills/<name>/skillopt-benchmark.jsonl`, both gated by
 * the BOOTSTRAP_PENDING_REVIEW sentinel (final line) — the user must hand-review,
 * delete the sentinel, then re-run with --bootstrap-reviewed before SkillOpt can
 * use the file. Both refuse to overwrite an existing benchmark unless --force.
 *
 *  1. runBootstrap (--bootstrap-from-routing): reads `routing-eval.jsonl` and
 *     makes one LLM call PER routing intent to emit rule checks. Tests dispatch
 *     phrasing, not output quality. Requires a pre-existing routing-eval.
 *
 *  2. runBootstrapFromSkill (--bootstrap-from-skill): reads the SKILL.md itself
 *     and makes ONE LLM call that emits a full starter benchmark (tasks + rule
 *     judges) as JSONL — no routing-eval dependency. JSONL output is parsed
 *     line-by-line with skip-bad-line salvage (D5) so a truncated final line
 *     drops instead of zeroing the run; a task is kept only when >=2 valid rule
 *     checks survive (D6). The generated checks are weak DRAFTS the reviewer is
 *     expected to strengthen.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chat as gatewayChat } from '../ai/gateway.ts';
import { errorFor } from '../errors.ts';
import { atomicWrite } from './apply-edits.ts';
import { BOOTSTRAP_PENDING_REVIEW, type RuleCheck } from './types.ts';

const BOOTSTRAP_SYSTEM = `You are SkillOpt's bootstrap-benchmark generator. Given a user intent that triggers a SKILL, generate 2-4 deterministic rule checks that would verify a successful execution.

Output ONLY a single JSON object on one line:
{"checks": [{"op": "<op>", "arg": <arg>}, ...]}

Valid ops:
  - contains:        arg: string — output must contain this substring
  - regex:           arg: regex string — output must match
  - section_present: arg: heading text — output must have this ## heading
  - max_chars:       arg: number — output ≤ N chars
  - min_citations:   arg: number — output has ≥N citations
  - tool_called:     arg: tool name — agent called this tool
  - tool_not_called: arg: tool name — agent avoided this tool

Be SPECIFIC. "max_chars: 4000" is more useful than "max_chars: 999999". A skill that should produce a structured report should have section_present checks.`;

const BOOTSTRAP_FROM_SKILL_SYSTEM = `You are SkillOpt's from-skill benchmark generator. Given a SKILL.md, infer what the skill is supposed to PRODUCE and what a GOOD output looks like, then generate realistic benchmark tasks that test OUTPUT QUALITY (not routing).

Output JSONL: ONE JSON object per line, NO surrounding array, NO prose, NO markdown fences. Each line is exactly:
{"task": "<a realistic user prompt this skill handles>", "checks": [{"op": "<op>", "arg": <arg>}, ...]}

Each task MUST carry at least 2 deterministic rule checks. Valid ops:
  - contains:        arg: string — output must contain this substring
  - regex:           arg: regex string — output must match
  - section_present: arg: heading text — output must have this ## heading
  - max_chars:       arg: number — output <= N chars
  - min_citations:   arg: number — output has >=N citations
  - tool_called:     arg: tool name — agent called this tool
  - tool_not_called: arg: tool name — agent avoided this tool

Rules:
- Cover the boring middle the skill actually handles, not just edge cases.
- Be SPECIFIC: "max_chars: 4000" beats "max_chars: 999999"; real heading names beat invented ones.
- Only use tool_called / tool_not_called for tools the skill ACTUALLY declares in its frontmatter "tools:" list. Do NOT invent tool names.
- Prefer 3-4 checks per task when the skill's quality bar supports them.`;

export interface BootstrapOpts {
  skillsDir: string;
  skillName: string;
  optimizerModel: string;
  force?: boolean;
  /** Test seam — substitute gateway.chat. */
  chatFn?: typeof gatewayChat;
}

export interface BootstrapResult {
  outputPath: string;
  rowsGenerated: number;
  rowsSkipped: number;
}

export async function runBootstrap(opts: BootstrapOpts): Promise<BootstrapResult> {
  const { skillsDir, skillName, optimizerModel, force } = opts;
  const chat = opts.chatFn ?? gatewayChat;

  const routingPath = path.join(skillsDir, skillName, 'routing-eval.jsonl');
  if (!fs.existsSync(routingPath)) {
    throw errorFor({
      class: 'NoRoutingEval',
      code: 'no_routing_eval',
      message: `Cannot bootstrap: ${routingPath} does not exist.`,
      hint: `Create a routing-eval.jsonl file first (gbrain skillify scaffold <name> generates one).`,
    });
  }

  const outputPath = path.join(skillsDir, skillName, 'skillopt-benchmark.jsonl');
  assertBenchmarkAbsent(outputPath, !!force);

  // Read the skill body for context.
  const skillPath = path.join(skillsDir, skillName, 'SKILL.md');
  const skillBody = readSkillBodyOrThrow(skillPath);

  // Parse routing-eval rows; skip malformed lines instead of crashing the whole
  // bootstrap on one bad line.
  const routingRows = fs.readFileSync(routingPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try { return JSON.parse(l) as { intent: string; expected_skill: string }; } catch { return null; }
    })
    .filter((r): r is { intent: string; expected_skill: string } =>
      r !== null && typeof r.intent === 'string' && typeof r.expected_skill === 'string');

  const generated: string[] = [];
  let skipped = 0;
  for (let i = 0; i < routingRows.length; i++) {
    const row = routingRows[i]!;
    if (row.expected_skill !== skillName) continue; // Only generate for our skill.
    const userMsg = `SKILL BODY:\n${skillBody.slice(0, 4000)}\n\nUSER INTENT:\n${row.intent}\n\nGenerate 2-4 rule checks the agent's response should pass.`;
    try {
      const result = await chat({
        model: optimizerModel,
        system: BOOTSTRAP_SYSTEM,
        messages: [{ role: 'user', content: userMsg }],
        maxTokens: 500,
        cacheSystem: true,
      });
      const checks = parseChecksResponse(result.text);
      if (checks.length === 0) {
        skipped += 1;
        continue;
      }
      generated.push(JSON.stringify({
        task_id: `bootstrap-${String(i + 1).padStart(3, '0')}`,
        task: row.intent,
        judge: { kind: 'rule', checks },
      }));
    } catch (err) {
      skipped += 1;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[skillopt] bootstrap row ${i + 1} failed: ${msg}\n`);
    }
  }

  if (generated.length === 0) {
    throw errorFor({
      class: 'BootstrapEmpty',
      code: 'bootstrap_empty',
      message: `Bootstrap generated 0 tasks (all rows skipped or routing-eval has no matching rows for '${skillName}').`,
      hint: `Check that routing-eval.jsonl has rows where expected_skill='${skillName}' and the optimizer model is reachable.`,
    });
  }

  const output = [...generated, BOOTSTRAP_PENDING_REVIEW, ''].join('\n');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  atomicWrite(outputPath, output);

  process.stderr.write(`[skillopt] Bootstrap wrote ${generated.length} tasks to ${outputPath} (${skipped} rows skipped).\n`);
  process.stderr.write(`[skillopt] REVIEW the file, then delete the trailing '${BOOTSTRAP_PENDING_REVIEW}' line and re-run with --bootstrap-reviewed.\n`);

  return { outputPath, rowsGenerated: generated.length, rowsSkipped: skipped };
}

function parseChecksResponse(raw: string): RuleCheck[] {
  try {
    const fenced = raw.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
    const cleaned = (fenced ? fenced[1]! : raw).trim();
    const parsed = JSON.parse(cleaned) as { checks?: unknown };
    if (parsed && Array.isArray(parsed.checks)) {
      return validateChecks(parsed.checks);
    }
  } catch { /* try fallback */ }
  // Fallback: first {...} substring.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as { checks?: unknown };
    if (parsed && Array.isArray(parsed.checks)) {
      return validateChecks(parsed.checks);
    }
  } catch { /* fall through */ }
  return [];
}

function validateChecks(raw: unknown[]): RuleCheck[] {
  const VALID = new Set(['contains', 'regex', 'section_present', 'max_chars', 'min_citations', 'tool_called', 'tool_not_called']);
  const out: RuleCheck[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.op === 'string' && VALID.has(o.op) && (typeof o.arg === 'string' || typeof o.arg === 'number')) {
      out.push({ op: o.op as RuleCheck['op'], arg: o.arg });
    }
  }
  return out;
}

// ─── from-skill generator (--bootstrap-from-skill) ──────────────────────────

export interface BootstrapFromSkillOpts {
  skillsDir: string;
  skillName: string;
  optimizerModel: string;
  /** How many starter tasks to request. Default 15. CLI caps the flag at 50. */
  taskCount?: number;
  force?: boolean;
  /** Test seam — substitute gateway.chat. */
  chatFn?: typeof gatewayChat;
}

/**
 * Generate a starter benchmark from the SKILL.md alone (no routing-eval).
 *
 * One LLM call emits JSONL tasks; we salvage line-by-line (D5) and keep a task
 * only when >=2 valid rule checks survive (D6). Provider/transport errors from
 * the chat call PROPAGATE — they are NOT collapsed into bootstrap_empty, so the
 * CLI surfaces the real failure instead of a misleading "0 tasks" message.
 */
export async function runBootstrapFromSkill(opts: BootstrapFromSkillOpts): Promise<BootstrapResult> {
  const { skillsDir, skillName, optimizerModel } = opts;
  const taskCount = opts.taskCount ?? 15;
  const chat = opts.chatFn ?? gatewayChat;

  const outputPath = path.join(skillsDir, skillName, 'skillopt-benchmark.jsonl');
  assertBenchmarkAbsent(outputPath, !!opts.force);

  const skillPath = path.join(skillsDir, skillName, 'SKILL.md');
  const skillBody = readSkillBodyOrThrow(skillPath);

  const userMsg = `SKILL BODY:\n${skillBody.slice(0, 8000)}\n\nGenerate ${taskCount} realistic benchmark tasks as JSONL (one JSON object per line, no array, no fences). Each task needs at least 2 rule checks. Output ONLY the JSONL lines.`;

  // NOTE: no try/catch here — a provider/transport throw propagates to the CLI.
  const result = await chat({
    model: optimizerModel,
    system: BOOTSTRAP_FROM_SKILL_SYSTEM,
    messages: [{ role: 'user', content: userMsg }],
    maxTokens: Math.min(8000, Math.max(4000, taskCount * 220)),
    cacheSystem: true,
  });

  const { generated, skipped } = parseSkillBenchmarkJsonl(result.text, skillName);

  if (generated.length === 0) {
    throw errorFor({
      class: 'BootstrapEmpty',
      code: 'bootstrap_empty',
      message: `Bootstrap-from-skill generated 0 usable tasks for '${skillName}'.`,
      hint: `The model returned no parseable JSONL tasks with >=2 valid checks. Re-run, or verify the optimizer model is reachable.`,
    });
  }

  const output = [...generated, BOOTSTRAP_PENDING_REVIEW, ''].join('\n');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  atomicWrite(outputPath, output);

  process.stderr.write(`[skillopt] Bootstrap-from-skill wrote ${generated.length} tasks to ${outputPath} (${skipped} dropped).\n`);
  if (generated.length < 15) {
    process.stderr.write(`[skillopt] WARNING: only ${generated.length} task(s) generated. The recommended --split 1:1:1 needs >=15 (D_sel >= 5); below that the optimizer refuses with d_sel_too_small. Add tasks or re-run.\n`);
  }
  process.stderr.write(`[skillopt] REVIEW + STRENGTHEN the generated rule checks (they are weak drafts), delete the trailing '${BOOTSTRAP_PENDING_REVIEW}' line, then run:\n`);
  process.stderr.write(`[skillopt]   gbrain skillopt ${skillName} --bootstrap-reviewed --split 1:1:1\n`);

  return { outputPath, rowsGenerated: generated.length, rowsSkipped: skipped };
}

/**
 * Parse JSONL benchmark tasks from the model's from-skill output (D5 salvage).
 *
 * Strips a single optional wrapping ```json/```jsonl fence, then parses line by
 * line. A malformed line (incl. a truncated final line) is skipped, not fatal —
 * the rest survive. A task is kept only when >=2 valid rule checks survive
 * validation (D6); otherwise the whole task is dropped and counted. task_ids are
 * assigned contiguously over KEPT tasks (<skillName>-001..NNN) so they're unique
 * and stable for loadBenchmark's duplicate-id check.
 */
function parseSkillBenchmarkJsonl(raw: string, skillName: string): { generated: string[]; skipped: number } {
  const fence = raw.match(/```(?:json|jsonl)?\s*\n?([\s\S]*?)```/i);
  const body = fence ? fence[1]! : raw;
  const lines = body.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

  const generated: string[] = [];
  let skipped = 0;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped += 1;
      continue;
    }
    if (!parsed || typeof parsed !== 'object') { skipped += 1; continue; }
    const o = parsed as Record<string, unknown>;
    const task = typeof o.task === 'string' ? o.task.trim() : '';
    if (!task) { skipped += 1; continue; }
    const checks = Array.isArray(o.checks) ? validateChecks(o.checks) : [];
    if (checks.length < 2) { skipped += 1; continue; } // D6: drop the whole task
    generated.push(JSON.stringify({
      task_id: `${skillName}-${String(generated.length + 1).padStart(3, '0')}`,
      task,
      judge: { kind: 'rule', checks },
    }));
  }
  return { generated, skipped };
}

// ─── shared helpers (used by both bootstrap generators) ─────────────────────

/** Overwrite guard: refuse to clobber an existing benchmark unless force. */
function assertBenchmarkAbsent(outputPath: string, force: boolean): void {
  if (fs.existsSync(outputPath) && !force) {
    throw errorFor({
      class: 'BenchmarkExists',
      code: 'benchmark_exists',
      message: `Benchmark already exists at ${outputPath}.`,
      hint: `Pass --force to overwrite, or remove the file first.`,
    });
  }
}

/** Read SKILL.md or throw a structured no_skill_md error. */
function readSkillBodyOrThrow(skillPath: string): string {
  try {
    return fs.readFileSync(skillPath, 'utf8');
  } catch {
    throw errorFor({
      class: 'NoSkill',
      code: 'no_skill_md',
      message: `Cannot read ${skillPath}.`,
      hint: `The skill must exist before bootstrapping its benchmark.`,
    });
  }
}
