/**
 * Interview engine for `gbrain bootstrap interview` (library module — no CLI
 * parsing; the dispatcher in src/commands/bootstrap/ calls these functions).
 *
 * State lives at `<workspace>/state/interview.json` (COMMITTED — identity
 * source of truth, same sensitivity as the rendered USER.md; makes
 * re-render-on-new-machine work). All writes are atomic (tmp + rename).
 *
 * Hardening carried from the plan (docs/designs/AGENT_BOOTSTRAP_PLAN.md):
 *  - [G12] Reads detect git conflict markers and return a typed,
 *    agent-readable error — never a thrown SyntaxError.
 *  - [G10] `setAnswer` enforces per-key maxLength / rejectValues / allowed
 *    lists, strips control characters, and escapes `{{` / `}}` at set time.
 *    THE ESCAPE (documented contract, relied on by render.ts and the
 *    unresolved-token sweep): every `{{` becomes `{ {` and every `}}` becomes
 *    `} }`, applied repeatedly until no adjacent brace pair remains. The
 *    renderer's token regex (`/\{\{([A-Z0-9_]+)\}\}/`) can never match the
 *    escaped form, the renderer never re-interprets it, and the post-render
 *    token sweep cannot trip on it.
 *  - [A8] Per-answer `set_at` provenance. `confirm` requires the hash of the
 *    exact answer set that was read back (`readBackHash`); any later
 *    setAnswer/skipAnswer invalidates a prior confirm (the `confirmed` block
 *    is cleared), so a single-batch set+confirm-without-readback cannot pass.
 *  - [CX2-13] Keys marked `persist: false` + `sink: 'config'` (PROVIDER_KEY)
 *    NEVER touch interview.json, never appear in hashes/provenance/logs or in
 *    error messages; `setAnswer` returns `{ sink: 'config', key }` and the
 *    caller routes the value through `routeProviderKeyToConfig` (the existing
 *    0600 config-file API in src/core/config.ts).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { loadQuestionBank, type QuestionBank, type QuestionSpec } from './assets.ts';
import { configPath, loadConfigFileOnly, saveConfig, type GBrainConfig } from '../config.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InterviewAnswer {
  value: string;
  /** ISO timestamp of when this answer was set [A8]. */
  set_at: string;
  skipped?: boolean;
}

export interface InterviewState {
  version: 1;
  answers: Record<string, InterviewAnswer>;
  /** Set by `confirm` after a successful read-back hash match [A8]. */
  confirmed?: { hash: string; at: string };
}

export type InterviewErrorCode =
  | 'conflict_markers'
  | 'invalid_json'
  | 'invalid_shape'
  | 'newer_version'
  | 'unknown_key'
  | 'empty_value'
  | 'too_long'
  | 'rejected_value'
  | 'not_allowed'
  | 'required_key'
  | 'incomplete'
  | 'hash_mismatch'
  | 'config_missing'
  | 'unrecognized_key_shape'
  | 'io_error';

/** Typed, agent-readable failure. `message` is safe to relay verbatim to the
 * human — it never contains an answer value (secret-hygiene for sink keys). */
export interface InterviewError {
  ok: false;
  code: InterviewErrorCode;
  message: string;
}

export interface InterviewStatus {
  ok: true;
  /** Required bank keys with no non-skipped answer. */
  missingRequired: string[];
  /** Keys with a non-skipped persisted answer, sorted. */
  answered: string[];
  /** Keys explicitly skipped, sorted. */
  skipped: string[];
  /** True when every required key is answered. */
  complete: boolean;
  /** True when a `confirmed` block exists AND its hash still matches the
   * current answer set (a later setAnswer clears it, so this can only be
   * true for the exact set that was read back). */
  confirmed: boolean;
}

export interface ShowEntry {
  key: string;
  question?: string;
  required: boolean;
  answered: boolean;
  skipped: boolean;
  value?: string;
  set_at?: string;
  default?: string;
}

// ---------------------------------------------------------------------------
// State file plumbing
// ---------------------------------------------------------------------------

export function interviewStatePath(workspaceDir: string): string {
  return join(workspaceDir, 'state', 'interview.json');
}

