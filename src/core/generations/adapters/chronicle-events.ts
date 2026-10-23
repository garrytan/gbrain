/**
 * GBRA-161 PR 3: the Life Chronicle event adapter (kind `chronicle_event`, one owner key per depth page:
 * `depth:<slug>`). The items are the event pages a judged revision of the depth page yields, each with the timeline
 * projection row it puts on the depth page. A re-judged revision publishes a new generation: changed events are
 * versioned and overwritten, and the events it dropped retire (versioned, soft-deleted, `retired_by: life-chronicle`)
 * together with their projection rows, in the activation. Chronicle pages are database-only, so a managed source runs the
 * same activation in one coordinated request (`databaseOnly`).
 *
 * Ownership stays content-addressed (#5876): an event is the depth page's while it names that page as its depth and its
 * content hash is one the chronicle ledger recorded for it, or its identity is the one the live generation recorded. An
 * operator-edited event (any other content) and an operator-deleted one (deleted without a verified retirement) are not
 * items at all: the adapter never overwrites, retires or revives them.
 */
import type { BrainEngine } from '../../engine.ts';
import type { PageSnapshot } from '../../page-state/types.ts';
import { pageBodyBytes } from '../../page-body/page-shape.ts';
import { digest } from '../../persistence/digest.ts';
import { RESERVED_RETIREMENT_KEYS, retireDerivedPagesInTransaction } from '../../persistence/derived-retirement-hold.ts';
import { withWriteTrust } from '../../persistence/context.ts';
import { effectiveVisibility, type Visibility } from '../../search/private-visibility.ts';
import { deriveTrust, lowerDerivedPageIn } from '../../trust/taint.ts';
import { derivedGateConfig, derivedGateInput, timelineRowAllowed } from '../../trust/derived-gate.ts';
import { assessTimelineForGate, type WriteGateAssessment } from '../../write-gate.ts';
import { recordWriteGateReceipt } from '../../write-gate-store.ts';
import type { EmptySourceProof } from '../proofs.ts';
import type { GenerationAdapter, GenerationKey, InputState, ItemRow, ProposedItem } from '../contract.ts';
import { markdownItem, pageIdentityHash, pagePreimage, preimageIdentity, readPageRows, type PageRowData } from './page.ts';

export const CHRONICLE_EVENT_KIND = 'chronicle_event';
export const CHRONICLE_RETIRED_BY = 'life-chronicle';
/** Ineligibility reasons that retire a depth page's events with no model call (chronicle/ledger.ts RETIRE_REASONS). */
export const CHRONICLE_INELIGIBLE_REASONS = ['not_chronicle_shaped', 'dream_generated', 'too_short'] as const;

/** The judged depth page; publication re-checks every field. */
export interface ChronicleDepthPin {
  slug: string;
  pageId: number;
  revision: string;
  contentHash: string;
  incarnation: string;
  visibility: Visibility;
}

export function pinDepth(snapshot: PageSnapshot): ChronicleDepthPin {
  return {
    slug: snapshot.page.slug, pageId: Number(snapshot.page.id), revision: snapshot.revision,
    contentHash: String(snapshot.page.content_hash ?? ''), incarnation: snapshot.sourceIncarnation,
    visibility: effectiveVisibility({ kind: 'page', page: snapshot.page }),
  };
}

/** null while the pin holds; otherwise why the generation is superseded. `decisionRequestId`: the writer grant is rechecked too. */
export async function depthPinBroken(tx: BrainEngine, sourceId: string, pin: ChronicleDepthPin, decisionRequestId: string | null): Promise<string | null> {
  const current = await tx.readPageSnapshot(pin.slug, { sourceId });
  if (!current) return 'page_missing';
  if (Number(current.page.id) !== pin.pageId || current.revision !== pin.revision
    || String(current.page.content_hash ?? '') !== pin.contentHash || current.sourceIncarnation !== pin.incarnation
    || effectiveVisibility({ kind: 'page', page: current.page }) !== pin.visibility) return 'superseded';
  return decisionRequestId && !await grantHolds(tx, decisionRequestId) ? 'superseded' : null;
}

