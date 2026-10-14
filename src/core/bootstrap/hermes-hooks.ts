/**
 * hermes-hooks.ts — the Hermes shell-hook items and consent store behind
 * `gbrain setup hermes` (the counterpart of codex-hooks.ts).
 *
 * Spec target: Hermes Agent v0.21.7 (commit 427d605d, agent/shell_hooks.py).
 *  - Hooks live in the profile `config.yaml` as `hooks.<event>: [{command,
 *    timeout}]`. Hermes splits `command` with shlex and runs it WITHOUT a shell
 *    (`shell=False`), so a plain `env K=V <bin> hook …` line is enough.
 *  - Hermes writes the payload `{hook_event_name, session_id, cwd, profile,
 *    extra: {...}}` on stdin. Only `pre_llm_call` can inject context (stdout
 *    `{"context": "…"}`, appended to the current user message);
 *    `on_session_finalize` is an observer and carries no transcript path.
 *  - Consent: every (event, command) pair needs a first-use approval, stored in
 *    `$HERMES_HOME/shell-hooks-allowlist.json` as
 *    `{"approvals": [{event, command, approved_at, script_mtime_at_approval}]}`
 *    (sorted keys, indent 2, 0600). Unapproved hooks are skipped without a TTY.
 *    There is no content hash: the key is the exact command string.
 * Setup writes only the pairs it wrote hooks for, never `hooks_auto_accept`.
 */
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { ownedEntryFingerprint } from './adopted-connections.ts';
import { atomicWriteTextFile } from './atomic-write.ts';
import { appendHermesYamlText, readHermesConfigText, readHermesYamlText, removeHermesYamlText, writeHermesConfigText, type HermesConfigGuard } from './hermes-yaml.ts';

export const HERMES_SETUP_LANE_TOKEN = 'GBRAIN_HOOK_LANE=setup';
export const HERMES_SETUP_EVENTS = ['pre_llm_call', 'on_session_finalize'] as const;
export type HermesSetupEvent = (typeof HERMES_SETUP_EVENTS)[number];

/**
 * `gbrain hook` subcommand and Hermes timeout (seconds) per event. pre_llm_call
 * blocks the turn, so its timeout only has to sit above the hook's own
 * self-deadlines (user-prompt 0.8s, plus the first-turn digest 1.5s, or 4s
 * while the stdio serve starts); on_session_finalize returns at once because
 * the real capture runs detached.
 */
const SPECS: Record<HermesSetupEvent, { subcommand: string; timeout: number }> = {
  pre_llm_call: { subcommand: 'user-prompt', timeout: 10 },
  on_session_finalize: { subcommand: 'session-end', timeout: 5 },
};

export interface HermesHookItem { command: string; timeout: number }

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_.:/@=-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Capture stdin, then detach the real session-end so the finalize hook returns inside Hermes' budget. */
function detachedSessionEnd(bin: string): string {
  const script = 't="$(mktemp)"; cat >"$t"; GBRAIN_PAYLOAD="$t" GBRAIN_BIN="$0" nohup sh -c '
    + `'"$GBRAIN_BIN" hook session-end --harness hermes <"$GBRAIN_PAYLOAD"; rm -f "$GBRAIN_PAYLOAD"' >/dev/null 2>&1 &`;
  return `sh -c '${script.replace(/'/g, "'\\''")}' ${shellQuote(bin)}`;
}

/**
 * The `env` that leads every setup command, as an absolute path when this machine has one. Hermes' doctor
 * (`hermes hooks doctor`, `script_is_executable`) judges the FIRST path-like token of a hook command: with a bare
 * `env` that is `GBRAIN_HOME=/…` (not a file), so the hook was reported "script missing or not executable" and its
 * approval recorded no mtime. `/usr/bin/env` is a real executable that contains a `/`, so it is the token Hermes
 * inspects. (Its mtime then tracks the OS `env`, not gbrain, so a gbrain upgrade never reads as hook drift.)
 */
export const hermesEnvLauncher = (): string => (existsSync('/usr/bin/env') ? '/usr/bin/env' : 'env');

