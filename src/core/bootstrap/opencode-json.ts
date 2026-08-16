/**
 * opencode-json.ts — managed `mcp.<name>` entry writer for opencode's JSONC
 * configs (see TARGETS['opencode-2026-08'] in host-specs.ts and
 * docs/mcp/OPENCODE-CLI-PIN.md for the verified format assumptions).
 *
 * Why a direct writer exists: `opencode mcp add` always targets the
 * user-global opencode.jsonc (no scope flag), cannot set file modes (the
 * harness lane's inline bearer needs 0600), and requires the binary on the
 * box — the writer covers project scope, secret hygiene, and offline/
 * pre-install registration with one code path.
 *
 * Safety invariants (codex-toml.ts analog, adapted for JSONC):
 * - ALL edits go through jsonc-parser `modify`/`applyEdits` — text splicing
 *   that preserves comments, formatting, and EOLs byte-for-byte outside the
 *   edited range. opencode's own `mcp add` preserves comments (observed);
 *   gbrain matches that bar. JSON.parse is never used on config text.
 * - Ownership is a STRUCTURAL FINGERPRINT, not a marker key (unknown keys
 *   are tolerated by opencode 1.18.18, but a future strict-schema flip must
 *   not brick the user's opencode): a local entry is ours when command[0] is
 *   gbrain-shaped AND environment.GBRAIN_SOURCE exists; source EQUALITY
 *   (not mere presence) splits `ours-same-source` from `ours-other-source`
 *   ([FIX7] parity with verifyMcpTargetsWorkspace) — callers warn before
 *   overwriting another workspace's registration. A remote entry is ours
 *   when its url matches the caller's receipt, or when its Authorization
 *   header carries the `{env:GBRAIN_REMOTE_TOKEN}` interpolation (only the
 *   connect lane writes that). Anything else under our name is FOREIGN —
 *   refuse, never guess.
 * - Read-failure classes are distinct: ENOENT → fresh file; empty/whitespace
 *   → treated as `{}`; unreadable (EACCES etc.) → refuse loudly (never
 *   clobber what cannot be read). A file that fails even JSONC parsing →
 *   refuse with a paste-by-hand snippet.
 * - Post-render validation before rename: the rendered text is re-parsed,
 *   our entry deep-asserted, and every OTHER top-level key asserted to
 *   survive; on any failure the original file is untouched.
 * - Secrets hygiene: when the entry carries an inline bearer the target is
 *   forced 0600. Backups are UNIQUE per operation (`<config>.bak-<hex>`,
 *   returned in the result) so two overlapping runs can never clobber each
 *   other's snapshot, and a backup is chmod'd 0600 whenever the COPIED
 *   content carries an inline bearer (write AND remove paths — on re-runs
 *   the backup carries the PREVIOUS token). Token-free entries inherit the
 *   file's existing mode.
 * - Concurrency: callers hold acquireBootstrapLock (config-dir →
 *   opencode-dir ordering, mirroring the codex lanes in harness.ts) — the
 *   writer itself is lock-free like codex-toml.ts.
 */