async function grantHolds(tx: BrainEngine, decisionRequestId: string): Promise<boolean> {
  const [request] = await tx.executeRaw<import('../../persistence/model.ts').WriteRequest>('SELECT * FROM persistence_requests WHERE id=$1::uuid', [decisionRequestId]);
  if (!request) return false;
  const { authorizeFactsBackstop } = await import('../../persistence/effect-facts.ts');
  const { OperationError } = await import('../../ops/contract.ts');
  try { await authorizeFactsBackstop(tx, request); return true; }
  catch (error) { if (error instanceof OperationError) return false; throw error; }
}

export const chronicleOwnerKey = (depthSlug: string) => `depth:${depthSlug}`;
const depthOf = (key: GenerationKey) => {
  if (!key.ownerKey.startsWith('depth:')) throw new Error(`not a chronicle owner key: ${key.ownerKey}`);
  return key.ownerKey.slice('depth:'.length);
};

/** The input pin of a judged depth page: every field the pin rechecks, so any change refuses activation (`pin_moved`). */
export const depthInputPin = (pin: ChronicleDepthPin) => digest(['chronicle-depth-v1', pin.pageId, pin.revision, pin.contentHash, pin.incarnation, pin.visibility]);

/**
 * What one publication hands the adapter: the writer grant the activation rechecks (null: none, e.g. a retire-only run),
 * and the identity of each event it proposes. An event live at exactly its proposed identity is the extractor's output,
 * so the activation recognises what this publication wrote before the chronicle ledger records its hash.
 */
export interface ChronicleGenerationContext { decisionRequestId: string | null; planned?: Record<string, string> }

/** One proposed event: the markdown its page is written from and the projection row it puts on the depth page. */
export interface ChronicleEventContent {
  markdown: string;
  title: string;
  compiledTruth: string;
  frontmatter: Record<string, unknown>;
  when: string;
  day: string;
  summary: string;
}

export function chronicleEventItem(slug: string, event: ChronicleEventContent): ProposedItem {
  return { key: slug, content: JSON.stringify(event), identityHash: markdownItem(slug, event.markdown).identityHash };
}

function safeDate(value: unknown): Date | null {
  const date = new Date(String(value ?? ''));
  return Number.isNaN(date.getTime()) ? null : date;
}

type EventRow = PageRowData & { content_hash: string | null };
type Projection = { date: string; summary: string; detail: string };

/** The depth page row (a live one first), for its id; null when it was purged. */
async function depthRow(db: BrainEngine, sourceId: string, slug: string): Promise<{ id: number; live: boolean } | null> {
  const [row] = await db.executeRaw<{ id: number; live: boolean }>(
    'SELECT id, deleted_at IS NULL AS live FROM pages WHERE source_id=$1 AND slug=$2 ORDER BY deleted_at NULLS FIRST, id DESC LIMIT 1', [sourceId, slug]);
  return row ? { id: Number(row.id), live: row.live } : null;
}

/** Every event content hash the chronicle ledger recorded for the depth page `pageId`. */
export async function ownedEventHashes(db: BrainEngine, sourceId: string, pageId: number): Promise<Set<string>> {
  const rows = await db.executeRaw<{ hash: string }>('SELECT DISTINCT unnest(event_hashes) AS hash FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2', [sourceId, pageId]);
  return new Set(rows.map(row => row.hash));
}

/** Slugs of `sourceId` the chronicle ledger records as retired by a generation (the verified half of a retirement stamp). */
async function ledgerRetired(db: BrainEngine, sourceId: string, slugs: readonly string[]): Promise<Set<string>> {
  if (!slugs.length) return new Set();
  const rows = await db.executeRaw<{ item_key: string }>(
    `SELECT DISTINCT i.item_key FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
      WHERE g.source_id=$1 AND g.kind=$2 AND i.action='retired' AND i.item_key=ANY($3::text[])`, [sourceId, CHRONICLE_EVENT_KIND, [...slugs]]);
  return new Set(rows.map(row => row.item_key));
}

/**
 * Whether a deleted event page is one the extractor retired, verified rather than read off its stamp alone: the stamp
 * names a derived retirement and either the generation ledger recorded it, or (a retirement from before the ledger) its
 * content hash is one the chronicle ledger recorded for its depth page.
 */
