/**
 * Compatibility windows, recorded in one place: wire fields a gbrain process still accepts from an older peer after it
 * stopped using them, and config keys a published notice names as the way back.
 *
 * Master ships many PATCH releases a day, so a window counted in releases lasts hours. Each window is a calendar
 * period plus a version floor.
 * - A retired wire field is accepted (validated by shape, ignored, and noted) until `accept_until`, and only peers
 *   below `floor` still send it. A newer client never sends it: the one sync flag table (`src/core/sync-flags.ts`)
 *   does not list it. After `accept_until` the field may be deleted from here and from the validators.
 * - A rollback key stays readable and honored at least until `honored_until`, by every release from `floor` on; the
 *   notice or migration that names it (`named_in`) promised users that way back. It is listed as a rollback key,
 *   never as a tunable (`src/core/sync-config-keys.ts`).
 */
export type SyncWire = 'serve' | 'owner';
export interface WireSkewWindow {
  field: string;
  floor: string;
  accept_until: string;
  why: string;
  /** The hand-offs that still accept it: serve delegation (`sync-ipc.ts`) and the PGLite owner lane (`sync-wire.ts`). */
  wires: readonly SyncWire[];
  /** The shape an older peer sends; anything else is refused as an invalid option. */
  accepts: (value: unknown) => boolean;
}

const PROCESSING_KEYS: readonly unknown[] = ['noEmbed', 'noExtract', 'noSchemaPack'];

export const WIRE_SKEW_WINDOWS = {
  /** #6712 PR 1: the managed cursor's processing options are inherited, so the explicit-flag list no longer decides anything. */
  explicitProcessing: { field: 'explicitProcessing', floor: '0.60.255.0', accept_until: '2026-11-14', wires: ['serve', 'owner'],
    accepts: value => Array.isArray(value) && new Set(value).size === value.length && value.every(item => PROCESSING_KEYS.includes(item)),
    why: 'Sync clients below the floor send the processing flags their user typed (#6317, #6696); a resume now inherits the cursor\'s opt-outs instead.' },
} as const satisfies Record<string, WireSkewWindow>;

/** The retired fields one hand-off still accepts, by field name. */
export function retiredWireFields(wire: SyncWire): ReadonlyMap<string, WireSkewWindow> {
  return new Map((Object.values(WIRE_SKEW_WINDOWS) as WireSkewWindow[]).filter(window => window.wires.includes(wire)).map(window => [window.field, window]));
}

/** The one notice a resident prints when it ignores retired fields an older client sent. */
export function retiredWireNotice(fields: readonly string[]): string {
  const windows = fields.map(field => (Object.values(WIRE_SKEW_WINDOWS) as WireSkewWindow[]).find(window => window.field === field)!);
  return `[gbrain notice] this gbrain ignores ${windows.map(window => `\`${window.field}\` (sent by gbrain below ${window.floor}; accepted until ${window.accept_until})`).join(', ')} `
    + 'from an older sync client and runs without it. Upgrade the gbrain that runs `gbrain sync` to match this one.';
}

export interface ConfigRollbackWindow { key: string; floor: string; honored_until: string; named_in: string; restores: string }

export const CONFIG_ROLLBACK_WINDOWS = {
  'sync.job_drain': { key: 'sync.job_drain', floor: '0.60.266.0', honored_until: '2027-01-14', named_in: '0.60.233.0 behavior notice (#6706)',
    restores: 'single-pass managed `sync` jobs instead of draining to the job deadline' },
  'sync.foreground_priority': { key: 'sync.foreground_priority', floor: '0.60.266.0', honored_until: '2027-01-14', named_in: 'docs/guides/live-sync.md (#5984)',
    restores: 'first-in-first-out bulk groups instead of letting foreground writes go first' },
  'sync.federated_v2': { key: 'sync.federated_v2', floor: '0.60.266.0', honored_until: '2027-01-14', named_in: 'skills/migrations/v0.40.5.md',
    restores: 'the v0.39 sequential sync --all instead of the federated v2 path' },
  'sync.waive_batch': { key: 'sync.waive_batch', floor: '0.60.266.0', honored_until: '2027-01-14', named_in: '#5984 behavior notice',
    restores: 'one waived entry per transaction instead of batched waivers' },
  'sync.bulk': { key: 'sync.bulk', floor: '0.60.266.0', honored_until: '2027-01-14', named_in: '#5984 behavior notice and docs/guides/live-sync.md',
    restores: 'one page per transaction on managed Postgres sync instead of bulk groups' },
} as const satisfies Record<string, ConfigRollbackWindow>;