import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { applyEdits, modify, parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { atomicWriteTextFile } from './atomic-write.ts';
import { opencodeGlobalSiblingPath } from './host-specs.ts';

export const GBRAIN_REMOTE_TOKEN_ENV = 'GBRAIN_REMOTE_TOKEN';
const ENV_INTERPOLATION = `{env:${GBRAIN_REMOTE_TOKEN_ENV}}`;

// ── Entry shapes ────────────────────────────────────────────────────────────

export interface OpencodeLocalEntry {
  kind: 'local';
  name: string;
  /** argv — command[0] is PATH-resolved "gbrain" (project scope, committed-
   * file candidate) or an absolute binary path (user scope). */
  command: string[];
  environment: Record<string, string>;
}

export interface OpencodeRemoteEntry {
  kind: 'remote';
  name: string;
  url: string;
  /** 'inline' writes `Bearer <token>` (harness lane — framework-spawned
   * opencode inherits no shell profile; file forced 0600). 'env' writes the
   * `{env:GBRAIN_REMOTE_TOKEN}` interpolation (connect lane — token never
   * enters the file). */
  tokenMode: 'inline' | 'env';
  bearerToken?: string;
}

export type OpencodeMcpEntry = OpencodeLocalEntry | OpencodeRemoteEntry;

export type OpencodeEntryKind =
  | 'absent'
  | 'ours-same-source'
  | 'ours-other-source'
  | 'foreign';

export interface OpencodeEntryExpectation {
  /** GBRAIN_SOURCE the caller is registering (local entries). */
  sourceId?: string;
  /** Serve url from the caller's receipt (remote entries). */
  url?: string;
}

export interface WriteOpencodeEntryResult {
  configPath: string;
  /** True when a prior gbrain-owned entry was replaced (idempotent re-run). */
  replacedPrior: boolean;
  /** Kind of the pre-existing entry (what was there before this write). */
  priorKind: OpencodeEntryKind;
  /** Unique per-write backup (`<config>.bak-<hex>`) of the prior file, or
   * null on a fresh file. Callers that roll back restore from THIS path. */
  backupPath: string | null;
  /** The EXACT text this write landed — rollback callers compare the current
   * file content against it before restoring (a mismatch means a newer
   * registration exists and a restore would clobber it). */
  writtenText: string;
  notes: string[];
}

export interface RemoveOpencodeEntryResult {
  configPath: string;
  removed: boolean;
  backupPath: string | null;
  notes: string[];
}

// ── Read + parse (failure classes are distinct) ─────────────────────────────

interface RawConfig {
  text: string;
  existed: boolean;
}

function readConfigRaw(configPath: string): RawConfig {
  if (!existsSync(configPath)) return { text: '', existed: false };
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (e) {
    throw new Error(
      `${configPath} exists but cannot be read (${(e as Error).message}) — ` +
        `refusing to touch a config that cannot be read back. Fix permissions and re-run.`,
    );
  }
  return { text, existed: true };
}

/**
 * Parse config text as JSONC (opencode's effective grammar for BOTH .json
 * and .jsonc files — OPENCODE-CLI-PIN.md §Config format). Empty/whitespace
 * text parses as `{}`. Text that fails even JSONC parsing throws with a
 * paste-by-hand snippet so the user is never stranded.
 */
export function parseOpencodeConfig(text: string, configPath: string, snippet?: string): Record<string, unknown> {
  if (text.trim() === '') return {};
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) {
    const first = errors[0];
    throw new Error(
      `${configPath} does not parse as JSONC (${printParseErrorCode(first.error)} at offset ${first.offset}) — ` +
        `opencode itself cannot read it either. Fix the file, or add the entry by hand:\n${snippet ?? ''}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${configPath} is valid JSONC but not an object — fix the file and re-run.`);
  }
  return parsed as Record<string, unknown>;
}

// ── Ownership fingerprint ───────────────────────────────────────────────────

function isGbrainShapedCommand(command: unknown): boolean {
  if (!Array.isArray(command) || command.length === 0) return false;
  const head = command[0];
  if (typeof head !== 'string') return false;
  if (head === 'gbrain') return true; // PATH-resolved (project scope)
  if (/[\\/]gbrain$/.test(head)) return true; // absolute binary path
  // bun-run wrapper shim lane: `bun run <...>/gbrain/src/cli.ts` etc. The
  // arg match is ANCHORED like the head-path lane: some arg must carry an
  // exact `gbrain` path segment (or a hyphen-suffixed `gbrain-*` one) — a
  // loose substring scan classified `bun run /opt/gbrainy-fork/src/cli.ts`
  // as ours (both the `gbrain` substring and a bare `src/cli.ts$` matched).
  // A gbrain-less `bun run /repo/src/cli.ts` is now NOT ours (fail-closed:
  // gbrain refuses to touch what it cannot prove it owns).
  if (head === 'bun' || head.endsWith('/bun')) {
    return command.some((a) => typeof a === 'string' && /(?:^|[\\/])gbrain(?:[\\/-]|$)/.test(a));
  }
  // staged shim named gbrain-<suffix> (e.g. gbrain-shim from stageBinDir) —
  // hyphen-anchored so a foreign /opt/bin/gbrainy is NOT ours.
  return /[\\/]gbrain-[^\\/]*$/.test(head);
}

/**
 * Classify the `mcp.<name>` entry in parsed config. The arbiter every lane
 * consults before writing or removing (codexBlockOwnsName analog).
 */