export async function verifiedChronicleRetirement(db: BrainEngine, sourceId: string, page: { slug: string; content_hash?: string | null; frontmatter?: Record<string, unknown> | null }): Promise<boolean> {
  const stamp = page.frontmatter?.retired_by;
  if (stamp !== CHRONICLE_RETIRED_BY && stamp !== 'generation-restore') return false;
  if ((await ledgerRetired(db, sourceId, [page.slug])).has(page.slug)) return true;
  const depth = (page.frontmatter?.event as { depth?: unknown } | undefined)?.depth;
  if (stamp !== CHRONICLE_RETIRED_BY || typeof depth !== 'string' || !page.content_hash) return false;
  const row = await depthRow(db, sourceId, depth);
  return row !== null && (await ownedEventHashes(db, sourceId, row.id)).has(String(page.content_hash));
}

async function projectionRows(db: BrainEngine, pageIds: readonly number[]): Promise<Map<number, Projection[]>> {
  const out = new Map<number, Projection[]>();
  if (!pageIds.length) return out;
  const rows = await db.executeRaw<{ event_page_id: number; date: string; summary: string; detail: string | null }>(
    'SELECT event_page_id, date::text AS date, summary, detail FROM timeline_entries WHERE event_page_id = ANY($1::bigint[]) ORDER BY date', [[...pageIds]]);
  for (const row of rows) out.set(Number(row.event_page_id), [...out.get(Number(row.event_page_id)) ?? [], { date: row.date, summary: row.summary, detail: row.detail ?? '' }]);
  return out;
}

/**
 * The event rows of `itemKeys` and every live event naming the depth page, classified: owned live events and verified
 * retirements are items; an operator-edited or operator-deleted event (or any other page at a proposed slug) is left out.
 */
async function readEventItems(db: BrainEngine, key: GenerationKey, itemKeys: readonly string[], context?: ChronicleGenerationContext): Promise<Map<string, ItemRow>> {
  const depth = depthOf(key);
  const rows = await readPageRows(db, key.sourceId, `p.slug = ANY($2::text[]) OR (p.deleted_at IS NULL AND p.type='event' AND p.frontmatter->'event'->>'depth' = $3
      AND p.frontmatter->>'captured_via' LIKE 'life-chronicle:%')`, [[...itemKeys], depth]);
  if (!rows.length) return new Map();
  const hashes = await db.executeRaw<{ slug: string; content_hash: string | null }>('SELECT slug, content_hash FROM pages WHERE source_id=$1 AND id = ANY($2::bigint[])',
    [key.sourceId, rows.map(row => row.page_id)]);
  const hashOf = new Map(hashes.map(row => [row.slug, row.content_hash]));
  const events: EventRow[] = rows.filter(row => row.type === 'event').map(row => ({ ...row, content_hash: hashOf.get(row.slug) ?? null }));
  const depthPage = await depthRow(db, key.sourceId, depth);
  const owned = depthPage ? await ownedEventHashes(db, key.sourceId, depthPage.id) : new Set<string>();
  const recorded = new Map((await db.executeRaw<{ item_key: string; identity_hash: string }>(
    `SELECT i.item_key, i.identity_hash FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
      WHERE g.source_id=$1 AND g.kind=$2 AND g.owner_key=$3 AND g.state='live' AND i.action <> 'retired'`, [key.sourceId, CHRONICLE_EVENT_KIND, key.ownerKey]))
    .map(row => [row.item_key, row.identity_hash]));
  const retired = await ledgerRetired(db, key.sourceId, events.filter(row => row.deleted).map(row => row.slug));
  const projections = await projectionRows(db, events.map(row => row.page_id));
  const out = new Map<string, ItemRow>();
  for (const row of events) {
    const fm = row.frontmatter ?? {};
    const origin = String(fm.captured_via ?? '').startsWith('life-chronicle:') && (fm.event as { depth?: unknown } | undefined)?.depth === depth;
    if (!origin) continue;
    if (row.deleted) {
      const stamp = fm.retired_by;
      const verified = retired.has(row.slug) || (stamp === CHRONICLE_RETIRED_BY && owned.has(String(row.content_hash ?? '')));
      if (!verified || (stamp !== CHRONICLE_RETIRED_BY && stamp !== 'generation-restore')) continue;
    } else if (!owned.has(String(row.content_hash ?? '')) && recorded.get(row.slug) !== pageIdentityHash(row) && context?.planned?.[row.slug] !== pageIdentityHash(row)) continue;
    const rowProjections = projections.get(row.page_id) ?? [];
    out.set(row.slug, { key: row.slug, identityHash: pageIdentityHash(row), live: !row.deleted, owned: true, segmented: row.segmented, preimage: () => {
      const page = pagePreimage(row);
      return page.json ? { json: { ...page.json, projection: rowProjections, content_hash: row.content_hash }, bytes: page.bytes } : page;
    } });
  }
  return out;
}