/**
 * Setup's hook item for one event. `env` pins this install: GBRAIN_HOME and GBRAIN_SOURCE on every event (so a
 * captured session lands in the same source the reads use), and HERMES_HOME where it matters (capture reads that
 * profile's state.db; the read hook pins a non-default profile so a consent receipt in it stays visible).
 */
export function hermesSetupHookItem(bin: string, event: HermesSetupEvent, env: { GBRAIN_HOME?: string; GBRAIN_SOURCE?: string; HERMES_HOME?: string }): HermesHookItem {
  const spec = SPECS[event];
  const assignments = [HERMES_SETUP_LANE_TOKEN, ...(env.GBRAIN_HOME ? [`GBRAIN_HOME=${env.GBRAIN_HOME}`] : []), ...(env.GBRAIN_SOURCE ? [`GBRAIN_SOURCE=${env.GBRAIN_SOURCE}`] : []),
    ...(env.HERMES_HOME ? [`HERMES_HOME=${env.HERMES_HOME}`] : [])];
  const launcher = hermesEnvLauncher();
  const command = event === 'on_session_finalize'
    ? `${[launcher, ...assignments].map(shellQuote).join(' ')} ${detachedSessionEnd(bin)}`
    : [launcher, ...assignments, bin, 'hook', spec.subcommand, '--harness', 'hermes'].map(shellQuote).join(' ');
  return { command, timeout: spec.timeout };
}

/** True for a command that belongs to some gbrain hermes hook lane (setup's or a hand-wired one). */
export const isGbrainHermesCommand = (command: string): boolean => /hook (user-prompt|session-start|session-end|stop) --harness hermes/.test(command);

// ── consent store ───────────────────────────────────────────────────────────

export interface HermesApproval { event: string; command: string; approved_at?: string; script_mtime_at_approval?: string | null }
export interface HermesPair { event: HermesSetupEvent; command: string }
const KNOWN_APPROVAL_KEYS = new Set(['event', 'command', 'approved_at', 'script_mtime_at_approval']);

interface AllowlistFile { exists: boolean; doc: Record<string, unknown>; approvals: unknown[]; trailingNewline: boolean }

/** Python `json.dumps(sort_keys=True, indent=2)`: the byte format Hermes itself writes. */
export function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]])) : v), 2);
}

export function readHermesAllowlist(path: string): AllowlistFile {
  if (!existsSync(path)) return { exists: false, doc: {}, approvals: [], trailingNewline: false };
  const text = readFileSync(path, 'utf8');
  let doc: unknown;
  try { doc = text.trim() === '' ? {} : JSON.parse(text); } catch {
    throw new Error(`${path} is not valid JSON; setup never rewrites a file it cannot parse (Hermes would ignore every approval in it). Fix it by hand, then run setup again.`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${path} is not a JSON object; setup never rewrites a file it cannot parse.`);
  const approvals = (doc as Record<string, unknown>).approvals;
  if (approvals !== undefined && !Array.isArray(approvals)) throw new Error(`${path} has an "approvals" key that is not a list; setup leaves it untouched.`);
  return { exists: true, doc: doc as Record<string, unknown>, approvals: (approvals as unknown[] | undefined) ?? [], trailingNewline: text.endsWith('\n') };
}

const matches = (a: unknown, pair: HermesPair): a is HermesApproval =>
  !!a && typeof a === 'object' && (a as HermesApproval).event === pair.event && (a as HermesApproval).command === pair.command;

export const isApproved = (file: AllowlistFile, pair: HermesPair): boolean => file.approvals.some((a) => matches(a, pair));
/** An approval carrying keys Hermes does not write: someone edited it, so setup treats it as theirs. */
export const approvalIsEdited = (file: AllowlistFile, pair: HermesPair): boolean =>
  file.approvals.some((a) => matches(a, pair) && Object.keys(a as object).some((k) => !KNOWN_APPROVAL_KEYS.has(k)));

function write(path: string, file: AllowlistFile, approvals: unknown[]): void {
  const doc = { ...file.doc, approvals };
  atomicWriteTextFile(path, sortedJson(doc) + (file.trailingNewline ? '\n' : ''), { forceMode: 0o600 });
}

/** Hermes' own `_command_script_path`: first token with a script extension, else first path-like token, else the first. */
export function hermesCommandScriptPath(command: string): string {
  const tokens = shlexSplit(command);
  if (tokens === null) return command;
  const first = tokens[0] ?? command;
  return tokens.find((t) => /\.(sh|bash|zsh|fish|py|pyw|rb|pl|lua|js|mjs|cjs|ts)$/i.test(t)) ?? tokens.find((t) => t.includes('/') || t.startsWith('~')) ?? first;
}

/** POSIX shlex.split; null on unbalanced quotes. */
export function shlexSplit(line: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "'") { const j = line.indexOf("'", i + 1); if (j < 0) return null; cur += line.slice(i + 1, j); has = true; i = j + 1; continue; }
    if (c === '"') {
      let j = i + 1; has = true;
      for (; j < line.length && line[j] !== '"'; j++) { if (line[j] === '\\' && '"\\$`\n'.includes(line[j + 1] ?? '')) j++; cur += line[j]; }
      if (j >= line.length) return null;
      i = j + 1; continue;
    }
    if (c === '\\') { if (i + 1 >= line.length) return null; cur += line[i + 1]; has = true; i += 2; continue; }
    if (/\s/.test(c)) { if (has) { out.push(cur); cur = ''; has = false; } i++; continue; }
    cur += c; has = true; i++;
  }
  if (has) out.push(cur);
  return out;
}