export function opencodeEntryKind(
  parsed: Record<string, unknown>,
  name: string,
  expect: OpencodeEntryExpectation = {},
): OpencodeEntryKind {
  const mcp = parsed.mcp;
  if (typeof mcp !== 'object' || mcp === null) return 'absent';
  const entry = (mcp as Record<string, unknown>)[name];
  if (entry === undefined) return 'absent';
  if (typeof entry !== 'object' || entry === null) return 'foreign';
  const e = entry as Record<string, unknown>;

  if (e.type === 'local') {
    if (!isGbrainShapedCommand(e.command)) return 'foreign';
    const env = e.environment;
    const src =
      typeof env === 'object' && env !== null
        ? (env as Record<string, unknown>).GBRAIN_SOURCE
        : undefined;
    if (typeof src !== 'string' || src === '') return 'foreign';
    // Kind mismatch (red-team): a caller expecting a REMOTE entry (harness /
    // connect lanes pass expect.url) that finds a LOCAL gbrain entry is
    // looking at ANOTHER lane's registration (the workspace stdio lane's) —
    // never `ours-same-source`, or a silent replace (and a later --remove)
    // would eat it. `ours-other-source` fires the refuse/confirm machinery.
    if (expect.url !== undefined) return 'ours-other-source';
    if (expect.sourceId === undefined) return 'ours-same-source';
    return src === expect.sourceId ? 'ours-same-source' : 'ours-other-source';
  }

  if (e.type === 'remote') {
    if (expect.url !== undefined && e.url === expect.url) return 'ours-same-source';
    const headers = e.headers;
    const auth =
      typeof headers === 'object' && headers !== null
        ? (headers as Record<string, unknown>).Authorization
        : undefined;
    if (typeof auth === 'string' && auth.includes(ENV_INTERPOLATION)) {
      // Only the gbrain connect lane writes the {env:GBRAIN_REMOTE_TOKEN}
      // interpolation — unambiguously ours even without a receipt url. But a
      // url mismatch (another serve) OR a LOCAL expectation (expect.sourceId
      // — the workspace stdio lane; the kind-mismatch mirror of the local
      // branch above) is another lane's wiring: ours-other-source.
      return expect.url === undefined && expect.sourceId === undefined
        ? 'ours-same-source'
        : 'ours-other-source';
    }
    return 'foreign';
  }

  return 'foreign';
}

// ── Rendering ───────────────────────────────────────────────────────────────

function entryValue(entry: OpencodeMcpEntry): Record<string, unknown> {
  if (entry.kind === 'local') {
    return {
      type: 'local',
      command: entry.command,
      environment: entry.environment,
      enabled: true,
    };
  }
  const token =
    entry.tokenMode === 'inline'
      ? `Bearer ${entry.bearerToken ?? ''}`
      : `Bearer ${ENV_INTERPOLATION}`;
  return {
    type: 'remote',
    url: entry.url,
    headers: { Authorization: token },
    enabled: true,
  };
}

/** Copy-pasteable snippet for the refusal paths (the user is never stranded).
 * SECURITY: an inline bearer is substituted with a literal placeholder — the
 * snippet rides thrown error messages (parse refusal, foreign refusal), and an
 * error path must never embed the real secret in text that lands in logs,
 * receipts, or stderr. Only the human-facing snippet changes; the write path
 * still renders the real token. */
export function opencodeEntrySnippet(entry: OpencodeMcpEntry): string {
  const safe: OpencodeMcpEntry =
    entry.kind === 'remote' && entry.tokenMode === 'inline'
      ? { ...entry, bearerToken: '<paste-token-here>' }
      : entry;
  return JSON.stringify({ mcp: { [safe.name]: entryValue(safe) } }, null, 2);
}

function assertEntryName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(
      `MCP server name "${name}" is not a simple key ([A-Za-z0-9_-]+) — pick a simpler --name`,
    );
  }
}

function entryCarriesSecret(entry: OpencodeMcpEntry): boolean {
  return entry.kind === 'remote' && entry.tokenMode === 'inline';
}

/** True when config text carries an INLINE bearer credential (any
 * `Bearer <value>` that is not the `{env:…}` interpolation) — the rule that
 * decides whether a backup copy must be tightened to 0600. */
