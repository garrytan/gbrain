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
 * Splice discipline lives in src/core/managed-block.ts (shared with the
 * brain-first block): exact-line marker match at column 0; no markers →
 * append a fresh block at EOF; exactly one in-order pair → replace the
 * interior; anything else (duplicates, an orphan, out of order) → THROW.
 * Marker-equal lines inside the body are neutralized with a leading space.
 *
 * The block header names the serve endpoint [OV-A3]: on a multi-brain box the
 * LAST `bootstrap harness` run wins the block, and the named URL is what
 * makes that visible (doctor's drift check compares against config truth).
 */

import { existsSync, readFileSync } from 'node:fs';
import { buildAmbientWritebackSection } from '../facts/writeback-instructions.ts';
import { atomicWriteTextFile } from './atomic-write.ts';
import { blockPresent, probeBlock, removeBlock, spliceBlock, type BlockMarkers } from '../managed-block.ts';

export const AMBIENT_WRITEBACK_BLOCK_BEGIN = '<!-- gbrain:ambient-writeback:begin -->';
export const AMBIENT_WRITEBACK_BLOCK_END = '<!-- gbrain:ambient-writeback:end -->';

const AMBIENT_MARKERS: BlockMarkers = {
  begin: AMBIENT_WRITEBACK_BLOCK_BEGIN,
  end: AMBIENT_WRITEBACK_BLOCK_END,
  label: 'ambient-writeback',
  rerun: 'gbrain bootstrap harness',
};

/** Non-throwing probe for status/doctor surfaces: one vocabulary for the
 * three states, with the interior when present. */
export function probeAmbientBlock(text: string): { state: 'absent' | 'present' | 'damaged'; interior?: string } {
  return probeBlock(AMBIENT_MARKERS, text);
}

/**
 * Splice `body` into the managed block inside `existing`. No markers →
 * append a fresh block at EOF. Exactly one in-order pair → replace the
 * interior. Anything else → THROW (managed-block.ts discipline).
 */
export function spliceAmbientWritebackBlock(existing: string, body: string): string {
  return spliceBlock(AMBIENT_MARKERS, existing, body);
}

/**
 * Strip the managed block (markers + interior + at most one trailing blank
 * line). No markers → `removed: false` with the text unchanged; damaged
 * markers throw the same error splice throws. The FILE is never deleted by
 * callers — a file left empty of our content stays in place.
 */
export function removeAmbientWritebackBlock(existing: string): { text: string; removed: boolean } {
  return removeBlock(AMBIENT_MARKERS, existing);
}

/** True when any exact marker line is present (well-formed OR damaged) —
 * the cheap probe callers run before locking for a strip. */
export function ambientBlockPresent(text: string): boolean {
  return blockPresent(AMBIENT_MARKERS, text);
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