function scriptMtimeIso(command: string): string | null {
  try {
    const p = hermesCommandScriptPath(command);
    const ms = statSync(p.startsWith('~') ? p.replace(/^~/, process.env.HOME ?? '~') : p).mtimeMs;
    const us = Math.round(ms * 1000);
    const micro = us % 1_000_000;
    return `${new Date(Math.floor(us / 1_000_000) * 1000).toISOString().slice(0, 19)}${micro ? `.${String(micro).padStart(6, '0')}` : ''}Z`;
  } catch { return null; }
}

/** Approve exactly these pairs (merged with every existing approval). Returns the pairs this call added and whether it created the file. */
export function approveHermesHooks(path: string, pairs: HermesPair[]): { added: HermesPair[]; created: boolean } {
  const file = readHermesAllowlist(path);
  const added = pairs.filter((p) => !isApproved(file, p));
  if (added.length === 0) return { added, created: false };
  const stamp = new Date().toISOString().replace(/Z$/, '000Z');
  write(path, file, [...file.approvals, ...added.map((p) => ({ event: p.event, command: p.command, approved_at: stamp, script_mtime_at_approval: scriptMtimeIso(p.command) }))]);
  return { added, created: !file.exists };
}

/**
 * Remove exactly these pairs. A file setup created that ends up with no
 * approvals and no other keys is deleted; any other file keeps its remaining
 * approvals and keys. Returns the pairs that were present.
 */
export function revokeHermesHooks(path: string, pairs: HermesPair[], opts: { dryRun?: boolean; deleteIfEmpty?: boolean } = {}): HermesPair[] {
  const file = readHermesAllowlist(path);
  const present = pairs.filter((p) => isApproved(file, p));
  if (present.length === 0 || opts.dryRun) return present;
  const rest = file.approvals.filter((a) => !present.some((p) => matches(a, p)));
  if (rest.length === 0 && opts.deleteIfEmpty && Object.keys(file.doc).every((k) => k === 'approvals')) unlinkSync(path);
  else write(path, file, rest);
  return present;
}

// ── config.yaml hook items ──────────────────────────────────────────────────

