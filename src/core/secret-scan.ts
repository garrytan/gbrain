/**
 * secret-scan.ts — pattern-based secret detection for USER workspaces
 * (agent-bootstrap plan: ENG-9 as amended by CX2-15, S3#2, D6).
 *
 * Consumers: `gbrain sources push` (block-before-commit gate), bootstrap
 * verify, and the transcript-corpus writer (redact-in-place via
 * `redactFindings`).
 *
 * TWO SCAN POLICIES EXIST DELIBERATELY [CX2-15]: `.gitleaks.toml` is CI
 * fixture policy for THIS public repo (test/, skills/ are allowlisted there
 * because they hold synthetic fixtures). Importing that allowlist here would
 * blind the runtime scanner to real secrets under a user's personal-repo
 * `skills/` tree. This module therefore ships an EMPTY default allowlist
 * plus a per-workspace override file (`<ws>/.gbrain-scan-allow`, one
 * glob-or-fingerprint per line, `#` comments).
 *
 * Rendering reuses `redactSecretsInText` [ENG-9] so every surface prints
 * `<REDACTED:pattern>` — a finding preview or redacted corpus NEVER contains
 * the secret value, and this module never returns raw matched values.
 *
 * The generic high-entropy assignment heuristic is OFF by default (opt-in
 * via `ScanOpts.highEntropy`) — named-prefix patterns are precise; the
 * entropy heuristic trades false positives for recall and is a caller
 * decision, not a default.
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { isAbsolute, join, relative, sep } from 'path';
import { createHash } from 'crypto';
import { redactSecretsInText } from './minions/handlers/shell-redact.ts';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SecretFinding {
  /** Pattern name, e.g. 'openai', 'github_token', 'private_key_pem'. */
  pattern: string;
  /** 1-based line number within the scanned text/file. */
  line: number;
  /** Line excerpt with the secret replaced by `<REDACTED:pattern>` — NEVER the value. */
  redactedPreview: string;
  /**
   * `sha256:<first-16-hex>` of the matched value. The allowlist key: paste
   * this line into `<ws>/.gbrain-scan-allow` to accept a specific finding.
   */
  fingerprint: string;
  /** Set by scanFiles: the path the finding came from (as given by the caller). */
  file?: string;
}

export interface ScanOpts {
  /**
   * Allowlist entries (globs or `sha256:<hex-prefix>` fingerprints). Default
   * EMPTY [CX2-15] — callers merge in `loadWorkspaceAllowlist(root)`.
   */
  allowlist?: string[];
  /** Workspace root: allowlist path-globs match paths relative to this. */
  workspaceRoot?: string;
  /** Opt-in generic high-entropy assignment heuristic. Default false. */
  highEntropy?: boolean;
}

/** Name of the per-workspace allowlist override file. */
export const SCAN_ALLOW_FILENAME = '.gbrain-scan-allow';

// ── Patterns ────────────────────────────────────────────────────────────────
//
// Each core pattern is compiled with a left boundary group `(^|[^A-Za-z0-9_])`
// so prefixes embedded inside longer identifiers ("risk-assessment…",
// "task-…") never fire. Order matters: 'anthropic' precedes 'openai' and the
// per-line claimed-span set prevents a `sk-ant-…` key from double-reporting
// as a generic `sk-` match.

interface CompiledPattern {
  name: string;
  re: RegExp; // 'g' flags; group 1 = boundary, group 2 = the secret value
  /** When true, a match must also pass the Shannon-entropy gate. */
  entropyGated?: boolean;
}

