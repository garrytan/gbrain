/**
 * codex-hooks.ts — the codex `hooks.json` writer (SessionEnd capture lane).
 *
 * SPEC TARGET (verified): codex-cli 0.147.0, observation run 2026-08-25
 * (live captures + openai/codex source at tag rust-v0.147.0). The facts this
 * writer is built on, none of them guesses:
 *
 *  - File: $CODEX_HOME/hooks.json. TOP-LEVEL DENY-UNKNOWN-FIELDS: any extra
 *    top-level key makes codex skip the WHOLE file with only a stderr
 *    warning — so ownership rides the one legal metadata slot
 *    (`description`) plus a command-substring token, never a `_gbrain` key.
 *  - Schema: {description?, hooks: {SessionEnd: [{matcher?, hooks:
 *    [{type:'command', command:<shell string via $SHELL -lc>, timeout:<sec>,
 *    async?, …}]}]}} — PascalCase event names.
 *  - TRUST GATE (fail-closed, SILENT): a user-layer hook runs ONLY when
 *    $CODEX_HOME/config.toml carries
 *    [hooks.state."<abs hooks.json path>:session_end:<group>:<handler>"]
 *    trusted_hash = "sha256:" + sha256hex(compact canonical JSON, keys
 *    sorted recursively, of the normalized identity {event_name, matcher?,
 *    hooks:[{type, command, timeout, async, …}]}, None fields omitted).
 *    Without it the hook is listed and NEVER EXECUTED, with zero warnings in
 *    `codex exec` output. So this writer writes TWO files, and any command
 *    edit re-hashes.
 *  - SessionEnd handlers are hard-killed at 3s — the command captures stdin
 *    to a temp file and detaches a grandchild (`nohup … &`) that runs the
 *    real `gbrain hook session-end --harness codex`, so ingest time never
 *    races the kill.
 *  - Deliberately NO GBRAIN_SOURCE in the command [OV2]: hooks.json is
 *    user-global; a baked source would stamp every codex session on the
 *    machine with the last-bootstrapped repo. session-end resolves everything
 *    from the payload (cwd/transcript_path/session_id) at runtime — and it
 *    reads no GBRAIN_SOURCE at all, so the ambient-env tier [EV4] cannot
 *    misattribute this lane either.
 *  - Index sensitivity (documented residual): the trust key embeds our
 *    group's index in the SessionEnd array. A fresh install APPENDS last; a
 *    re-run REPLACES our group IN PLACE — so writing never shifts a FOREIGN
 *    group's index (append-after-strip would shift every foreign group that
 *    sat after ours, silently staling THEIR trust entries). If the user later
 *    reorders/removes their own groups, OUR entry can go stale — the hook
 *    then silently stops, which is exactly what doctor's
 *    codex-wired-but-zero-receipts rung exists to name. Uninstall does shift
 *    foreign groups after ours (array removal is inherently index-shifting);
 *    removeCodexHooks says so in its notes when that happens.
 *  - Version sensitivity: all of this is pinned to 0.147.0 with no upstream
 *    stability promise — re-run the observation gate on codex version bumps.
 */

import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { atomicWriteTextFile } from './atomic-write.ts';
import type { HostSpecTarget } from './host-specs.ts';
import { CODEX_HOOK_EVENTS, codexConfigPath, codexHooksPath } from './host-specs.ts';

export const CODEX_HOOKS_SPEC_TARGET: HostSpecTarget = {
  id: 'codex-hooks-2026-08',
  status: 'verified',
  verifiedAt: '2026-08-25',
  references: [
    'codex-cli 0.147.0 observation run 2026-08-25 (live SessionEnd payload + trust-gate captures)',
    'openai/codex tag rust-v0.147.0: hooks/discovery.rs, hooks/fingerprint.rs, config_rules.rs',
  ],
  note:
    'hooks.json is top-level deny-unknown-fields (description is the one legal metadata slot); ' +
    'user-layer hooks are trust-gated via [hooks.state."<path>:session_end:<g>:<h>"].trusted_hash ' +
    'in config.toml (silent non-execution without it); SessionEnd budget 3s hard-kill; payload ' +
    '{session_id, transcript_path, cwd, hook_event_name, reason:"other" always}; fires on normal/' +
    'API-error exit + SIGINT, never SIGKILL; rollout flushed before the hook.',
};

/** Substring that marks a SessionEnd handler as gbrain-owned (the command
 * string is the only marker surface deny-unknown-fields leaves us). */
export const CODEX_HOOK_OWNERSHIP_TOKEN = 'hook session-end --harness codex';