function freshState(): InterviewState {
  return { version: 1, answers: {} };
}

/**
 * Read + validate the state file. Never throws for expected failure modes:
 * conflict markers [G12], invalid JSON, wrong shape, newer version — each
 * returns a typed error whose message the agent can relay.
 */
export function readInterviewState(
  workspaceDir: string
): { ok: true; state: InterviewState; exists: boolean } | InterviewError {
  const path = interviewStatePath(workspaceDir);
  if (!existsSync(path)) return { ok: true, state: freshState(), exists: false };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { ok: false, code: 'io_error', message: `could not read ${path}: ${(e as Error).message}` };
  }
  if (raw.includes('<<<<<<<') || raw.includes('>>>>>>>')) {
    return {
      ok: false,
      code: 'conflict_markers',
      message:
        `${path} contains git conflict markers — resolve the merge in state/interview.json ` +
        `(keep the answer set the principal actually confirmed), then retry.`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      code: 'invalid_json',
      message:
        `${path} is not valid JSON (${(e as Error).message}). ` +
        `Fix or delete the file, then re-run the interview (answers may need re-entry).`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: 'invalid_shape', message: `${path} must contain a JSON object.` };
  }
  const s = parsed as Record<string, unknown>;
  if (typeof s.version !== 'number') {
    return { ok: false, code: 'invalid_shape', message: `${path} is missing a numeric "version" field.` };
  }
  if (s.version > 1) {
    return {
      ok: false,
      code: 'newer_version',
      message: `${path} has version ${s.version}, written by a newer gbrain — upgrade this binary before continuing.`,
    };
  }
  if (typeof s.answers !== 'object' || s.answers === null || Array.isArray(s.answers)) {
    return { ok: false, code: 'invalid_shape', message: `${path} is missing an "answers" object.` };
  }
  return { ok: true, state: s as unknown as InterviewState, exists: true };
}

