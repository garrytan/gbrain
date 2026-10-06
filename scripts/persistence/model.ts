/**
 * The crash robot's reference model: an independent temporal oracle. It
 * derives expectations from durable receipts (request id -> revision) plus a
 * small state model of page identities, revisions, markers, withdrawals and
 * supersession chains. Committed visibility is checked at the observation
 * point (right after the caller saw the receipt); afterwards only legal
 * transitions are allowed: a page's revision moves only when a committed op
 * touched that page, and a withdrawn fact never becomes visible again.
 *
 * Documented exceptions: `remember` without an entity page writes a DB-only
 * fact (src/core/persistence/memory-mutations.ts) and has no fence row; an
 * explicit `remember` of a withdrawn claim is a new assertion, not a resurrection.
 */
import type { EffectKind } from '../../src/core/persistence/effect-model.ts';
import { EFFECT_FAULT_POINTS, type FaultPoint } from '../../src/core/persistence/fault-points.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { parseTakesFence } from '../../src/core/takes-fence.ts';
import { isRegistryCode } from '../../src/core/error-catalogue.ts';
import { CONNECTOR_SLUG, contextFor, retryingRead, type OpDescriptor, type OpKind, type OpObservation, type World } from './ops.ts';

/**
 * How the generator reaches each effect kind's mid-effect seam: the op that
 * queues it. A new effect kind without an entry fails typecheck.
 * facts-backstop is queued only when facts extraction is configured; keyless
 * robot brains never queue it, so its seam is exercised by the facts drain.
 * links is queued only for remote (untrusted) page writes; its seam is
 * exercised whenever the generator's put_page runs as a remote caller.
 */
export const EFFECT_SEAMS = {
  git: { op: 'put_page', point: EFFECT_FAULT_POINTS.git },
  embedding: { op: 'put_page', point: EFFECT_FAULT_POINTS.embedding },
  'withdrawal-mirror': { op: 'forget', point: EFFECT_FAULT_POINTS['withdrawal-mirror'] },
  'facts-backstop': { op: 'put_page', point: EFFECT_FAULT_POINTS['facts-backstop'] },
  links: { op: 'put_page', point: EFFECT_FAULT_POINTS.links },
} as const satisfies Record<EffectKind, { op: OpKind; point: FaultPoint }>;

/** Non-error outcomes a sync or connector run reports as its status (not error codes). */
const EXTERNAL_RESULT_CODES = new Set(['blocked_by_failures', 'dry_run']);

/**
 * Findings outside the safety classes, filed in TODOS.md with a skipped test,
 * stay visible in the manifest (`deferred`) without failing the gate.
 */
export const KNOWN_DEFERRALS: { class: ViolationClass; match: RegExp; todo: string }[] = [
  { class: 'untyped_error', match: /\(internal_error\)[\s\S]*(LockUnavailableError|SyncLockBusyError)/,
    todo: 'TODOS.md "A held sync lock reaches agents as internal_error"' },
];

export type ViolationClass = 'lost_write' | 'duplicate_apply' | 'untrue_receipt' | 'wedge' | 'withdrawal_permanence'
  | 'source_isolation' | 'authorization' | 'caller_bound_replay' | 'projection_drift' | 'missing_attribution' | 'orphan_rows' | 'effects_not_terminal'
  | 'untyped_error' | 'lock_order';
/** Violations that always block a ship (see the plan's bug-fix bound). */
export const SAFETY_CLASSES: ReadonlySet<ViolationClass> = new Set(['lost_write', 'duplicate_apply', 'untrue_receipt', 'wedge',
  'withdrawal_permanence', 'source_isolation', 'authorization', 'caller_bound_replay']);
export interface Violation { class: ViolationClass; op?: string; detail: string }

interface PageModel { live: boolean; revision: string | null; markers: Set<string>; lastMarker: string | null }
interface FactModel { id: string; source: string; text: string; entity: string; withdrawn: boolean; op: string }

