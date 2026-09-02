/**
 * instructions-block.ts — the ambient-writeback managed instruction block
 * (WP3 of the ambient-writeback plan; targets `kind: 'instructions'` in the
 * harness receipt).
 *
 * `gbrain bootstrap harness` splices ONE marker-delimited block into the
 * user-global instruction files the harnesses actually load (Claude Code
 * `~/.claude/CLAUDE.md`, codex `$CODEX_HOME/AGENTS.md` — paths owned by
 * host-specs.ts) so harnesses that never surface the MCP `instructions`
 * field still receive the ambient memory-writeback contract. The section
 * BODY comes from the one shared builder
 * (src/core/facts/writeback-instructions.ts) so this surface structurally
 * cannot drift from the MCP instructions surface.
 *
 * Splice discipline copied VERBATIM from spliceCompiledBlock
 * (src/commands/compile-context.ts): exact-line marker match at column 0; no
 * markers → append a fresh block at EOF; exactly one in-order pair → replace
 * the interior; anything else (duplicates, an orphan, out of order) → THROW —
 * those are hand-edits we must not guess through. Marker-equal lines inside
 * the body are neutralized with a leading space so a body excerpt can never
 * self-wedge the next splice.
 *
 * The block header names the serve endpoint [OV-A3]: on a multi-brain box the
 * LAST `bootstrap harness` run wins the block, and the named URL is what
 * makes that visible (doctor's drift check compares against config truth).
 */

import { existsSync, readFileSync } from 'node:fs';
import { buildAmbientWritebackSection } from '../facts/writeback-instructions.ts';
import { atomicWriteTextFile } from './atomic-write.ts';

export const AMBIENT_WRITEBACK_BLOCK_BEGIN = '<!-- gbrain:ambient-writeback:begin -->';
export const AMBIENT_WRITEBACK_BLOCK_END = '<!-- gbrain:ambient-writeback:end -->';

function damagedMarkersError(begins: number, ends: number): Error {
  return new Error(
    `the gbrain ambient-writeback markers in this file are damaged ` +
      `(${begins} begin / ${ends} end` +
      `${begins === 1 && ends === 1 ? ', out of order' : ''}) — ` +
      `the managed block was hand-edited. Fix the markers (or delete the whole block, ` +
      `markers included) and re-run \`gbrain bootstrap harness\`.`,
  );
}

/**
 * The ONE marker scan (splice, remove, status probes, and doctor's drift
 * compare all consume it — divergent hand-rolled scans would classify a
 * damaged file differently per surface). 'absent' = no marker lines at all;
 * a well-formed single in-order pair returns its indexes; anything else
 * (duplicates, an orphan, out of order) THROWS the damaged-markers error.
 */
function scanMarkers(lines: string[]): { begin: number; end: number } | 'absent' {
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, i) => {
    if (line === AMBIENT_WRITEBACK_BLOCK_BEGIN) begins.push(i);
    if (line === AMBIENT_WRITEBACK_BLOCK_END) ends.push(i);
  });
  if (begins.length === 0 && ends.length === 0) return 'absent';
  if (begins.length !== 1 || ends.length !== 1 || begins[0] > ends[0]) {
    throw damagedMarkersError(begins.length, ends.length);
  }
  return { begin: begins[0], end: ends[0] };
}

/** Non-throwing probe for status/doctor surfaces: one vocabulary for the
 * three states, with the interior when present. */
export function probeAmbientBlock(
  text: string,
): { state: 'absent' | 'present' | 'damaged'; interior?: string } {
  const lines = text.split('\n');
  try {
    const scan = scanMarkers(lines);
    if (scan === 'absent') return { state: 'absent' };
    return { state: 'present', interior: lines.slice(scan.begin + 1, scan.end).join('\n') };
  } catch {
    return { state: 'damaged' };
  }
}

/**
 * Splice `body` into the managed block inside `existing`. No markers →
 * append a fresh block at EOF. Exactly one in-order pair → replace the
 * interior. Anything else → THROW (spliceCompiledBlock discipline).
 */