export function textCarriesInlineBearer(text: string): boolean {
  return /Bearer\s+(?!\{env:)\S/.test(text);
}

/** Unique-suffix backup (`<config>.bak-<hex>`): two overlapping runs can
 * never clobber each other's snapshot. The config-dir lock covers the WRITE,
 * but a backup must survive until the caller's post-write verification (the
 * harness network smoke) — which runs AFTER the lock is released, so a fixed
 * `.bak` name would let run B's writer overwrite run A's snapshot and a
 * failed run A would then restore (and revoke against) run B's state.
 * chmod 0600 whenever the copied content carries an inline bearer
 * (copyFileSync onto a fresh path takes the source mode, but a hand-loosened
 * source must not propagate a loose mode to a token-bearing backup). */
function createUniqueBackup(configPath: string, priorText: string): string {
  const backupPath = `${configPath}.bak-${randomBytes(6).toString('hex')}`;
  copyFileSync(configPath, backupPath);
  if (textCarriesInlineBearer(priorText)) chmodSync(backupPath, 0o600);
  return backupPath;
}

// No explicit eol: jsonc-parser detects and preserves the file's own EOLs
// (verified: a CRLF config keeps CRLF through modify/applyEdits).
const FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

// ── Write ───────────────────────────────────────────────────────────────────

/**
 * Idempotently write the managed `mcp.<name>` entry via a comment-preserving
 * surgical edit. Refuses foreign entries; replaces ours-same-source silently;
 * replaces ours-other-source only when `allowReplaceOtherSource` (callers
 * warn first). Validates the render before the atomic swap.
 */
export function writeOpencodeMcpEntry(
  configPath: string,
  entry: OpencodeMcpEntry,
  opts: { expect?: OpencodeEntryExpectation; allowReplaceOtherSource?: boolean } = {},
): WriteOpencodeEntryResult {
  assertEntryName(entry.name);
  if (entry.kind === 'remote' && entry.tokenMode === 'inline' && !entry.bearerToken) {
    throw new Error('inline token mode requires a bearerToken');
  }
  const notes: string[] = [];
  const snippet = opencodeEntrySnippet(entry);

  const { text, existed } = readConfigRaw(configPath);
  const parsed = parseOpencodeConfig(text, configPath, snippet);

  const priorKind = opencodeEntryKind(parsed, entry.name, opts.expect);
  if (priorKind === 'foreign') {
    throw new Error(
      `mcp.${entry.name} in ${configPath} is not a gbrain-managed entry — refusing to overwrite it. ` +
        `Remove it (or pick another --name) and re-run.`,
    );
  }
  if (priorKind === 'ours-other-source' && !opts.allowReplaceOtherSource) {
    // Caller-appropriate refusal text: on the REMOTE path (expect.url — the
    // harness/connect lanes) no GBRAIN_SOURCE is involved, and connect's
    // documented escape hatch is --force; the GBRAIN_SOURCE wording belongs
    // to the local/workspace lane only.
    throw new Error(
      opts.expect?.url !== undefined
        ? `mcp.${entry.name} in ${configPath} is a gbrain registration that does not match this endpoint ` +
            `(${opts.expect.url}) — another install or lane owns it; pass --force to replace it, or pick another --name.`
        : `mcp.${entry.name} in ${configPath} belongs to a DIFFERENT gbrain workspace ` +
            `(GBRAIN_SOURCE mismatch) — re-run with the overwrite confirmation to reroute it, or pick another --name.`,
    );
  }
  if (priorKind === 'ours-other-source') {
    notes.push(
      opts.expect?.url !== undefined
        ? `replaced a gbrain registration that did not match this endpoint (url/lane mismatch).`
        : `replaced a gbrain registration that pointed at a different workspace (source mismatch).`,
    );
  }

  const baseText = text.trim() === '' ? '{\n  "$schema": "https://opencode.ai/config.json"\n}\n' : text;
  const edits = modify(baseText, ['mcp', entry.name], entryValue(entry), FORMATTING);
  const nextText = applyEdits(baseText, edits);

  // Post-render validation: parse + deep-assert our entry + assert every
  // OTHER top-level key survives. Any failure leaves the original untouched.
  const rendered = parseOpencodeConfig(nextText, configPath, snippet);
  const renderedMcp = rendered.mcp as Record<string, unknown> | undefined;
  const ours = renderedMcp?.[entry.name];
  if (JSON.stringify(ours) !== JSON.stringify(entryValue(entry))) {
    throw new Error(
      `post-render validation failed: mcp.${entry.name} did not round-trip — original file left untouched.`,
    );
  }
  for (const key of Object.keys(parsed)) {
    if (key === 'mcp') continue;
    if (JSON.stringify(rendered[key]) !== JSON.stringify(parsed[key])) {
      throw new Error(
        `post-render validation failed: top-level key "${key}" changed — original file left untouched.`,
      );
    }
  }
  if (typeof parsed.mcp === 'object' && parsed.mcp !== null) {
    for (const key of Object.keys(parsed.mcp as Record<string, unknown>)) {
      if (key === entry.name) continue;
      const before = (parsed.mcp as Record<string, unknown>)[key];
      const after = renderedMcp?.[key];
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error(
          `post-render validation failed: mcp.${key} (not ours) changed — original file left untouched.`,
        );
      }
    }
  }

  const secret = entryCarriesSecret(entry);
  let backupPath: string | null = null;
  if (existed) {
    backupPath = createUniqueBackup(configPath, text);
    if (secret) chmodSync(backupPath, 0o600); // re-runs: the backup carries the previous token
  }
  atomicWriteTextFile(configPath, nextText, secret ? { forceMode: 0o600 } : { freshMode: 0o644 });
  if (secret && existed) {
    notes.push(`${configPath} tightened to 0600 — it now carries a bearer token.`);
  }

  return {
    configPath,
    replacedPrior: priorKind !== 'absent',
    priorKind,
    backupPath,
    writtenText: nextText,
    notes,
  };
}

