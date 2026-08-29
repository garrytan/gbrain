/**
 * sensitivity-scan.ts — composed detector for compiled-context entries
 * (cathedral-5, plan D4').
 *
 * DETECTOR, NOT REDACTOR: any content hit means the caller drops the whole
 * page entry (compile-view.ts) and reports the finding. Findings NEVER
 * contain the matched text — family + fingerprint only (the caller adds the
 * slug).
 *
 * Composition, IN ORDER:
 *   (a) secret-scan `scanText` (named key prefixes, whole-block PEM) with
 *       the `.gbrain-scan-allow` fingerprint allowlist EXPLICITLY loaded —
 *       `scanText` defaults to an EMPTY allowlist [CX2-15], so the escape
 *       hatch only works if we load and pass it here;
 *   (b) `findPii` over the ordered PII_PATTERNS array
 *       (eval-capture-scrub.ts — email/phone/SSN/JWT/Bearer/Luhn-gated CC);
 *   (c) the hardcoded private path-shape family + the operator word
 *       blocklist, ported from scripts/check-no-pii-in-agent-voice.sh
 *       (the MECHANISM — pipe-separated case-insensitive word-boundary
 *       alternation — not that script's loosened POSIX-ERE shape regexes);
 *   (d) the operator pattern file via `loadImportRedactionPatterns`
 *       (transcripts/render.ts — user file + shipped defaults).
 *
 * UNIFORM ESCAPE HATCH: every family's findings carry a
 * `sha256:<hex16>` fingerprint of the matched value, honored by the same
 * `<workspaceRoot>/.gbrain-scan-allow` file secret-scan uses (one
 * glob-or-fingerprint per line). An operator can un-drop any false
 * positive, not just secrets.
 *
 * FAILURE TAXONOMY:
 *   - CONTENT hit  → finding in the returned array (caller drops the entry).
 *   - CONFIG/loader failure (malformed operator regex, malformed blocklist,
 *     unreadable-but-present allowlist file, scanner module error during
 *     load) → `SensitivityScanConfigError` THROWN from
 *     `loadSensitivityConfig` — the caller aborts the whole run without
 *     writing. "Drop on config error" could overwrite a good compiled file
 *     with header-only output; aborting cannot.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { findPii } from '../eval-capture-scrub.ts';
import {
  SCAN_ALLOW_FILENAME,
  scanText,
  valueAllowlisted,
} from '../secret-scan.ts';
import type { ImportRedactionPattern } from '../transcripts/render.ts';
import { loadImportRedactionPatterns } from '../transcripts/render.ts';

// ── Types ───────────────────────────────────────────────────────────────────

export interface SensitivityFinding {
  /**
   * Which detector fired: `secret:<pattern>` (secret-scan name),
   * `pii:<family>` (PII_PATTERNS family), `path`, `blocklist`, or
   * `pattern-file`. Stable vocabulary — consumed by compile meta + stderr.
   */
  family: string;
  /**
   * `sha256:<first-16-hex>` of the matched value — the allowlist key.
   * NEVER the matched text.
   */
  fingerprint: string;
}

export class SensitivityScanConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SensitivityScanConfigError';
  }
}

export interface SensitivityConfigOpts {
  /**
   * Workspace root holding `.gbrain-scan-allow`. Absent file → empty
   * allowlist (valid state); PRESENT but unreadable → config error.
   */
  workspaceRoot?: string;
  /**
   * Operator word blocklist, pipe-separated (`name-a|name-b`). Defaults to
   * the AGENT_VOICE_PII_BLOCKLIST env var — the same contract as the
   * agent-voice CI guard. Empty/unset → family disabled.
   */
  blocklist?: string;
  /** Operator pattern file path (defaults to ~/.gbrain/harvest-private-patterns.txt). */
  userPatternsPath?: string;
}

/** Loaded-and-validated scan configuration. Loading throws; scanning never does. */
export interface SensitivityScanConfig {
  allowlist: string[];
  blocklistRe: RegExp | null;
  patterns: ImportRedactionPattern[];
}

// ── Path-shape family (ported from check-no-pii-in-agent-voice.sh) ──────────

/** Hardcoded private filesystem prefixes. Extend as new deployment shapes emerge. */
const PATH_SHAPE_RES: readonly RegExp[] = [
  /\/data\/\.openclaw\//g,
  /\/private\/[a-z0-9_-]+\/workspace\//g,
];

// ── Config loading (throws typed errors — the abort lane) ───────────────────