const MARKER = /mk-[a-z]+\d+/g;
const key = (source: string, slug: string) => `${source}\u0000${slug}`;
function memberMarkersOf(members: { d: OpDescriptor }[]): string[] { return members.flatMap(x => markersIn(JSON.stringify(x.d.args))); }
function markersIn(text: string | undefined | null): string[] { return text ? [...text.matchAll(MARKER)].map(m => m[0]) : []; }
/** The newest page-body marker: edits insert theirs right after "Marker: ". */
function bodyMarker(text: string | undefined | null): string | null { return /Marker: (mk-[a-z]+\d+)/.exec(text ?? '')?.[1] ?? null; }

export class ReferenceModel {
  pages = new Map<string, PageModel>();
  facts = new Map<string, FactModel>();
  /** Marker -> source of the committed op that introduced it. */
  committedMarkers = new Map<string, string>();
  /** Markers of ops that were refused: they must never become visible. */
  refusedMarkers = new Set<string>();
  /** Re-asserted withdrawn claims (an explicit remember after forget). */
  reasserted = new Set<string>();
  violations: Violation[] = [];
  /** Pages a committed op touched in the current step: their revision may move. */
  touched = new Set<string>();
  revoked = new Set<string>();
  /** Accepted but not yet terminal when the caller stopped waiting: settled by `settlePending`. */
  pending = new Map<string, OpDescriptor>();

  constructor(readonly world: World) {}
  violate(v: Violation) { this.violations.push(v); }

  /** Durable model state, so a worker started after a SIGKILL continues the same oracle. */
  toJSON(): Record<string, unknown> {
    return { pages: [...this.pages].map(([k, p]) => [k, { ...p, markers: [...p.markers] }]), facts: [...this.facts],
      committedMarkers: [...this.committedMarkers], refusedMarkers: [...this.refusedMarkers], reasserted: [...this.reasserted],
      revoked: [...this.revoked], violations: this.violations, pending: [...this.pending] };
  }
  static fromJSON(world: World, state: Record<string, any>): ReferenceModel {
    const m = new ReferenceModel(world);
    m.pages = new Map(state.pages.map(([k, p]: [string, any]) => [k, { ...p, markers: new Set(p.markers) }]));
    m.facts = new Map(state.facts); m.committedMarkers = new Map(state.committedMarkers);
    m.refusedMarkers = new Set(state.refusedMarkers); m.reasserted = new Set(state.reasserted);
    m.revoked = new Set(state.revoked); m.violations = state.violations; m.pending = new Map(state.pending ?? []);
    return m;
  }
  /** An interrupted op whose outcome is unknown: its marker may legally be visible, in its own source only. */
  uncertain(d: OpDescriptor): void {
    const marker = markersIn(JSON.stringify(d.args)).at(-1);
    if (!marker) return;
    this.refusedMarkers.delete(marker); this.committedMarkers.set(marker, d.source);
    const slug = d.kind === 'connector_publish' ? CONNECTOR_SLUG : d.args.slug;
    if (typeof slug === 'string') this.pages.delete(key(d.source, slug));
  }
  /** Pages an in-flight op names: a crash may or may not have committed it, so their revision may move. */
  allowInFlight(ops: OpDescriptor[]): void {
    for (const d of ops) {
      const slug = d.kind === 'connector_publish' ? CONNECTOR_SLUG : d.args.slug ?? d.args.entity;
      if (typeof slug === 'string') this.touched.add(key(d.source, slug));
      if (d.kind === 'forget') for (const f of this.facts.values()) if (f.source === d.source) this.touched.add(key(f.source, f.entity));
    }
  }
  /** Forget pending page-liveness expectations an in-flight delete/restore may have settled either way. */
  relaxInFlight(ops: OpDescriptor[]): void {
    for (const d of ops) if (['delete_page', 'restore_page', 'put_page', 'sync'].includes(d.kind) && typeof d.args.slug === 'string') {
      this.pages.delete(key(d.source, d.args.slug));
    }
  }

