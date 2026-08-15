// v0.42.x — Life Chronicle (#2390) put_page chronicle backstop (Phase A.3).
// Deterministic + fire-and-forget: it ONLY checks eligibility + the auto_chronicle
// flag and enqueues a `chronicle_extract` minion job. The LLM judgment runs off
// the write path in the job handler. Mirrors facts/backstop.ts (queue mode).
import type { BrainEngine } from '../engine.ts';
import { isChronicleEligible } from './eligibility.ts';
import { isAutoChronicleEnabled } from './config.ts';

export interface ChronicleBackstopResult {
  enqueued: boolean;
  skipped?: string;
}

/**
 * Eligibility + enqueue. The CALLER is responsible for the trust gate and for
 * only invoking on a real import (status==='imported') — see the put_page hook,
 * which skips on remote/untrusted and on skipped/unchanged rewrites so an edit
 * that changes nothing never re-enqueues.
 */
export async function runChronicleBackstop(
  page: { slug: string; type: string; compiled_truth?: string; frontmatter?: Record<string, unknown> },
  ctx: { engine: BrainEngine; sourceId: string },
): Promise<ChronicleBackstopResult> {
  const dreamGenerated = page.frontmatter?.dream_generated === true;
  const elig = isChronicleEligible({
    type: page.type, slug: page.slug, body: page.compiled_truth, dreamGenerated,
  });
  if (!elig.ok) return { enqueued: false, skipped: elig.reason };
  if (!(await isAutoChronicleEnabled(ctx.engine))) return { enqueued: false, skipped: 'auto_chronicle_off' };
  try {
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    await queue.add('chronicle_extract', { slug: page.slug, sourceId: ctx.sourceId });
    return { enqueued: true };
  } catch {
    return { enqueued: false, skipped: 'enqueue_error' };
  }
}