const GBRAIN_DESCRIPTION =
  'gbrain session-end capture — the SessionEnd entry whose command mentions "gbrain" is managed by `gbrain bootstrap` (re-runs rewrite it; `gbrain bootstrap uninstall` deletes it)';

const TRUST_BLOCK_BEGIN = '# --- gbrain:codex-hooks-trust (managed block — do not edit; gbrain bootstrap rewrites it) ---';
const TRUST_BLOCK_END = '# --- /gbrain:codex-hooks-trust ---';

/** The hooks.json event key this lane manages — derived from host-specs so
 * the declared event list and the writer can never drift apart. */
const SESSION_END_EVENT: string = CODEX_HOOK_EVENTS[0];

/** Strip the managed trust block (and trailing blank lines) out of a
 * config.toml text — THE one implementation for write and remove, so a
 * marker or CRLF-handling change can never half-propagate. */
function stripTrustBlock(text: string): { remainder: string[]; crlf: boolean; found: boolean } {
  const crlf = text.includes('\r\n');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const begin = lines.indexOf(TRUST_BLOCK_BEGIN);
  const end = lines.indexOf(TRUST_BLOCK_END);
  const found = begin >= 0 && end > begin;
  const remainder = found ? [...lines.slice(0, begin), ...lines.slice(end + 1)] : [...lines];
  while (remainder.length > 0 && remainder[remainder.length - 1]!.trim() === '') remainder.pop();
  return { remainder, crlf, found };
}

/** SessionEnd is hard-clamped to 3s by codex; declare exactly that. */
const SESSION_END_TIMEOUT_SEC = 3;

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_.:/@=-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/**
 * The SessionEnd command: capture stdin, detach a grandchild, exit within the
 * 3s budget. Codex hands this string to `$SHELL -lc`, and $SHELL can be a
 * non-POSIX shell (fish, csh) where bare `var=value` assignments and `$( )`
 * are syntax errors — so the TOP level is a single `sh -c '<script>' <bin>`
 * invocation and only /bin/sh ever parses the POSIX script. The outer sh's
 * $0 is the gbrain binary (no nested quoting of the path); the grandchild
 * inherits GBRAIN_BIN/GBRAIN_PAYLOAD through the env-prefix assignments.
 */
export function buildCodexSessionEndCommand(gbrainBin: string): string {
  const script =
    't="$(mktemp)"; cat >"$t"; GBRAIN_PAYLOAD="$t" GBRAIN_BIN="$0" nohup sh -c ' +
    `'"$GBRAIN_BIN" ${CODEX_HOOK_OWNERSHIP_TOKEN} <"$GBRAIN_PAYLOAD"; rm -f "$GBRAIN_PAYLOAD"' >/dev/null 2>&1 &`;
  // Embed the script into an outer single-quoted argument: ' → '\'' works
  // identically in POSIX shells AND fish (escaped-quote outside quotes).
  return `sh -c '${script.replace(/'/g, "'\\''")}' ${shellQuote(gbrainBin)}`;
}

/** Compact JSON with recursively-sorted keys — codex's canonical form. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, val]) => `${JSON.stringify(k)}:${canonicalJson(val)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The trust hash for OUR SessionEnd handler shape (matcher/None fields omitted). */
export function codexTrustHash(command: string): string {
  const identity = {
    event_name: 'session_end',
    hooks: [{ type: 'command', command, timeout: SESSION_END_TIMEOUT_SEC, async: false }],
  };
  return 'sha256:' + createHash('sha256').update(canonicalJson(identity), 'utf8').digest('hex');
}

interface HooksJson {
  description?: string;
  hooks?: Record<string, Array<{ matcher?: unknown; hooks?: Array<{ type?: unknown; command?: unknown; [k: string]: unknown }> }>>;
  [k: string]: unknown;
}

function isOurGroup(group: { hooks?: Array<{ command?: unknown }> }): boolean {
  return (group.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(CODEX_HOOK_OWNERSHIP_TOKEN));
}

export interface WriteCodexHooksResult {
  ok: boolean;
  hooksPath: string;
  configPath: string;
  trustKey?: string;
  replacedPrior?: boolean;
  reason?: 'hooks_json_unparseable' | 'foreign_trust_entry' | 'config_toml_unreadable';
  notes: string[];
}

/**
 * Write (or rewrite) gbrain's SessionEnd entry + its trust-state entry.
 * Fail-closed: a hooks.json that exists but does not parse is NEVER touched
 * (codex itself would skip it; overwriting could destroy the user's own
 * hooks), and a foreign [hooks.state] entry for our exact key outside our
 * managed block is a refusal, not an overwrite.
 */
