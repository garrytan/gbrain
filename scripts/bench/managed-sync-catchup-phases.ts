/**
 * Trace analysis for scripts/bench/managed-sync-catchup.ts: sequential round
 * trips (waves), transactions, the sync process's per-phase critical path, the
 * group publication breakdown with its counter hold, and per-put_page
 * foreground round trips. Pure functions over trace records, so
 * `--analyze <trace.jsonl>` reruns them on a kept trace without a database.
 *
 * Only statement prefixes that stay stable across the publication rewrite are
 * matched (RULES lists each segmentation rule; the JSON carries it too).
 */
import { classify, family, flatSql, pct, round1, sum, type TraceRecord } from './managed-sync-catchup-lib.ts';

export const RULES = {
  wave: 'A wave is a maximal run of records on one (pid, conn) whose [t, t+ms] intervals overlap; a describe record is always its own wave and the record after it starts a new one. Statements are execute and simple records; describes and connects count only as round trips.',
  transaction: 'Records between begin and commit/rollback on one (pid, conn), whichever process or connection runs them. group publication = the set-based completion (WITH m AS (SELECT * FROM unnest(...)) ... UPDATE persistence_requests r SET state=\'committed\'), or >= 1 member attribution (SELECT set_config(\'gbrain.write_request\',...)) with an INSERT INTO pages / UPDATE pages (a lane group rolled back before its completion); single publication = the ownership guard, the counter lock (INSERT INTO persistence_counters(key)) and the single completion (UPDATE persistence_requests SET state=$2,outcome=), or the lock_timeout 1s set_config with the counter lock (older branches); admission = INSERT INTO persistence_requests (also behind the single admission\'s WITH reserved AS (UPDATE persistence_counters ...)); recovery = UPDATE persistence_requests SET recovery= (the recovery record before a file is touched); claim = UPDATE persistence_requests [r] SET state=\'running\' (head claim and group follower claim are separate occurrences); waiver = op_checkpoints write with a page_write_guards lock (a no-op entry waived); cursor = INSERT/UPDATE/DELETE op_checkpoints.',
  freeze: 'Per admission: sync-process statements outside any phase transaction from the end of the first cursor save after max(previous admission end, last publication commit) up to the admission begin; waits and consumer background excluded. Wall excludes the cursor saves nested in the window.',
  prepare: 'Per publication: statements outside any phase transaction between the end of the last claim since the previous publication and the publication begin (waits and consumer background excluded).',
  wait: 'Per admission: WRITE_PROGRESS_SQL and SELECT * FROM persistence_requests WHERE id=$1::uuid / id=ANY($1::uuid[]) reads from the admission commit to the next cursor save (or admission). Its wall overlaps claim, prepare and publication.',
  commit_gap: 'Between consecutive committed group publications of one sync process (all publications when it published no group): wall, and every record the process sent in between. Single publications include foreground writes the sync process\'s consumer published.',
  member_chain: 'Members are split at their attribution statements (with its describe, if any): segment i runs from member i\'s attribution to member i+1\'s, so it holds member i\'s apply/effects tail and member i+1\'s authorize/snapshot/validate lead. The rotation leaves the steady per-member total unchanged. Steady = segments 2..n-1 of transactions with >= 3 members; segment 1 carries first-use describes, the last one runs into the counter lock and is part of the fixed cost.',
  counter_hold: 'From the counter row lock (SELECT * FROM persistence_counters ... FOR UPDATE, with its describe) to the commit, inclusive. INSERT INTO persistence_counters(key) ... ON CONFLICT DO NOTHING creates missing rows and locks no existing one, so it is outside the hold.',
  chain_wave: 'Feeder round-trip waves are counted across connections: one wave is a maximal run of the bucket\'s records whose [t, t+ms] intervals overlap on any connection of the process, so four freezes in flight at once are one wave and a chain of reads hopping connections is one wave per read.',
  feeder: 'Sync process only. Feeder markers are statements only the sync loop sends: cursor and waiver transactions, admission transactions, op_checkpoints reads, request lookups by request_id (SELECT * / count(*)), the admit-ahead foreground check, and write-wait reads (WRITE_PROGRESS_SQL, id=$1, the group state read id=ANY). A gap between consecutive markers that ends at a write-wait read is idle (awaitWrite); every other gap is producing. A single entry\'s wait (admission, then the cursor save, no state read) counts as producing. Loose statements in producing gaps that are not consumer work (consumer background, claim attempts, claim renewals, the group recovery check) are freeze and waiver-screen reads; those inside a consumer preparation span (k-th claim chain end to the k-th publication begin; a chain is a head claim and its follower claim) are reported apart as overlapping, because the screen and the consumer\'s preparation run the same helpers. Freeze vs screen: each freeze issues one origin read (pages ... source_path=ANY), one page snapshot and one writer check, so per origin read one snapshot and one writer check are freeze; every other read is screen (an estimate). Entries frozen = origin reads outside preparation spans.',
  lane: 'Per group publication transaction: the turn wait is the last run of lane-turn polls (SELECT state FROM persistence_requests WHERE ... request_id=$3, describes included) after which no member attribution or page write follows (member validation sends the same read earlier); apply = begin to the first poll of that run, turn wait = its first poll to the end of its last, completion = the rest to commit. A group with no predecessor polls nothing (apply = whole transaction). Lanes busy = open group publication transactions per process, time-weighted over the time at least one is open.',
  foreground_spans: 'Per put_page, from the foreground process\'s transactions: writes in start order take the admission transactions in order (the first unassigned one starting in the write\'s [t-ms, t] window); a write\'s publication is the latest unassigned single publication between its admission end and its reply, its claim the latest unassigned claim before that publication, its recovery record the latest recovery transaction between the two. pre-admission = start to the admission begin; admission = the admission transaction; admission+claim = admission begin to the claim end; preparation = claim end to the publication begin (includes the recovery record); recovery = the recovery-record transaction; publication = the single publication transaction; visible = publication end to the reply, or admission end to the reply for a write another process published or that was still pending at its reply. Concurrent writes (open loop) are matched the same way.',
  steady_rate: 'Commit times: the end of each committed group publication (one commit per member, any process) and each committed single publication of a sync process when the trace has no foreground writer (the sync process\'s consumer also publishes foreground put_pages, which the trace cannot tell apart; persistence_requests.completed_at is exact). Pages/min between the commit that reaches 10% of the committed pages and the one that reaches 90%; first commit is measured from the first record of the first sync process.',
};

