/**
 * One-time disclosure of the behavior changes an upgrade turns on (safety
 * notice `behavior_changes`, agent operator contract v1). Disclosure only:
 * every change stays on, nothing waits for an answer, and delivery is never
 * recorded as the user's consent.
 *
 * BEHAVIOR_CHANGES is the one table of disclosed changes, each with the
 * release that introduced it:
 *   0.60.68.0  a non-empty `chat_fallback_chain` is walked on every non-pinned
 *              chat call (only when a chain is set; a remote (HTTP) caller
 *              sees only that a chain is configured), managed-brain autopilot
 *              lint writes its repairs, transcript re-ingest makes smaller
 *              parts, the mention linker rebuilds its resume state once.
 *   0.60.74.0  fix wave 9: shell jobs reap leftover processes, the
 *              declaring-pack extract_atoms auto-drain, the 90-day OAuth
 *              access-token cap, the writer-status `local_process_ingress`
 *              rename, `jobs work` exit codes, the longer retention of
 *              unextracted corpus files.
 *   0.60.77.0  quote grounding on by default (think, syntheses, concepts,
 *              patterns); forget's `similar_active` and the TypeSafe-gated
 *              overnight withdrawal review.
 *   0.60.87.0  the save-before-compaction notice in Claude Code and OpenClaw
 *              sessions (core memory ships off, so it is not a change).
 * A release that changes behavior appends its rows; a shipped row's release
 * never changes.
 *
 * Identity: notice id (`behavior_changes@<BEHAVIOR_NOTICE_SINCE>`, the newest
 * row's release, never the running VERSION) × brain × channel, plus the
 * authenticated client on HTTP. A release with no new rows re-notifies
 * nobody. Content: only the rows introduced after the last notice release
 * this brain × channel (× client) was shown, or after the brain's baseline
 * when it was never shown one. The baseline (the first gbrain version that
 * saw it, `0` when it already existed) is recorded once under GBRAIN_HOME:
 * `gbrain init` stamps a database it creates with this version; otherwise
 * the first look decides from the recorded upgrade history
 * (`upgrade-state.json` `from` below the newest row) or the brain's own
 * creation time (its oldest `sources.created_at` more than
 * FRESH_BRAIN_GRACE_MS ago). A fresh install sees no notice.
 *
 * Markers:
 *   - CLI and stdio: one file per notice × brain × channel under
 *     GBRAIN_HOME/notices/behavior-changes/, created exclusively (`wx`), so
 *     concurrent processes deliver it once; the newest marker names the last
 *     release shown. A home that cannot be written still gets the notice
 *     (once per process).
 *   - HTTP: one bounded `config` row in the brain DB
 *     (`notices.behavior_changes.http`: up to HTTP_SHOWN_CAP client ids, each
 *     with the release it was shown, oldest dropped first). No migration: the
 *     row reuses the key/value table every brain has.
 * `gbrain doctor --only behavior_changes` reads every row newer than the
 * brain's baseline again and writes nothing.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** The measured re-ingest page multiplier, as prose (scripts/measure-transcript-split-cost.ts: 4 → 27 pages on a 1 MB session). */
export const TRANSCRIPT_REINGEST_MULTIPLIER = 'about 6.75x';
export const BEHAVIOR_NOTICE_CODE = 'behavior_changes';
/** A brain created this recently, with no recorded baseline, counts as a fresh install. */
export const FRESH_BRAIN_GRACE_MS = 60 * 60 * 1000;
export const HTTP_SHOWN_KEY = 'notices.behavior_changes.http';
export const HTTP_SHOWN_CAP = 500;
const CLIENT_ID_MAX = 128;
/** The baseline recorded for a brain that existed before baselines were kept. */
const PREDATES = '0';
const RELEASE = /^\d+(\.\d+)*$/;

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
    return RELEASE.test(v) ? v : null;
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

const laterRelease = (a: string, b: string) => (compareReleases(a, b) >= 0 ? a : b);

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

type ChangeText = string | ((chain: ChainDisclosure | null, remote: boolean) => string | null);