// ── Remove ──────────────────────────────────────────────────────────────────

/**
 * Remove the managed entry (fingerprint-keyed; everything else survives
 * byte-for-byte). Absent file / absent entry are calm no-ops. Foreign
 * entries refuse — removal never deletes what gbrain does not own.
 * `skipOtherSource` turns an `ours-other-source` match into a calm skip-with-
 * note instead of a removal (the uninstall sweep passes it: a gbrain entry
 * from a DIFFERENT workspace is not this uninstall's to delete).
 */
export function removeOpencodeMcpEntry(
  configPath: string,
  name: string,
  expect: OpencodeEntryExpectation = {},
  opts: { skipOtherSource?: boolean } = {},
): RemoveOpencodeEntryResult {
  assertEntryName(name);
  const notes: string[] = [];
  if (!existsSync(configPath)) {
    return { configPath, removed: false, backupPath: null, notes: ['no opencode config — nothing to remove'] };
  }
  const { text } = readConfigRaw(configPath);
  const parsed = parseOpencodeConfig(text, configPath);

  const kind = opencodeEntryKind(parsed, name, expect);
  if (kind === 'absent') {
    return { configPath, removed: false, backupPath: null, notes: ['no gbrain-managed entry — nothing to remove'] };
  }
  if (kind === 'foreign') {
    throw new Error(
      `mcp.${name} in ${configPath} is not a gbrain-managed entry — refusing to remove it.`,
    );
  }
  if (kind === 'ours-other-source' && opts.skipOtherSource) {
    return {
      configPath,
      removed: false,
      backupPath: null,
      notes: [
        `mcp.${name} in ${configPath} belongs to a DIFFERENT gbrain workspace (source mismatch) — left in place.`,
      ],
    };
  }
  if (kind === 'ours-other-source') {
    notes.push('removed a gbrain registration that pointed at a different workspace (source mismatch).');
  }

  const edits = modify(text, ['mcp', name], undefined, FORMATTING);
  const nextText = applyEdits(text, edits);
  parseOpencodeConfig(nextText, configPath); // never leave opencode unreadable

  // Unique backup, 0600 when the copied content carries an inline bearer —
  // the removed entry may BE the token-bearing one, and a fixed-name copy
  // onto a pre-existing loose-mode backup would keep the loose mode.
  const backupPath = createUniqueBackup(configPath, text);
  atomicWriteTextFile(configPath, nextText);
  return { configPath, removed: true, backupPath, notes };
}

// ── Sibling-global reconcile (the two-filename merge blind spot) ────────────

