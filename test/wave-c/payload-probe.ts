/** Wave C test helper: searches every table for a marker (rows cast to text; bytea shows as hex) at the door seam. */
import type { BrainEngine } from '../../src/core/engine.ts';
import { _setDoorProbeForTests } from '../../src/core/persistence/coordinator.ts';

const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex');

/**
 * Tables (and the count of rows) holding `marker` as text or as hex bytes. `exceptRequest`: the write's own admission
 * journal row (its intent carries the caller's payload by design) is left out.
 */
export async function payloadTables(engine: BrainEngine, marker: string, exceptRequest?: string): Promise<string[]> {
  const tables = await engine.executeRaw<{ name: string }>(`SELECT quote_ident(table_name) AS name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`);
  const found: string[] = [];
  for (const { name } of tables) {
    const skip = name === 'persistence_requests' && exceptRequest ? ` AND NOT (t.request_id::text = '${exceptRequest}' OR t.id::text = '${exceptRequest}')` : '';
    const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${name} t WHERE (t::text LIKE $1 OR t::text LIKE $2)${skip}`,
      [`%${marker}%`, `%${hex(marker)}%`]);
    if (row && row.n > 0) found.push(`${name}:${row.n}`);
  }
  return found;
}

/** Installs the door probe for one request; `seen()` reports whether it ran and what it found. Uninstall with `clear()`. */
export function probeHooks(marker: string, requestId: string) {
  let result: { probed: boolean; tables: string[] } = { probed: false, tables: [] };
  _setDoorProbeForTests(async (tx, row) => {
    if (row.request_id !== requestId) return;
    result = { probed: true, tables: await payloadTables(tx, marker, requestId) };
  });
  return { seen: () => result, clear: () => _setDoorProbeForTests(null) };
}

/** As probeHooks, for whichever strict publication reaches the door next (an upload's commit request id is minted inside the op). */
export function probeAny(marker: string) {
  let result: { probed: boolean; tables: string[] } = { probed: false, tables: [] };
  _setDoorProbeForTests(async (tx, row) => { result = { probed: true, tables: await payloadTables(tx, marker, row.request_id) }; });
  return { seen: () => result, clear: () => _setDoorProbeForTests(null) };
}
