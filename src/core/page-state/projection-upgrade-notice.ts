/**
 * #6803 A10: `gbrain post-upgrade` names the projection drain while image
 * pages wait in the projection queue (`sealable` or `reimport`). Read-only: it
 * counts the queue and prints an `[AGENT]` block; the drain stays an explicit,
 * preview-first step the user agrees to (doctor's fix asks first too).
 */
import type { BrainEngine } from '../engine.ts';
import { agentBlock } from '../agent-markers.ts';
import { projectionBacklog } from './projections.ts';
import { IMAGE_SEAL_PAGES_PER_SECOND, projectionDrainMinutes } from './image-seal.ts';

/** The notice lines, or null when no image page waits. */
export async function projectionUpgradeNotice(engine: BrainEngine): Promise<string[] | null> {
  const backlog = await projectionBacklog(engine);
  if (!backlog.sealable && !backlog.reimport) return null;
  const sealing = backlog.sealable
    ? `${backlog.sealable} image page(s) the importer already attested can be sealed keyless by ` +
      `gbrain projections drain (about ${projectionDrainMinutes(backlog.sealable)} minute(s) at ${IMAGE_SEAL_PAGES_PER_SECOND} pages/s, the rate measured on a 10,000-image drain; ` +
      'no provider call, no re-embedding). '
    : '';
  const reimport = backlog.reimport
    ? `${backlog.reimport} image page(s) need their importer (fresh OCR and pixels, paid): preview with gbrain embed --stale --images --dry-run. `
    : '';
  return [
    '',
    agentBlock({
      why: `${backlog.sealable + backlog.reimport} image page(s) are queued for a text projection and out of search until sealed. ${sealing}${reimport}`.trimEnd(),
      consent: 'ask the user before draining (the preview is read-only)',
      actor: 'agent',
      next: 'run: gbrain projections drain --dry-run (read-only preview of every class), then relay it and ask before running gbrain projections drain',
      verify: 'gbrain doctor --only text_projection_readiness --json',
    }).trimEnd(),
    '',
  ];
}

/** Prints the notice while image pages wait. Best-effort: never blocks the upgrade. */
export async function printProjectionUpgradeNotice(engine: BrainEngine, log: (line: string) => void = console.log): Promise<boolean> {
  try {
    const lines = await projectionUpgradeNotice(engine);
    if (!lines) return false;
    for (const line of lines) log(line);
    return true;
  } catch {
    return false;
  }
}