  page(source: string, slug: string): PageModel {
    let p = this.pages.get(key(source, slug));
    if (!p) { p = { live: false, revision: null, markers: new Set(), lastMarker: null }; this.pages.set(key(source, slug), p); }
    return p;
  }

  /** Ops of the current concurrent group: their observation-point checks wait for `settleGroup`. */
  private deferred = false;

  /** Fold one observed op into the model and check its observation-point promises. */
  async observe(d: OpDescriptor, o: OpObservation, original?: OpObservation): Promise<void> {
    const marker = markersIn(JSON.stringify(d.args)).at(-1) ?? null;
    if (d.replayOf && original) {
      await this.checkReplay(d, o, original);
      // A same-principal replay returns the original receipt; it is not a new write.
      if (d.actor === original.actor) return;
    }
    if (d.actor !== 'local' && this.revoked.has(d.actor) && o.status === 'committed') {
      this.violate({ class: 'authorization', op: d.id, detail: `${d.kind} by revoked ${d.actor} committed` });
    }
    if (o.status === 'pending') { this.pending.set(d.id, d); return; }
    this.pending.delete(d.id);
    if (o.status !== 'committed') {
      if (marker && !this.committedMarkers.has(marker)) this.refusedMarkers.add(marker);
      // The agent sees the MCP envelope: its code must be a registered one, and not the unknown-failure fallback.
      const agentCode = o.agentCode ?? o.code;
      if (o.status === 'refused' && agentCode !== 'http:401' && (!agentCode || !isRegistryCode(agentCode) || agentCode === 'internal_error') && !EXTERNAL_RESULT_CODES.has(o.code ?? '')) {
        this.violate({ class: 'untyped_error', op: d.id, detail: `${d.kind} failed without a registered agent error code (${agentCode}): ${JSON.stringify(o.raw).slice(0, 300)}` });
      }
      return;
    }
    if (marker) { this.committedMarkers.set(marker, d.source); this.refusedMarkers.delete(marker); }
    await MODEL[d.kind](this, d, o);
  }

  /** Start of a step: pages a committed op touches during this step (or a pending op names) may move their revision. */
  beginStep(concurrent: boolean): void {
    this.touched.clear(); this.deferred = concurrent;
    this.allowInFlight([...this.pending.values()]);
  }
  get deferringVisibility(): boolean { return this.deferred; }