/** Strict allowlist load: absent → []; present-but-unreadable → THROW. */
function loadAllowlistStrict(workspaceRoot?: string): string[] {
  if (!workspaceRoot) return [];
  // workspaceRoot is the operator's own workspace root (trusted local CLI
  // plane; compile-context is refused on thin clients) joined with a literal.
  // nosemgrep: javascript.lang.security.audit.path-traversal.path-join-resolve-traversal.path-join-resolve-traversal
  const p = join(workspaceRoot, SCAN_ALLOW_FILENAME);
  if (!existsSync(p)) return [];
  let raw: string;
  try {
    raw = readFileSync(p, 'utf-8');
  } catch (err) {
    throw new SensitivityScanConfigError(
      `Cannot read allowlist ${p}: ${(err as Error).message}`,
      { cause: err },
    );
  }
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** Compile the operator blocklist (pipe-separated words → \b-anchored alternation). */
function compileBlocklist(blocklist: string | undefined): RegExp | null {
  const src = (blocklist ?? '').trim();
  if (!src) return null;
  try {
    // Operator-authored config on the trusted local plane (same posture as
    // the operator pattern file): a malformed pattern throws a typed CONFIG
    // error below and the whole compile run ABORTS without writing — the
    // documented fail-closed lane. Never fed remote/untrusted input.
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    return new RegExp(`\\b(?:${src})\\b`, 'gi');
  } catch (err) {
    throw new SensitivityScanConfigError(
      `Malformed operator blocklist: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

/**
 * Load + validate everything the scan needs. EVERY loader failure surfaces
 * here as SensitivityScanConfigError so callers get one abort seam before
 * any content is scanned or any file is written.
 */
export function loadSensitivityConfig(
  opts: SensitivityConfigOpts = {},
): SensitivityScanConfig {
  const allowlist = loadAllowlistStrict(opts.workspaceRoot);
  const blocklistRe = compileBlocklist(opts.blocklist ?? process.env.AGENT_VOICE_PII_BLOCKLIST);
  let patterns: ImportRedactionPattern[];
  try {
    // Malformed regex in the operator pattern file throws at load time
    // (harvest-lint.ts PrivacyLintConfigError) — rewrapped into this
    // module's single typed error.
    patterns = loadImportRedactionPatterns(opts.userPatternsPath);
  } catch (err) {
    throw new SensitivityScanConfigError(
      `Operator pattern file failed to load: ${(err as Error).message}`,
      { cause: err },
    );
  }
  return { allowlist, blocklistRe, patterns };
}

// ── Scanning (pure; content hits only) ──────────────────────────────────────

function fingerprintValue(value: string): { fingerprint: string; fullHex: string } {
  const fullHex = createHash('sha256').update(value).digest('hex');
  return { fingerprint: `sha256:${fullHex.slice(0, 16)}`, fullHex };
}

/** Push a finding unless its value is fingerprint-allowlisted. */
function pushUnlessAllowed(
  out: SensitivityFinding[],
  family: string,
  value: string,
  allowlist: string[],
): void {
  const { fingerprint, fullHex } = fingerprintValue(value);
  if (valueAllowlisted(fullHex, allowlist)) return;
  out.push({ family, fingerprint });
}

/** Scan `text` with one global regex, reporting each match under `family`. */
function scanRegexFamily(
  out: SensitivityFinding[],
  text: string,
  re: RegExp,
  family: string,
  allowlist: string[],
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++; // zero-width safety
      continue;
    }
    pushUnlessAllowed(out, family, m[0], allowlist);
  }
}

/**
 * Scan one rendered entry. Returns ALL findings in deterministic family
 * order (secret → pii → path → blocklist → pattern-file); the caller drops
 * the entry on any finding and typically reports the first. Pure — config
 * problems were already surfaced by `loadSensitivityConfig`.
 */
export function scanSensitive(
  text: string,
  config: SensitivityScanConfig,
): SensitivityFinding[] {
  if (!text) return [];
  const out: SensitivityFinding[] = [];

  // (a) Secrets — scanText applies the fingerprint allowlist itself.
  for (const f of scanText(text, { allowlist: config.allowlist })) {
    out.push({ family: `secret:${f.pattern}`, fingerprint: f.fingerprint });
  }

  // (b) PII — detection over the ordered PII_PATTERNS families.
  for (const f of findPii(text)) {
    pushUnlessAllowed(out, `pii:${f.family}`, text.slice(f.start, f.end), config.allowlist);
  }

  // (c1) Private path shapes.
  for (const re of PATH_SHAPE_RES) {
    scanRegexFamily(out, text, re, 'path', config.allowlist);
  }

  // (c2) Operator word blocklist.
  if (config.blocklistRe) {
    scanRegexFamily(out, text, config.blocklistRe, 'blocklist', config.allowlist);
  }

  // (d) Operator pattern file (user patterns + shipped defaults).
  for (const { regex } of config.patterns) {
    scanRegexFamily(out, text, regex, 'pattern-file', config.allowlist);
  }

  return out;
}