async function recordProjectionFlag(tx: BrainEngine, assessment: WriteGateAssessment, eventPageId: number, date: string, sourceId: string): Promise<void> {
  if (assessment.verdict !== 'flag') return;
  const [entry] = await tx.executeRaw<{ id: number }>('SELECT id FROM timeline_entries WHERE event_page_id=$1 AND date=$2::date', [eventPageId, date]);
  if (entry) await recordWriteGateReceipt(tx, { targetTable: 'timeline_entries', targetId: Number(entry.id), sourceId, assessment });
}

/**
 * Writes one event page (versioned first when it replaces a live one) inside the caller's transaction; returns its id.
 * `contentHash`: a restore keeps the hash the page had, which the chronicle ledger owns (jsonb reorders frontmatter keys,
 * and the content hash is order-sensitive).
 */
async function writeEventPage(tx: BrainEngine, sourceId: string, slug: string, page: { title: string; compiledTruth: string; frontmatter: Record<string, unknown>; when: unknown; contentHash?: string | null }): Promise<number> {
  const live = await tx.readPageSnapshot(slug, { sourceId });
  if (live) await tx.createVersion(slug, { sourceId, preimage: live });
  const written = await tx.putPage(slug, { type: 'event', title: page.title, compiled_truth: page.compiledTruth,
    frontmatter: { type: 'event', ...page.frontmatter }, effective_date: safeDate(page.when), ...(page.contentHash ? { content_hash: page.contentHash } : {}) }, { sourceId });
  return Number(written.id);
}