export function writeCodexHooks(opts: {
  gbrainBin: string;
  hooksPath?: string;
  configPath?: string;
}): WriteCodexHooksResult {
  const hooksPath = opts.hooksPath ?? codexHooksPath();
  const configPath = opts.configPath ?? codexConfigPath();
  const notes: string[] = [];

  // 1. hooks.json — parse (fail-closed), strip ours, append ours LAST.
  let doc: HooksJson = {};
  let existed = false;
  if (existsSync(hooksPath)) {
    existed = true;
    try {
      doc = JSON.parse(readFileSync(hooksPath, 'utf8')) as HooksJson;
      if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) throw new Error('not an object');
    } catch {
      return { ok: false, hooksPath, configPath, reason: 'hooks_json_unparseable', notes: [`${hooksPath} exists but does not parse as a JSON object — fix or remove it (codex skips it too), then re-run.`] };
    }
  }
  const hooks = (doc.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks) ? doc.hooks : {}) as NonNullable<HooksJson['hooks']>;
  const sessionEnd = Array.isArray(hooks[SESSION_END_EVENT]) ? hooks[SESSION_END_EVENT]! : [];
  const command = buildCodexSessionEndCommand(opts.gbrainBin);
  const ourGroup = { hooks: [{ type: 'command', command, timeout: SESSION_END_TIMEOUT_SEC }] };
  // Fresh install appends LAST; a re-run replaces our group IN PLACE — a
  // strip-then-append would shift every foreign group sitting after ours
  // down one index, silently staling THEIR codex trust entries.
  const priorIdx = sessionEnd.findIndex(isOurGroup);
  const replacedPrior = priorIdx >= 0;
  const withoutDupes = sessionEnd.filter((g, i) => i === priorIdx || !isOurGroup(g));
  if (withoutDupes.length !== sessionEnd.length) {
    notes.push(
      `${sessionEnd.length - withoutDupes.length} duplicate gbrain SessionEnd group(s) dropped — foreign groups after them shift down; re-trust any of your own entries that stop firing.`,
    );
  }
  const nextSessionEnd = replacedPrior ? withoutDupes.map((g, i) => (i === priorIdx ? ourGroup : g)) : [...withoutDupes, ourGroup];
  const ourGroupIndex = replacedPrior ? priorIdx : nextSessionEnd.length - 1;
  const nextDoc: HooksJson = {
    ...doc,
    ...(doc.description === undefined ? { description: GBRAIN_DESCRIPTION } : {}),
    hooks: { ...hooks, [SESSION_END_EVENT]: nextSessionEnd },
  };

  // 2. config.toml trust entry — OUR entries live inside the managed marker
  //    block; everything outside survives byte-for-byte.
  const trustKey = `${hooksPath}:session_end:${ourGroupIndex}:0`;
  let configText = '';
  if (existsSync(configPath)) {
    try {
      configText = readFileSync(configPath, 'utf8');
    } catch {
      return { ok: false, hooksPath, configPath, reason: 'config_toml_unreadable', notes: [`${configPath} exists but is unreadable — fix permissions and re-run.`] };
    }
  }
  const { remainder, crlf } = stripTrustBlock(configText);
  // Foreign-ownership guard: our table header outside our block would become
  // a duplicate-table hard parse error that bricks codex entirely. TOLERANT
  // match — any [hooks.state.…] header line mentioning our key, in either
  // TOML string spelling and any interior whitespace, not just our exact
  // JSON.stringify rendering.
  const header = `[hooks.state.${JSON.stringify(trustKey)}]`;
  const headerRe = /^\s*\[\s*hooks\s*\.\s*state\s*[.\]]/;
  if (remainder.some((l) => headerRe.test(l) && l.includes(trustKey))) {
    return {
      ok: false, hooksPath, configPath, reason: 'foreign_trust_entry',
      notes: [`${configPath} already defines a [hooks.state] entry for ${trustKey} outside the gbrain-managed block — refusing to double-define it (a hard TOML parse error). Remove that entry and re-run.`],
    };
  }
  const block = [
    TRUST_BLOCK_BEGIN,
    `${header}`,
    `trusted_hash = ${JSON.stringify(codexTrustHash(command))}`,
    TRUST_BLOCK_END,
  ];
  const nextConfig = [...(remainder.length ? [...remainder, ''] : []), ...block, ''].join('\n');

  // 3. Write both, hooks.json first (a trust entry for a missing file is
  //    inert; a hooks file without trust is silently skipped — either partial
  //    state is safe, this order just minimizes the skipped window).
  if (existed) {
    copyFileSync(hooksPath, `${hooksPath}.bak`);
    chmodSync(`${hooksPath}.bak`, 0o600);
  }
  atomicWriteTextFile(hooksPath, JSON.stringify(nextDoc, null, 2) + '\n', { freshMode: 0o600, forceMode: 0o600 });

  if (configText) {
    // DISTINCT suffix: config.toml.bak is the MCP block writer's rollback
    // anchor (harness lane [X5] restores it on a failed smoke) — reusing it
    // here would clobber that anchor and make the rollback restore THIS
    // write's post-state instead of the pre-run config.
    copyFileSync(configPath, `${configPath}.hooks.bak`);
    chmodSync(`${configPath}.hooks.bak`, statSync(configPath).mode & 0o777);
  }
  atomicWriteTextFile(configPath, crlf ? nextConfig.replace(/\n/g, '\r\n') : nextConfig, { freshMode: 0o600 });

  const foreignCount = nextSessionEnd.length - 1;
  if (foreignCount > 0) {
    notes.push(
      `${foreignCount} foreign SessionEnd group(s) preserved at their original indexes (${replacedPrior ? "gbrain's entry replaced in place" : "gbrain's entry appended last"}) so their trust-state entries never go stale.`,
    );
  }
  return { ok: true, hooksPath, configPath, trustKey, replacedPrior, notes };
}

