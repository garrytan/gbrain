/**
 * SkillOpt error codes -> remediation.
 *
 * Every optimizer-reply error string starts with a machine code
 * (`reflect_failure_truncated: ...`, `one_shot_rewrite_output_cap_too_small: ...`).
 * Reflect codes are normalized mode-agnostically (`reflect_truncated`), so one
 * remediation entry + one docs anchor covers both reflect calls. The receipt
 * carries one `{code, fix, docs}` entry per distinct code across
 * `reflect_errors`, `abort_detail` and the abort reason.
 */

export interface RemediationEntry {
  code: string;
  fix: string;
  docs: string;
}

const DOCS_PATH = 'docs/guides/skillopt.md';

const RAISE_CAP = 'The optimizer ran out of output tokens. Raise the cap: --reflect-max-tokens <n> or gbrain config set skillopt.reflect_max_tokens <n>.';
const CONTRACT = 'The optimizer is not following the edits JSON contract. Try a different --optimizer-model.';
const PROVIDER = 'The optimizer provider call failed. Check the provider (gbrain models doctor), then resume the run.';
const CONTEXT = 'The optimizer context window cannot hold the prompt plus the output cap. Lower --reflect-max-tokens / skillopt.reflect_max_tokens, or use an --optimizer-model with a larger context window.';

const FIXES: Readonly<Record<string, string>> = {
  reflect_truncated: RAISE_CAP,
  reflect_empty_reply: CONTRACT,
  reflect_no_parseable_edits: CONTRACT,
  reflect_invalid_edits: CONTRACT,
  reflect_context_too_small: CONTEXT,
  reflect_context_overflow: CONTEXT,
  reflect_failed: PROVIDER,
  one_shot_rewrite_truncated: RAISE_CAP,
  one_shot_rewrite_output_cap_too_small: 'Raise --reflect-max-tokens / skillopt.reflect_max_tokens, or use the default reflect mode.',
  one_shot_rewrite_body_truncated: 'The skill body does not fit the optimizer context. Lower --reflect-max-tokens / skillopt.reflect_max_tokens (the output cap shares the window), use a larger-context --optimizer-model, or use the default reflect mode.',
  one_shot_rewrite_empty_reply: CONTRACT,
  one_shot_rewrite_failed: PROVIDER,
  budget_exhausted: 'Raise --max-cost-usd (cycle runs: gbrain config set cycle.skillopt.per_skill_cap_usd <usd>). Each optimizer call reserves its full output cap, so lowering --reflect-max-tokens / skillopt.reflect_max_tokens also helps.',
  runtime_exceeded: 'Raise --max-runtime-min, then resume the run.',
  reservation_exceeds_cap: 'One call alone reserves more than the cost cap, so no model call was made. Lower --reflect-max-tokens / skillopt.reflect_max_tokens, pick a cheaper model, or raise --max-cost-usd (cycle runs: gbrain config set cycle.skillopt.per_skill_cap_usd <usd>).',
};

/** Every code that can appear in `remediation[].code` (docs table pins this). */
export const SKILLOPT_REMEDIATION_CODES: readonly string[] = Object.keys(FIXES);

export const OPTIMIZER_OUTPUT_UNUSABLE = 'optimizer_output_unusable';

/** Normalized code of an error string, or undefined when it carries none we map. */
export function errorCode(message: string): string | undefined {
  let head = message.trim();
  if (head.startsWith(`${OPTIMIZER_OUTPUT_UNUSABLE}:`)) head = head.slice(OPTIMIZER_OUTPUT_UNUSABLE.length + 1).trim();
  const raw = head.split(':', 1)[0]!.trim();
  const reflect = raw.match(/^reflect_(?:failure|success)_(.+)$/);
  const code = reflect ? `reflect_${reflect[1]}` : raw;
  return Object.hasOwn(FIXES, code) ? code : undefined;
}

export function buildRemediation(
  messages: readonly string[],
  abortReason?: string,
): RemediationEntry[] {
  const codes = new Set<string>();
  for (const m of messages) {
    const c = errorCode(m);
    if (c) codes.add(c);
  }
  if (abortReason === 'budget_exhausted' || abortReason === 'runtime_exceeded') codes.add(abortReason);
  return [...codes].map((code) => ({ code, fix: FIXES[code]!, docs: `${DOCS_PATH}#${code}` }));
}

const MAX_RECORDED_ERRORS = 20;
const MAX_ERROR_CHARS = 300;

/** Append to a receipt error list: deduped, at most 20 entries of 300 chars. */
export function recordReflectError(list: string[], message: string): void {
  const clipped = message.length > MAX_ERROR_CHARS ? message.slice(0, MAX_ERROR_CHARS) : message;
  if (list.length >= MAX_RECORDED_ERRORS || list.includes(clipped)) return;
  list.push(clipped);
}