const CORE_PATTERNS: ReadonlyArray<{ name: string; source: string }> = [
  { name: 'anthropic', source: 'sk-ant-[A-Za-z0-9_-]{16,}' },
  // Prefixed OpenAI forms (sk-proj-/sk-svcacct-/sk-None-) allow `_`/`-` in the
  // body, which the bare sk- pattern below deliberately does not. Ordered
  // before it so the claimed-span dedupe attributes the whole key here.
  { name: 'openai', source: 'sk-(?:proj|svcacct|None)-[A-Za-z0-9_-]{20,}' },
  { name: 'openai', source: 'sk-[A-Za-z0-9]{20,}' },
  // Voyage key shape mirrors PROVIDER_KEY_SHAPES in bootstrap/interview.ts.
  { name: 'voyage', source: 'pa-[A-Za-z0-9_-]{20,}' },
  { name: 'github_pat', source: 'github_pat_[A-Za-z0-9_]{22,}' },
  { name: 'github_token', source: 'gh[pousr]_[A-Za-z0-9]{36,}' },
  { name: 'slack', source: 'xox[baprs]-[A-Za-z0-9-]{10,}' },
  { name: 'aws_access_key', source: 'AKIA[0-9A-Z]{16}' },
  // NOTE: private_key_pem is NOT here — a PEM key spans multiple lines and the
  // per-line scanner below cannot see the base64 body. It is matched over the
  // WHOLE text by PEM_BLOCK_RE (see scanPemBlocks) so redaction covers the
  // body+footer, not just the header line.
];

/**
 * Whole-block PEM private key: header + (optional) base64 body + (optional)
 * footer, matched multiline. The header-only pattern used to leave the base64
 * body in the redacted corpus (the redaction replaced only the header line);
 * matching the whole span means the key body is scrubbed. The body+footer are
 * OPTIONAL so a lone/truncated header (a body-only leak, or a header with no
 * END) still fires the push-block gate — value is then just the header. The
 * lazy `[\s\S]*?` stops at the first END marker so two adjacent keys don't
 * collapse into one span. `-----BEGIN CERTIFICATE-----` never matches (the
 * literal `PRIVATE KEY` is required).
 */
export const PEM_BLOCK_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/g;

// Opt-in: `secret|token|password|api key`-shaped assignment whose value has
// high Shannon entropy. Keyword-anchored (compiled inline below so the group
// layout matches the core patterns: group 1 = anchor, group 2 = value).
const HIGH_ENTROPY_MIN_BITS_PER_CHAR = 3.5;

function compilePatterns(opts: ScanOpts): CompiledPattern[] {
  const out: CompiledPattern[] = CORE_PATTERNS.map((p) => ({
    name: p.name,
    re: new RegExp(`(^|[^A-Za-z0-9_])(${p.source})`, 'g'),
  }));
  if (opts.highEntropy) {
    // Group layout matches the core shape: group 1 = boundary (empty here,
    // the keyword anchor plays that role), group 2 = value. We wrap the
    // keyword part into group 1 so span math stays uniform.
    out.push({
      name: 'high_entropy_assignment',
      re: new RegExp(
        `((?:^|[^A-Za-z0-9_])(?:secret|token|passwd|password|api[_-]?key|apikey)["']?\\s*[:=]\\s*["']?)([A-Za-z0-9+/_=-]{20,})`,
        'gi',
      ),
      entropyGated: true,
    });
  }
  return out;
}

/** Shannon entropy in bits/char. Exported for tests. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

// ── Allowlist ───────────────────────────────────────────────────────────────

/**
 * Load `<workspaceRoot>/.gbrain-scan-allow`: one glob-or-fingerprint per
 * line, `#` comments and blank lines ignored. Absent/unreadable file → []
 * (the shipped default allowlist is EMPTY [CX2-15]).
 */