export interface HermesHookCensusItem { event: HermesSetupEvent; index: number; hash: string; lane: 'setup' | 'other' | 'foreign'; command: string }

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function eventItemsText(label: string, text: string, event: HermesSetupEvent): unknown[] {
  const hooks = readHermesYamlText(label, text, ['hooks']);
  if (hooks !== undefined && !isRecord(hooks)) throw new Error(`${label}: 'hooks' is not a mapping (Hermes expects hooks.<event>: [...]); setup leaves it untouched. Fix it by hand, then run setup again.`);
  const v = readHermesYamlText(label, text, ['hooks', event]);
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`${label}: hooks.${event} is not a list; setup leaves it untouched.`);
  return v;
}

/** Every item under setup's events (from an in-memory document), fingerprinted. Throws on an unparseable config. */
export function hermesHookCensusText(label: string, text: string): HermesHookCensusItem[] {
  const out: HermesHookCensusItem[] = [];
  for (const event of HERMES_SETUP_EVENTS) {
    eventItemsText(label, text, event).forEach((item, index) => {
      if (!isRecord(item)) return;
      const command = typeof item.command === 'string' ? item.command : '';
      out.push({ event, index, hash: ownedEntryFingerprint(item), command,
        lane: command.includes(HERMES_SETUP_LANE_TOKEN) ? 'setup' : isGbrainHermesCommand(command) ? 'other' : 'foreign' });
    });
  }
  return out;
}

/** Every item under setup's events, fingerprinted. Throws on an unparseable config. */
export const hermesHookCensus = (configPath: string): HermesHookCensusItem[] => hermesHookCensusText(configPath, readHermesConfigText(configPath));

export interface HermesHookEditOpts {
  want: Partial<Record<HermesSetupEvent, HermesHookItem>>;
  owned: ReadonlySet<string>;
  preserve: ReadonlySet<string>;
  comment: string;
}

/**
 * Converge setup's hook items in an in-memory config.yaml: per event, an item whose fingerprint is in `owned` (or
 * equals the wanted one) is replaced by the wanted item (extra owned copies dropped), else the wanted item is
 * appended; an unwanted event loses only its owned items. Events in `preserve` (edited by the user) get no write.
 * Foreign and edited items are never touched. Pure: the caller decides whether to write the result, so the whole
 * sequence can be dry-run (and refused) before anything is.
 */
export function editHermesSetupHooksText(label: string, text: string, opts: HermesHookEditOpts): { text: string; changed: boolean } {
  let changed = false;
  let cur = text;
  for (const event of HERMES_SETUP_EVENTS) {
    const items = eventItemsText(label, cur, event);
    const wanted = opts.preserve.has(event) ? undefined : opts.want[event];
    const wantedHash = wanted ? ownedEntryFingerprint(wanted) : null;
    const ours = items.filter(isRecord).map(ownedEntryFingerprint).filter((h) => opts.owned.has(h) || h === wantedHash);
    if (wanted && ours.length === 1 && ours[0] === wantedHash) continue;
    if (!wanted && ours.length === 0) continue;
    for (const hash of new Set(ours)) {
      for (let guard = 0; guard < 8; guard++) {
        const r = removeHermesYamlText(label, cur, ['hooks', event], { match: (it) => isRecord(it) && ownedEntryFingerprint(it) === hash });
        if (r.result === 'unlocatable') throw new Error(`a gbrain hook item under hooks.${event} in ${label} is setup's but is written in a shape setup cannot rewrite safely; remove it by hand, then run setup again.`);
        if (r.result !== 'removed') break;
        cur = r.text;
      }
    }
    if (wanted) cur = appendHermesYamlText(label, cur, ['hooks', event], { item: wanted }, opts.comment);
    changed = true;
  }
  return { text: cur, changed };
}

/** {@link editHermesSetupHooksText} applied to the file in ONE write (a single read, guarded against a concurrent writer). */
export function writeHermesSetupHooks(configPath: string, opts: HermesHookEditOpts & { guard?: HermesConfigGuard }): { changed: boolean } {
  const raw = readHermesConfigText(configPath);
  const { text, changed } = editHermesSetupHooksText(configPath, raw, opts);
  if (changed) writeHermesConfigText(configPath, raw, text, opts.guard);
  return { changed };
}
