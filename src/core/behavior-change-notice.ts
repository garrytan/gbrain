/**
 * One-time disclosure of four behavior changes an upgrade turns on (safety
 * notice `behavior_changes`, agent operator contract v1). Disclosure only:
 * every change stays on, nothing waits for an answer, and delivery is never
 * recorded as the user's consent.
 *
 *   (a) a non-empty `chat_fallback_chain` is walked on every non-pinned chat
 *       call, on errors and (unless `chat_fallback_on_refusal=false`) on
 *       refusals: the entries, the providers that receive traffic and the
 *       per-plane removal guidance. Only when a chain is set; a remote
 *       (HTTP) caller sees only that a chain is configured.
 *   (b) managed-brain autopilot lint writes its repairs
 *       (`gbrain config set cycle.lint_fix false` opts out).
 *   (c) transcript re-ingest makes smaller parts and re-embeds once
 *       (`TRANSCRIPT_REINGEST_MULTIPLIER`).
 *   (d) the mention linker rebuilds its resume state once.
 *
 * Identity: notice id (`behavior_changes@<BEHAVIOR_NOTICE_SINCE>`) × brain ×
 * channel, plus the authenticated client on HTTP. Eligibility: a brain that
 * predates BEHAVIOR_NOTICE_SINCE. Its baseline (the first gbrain version
 * that saw it, `0` when it already existed) is recorded once under
 * GBRAIN_HOME: `gbrain init` stamps a database it creates with this version;
 * otherwise the first look decides from the recorded upgrade history
 * (`upgrade-state.json` `from` below the release) or the brain's own
 * creation time (its oldest `sources.created_at` more than
 * FRESH_BRAIN_GRACE_MS ago). A fresh install sees no notice.
 *
 * Markers:
 *   - CLI and stdio: one file per notice × brain × channel under
 *     GBRAIN_HOME/notices/behavior-changes/, created exclusively (`wx`), so
 *     concurrent processes deliver it once. A home that cannot be written
 *     still gets the notice (once per process).
 *   - HTTP: one bounded `config` row in the brain DB
 *     (`notices.behavior_changes.http`: the notice id and up to
 *     HTTP_SHOWN_CAP client ids, oldest dropped first). No migration: the
 *     row reuses the key/value table every brain has.
 * `gbrain doctor --only behavior_changes` reads the disclosure again and
 * writes nothing.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from './engine.ts';
import type { Action, Notice } from './agent-output.ts';
import { gbrainPath, type GBrainConfig } from './config.ts';
import { VERSION } from '../version.ts';
import {
  CHAT_FALLBACK_PLANE_LABEL,
  chatFallbackRemovalFix,
  diagnoseChatFallbackEntry,
  readChatFallbackPlanes,
  type ChatFallbackPlane,
} from './ai/chat-fallback-planes.ts';
import { mergedProviderEnv } from './ai/provider-env.ts';

/** The first release that carries this notice. Set once, here, at ship time. */
export const BEHAVIOR_NOTICE_SINCE: string = VERSION;
/** The measured re-ingest page multiplier for (c), as prose (scripts/measure-transcript-split-cost.ts: 4 → 27 pages on a 1 MB session). */
export const TRANSCRIPT_REINGEST_MULTIPLIER = 'about 6.75x';
export const BEHAVIOR_NOTICE_CODE = 'behavior_changes';
export const BEHAVIOR_NOTICE_ID = `${BEHAVIOR_NOTICE_CODE}@${BEHAVIOR_NOTICE_SINCE}`;
/** A brain created this recently, with no recorded baseline, counts as a fresh install. */
export const FRESH_BRAIN_GRACE_MS = 60 * 60 * 1000;
export const HTTP_SHOWN_KEY = 'notices.behavior_changes.http';
export const HTTP_SHOWN_CAP = 500;
const CLIENT_ID_MAX = 128;
/** The baseline recorded for a brain that existed before baselines were kept. */
const PREDATES = '0';

export type BehaviorChannel = 'cli' | 'stdio' | 'http';