  /**
   * After a concurrent group: each touched page's revision must be one a
   * committed group member returned, or the write of a committed sync or
   * connector publish (which returns no revision) whose marker the page
   * carries; every committed edit's marker is visible, and every superseded
   * member revision is in the page's history.
   */
  async settleGroup(batch: OpDescriptor[], observed: OpObservation[]): Promise<void> {
    const committed = batch.map((d, i) => ({ d, o: observed[i] })).filter(x => x.o.status === 'committed');
    const bySlug = new Map<string, typeof committed>();
    for (const x of committed) {
      const slug = x.d.kind === 'connector_publish' ? CONNECTOR_SLUG : String(x.d.args.slug ?? x.d.args.entity ?? '');
      if (slug) bySlug.set(key(x.d.source, slug), [...(bySlug.get(key(x.d.source, slug)) ?? []), x]);
    }
    for (const [k, members] of bySlug) {
      const [source, slug] = k.split('\u0000');
      const read = await this.readPage('local', source, slug);
      const revisions = members.map(x => x.o.values.revision).filter(Boolean) as string[];
      // Whole-page writers (put, sync, connector) may legally replace each other; edits and fact writes compose.
      const replacing = members.some(x => ['put_page', 'sync', 'connector_publish'].includes(x.d.kind));
      const memberMarkers = members.map(x => ['edit_page', 'put_page', 'sync', 'connector_publish'].includes(x.d.kind) ? markersIn(JSON.stringify(x.d.args)).at(-1) : null);
      const visible = markersIn(String(read?.content));
      // A sync or connector publish returns no revision: the page may end at its write when it ran after a
      // receipted member, and then carries its marker.
      const unreceiptedFinal = members.some((x, i) => ['sync', 'connector_publish'].includes(x.d.kind) && !x.o.values.revision
        && !!memberMarkers[i] && visible.includes(memberMarkers[i]!));
      if (revisions.length && !revisions.includes(String(read?.revision)) && !unreceiptedFinal) {
        this.violate({ class: 'lost_write', op: members.map(x => x.d.id).join('+'), detail: `concurrent group left ${source}/${slug} at ${String(read?.revision)}, none of the committed revisions ${revisions.join(',')}` });
      }
      if (replacing && memberMarkers.some(Boolean) && !memberMarkers.some(mk => mk && visible.includes(mk))) {
        this.violate({ class: 'lost_write', op: members.map(x => x.d.id).join('+'), detail: `no committed whole-page write of the group is visible in ${source}/${slug}` });
      }
      for (const [i, x] of members.entries()) {
        const marker = memberMarkers[i];
        if (!replacing && marker && !markersIn(String(read?.content)).includes(marker)) this.violate({ class: 'lost_write', op: x.d.id, detail: `committed concurrent ${x.d.kind} marker ${marker} is not visible` });
        if (x.o.values.revision && x.o.values.revision !== read?.revision) {
          const [kept] = await this.q<{ n: number }>(`SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id
            WHERE p.source_id=$1 AND p.slug=$2 AND v.knowledge_revision::text=$3`, [source, slug, x.o.values.revision]);
          if (!kept.n) this.violate({ class: 'untrue_receipt', op: x.d.id, detail: `committed revision ${x.o.values.revision} of ${source}/${slug} never existed` });
        }
      }
      const page = this.page(source, slug);
      page.revision = read?.revision ? String(read.revision) : null;
      if (members.some(x => ['edit_page', 'put_page', 'sync', 'connector_publish'].includes(x.d.kind))) page.lastMarker = bodyMarker(String(read?.content)) ?? markersIn(String(read?.content)).find(mk => memberMarkersOf(members).includes(mk)) ?? page.lastMarker;
    }
    this.deferred = false;
  }

  /**
   * Requests whose receipts the caller sees late (a pending write settled after
   * the drain, or an interrupted request resubmitted after a crash) were
   * committed in queue order with writes observed since. Their receipt must
   * name a revision the page really had (current or archived in page_versions);
   * the page's current state is then adopted as the model's.
   */
  async settleLate(batch: OpDescriptor[], observed: OpObservation[]): Promise<void> {
    for (const [i, d] of batch.entries()) {
      const o = observed[i];
      if (o.status !== 'committed' || !o.values.revision) continue;
      const slug = d.kind === 'connector_publish' ? CONNECTOR_SLUG : String(d.args.slug ?? d.args.entity ?? '');
      const [seen] = await this.q<{ n: number }>(`SELECT
        (SELECT count(*)::int FROM pages p WHERE p.source_id=$1 AND p.slug=$2 AND p.knowledge_revision::text=$3)
        + (SELECT count(*)::int FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND p.slug=$2 AND v.knowledge_revision::text=$3) AS n`,
      [d.source, slug, o.values.revision]);
      if (!seen.n) this.violate({ class: 'untrue_receipt', op: d.id, detail: `late receipt names revision ${o.values.revision} that ${d.source}/${slug} never had` });
    }
    for (const d of batch) {
      const slug = d.kind === 'connector_publish' ? CONNECTOR_SLUG : d.args.slug ?? d.args.entity;
      if (typeof slug !== 'string') continue;
      const page = this.page(d.source, slug); const read = await this.readPage('local', d.source, slug);
      this.touched.add(key(d.source, slug));
      page.live = read !== null; page.revision = read?.revision ? String(read.revision) : null;
      page.lastMarker = read ? bodyMarker(String(read.content)) : null;
    }
    this.deferred = false;
  }

