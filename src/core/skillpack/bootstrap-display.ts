/**
 * skillpack/bootstrap-display.ts — post-scaffold runbook display.
 *
 * Codex T1 fix: third-party packs don't auto-execute their install
 * runbook. Instead, scaffold drops the files (additively, the v0.36
 * way) and then displays `runbooks/bootstrap.md` if present, framed
 * for the calling agent to walk per-step at its own discretion.
 *
 * No executor. No `agent:` / `show user:` / `ask user:` dispatch.
 * Just print the markdown with a header that signals to any agent
 * reading the output that these are SUGGESTED steps, not a runnable
 * script. The agent (Claude / OpenClaw / etc.) decides whether to
 * walk them and how.
 *
 * Stays pure-data: returns the framed text rather than writing
 * directly so tests can assert the shape and callers control the
 * output stream.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import type { SkillpackManifest } from './manifest-v1.ts';

export interface BootstrapDisplayInput {
  /** Absolute path to the scaffolded skillpack root (pack cache or local). */
  packRoot: string;
  /** Parsed manifest. */
  manifest: SkillpackManifest;
  /** Absolute path to the user's workspace where files landed. */
  workspace: string;
}

export interface BootstrapDisplayResult {
  /** True when a bootstrap.md was found AND non-empty. */
  shown: boolean;
  /** The framed text the caller writes to stderr/stdout. Empty when shown=false. */
  text: string;
  /** Resolved bootstrap.md path (informational). */
  bootstrapPath: string | null;
}

const FRAME_HEADER = `══════════════════════════════════════════════════════════════════════
 BOOTSTRAP STEPS (read-only — agent decides what to run)
══════════════════════════════════════════════════════════════════════
These are SUGGESTED next steps from the skillpack author. gbrain
deliberately does NOT auto-execute them — third-party packs run in
trusted-path mode and an automated walker would let a malicious pack
mutate your brain on install.

Read each step. Run what you understand. Skip what you don't. Use
\`gbrain skillpack reference <name>\` later if you want to see what
the author changed in a new version.
══════════════════════════════════════════════════════════════════════
`;

const FRAME_FOOTER = `══════════════════════════════════════════════════════════════════════
End of bootstrap steps. The skillpack files are already on disk —
nothing above has been executed.
══════════════════════════════════════════════════════════════════════
`;

/**
 * Build the framed bootstrap output. Pure function — does not write to any
 * stream. Returns shown=false when there's no bootstrap.md or it's empty.
 */
export function buildBootstrapDisplay(input: BootstrapDisplayInput): BootstrapDisplayResult {
  const relPath = input.manifest.runbooks?.bootstrap;
  if (!relPath) {
    return { shown: false, text: '', bootstrapPath: null };
  }
  const absPath = join(input.packRoot, relPath);
  if (!existsSync(absPath)) {
    return { shown: false, text: '', bootstrapPath: absPath };
  }
  const content = readFileSync(absPath, 'utf-8').trim();
  if (content.length === 0) {
    return { shown: false, text: '', bootstrapPath: absPath };
  }

  const text = `${FRAME_HEADER}\n${content}\n\n${FRAME_FOOTER}`;
  return { shown: true, text, bootstrapPath: absPath };
}
