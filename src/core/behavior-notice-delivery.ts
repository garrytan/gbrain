/**
 * Delivery of the `behavior_changes` notice: the rendered disclosure, the CLI/stdio markers and the HTTP shown row
 * (core/behavior-change-notice.ts holds the BEHAVIOR_CHANGES table and the module doc).
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from './engine.ts';
import type { Action, Notice } from './agent-output.ts';
import { gbrainPath, type GBrainConfig } from './config.ts';
import { VERSION } from '../version.ts';
import { chatFallbackRemovalFix } from './ai/chat-fallback-planes.ts';
import { BEHAVIOR_CHANGES, BEHAVIOR_NOTICE_ID, BEHAVIOR_NOTICE_SINCE } from './behavior-change-notice.ts';
import {
  BEHAVIOR_NOTICE_CODE, CLIENT_ID_MAX, DOCTOR_ARGV, FRESH_BRAIN_GRACE_MS, HTTP_SHOWN_CAP, HTTP_SHOWN_KEY, PREDATES, RELEASE,
  behaviorBrainKey, compareReleases, currentBrainId, chainDisclosure, laterRelease, noticeDir, readBaseline, safe,
  writeBaseline, type ChainDisclosure,
} from './behavior-notice-state.ts';

/** `gbrain upgrade` recorded an upgrade from a release older than the newest disclosed change. */
function upgradedAcrossRelease(): boolean {
  try {
    const state = JSON.parse(readFileSync(gbrainPath('upgrade-state.json'), 'utf8')) as { last_upgrade?: { from?: unknown } };
    const from = state.last_upgrade?.from;
    return typeof from === 'string' && compareReleases(from, BEHAVIOR_NOTICE_SINCE) < 0;
  } catch {
    return false;
  }
}

async function brainCreatedBefore(engine: BrainEngine, cutoffMs: number): Promise<boolean> {
  try {
    const rows = await engine.executeRaw<{ at: string | Date | null }>(`SELECT MIN(created_at) AS at FROM sources`);
    const at = rows[0]?.at;
    if (at === null || at === undefined) return false;
    const ms = new Date(at).getTime();
    return Number.isFinite(ms) && ms < cutoffMs;
  } catch {
    return false;
  }
}

/**
 * The brain's baseline release (`0` when it predates baselines). Reads the
 * recorded baseline; without one, derives it and (when `persist`) records it,
 * so a fresh brain stays fresh after the grace window. `persist: false`
 * (doctor) writes nothing.
 */
export async function brainBaseline(
  engine: BrainEngine | null,
  brainKey: string,
  opts: { persist: boolean; now?: number },
): Promise<string> {
  const recorded = readBaseline(brainKey);
  if (recorded) return recorded;
  const now = opts.now ?? Date.now();
  const predates = upgradedAcrossRelease() || (engine !== null && await brainCreatedBefore(engine, now - FRESH_BRAIN_GRACE_MS));
  const since = predates ? PREDATES : VERSION;
  if (!opts.persist) return since;
  writeBaseline(brainKey, since, true);
  return readBaseline(brainKey) ?? since;
}

/**
 * The disclosure of the changes introduced after release `after` (default:
 * all of them), grouped by release; null when none apply. `remote` (HTTP)
 * names only that a chain is configured; entries and providers stay on the host.
 */
/**
 * The releases a disclosure covers: listed when there are a few, a range past
 * that, so the header does not crowd the changes out of the rendered 2,000
 * characters as releases accumulate.
 */
export function releaseSpan(versions: string[]): string {
  if (versions.length > RELEASE_LIST_MAX) {
    const sorted = [...versions].sort(compareReleases);
    return `v${sorted[0]} through v${sorted.at(-1)} (${versions.length} releases)`;
  }
  const releases = versions.map(v => `v${v}`);
  return releases.length > 1 ? `${releases.slice(0, -1).join(', ')} and ${releases.at(-1)}` : releases[0]!;
}
const RELEASE_LIST_MAX = 4;