export const chronicleEventAdapter: GenerationAdapter<ChronicleGenerationContext> = {
  kind: CHRONICLE_EVENT_KIND,
  retiredBy: CHRONICLE_RETIRED_BY,
  modelProduced: true,
  databaseOnly: true,
  lockKeys: (key, itemKeys) => [depthOf(key), ...itemKeys].map(slug => ({ sourceId: key.sourceId, slug })),
  async readInput(engine, key, context) {
    const snapshot = await engine.readPageSnapshot(depthOf(key), { sourceId: key.sourceId });
    if (!snapshot) return null;
    const pin = pinDepth(snapshot);
    const size = pageBodyBytes(snapshot.page);
    const revoked = context?.decisionRequestId ? !await grantHolds(engine, context.decisionRequestId) : false;
    return { pin: revoked ? `${depthInputPin(pin)}:grant_revoked` : depthInputPin(pin), size };
  },
  readItems: (engine, key, itemKeys, context) => readEventItems(engine, key, itemKeys, context),
  // An owned event already carries producer evidence (its content hash is on the chronicle ledger).
  legacyEvidence: async (_engine, _key, rows) => new Set(rows.map(row => row.key)),
  async publishItems(tx, key, items, context) {
    const depth = depthOf(key);
    const derivation = await deriveTrust(tx, [{ table: 'pages', sourceId: key.sourceId, slug: depth }], { channel: 'derive:chronicle' });
    const gateCfg = await derivedGateConfig(tx);
    const items0 = await readEventItems(tx, key, items.map(item => item.key), context);
    await withWriteTrust(tx, derivation.trust, async () => {
      for (const item of items) {
        const event = JSON.parse(item.content) as ChronicleEventContent;
        const existing = await tx.executeRaw('SELECT 1 FROM pages WHERE source_id=$1 AND slug=$2', [key.sourceId, item.key]);
        if (existing.length && !items0.has(item.key)) {
          const { opError } = await import('../../ops/contract.ts');
          throw opError('revision_conflict', `chronicle_superseded: ${item.key} was edited or deleted by an operator; nothing from this generation is published.`,
            'Nothing to do: the next chronicle cycle judges the depth page again and leaves that event as the operator left it.');
        }
        const pageId = await writeEventPage(tx, key.sourceId, item.key, { title: event.title, compiledTruth: event.compiledTruth, frontmatter: event.frontmatter, when: event.when });
        await lowerDerivedPageIn(tx, derivation, key.sourceId, item.key);
        // #5575 B3: the event's summary lands on the depth page's timeline; a quarantined or rejected one projects nothing.
        const gate = assessTimelineForGate({ summary: event.summary, source: `life-chronicle:event:${item.key}` }, derivedGateInput(derivation.trust), gateCfg);
        if (!timelineRowAllowed(gate)) continue;
        await tx.upsertEventProjection({ depthSlug: depth, eventSlug: item.key, date: event.day, summary: event.summary, sourceId: key.sourceId });
        await recordProjectionFlag(tx, gate, pageId, event.day, key.sourceId);
      }
    });
  },
  async retireItems(tx, key, itemKeys, retiredBy) {
    if (!itemKeys.length) return;
    await tx.executeRaw(`DELETE FROM timeline_entries t USING pages p WHERE p.id=t.event_page_id AND p.source_id=$1 AND p.slug=ANY($2::text[])`, [key.sourceId, [...itemKeys]]);
    await retireDerivedPagesInTransaction(tx, key.sourceId, itemKeys, retiredBy);
  },
  async restoreItem(tx, key, itemKey, preimage) {
    const frontmatter = { ...(preimage.frontmatter as Record<string, unknown>) };
    for (const stamp of RESERVED_RETIREMENT_KEYS) delete frontmatter[stamp];
    delete frontmatter.type;
    const pageId = await writeEventPage(tx, key.sourceId, itemKey, { title: String(preimage.title), compiledTruth: String(preimage.compiled_truth ?? ''), frontmatter,
      when: frontmatter.event_date, contentHash: typeof preimage.content_hash === 'string' ? preimage.content_hash : null });
    const depth = await depthRow(tx, key.sourceId, depthOf(key));
    if (!depth?.live) return;
    for (const projection of (preimage.projection as Projection[] | undefined) ?? []) {
      await tx.executeRaw(`INSERT INTO timeline_entries (page_id, date, source, summary, detail, event_page_id) VALUES ($1, $2::date, $3, $4, $5, $6)
        ON CONFLICT (event_page_id, date) WHERE event_page_id IS NOT NULL DO UPDATE SET summary=EXCLUDED.summary, detail=EXCLUDED.detail, page_id=EXCLUDED.page_id, source=EXCLUDED.source`,
      [depth.id, projection.date, `life-chronicle:event:${itemKey}`, projection.summary, projection.detail, pageId]);
    }
  },
  preimageIdentity,
  async proofHolds(engine, key, proof: EmptySourceProof) {
    if (proof.kind !== 'originIneligible' || !(CHRONICLE_INELIGIBLE_REASONS as readonly string[]).includes(proof.reason)) return false;
    const snapshot = await engine.readPageSnapshot(depthOf(key), { sourceId: key.sourceId });
    if (!snapshot?.page.content_hash) return false;
    const { CHRONICLE_EXTRACTOR_VERSION } = await import('../../chronicle/contract.ts');
    const rows = await engine.executeRaw('SELECT 1 FROM chronicle_page_state WHERE source_id=$1 AND page_id=$2 AND content_hash=$3 AND extractor_version=$4 AND state=$5 AND reason=$6',
      [key.sourceId, Number(snapshot.page.id), snapshot.page.content_hash, CHRONICLE_EXTRACTOR_VERSION, 'skipped', proof.reason]);
    return rows.length > 0;
  },
};

/** The live chronicle generations of `sourceId` whose depth page is gone and that still hold a live event (C-6): their owner keys, oldest first. */
export async function orphanedDepthKeys(db: BrainEngine, sourceId: string, limit: number): Promise<string[]> {
  const rows = await db.executeRaw<{ owner_key: string }>(
    `SELECT g.owner_key FROM derived_generations g
      WHERE g.source_id=$1 AND g.kind=$2 AND g.state='live'
        AND EXISTS (SELECT 1 FROM derived_generation_items i JOIN pages e ON e.source_id=g.source_id AND e.slug=i.item_key AND e.deleted_at IS NULL
          WHERE i.generation_id=g.id AND i.action <> 'retired')
        AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=g.source_id AND p.slug=substr(g.owner_key, 7) AND p.deleted_at IS NULL)
      ORDER BY g.updated_at, g.id LIMIT $3`, [sourceId, CHRONICLE_EVENT_KIND, limit]);
  return rows.map(row => row.owner_key);
}

export type { InputState };
