import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { recentWriterVersions, WRITER_VERSION_FLOOR, writerVersionBelowFloor } from '../../../core/persistence/writer-versions.ts';

const WINDOW_DAYS = 7;
const SAMPLE = 20;

/**
 * Writer-version advisory: committed requests from the last seven days whose admitting or publishing
 * binary predates v0.60.5.0 or this release (no stamp). Observation, not prevention; older writers are
 * not blocked. Pending requests never count, and only requests admitted or published after migration 178
 * are expected to carry stamps.
 */
export async function writerVersionCheck(engine: BrainEngine): Promise<Check> {
  try {
    const [brain] = await engine.executeRaw<{ cutoff: unknown }>('SELECT writer_version_cutoff AS cutoff FROM persistence_brain WHERE singleton=1');
    if (!brain?.cutoff) throw new Error('the writer-version migration cutoff is not recorded');
    const observed = await recentWriterVersions(engine, WINDOW_DAYS);
    const flagged = observed.filter(row => writerVersionBelowFloor(row.version));
    const hosts = flagged.slice(0, SAMPLE).map(row => ({ host_id: row.host_id, principal: row.principal, role: row.role,
      [`${row.role}_version`]: row.version_label, last_seen: row.last_seen, requests: row.requests }));
    const count = flagged.reduce((sum, row) => sum + row.requests, 0);
    const details = { count, truncated: flagged.length > SAMPLE, hosts, window_days: WINDOW_DAYS, floor: WRITER_VERSION_FLOOR,
      observed: observed.slice(0, SAMPLE).map(row => ({ host_id: row.host_id, principal: row.principal, role: row.role, version: row.version_label, last_seen: row.last_seen })) };
    if (!flagged.length) return { name: 'writer_version', status: 'ok', details,
      message: `Every writer that admitted or published a request in the last ${WINDOW_DAYS} days is v${WRITER_VERSION_FLOOR} or newer.` };
    const listed = hosts.map(host => `host ${host.host_id ?? 'unknown (not recorded)'} (principal ${host.principal}) ${host.role} ${host[`${host.role}_version`]}, last seen ${host.last_seen}`);
    return { name: 'writer_version', status: 'warn', details,
      message: `${count} committed request(s) in the last ${WINDOW_DAYS} days were admitted or published by a writer older than v${WRITER_VERSION_FLOOR} or by an unstamped binary: `
        + `${listed.join('; ')}${flagged.length > SAMPLE ? ` (first ${SAMPLE} of ${flagged.length} shown)` : ''}. `
        + `A writer older than v${WRITER_VERSION_FLOOR} may still delete database-only timeline rows. Run \`gbrain upgrade\` on that host. `
        + 'This is an observation, not prevention: older writers are not blocked.' };
  } catch (error) {
    return { name: 'writer_version', status: 'warn',
      message: `Writer versions could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown', truncated: true, hosts: [] } };
  }
}