/** Release order over every numeric segment (`0.60.65.0` style; missing segments are 0). */
export function compareReleases(a: string, b: string): number {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function noticeDir(): string {
  return gbrainPath('notices', 'behavior-changes');
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');

/** Brain identity under GBRAIN_HOME: the brain id plus a hash of its database location (never the location itself). */
export function behaviorBrainKey(cfg: GBrainConfig | null | undefined, brainId = 'host'): string {
  const location = cfg?.database_url ?? cfg?.database_path ?? '';
  return `${safe(brainId)}-${createHash('sha256').update(location).digest('hex').slice(0, 12)}`;
}

let brainIdMemo: Promise<string> | null = null;

/** The brain id this process routes to (`--brain`, GBRAIN_BRAIN_ID, .gbrain-mount), `host` when unresolvable; resolved once per process. */
export function currentBrainId(): Promise<string> {
  brainIdMemo ??= (async () => {
    try {
      const { resolveBrainId } = await import('./brain-resolver.ts');
      const { getCliOptions } = await import('./cli-options.ts');
      return resolveBrainId(getCliOptions().brain);
    } catch {
      return 'host';
    }
  })();
  return brainIdMemo;
}

// ── eligibility ─────────────────────────────────────────────────────────────

const baselinePath = (brainKey: string) => join(noticeDir(), `${brainKey}.baseline`);

function readBaseline(brainKey: string): string | null {
  try {
    const v = readFileSync(baselinePath(brainKey), 'utf8').trim();
    return /^\d+(\.\d+)*$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Record a baseline; `exclusive` keeps an existing one (first writer wins). Never throws. */
function writeBaseline(brainKey: string, since: string, exclusive: boolean): void {
  try {
    mkdirSync(noticeDir(), { recursive: true });
    writeFileSync(baselinePath(brainKey), `${since}\n`, { mode: 0o600, flag: exclusive ? 'wx' : 'w' });
  } catch { /* unwritable home or a concurrent first writer: eligibility is re-derived next time */ }
}

/** `gbrain init` created this brain's database: it is a fresh install at this version. */
export function stampFreshBrainBaseline(brainKey: string): void {
  writeBaseline(brainKey, VERSION, false);
}

/** `gbrain upgrade` recorded an upgrade from a release older than this notice. */
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
 * Does this brain predate BEHAVIOR_NOTICE_SINCE? Reads the recorded baseline;
 * without one, derives it and (when `persist`) records it, so a fresh brain
 * stays fresh after the grace window. `persist: false` (doctor) writes nothing.
 */
export async function brainPredatesRelease(
  engine: BrainEngine | null,
  brainKey: string,
  opts: { persist: boolean; now?: number },
): Promise<boolean> {
  let since = readBaseline(brainKey);
  if (!since) {
    const now = opts.now ?? Date.now();
    const predates = upgradedAcrossRelease() || (engine !== null && await brainCreatedBefore(engine, now - FRESH_BRAIN_GRACE_MS));
    since = predates ? PREDATES : VERSION;
    if (opts.persist) {
      writeBaseline(brainKey, since, true);
      since = readBaseline(brainKey) ?? since;
    }
  }
  return compareReleases(since, BEHAVIOR_NOTICE_SINCE) < 0;
}

// ── content ─────────────────────────────────────────────────────────────────

export interface ChainDisclosure {
  plane: ChatFallbackPlane;
  entries: string[];
  providers: string[];
  onRefusal: boolean;
  filePath: string;
}

/** The effective chain as disclosed to the local owner, or null when no chain is set. Never throws. */
export async function chainDisclosure(engine: BrainEngine | null, cfg: GBrainConfig | null): Promise<ChainDisclosure | null> {
  try {
    const planes = await readChatFallbackPlanes(engine);
    if (!planes.effective) return null;
    const env = mergedProviderEnv(cfg, process.env);
    const providers = [...new Set(planes.effective.chain
      .map(entry => diagnoseChatFallbackEntry(entry, { env, userCapKeys: [] }).provider)
      .filter((p): p is string => !!p))];
    return { plane: planes.effective.plane, entries: planes.effective.chain, providers, onRefusal: planes.onRefusal.value, filePath: planes.filePath };
  } catch {
    return null;
  }
}

const DOCTOR_ARGV = ['gbrain', 'doctor', '--only', BEHAVIOR_NOTICE_CODE, '--json'];

/** The disclosure. `remote` (HTTP) names only that a chain is configured; entries and providers stay on the host. */
export function behaviorChangesNotice(chain: ChainDisclosure | null, opts: { remote?: boolean } = {}): Notice {
  const items: string[] = [];
  if (chain && opts.remote) {
    items.push('A chat fallback chain is configured on this brain host: when a chat call\'s own model fails it is retried on other models. Its entries and providers are visible to the brain host operator in gbrain doctor --only chat_fallback_chain.');
  } else if (chain) {
    items.push(`chat_fallback_chain is live (set in ${CHAT_FALLBACK_PLANE_LABEL[chain.plane]}): when a chat call's own model fails${chain.onRefusal ? ' or refuses' : ''}, gbrain retries it on ${chain.entries.join(', ')}, so ${chain.providers.length ? chain.providers.join(', ') : 'those providers'} receive that traffic. ` +
      (chain.onRefusal
        ? 'It falls back on refusals as well as errors, so content one provider refused is sent to the next; `gbrain config set chat_fallback_on_refusal false` keeps outage fallback only.'
        : 'chat_fallback_on_refusal is false, so it falls back on errors only.') +
      ' Removing the chain is optional; ask the user (gbrain doctor --only chat_fallback_chain has the per-plane steps).');
  }
  items.push('On a managed brain, autopilot\'s lint phase now writes its repairs instead of only reporting them; `gbrain config set cycle.lint_fix false` turns that off.');
  items.push(`Transcript re-ingest now splits transcripts into smaller parts (45,000-byte target, previously 300,000 bytes): ${TRANSCRIPT_REINGEST_MULTIPLIER} as many part pages and about 9% more embedding tokens (measured on a 1 MB session), and each re-ingested transcript re-embeds once.`);
  items.push('The mention linker rebuilds its gazetteer resume state once, so the first mention-extraction run after upgrading rescans pages.');
  const why = `gbrain v${BEHAVIOR_NOTICE_SINCE} changed ${items.length} behaviors on this brain. All stay on; this is a one-time disclosure, not a request for consent. ` +
    items.map((t, i) => `(${i + 1}) ${t}`).join(' ') +
    ' gbrain doctor --only behavior_changes shows this again.';
  const fix: Action = chain && !opts.remote
    ? chatFallbackRemovalFix(chain.plane, chain.filePath)
    : { argv: DOCTOR_ARGV, consent: [], actor: opts.remote ? 'host_admin' : 'agent', requires_exclusive: false,
      why: 'Shows this disclosure again; read-only.', docs: 'docs/guides/chat-fallback.md' };
  return { code: BEHAVIOR_NOTICE_CODE, kind: 'safety', why, fix };
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

/** Claim the per-channel marker. `unwritable` still delivers (conservative). */
function claimMarker(brainKey: string, channel: 'cli' | 'stdio'): 'claimed' | 'shown' | 'unwritable' {
  const path = join(noticeDir(), `${safe(BEHAVIOR_NOTICE_ID)}.${brainKey}.${channel}.shown`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${new Date().toISOString()}\n`, { mode: 0o600, flag: 'wx' });
    return 'claimed';
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EEXIST' ? 'shown' : 'unwritable';
  }
}

/** Has this channel's marker been written for this brain? (doctor; read-only) */
export function behaviorNoticeShown(brainKey: string, channel: 'cli' | 'stdio'): boolean {
  try {
    readFileSync(join(noticeDir(), `${safe(BEHAVIOR_NOTICE_ID)}.${brainKey}.${channel}.shown`));
    return true;
  } catch {
    return false;
  }
}

/**
 * CLI and stdio: the notice once per notice × brain × channel, or null.
 * Never throws; a fault returns null and the next call looks again.
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
    if (!(await brainPredatesRelease(engine, brainKey, { persist: true, now: opts.now }))) return null;
    if (claimMarker(brainKey, channel) === 'shown') return null;
    return behaviorChangesNotice(await chainDisclosure(engine, opts.cfg));
  } catch {
    if (key) handled.delete(key);
    return null;
  }
}

interface HttpShown { id: string; clients: Record<string, string> }

function readHttpShown(raw: string | null): HttpShown {
  try {
    const v = raw ? JSON.parse(raw) as Partial<HttpShown> : null;
    if (v && v.id === BEHAVIOR_NOTICE_ID && v.clients && typeof v.clients === 'object') return { id: v.id, clients: v.clients };
  } catch { /* unreadable: start over */ }
  return { id: BEHAVIOR_NOTICE_ID, clients: {} };
}

/** Add a client, keeping the newest HTTP_SHOWN_CAP. */
export function recordHttpShown(raw: string | null, clientId: string, at: string): string {
  const shown = readHttpShown(raw);
  shown.clients[clientId] = at;
  const kept = Object.entries(shown.clients).sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0)).slice(0, HTTP_SHOWN_CAP);
  return JSON.stringify({ id: BEHAVIOR_NOTICE_ID, clients: Object.fromEntries(kept) });
}

/**
 * HTTP: the notice once per authenticated client (remote view: no entries or
 * providers). The per-client record lives in the brain's `config` table; a
 * failed write still delivers. Never throws.
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
    if (!(await brainPredatesRelease(engine, brainKey, { persist: true, now: opts.now }))) return null;
    const raw = await engine.getConfig(HTTP_SHOWN_KEY).catch(() => null);
    if (readHttpShown(raw).clients[client]) return null;
    try { await engine.setConfig(HTTP_SHOWN_KEY, recordHttpShown(raw, client, new Date(opts.now ?? Date.now()).toISOString())); } catch { /* deliver anyway */ }
    return behaviorChangesNotice(await chainDisclosure(engine, opts.cfg), { remote: true });
  } catch {
    if (key) handled.delete(key);
    return null;
  }
}
