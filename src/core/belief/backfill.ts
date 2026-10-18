/**
 * The marked history backfill (docs/designs/BELIEF_LEDGER.md section 7.2):
 * seeds history before a source's first coverage start from `page_versions`.
 * Git is not read (its history is outside purge's reach and would double this
 * pass; a later version can add it). Every row is `origin = 'backfill'`,
 * recorded at the run's time, with the historical time only in `source_time`,
 * and never certified.
 *
 * Per page, the retained version bodies before the coverage start are parsed
 * (facts and takes fences) and diffed in order; each version's transitions
 * are one publication (`page.published` plus the fact and take events), and
 * the last one closes on the body at the coverage start. A summary event
 * (`backfill`) carries `backfill_complete` and the reasons it is not.
 *
 * The payload is prepared outside the appending transaction and carries the
 * `purge_epoch` it read; the append runs under the page key, refuses when the
 * epoch moved (the page is prepared again from current, redacted versions),
 * and rechecks tombstones through `appendBeliefEvents`. Events of a key a
 * purge hid through derivation (`derived.hidden`) are appended hidden, and a
 * carrying field a purge registered from a retained version that quoted the
 * claim (`registerVersionCarriers`) is appended as the redaction marker. A
 * version whose own frontmatter is private publishes private events, whatever
 * the page's visibility is now.
 * Publication ids are derived from the page lifetime and the version row; a
 * lifetime that already has its summary is skipped, so a rerun appends
 * nothing even after versions were pruned. The lifetime is resolved under the
 * page key, and the append refuses when the page was renamed or replaced
 * since preparation.
 */
import type { BrainEngine } from '../engine.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { parseTakesFence, TAKE_RESERVATION_SOURCE } from '../takes-fence.ts';
import { opError } from '../ops/contract.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import { factKey, lifetimeRef, pageKey, sha256Hex, takeClaimHash, takeKey, valueHash } from './keys.ts';
import { appendBeliefEvents, markBeliefCommits, type BeliefEventDraft } from './append.ts';
import { readLedgerSource } from './ledger.ts';
import { resolveLifetimes } from './lifetimes.ts';
import { factValue, takeValue } from './subjects.ts';
import { coverageIntervals } from './coverage-report.ts';

export interface BackfillPageResult { slug: string; versions: number; events: number; complete: boolean; reasons: string[] }
export interface BackfillReport { source_id: string; since: string | null; pages: BackfillPageResult[]; events: number; retried: number }

interface Body { revision: string | null; source_time: string; text: string | null; private: boolean }
interface Keyed { kind: 'fact' | 'take'; key: string; value: Record<string, unknown>; vhash: string; visibility: string; claimFp: string; validFrom: string | null; validUntil: string | null }
interface Prepared { epoch: number; incarnation: string; lifetime: string; pageId: number; versions: Body[]; drafts: BeliefEventDraft[][]; publications: string[]; summary: BeliefEventDraft; complete: boolean; reasons: string[] }