const SIG = {
  lock1s: /^SELECT set_config\('synchronous_commit','on',true\),set_config\('lock_timeout','1s',true\)/,
  counterLock: /^INSERT INTO persistence_counters\(key\)/,
  counterRowLock: /^SELECT \* FROM persistence_counters WHERE key=ANY\(.*FOR UPDATE$/,
  attribution: /^SELECT set_config\('gbrain\.write_request',/,
  admission: /^(?:WITH reserved AS \(UPDATE persistence_counters .*?\) )?INSERT INTO persistence_requests\b/,
  claim: /^UPDATE persistence_requests (?:r )?SET state='running'/,
  claimAttempt: /^SELECT r\.\* FROM persistence_requests r LEFT JOIN persistence_worktrees w/,
  cursor: /^(?:INSERT INTO|UPDATE|DELETE FROM) op_checkpoints\b/,
  wait: /^SELECT (?:\*|state,error_code,error_message,completed_at,updated_at,blocked_reason,outcome) FROM persistence_requests WHERE id=(?:\$1::uuid|ANY\(\$1::uuid\[\]\))$/,
  groupCompletion: /^WITH m AS \( SELECT \* FROM unnest\(.*\bUPDATE persistence_requests r SET state='committed'/,
  singleCompletion: /\bUPDATE persistence_requests SET state=\$2,outcome=/,
  ownershipGuard: /^SELECT owner_host_id,owner_epoch,state FROM persistence_worktrees WHERE id=\$1::uuid FOR SHARE$/,
  pageWrite: /^(?:INSERT INTO pages\b|UPDATE pages\b)/,
  recovery: /^WITH recorded AS \(UPDATE persistence_requests (?:r )?SET recovery=/,
  guard: /\bpage_write_guards\b/,
  laneTurn: /^SELECT state FROM persistence_requests WHERE principal_kind=\$1 AND principal_id=\$2 AND request_id=\$3::uuid$/,
  headClaim: /^UPDATE persistence_requests SET state='running'/,
  checkpointRead: /^SELECT\b.*\bFROM op_checkpoints\b/,
  requestLookup: /^SELECT (?:\*|count\(\*\)::int AS n) FROM persistence_requests WHERE principal_kind=\$1 AND principal_id=\$2 AND request_id=(?:\$3::uuid|ANY\(\$3::uuid\[\]\))$/,
  foregroundCheck: /^SELECT id FROM persistence_requests WHERE worktree_id=\$1::uuid AND state IN \('queued','running','recovering'\) AND NOT\(COALESCE\(intent->>'kind',''\) LIKE 'managed_sync_%'\)/,
  consumerOnly: /^UPDATE persistence_requests r SET claim_expires_at=|^SELECT 1 FROM persistence_requests WHERE worktree_id=\$1::uuid AND NOT \(id=ANY/,
  origin: /^SELECT id,slug,source_path FROM pages WHERE source_id=\$1 AND source_path=ANY\(/,
  snapshot: /^WITH chosen AS \( SELECT p\.\* FROM pages p WHERE p\.slug=\$1/,
  writerCheck: /^SELECT lane,revoked_at,grant_ceiling FROM persistence_local_writers WHERE id=\$1::uuid$/,
};
const BEGIN = /^(?:begin|start transaction)\b/i;
const END = /^(?:commit|end)\b|^rollback(?!\s+to\b)/i;
const SYNC_FAMILIES = new Set(['cli-sync', 'reentry']);
const WAVE_EPS_MS = 0.005;

const end = (r: TraceRecord) => r.t + r.ms;
const byStart = (a: TraceRecord, b: TraceRecord) => a.t - b.t || end(a) - end(b);
const isStatement = (r: TraceRecord) => r.kind === 'execute' || r.kind === 'simple';
const is = (re: RegExp) => (r: TraceRecord) => re.test(flatSql(r.sql));

function groupBy<T>(xs: T[], key: (x: T) => string | number): Map<string | number, T[]> {
  const out = new Map<string | number, T[]>();
  for (const x of xs) { const k = key(x); const list = out.get(k); if (list) list.push(x); else out.set(k, [x]); }
  return out;
}

/** Waves and the summed span of their merged intervals. */
export function waves(records: TraceRecord[]): { count: number; spanMs: number } {
  let count = 0, spanMs = 0;
  for (const rs of groupBy(records, r => `${r.pid}:${r.conn}`).values()) {
    rs.sort(byStart);
    let open = false, start = 0, stop = 0, describe = false;
    for (const r of rs) {
      const d = r.kind === 'describe';
      if (!open || d || describe || r.t >= stop - WAVE_EPS_MS) {
        if (open) spanMs += stop - start;
        count++; open = true; start = r.t; stop = end(r); describe = d;
      } else stop = Math.max(stop, end(r));
    }
    if (open) spanMs += stop - start;
  }
  return { count, spanMs };
}

export interface Cost { statements: number; waves: number; describes: number }
export function cost(records: TraceRecord[]): Cost {
  return { statements: records.filter(isStatement).length, waves: waves(records).count, describes: records.filter(r => r.kind === 'describe').length };
}

export type TxnType = 'publication' | 'admission' | 'recovery' | 'claim' | 'claim-attempt' | 'waiver' | 'cursor' | 'other';
export interface Txn { pid: number; label: string; records: TraceRecord[]; start: number; end: number; type: TxnType; committed: boolean; members: number; group: boolean }

function txnType(records: TraceRecord[], members: number): { type: TxnType; group: boolean } {
  const has = (re: RegExp) => records.some(r => isStatement(r) && re.test(flatSql(r.sql)));
  if (has(SIG.groupCompletion) || (members > 0 && has(SIG.pageWrite))) return { type: 'publication', group: true };
  if ((has(SIG.ownershipGuard) && has(SIG.counterLock) && has(SIG.singleCompletion)) || (has(SIG.lock1s) && has(SIG.counterLock))) return { type: 'publication', group: members > 0 };
  const type: TxnType = has(SIG.admission) ? 'admission' : has(SIG.recovery) ? 'recovery' : has(SIG.claim) ? 'claim'
    : has(SIG.cursor) ? (has(SIG.guard) ? 'waiver' : 'cursor') : has(SIG.claimAttempt) ? 'claim-attempt' : 'other';
  return { type, group: false };
}

/** Transactions per (pid, conn), and the records outside any transaction. */
export function transactions(records: TraceRecord[]): { txns: Txn[]; loose: TraceRecord[] } {
  const txns: Txn[] = [];
  const loose: TraceRecord[] = [];
  const close = (rs: TraceRecord[], committed: boolean) => {
    const last = rs.at(-1)!;
    const members = rs.filter(r => isStatement(r) && SIG.attribution.test(flatSql(r.sql))).length;
    txns.push({ pid: rs[0]!.pid, label: rs[0]!.label, records: rs, start: rs[0]!.t, end: end(last), ...txnType(rs, members), committed, members });
  };
  for (const rs of groupBy(records, r => `${r.pid}:${r.conn}`).values()) {
    rs.sort(byStart);
    let open: TraceRecord[] | null = null;
    for (const r of rs) {
      const sql = isStatement(r) ? r.sql.trim() : '';
      if (BEGIN.test(sql)) { if (open) close(open, false); open = [r]; continue; }
      if (!open) { loose.push(r); continue; }
      open.push(r);
      if (END.test(sql)) { close(open, /^(?:commit|end)\b/i.test(sql) && !r.err && !open.some(x => x.err)); open = null; }
    }
    if (open) close(open, false);
  }
  txns.sort((a, b) => a.start - b.start);
  return { txns, loose: loose.sort(byStart) };
}

function inWindow(records: TraceRecord[], from: number, to: number): TraceRecord[] {
  return records.filter(r => r.t >= from && r.t < to);
}

interface Occurrence { wall: number | null; records: TraceRecord[] }
export interface PhaseRow { phase: string; occurrences: number; wall_ms_total: number | null; wall_ms_p50: number | null; statements: number; statements_p50: number | null;
  waves: number; waves_p50: number | null; describes: number; statements_per_page: number | null; waves_per_page: number | null; concurrent: boolean }

function phaseRow(phase: string, occ: Occurrence[], pages: number | null, concurrent = false): PhaseRow {
  const costs = occ.map(o => cost(o.records));
  const walls = occ.flatMap(o => o.wall === null ? [] : [o.wall]);
  const statements = sum(costs.map(c => c.statements)), w = sum(costs.map(c => c.waves));
  return { phase, occurrences: occ.length, wall_ms_total: walls.length ? round1(sum(walls)) : null, wall_ms_p50: pct(walls, 50),
    statements, statements_p50: pct(costs.map(c => c.statements), 50), waves: w, waves_p50: pct(costs.map(c => c.waves), 50),
    describes: sum(costs.map(c => c.describes)), statements_per_page: pages ? round1(statements / pages) : null, waves_per_page: pages ? round1(w / pages) : null, concurrent };
}

/**
 * Pages a trace published, for `--analyze`: members of committed group
 * publications; without groups, committed single publications outside the
 * foreground writer (a sync consumer's singles can be foreground writes, so
 * singles are not added to groups).
 */
export function publishedPages(records: TraceRecord[]): number {
  const pubs = [...groupBy(records, r => r.pid).values()].flatMap(rs => transactions(rs).txns.filter(t => t.type === 'publication' && t.committed));
  return sum(pubs.filter(t => t.group).map(t => Math.max(1, t.members))) || pubs.filter(t => family(t.label) !== 'foreground').length;
}

/** Per-phase critical path of the sync processes (`cli-sync`, `reentry`); RULES describes each phase. */
export function criticalPath(records: TraceRecord[], pages: number | null): Record<string, unknown> {
  const occ: Record<string, Occurrence[]> = { 'publication (group)': [], 'publication (single)': [], freeze: [], admission: [], cursor: [], waiver: [], recovery: [], claim: [], prepare: [], wait: [], commit_gap: [], background: [] };
  const sync = records.filter(r => SYNC_FAMILIES.has(family(r.label)));
  for (const rs of groupBy(sync, r => r.pid).values()) {
    rs.sort(byStart);
    const { txns, loose } = transactions(rs);
    const of = (type: TxnType) => txns.filter(t => t.type === type);
    const pubs = of('publication'), adms = of('admission'), claims = of('claim'), cursors = of('cursor');
    const groups = pubs.filter(p => p.group);
    for (const [phase, list] of [['publication (group)', groups], ['publication (single)', pubs.filter(p => !p.group)], ['admission', adms], ['claim', claims], ['cursor', cursors], ['waiver', of('waiver')], ['recovery', of('recovery')]] as const) {
      occ[phase]!.push(...list.map(t => ({ wall: t.end - t.start, records: t.records })));
    }
    const waits = loose.filter(is(SIG.wait));
    const background = [...loose.filter(r => !SIG.wait.test(flatSql(r.sql)) && classify(r.sql) === 'consumer-background'), ...of('claim-attempt').flatMap(t => t.records)];
    const free = [...loose.filter(r => !SIG.wait.test(flatSql(r.sql)) && classify(r.sql) !== 'consumer-background'), ...of('other').flatMap(t => t.records)].sort(byStart);
    occ.background!.push({ wall: null, records: background });
    for (const [k, p] of pubs.entries()) {
      const after = k ? pubs[k - 1]!.end : -Infinity;
      const claim = claims.filter(c => c.end <= p.start && c.end > after).at(-1);
      if (claim) occ.prepare!.push({ wall: p.start - claim.end, records: inWindow(free, claim.end, p.start) });
    }
    const last = end(rs.reduce((a, b) => end(a) > end(b) ? a : b));
    for (const [k, a] of adms.entries()) {
      const lastPub = pubs.filter(p => p.end <= a.start).at(-1);
      const base = Math.max(k ? adms[k - 1]!.end : rs[0]!.t, lastPub?.end ?? -Infinity);
      const firstSave = cursors.find(c => c.start >= base && c.end <= a.start);
      const from = firstSave ? firstSave.end : base;
      const nested = cursors.filter(c => c.start >= from && c.end <= a.start);
      occ.freeze!.push({ wall: a.start - from - sum(nested.map(c => c.end - c.start)), records: inWindow(free, from, a.start) });
      const next = Math.min(cursors.find(c => c.start >= a.end)?.start ?? Infinity, adms[k + 1]?.start ?? Infinity, last);
      occ.wait!.push({ wall: next - a.end, records: inWindow(waits, a.end, next) });
    }
    const ends = (groups.length ? groups : pubs).filter(p => p.committed).map(p => p.end);
    for (let i = 1; i < ends.length; i++) occ.commit_gap!.push({ wall: ends[i]! - ends[i - 1]!, records: rs.filter(r => r.t > ends[i - 1]! && r.t <= ends[i]!) });
  }
  const phases = Object.entries(occ).map(([phase, list]) => phaseRow(phase, list, pages, phase === 'wait' || phase === 'background'));
  const all = waves(sync);
  const pub = phases.find(p => p.phase === 'publication (group)')!;
  return { pages, processes: new Set(sync.map(r => r.pid)).size, phases,
    wave_check: { sync_waves: all.count, sync_statements: sync.filter(isStatement).length, ms_per_wave: all.count ? round1(all.spanMs / all.count) : null,
      publication_wall_ms_per_wave: pub.waves && pub.wall_ms_total !== null ? round1(pub.wall_ms_total / pub.waves) : null },
    rules: { wave: RULES.wave, transaction: RULES.transaction, freeze: RULES.freeze, prepare: RULES.prepare, wait: RULES.wait, commit_gap: RULES.commit_gap } };
}

interface Fit { fixed: number; per_member: number; r2: number | null; n: number }
function ols(xs: number[], ys: number[]): Fit | null {
  const n = xs.length;
  if (n < 2) return null;
  const mx = sum(xs) / n, my = sum(ys) / n;
  const sxx = sum(xs.map(x => (x - mx) ** 2));
  if (sxx === 0) return null;
  const b = sum(xs.map((x, i) => (x - mx) * (ys[i]! - my))) / sxx;
  const a = my - b * mx;
  const sst = sum(ys.map(y => (y - my) ** 2)), sse = sum(ys.map((y, i) => (y - a - b * xs[i]!) ** 2));
  return { fixed: round1(a), per_member: Math.round(b * 100) / 100, r2: sst ? Math.round((1 - sse / sst) * 1000) / 1000 : null, n };
}
const mean = (xs: number[]) => xs.length ? round1(sum(xs) / xs.length) : null;

interface GroupTxn { process: string; members: number; statements: number; waves: number; describes: number; wall_ms: number; committed: boolean;
  hold: Cost & { ms: number } | null; segments: Cost[]; prefix: Cost }

function analyzeGroup(t: Txn): GroupTxn {
  const rs = t.records;
  const lockAt = rs.findIndex(is(SIG.counterRowLock));
  const hold = lockAt < 0 ? null : { ...cost(rs.slice(lockAt)), ms: round1(t.end - rs[lockAt]!.t) };
  const bounds: number[] = [];
  rs.forEach((r, i) => {
    if (!isStatement(r) || !SIG.attribution.test(flatSql(r.sql))) return;
    bounds.push(i > 0 && rs[i - 1]!.kind === 'describe' && rs[i - 1]!.sql === r.sql ? i - 1 : i);
  });
  const stop = lockAt < 0 ? rs.length : lockAt;
  const segments = bounds.map((b, i) => cost(rs.slice(b, i + 1 < bounds.length ? bounds[i + 1] : stop)));
  return { process: family(t.label), members: Math.max(1, t.members), ...cost(rs), wall_ms: round1(t.end - t.start), committed: t.committed, hold, segments, prefix: cost(rs.slice(0, bounds[0] ?? 0)) };
}

/** Group publication breakdown (all processes): fixed vs per-member cost, steady member chain, completion and counter hold. */
export function publicationBreakdown(records: TraceRecord[]): Record<string, unknown> {
  const pubs = [...groupBy(records, r => r.pid).values()].flatMap(rs => transactions(rs).txns.filter(t => t.type === 'publication'));
  const groups = pubs.filter(t => t.group).map(analyzeGroup);
  const ok = groups.filter(g => g.committed);
  const singles = pubs.filter(t => !t.group && t.committed).map(t => ({ ...cost(t.records), wall: t.end - t.start }));
  const xs = ok.map(g => g.members);
  const steady = ok.filter(g => g.members >= 3).flatMap(g => g.segments.slice(1, -1));
  const first = ok.filter(g => g.members >= 2).map(g => g.segments[0]!);
  const held = ok.filter(g => g.hold);
  const holdFit = { statements: ols(held.map(g => g.members), held.map(g => g.hold!.statements)), waves: ols(held.map(g => g.members), held.map(g => g.hold!.waves)),
    ms: ols(held.map(g => g.members), held.map(g => g.hold!.ms)) };
  const chain = { statements_mean: mean(steady.map(s => s.statements)), waves_mean: mean(steady.map(s => s.waves)), describes_mean: mean(steady.map(s => s.describes)), segments: steady.length };
  const byMembers = [...groupBy(ok, g => g.members).entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([members, gs]) => ({
    members: Number(members), transactions: gs.length, statements_p50: pct(gs.map(g => g.statements), 50), waves_p50: pct(gs.map(g => g.waves), 50),
    describes_p50: pct(gs.map(g => g.describes), 50), wall_ms_p50: pct(gs.map(g => g.wall_ms), 50),
    hold_statements_p50: pct(gs.flatMap(g => g.hold ? [g.hold.statements] : []), 50), hold_waves_p50: pct(gs.flatMap(g => g.hold ? [g.hold.waves] : []), 50),
    hold_ms_p50: pct(gs.flatMap(g => g.hold ? [g.hold.ms] : []), 50) }));
  return {
    group_transactions: groups.length, committed: ok.length, rolled_back: groups.length - ok.length, members_total: sum(xs), members_p50: pct(xs, 50),
    fit: { waves: ols(xs, ok.map(g => g.waves)), statements: ols(xs, ok.map(g => g.statements)) },
    prefix: { statements_mean: mean(ok.map(g => g.prefix.statements)), waves_mean: mean(ok.map(g => g.prefix.waves)) },
    first_member_chain: { statements_mean: mean(first.map(s => s.statements)), waves_mean: mean(first.map(s => s.waves)), describes_mean: mean(first.map(s => s.describes)) },
    steady_member_chain: chain,
    completion_per_member: { statements: holdFit.statements?.per_member ?? null, waves: holdFit.waves?.per_member ?? null },
    per_page_publication_round_trips: chain.waves_mean !== null && holdFit.waves ? round1(chain.waves_mean + holdFit.waves.per_member) : null,
    per_page_publication_statements: chain.statements_mean !== null && holdFit.statements ? round1(chain.statements_mean + holdFit.statements.per_member) : null,
    counter_hold: {
      statements_p50: pct(held.map(g => g.hold!.statements), 50), statements_max: pct(held.map(g => g.hold!.statements), 100),
      waves_p50: pct(held.map(g => g.hold!.waves), 50), waves_max: pct(held.map(g => g.hold!.waves), 100),
      ms_p50: pct(held.map(g => g.hold!.ms), 50), ms_max: pct(held.map(g => g.hold!.ms), 100), fit: holdFit },
    by_members: byMembers,
    single_publications: { committed: singles.length, statements_p50: pct(singles.map(s => s.statements), 50), waves_p50: pct(singles.map(s => s.waves), 50), wall_ms_p50: pct(singles.map(s => s.wall), 50) },
    transactions: ok.slice(0, 200).map(({ segments: _s, prefix: _p, ...g }) => g),
    rules: { member_chain: RULES.member_chain, counter_hold: RULES.counter_hold },
  };
}

/** Waves across connections (RULES.chain_wave) and the summed span of their merged intervals. */
export function chainWaves(records: TraceRecord[]): { count: number; spanMs: number } {
  const rs = [...records].sort(byStart);
  let count = 0, spanMs = 0, start = 0, stop = -Infinity;
  for (const r of rs) {
    if (r.t >= stop - WAVE_EPS_MS) { if (count) spanMs += stop - start; count++; start = r.t; stop = end(r); } else stop = Math.max(stop, end(r));
  }
  if (count) spanMs += stop - start;
  return { count, spanMs };
}

interface Span { start: number; end: number }
const within = (t: number, spans: Span[]) => spans.some(s => t >= s.start && t < s.end);

/** Consumer preparation spans of one process: the k-th claim chain (head claim + follower claim) ends, the k-th publication begins. */
function preparationSpans(txns: Txn[]): Span[] {
  const chains: Array<{ end: number; follower: boolean }> = [];
  for (const t of txns.filter(x => x.type === 'claim')) {
    const head = t.records.some(r => isStatement(r) && SIG.headClaim.test(flatSql(r.sql)));
    const open = chains.at(-1);
    if (!head && open && !open.follower) { open.end = t.end; open.follower = true; } else chains.push({ end: t.end, follower: !head });
  }
  const spans: Span[] = [];
  let k = 0;
  for (const p of txns.filter(x => x.type === 'publication')) {
    while (k < chains.length && chains[k]!.end > p.start) k++;
    if (k >= chains.length) break;
    spans.push({ start: chains[k]!.end, end: p.start });
    k++;
  }
  return spans;
}

interface Bucket { statements: number; waves: number; describes: number; ms: number | null }
function bucket(records: TraceRecord[], ms: number | undefined): Bucket {
  return { statements: records.filter(isStatement).length, waves: chainWaves(records).count, describes: records.filter(r => r.kind === 'describe').length, ms: ms === undefined ? null : round1(ms) };
}
const per = (b: Bucket, n: number | null) => n ? { statements: round1(b.statements / n), waves: round1(b.waves / n), ms: b.ms === null ? null : round1(b.ms / n) } : null;

/** Feeder (sync loop) breakdown of the sync processes: idle vs producing time and per-bucket cost per entry, group and page (RULES.feeder). */
export function feederBreakdown(records: TraceRecord[], pages: number | null): Record<string, unknown> {
  const sync = records.filter(r => SYNC_FAMILIES.has(family(r.label)));
  const acc: Record<string, TraceRecord[]> = { freeze: [], waiver_screen: [], waiver: [], cursor: [], admission: [], wait: [], overlapping_preparation: [] };
  const ms: Record<string, number> = { idle: 0, producing_gaps: 0, wall: 0, waiver: 0, cursor: 0, admission: 0, wait: 0 };
  let groups = 0, entries = 0;
  for (const rs of groupBy(sync, r => r.pid).values()) {
    rs.sort(byStart);
    const { txns, loose } = transactions(rs);
    ms.wall! += end(rs.reduce((a, b) => end(a) > end(b) ? a : b)) - rs[0]!.t;
    const prep = preparationSpans(txns);
    type Marker = { start: number; end: number; kind: string; records: TraceRecord[] };
    const markers: Marker[] = [];
    for (const t of txns) {
      if (t.type === 'cursor' || t.type === 'waiver' || t.type === 'admission') markers.push({ start: t.start, end: t.end, kind: t.type, records: t.records });
      if (t.type === 'admission') groups++;
    }
    const candidates: TraceRecord[] = [];
    for (const r of loose) {
      const s = flatSql(r.sql);
      const kind = SIG.wait.test(s) ? 'wait' : SIG.checkpointRead.test(s) ? 'cursor' : SIG.requestLookup.test(s) || SIG.foregroundCheck.test(s) ? 'admission' : null;
      if (kind) markers.push({ start: r.t, end: end(r), kind, records: [r] });
      else if (r.kind !== 'connect' && classify(r.sql) !== 'consumer-background' && !SIG.consumerOnly.test(s)) candidates.push(r);
    }
    for (const t of txns) if (t.type === 'other' && !t.records.some(r => classify(r.sql) === 'consumer-background')) candidates.push(...t.records);
    markers.sort((a, b) => a.start - b.start);
    const producing: Span[] = [];
    for (const [i, m] of markers.entries()) {
      acc[m.kind]!.push(...m.records);
      ms[m.kind]! += m.end - m.start;
      const next = markers[i + 1];
      if (!next || next.start <= m.end) continue;
      if (next.kind === 'wait') ms.idle! += next.start - m.end;
      else { ms.producing_gaps! += next.start - m.end; producing.push({ start: m.end, end: next.start }); }
    }
    const reads = candidates.filter(r => within(r.t, producing));
    const own = reads.filter(r => !within(r.t, prep));
    acc.overlapping_preparation!.push(...reads.filter(r => within(r.t, prep)));
    const origins = own.filter(r => isStatement(r) && SIG.origin.test(flatSql(r.sql))).length;
    entries += origins;
    let snapshots = origins, writers = origins;
    for (const r of own.sort(byStart)) {
      const s = flatSql(r.sql);
      const freeze = SIG.origin.test(s) || (SIG.snapshot.test(s) && (r.kind === 'describe' || snapshots-- > 0)) || (SIG.writerCheck.test(s) && (r.kind === 'describe' || writers-- > 0));
      acc[freeze ? 'freeze' : 'waiver_screen']!.push(r);
    }
  }
  const b = Object.fromEntries(Object.entries(acc).map(([k, rs]) => [k, bucket(rs, ms[k])])) as Record<string, Bucket>;
  const top = groupBy([...acc.freeze!, ...acc.waiver_screen!].filter(isStatement), r => flatSql(r.sql).slice(0, 120));
  const producing = ms.wall! - ms.idle!;
  return {
    processes: new Set(sync.map(r => r.pid)).size, groups_admitted: groups, entries_frozen_est: entries, pages,
    time_ms: { wall: round1(ms.wall!), idle_await_write: round1(ms.idle!), producing: round1(producing), producing_gaps: round1(ms.producing_gaps!),
      cursor: round1(ms.cursor!), admission: round1(ms.admission!), waiver: round1(ms.waiver!), wait_reads: round1(ms.wait!),
      idle_share_pct: ms.wall ? round1(100 * ms.idle! / ms.wall!) : null },
    buckets: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, { ...v, per_entry: per(v, entries), per_group: per(v, groups), per_page: per(v, pages) }])),
    top_freeze_screen_statements: [...top.entries()].map(([sql, rs]) => ({ sql, count: rs.length, per_entry: entries ? round1(rs.length / entries) : null }))
      .sort((x, y) => y.count - x.count).slice(0, 15),
    rules: { feeder: RULES.feeder, chain_wave: RULES.chain_wave },
  };
}

/** Lane group apply vs commit-turn wait per group publication transaction, and how many lanes are busy at once (RULES.lane). */
export function laneApply(records: TraceRecord[]): Record<string, unknown> {
  const rows: Array<{ members: number; apply: number; turn: number | null; polls: number; completion: number; statements_per_page: number; describes: number; committed: boolean }> = [];
  const dist = new Map<number, number>();
  let busyMs = 0, weighted = 0, maxBusy = 0;
  for (const rs of groupBy(records, r => r.pid).values()) {
    const groups = transactions(rs).txns.filter(t => t.type === 'publication' && t.group);
    for (const t of groups) {
      const recs = t.records;
      const turn = (r: TraceRecord) => SIG.laneTurn.test(flatSql(r.sql));
      let last = recs.findLastIndex(turn);
      if (recs.slice(last + 1).some(r => isStatement(r) && (SIG.attribution.test(flatSql(r.sql)) || SIG.pageWrite.test(flatSql(r.sql))))) last = -1;
      let at = last;
      while (at > 0 && turn(recs[at - 1]!)) at--;
      const applyEnd = at >= 0 ? recs[at]!.t : t.end;
      const members = Math.max(1, t.members);
      rows.push({ members, apply: applyEnd - t.start, turn: at >= 0 ? end(recs[last]!) - recs[at]!.t : null, polls: at >= 0 ? recs.slice(at, last + 1).filter(isStatement).length : 0,
        completion: at >= 0 ? t.end - end(recs[last]!) : 0, statements_per_page: (at >= 0 ? recs.slice(0, at) : recs).filter(isStatement).length / members,
        describes: recs.filter(r => r.kind === 'describe').length, committed: t.committed });
    }
    const events = groups.flatMap(t => [{ t: t.start, d: 1 }, { t: t.end, d: -1 }]).sort((a, b) => a.t - b.t || a.d - b.d);
    let open = 0, prev = 0;
    for (const e of events) {
      if (open > 0) { const dt = e.t - prev; busyMs += dt; weighted += open * dt; dist.set(open, (dist.get(open) ?? 0) + dt); }
      open += e.d; prev = e.t; maxBusy = Math.max(maxBusy, open);
    }
  }
  const p = (xs: number[]) => ({ p50: pct(xs, 50), p95: pct(xs, 95) });
  const turns = rows.flatMap(r => r.turn === null ? [] : [r.turn]);
  return {
    group_txns: rows.length, committed: rows.filter(r => r.committed).length, with_turn_wait: turns.length,
    apply_ms: p(rows.map(r => r.apply)), turn_wait_ms: { ...p(turns), total: round1(sum(turns)) }, turn_polls_p50: pct(rows.filter(r => r.turn !== null).map(r => r.polls), 50),
    completion_ms: p(rows.map(r => r.completion)), apply_statements_per_page: p(rows.map(r => r.statements_per_page)),
    describes_per_group: { ...p(rows.map(r => r.describes)), mean: mean(rows.map(r => r.describes)) },
    lanes_busy: { mean: busyMs ? Math.round(100 * weighted / busyMs) / 100 : null, max: maxBusy, busy_ms: round1(busyMs),
      distribution_pct: Object.fromEntries([...dist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, round1(100 * v / busyMs)])) },
    rules: { lane: RULES.lane },
  };
}

/** Describe round trips per connection over the run, and per single (put_page-sized) publication transaction, by process family. */
export function describeRoundTrips(records: TraceRecord[]): Record<string, unknown> {
  const conns = [...groupBy(records, r => `${r.pid}:${r.conn}`).values()].map(rs => ({ family: family(rs[0]!.label), describes: rs.filter(r => r.kind === 'describe').length }));
  const singles = [...groupBy(records, r => r.pid).values()].flatMap(rs => transactions(rs).txns.filter(t => t.type === 'publication' && !t.group));
  const byFamily = (xs: Array<{ family: string; describes: number }>) => Object.fromEntries([...groupBy(xs, x => x.family).entries()].map(([f, list]) => [f, {
    n: list.length, describes: sum(list.map(x => x.describes)), mean: mean(list.map(x => x.describes)), p50: pct(list.map(x => x.describes), 50), max: pct(list.map(x => x.describes), 100) }]));
  return { connections: conns.length, describes: sum(conns.map(c => c.describes)), per_connection: { p50: pct(conns.map(c => c.describes), 50), p95: pct(conns.map(c => c.describes), 95), max: pct(conns.map(c => c.describes), 100) },
    per_connection_by_process: byFamily(conns),
    per_single_publication_by_process: byFamily(singles.map(t => ({ family: family(t.label), describes: t.records.filter(r => r.kind === 'describe').length }))) };
}

/** Per-put_page span timeline from the foreground process's records (RULES.foreground_spans); p50/p95 per span. */
export function foregroundSpans(records: TraceRecord[], writes: Array<{ t: number; ms: number }>): Record<string, unknown> {
  const fg = records.filter(r => family(r.label) === 'foreground');
  const txns = [...groupBy(fg, r => r.pid).values()].flatMap(rs => transactions(rs).txns).sort((x, y) => x.start - y.start);
  const of = (type: TxnType) => txns.filter(t => t.type === type && !t.group);
  const admissions = of('admission'), claims = of('claim'), recoveries = of('recovery'), pubs = of('publication');
  const used = new Set<Txn>();
  const latest = (list: Txn[], from: number, to: number) => list.filter(t => !used.has(t) && t.start >= from && t.end <= to).at(-1);
  const ordered = writes.map(w => ({ from: w.t - w.ms, to: w.t })).sort((x, y) => x.from - y.from);
  let overlapping = 0;
  for (let i = 1; i < ordered.length; i++) if (ordered[i - 1]!.to > ordered[i]!.from) overlapping++;
  const spans: Record<string, number[]> = { pre_admission: [], admission: [], admission_claim: [], preparation: [], recovery: [], publication: [], visible: [], total: [] };
  const describes: number[] = [];
  let here = 0, elsewhere = 0, unmatched = 0, k = 0;
  const matched = ordered.map(w => {
    while (k < admissions.length && admissions[k]!.start < w.from) k++;
    const adm = k < admissions.length && admissions[k]!.start < w.to ? admissions[k++]! : null;
    if (adm) used.add(adm);
    return { w, adm };
  });
  for (const { w, adm } of [...matched].sort((x, y) => x.w.to - y.w.to)) {
    if (!adm) { unmatched++; continue; }
    spans.pre_admission!.push(adm.start - w.from);
    spans.admission!.push(adm.end - adm.start);
    spans.total!.push(w.to - w.from);
    const pub = latest(pubs, adm.end, w.to);
    const claim = pub ? latest(claims, adm.end, pub.start) : undefined;
    if (!pub || !claim) { elsewhere++; spans.visible!.push(w.to - adm.end); continue; }
    here++;
    used.add(pub); used.add(claim);
    const rec = latest(recoveries, claim.end, pub.start);
    if (rec) { used.add(rec); spans.recovery!.push(rec.end - rec.start); }
    spans.admission_claim!.push(claim.end - adm.start);
    spans.preparation!.push(pub.start - claim.end);
    spans.publication!.push(pub.end - pub.start);
    spans.visible!.push(w.to - pub.end);
    describes.push(pub.records.filter(r => r.kind === 'describe').length);
  }
  return { writes: writes.length, overlapping, unmatched, published_here: here, published_elsewhere_or_pending: elsewhere,
    publication_describes: { p50: pct(describes, 50), p95: pct(describes, 95), mean: mean(describes) },
    spans_ms: Object.fromEntries(Object.entries(spans).map(([key, xs]) => [key, { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95) }])),
    rules: { foreground_spans: RULES.foreground_spans } };
}

/** Commit times of published pages in a trace (RULES.steady_rate), sorted. */
export function commitTimes(records: TraceRecord[]): number[] {
  const out: number[] = [];
  const foreground = records.some(r => family(r.label) === 'foreground');
  for (const rs of groupBy(records, r => r.pid).values()) for (const t of transactions(rs).txns) {
    if (t.type !== 'publication' || !t.committed) continue;
    if (t.group) for (let i = 0; i < Math.max(1, t.members); i++) out.push(t.end);
    else if (!foreground && SYNC_FAMILIES.has(family(t.label))) out.push(t.end);
  }
  return out.sort((a, b) => a - b);
}

/** Steady-state pages/min between the 10% and 90% committed marks, and the time from `start` to the first commit. */
export function steadyRate(times: number[], start: number | null): Record<string, number | null> {
  const n = times.length;
  const first = start === null || !n ? null : round1(times[0]! - start);
  if (n < 2) return { committed: n, pages_per_min_10_90: null, window_s: null, first_commit_ms: first };
  const i10 = Math.max(0, Math.ceil(0.1 * n) - 1), i90 = Math.max(0, Math.ceil(0.9 * n) - 1);
  const dt = times[i90]! - times[i10]!;
  return { committed: n, pages_per_min_10_90: dt > 0 ? round1((i90 - i10) / (dt / 60_000)) : null, window_s: round1(dt / 1000), first_commit_ms: first };
}

/** First record of the first sync process: the start the steady-state rate's first commit is measured from. */
export function syncStart(records: TraceRecord[]): number | null {
  let t: number | null = null;
  for (const r of records) if (SYNC_FAMILIES.has(family(r.label)) && (t === null || r.t < t)) t = r.t;
  return t;
}

/**
 * Per put_page: the foreground process's admission, claim and single
 * publication transactions inside the write's window, and every record it sent
 * in that window (including its consumer's background work). `published_here`
 * keeps the writes its own consumer published; the others were published by
 * another process (the sync process's consumer) while it waited.
 */
export function foregroundRoundTrips(records: TraceRecord[], writes: Array<{ t: number; ms: number }>): Record<string, unknown> {
  const fg = records.filter(r => family(r.label) === 'foreground').sort(byStart);
  const txns = [...groupBy(fg, r => r.pid).values()].flatMap(rs => transactions(rs).txns)
    .filter(t => t.type === 'admission' || t.type === 'claim' || (t.type === 'publication' && !t.group));
  const per = writes.map(w => {
    const from = w.t - w.ms;
    const own = txns.filter(t => t.start >= from && t.start < w.t);
    return { write: cost(own.flatMap(t => t.records)), txns: own.length, here: own.some(t => t.type === 'publication'), window: cost(inWindow(fg, from, w.t)) };
  });
  const p = (xs: number[]) => ({ p50: pct(xs, 50), p95: pct(xs, 95) });
  const stats = (xs: typeof per) => ({ writes: xs.length, write_txns_p50: pct(xs.map(x => x.txns), 50),
    write_txn_statements: p(xs.map(x => x.write.statements)), write_txn_waves: p(xs.map(x => x.write.waves)),
    window_statements: p(xs.map(x => x.window.statements)), window_waves: p(xs.map(x => x.window.waves)) });
  return { ...stats(per), published_here: stats(per.filter(x => x.here)) };
}

const cell = (v: unknown) => v === null || v === undefined ? '—' : String(v);
function table(head: string[], rows: unknown[][]): string {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)].join('\n');
}

/** Markdown tables for the log and `--analyze`. */
export function renderAnalysis(cp: Record<string, unknown>, pub: Record<string, unknown>): string {
  const phases = cp.phases as PhaseRow[];
  const check = cp.wave_check as Record<string, number | null>;
  const out = [`Critical path (sync process, ${cell(cp.pages)} pages; * = concurrent with other phases)`,
    table(['phase', 'n', 'wall ms', 'wall p50', 'stmts', 'stmts p50', 'waves', 'waves p50', 'describes', 'stmts/page', 'waves/page'],
      phases.map(p => [p.phase + (p.concurrent ? '*' : ''), p.occurrences, p.wall_ms_total, p.wall_ms_p50, p.statements, p.statements_p50, p.waves, p.waves_p50, p.describes, p.statements_per_page, p.waves_per_page])),
    `Wave check: ${cell(check.sync_waves)} waves for ${cell(check.sync_statements)} statements, ${cell(check.ms_per_wave)} ms per wave; publication wall ${cell(check.publication_wall_ms_per_wave)} ms per wave.`];
  const fit = pub.fit as { waves: Fit | null; statements: Fit | null };
  const chain = pub.steady_member_chain as Record<string, number | null>;
  const first = pub.first_member_chain as Record<string, number | null>;
  const hold = pub.counter_hold as Record<string, unknown> & { fit: Record<string, Fit | null> };
  const completion = pub.completion_per_member as Record<string, number | null>;
  const f = (x: Fit | null) => x ? `${x.fixed} + ${x.per_member}/member (r2 ${cell(x.r2)}, n ${x.n})` : '—';
  out.push(`\nGroup publication (${cell(pub.committed)} committed, ${cell(pub.rolled_back)} rolled back, ${cell(pub.members_total)} members)`,
    table(['members', 'txns', 'stmts p50', 'waves p50', 'describes p50', 'wall ms p50', 'hold stmts p50', 'hold waves p50', 'hold ms p50'],
      (pub.by_members as Array<Record<string, number | null>>).map(m => [m.members, m.transactions, m.statements_p50, m.waves_p50, m.describes_p50, m.wall_ms_p50, m.hold_statements_p50, m.hold_waves_p50, m.hold_ms_p50])),
    table(['measure', 'value'], [
      ['waves per transaction', f(fit.waves)], ['statements per transaction', f(fit.statements)],
      ['steady member chain (stmts / waves / describes)', `${cell(chain.statements_mean)} / ${cell(chain.waves_mean)} / ${cell(chain.describes_mean)} over ${cell(chain.segments)} segments`],
      ['first member chain (stmts / waves / describes)', `${cell(first.statements_mean)} / ${cell(first.waves_mean)} / ${cell(first.describes_mean)}`],
      ['completion per member (stmts / waves)', `${cell(completion.statements)} / ${cell(completion.waves)}`],
      ['per-page publication (stmts / waves)', `${cell(pub.per_page_publication_statements)} / ${cell(pub.per_page_publication_round_trips)}`],
      ['counter hold stmts p50 / max', `${cell(hold.statements_p50)} / ${cell(hold.statements_max)}; ${f(hold.fit.statements)}`],
      ['counter hold waves p50 / max', `${cell(hold.waves_p50)} / ${cell(hold.waves_max)}; ${f(hold.fit.waves)}`],
      ['counter hold ms p50 / max', `${cell(hold.ms_p50)} / ${cell(hold.ms_max)}; ${f(hold.fit.ms)}`],
    ]));
  return out.join('\n');
}

/** Markdown tables for the Phase 0 fields: feeder, lanes, describes, steady-state rate and foreground spans. */
export function renderPhase0(fields: { feeder?: Record<string, unknown>; lanes?: Record<string, unknown>; describes?: Record<string, unknown>; steady?: Record<string, unknown>; spans?: Record<string, Record<string, unknown>> }): string {
  const out: string[] = [];
  const f = fields.feeder;
  if (f) {
    const time = f.time_ms as Record<string, number | null>;
    const buckets = f.buckets as Record<string, Bucket & { per_entry: Record<string, number | null> | null; per_group: Record<string, number | null> | null; per_page: Record<string, number | null> | null }>;
    const w = (x: Record<string, number | null> | null) => x ? `${cell(x.statements)} / ${cell(x.waves)}` : '—';
    out.push(`\nFeeder (sync loop): ${cell(f.groups_admitted)} groups, ~${cell(f.entries_frozen_est)} entries frozen, ${cell(f.pages)} pages; wall ${cell(time.wall)} ms, idle in awaitWrite ${cell(time.idle_await_write)} ms (${cell(time.idle_share_pct)}%), producing ${cell(time.producing)} ms`,
      table(['bucket', 'stmts', 'waves', 'describes', 'ms', 'per entry (stmts / waves)', 'per group', 'per page'],
        Object.entries(buckets).map(([k, b]) => [k, b.statements, b.waves, b.describes, b.ms, w(b.per_entry), w(b.per_group), w(b.per_page)])));
  }
  const l = fields.lanes;
  if (l && l.group_txns) {
    const q = (x: unknown) => { const v = x as Record<string, number | null>; return `${cell(v.p50)} / ${cell(v.p95)}`; };
    const busy = l.lanes_busy as Record<string, unknown>;
    out.push(`\nLane group transactions (${cell(l.group_txns)}, ${cell(l.with_turn_wait)} waited for their turn; lanes busy mean ${cell(busy.mean)}, max ${cell(busy.max)}, distribution % ${JSON.stringify(busy.distribution_pct)})`,
      table(['measure', 'p50 / p95'], [['apply ms', q(l.apply_ms)], ['turn wait ms', `${q(l.turn_wait_ms)} (total ${cell((l.turn_wait_ms as Record<string, number>).total)})`],
        ['completion ms', q(l.completion_ms)], ['apply statements per page', q(l.apply_statements_per_page)], ['describes per group', q(l.describes_per_group)]]));
  }
  const d = fields.describes;
  if (d) {
    const pc = d.per_connection as Record<string, number | null>;
    const sp = d.per_single_publication_by_process as Record<string, Record<string, number | null>>;
    out.push(`\nDescribe round trips: ${cell(d.describes)} over ${cell(d.connections)} connections (per connection p50 ${cell(pc.p50)}, p95 ${cell(pc.p95)}, max ${cell(pc.max)}); per single publication: ${Object.entries(sp).map(([k, v]) => `${k} mean ${cell(v.mean)} (n ${cell(v.n)})`).join(', ') || '—'}`);
  }
  const st = fields.steady;
  if (st) out.push(`Steady state: ${cell(st.pages_per_min_10_90)} pages/min between the 10% and 90% commits (${cell(st.window_s)} s, ${cell(st.committed)} commits); first commit ${cell(st.first_commit_ms)} ms after the sync process started.`);
  for (const [tag, sp] of Object.entries(fields.spans ?? {})) {
    const spans = sp.spans_ms as Record<string, { n: number; p50: number | null; p95: number | null }>;
    const pd = sp.publication_describes as Record<string, number | null>;
    out.push(`\nForeground ${tag} spans (${cell(sp.writes)} writes, ${cell(sp.published_here)} published by the writer, ${cell(sp.published_elsewhere_or_pending)} elsewhere or pending, ${cell(sp.overlapping)} overlapping; describes per publication p50 ${cell(pd.p50)})`,
      table(['span', 'n', 'p50 ms', 'p95 ms'], Object.entries(spans).map(([k, v]) => [k, v.n, v.p50, v.p95])));
  }
  return out.join('\n');
}