  private async checkReplay(d: OpDescriptor, o: OpObservation, original: OpObservation): Promise<void> {
    const sameActor = d.actor === original.actor;
    const sameIntent = JSON.stringify(d.args) === JSON.stringify(this.world.descriptors?.get(original.id)?.args);
    if (!sameActor) {
      if (o.receipt && original.receipt && o.receipt.revision && o.receipt.revision === original.receipt.revision) {
        this.violate({ class: 'caller_bound_replay', op: d.id, detail: `${d.actor} replaying ${original.actor}'s request id received the original receipt` });
      }
      return;
    }
    if (sameIntent) {
      if (original.status === 'committed' && o.status !== 'committed') this.violate({ class: 'untrue_receipt', op: d.id, detail: `same-intent replay of a committed request returned ${o.status}/${o.code}` });
      if (original.status === 'committed' && o.receipt?.revision && original.receipt?.revision && o.receipt.revision !== original.receipt.revision) {
        this.violate({ class: 'duplicate_apply', op: d.id, detail: 'same-intent replay produced a new revision' });
      }
    } else if (original.status !== 'refused' && o.status === 'committed') {
      this.violate({ class: 'caller_bound_replay', op: d.id, detail: 'changed intent under one request id committed instead of idempotency_conflict' });
    }
  }