export function loadWorkspaceAllowlist(workspaceRoot: string): string[] {
  try {
    const p = join(workspaceRoot, SCAN_ALLOW_FILENAME);
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Minimal anchored glob → RegExp. `**` crosses `/`, `*` stays within a path
 * segment, `?` is one non-slash char. Shared by the scan allowlist and the
 * workspace-push deny-glob backstop (one glob dialect everywhere).
 */
const GLOB_REGEX_CACHE = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = GLOB_REGEX_CACHE.get(glob);
  if (cached) return cached;
  let g = glob;
  if (g.endsWith('/')) g += '**'; // `foo/` means everything under foo/
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          re += '(?:.*/)?';
          i++;
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  const compiled = new RegExp(`^${re}$`);
  GLOB_REGEX_CACHE.set(glob, compiled);
  return compiled;
}

/**
 * Gitignore-flavored match: a glob WITHOUT `/` matches the basename at any
 * depth (`*.pem` catches `sub/dir/key.pem`); a glob WITH `/` is anchored at
 * the workspace root (`.gbrain/**`). Paths are normalized to `/` separators.
 */
export function matchesGlob(glob: string, relPath: string): boolean {
  const norm = relPath.split(sep).join('/');
  if (!glob.includes('/')) {
    const base = norm.slice(norm.lastIndexOf('/') + 1);
    return globToRegExp(glob).test(base);
  }
  return globToRegExp(glob).test(norm);
}

function isFingerprintEntry(entry: string): boolean {
  return entry.startsWith('sha256:');
}

/**
 * Minimum fingerprint-prefix length (hex chars) an allowlist entry must carry
 * to suppress a finding. 16 hex = 64 bits: an 8-hex (32-bit) floor was low
 * enough that a short allowlist entry could collide with an UNRELATED secret's
 * hash and silently un-report it. The emitted fingerprint is exactly 16 hex,
 * so a copy-pasted fingerprint still matches at the floor.
 */
export const ALLOWLIST_FINGERPRINT_MIN_HEX = 16;

/** True when the full sha256 hex of a matched value is allowlisted (≥16-hex prefix). */
function valueAllowlisted(fullHex: string, allowlist: string[]): boolean {
  for (const entry of allowlist) {
    if (!isFingerprintEntry(entry)) continue;
    const prefix = entry.slice('sha256:'.length).toLowerCase();
    if (prefix.length >= ALLOWLIST_FINGERPRINT_MIN_HEX && fullHex.startsWith(prefix)) return true;
  }
  return false;
}

/** True when a file path is allowlisted by any glob entry. */
export function pathAllowlisted(relPath: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => !isFingerprintEntry(entry) && matchesGlob(entry, relPath));
}

// ── Scanning ────────────────────────────────────────────────────────────────

interface RawHit {
  pattern: string;
  line: number; // 1-based
  value: string;
  lineText: string;
}

/**
 * Whole-text PEM private-key pass. Runs over the FULL text (not per-line) so
 * the base64 body between header and footer is part of the matched value and
 * therefore gets redacted, never left behind. `lineText` is set to the whole
 * matched block so buildPreview / redactSecretsInText replace the entire span
 * with `<REDACTED:private_key_pem>`.
 */
function scanPemBlocks(text: string): RawHit[] {
  const hits: RawHit[] = [];
  PEM_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PEM_BLOCK_RE.exec(text)) !== null) {
    const value = m[0];
    if (value.length === 0) {
      PEM_BLOCK_RE.lastIndex++; // zero-width safety
      continue;
    }
    // 1-based line of the header start.
    const line = text.slice(0, m.index).split('\n').length;
    hits.push({ pattern: 'private_key_pem', line, value, lineText: value });
  }
  return hits;
}

function scanInternal(text: string, opts: ScanOpts): RawHit[] {
  const patterns = compilePatterns(opts);
  // PEM blocks first: their full-span value must be redacted before any
  // per-line replacement can touch the region (base64 bodies never match the
  // named patterns, so order is a belt-and-suspenders guarantee).
  const hits: RawHit[] = scanPemBlocks(text);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.length < 8) continue;
    const claimed: Array<[number, number]> = [];
    for (const p of patterns) {
      p.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = p.re.exec(line)) !== null) {
        const value = m[2];
        const start = m.index + m[1].length;
        const end = start + value.length;
        // Zero-width safety: never loop forever on a pathological pattern.
        if (m[0].length === 0) p.re.lastIndex++;
        if (claimed.some(([s, e]) => start < e && end > s)) continue;
        if (p.entropyGated && shannonEntropy(value) < HIGH_ENTROPY_MIN_BITS_PER_CHAR) continue;
        claimed.push([start, end]);
        hits.push({ pattern: p.name, line: i + 1, value, lineText: line });
      }
    }
  }
  return hits;
}

const PREVIEW_MAX_CHARS = 160;