/**
 * opencode merges the user-global `opencode.json` AND `opencode.jsonc` when
 * both exist. Before writing `mcp.<name>` into one of them, reconcile the
 * SIBLING file: an ours-classified entry there is removed (one owner per
 * name — left in place it survives as a shadow registration whose merge
 * winner is ambiguous, and a later removal of the primary "reveals" it); a
 * FOREIGN entry refuses loudly naming BOTH files (same refusal posture as
 * the primary-file foreign case — the merge winner is not ours to fight
 * over). No-op when the path is not a global-pair member or the sibling is
 * absent/entry-less. Callers hold the opencode config-dir bootstrap lock
 * (both files share the dir — one lock covers both) and call this ONLY for
 * user-global writes (project-scope sibling semantics are unobserved).
 */
export function reconcileOpencodeSiblingGlobal(
  configPath: string,
  name: string,
  expect: OpencodeEntryExpectation = {},
): { siblingPath: string | null; removed: boolean; notes: string[] } {
  const siblingPath = opencodeGlobalSiblingPath(configPath);
  if (!siblingPath || !existsSync(siblingPath)) return { siblingPath, removed: false, notes: [] };
  const { text } = readConfigRaw(siblingPath);
  const parsed = parseOpencodeConfig(text, siblingPath);
  const kind = opencodeEntryKind(parsed, name, expect);
  if (kind === 'absent') return { siblingPath, removed: false, notes: [] };
  if (kind === 'foreign') {
    throw new Error(
      `mcp.${name} in ${siblingPath} is not a gbrain-managed entry — opencode merges ${siblingPath} AND ` +
        `${configPath} when both exist, so writing mcp.${name} into ${configPath} would fight it with an ` +
        `ambiguous merge winner. Remove it (or pick another --name) and re-run.`,
    );
  }
  const r = removeOpencodeMcpEntry(siblingPath, name, expect);
  const notes = [
    `removed the gbrain mcp.${name} entry from ${siblingPath} — opencode merges both global filenames, and the ` +
      `registration being written lands in ${configPath} (one owner per name).`,
    ...r.notes,
  ];
  return { siblingPath, removed: r.removed, notes };
}

/**
 * True when `mcp.<name>` exists as a REMOTE-type entry (regardless of
 * ownership). The workspace stdio lane consults this before writing a local
 * entry into the user-global config: a remote entry under our name is either
 * the harness lane's (bootstrap harness) or foreign — either way the stdio
 * lane must not fight it (the codexBlockOwnsName analog, #4043 ownership
 * rule). Best-effort: unreadable/unparseable configs return false (the write
 * path re-checks with full refusal semantics).
 */
export function opencodeRemoteEntryExists(configPath: string, name: string): boolean {
  try {
    const { text, existed } = readConfigRaw(configPath);
    if (!existed) return false;
    const parsed = parseOpencodeConfig(text, configPath);
    const mcp = parsed.mcp;
    if (typeof mcp !== 'object' || mcp === null) return false;
    const entry = (mcp as Record<string, unknown>)[name];
    return typeof entry === 'object' && entry !== null && (entry as Record<string, unknown>).type === 'remote';
  } catch {
    return false;
  }
}

// ── Status/recovery helpers ─────────────────────────────────────────────────

/**
 * Recover the inline bearer from OUR remote entry (harness `--status` token
 * liveness — the receipt never stores the token). Returns null when the file
 * or entry is absent, foreign, env-mode, or unreadable as JSONC.
 */
export function parseOpencodeEntryBearer(configPath: string, name: string, expectUrl?: string): string | null {
  try {
    const { text, existed } = readConfigRaw(configPath);
    if (!existed) return null;
    const parsed = parseOpencodeConfig(text, configPath);
    const kind = opencodeEntryKind(parsed, name, { url: expectUrl });
    if (kind !== 'ours-same-source') return null;
    const entry = (parsed.mcp as Record<string, unknown>)[name] as Record<string, unknown>;
    if (entry.type !== 'remote') return null;
    const auth = (entry.headers as Record<string, unknown> | undefined)?.Authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
    const token = auth.slice('Bearer '.length);
    if (token.includes('{env:')) return null; // env-interpolated — no inline token to recover
    return token || null;
  } catch {
    return null;
  }
}