  /** Read surfaces an agent uses, under a given actor. */
  /**
   * The oracle's own reads retry a session drop the robot injected (the
   * pooler_disconnect fault); only the system under test is judged on such
   * errors, and any other close fails the run.
   */
  private retrying<T>(read: () => Promise<T>): Promise<T> { return retryingRead(this.world, read); }
  q<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]> {
    return this.retrying(() => this.world.engine.executeRaw<R>(sql, params));
  }

  /** The last read error, quoted in a violation so a failed read is never mistaken for a missing page. */
  lastReadError: string | null = null;
  async readPage(actor: string, source: string, slug: string): Promise<Record<string, unknown> | null> {
    this.lastReadError = null;
    try {
      return await this.retrying(() => operationsByName.get_page.handler(contextFor(this.world, actor, source),
        { slug, include_content: true, ...(actor === 'local' ? { source_id: source } : {}) })) as Record<string, unknown>;
    } catch (error) {
      const e = error as { code?: string; message?: string };
      this.lastReadError = `${e.code ?? 'error'}: ${String(e.message).slice(0, 160)}`;
      return null;
    }
  }
  async recall(actor: string, source: string, entity: string): Promise<string[]> {
    try {
      const r = await this.retrying(() => operationsByName.recall.handler(contextFor(this.world, actor, source),
        { entity, limit: 100, ...(actor === 'local' ? { source_id: source } : {}) })) as { facts?: { fact?: string }[] };
      return (r.facts ?? []).map(f => String(f.fact ?? ''));
    } catch { return []; }
  }

  /** Invariants over the whole brain; run after every step and after recovery. */
  async checkGlobal(stage: string): Promise<void> {
    const rows = await this.q<{ source_id: string; slug: string; compiled_truth: string; timeline: string; revision: string | null; deleted: boolean; id: number }>(
      'SELECT id,source_id,slug,compiled_truth,timeline,knowledge_revision::text AS revision,deleted_at IS NOT NULL AS deleted FROM pages');
    const seen = new Set<string>();
    for (const row of rows) {
      const k = key(row.source_id, row.slug); seen.add(k);
      for (const m of markersIn(`${row.compiled_truth}\n${row.timeline}`)) {
        const owner = this.committedMarkers.get(m);
        if (owner && owner !== row.source_id) this.violate({ class: 'source_isolation', detail: `${stage}: ${m} written to ${owner} is visible in ${row.source_id}/${row.slug}` });
        if (!owner && this.refusedMarkers.has(m)) this.violate({ class: 'untrue_receipt', detail: `${stage}: refused write ${m} is visible in ${row.source_id}/${row.slug}` });
      }
      const model = this.pages.get(k);
      if (!model) continue;
      if (model.live === row.deleted) this.violate({ class: model.live ? 'lost_write' : 'untrue_receipt', detail: `${stage}: ${row.source_id}/${row.slug} live=${!row.deleted}, model expects ${model.live}` });
      if (this.touched.has(k)) model.revision = row.revision;
      else if (model.revision && row.revision !== model.revision) {
        this.violate({ class: 'lost_write', detail: `${stage}: ${row.source_id}/${row.slug} revision ${row.revision} != last committed ${model.revision}` });
      }
      if (model.live && model.lastMarker && !markersIn(row.compiled_truth).includes(model.lastMarker)) {
        this.violate({ class: 'lost_write', detail: `${stage}: ${row.source_id}/${row.slug} lost committed marker ${model.lastMarker}` });
      }
    }
    for (const [k, model] of this.pages) if (model.live && !seen.has(k)) this.violate({ class: 'lost_write', detail: `${stage}: committed page ${k.replace('\u0000', '/')} is missing` });
    await this.checkWithdrawals(stage);
    await this.checkProjection(stage, rows.filter(r => !r.deleted));
    await this.checkAttribution(stage);
  }

  private async checkWithdrawals(stage: string): Promise<void> {
    const withdrawn = [...this.facts.values()].filter(f => f.withdrawn && !this.reasserted.has(`${f.source}\u0000${f.text}`));
    for (const fact of withdrawn) {
      const actors = ['local', ...this.world.remotes.filter(r => r.sourceId === fact.source && !this.revoked.has(r.name)).map(r => r.name)];
      for (const actor of actors) {
        if ((await this.recall(actor, fact.source, fact.entity)).includes(fact.text)) {
          this.violate({ class: 'withdrawal_permanence', op: fact.op, detail: `${stage}: withdrawn fact "${fact.text}" returned by recall for ${actor}` });
        }
      }
      const page = await this.readPage('local', fact.source, fact.entity);
      const live = parseFactsFence(String(page?.content ?? '')).facts.filter(f => !f.forgotten && f.validUntil === undefined && f.claim === fact.text);
      if (live.length) this.violate({ class: 'withdrawal_permanence', op: fact.op, detail: `${stage}: withdrawn fact "${fact.text}" is a live row in ${fact.source}/${fact.entity}'s fence` });
      const [db] = await this.q<{ n: number }>(
        'SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND fact=$2 AND expired_at IS NULL', [fact.source, fact.text]);
      if (db.n > 0) this.violate({ class: 'withdrawal_permanence', op: fact.op, detail: `${stage}: withdrawn fact "${fact.text}" has ${db.n} active row(s)` });
    }
  }

  private async checkProjection(stage: string, live: { id: number; source_id: string; slug: string }[]): Promise<void> {
    for (const row of live) {
      const page = await this.readPage('local', row.source_id, row.slug);
      const content = String(page?.content ?? '');
      const takes = parseTakesFence(content).takes;
      const dbTakes = await this.q<{ row_num: number; claim: string; active: boolean }>(
        'SELECT row_num,claim,active FROM takes WHERE page_id=$1 ORDER BY row_num', [row.id]);
      const fence = takes.map(t => `${t.rowNum}:${t.claim}:${t.active}`).sort();
      const db = dbTakes.map(t => `${t.row_num}:${t.claim}:${t.active}`).sort();
      if (JSON.stringify(fence) !== JSON.stringify(db)) this.violate({ class: 'projection_drift', detail: `${stage}: ${row.source_id}/${row.slug} takes fence ${JSON.stringify(fence)} != rows ${JSON.stringify(db)}` });
      const liveFacts = parseFactsFence(content).facts.filter(f => !f.forgotten && f.validUntil === undefined).map(f => f.claim).sort();
      const dbFacts = (await this.q<{ fact: string }>(`SELECT fact FROM facts WHERE source_id=$1 AND source_markdown_slug=$2
        AND expired_at IS NULL AND superseded_by IS NULL AND (valid_until IS NULL OR valid_until > now())`, [row.source_id, row.slug])).map(f => f.fact).sort();
      if (JSON.stringify(liveFacts) !== JSON.stringify(dbFacts)) this.violate({ class: 'projection_drift', detail: `${stage}: ${row.source_id}/${row.slug} facts fence ${JSON.stringify(liveFacts)} != rows ${JSON.stringify(dbFacts)}` });
    }
    const [orphans] = await this.q<{ takes: number; timeline: number }>(`SELECT
      (SELECT count(*)::int FROM takes t WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id=t.page_id)) AS takes,
      (SELECT count(*)::int FROM timeline_entries e WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id=e.page_id)) AS timeline`);
    if (orphans.takes || orphans.timeline) this.violate({ class: 'orphan_rows', detail: `${stage}: orphan takes=${orphans.takes} timeline=${orphans.timeline}` });
  }

  private async checkAttribution(stage: string): Promise<void> {
    const [missing] = await this.q<{ facts: number; takes: number; timeline: number; pages: number }>(`SELECT
      (SELECT count(*)::int FROM facts WHERE write_principal_kind IS NULL) AS facts,
      (SELECT count(*)::int FROM takes WHERE write_principal_kind IS NULL) AS takes,
      (SELECT count(*)::int FROM timeline_entries WHERE write_principal_kind IS NULL) AS timeline,
      (SELECT count(*)::int FROM pages WHERE deleted_at IS NULL AND revision_principal_kind IS NULL) AS pages`);
    for (const [table, n] of Object.entries(missing)) if (n) this.violate({ class: 'missing_attribution', detail: `${stage}: ${n} ${table} row(s) without write attribution` });
  }

  /** After a drain: nothing pending, every effect terminal, and a fresh write still admits (no wedge). */
  async checkDrained(stage: string): Promise<void> {
    const [pending] = await this.q<{ requests: number; effects: number }>(`SELECT
      (SELECT count(*)::int FROM persistence_requests WHERE state IN ('queued','running','recovering')) AS requests,
      (SELECT count(*)::int FROM persistence_effects WHERE state IN ('queued','running') OR recovery IS NOT NULL) AS effects`);
    if (pending.requests) this.violate({ class: 'wedge', detail: `${stage}: ${pending.requests} request(s) still pending after the drain` });
    if (pending.effects) this.violate({ class: 'effects_not_terminal', detail: `${stage}: ${pending.effects} effect(s) not terminal after the drain` });
  }
}