export function behaviorChangesNotice(chain: ChainDisclosure | null, opts: { remote?: boolean; after?: string } = {}): Notice | null {
  const byRelease = new Map<string, string[]>();
  let namesChain = false;
  for (const change of BEHAVIOR_CHANGES) {
    if (compareReleases(change.since, opts.after ?? PREDATES) <= 0) continue;
    const text = typeof change.text === 'string' ? change.text : change.text(chain, !!opts.remote);
    if (!text) continue;
    namesChain ||= typeof change.text !== 'string';
    byRelease.set(change.since, [...(byRelease.get(change.since) ?? []), text]);
  }
  if (byRelease.size === 0) return null;
  const count = [...byRelease.values()].reduce((n, texts) => n + texts.length, 0);
  let n = 0;
  const why = `gbrain ${releaseSpan([...byRelease.keys()])} changed ${count} behavior${count === 1 ? '' : 's'} on this brain. All stay on; this is a one-time disclosure, not a request for consent. ` +
    [...byRelease].map(([since, texts]) => (byRelease.size > 1 ? `v${since}: ` : '') + texts.map(t => `(${++n}) ${t}`).join(' ')).join(' ') +
    ' gbrain doctor --only behavior_changes shows this again.';
  const fix: Action = chain && namesChain && !opts.remote
    ? chatFallbackRemovalFix(chain.plane, chain.filePath)
    : { argv: DOCTOR_ARGV, consent: [], actor: opts.remote ? 'host_admin' : 'agent', requires_exclusive: false,
      why: 'Shows this disclosure again; read-only.', docs: 'docs/guides/chat-fallback.md' };
  return { code: BEHAVIOR_NOTICE_CODE, kind: 'safety', why, fix };
}

/**
 * #5575 legacy content: while unclaimed sources hold rows from before trust
 * tiers, the notice's fix becomes the claim (`fix.next: tell_user_to_run`, the
 * user_message explains claiming), unless it already carries the chat
 * fallback removal. Best-effort: any fault keeps the notice as built.
 */
export async function withTrustClaimAsk(engine: BrainEngine, notice: Notice | null): Promise<Notice | null> {
  if (!notice || (notice.fix?.argv && notice.fix.argv.join(' ') !== DOCTOR_ARGV.join(' '))) return notice;
  try {
    const { claimSourcesFix, hasUnclaimedLegacySources, CLAIM_USER_MESSAGE } = await import('./trust/claim.ts');
    if (!(await hasUnclaimedLegacySources(engine))) return notice;
    return { ...notice, fix: claimSourcesFix(), user_message: CLAIM_USER_MESSAGE };
  } catch {
    return notice;
  }
}

// ── delivery ────────────────────────────────────────────────────────────────

/** notice × brain × channel (× client) already handled in this process: one look per process. */
const handled = new Set<string>();
const HANDLED_MAX = 10_000;

function markHandled(key: string): boolean {
  if (handled.has(key)) return false;
  if (handled.size >= HANDLED_MAX) handled.delete(handled.values().next().value as string);
  handled.add(key);
  return true;
}

/** Test seam: forget this process's looks. */
export function __resetBehaviorNoticeForTests(): void {
  handled.clear();
}

const markerPrefix = safe(`${BEHAVIOR_NOTICE_CODE}@`);
const markerSuffix = (brainKey: string, channel: 'cli' | 'stdio') => `.${brainKey}.${channel}.shown`;

/** Claim the per-channel marker for the current notice id. `unwritable` still delivers (conservative). */
function claimMarker(brainKey: string, channel: 'cli' | 'stdio'): 'claimed' | 'shown' | 'unwritable' {
  const path = join(noticeDir(), `${safe(BEHAVIOR_NOTICE_ID)}${markerSuffix(brainKey, channel)}`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx' });
    return 'claimed';
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EEXIST' ? 'shown' : 'unwritable';
  }
}

/** The newest notice release this brain × channel was shown (any build's marker), `0` when none. */
function localShownThrough(brainKey: string, channel: 'cli' | 'stdio'): string {
  const suffix = markerSuffix(brainKey, channel);
  let through = PREDATES;
  try {
    for (const name of readdirSync(noticeDir())) {
      if (!name.startsWith(markerPrefix) || !name.endsWith(suffix)) continue;
      const release = name.slice(markerPrefix.length, -suffix.length);
      if (RELEASE.test(release)) through = laterRelease(through, release);
    }
  } catch { /* no markers yet, or an unreadable home */ }
  return through;
}

/** Has this channel been shown the newest notice for this brain? (doctor; read-only) */
export function behaviorNoticeShown(brainKey: string, channel: 'cli' | 'stdio'): boolean {
  return compareReleases(localShownThrough(brainKey, channel), BEHAVIOR_NOTICE_SINCE) >= 0;
}

/**
 * CLI and stdio: the changes this brain × channel has not been shown, once
 * per notice, or null. Never throws; a fault returns null and the next call
 * looks again.
 */