/** Atomic write (tmp + rename) — a killed interview never leaves a torn file. */
function writeInterviewState(workspaceDir: string, state: InterviewState): void {
  const path = interviewStatePath(workspaceDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** Create `<ws>/state/interview.json` if absent. Idempotent; refuses to
 * clobber an existing-but-broken file (returns its typed read error). */
export function initState(
  workspaceDir: string
): { ok: true; created: boolean; path: string } | InterviewError {
  const read = readInterviewState(workspaceDir);
  if (!read.ok) return read;
  if (read.exists) return { ok: true, created: false, path: interviewStatePath(workspaceDir) };
  try {
    writeInterviewState(workspaceDir, freshState());
  } catch (e) {
    return { ok: false, code: 'io_error', message: `could not create interview state: ${(e as Error).message}` };
  }
  return { ok: true, created: true, path: interviewStatePath(workspaceDir) };
}

// ---------------------------------------------------------------------------
// Value sanitization [G10]
// ---------------------------------------------------------------------------

/**
 * Set-time sanitization, in order:
 *  1. Normalize CRLF/CR to LF.
 *  2. Strip control characters except newline and tab.
 *  3. Escape template braces: `{{` → `{ {` and `}}` → `} }`, repeated until
 *     stable (single-pass replace can leave adjacent pairs in runs like
 *     `{{{{`). See the module doc for why this escape is the contract.
 *  4. Trim leading/trailing whitespace.
 * Exported for direct unit testing.
 */
export function sanitizeAnswerValue(raw: string): string {
  let v = raw.replace(/\r\n?/g, '\n');
  // eslint-disable-next-line no-control-regex
  v = v.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  while (v.includes('{{')) v = v.replaceAll('{{', '{ {');
  while (v.includes('}}')) v = v.replaceAll('}}', '} }');
  return v.trim();
}

function bankSpec(bank: QuestionBank, key: string): QuestionSpec | undefined {
  return bank.questions[key];
}

function isConfigSink(spec: QuestionSpec): boolean {
  return spec.persist === false && spec.sink === 'config';
}

function requiredKeys(bank: QuestionBank): string[] {
  return bank.interviewKeys.filter((k) => bank.questions[k]?.required === true);
}

// ---------------------------------------------------------------------------
// setAnswer / skipAnswer
// ---------------------------------------------------------------------------

export type SetAnswerResult =
  | { ok: true; sink: 'state'; key: string; value: string; invalidatedConfirmation?: boolean }
  /** Config-sink keys [CX2-13]: nothing persisted here; the caller routes the
   * value via `routeProviderKeyToConfig`. The value is deliberately NOT
   * echoed back in this result. */
  | { ok: true; sink: 'config'; key: string }
  | InterviewError;

export function setAnswer(workspaceDir: string, key: string, rawValue: string): SetAnswerResult {
  const bank = loadQuestionBank();
  const spec = bankSpec(bank, key);
  if (!spec) {
    return {
      ok: false,
      code: 'unknown_key',
      message: `"${key}" is not in the question bank. Known keys: ${Object.keys(bank.questions).sort().join(', ')}.`,
    };
  }

  const value = sanitizeAnswerValue(rawValue);
  if (value === '') {
    return {
      ok: false,
      code: 'empty_value',
      message: `"${key}" got an empty answer. To decline an optional question use skip; required questions need a real answer.`,
    };
  }
  if (value.length > spec.maxLength) {
    return {
      ok: false,
      code: 'too_long',
      message:
        `answer for "${key}" is ${value.length} characters after sanitization; the limit is ${spec.maxLength}. ` +
        `Truncate it to the essential part (or split the overflow into a follow-up note) and set it again.`,
    };
  }

  // Config-sink keys bypass everything below: no persistence, no hash
  // membership, no value in the return or in any message [CX2-13].
  if (isConfigSink(spec)) {
    return { ok: true, sink: 'config', key };
  }

  if (spec.rejectValues && spec.rejectValues.includes(value.toLowerCase())) {
    return {
      ok: false,
      code: 'rejected_value',
      message: `"${value}" is a placeholder, not an answer for ${key}. Ask again for a real one (rejected: ${spec.rejectValues.filter((r) => r !== '').join(', ')}).`,
    };
  }
  let stored = value;
  if (spec.allowed) {
    const match = spec.allowed.find((a) => a.toLowerCase() === value.toLowerCase());
    if (!match) {
      return {
        ok: false,
        code: 'not_allowed',
        message: `"${key}" must be one of: ${spec.allowed.join(', ')}.`,
      };
    }
    stored = match; // store the canonical spelling
  }

  const read = readInterviewState(workspaceDir);
  if (!read.ok) return read;
  const state = read.state;
  state.answers[key] = { value: stored, set_at: new Date().toISOString() };
  // Any change invalidates a prior read-back confirmation [A8]. Surfaced to
  // the caller so the CLI can WARN — silently voiding the confirmation used
  // to fail much later, at render, with no pointer back to this --set.
  const invalidatedConfirmation = state.confirmed !== undefined;
  delete state.confirmed;
  try {
    writeInterviewState(workspaceDir, state);
  } catch (e) {
    return { ok: false, code: 'io_error', message: `could not write interview state: ${(e as Error).message}` };
  }
  return { ok: true, sink: 'state', key, value: stored, invalidatedConfirmation };
}

export function skipAnswer(
  workspaceDir: string,
  key: string
): { ok: true; sink: 'state' | 'config'; key: string; skipped: true; invalidatedConfirmation?: boolean } | InterviewError {
  const bank = loadQuestionBank();
  const spec = bankSpec(bank, key);
  if (!spec) {
    return { ok: false, code: 'unknown_key', message: `"${key}" is not in the question bank.` };
  }
  if (spec.required === true) {
    return {
      ok: false,
      code: 'required_key',
      message: `"${key}" is required and cannot be skipped — the interview gate stays closed until it has a real answer.`,
    };
  }
  // Config-sink keys persist nothing, including the skip [CX2-13].
  if (isConfigSink(spec)) {
    return { ok: true, sink: 'config', key, skipped: true };
  }
  const read = readInterviewState(workspaceDir);
  if (!read.ok) return read;
  const state = read.state;
  state.answers[key] = { value: '', set_at: new Date().toISOString(), skipped: true };
  // Same [A8] invalidation-surfacing as setAnswer.
  const invalidatedConfirmation = state.confirmed !== undefined;
  delete state.confirmed;
  try {
    writeInterviewState(workspaceDir, state);
  } catch (e) {
    return { ok: false, code: 'io_error', message: `could not write interview state: ${(e as Error).message}` };
  }
  return { ok: true, sink: 'state', key, skipped: true, invalidatedConfirmation };
}

// ---------------------------------------------------------------------------
// status / readBackHash / confirm / show
// ---------------------------------------------------------------------------

function answeredKeys(state: InterviewState): string[] {
  return Object.keys(state.answers)
    .filter((k) => state.answers[k] && state.answers[k]!.skipped !== true)
    .sort();
}

export function status(workspaceDir: string): InterviewStatus | InterviewError {
  const bank = loadQuestionBank();
  const read = readInterviewState(workspaceDir);
  if (!read.ok) return read;
  const state = read.state;
  const answered = answeredKeys(state);
  const skipped = Object.keys(state.answers)
    .filter((k) => state.answers[k]?.skipped === true)
    .sort();
  const missingRequired = requiredKeys(bank).filter((k) => !answered.includes(k));
  const complete = missingRequired.length === 0;
  let confirmed = false;
  if (state.confirmed && complete) {
    confirmed = state.confirmed.hash === computeHash(state);
  }
  return { ok: true, missingRequired, answered, skipped, complete, confirmed };
}

/** Stable hash over the sorted (key, value) pairs of every non-skipped
 * persisted answer. Config-sink values can never appear here [CX2-13]. */
function computeHash(state: InterviewState): string {
  const pairs = answeredKeys(state).map((k) => [k, state.answers[k]!.value]);
  return createHash('sha256').update(JSON.stringify(pairs), 'utf8').digest('hex');
}

/**
 * The hash of the exact answer set to read back to the human [A8]. Errors
 * until every required key is answered — an incomplete set has nothing worth
 * confirming. `confirm` only accepts this value, computed AFTER the final
 * answer landed; setting any answer afterwards changes the hash.
 */
export function readBackHash(
  workspaceDir: string
): { ok: true; hash: string; keys: string[] } | InterviewError {
  const bank = loadQuestionBank();
  const read = readInterviewState(workspaceDir);
  if (!read.ok) return read;
  const state = read.state;
  const answered = answeredKeys(state);
  const missing = requiredKeys(bank).filter((k) => !answered.includes(k));
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'incomplete',
      message: `cannot read back an incomplete interview — still missing required: ${missing.join(', ')}.`,
    };
  }
  return { ok: true, hash: computeHash(state), keys: answered };
}