/** Every disclosed behavior change, with the release that introduced it. Append new rows; never edit a shipped `since`. */
export const BEHAVIOR_CHANGES: ReadonlyArray<{ since: string; text: ChangeText }> = [
  { since: '0.60.68.0', text: (chain, remote) => {
    if (!chain) return null;
    if (remote) return 'A chat fallback chain is configured on this brain host: when a chat call\'s own model fails it is retried on other models. Its entries and providers are visible to the brain host operator in gbrain doctor --only chat_fallback_chain.';
    return `chat_fallback_chain is live (set in ${CHAT_FALLBACK_PLANE_LABEL[chain.plane]}): when a chat call's own model fails${chain.onRefusal ? ' or refuses' : ''}, gbrain retries it on ${chain.entries.join(', ')}, so ${chain.providers.length ? chain.providers.join(', ') : 'those providers'} receive that traffic. ` +
      (chain.onRefusal
        ? 'It falls back on refusals as well as errors, so content one provider refused is sent to the next; `gbrain config set chat_fallback_on_refusal false` keeps outage fallback only.'
        : 'chat_fallback_on_refusal is false, so it falls back on errors only.') +
      ' Removing the chain is optional; ask the user (gbrain doctor --only chat_fallback_chain has the per-plane steps).';
  } },
  { since: '0.60.68.0', text: 'On a managed brain, autopilot\'s lint phase now writes its repairs instead of only reporting them; `gbrain config set cycle.lint_fix false` turns that off.' },
  { since: '0.60.68.0', text: `Transcript re-ingest now splits transcripts into smaller parts (45,000-byte target, previously 300,000 bytes): ${TRANSCRIPT_REINGEST_MULTIPLIER} as many part pages and about 9% more embedding tokens (measured on a 1 MB session), and each re-ingested transcript re-embeds once.` },
  { since: '0.60.68.0', text: 'The mention linker rebuilds its gazetteer resume state once, so the first mention-extraction run after upgrading rescans pages.' },
  { since: '0.60.74.0', text: 'A shell job\'s leftover processes (`cmd &` with no `wait`) are now terminated when the job ends; start long-lived processes under a service manager or detach them with `setsid`.' },
  { since: '0.60.74.0', text: 'On Postgres autopilot, a brain whose schema pack declares extract_atoms now gets the daily atom auto-drain, spending within autopilot.auto_drain.max_usd_per_day (default $2); `gbrain config set autopilot.auto_drain.enabled false` opts out.' },
  { since: '0.60.74.0', text: 'OAuth access tokens now last at most 90 days: stored client lifetimes were clamped and already-issued access tokens shortened to 90 days after issue, so a client with no refresh token reconnects; restart any running `gbrain serve --http`.' },
  { since: '0.60.74.0', text: '`gbrain sources writer status --json` renamed `ingress` to `local_process_ingress`; it describes only the process that answered.' },
  { since: '0.60.74.0', text: '`gbrain jobs work` exits 0 after a SIGTERM drain (was 143) and 17 when running claims had to be handed back.' },
  { since: '0.60.74.0', text: 'Captured session files nothing has extracted are kept up to 3x dream.synthesize.corpus_retention_days (90 days by default, was 30), so the corpus directory can use more disk; `gbrain sweep --once --budget-ms 600000` clears that backlog.' },
  { since: '0.60.77.0', text: 'think answers, saved syntheses, concept narratives and pattern pages check their quotes against their sources: a quote found nowhere loses its quotation marks and is marked [unverified]. It is not yet measured as a catch for made-up quotes. `gbrain config set think.quote_verify false` and `gbrain config set dream.quote_verify false` turn it off.' },
  { since: '0.60.77.0', text: 'forget responses list close active facts it did not withdraw (`similar_active`); with a TypeSafe key, forgetting also queues an overnight review that only proposes withdrawing rewordings (`gbrain decide proposals list`; `gbrain config set decide.slots.conflict.review_withdraw false` turns it off).' },
  { since: '0.60.78.0', text: 'On a brain with embedding turned off, search, query, recall, think and fact writes no longer send text to an embedding provider: reads run keyword-only and say so, and `gbrain doctor --json` names the enable command if the user wants semantic search back.' },
  { since: '0.60.79.0', text: 'Frontmatter is parsed as YAML 1.2: clock-like values such as `10:30` stay text (they were read as base-60 numbers, so 10:30 became 630), a leading zero is decimal (`010` is 10, not 8), `0o` marks octal, and `1_000` stays text. Re-syncing a page whose frontmatter used those forms stores the new values.' },
  { since: '0.60.87.0', text: 'Near automatic context compaction, Claude Code and OpenClaw sessions get one notice per compaction segment asking the agent to save what it needs with `remember` (up to 20 facts per call). In the held-out test it raised accuracy after compaction from 51.7% to 63.0% and cost about 28% more per question (5% more per correct answer). `gbrain config set memory.pressure.enabled false` turns it off. Always-loaded core memory is new and off; `gbrain config set memory.core.enabled true` turns it on.' },
  { since: '0.60.88.0', text: '`think` now answers with the current date (in `brain.timezone`) and each page\'s content date, so relative words like "last month" resolve against today and dates inside a page against that page. In the held-out test it raised accuracy from 74.2% to 88.2% with unchanged latency. Pass `reference_date` (MCP) or `--reference-date` (CLI) to answer as of another day.' },
  { since: '0.60.93.0', text: 'Links to pages that do not exist yet are now kept instead of dropped, including links in remote agents\' writes: `gbrain wanted` (MCP `wanted_pages`) lists them, most-linked first, and the edge appears once the page is created. Existing pages are re-extracted once to fill the list. In the held-out test no edge was lost and every withheld entity was listed. `gbrain config set wanted_pages.enabled false` turns it off.' },
];

/** The newest disclosed change's release: the notice id moves only when a release adds rows. */
export const BEHAVIOR_NOTICE_SINCE: string = BEHAVIOR_CHANGES.reduce((v, c) => laterRelease(v, c.since), PREDATES);
export const BEHAVIOR_NOTICE_ID = `${BEHAVIOR_NOTICE_CODE}@${BEHAVIOR_NOTICE_SINCE}`;

/**
 * The disclosure of the changes introduced after release `after` (default:
 * all of them), grouped by release; null when none apply. `remote` (HTTP)
 * names only that a chain is configured; entries and providers stay on the host.
 */
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
  const releases = [...byRelease.keys()].map(v => `v${v}`);
  const count = [...byRelease.values()].reduce((n, texts) => n + texts.length, 0);
  let n = 0;
  const why = `gbrain ${releases.length > 1 ? `${releases.slice(0, -1).join(', ')} and ${releases.at(-1)}` : releases[0]} changed ${count} behavior${count === 1 ? '' : 's'} on this brain. All stay on; this is a one-time disclosure, not a request for consent. ` +
    [...byRelease].map(([since, texts]) => (byRelease.size > 1 ? `v${since}: ` : '') + texts.map(t => `(${++n}) ${t}`).join(' ')).join(' ') +
    ' gbrain doctor --only behavior_changes shows this again.';
  const fix: Action = chain && namesChain && !opts.remote
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
    return behaviorChangesNotice(await chainDisclosure(engine, opts.cfg), { after });
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
    return behaviorChangesNotice(await chainDisclosure(engine, opts.cfg), { remote: true, after });
  } catch {
    if (key) handled.delete(key);
    return null;
  }
}