const MAX_EPOCH_RETRIES = 3;
const toUuid = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
const iso = (v: unknown) => v == null ? null : new Date(v as string).toISOString();
const dateIso = (d?: string) => d ? iso(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00Z` : d) : null;

/** Keyed fence subjects of one body: active fence facts by (page, fp, visibility) and takes by (page, claim hash, ordinal). Purge registers version carriers under these keys. */
export async function bodySubjects(engine: BrainEngine, lifetime: string, text: string, pageVisibility: string): Promise<{ subjects: Keyed[]; warnings: string[] }> {
  const facts = parseFactsFence(text);
  const takes = parseTakesFence(text);
  const active = facts.facts.filter(f => f.active);
  const fps = active.length ? await engine.executeRaw<{ fp: string }>('SELECT gbrain_fact_fingerprint(c) AS fp FROM unnest($1::text[]) WITH ORDINALITY AS t(c, n) ORDER BY n',
    [active.map(f => f.claim)]) : [];
  const subject = lifetimeRef(lifetime);
  const groups = new Map<string, { raw: Parameters<typeof factValue>[0]; count: number }>();
  for (const [i, f] of active.entries()) {
    const fp = fps[i]!.fp;
    const key = factKey(subject, fp, f.visibility);
    const existing = groups.get(key);
    if (existing) { existing.count++; continue; }
    groups.set(key, { count: 1, raw: { id: 0, entity_slug: null, sms: '', entity_page_id: null, fact: f.claim, fp, kind: f.kind, visibility: f.visibility,
      notability: f.notability, context: f.context ?? null, confidence: f.confidence, valid_from: dateIso(f.validFrom), valid_until: dateIso(f.validUntil),
      claim_metric: null, claim_value: null, claim_unit: null, claim_period: null, event_type: null, dimension: null, value: null, value_hash: null, row_num: f.rowNum, tier: '' } });
  }
  const subjects: Keyed[] = [...groups].map(([key, { raw, count }]) => {
    const value = factValue(raw, subject, count);
    return { kind: 'fact', key, value, vhash: valueHash(value), visibility: raw.visibility, claimFp: raw.fp, validFrom: raw.valid_from, validUntil: raw.valid_until };
  });
  const rows = takes.takes.filter(t => t.source !== TAKE_RESERVATION_SOURCE);
  const takeFps = rows.length ? await engine.executeRaw<{ fp: string }>('SELECT gbrain_fact_fingerprint(c) AS fp FROM unnest($1::text[]) WITH ORDINALITY AS t(c, n) ORDER BY n',
    [rows.map(t => t.claim)]) : [];
  const byClaim = new Map<string, Array<{ t: typeof rows[number]; fp: string }>>();
  rows.forEach((t, i) => { const h = takeClaimHash(t.claim, t.kind, t.holder); byClaim.set(h, [...byClaim.get(h) ?? [], { t, fp: takeFps[i]!.fp }]); });
  for (const [hash, group] of byClaim) {
    group.sort((a, b) => (a.t.sinceDate ?? '').localeCompare(b.t.sinceDate ?? '') || a.t.rowNum - b.t.rowNum);
    group.forEach(({ t, fp }, ordinal) => {
      const value = takeValue({ id: 0, page_id: 0, row_num: t.rowNum, claim: t.claim, claim_fp: fp, kind: t.kind, holder: t.holder, weight: t.weight,
        since_date: t.sinceDate ?? null, until_date: t.untilDate ?? null, source: t.source ?? null, active: t.active, resolved_at: dateIso(t.resolvedAt),
        resolved_outcome: t.resolvedOutcome ?? null, resolved_value: t.resolvedValue ?? null, resolved_unit: t.resolvedUnit ?? null,
        resolved_source: t.resolvedEvidence ?? null, resolved_by: t.resolvedBy ?? null, resolved_quality: t.resolvedQuality ?? null, tier: '' });
      subjects.push({ kind: 'take', key: takeKey(lifetime, hash, ordinal), value, vhash: valueHash(value), visibility: pageVisibility, claimFp: fp, validFrom: null, validUntil: null });
    });
  }
  return { subjects, warnings: [...facts.warnings, ...takes.warnings] };
}

/** Reads one page's retained versions before `since` and builds its backfill publications, under the epoch it read. */
async function preparePage(engine: BrainEngine, sourceId: string, slug: string, since: string, hidden: ReadonlySet<string>): Promise<Prepared | null> {
  const source = await readLedgerSource(engine, sourceId);
  if (!source) return null;
  const [page] = await engine.executeRaw<{ id: number; created_at: string; large: boolean; visible: boolean; compiled_truth: string | null; timeline: string | null; revision: string }>(`SELECT p.id, p.created_at, p.knowledge_revision::text AS revision,
      p.body_storage = 'segmented' AS large, p.compiled_truth, p.timeline, (${privatePagesFilterFragment('p')}) AS visible
    FROM pages p WHERE p.source_id = $1 AND p.slug = $2`, [sourceId, slug]);
  if (!page) return null;
  const lifetime = await engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    return (await resolveLifetimes(tx, [{ sourceId, incarnation: source.incarnation, slug, pageId: Number(page.id) }])).get(Number(page.id))!;
  });
  const versions = await engine.executeRaw<{ id: number; snapshot_at: string; revision: string | null; compiled_truth: string | null; timeline: string | null; segmented: boolean; private: boolean }>(`SELECT v.id,
      v.snapshot_at, v.knowledge_revision::text AS revision, v.compiled_truth, v.timeline, v.body_storage = 'segmented' AS segmented,
      (COALESCE(v.frontmatter->>'visibility', '') = 'private' OR COALESCE(v.frontmatter ? 'pinned_question', false)) AS private
    FROM page_versions v WHERE v.page_id = $1 ORDER BY v.snapshot_at, v.id`, [page.id]);
  if (new Date(page.created_at).getTime() > Date.parse(since)) return null;
  const before = versions.filter(v => new Date(v.snapshot_at).getTime() <= Date.parse(since));
  const reasons: string[] = [];
  if (page.large || versions.some(v => v.segmented)) reasons.push('large_page_versions_pruned');
  const closing = versions.find(v => new Date(v.snapshot_at).getTime() > Date.parse(since));
  const text = (v: { segmented: boolean; compiled_truth: string | null; timeline: string | null }) => v.segmented || v.compiled_truth == null ? null : `${v.compiled_truth}\n${v.timeline ?? ''}`;
  const bodies: Body[] = before.map((v, i) => ({ revision: v.revision, source_time: i === 0 ? iso(page.created_at)! : iso(before[i - 1]!.snapshot_at)!, text: text(v), private: v.private === true }));
  const atStart: Body = { revision: closing ? closing.revision : page.revision, source_time: before.length ? iso(before.at(-1)!.snapshot_at)! : iso(page.created_at)!,
    text: closing ? text(closing) : page.large ? null : `${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`, private: closing?.private === true };
  const chain = [...bodies, atStart];
  const drafts: BeliefEventDraft[][] = [];
  const publications: string[] = [];
  let prior: Keyed[] = [];
  let priorRevision: string | null = null;
  const stateHash = sha256Hex(`backfill:${lifetime}`);
  const visibility = page.visible === true ? 'world' : 'private';
  const base = { sourceId, incarnation: source.incarnation, lifetime, slug, stream: slug, stateHash, tierBasis: 'unknown' as const, trustTier: 'unknown' };
  for (const [i, body] of chain.entries()) {
    if (body.text == null) { reasons.push('segmented_version_body'); priorRevision = body.revision; continue; }
    const bodyVisibility = body.private ? 'private' : visibility;
    const { subjects, warnings } = await bodySubjects(engine, lifetime, body.text, bodyVisibility);
    if (warnings.length) reasons.push('fence_parse_warnings');
    const cause = { op: 'backfill', version: i < bodies.length ? Number(before[i]!.id) : closing ? Number(closing.id) : null, at_coverage_start: i === bodies.length };
    const out: BeliefEventDraft[] = [{ ...base, subjectKind: 'page', subjectKey: pageKey(lifetime), eventType: 'page.published', visibility: bodyVisibility,
      value: { revision_before: priorRevision, revision_after: body.revision, ...(i === 0 ? { snapshot: false } : {}) }, sourceTime: body.source_time, cause }];
    const priorMap = new Map(prior.map(s => [s.key, s]));
    const nowMap = new Map(subjects.map(s => [s.key, s]));
    const draft = (s: Keyed, eventType: string, value: Record<string, unknown> | null, priorHash: string | null) => out.push({ ...base, subjectKind: s.kind,
      subjectKey: s.key, eventType, visibility: s.visibility, value, priorHash, claimFp: s.claimFp, validFrom: s.validFrom, validUntil: s.validUntil,
      sourceTime: body.source_time, cause, ...(hidden.has(s.key) ? { purged: true } : {}) });
    for (const [key, s] of priorMap) if (!nowMap.has(key)) draft(s, `${s.kind}.retracted`, null, s.vhash);
    for (const [key, s] of nowMap) {
      const was = priorMap.get(key);
      if (!was) draft(s, `${s.kind}.asserted`, s.value, null);
      else if (was.vhash !== s.vhash) draft(s, `${s.kind}.revised`, s.value, was.vhash);
    }
    drafts.push(out);
    publications.push(i < bodies.length ? `version:${before[i]!.id}` : closing ? `version:${closing.id}` : 'current');
    prior = subjects;
    priorRevision = body.revision;
  }
  const complete = reasons.length === 0;
  const summary: BeliefEventDraft = { ...base, subjectKind: 'page', subjectKey: pageKey(lifetime), eventType: 'backfill', visibility,
    value: { backfill_complete: complete, versions: before.length, reasons: [...new Set(reasons)].sort(), coverage_start: since }, sourceTime: bodies[0]?.source_time ?? null,
    cause: { op: 'backfill', purge_epoch: source.purgeEpoch } };
  return { epoch: source.purgeEpoch, incarnation: source.incarnation, lifetime, pageId: Number(page.id), versions: chain, drafts, publications, summary, complete, reasons: [...new Set(reasons)].sort() };
}

/** Appends one prepared page under its key; refuses (`belief_stale_preparation`) when a purge moved the source's epoch since preparation. */
async function appendPrepared(engine: BrainEngine, sourceId: string, slug: string, prepared: Prepared): Promise<{ events: number; publications: string[] }> {
  const publications: string[] = [];
  const events = await engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId, slug }]);
    const source = await readLedgerSource(tx, sourceId);
    if (!source || source.incarnation !== prepared.incarnation) return 0;
    if (source.purgeEpoch !== prepared.epoch) {
      throw opError('belief_stale_preparation', `A purge ran in source ${sourceId} after the backfill of ${slug} was prepared.`,
        'The backfill prepares the page again from the current, redacted versions; rerun gbrain beliefs backfill if it gave up.');
    }
    const [open] = await tx.executeRaw<{ id: number; page_lifetime: string | null }>(`SELECT p.id, l.page_lifetime::text AS page_lifetime FROM pages p
      LEFT JOIN belief_page_lifetimes l ON l.source_incarnation = $2::uuid AND l.slug = p.slug AND l.ended_at IS NULL WHERE p.source_id = $1 AND p.slug = $3`,
    [sourceId, source.incarnation, slug]);
    if (Number(open?.id) !== prepared.pageId || open?.page_lifetime !== prepared.lifetime) {
      throw opError('belief_stale_preparation', `The page at ${slug} in source ${sourceId} was renamed or replaced after its backfill was prepared.`,
        'The backfill prepares the page again; rerun gbrain beliefs backfill if it gave up.');
    }
    const [done] = await tx.executeRaw<{ id: number }>(`SELECT id FROM belief_events WHERE page_lifetime = $1::uuid AND event_type = 'backfill' LIMIT 1`, [prepared.lifetime]);
    if (done) return 0;
    let n = 0;
    for (const [i, group] of [...prepared.drafts, [prepared.summary]].entries()) {
      const publicationId = toUuid(sha256Hex(`backfill\u0000${prepared.lifetime}\u0000${prepared.publications[i] ?? 'summary'}`));
      const appended = await appendBeliefEvents(tx, group, { publicationId, origin: 'backfill', purgesPossible: source.purgesPossible });
      if (appended) publications.push(publicationId);
      n += appended;
    }
    return n;
  });
  return { events, publications };
}

/**
 * Backfills history before the source's first coverage start. Requires an
 * enabled source (the coverage start is the cut). `slugs` limits the pages;
 * `prepareHook` (tests) runs between preparation and append.
 */
export async function backfillBeliefHistory(engine: BrainEngine, sourceId: string,
  opts: { slugs?: string[]; prepareHook?: (slug: string, attempt: number) => Promise<void> } = {}): Promise<BackfillReport> {
  const [first] = await coverageIntervals(engine, sourceId);
  if (!first) {
    throw opError('belief_coverage_required', `The belief ledger is not enabled on source ${sourceId}, so there is no coverage start to backfill before.`,
      `Ask the user, then run gbrain beliefs enable --source ${sourceId} first.`);
  }
  const since = first.started_at;
  const slugs = opts.slugs ?? (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id = $1 ORDER BY slug', [sourceId])).map(r => r.slug);
  const report: BackfillReport = { source_id: sourceId, since, pages: [], events: 0, retried: 0 };
  const hiddenKeys = async () => new Set((await engine.executeRaw<{ subject_key: string }>(`SELECT DISTINCT subject_key FROM belief_events
    WHERE source_id = $1 AND event_type = 'derived.hidden'`, [sourceId])).map(r => r.subject_key));
  let hidden = await hiddenKeys();
  for (const slug of slugs) {
    for (let attempt = 0; ; attempt++) {
      const prepared = await preparePage(engine, sourceId, slug, since, hidden);
      if (!prepared) break;
      await opts.prepareHook?.(slug, attempt);
      try {
        const { events, publications } = await appendPrepared(engine, sourceId, slug, prepared);
        if (publications.length) await markBeliefCommits(engine, publications);
        report.pages.push({ slug, versions: prepared.versions.length, events, complete: prepared.complete, reasons: prepared.reasons });
        report.events += events;
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== 'belief_stale_preparation' || attempt + 1 >= MAX_EPOCH_RETRIES) throw error;
        report.retried++;
        hidden = await hiddenKeys();
      }
    }
  }
  return report;
}