function buildPreview(lineText: string, value: string, patternName: string): string {
  // ENG-9: render through redactSecretsInText for the canonical
  // `<REDACTED:name>` token — the value never survives into the preview.
  const redacted = redactSecretsInText(lineText, new Map([[patternName, value]])).trim();
  if (redacted.length <= PREVIEW_MAX_CHARS) return redacted;
  const at = redacted.indexOf(`<REDACTED:${patternName}>`);
  const start = Math.max(0, at - 40);
  return (start > 0 ? '…' : '') + redacted.slice(start, start + PREVIEW_MAX_CHARS) + '…';
}

function toFinding(hit: RawHit, file?: string): SecretFinding {
  const fullHex = createHash('sha256').update(hit.value).digest('hex');
  return {
    pattern: hit.pattern,
    line: hit.line,
    redactedPreview: buildPreview(hit.lineText, hit.value, hit.pattern),
    fingerprint: `sha256:${fullHex.slice(0, 16)}`,
    ...(file !== undefined ? { file } : {}),
  };
}

/**
 * Scan a text blob. Returns findings with redacted previews — never raw
 * values. Fingerprint-allowlisted values are dropped; path-glob allowlist
 * entries only apply in `scanFiles` (they need a file path).
 */
export function scanText(text: string, opts: ScanOpts = {}): SecretFinding[] {
  const allowlist = opts.allowlist ?? [];
  const out: SecretFinding[] = [];
  for (const hit of scanInternal(text, opts)) {
    const fullHex = createHash('sha256').update(hit.value).digest('hex');
    if (valueAllowlisted(fullHex, allowlist)) continue;
    out.push(toFinding(hit));
  }
  return out;
}

/** Bytes to sniff for NUL when deciding content is binary. */
export const BINARY_SNIFF_BYTES = 8192;

/** scanFiles skips anything larger (the push gate applies the same cap). */
export const SCAN_MAX_FILE_BYTES = 25 * 1024 * 1024;

/** True when the first BINARY_SNIFF_BYTES of the buffer contain a NUL byte. */
export function looksBinaryBuffer(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function looksBinary(path: string): boolean {
  try {
    // small files dominate; callers size-cap first
    return looksBinaryBuffer(readFileSync(path));
  } catch {
    return true; // unreadable → skip like a binary
  }
}

/**
 * Scan files on disk. Unreadable and binary (NUL-sniffed) files are skipped.
 * When `opts.workspaceRoot` is set, allowlist path-globs are matched against
 * each file's path relative to that root; fingerprint entries apply as in
 * `scanText`. `finding.file` carries the path exactly as the caller gave it.
 */
export function scanFiles(paths: string[], opts: ScanOpts = {}): SecretFinding[] {
  const allowlist = opts.allowlist ?? [];
  const out: SecretFinding[] = [];
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      const st = statSync(p);
      if (!st.isFile() || st.size > SCAN_MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }
    const rel =
      opts.workspaceRoot && isAbsolute(p) ? relative(opts.workspaceRoot, p) : p;
    if (pathAllowlisted(rel, allowlist)) continue;
    if (looksBinary(p)) continue;
    let text: string;
    try {
      text = readFileSync(p, 'utf-8');
    } catch {
      continue;
    }
    for (const f of scanText(text, opts)) {
      out.push({ ...f, file: p });
    }
  }
  return out;
}

/**
 * Corpus-write mode [S3#2]: replace every matched span in place with
 * `<REDACTED:pattern>` (via redactSecretsInText) and report what was
 * redacted. Allowlisted values are left intact — the user declared them
 * safe. Returns the redacted text plus one finding per original occurrence.
 */
export function redactFindings(
  text: string,
  opts: ScanOpts = {},
): { text: string; redactions: SecretFinding[] } {
  const allowlist = opts.allowlist ?? [];
  const redactions: SecretFinding[] = [];
  const seen = new Set<string>(); // pattern\0value pairs already replaced
  let out = text;
  for (const hit of scanInternal(text, opts)) {
    const fullHex = createHash('sha256').update(hit.value).digest('hex');
    if (valueAllowlisted(fullHex, allowlist)) continue;
    redactions.push(toFinding(hit));
    const key = `${hit.pattern}\0${hit.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out = redactSecretsInText(out, new Map([[hit.pattern, hit.value]]));
  }
  return { text: out, redactions };
}