type Fold = (m: ReferenceModel, d: OpDescriptor, o: OpObservation) => Promise<void>;
const pageWrite = (kind: 'put' | 'edit'): Fold => async (m, d, o) => {
  const slug = String(d.args.slug); const page = m.page(d.source, slug); const k = key(d.source, slug);
  const marker = d.args.content === '$stale_content' ? bodyMarker(o.pageContent)
    : markersIn(String(d.args.content ?? JSON.stringify(d.args.edits ?? ''))).at(-1) ?? null;
  page.live = true; page.revision = o.values.revision ?? null; m.touched.add(k);
  if (kind === 'put') page.markers = new Set(markersIn(o.pageContent));
  if (marker) page.markers.add(marker);
  page.lastMarker = marker;
  if (m.deferringVisibility) return;
  const read = await m.readPage(d.actor === 'local' || m.revoked.has(d.actor) ? 'local' : d.actor, d.source, slug);
  if (!read || read.revision !== o.values.revision) {
    const [row] = await m.q<Record<string, unknown>>(`SELECT knowledge_revision::text AS revision,deleted_at IS NOT NULL AS deleted,
      source_path FROM pages WHERE source_id=$1 AND slug=$2`, [d.source, slug]);
    m.violate({ class: 'untrue_receipt', op: d.id, detail: `committed ${d.kind} revision ${o.values.revision} not visible (read ${String(read?.revision)}${m.lastReadError ? `; ${m.lastReadError}` : ''}; row ${JSON.stringify(row ?? null)})` });
  }
  else if (page.lastMarker && !markersIn(String(read.content)).includes(page.lastMarker)) m.violate({ class: 'untrue_receipt', op: d.id, detail: `committed ${d.kind} marker ${page.lastMarker} not visible` });
};
/** A write that moves a page's revision. A page the model has not seen committed (its put may still be pending) stays untracked. */
const touch = (slugOf: (d: OpDescriptor) => string): Fold => async (m, d, o) => {
  const k = key(d.source, slugOf(d)); m.touched.add(k);
  const page = m.pages.get(k);
  if (page) page.revision = o.values.revision ?? null;
};