export async function takeLocalBehaviorNotice(
  engine: BrainEngine,
  channel: 'cli' | 'stdio',
  opts: { cfg: GBrainConfig | null; brainKey?: string; now?: number },
): Promise<Notice | null> {
  let key = '';
  try {
    const brainKey = opts.brainKey ?? behaviorBrainKey(opts.cfg, await currentBrainId());
    key = `${BEHAVIOR_NOTICE_ID}|${brainKey}|${channel}`;
    if (!markHandled(key)) return null;
    const after = laterRelease(await brainBaseline(engine, brainKey, { persist: true, now: opts.now }), localShownThrough(brainKey, channel));
    if (compareReleases(BEHAVIOR_NOTICE_SINCE, after) <= 0) return null;
    if (claimMarker(brainKey, channel) === 'shown') return null;
    return withTrustClaimAsk(engine, behaviorChangesNotice(await chainDisclosure(engine, opts.cfg), { after }));
  } catch {
    if (key) handled.delete(key);
    return null;
  }
}

type HttpShown = Record<string, { since: string; at: string }>;

/** Clients and the notice release each was shown. A row from an older build (`clients` mapping to a time) was shown its row id's release. */
function readHttpShown(raw: string | null): HttpShown {
  const shown: HttpShown = {};
  try {
    const v = raw ? JSON.parse(raw) as { id?: unknown; clients?: Record<string, unknown> } : null;
    const rowRelease = typeof v?.id === 'string' && v.id.startsWith(`${BEHAVIOR_NOTICE_CODE}@`) ? v.id.slice(BEHAVIOR_NOTICE_CODE.length + 1) : '';
    for (const [client, entry] of Object.entries(v?.clients && typeof v.clients === 'object' ? v.clients : {})) {
      const e = entry as { since?: unknown; at?: unknown } | string;
      if (typeof e === 'string' && RELEASE.test(rowRelease)) shown[client] = { since: rowRelease, at: e };
      else if (typeof e === 'object' && e && typeof e.since === 'string' && RELEASE.test(e.since) && typeof e.at === 'string') shown[client] = { since: e.since, at: e.at };
    }
  } catch { /* unreadable: start over */ }
  return shown;
}

/** Record a client as shown the current notice, keeping the newest HTTP_SHOWN_CAP. */
export function recordHttpShown(raw: string | null, clientId: string, at: string): string {
  const shown = readHttpShown(raw);
  shown[clientId] = { since: BEHAVIOR_NOTICE_SINCE, at };
  const kept = Object.entries(shown).sort((a, b) => (a[1].at < b[1].at ? 1 : a[1].at > b[1].at ? -1 : 0)).slice(0, HTTP_SHOWN_CAP);
  return JSON.stringify({ id: BEHAVIOR_NOTICE_ID, clients: Object.fromEntries(kept) });
}

/**
 * HTTP: the changes each authenticated client has not been shown, once per
 * notice (remote view: no entries or providers). The per-client record lives
 * in the brain's `config` table; a failed write still delivers. Never throws.
 */
export async function takeHttpBehaviorNotice(
  engine: BrainEngine,
  clientId: string | undefined,
  opts: { cfg: GBrainConfig | null; brainKey?: string; now?: number },
): Promise<Notice | null> {
  if (!clientId) return null;
  const client = clientId.slice(0, CLIENT_ID_MAX);
  let key = '';
  try {
    const brainKey = opts.brainKey ?? behaviorBrainKey(opts.cfg, await currentBrainId());
    key = `${BEHAVIOR_NOTICE_ID}|${brainKey}|http|${client}`;
    if (!markHandled(key)) return null;
    const baseline = await brainBaseline(engine, brainKey, { persist: true, now: opts.now });
    const raw = await engine.getConfig(HTTP_SHOWN_KEY).catch(() => null);
    const after = laterRelease(baseline, readHttpShown(raw)[client]?.since ?? PREDATES);
    if (compareReleases(BEHAVIOR_NOTICE_SINCE, after) <= 0) return null;
    try { await engine.setConfig(HTTP_SHOWN_KEY, recordHttpShown(raw, client, new Date(opts.now ?? Date.now()).toISOString())); } catch { /* deliver anyway */ }
    return withTrustClaimAsk(engine, behaviorChangesNotice(await chainDisclosure(engine, opts.cfg), { remote: true, after }));
  } catch {
    if (key) handled.delete(key);
    return null;
  }
}
