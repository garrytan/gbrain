import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { agentFix, checkError, doctorVerify, infoCheck } from '../check-fix.ts';
import { PAGE_BODY_CONFIG_KEYS, parseSegmentedStorage, readPageBodyPolicy, segmentedWriterBlockers, SEGMENTED_WRITER_WINDOW_DAYS } from '../../../core/page-body/limits.ts';
import { SEGMENTED_WRITER_FLOOR } from '../../../core/page-body/writer-floor.ts';
import { existingLocalHostId } from '../../../core/persistence/identity.ts';
import { liveSegmentedBlockers } from '../../../core/persistence/segmented-gate-hold.ts';
import { VERSION } from '../../../version.ts';

const name = 'segmented_storage';
const DOCS = 'docs/guides/memory-boundaries.md#segmented-page-storage';
const SAMPLE = 20;
const enableFix = (why: string) => agentFix(['gbrain', 'config', 'set', PAGE_BODY_CONFIG_KEYS.segmentedStorage, 'on'], why, name, { actor: 'user', docs: DOCS });

/**
 * Wave B activation gate: the configured `pages.segmented_storage`, the value writes use, and the writers seen in
 * the last seven days that do not read segmented pages and keep it off (`segmentedGateWriters`: managed requests,
 * ingest-log runs and resident consumers without the segment-reader mark, or stamped below SEGMENTED_WRITER_FLOOR).
 * While it is off, pages over 1 MiB are written inline up to 24 MiB; stored segmented pages stay readable. A hold left
 * only by this host's own writes from before it upgraded (no live blocker, persistence/segmented-gate-hold.ts
 * `liveSegmentedBlockers`) is information with its clear time, not an upgrade fix; any live blocker keeps the warning
 * and the upgrade fix.
 */
export async function segmentedStorageCheck(engine: BrainEngine): Promise<Check> {
  try {
    const configured = parseSegmentedStorage(await engine.getConfig(PAGE_BODY_CONFIG_KEYS.segmentedStorage));
    const blockers = await segmentedWriterBlockers(engine, { fresh: true });
    const policy = await readPageBodyPolicy(engine);
    const listed = blockers.slice(0, SAMPLE).map(row => ({ host_id: row.host_id, principal: row.principal, role: row.role, version: row.version_label, segment_reader: row.segment_reader,
      last_seen: row.last_seen, clears_at: row.last_seen ? new Date(Date.parse(row.last_seen) + SEGMENTED_WRITER_WINDOW_DAYS * 86_400_000).toISOString() : null }));
    const details = { configured, effective: policy.segmented ? 'on' : 'off', max_bytes: policy.maxBytes, floor: SEGMENTED_WRITER_FLOOR,
      window_days: SEGMENTED_WRITER_WINDOW_DAYS, blockers: listed, truncated: blockers.length > SAMPLE, docs: DOCS };
    if (configured === 'off') return infoCheck(name, 'Segmented page storage is off by choice (pages.segmented_storage=off): pages over 1 MiB are stored inline up to 24 MiB; pages already stored in segments stay readable.',
      'disabled_by_choice', enableFix('Turns segmented storage back on: pages over 1 MiB are stored in segments, up to the engine ceiling.'), details);
    if (configured === 'invalid') return { name, status: 'warn', details, fix: enableFix('Replaces the unrecognized value with on.'),
      message: 'pages.segmented_storage holds an unrecognized value, so segmented page storage is off. Set it to on or off.' };
    const hosts = listed.map(row => `host ${row.host_id ?? 'unknown (not recorded)'} (principal ${row.principal}) ${row.role} ${row.version}, last seen ${row.last_seen}`);
    const self = blockers.length ? existingLocalHostId() : null;
    if (blockers.length && !(await liveSegmentedBlockers(engine, blockers, self)).length) {
      const clears = new Date(Math.max(...blockers.map(row => Date.parse(row.last_seen!))) + SEGMENTED_WRITER_WINDOW_DAYS * 86_400_000).toISOString();
      return infoCheck(name, `Segmented page storage is configured ${configured === 'on' ? 'on' : 'on by default'} but held off until ${clears} by writes this host (${self}) made before it upgraded: ${hosts.join('; ')}${blockers.length > SAMPLE ? ` (first ${SAMPLE} shown)` : ''}. `
        + `This host now runs v${VERSION}, at or above v${SEGMENTED_WRITER_FLOOR}, so nothing needs upgrading; the hold clears ${SEGMENTED_WRITER_WINDOW_DAYS} days after the last of those writes (clears_at), and until then pages over 1 MiB are written inline up to 24 MiB.`,
        'degraded', undefined, details);
    }
    if (blockers.length) {
      return { name, status: 'warn', details,
        message: `Segmented page storage is configured ${configured === 'on' ? 'on' : 'on by default'} but held off: ${blockers.length} writer(s) that do not read segmented pages `
          + `(a gbrain older than this release, or stamped below v${SEGMENTED_WRITER_FLOOR}) wrote in the last ${SEGMENTED_WRITER_WINDOW_DAYS} days: ${hosts.join('; ')}${blockers.length > SAMPLE ? ` (first ${SAMPLE} shown)` : ''}. `
          + 'An older writer does not understand segmented pages, so pages over 1 MiB are written inline up to 24 MiB until it is upgraded. '
          + `The hold clears ${SEGMENTED_WRITER_WINDOW_DAYS} days after each one's last write (clears_at).`,
        fix: { argv: ['gbrain', 'upgrade'], consent: [], actor: 'host_admin', requires_exclusive: false, verify: doctorVerify(name), docs: DOCS,
          why: 'Run on each host doctor names (by host UUID), then restart its gbrain processes; the hold clears once no older writer has written for seven days.' } };
    }
    return { name, status: 'ok', details,
      message: `Segmented page storage is on: pages over 1 MiB are stored in segments, up to ${policy.maxBytes} bytes on this ${engine.kind === 'pglite' ? 'PGLite' : 'Postgres'} brain.` };
  } catch (error) {
    return checkError(name, 'read the segmented storage gate', error, { details: { configured: 'unknown', effective: 'unknown', docs: DOCS } });
  }
}