/** A file edit picked up by sync, or a connector item: the page now carries its marker. */
function externalWrite(target: (d: OpDescriptor) => [string, string, string]): Fold {
  return async (m, d) => {
    const [source, slug, text] = target(d);
    const marker = markersIn(text).at(-1) ?? null;
    const page = m.page(source, slug); m.touched.add(key(source, slug));
    page.live = true; page.revision = null; page.lastMarker = marker;
    if (marker) { page.markers.add(marker); m.committedMarkers.set(marker, source); }
    if (m.deferringVisibility) return;
    const read = await m.readPage('local', source, slug);
    if (marker && !markersIn(String(read?.content)).includes(marker)) m.violate({ class: 'untrue_receipt', op: d.id, detail: `${d.kind} reported success but ${source}/${slug} lacks ${marker}` });
  };
}

/** One fold per op kind: how a committed observation moves the model, plus its observation-point check. */
export const MODEL: Record<OpKind, Fold> = {
  put_page: pageWrite('put'),
  edit_page: pageWrite('edit'),
  remember: async (m, d, o) => {
    const text = String(d.args.fact); const entity = String(d.args.entity ?? '');
    if (o.values.fact_id) m.facts.set(o.values.fact_id, { id: o.values.fact_id, source: d.source, text, entity, withdrawn: false, op: d.id });
    if ([...m.facts.values()].some(f => f.withdrawn && f.source === d.source && f.text === text)) m.reasserted.add(`${d.source}\u0000${text}`);
    await touch(() => entity)(m, d, o);
    const status = (o.raw as { status?: string } | undefined)?.status;
    if (!m.deferringVisibility && status !== 'duplicate' && !(await m.recall(m.revoked.has(d.actor) ? 'local' : d.actor, d.source, entity)).includes(text)) {
      m.violate({ class: 'untrue_receipt', op: d.id, detail: `committed remember "${text}" not returned by recall` });
    }
  },
  forget: async (m, d, o) => {
    const id = String((o.raw as { id?: unknown } | undefined)?.id ?? '');
    const fact = m.facts.get(id);
    if (fact) {
      if (fact.source !== d.source) m.violate({ class: 'source_isolation', op: d.id, detail: `forget in ${d.source} expired fact ${id} of ${fact.source}` });
      fact.withdrawn = true; m.reasserted.delete(`${fact.source}\u0000${fact.text}`);
      const k = key(fact.source, fact.entity); m.touched.add(k);
      const page = m.pages.get(k); if (page) page.revision = null;
    }
  },
  takes_add: touch(d => String(d.args.slug)),
  takes_supersede: touch(d => String(d.args.slug)),
  add_timeline_entry: touch(d => String(d.args.slug)),
  delete_page: async (m, d, o) => { await touch(d => String(d.args.slug))(m, d, o); m.page(d.source, String(d.args.slug)).live = false; },
  restore_page: async (m, d, o) => { await touch(d => String(d.args.slug))(m, d, o); m.page(d.source, String(d.args.slug)).live = true; },
  revoke_access: async (m, d) => { m.revoked.add(String(d.args.actor)); },
  sync: externalWrite(d => [d.source, String(d.args.slug), String(d.args.content)]),
  connector_publish: externalWrite(d => [d.source, CONNECTOR_SLUG, String(d.args.body)]),
};