/**
 * Record the principal's confirmation of the read-back [A8]. `providedHash`
 * must equal the CURRENT `readBackHash` — confirming a set the human never
 * saw (stale hash, guessed hash, answers changed since read-back) fails.
 */
export function confirm(
  workspaceDir: string,
  providedHash: string
): { ok: true; hash: string; at: string } | InterviewError {
  const current = readBackHash(workspaceDir);
  if (!current.ok) return current;
  if (providedHash !== current.hash) {
    return {
      ok: false,
      code: 'hash_mismatch',
      message:
        `confirmation hash does not match the current answer set. The answers changed since they were ` +
        `read back (or were never read back). Read the full set back to the principal, then confirm ` +
        `with the hash from that read-back.`,
    };
  }
  const read = readInterviewState(workspaceDir);
  if (!read.ok) return read;
  const state = read.state;
  const at = new Date().toISOString();
  state.confirmed = { hash: current.hash, at };
  try {
    writeInterviewState(workspaceDir, state);
  } catch (e) {
    return { ok: false, code: 'io_error', message: `could not write interview state: ${(e as Error).message}` };
  }
  return { ok: true, hash: current.hash, at };
}

/**
 * The read-back payload: one entry per interview key (question text, current
 * answer/skip/default), plus any persisted consent answers, plus the
 * confirmation hash when the required set is complete. The dispatcher renders
 * this to the human and quotes `hash` for `confirm`.
 */