export interface RemoveCodexHooksResult {
  hooksPath: string;
  configPath: string;
  removed: boolean;
  notes: string[];
}

/** Strip gbrain's SessionEnd entry + managed trust block. Foreign content
 * survives byte-for-byte; an unparseable hooks.json is left untouched. */
export function removeCodexHooks(opts: { hooksPath?: string; configPath?: string } = {}): RemoveCodexHooksResult {
  const hooksPath = opts.hooksPath ?? codexHooksPath();
  const configPath = opts.configPath ?? codexConfigPath();
  const notes: string[] = [];
  let removed = false;

  if (existsSync(hooksPath)) {
    try {
      const doc = JSON.parse(readFileSync(hooksPath, 'utf8')) as HooksJson;
      const hooks = (doc.hooks ?? {}) as NonNullable<HooksJson['hooks']>;
      const sessionEnd = Array.isArray(hooks[SESSION_END_EVENT]) ? hooks[SESSION_END_EVENT]! : [];
      const ourIdx = sessionEnd.findIndex(isOurGroup);
      const foreign = sessionEnd.filter((g) => !isOurGroup(g));
      let changed = false;
      if (foreign.length !== sessionEnd.length) {
        changed = true;
        if (foreign.length > 0) hooks[SESSION_END_EVENT] = foreign;
        else delete hooks[SESSION_END_EVENT];
        // Removal is inherently index-shifting for anything AFTER ours — the
        // user's own trust entries for those groups go stale (silent
        // non-execution). Say so instead of leaving them to find out.
        if (ourIdx >= 0 && ourIdx < sessionEnd.length - 1) {
          notes.push(
            `${sessionEnd.length - 1 - ourIdx} of your own SessionEnd group(s) sat after gbrain's — their index just shifted down, so codex will treat their config.toml trust entries as stale. Re-trust them (codex prompts on next run) or update the [hooks.state] indexes.`,
          );
        }
      }
      // Same only-if-we-wrote-it discipline as the writer: the description is
      // deleted only when it is byte-identical to ours.
      if (doc.description === GBRAIN_DESCRIPTION) {
        delete doc.description;
        changed = true;
      }
      if (changed) {
        removed = true;
        atomicWriteTextFile(hooksPath, JSON.stringify({ ...doc, hooks }, null, 2) + '\n', { freshMode: 0o600, forceMode: 0o600 });
      }
    } catch {
      notes.push(`${hooksPath} does not parse — left untouched (nothing gbrain wrote survives a hand-mangled file; remove it manually).`);
    }
  }

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, 'utf8');
    const { remainder, crlf, found } = stripTrustBlock(raw);
    if (found) {
      removed = true;
      const next = remainder.length ? remainder.join('\n') + '\n' : '';
      atomicWriteTextFile(configPath, crlf ? next.replace(/\n/g, '\r\n') : next, { forceMode: statSync(configPath).mode & 0o777 });
    }
  }
  return { hooksPath, configPath, removed, notes };
}