export function spliceAmbientWritebackBlock(existing: string, body: string): string {
  const lines = existing.length > 0 ? existing.split('\n') : [];
  const scan = scanMarkers(lines);
  // Neutralize marker-equal lines INSIDE the body: a body line that is
  // exactly a marker string would land as a real marker line — the first
  // splice succeeds, and every run after that sees damaged markers
  // (self-wedge until hand-edit). A leading space keeps the text visible but
  // fails the exact-line match. Deterministic, so re-splices compare
  // like-for-like.
  const neutralized = body
    .split('\n')
    .map((l) => (l === AMBIENT_WRITEBACK_BLOCK_BEGIN || l === AMBIENT_WRITEBACK_BLOCK_END ? ` ${l}` : l))
    .join('\n');
  const interior = neutralized.endsWith('\n') ? neutralized.slice(0, -1) : neutralized;
  if (scan === 'absent') {
    const head =
      existing.length === 0 ? '' : existing.endsWith('\n') ? existing : `${existing}\n`;
    return `${head}${AMBIENT_WRITEBACK_BLOCK_BEGIN}\n${interior}\n${AMBIENT_WRITEBACK_BLOCK_END}\n`;
  }
  const out = [...lines.slice(0, scan.begin + 1), ...interior.split('\n'), ...lines.slice(scan.end)];
  const joined = out.join('\n');
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}

/**
 * Strip the managed block (markers + interior + at most one trailing blank
 * line). No markers → `removed: false` with the text unchanged; damaged
 * markers throw the same error splice throws. The FILE is never deleted by
 * callers — a file left empty of our content stays in place.
 */
export function removeAmbientWritebackBlock(existing: string): { text: string; removed: boolean } {
  const lines = existing.length > 0 ? existing.split('\n') : [];
  const scan = scanMarkers(lines);
  if (scan === 'absent') return { text: existing, removed: false };
  // Consume at most one trailing BLANK line after the end marker. The final
  // '' element of a newline-terminated file is the trailing-newline sentinel,
  // not a blank line — only consume when something follows it.
  let after = scan.end + 1;
  if (after < lines.length - 1 && lines[after] === '') after++;
  const out = [...lines.slice(0, scan.begin), ...lines.slice(after)];
  return { text: out.join('\n'), removed: true };
}

/** True when any exact marker line is present (well-formed OR damaged) —
 * the cheap probe callers run before locking for a strip. */
export function ambientBlockPresent(text: string): boolean {
  return text
    .split('\n')
    .some((l) => l === AMBIENT_WRITEBACK_BLOCK_BEGIN || l === AMBIENT_WRITEBACK_BLOCK_END);
}

export interface AmbientInstructionBlockOpts {
  mode: 'salient' | 'all';
  /** Literal duration shorthand for transient facts, e.g. '3d'. */
  transientTtl: string;
  /** Resolved write posture (writeback-config.ts F5 semantics). */
  visibility: 'world' | 'private';
  /** Normalized serve endpoint the block was installed against [OV-A3]. */
  serveUrl: string;
}

/**
 * The block BODY: a managed-by header line (naming the mode + serve endpoint
 * so multi-brain last-wins stays visible [OV-A3]) followed by the shared
 * ambient-writeback section. `extractFactsAvailable` is 'unknown' here by
 * design: the engine-free harness lane cannot probe the registered serve's
 * surface (a `--surface verbs` serve has no extract_facts), so the block
 * carries the hedged multi-fact line that stays honest on every surface.
 */
export function renderAmbientInstructionBlock(opts: AmbientInstructionBlockOpts): string {
  const header =
    `<!-- managed by \`gbrain bootstrap harness\` — mode: ${opts.mode}; serve: ${opts.serveUrl}; ` +
    `re-run after config changes; do not hand-edit inside markers -->`;
  const section = buildAmbientWritebackSection({
    mode: opts.mode,
    transientTtl: opts.transientTtl,
    visibility: opts.visibility,
    // The engine-free harness lane cannot probe the serve's surface — a
    // clamped `--surface verbs` serve has no extract_facts. 'unknown'
    // renders the hedged multi-fact line ("when that tool is in your tool
    // list"), honest on every surface (codex re-review, this wave).
    extractFactsAvailable: 'unknown',
  });
  return `${header}\n${section}`;
}

/** Read-splice-write helper (absent file → created with just the block).
 * Atomic via atomicWriteTextFile — symlinked dotfile-managed targets survive. */
export function installAmbientWritebackBlockAt(path: string, body: string): void {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  atomicWriteTextFile(path, spliceAmbientWritebackBlock(existing, body));
}

/** Read-strip-write helper. Absent file / no markers → `removed: false`;
 * the file itself is NEVER deleted, even when left empty of our content. */
export function stripAmbientWritebackBlockAt(path: string): { removed: boolean } {
  if (!existsSync(path)) return { removed: false };
  const r = removeAmbientWritebackBlock(readFileSync(path, 'utf8'));
  if (r.removed) atomicWriteTextFile(path, r.text);
  return { removed: r.removed };
}
