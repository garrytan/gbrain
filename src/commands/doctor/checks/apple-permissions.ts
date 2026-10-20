import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { readConnectorCursorState, type ConnectorSourceRow } from '../../../core/connectors/item-holds-store.ts';
import { parseAppleSourceConfig } from '../../../core/apple/source-config.ts';
import { PERMISSION_CODES, permissionGuide } from '../../../core/apple/permission-guide.ts';
import { isAppleReaderErrorCode } from '../../../core/apple/readers/errors.ts';
import { ALL_APPLE_SERVICES } from '../../../core/apple/types.ts';
import { agentFix } from '../check-fix.ts';

/**
 * #6855: Apple sources with an enabled service whose last recorded probe was a
 * permission denial (macOS Calendars / Contacts privacy, or Mail Automation).
 * Zero-network and zero-helper: it reads the `last_probe` a sync stored in the
 * source's cursor state; `gbrain apple status` probes live. A denied service
 * otherwise looks like an empty one. Disabled services are never reported.
 */
export async function appleServicePermissionsCheck(engine: BrainEngine, sourceIds?: string[]): Promise<Check> {
  try {
    const rows = await engine.executeRaw<ConnectorSourceRow>(
      "SELECT id, incarnation::text AS incarnation, local_path, config FROM sources WHERE archived IS NOT TRUE AND config->>'kind' = 'apple' ORDER BY id");
    const denied: Array<{ source_id: string; service: string; code: string; at: string; pane: string | null; fix: string }> = [];
    for (const row of rows) {
      if (sourceIds && !sourceIds.includes(row.id)) continue;
      const cfg = parseAppleSourceConfig(row.config, row.local_path ?? '');
      const last = ((await readConnectorCursorState(engine, row))?.last_probe ?? {}) as Record<string, { ok?: boolean; at?: string; code?: string }>;
      for (const service of ALL_APPLE_SERVICES) {
        if (!cfg.services.includes(service)) continue;
        const probe = last[service];
        if (!probe || probe.ok !== false || !isAppleReaderErrorCode(probe.code) || !PERMISSION_CODES.includes(probe.code)) continue;
        const guide = permissionGuide(service, probe.code);
        denied.push({ source_id: row.id, service, code: probe.code, at: String(probe.at ?? ''), pane: guide.pane, fix: guide.fix });
      }
    }
    const details = { code: denied.length ? 'permission_denied' : undefined, count: denied.length, services: denied, docs: 'docs/guides/apple-connect.md#permissions' };
    if (!denied.length) return { name: 'apple_permissions', status: 'ok', message: 'No Apple source recorded a denied permission at its last sync.', details };
    const first = denied[0]!;
    return {
      name: 'apple_permissions', status: 'warn', details,
      message: denied.map((d) => `Apple source ${d.source_id}: ${d.service} was denied (${d.code}) at the last sync, so it imports nothing. ${d.pane ? `Open ${d.pane}. ` : ''}${d.fix}`).join(' '),
      fix: agentFix(['gbrain', 'apple', 'status', '--json'],
        'Read-only: probes each enabled service live and names the System Settings pane to fix; the user grants access there, then re-run gbrain apple setup.',
        'apple_permissions', { docs: 'docs/guides/apple-connect.md#permissions', ask_user: true, user_message: `${first.service} access is denied. ${first.pane ?? first.fix}` }),
    };
  } catch (error) {
    return { name: 'apple_permissions', status: 'warn', fix_unavailable_reason: 'check_errored', details: { count: 'unknown' },
      message: `Apple permissions could not be read from source state: ${error instanceof Error ? error.message : String(error)}. Health is unknown.` };
  }
}
