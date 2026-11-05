/** #8669: one explicitly approved source turn inside the global maintenance lane. */
import type { BrainEngine } from '../../engine.ts';
import { parseSourceConfig } from '../../sources-load.ts';
import { validateSourceId } from '../../utils.ts';

export const SYNTHESIS_SOURCES_KEY = 'autopilot.global_maintenance.synthesis_sources';
interface SourcePin { source_id: string; incarnation: string }
export interface SynthesisTurn { sourceId?: string; incarnation?: string; cursor?: string; disabled?: boolean }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(): never {
  throw Object.assign(new Error(`${SYNTHESIS_SOURCES_KEY} must be a JSON array of approved {source_id, incarnation} pins for active shared sources; re-preview and explicitly approve the current source identities.`), { code: 'config' });
}

/** No list keeps legacy routing; [] disables synthesis. Read federation alone never opts a source in. */
export async function nextSynthesisTurn(engine: BrainEngine, lastCursor?: string): Promise<SynthesisTurn> {
  const raw = await engine.getConfig(SYNTHESIS_SOURCES_KEY);
  if (raw === null || raw === undefined) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return refuse(); }
  if (!Array.isArray(parsed)) return refuse();
  if (!parsed.length) return { disabled: true };
  const pins: SourcePin[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || typeof item.source_id !== 'string' || typeof item.incarnation !== 'string' || !UUID.test(item.incarnation)) return refuse();
    try { validateSourceId(item.source_id); } catch { return refuse(); }
    if (pins.some(p => p.source_id === item.source_id)) return refuse();
    pins.push({ source_id: item.source_id, incarnation: item.incarnation.toLowerCase() });
  }
  // Re-read every pin at claim time. No fallback to the default source, and no
  // adoption of a source that was deleted and recreated under the same name.
  for (const pin of pins) {
    const rows = await engine.executeRaw<{ incarnation: string; archived: boolean; config: unknown }>(
      'SELECT incarnation::text AS incarnation, archived, config FROM sources WHERE id=$1', [pin.source_id]);
    const row = rows[0];
    if (!row || row.archived || row.incarnation !== pin.incarnation || parseSourceConfig(row.config).federated !== true) return refuse();
  }
  pins.sort((a, b) => a.source_id.localeCompare(b.source_id));
  const previous = pins.findIndex(p => `${p.source_id}@${p.incarnation}` === lastCursor);
  const pin = pins[(previous + 1) % pins.length]!;
  return { sourceId: pin.source_id, incarnation: pin.incarnation, cursor: `${pin.source_id}@${pin.incarnation}` };
}
