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
import { FENCE_REPAIR_MEASURED } from './fence-repair/measured.ts';
import { CONTENT_REPAIR_MEASURED } from './content-repair/measured.ts';

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
  { since: '0.60.94.0', text: 'Fact extraction, dream synthesis, atom extraction and take proposals now rewrite relative dates ("last week", "3 days ago") as the actual date, resolved against when the text was written. In the held-out test, saved facts with an unresolved relative date fell from 9% to 2% with no loss in answer accuracy. Facts saved earlier keep their wording. `gbrain config set extraction.date_grounding false` turns it off.' },
  { since: '0.60.94.0', text: 'Saved facts now record who said them (you, the assistant or someone else), so an assistant recommendation is no longer saved as your plan; recall shows the speaker. In the held-out test, answers about what the assistant said rose from 44% to 96%. Expect about 41% more saved facts on assistant-heavy conversations. `gbrain config set facts.attribution false` turns it off.' },
  { since: '0.60.94.0', text: 'Facts extracted from a dated page (a meeting or daily note) are stored at the page date instead of the sync time.' },  { since: '0.60.97.0', text: 'A put_page of a new slug ending in `.md` or `.mdx` is refused with `invalid_params` naming the bare slug; a page that already exists under such a slug still updates and its response carries `slug_advisory`.' },
  { since: '0.60.97.0', text: '`gbrain config set` refuses an unregistered `search.*` or `content_sanity.*` key (exit 2) and names the nearest registered key; `--force` still writes it.' },
  { since: '0.60.97.0', text: '`gbrain transcripts ingest --facts` exits 1 when any page fails fact extraction, and `gbrain doctor --remediate` exits 1 when a repair preview failed; a plan approved while a preview failed refuses with `preview_changed` once that preview succeeds.' },
  { since: '0.60.97.0', text: 'With `facts.default_visibility` set to `world`, facts extracted from conversations are written world-visible; they were always private before.' },
  { since: '0.60.97.0', text: 'The take sanitizer no longer redacts the name or word "dan"; the uppercase acronym DAN, "dan mode" in any case and "do anything now" are still redacted.' },
  { since: '0.60.97.0', text: 'Google Calendar sync writes only events between `historyDays` back and 60 days ahead; `gbrain sync --full` removes pages for in-window events the calendar no longer lists (more than 200 is refused and reported partial).' },
  { since: '0.60.98.0', text: 'Managed sync now holds a file whose facts or takes fence cannot be imported (code `invalid_fence`; `gbrain sources status <id>` names the fence, section and rows) instead of blocking the whole source, and a source such a fence blocked before recovers on its next sync. Coordinated writes refuse such a fence with `invalid_fence` (wire `error` stays `invalid_params`, or `take_row_collision`). `gbrain config set sync.holds fail` keeps fail-closed blocking.' },
  { since: '0.60.99.0', text: 'Fixable facts and takes fences are now rewritten instead of held or refused: managed sync, put_page and the fact and take writers normalize a fence whose meaning is unambiguous (a missing end marker after the table, two-dash takes markers, zero or duplicate row numbers, header aliases, invented kinds and enum synonyms, assistant holders, percent confidences) without changing a claim or an existing row number, and managed sync commits the rewritten file. Results report `fences_normalized`; `gbrain sync --dry-run` lists `would_normalize`. `gbrain config set fences.normalize false` turns it off (such fences are then held or refused).' },
  { since: '0.60.100.0', text: '`gbrain doctor` has a new `fence_integrity` check: it counts malformed facts and takes fences still waiting (held files, stored pages, unsynced checkout files) by the tier that would fix them, and warns when a source had 20 or more fences normalized in 7 days. Each doctor run scans stored pages and source checkouts for up to 10 seconds (`GBRAIN_DOCTOR_FENCE_TIMEOUT_MS`) and resumes where it stopped; until a scan finishes the check reports partial instead of ok. New settings `fences.repair.max_usd_per_page` (0.05) and `fences.repair.max_usd_per_day` (1.00) cap model fence repair.' },
  { since: '0.60.102.0', text: `Malformed facts and takes fences are now repaired automatically: the maintenance run repairs held files and stored pages on the owner host, and its first run after upgrading repairs every malformed fence it finds in each source, rewriting and committing those files (\`gbrain doctor --only fence_integrity\` counts them; \`gbrain repair fences\` previews the plan). A fence only a rewrite can realign sends just its header and those rows, never the rest of the page, to the repair model, within $0.30 per page and $1.00 per day (\`fences.repair.max_usd_per_page\`, \`fences.repair.max_usd_per_day\`); every rewrite passes validation gates before it is written. With \`models.fence_repair\` unset, the repair model is the first model the fence-repair eval measured as accurate enough that has a provider key on the brain host (\`gbrain models\` names it); with none, model repair stays off until the user sets \`models.fence_repair\`. ${FENCE_REPAIR_MEASURED} \`gbrain config set fences.repair.llm false\` keeps fence rows away from the model; \`gbrain config set fences.repair.enabled false\` pauses automatic repair. On a managed source each repaired file is committed, so \`git revert\` undoes it (page history keeps the earlier version); turning these settings off stops future repairs and does not undo past ones.` },
  { since: '0.60.105.0', text: '`gbrain pages purge-deleted`, `cache clear|prune`, `schema use|downgrade|init|remove-*`, `integrity auto|reset-progress` and `search modes --reset` refuse an argument they would ignore (exit 2), and `--help` never runs them; preview with `gbrain pages purge-deleted --dry-run --json`.' },
  { since: '0.60.105.0', text: '`gbrain pages purge-deleted` asks first: without a terminal it exits 3 with an ask_user payload naming the `--yes` command. `gbrain call purge_deleted_pages` asks the same way; the top-level `gbrain purge-deleted` is gone.' },
  { since: '0.60.105.0', text: '`gbrain apply-migrations` exits 1 (`migrations_pending`) when it leaves the schema behind; run `gbrain apply-migrations --yes`, then `gbrain doctor --json` if that fails.' },
  { since: '0.60.105.0', text: 'Remote put_page and put_pages content with no Timeline section is refused (`timeline_rows_would_be_removed`) when it would delete dated rows; keep the section or pass `drop_timeline: true`.' },
  { since: '0.60.105.0', text: '`gbrain schema active --json` exits nonzero on `unknown_source` or `database_error`; check `gbrain sources list --json`.' },
  { since: '0.60.105.0', text: '`gbrain waiting --json` and `open_loops`: loops with no counterparty move to `no_counterparty`, and each group lists at most 5 loops (`loops_omitted` counts the rest).' },
  { since: '0.60.105.0', text: 'Frontmatter validation and `--fix` no longer flag or rewrite valid YAML (a block-scalar line shaped like `Key: "a", then "b"`); a file an earlier `gbrain frontmatter validate --fix` rewrote can be restored from its backup under ~/.gbrain/backups/frontmatter/.' },
  { since: '0.60.105.0', text: 'Facts the sweep extracts from a saved session file are dated when the file was written, not when the sweep ran; facts saved earlier keep their dates.' },
  { since: '0.60.105.0', text: 'Link extraction no longer types a link to a person, meeting or calendar page as `works_at` (or a meeting/calendar link as `founded`/`invested_in`) from a nearby role phrase; it becomes `mentions`. Existing edges change on re-extraction: `gbrain extract --stale`.' },
  { since: '0.60.105.0', text: 'In-cycle dream patterns runs are sized to the cycle budget from the last run\'s recorded cost (`dream.patterns.last_run`): a first run submits at most 25 reflections, and a run that cannot fit `min_evidence` reflections is skipped as `insufficient_cycle_budget` before any spend; `gbrain dream --phase patterns` still runs at full size.' },
  { since: '0.60.105.0', text: 'An explicit `memory.auto_writeback off` now stops every ambient capture lane: the compaction harvest (PreCompact segments and OpenClaw compactions) and SessionEnd transcripts stop extracting too, and session text banked under off is never extracted later, even after writeback is turned back on. Unset keeps both lanes running. An unreadable, drifted or unrecognized setting now holds them instead of extracting. Restart `gbrain serve`, cron or autopilot sweeps and OpenClaw gateways started on an older version; `gbrain bootstrap harness --remove` stops the hooks from banking session text at all.' },
  { since: '0.60.105.0', text: 'On a managed canonical worktree the session hooks no longer start `gbrain sources push` (it refuses there; heartbeat reason `push_managed_coordinator`), backup check no longer counts gbrain\'s `.gbrain-owner.json` as uncommitted work and points managed roots at `gbrain sources writer status --probe --json`, a root with no origin remote reads `no_remote` even after a recorded push refusal, and doctor `bootstrap_push_health` reports ok once a recorded push failure\'s tree matches its origin branch.' },
  { since: '0.60.105.0', text: 'The MCP initialize instructions are reordered so harnesses that read only the first 2,048 characters (Claude Code) get the essentials: with ambient writeback on, a one-line writeback contract now sits in the memory clause (the full rules stay last), the error protocol follows the data-not-instructions clause in a shorter form, and the forget caveat moved after the scope clause.' },
  { since: '0.60.105.0', text: '`gbrain skillpack scaffold --harness` prints its Update lens and remove hints with the `--dest`, `--scope` and `--workspace` you passed, and `gbrain skillpack reference --harness <h>` with no slug no longer exits 2 on the shared-dependency ledger entry.' },
  { since: '0.60.105.0', text: 'On a managed brain, doctor `pack_upgrade_available` is now an info row with a read-only preview instead of an apply step it could not run, and `unify-types` apply switches the pack when nothing needs retyping (it still refuses, now naming the counts, when pages would change).' },
  { since: '0.60.105.0', text: '`gbrain bootstrap harness --remove` now also deletes Claude Code hook entries that lost their `_gbrain` marker when their command is exactly what this install wrote, and lists each one it removed; a lookalike it did not write is left in place and removal exits 1 with `harness_hook_unowned`. Re-running the install converges to one entry per event instead of adding a second set. `gbrain bootstrap harness --remove --dry-run` previews the removal without writing anything.' },
  { since: '0.60.105.0', text: '`gbrain repair <kind> --apply` and `gbrain doctor --remediate` now wait for each publication with the CLI write wait (`--wait`, `GBRAIN_WRITE_WAIT_MS`, `persistence.write_wait_ms`, else 30 s) instead of 5 s, so one run repairs a slow source; `--wait 0` stops at the first pending write and the rerun resumes.' },
  { since: '0.60.105.0', text: '`gbrain sources reconcile` now identifies a private fact row by its row number and claim, so a page whose world row shares a private row\'s claim publishes instead of being refused; it now also refuses a world row that copies a stored private row\'s context (24 or more characters) verbatim, naming only the row number.' },
  { since: '0.60.105.0', text: '`gbrain repair failed-writes` now replays subagent and restricted-namespace writes (they were all refused "via subagent requires ctx.subagentId"), under the original writer\'s stored authority re-checked against its live grant; replayed writes are attributed to that original writer.' },
  { since: '0.60.105.0', text: 'Inline `[Source: ..., date]` citations no longer file an adjacent HTML comment (such as `<!-- AUTO:slack END -->`) as a timeline entry, and a timeline row carrying comment markup is never written back into a page (it would duplicate a section END marker); `gbrain repair timeline-comments --source <id>` previews and cleans rows and bullets stored before this release.' },
  { since: '0.60.105.0', text: 'On a managed brain, `gbrain files upload-raw` of a small file now refuses before creating anything (it used to leave an empty `.raw/` directory); configure a storage backend and use `gbrain files upload <file> --page <slug>`.' },
  { since: '0.60.105.0', text: 'A managed write that fails on an unexpected owner exception keeps its class, errno and source frame owner-only (the public `storage_error` message stays generic), the owner log line names the class and source frame, and `gbrain write-request <id>` (`owner_build`) says when the owner that ran it is on another build than the CLI and needs a restart.' },
  { since: '0.60.105.0', text: 'Doctor\'s new `persistence_write_stall` check warns when a managed write has held its claim longer than `persistence.max_claim_ms` (default 10 minutes) and names the stuck phase; `gbrain sources writer status --json` shows each running request\'s `claim` phase.' },
  { since: '0.60.105.0', text: 'On a brain whose managed persistence was never activated, `gbrain sources writer deactivate` now releases sources claimed before activation (the dry run lists them as `pre_activation_claims`), so classic `gbrain sync` of them works again; `gbrain sources writer deactivate --dry-run --json` previews it.' },
  { since: '0.60.105.0', text: 'Writer transfer, `gbrain sources set-path` and reclone now compare only the files Git tracks in a Git checkout, so ignored files such as `.env.local` are never read or need copying and a clean `git clone` verifies; a transfer prepared before this release is prepared again (`writer_manifest_rescope_required`), and upgrading drops the per-file path and hash maps older releases stored.' },
  { since: '0.60.105.0', text: 'A managed sync import that races a database-only write to the same page is now held with code `concurrent_write` (the sync finishes, the database version is kept) instead of leaving the source `blocked_by_failures`; `gbrain sources reconcile <source> <slug> --preview` resolves it.' },
  { since: '0.60.105.0', text: 'Hybrid search on CJK text now falls back to matching any query term when matching all terms finds too few rows (all-term matches still rank first), and its CJK keyword arm has one time budget, `search.cjk_keyword_deadline_ms` (default 3000); a cut arm reports degraded `keyword_candidates_incomplete`, so narrow with `--source-id` or raise the key.' },
  { since: '0.60.105.0', text: 'Filtered vector search on Postgres runs pgvector iterative scans in relaxed_order, which keeps closer in-filter matches strict order dropped; `gbrain config set search.hnsw_iterative_scan strict_order` and a restart of serve and autopilot restore the old mode.' },
  { since: '0.60.105.0', text: 'With retrieval feedback on, MCP search and query results carry one visible line with the answer id (`Rate after use: rate_answer { answer_id: "ans_…", rating: 1-5 }`), so hosts that hide `_meta` can still rate.' },
  { since: '0.60.105.0', text: 'Imported transcript pages now also redact a password typed after a credential label (`password: …`, `login alice / …`) as `<REDACTED:labeled_credential>`; pages imported earlier are not rewritten, so run `gbrain transcripts audit-secrets --json` to list them (doctor `transcript_secret_exposure`).' },
  { since: '0.60.106.0', text: 'A managed Git effect whose durability check fails (a git timeout, a damaged checkout, an unreadable hook) now stays queued with `git_unavailable` and retries instead of completing as `durability_not_enabled` without a commit or push; only a directory with no Git checkout at or above it reads as not durable. Check with `gbrain sources writer status --json`.' },
  { since: '0.60.106.0', text: '`gbrain embed --stale` and the embed-backfill job no longer stop when some pages still need a text projection: everything else embeds, and the blocked pages (often image pages) are counted and named with `gbrain embed --stale --images` or `gbrain sync --full`.' },
  { since: '0.60.106.0', text: '`gbrain sources reconcile` no longer refuses a page whose file name more than 100 other pages share; upgrading builds two indexes on `pages` (online on Postgres) for that check.' },
  { since: '0.60.106.0', text: 'A pending write\'s `poll_command` is now `gbrain write-request --brain <id> -- <request_id>`, the same command as the error\'s `fix`, instead of `gbrain call get_write_request ...`.' },
  { since: '0.60.106.0', text: '`gbrain quarantine clear` works on a managed brain, and `--force` records `quarantine_override` in the page frontmatter so the page stays cleared until its title, type or body changes; `quarantine scan --apply` refuses on a managed brain. Preview with `gbrain quarantine list`.' },
  { since: '0.60.106.0', text: 'An inline `[Source: A, date; B, date]` citation now files one timeline entry per dated source instead of one entry with the last date, and timeline summaries drop paired `**`, `__`, `*` and `_` emphasis markers. Rows stored under the older reading are deleted the next time their page is written or extracted, never written back into the page; a row someone gave its own detail stays. Pages nobody edits keep the old rows until the timeline prune-orphans cleanup runs (see `gbrain extract timeline --help`).' },
  { since: '0.60.106.0', text: '`gbrain edge-proposals list` now reads `--limit=N` and `--status=X` (they were ignored), and a `--limit` that is not a whole number from 1 up exits 2 instead of failing in the database or silently becoming 1.' },
  { since: '0.60.106.0', text: 'Dream atom and concept extraction no longer accept a model answer that stopped at the output cap or was refused (claude-cli included): such an answer counts as a failure, never as "nothing to extract" or a new concept narrative. On a managed brain the failed atom batch keeps the page\'s earlier atoms and waits for an approved retry (`gbrain jobs submit extract-atoms-drain --params \'{"sourceId":"<id>","retryRequestId":"<request>"}\'`); a concept that fails 3 times on unchanged atoms is skipped until they change (`gbrain config unset dream.concepts.failed_attempts` retries it now).' },
  { since: '0.60.106.0', text: 'The dream patterns breaker now counts deaths per source (`dream:patterns:source:<id>`), including runs cancelled at their timeout after paid work, so a brain whose patterns runs keep dying is refused at once after the upgrade; fix the cause, then `gbrain dream reset-key \'dream:patterns:source:<id>\'`. Pattern pages store a quarantined claim\'s reflection list once per page (`unverified_claim_sources`); the first patterns run rewrites existing pages that way (frontmatter only, no model call) before it pays for a run.' },
  { since: '0.60.106.0', text: 'Dream triage no longer re-judges a transcript every cycle after a truncated, refused or unparseable verdict: it waits 24 hours, doubling per repeat up to 7 days (`triage_unreliable_backoff`), and a content or triage-model change re-judges at once; `gbrain dream retriage --force` re-judges now and pays per file.' },
  { since: '0.60.106.0', text: 'A `gbrain dream` scoped to a source, including a bare `gbrain dream` on the default source, now also takes the brain-wide `gbrain-cycle` lease for synthesize, patterns, embed and the other brain-wide phases: while autopilot maintenance holds it, those phases are skipped as `maintenance_lock_busy` and the source phases still run, and autopilot maintenance skips its window while a dream holds it. `gbrain status --section locks --json` shows the holder.' },
  { since: '0.60.106.0', text: '`gbrain onboard --auto` (including cron runs), `doctor --remediate` and MCP `run_onboard` never submit a manual-only step: the schema-pack upgrade (`unify-types`) and the paid takes bootstrap (`extract-takes-from-pages`) are listed under `manual_only_skipped` with the command to run them yourself. A job of either kind an earlier run already queued still runs: find it with `gbrain jobs list --status waiting` and cancel it with `gbrain jobs cancel <id>` if you did not want it.' },
  { since: '0.60.106.0', text: '`gbrain reindex --markdown` asks before re-embedding (paid): without a terminal it exits 3 with an ask_user payload naming the page count, the estimate and the `--yes` command; `--yes` or `--max-usd <usd>` approves it, and `--dry-run`, `--no-embed` and a keyless brain never ask. A queued `reindex` job re-embeds only with the approval stored at submit time (`gbrain jobs submit reindex ... --yes`, or the search-mode switch prompt); one queued without it fails with `confirmation_required`.' },
  { since: '0.60.107.0', text: 'Search-hiding and other gate-owned frontmatter keys (`quarantine`, `content_flag`, `embed_skip`, `atoms_scan_hash`, `quarantine_override`) in a local `put_page`, a connector, an ingest event or any other non-owner write are now stripped instead of kept; sync and import of your own files, reindex, repair and `gbrain quarantine clear` keep them.' },
  { since: '0.60.107.0', text: 'A quarantined page is no longer offered to automatic fact extraction (`facts_backstop.skipped: quarantined`) and its facts and takes fences are not projected; rows projected before it was quarantined stay.' },
  { since: '0.60.107.0', text: '`get_page` and `fetch` of a quarantined page carry `quarantined` (fetch: `metadata.quarantined`) and a `page_quarantined` notice, and remote callers get no body or text unless an admin-scoped caller passes `include_quarantined: true`; a quarantined `put_page` now reports `quarantined: { reason, detail }`.' },
  { since: '0.60.108.0', text: 'Managed brains now extract conversation facts from meetings, transcripts and email threads through receipted batch requests (up to 25 pages each), and record single emails, prose notes and undated pages as not extractable for good. Nothing runs on its own: preview with `gbrain extract-conversation-facts --source-id <id> --dry-run`. A run stops with `maintenance_backpressure` (exit 12) before the writer passes 80% of its request or receipt capacity; `gbrain sources writer status --json` shows it.' },
  { since: '0.60.108.0', text: 'Re-extracting a conversation page now keeps facts that an open loop or a superseding fact references, as expired history, instead of deleting them.' },
  { since: '0.60.108.0', text: 'Take numbers are never reused: `gbrain takes remove` leaves a struck `(removed)` row in the page, and a new take gets one more than every facts or takes row number on the page, so the first take on a page whose facts fence holds rows 1-5 is #6. Deleting the placeholder by hand frees its number again.' },
  { since: '0.60.108.0', text: 'On an unmanaged brain a dream-cycle concept whose file holds an edit the database has not imported is deferred (`revision_conflict`) and published after sync imports it, instead of being overwritten.' },
  { since: '0.60.108.0', text: 'A job error during worker shutdown now records `worker_shutdown: <handler error>` instead of bare `worker_shutdown`, and an `UnrecoverableError` thrown then dead-letters at once instead of running again.' },
  { since: '0.60.108.0', text: '`gbrain jobs supervisor stop` can now report `unverified` (exit 1) and `stale_pid_file` (exit 0, nothing signaled), and on Linux the supervisor PID file has a second line with the process start time; read only its first line.' },
  { since: '0.60.108.0', text: '`thinking: off` calls on native Google and OpenAI routes (eval judges, the synthesize triage judge, fence repair\'s model tier) now send the model\'s thinking switch (`thinkingBudget: 0`, `reasoningEffort: none`) and, where reasoning cannot be turned off (Gemini 2.5 Pro and 3.x, gpt-5/-mini/-nano, o-series), a 32,000-token reply cap; `eval takes-quality --budget-usd` and `eval cross-modal --max-usd` price that cap, so a budget that passed before can refuse earlier.' },
  { since: '0.60.111.0', text: 'A managed sync on Postgres publishes up to 16 groups at once (clamped by the connection pool; `sync.lanes` or `--lanes N` lowers it), and a page write during a catch-up goes ahead of queued sync groups that do not touch its page and publishes beside the running ones; `gbrain config set sync.foreground_priority false` restores strict arrival order.' },
  { since: '0.60.111.0', text: '`gbrain sources refresh` now refuses with `git_unavailable` when git cannot read the checkout\'s branch or remote (it used to read that as a detached HEAD or no remote and could skip the fetch), and a checkout that is not a Git checkout refuses `refresh_no_upstream`; run `git -C <checkout> status` to see why.' },
  // #6278
  { since: '0.60.112.0', text: 'A managed sync member\'s preparation now has a deadline (`persistence.sync_preparation_ms`, 120 s): a write that cannot finish preparing is released at its budget and tried once more, and a second cut-off (or a process killed mid-preparation) finishes it `failed` with `preparation_stalled`. The sync holds that file (`preparation_stalled`, listed by `gbrain sources status`; no `gbrain repair` applies) and keeps going, so the file stays out of the index until `gbrain sources retry-held <id>` and the same sync re-import it. A run that stalls more files than `sync.hold_escalate_count` / `sync.hold_escalate_pct` allow, or five in a row with no page committed between them, stops `blocked` with `preparation_systemic` (exit 1) instead of holding every file.' },
  { since: '0.60.112.0', text: 'A `put_page`, `edit_page`, `remember` or maintenance write (fact-fence adoption, maintenance page writes) whose preparation is cut off twice now gets a terminal `preparation_stalled` receipt instead of being claimed again and holding the rest of its root; resubmit a foreground write under a new `request_id`. `gbrain sources writer status` and doctor `persistence_write_stall` name the step it reached, what it waited on and the owner process (`claim.stall`).' },
  { since: '0.60.112.0', text: 'A managed `gbrain sync` pass that finishes its cursor while `sources retry-held` re-screens are scheduled for the source now returns `partial` / `writer_yield` instead of `synced`, and the drain runs the re-screen in the same invocation; a single-pass caller re-enters as it does at a slice boundary. A sync admission refused for write capacity (`queue_capacity` with `detail` `outstanding=N limit=M`) is waited out by the drain and, past its 30 s no-progress window, ends `blocked` with the new stop reason `write_capacity` and `drain.capacity`, where it used to exit 1 with no drain summary and a failure-ledger row.' },
  { since: '0.60.112.0', text: 'A managed `gbrain sync` drain no longer counts a renewed claim as progress: `drain_stalled` can now stop a catch-up whose head preparation is stuck past its budget plus 30 s, a preparation the sync\'s own process still holds past its budget plus 30 s ends the drain `resumable` / `preparation_abandoned` (exit 0, safe to rerun) and exits, and a progress line prints `stalled <N>s on <step>`. `gbrain sources retry-held` now prints a follow-up sync that keeps `--no-embed` and the run\'s other processing options.' },
  { since: '0.60.112.0', text: 'New keys `persistence.sync_preparation_ms` (120000), `persistence.maintenance_preparation_ms` (120000), `persistence.preparation_ceiling_ms` (600000) and `persistence.max_preparation_attempts` (2) bound write preparation, and `gbrain config set` refuses a value out of range; the `preparation_deadlines` write switch (`gbrain config set persistence.preparation_deadlines false`) restores the old behavior exactly (only `remember`, `put_page` and `edit_page` keep a 30 s budget; nothing is counted or held). `persistence.max_claim_ms` keeps its doctor meaning. Migration v220 adds `persistence_requests.preparation_attempts`; restart every `gbrain serve`, jobs worker and autopilot on the new version, because an older owner never gives up a stuck preparation.' },
  { since: '0.60.112.0', text: 'Fact-fence adoption (the extract_facts cycle phase and the v0.32.2 backfill) now writes the fence\'s parsed text back into `facts.fact`: a legacy claim with surrounding whitespace or CRLF line endings is adopted with that whitespace trimmed and its line endings folded to LF (the row keeps its id, vectors and provenance). A claim the fence codec would change further (whitespace-only, `~~x~~`, a literal `<br>`) or one its page already carries stays a legacy row, active and searchable, and is reported as `FACTS_FENCE_FAILED: <slug> (fence_unrenderable: …)` and under doctor `fence_integrity` `unrenderable_legacy_facts`. Only the pages still holding such rows skip destructive fact reconciliation (the whole source skipped before), and the cycle summary names them while keeping the reconcile counts of the other pages.' },
  { since: '0.60.112.0', text: 'A managed maintenance write on a page whose body or timeline already carries a fence defect no adoption clears (for example a second facts fence in the timeline) is now refused at submission with its fence reason, so the cycle skips that page in `failed_pages` instead of failing a request on every pass; doctor `fence_integrity` counts the stored defect as a repair candidate.' },
  // #6278 PR 1.5
  { since: '0.60.114.0', text: 'A cancelled database statement that a transaction-mode pooler never completes (its backend stuck in `ClientRead`) is now ended client-side `GBRAIN_CANCEL_SETTLE_MS` (2000 ms) after the cancel request by discarding that reserved connection; the owner\'s phase ends `deadline_exceeded` instead of parking until the watchdog, and a preparation read ended this way counts as the preparation deadline.' },
  // #6278 PR 2
  { since: '0.60.113.0', text: '`gbrain repair fences` and the maintenance `fence_repair` phase now run while a managed sync of the source is in progress: only a file a write in flight or the running sync\'s frozen manifest still names waits as `sync_in_progress` (a held file does not), and every other candidate, held files included, is repaired and committed during the catch-up. The busy check is repeated when each item is applied and when its write is admitted, and fails closed when it cannot be read.' },
  { since: '0.60.113.0', text: 'An `owner_unavailable` refusal from fence repair, chronicle, fact-fence adoption or any other maintenance writer now carries a `reason`: `host_mismatch` (both host ids\' first 8 characters, the local `host.json` path for local callers only, `retryable: false`), `transfer_in_progress` or `clone_in_progress` (`fix.next: wait`, 30 s), `binding_missing`, `incarnation_changed`, `local_path_missing` or `coordination_path_missing`; a fence hold records the same reason instead of a bare `owner_unavailable`. Nothing claims or transfers ownership to run maintenance; `gbrain errors owner_unavailable` lists the reasons.' },
  // Wave 0 repair batch (GBRA-60)
  { since: '0.60.115.0', text: 'New stdio registrations gbrain writes (`gbrain bootstrap hooks`, the readiness and `gbrain init` registration lines) and the Codex and Claude Code plugins, and the `gbrain agent register` daily-driver and coding-agent presets, now use `--surface full`, every operation including `put_pages`, instead of `starter`; an existing registration or client keeps its surface. A harness that caps its tool count can register `--surface starter` or set `GBRAIN_SURFACE=starter` in the server entry\'s env.' },
  { since: '0.60.115.0', text: 'New memory-reader, memory-writer and coding-agent grants (`gbrain mcp grant`, the admin dashboard, `auth rescope --profile`) are callable and listed on the full MCP surface instead of starter; their operation snapshot is still the ceiling, so a reader still cannot write. Existing clients keep their stored surface until the owner re-applies a profile. `whoami` and `gbrain://capabilities` now report `grant_diagnosis`, and `gbrain doctor` adds `grant_new_ops_available`, which lists grants whose snapshot or stored surface keeps operations their scopes allow out of reach, with the rescope commands.' },
  { since: '0.60.115.0', text: 'Doctor `embeddings` now warns on an embedding backlog only when it is large (over 1,000 chunks or 1% of chunks) and its oldest pending chunk has waited more than 24 hours, read from the new `content_chunks.embedding_pending_since` column; a backlog draining inside that window reads `ok` even below 90% coverage, an old one warns even above 90%, and `details` always carries `backlog`, `oldest_pending_age_s` and `age_threshold_s`. Check with `gbrain doctor --only embeddings --json`.' },
  // #6317. `since` below is a placeholder equal to the branch's VERSION so a fresh install's baseline covers it; the integrator sets it
  // to the merge-slot stamp (master plus one PATCH) by hand, because release:restamp rewrites VERSION, CHANGELOG and TODOS, never this table.
  { since: '0.60.117.0', text: 'On a managed Postgres brain, gbrain now prefers one full persistence consumer per host: `gbrain serve` always runs one, and a `gbrain sync`, jobs worker, autopilot or MCP process that finds a live, full, not-wedged consumer of this host in the new `persistence_consumers` heartbeat table runs waiter-only (it submits and waits, claims nothing) and promotes itself when that owner lapses, reads wedged or stops. This is a preference, not a guarantee: two processes starting within one heartbeat of each other, or a CLI that took its consumer before the serve started, both stay full until one exits, and doctor reports the overlap as `two_consumers_on_host` (a claim owner with no heartbeat row, an older process, as `consumers_without_heartbeat`). The fallback is visible, never silent: a sync beside an older serve prints `owner row missing: older serve or no serve; running own consumer` on its start line, `gbrain sync --no-delegate` (or `GBRAIN_SYNC_NO_DELEGATE=1`) keeps one run\'s own consumer on either engine, and `gbrain config set persistence.single_consumer false` (or `GBRAIN_SINGLE_CONSUMER=0`) restores a consumer per process brain-wide. Short-lived commands (`put`, `import`, `dream`, `cycle`) keep their own consumer; PGLite is unchanged. Restart every resident gbrain process on this version so the heartbeat rows exist.' },
  { since: '0.60.117.0', text: 'A managed `gbrain sync` beside a live owner on this host no longer stops `drain_stalled` with "nothing here can claim it" at the allowance: it prints `stalled <N>s on <step>` with the owner\'s pid and kind every 10 s and keeps going until the 600 s preparation ceiling frees the root, then stops with `cause: owner_wedged_here`, the owner `{kind, pid, nonce}`, `retry_after_ms` and `next.safe_to_loop: true` before the ceiling (rerun after the delay) or a restart of the named pid after it. `gbrain sources status --json` and `writer status --json` now carry `data_moving`, `not_moving_since` and `movement_state` per managed source, doctor warns `managed_sync_not_moving` (counted against the score; a cursor parked between runs with no live consumer is `parked`, not scored), `serve` prints one notice when a source flips, and `writer status` ends each running claim in a `claim.next` (`claim_running` with `retry_after_ms`, `claim_overdue` as `tell_user_to_run` naming the owner pid, or `claim_lapsed` with the resume command). `/health` stays liveness-only.' },
  { since: '0.60.117.0', text: 'New command `gbrain sources writer movement [<source>] [--wait <dur>] [--warn-only] [--json]` is the deploy gate an upgrade ends with: it waits one window (max(300 s, preparation budget + 60 s)) and exits 1 with `managed_sync_not_moving` (`reason: movement_check`) when pending managed work did not move (`--warn-only` prints the same and exits 0; `held` and `within_allowance` exit 0 with their route). `gbrain upgrade` and `post-upgrade` do not run it (neither restarts your processes) and end by printing it bare. Doctor also warns `host_identity_mismatch` when this process\'s `host.json` differs from the binding owner\'s on the same machine, naming both files and the `GBRAIN_HOME` to set; `host.json` stays version 1 and gains optional `minted_under` on files minted from now on.' },
  // R2 facts extraction default (GBRA-60); `since` is a placeholder equal to the branch's VERSION until the merge-slot stamp.
  { since: '0.60.118.0', text: 'Background fact extraction now uses claude-haiku-5-5 instead of claude-sonnet-4-6 when no model is set and the reasoning tier resolves through Anthropic (less than a tenth of the cost; it passed a facts-absorb quality gate against Sonnet 4.6, with 4.6 points fewer planted items covered on natural transcripts). `gbrain config set facts.extraction_model anthropic:claude-sonnet-4-6` keeps the previous model; installs that resolve through OpenAI, or set facts.extraction_model, models.tier.reasoning or models.default, are unchanged.' },
  { since: '0.60.119.0', text: 'On Postgres, gbrain now keeps one small file per database under `~/.gbrain/cache/pg-types/` with the parameter types the database described for gbrain\'s statements (hashes and type numbers only, no SQL text or credentials), so the next command skips those round trips; it is ignored when the Postgres or schema version differs and deleted when a migration runs. `GBRAIN_PG_TYPE_CACHE_PERSIST=0` keeps the types in memory only.' },
  { since: '0.60.120.0', text: 'Link typing changed (Q2, confirmed on held-out data): "adviser" and "is an advisor to [X]" type advises, and "not an advisor to [X]" does not; board, observer and investor wording never types works_at; a dated advisory, board or investor role is not an employment start. Every page re-extracts its links once in the background (zero model calls; `gbrain extract --stale` finishes it now, `gbrain doctor --json` reports links_extraction_lag 0 when done). Turning `line_grammar.enabled` on or off now re-extracts every page too, so the graph follows the setting; typed relation lines stay opt-in.' },
  // #6340 (GBRA-64).
  { since: '0.60.121.0', text: 'A managed catch-up no longer stops on a page that moved under it: a database page that changed after the manifest was frozen is held as `concurrent_write` (re-bound and passed when it already holds what the file would import), uncommitted working-tree bytes that match neither the pinned commit nor the page are held with the new code `worktree_dirty`, and working-tree bytes committed at HEAD past the pinned target are imported as HEAD has them; the run finishes `synced` with the holds listed instead of `blocked_by_failures` (`sync.holds=fail` and company-brain sources keep blocking).' },
  { since: '0.60.121.0', text: 'A managed sync drain that loses its database connection (`write ECONNABORTED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE`) now reconnects and retries at 5, 15 and 45 seconds instead of exiting, and a connection fault is no longer recorded in the sync failure ledger, so a relaunch (with or without `--retry-failed`) resumes at the stored cursor against the frozen manifest instead of re-freezing it; three drops in a row with no page committed between them stop the drain `connection_lost`.' },
  { since: '0.60.121.0', text: 'New commands `gbrain sync status --source <id> --json` (cursor position, pages committed in the last 10 minutes, each hold and the last error with `class`, `safe_actions` and `needs_human`, and `next`) and `gbrain sync unblock --source <id> [--apply] --json` (performs the safe action for every hold and the last error, refuses the rest by name) let an operator agent drive a catch-up without a human; the decision table is `docs/guides/sync-unblock-runbook.md`.' },
  // #6355 (GBRA-64); `since` is a placeholder equal to the branch's VERSION until the merge-slot stamp.
  { since: '0.60.123.0', text: 'A write whose database session drops during admission (a pooler reap, a failover, pg_terminate_backend) is re-run after 100, 300 and 900 ms, which replays the admitted row when the lost acknowledgment had committed; a session that keeps dropping returns the new typed `write_outcome_unknown` (reason `connection_lost`, fix: read the request by id) instead of the raw `CONNECTION_CLOSED` / `57P01` the caller used to take for a refusal while the write committed. A write admitted on the consumer\'s warm lane re-runs on the pool and the dead lane is given up at once. The vendored Postgres driver no longer hands a caller the stale `57P01` of a connection killed during startup, nor leaves a pool slot stuck until `CONNECT_TIMEOUT` after a close caught a pending write.' },
  // Budgeted delivery PR 1. `since` equals the branch's VERSION; the integrator sets it to the merge-slot stamp by hand (release:restamp does not rewrite this table).
  { since: '0.60.124.0', text: 'A token budget passed under `auto` evidence delivery (`token_budget` on query, search and assemble_evidence, `budget_tokens` on recall with `return_unit: "auto"`) is now a hard cap on the delivered titles and evidence: the best hit comes first, and conversations or notes that do not fit are listed in `delivery.dropped_reasons` instead of being appended as extra chunks. A budget below 32 tokens is refused with `invalid_params`. Calls without a budget, and a bare query `token_budget` (legacy chunk budgeting), are unchanged. `gbrain config set search.auto_packing off` restores the uncapped behavior.' },
  { since: '0.60.126.0', text: '`context_pack` cards now list the newest pages that mention each entity and are dated after the entity\'s own page (up to 8 per card, 2,000 characters per card and 6,000 per pack, each with its date, slug, title and preview), so a later mail or note that corrects the page reaches the agent on its first call. A remote caller never sees a private page or another source there, and the section packs last under `budget_tokens`. `gbrain config set mentions.newer_on_cards false` turns it off.' },
  // Lua grammar replacement (GBRA-64, from GBRA-49's serve-hang report); `since` is a placeholder until the merge-slot stamp.
  { since: '0.60.133.0', text: 'Lua code (`.lua` files and ```lua fences) now parses with tree-sitter-grammars/tree-sitter-lua v0.3.0: every parse is sound (the previous grammar started each parse after the first from uninitialized scanner state, misparsing or spinning until the 30 s chunker timeout, which left `gbrain serve` unresponsive on a page of mislabelled shell fences), and `function` / `local function` / `function M.f()` definitions become named semantic chunks for the first time. On the next sync each source is walked once and only its `.lua` files re-chunk and re-embed (priced by the cost gate as `grammar_drift`); other code pages keep their chunks. `gbrain sync --source <id> --full` also refreshes Lua fences inside already indexed Markdown pages.' },
  { since: '0.60.131.0', text: 'Vector search scoped to a source that holds a small part of the brain now returns its true nearest chunks: a source with up to about 25,000 chunks is scanned exactly instead of through the HNSW index, and a larger one falls back to that scan when the index comes back short. Unscoped search is unchanged; scoped results can differ from earlier releases where the index had missed closer matches.' },
  { since: '0.60.132.0', text: 'The maintenance run now repairs the content holds managed sync records, by itself and without consent: two facts or takes fences of one kind in one section are merged into one (exact duplicate rows dropped, colliding numbers renumbered, the validator proving every original row survived), an unclosed fence followed by text on a private page is closed after its last row, and a stray frontmatter `slug:` that names no page (or a page of a different type with no title in common) is removed; each repair is one committed file write carrying the trailer `gbrain-repair: <hold_code> <tier> <confidence>` and a receipt, so `git revert` of that commit undoes it. The `fence_repair` phase runs the fences, the new `content_repair` phase right after it runs the rest of the lane (`gbrain repair content --source <id>` previews both); `gbrain config set fences.repair.enabled false` pauses all of it.' },
  { since: '0.60.132.0', text: `The repair model (\`models.fence_repair\`, or \`models.content_repair\` for slug conflicts) now also classifies the cases the deterministic rules mark ambiguous, under the same \`fences.repair.max_usd_per_page\` ($0.30) and \`fences.repair.max_usd_per_day\` ($1.00) caps and one shared daily ledger: whether the lines after an unclosed fence on a world-visible page are prose or table rows, and whether two pages a \`slug:\` line ties together are the same thing. The model chooses among coded answers and never writes text: a world-page close that would expose hidden lines waits for your hash-bound approval (\`tail_exposure_approval\`), a page merge is recommended, never executed (\`merge_recommended\` names the canonical page), and an undecided case is \`needs_human\`. ${CONTENT_REPAIR_MEASURED} \`gbrain config set fences.repair.llm false\` turns the model tier off for the whole lane; \`--no-llm\` keeps one run to the free tiers.` },
  { since: '0.60.132.0', text: '`gbrain sync unblock --source <id> --apply` now writes: for every held file the content-repair lane clears (`invalid_fence` and `frontmatter_slug_conflict`) it runs the lane on exactly those paths as one bounded hash-bound apply under the `fences.repair` caps, prints a receipt per file and schedules the re-screen, and reports each path as `repaired`, `held`, `needs_human` or `skipped` with the reason and its next step; a hold whose stored state waits on a person, your spend decision or the owner host is listed, never retried. Before this release unblock refused every repair-class hold. `--no-llm` keeps the repairs to the free tiers; `--no-repair` restores the refuse-only behaviour. `gbrain sync status` now reports a fence hold the lane marked manual or paid, and a recommended merge, as `needs_human` with the paragraph in `human_reason`.' },
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