export function show(workspaceDir: string):
  | { ok: true; entries: ShowEntry[]; extras: ShowEntry[]; hash?: string; confirmed: boolean }
  | InterviewError {
  const bank = loadQuestionBank();
  const read = readInterviewState(workspaceDir);
  if (!read.ok) return read;
  const state = read.state;

  const toEntry = (key: string): ShowEntry => {
    const spec = bank.questions[key];
    const a = state.answers[key];
    return {
      key,
      question: spec?.question,
      required: spec?.required === true,
      answered: !!a && a.skipped !== true,
      skipped: a?.skipped === true,
      ...(a && a.skipped !== true ? { value: a.value } : {}),
      ...(a ? { set_at: a.set_at } : {}),
      ...(spec?.default !== undefined ? { default: spec.default } : {}),
    };
  };

  const entries = bank.interviewKeys.map(toEntry);
  const extras = Object.keys(state.answers)
    .filter((k) => !bank.interviewKeys.includes(k))
    .sort()
    .map(toEntry);

  const st = status(workspaceDir);
  if (!st.ok) return st;
  const result: { ok: true; entries: ShowEntry[]; extras: ShowEntry[]; hash?: string; confirmed: boolean } = {
    ok: true,
    entries,
    extras,
    confirmed: st.confirmed,
  };
  if (st.complete) {
    const h = readBackHash(workspaceDir);
    if (h.ok) result.hash = h.hash;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Config sink routing [CX2-13]
// ---------------------------------------------------------------------------

/** Provider detection by key shape. Order matters: `sk-ant-` before `sk-`. */
const PROVIDER_KEY_SHAPES: Array<{ prefix: string; configKey: ProviderConfigKey; label: string }> = [
  { prefix: 'sk-ant-', configKey: 'anthropic_api_key', label: 'Anthropic (sk-ant-…)' },
  { prefix: 'sk-', configKey: 'openai_api_key', label: 'OpenAI (sk-…)' },
  { prefix: 'pa-', configKey: 'voyage_api_key', label: 'Voyage (pa-…)' },
];

export type ProviderConfigKey = 'anthropic_api_key' | 'openai_api_key' | 'voyage_api_key';

/**
 * Route an interview-provided provider key to the 0600 config file — the ONLY
 * legal destination for a `sink: 'config'` answer [CX2-13]. Reads the file
 * plane only (`loadConfigFileOnly`) so env-merged values are never baked into
 * the file, and writes through `saveConfig` (0600 + chmod + per-home
 * .gitignore). Error messages NEVER contain the key material.
 */
export function routeProviderKeyToConfig(
  rawValue: string
): { ok: true; configKey: ProviderConfigKey } | InterviewError {
  const bank = loadQuestionBank();
  const spec = bank.questions['PROVIDER_KEY'];
  const maxLength = spec?.maxLength ?? 256;
  const value = rawValue.trim();
  if (value === '') {
    return { ok: false, code: 'empty_value', message: 'no key provided — use skip to decline the provider-key question.' };
  }
  if (value.length > maxLength) {
    return { ok: false, code: 'too_long', message: `provider key is ${value.length} characters; the limit is ${maxLength}. Check the paste.` };
  }
  if (/[\x00-\x1f\x7f\s]/.test(value)) {
    return { ok: false, code: 'unrecognized_key_shape', message: 'provider key contains whitespace or control characters — check the paste.' };
  }
  const shape = PROVIDER_KEY_SHAPES.find((s) => value.startsWith(s.prefix));
  if (!shape) {
    return {
      ok: false,
      code: 'unrecognized_key_shape',
      message: `key shape not recognized. Supported: ${PROVIDER_KEY_SHAPES.map((s) => s.label).join(', ')}.`,
    };
  }
  const config = loadConfigFileOnly();
  if (!config) {
    return {
      ok: false,
      code: 'config_missing',
      message: `no gbrain config found at ${configPath()} — run \`gbrain init\` first, then set the provider key again.`,
    };
  }
  const next: GBrainConfig = { ...config, [shape.configKey]: value };
  try {
    saveConfig(next);
  } catch (e) {
    return { ok: false, code: 'io_error', message: `could not write config: ${(e as Error).message}` };
  }
  return { ok: true, configKey: shape.configKey };
}
