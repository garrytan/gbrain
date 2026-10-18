/**
 * `gbrain post-upgrade`: while index-due pages exist (including every page
 * behind the binary's mention or alias version on an otherwise unchanged
 * brain), an `[AGENT]` block names the catch-up sweep and how long it takes,
 * so an upgraded brain gets its entity mention index without waiting for
 * autopilot cycles (each cycle's extract phase also continues the sweep).
 */

import type { BrainEngine } from '../engine.ts';
import { agentBlock } from '../agent-markers.ts';
import { previewMentionPass } from './stale.ts';

/**
 * Planning rate for the catch-up estimate. The 52k-document world ran its
 * full pass at 3,300-7,800 pages/s on PGLite with no embeddings; real pages
 * are longer, so the estimate assumes 1,000 and rounds up to whole minutes.
 */
export const MENTION_PASS_PAGES_PER_SECOND = 1000;

export const MENTION_CATCH_UP_ARGV = ['gbrain', 'extract', '--stale', '--catch-up'] as const;

/** The notice lines, or null when nothing is due (or linking is off). */
export async function mentionIndexUpgradeNotice(engine: BrainEngine): Promise<string[] | null> {
  const preview = await previewMentionPass(engine);
  if (!preview.enabled || preview.due === 0) return null;
  const minutes = Math.max(1, Math.ceil(preview.due / MENTION_PASS_PAGES_PER_SECOND / 60));
  return [
    '',
    agentBlock({
      why: `${preview.due} page(s) have not been scanned for entity names by this version. Until they are, entity cards list only explicit links ` +
        '(coverage: pending) and documents that name an account, person or company by name or code are not linked to it.',
      consent: 'none (free: no model calls, no egress)',
      actor: 'agent',
      next: `run: ${MENTION_CATCH_UP_ARGV.join(' ')} (about ${minutes} minute(s) for ${preview.due} page(s); resumable, and autopilot cycles continue it otherwise)`,
      verify: 'gbrain extract --stale --dry-run --json (mention_due_pages: 0)',
    }).trimEnd(),
    '',
  ];
}

/** Prints the notice when pages are due. Best-effort: never blocks the upgrade. */
export async function printMentionIndexUpgradeNotice(engine: BrainEngine, log: (line: string) => void = console.log): Promise<boolean> {
  try {
    const lines = await mentionIndexUpgradeNotice(engine);
    if (!lines) return false;
    for (const line of lines) log(line);
    return true;
  } catch {
    return false;
  }
}
