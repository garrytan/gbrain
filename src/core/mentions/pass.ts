/**
 * The mention pass: keeps entity pages' derived aliases and every page's
 * `link_source='mentions'` links current, incrementally, from `gbrain extract
 * --stale` and the managed stale path (sync's inline extraction stays
 * link-only).
 *
 * One pass, per source in scope:
 *   1. Policy. `auto_link=false` or `mentions.auto_link=false` removes plain
 *      mention links and derived alias rows once and records `disabled`;
 *      re-enabling makes every page due. A change of the policy fingerprint
 *      (linkable type set, cross-source policy, ignore list, alias deny list,
 *      multi-word aliases, sibling merge) makes every page due once. The
 *      status row records the extractor versions its count reflects; when
 *      they differ from this binary's, `pending` is recounted once.
 *   2. Alias refresh: linkable entity pages whose derived aliases were
 *      refreshed at another content revision (or alias version) get their
 *      `declared` and `subject` rows rewritten; pages that stopped being
 *      entities lose them. Frontmatter rows are never touched. Managed
 *      brains write through the coordinated writer (`page_aliases` is guarded).
 *   3. Authoritative gazetteer: a pack or alias read that fails writes
 *      nothing and records `failed` with the error.
 *   4. Entry diff: the gazetteer's (source, name, target, case) entries are
 *      compared with the saved set under an advisory lock; on change the set
 *      is saved, the source generation bumps, and only pages the change can
 *      affect are marked due (pages linking to a removed or retargeted
 *      target, plus pages whose text matches an added name or contains a
 *      removed one through the real tokenizer, prefiltered by a substring
 *      superset, one batch of pages per statement). That scan has half the
 *      time left in the run; pages it did not reach are marked due too. With
 *      no time left the set is not saved this run, and the source stays
 *      pending (coverage reads it as pending even with no page due).
 *   5. Reconcile due pages (content revision, extractor version or an
 *      invalidation differs): per batch, publish only when the source
 *      generations and each page's content revision are unchanged since the
 *      scan read them (conditional publish), so an edit or a gazetteer change
 *      during the scan leaves the page due. Only plain mention rows are
 *      touched; `typed_ner` rows stay.
 *   6. Status row (also written when a step throws or the pass is aborted:
 *      state `failed` with the step and error): state, pending pages (mention-due pages plus linkable
 *      entity pages with stale derived aliases, counted when the pass ends
 *      or its deadline stops it), last pass, generation. `coverage` on
 *      entity cards and get_backlinks reads it.
 *
 * MENTION_EXTRACTOR_VERSION is separate from LINK_EXTRACTOR_VERSION_TS, so a
 * gazetteer change never reruns link or timeline extraction.
 *
 * A segmented page (body in segments, NULL body columns) is scanned block by
 * block (page-body/segment-blocks.ts), the title first, keeping each target's
 * first mention, and incrementally: each run's mentions are stored on its
 * page_segment_derivations row keyed by its text, the gazetteer's digest and
 * the scan options, so only runs that changed are read again. A name whose
 * tokens straddle a segment cut (a blank line, heading, dated line or message
 * boundary) is not matched. A gazetteer change
 * marks every segmented page in scope due (no SQL prefilter reads its body).
 * Derived aliases are still refreshed for inline entity pages only.
 */

import { createHash } from 'node:crypto';
import type { BrainEngine, LinkBatchInput } from '../engine.ts';
import { pipelined } from '../page-state/transactions.ts';
import { isCrossSourceLinksEnabled } from '../link-extraction.ts';
import {
  buildGazetteer, entryNameNorm, findMentionedEntities, gazetteerEntryKeys, tokenizeTitle,
  type FindMentionsOpts, type Gazetteer, type GazetteerEntry, type GazetteerEntryKey, type Mention,
} from '../by-mention.ts';
import { bodyBlocks, detachedValue } from '../page-body/segment-blocks.ts';
import { commitRuns, derivationScope, keyDigest, planRuns, readRuns, SegmentDerivationRaced, type DeriveRun } from '../page-body/segment-derive.ts';
import { canonicalJson } from '../belief/keys.ts';
import { beliefCoveredSources, unmanagedBeliefPoint } from '../belief/projection-point.ts';
import { classifyItemFailure } from '../item-failure.ts';
import { linkableTypesFor, loadSourcePack, parseNameList, readMentionPolicy, type MentionPolicy, type PackTypes } from './policy.ts';
import { deriveEntityAliases, type DerivedAlias } from './aliases.ts';
import { normalizeAliasList } from '../search/alias-normalize.ts';
import { withCoordinatedWrite } from '../persistence/context.ts';
import { maintenanceAttribution } from '../persistence/attribution.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';

import { ALIAS_DERIVATION_VERSION, MENTION_EXTRACTOR_VERSION } from './versions.ts';

export { ALIAS_DERIVATION_VERSION, MENTION_EXTRACTOR_VERSION };

const RECONCILE_BATCH = 200;
const ALIAS_BATCH = 200;
const PREFILTER_BATCH = 500;

export type MentionState = 'complete' | 'pending' | 'disabled' | 'failed';

export interface MentionPassResult {
  /** Pages whose mention links were reconciled and published. */
  pages: number;
  created: number;
  removed: number;
  /** Pages left due because they (or the gazetteer) changed during the scan. */
  skipped: number;
  /** Entity pages whose derived alias rows changed. */
  aliasPages: number;
  /** Mention-due pages after the pass. */
  remaining: number;
  state: MentionState;
  error?: string;
  /** Pages whose own content the scanner refused (a run it must read whole is over its bound); they stay due and the pass goes on. */
  failed?: number;
  failures?: MentionPageFailure[];
}

export interface MentionPageFailure { slug: string; source_id: string; code: string; message: string }

/** The failed pages a pass lists; `failed` still counts every one. */
export const MENTION_FAILURE_REPORT_LIMIT = 20;

export interface MentionPassOpts {
  sourceId?: string;
  /** Epoch ms; the pass stops between batches after it. Absent = run to completion. */
  deadline?: number;
  signal?: AbortSignal;
  /** Test seam: runs after a batch is scanned and before it is published. */
  beforePublish?: (pageIds: number[]) => Promise<void>;
}


/** Mention-due live pages, per source (or one source). */
export async function countMentionDuePages(engine: Pick<BrainEngine, 'countPagesDueForMentions'>, sourceId?: string): Promise<number> {
  return engine.countPagesDueForMentions({ sourceId: sourceId ?? null, mentionVersion: MENTION_EXTRACTOR_VERSION });
}

/**
 * Index-due live pages of one source: mention-due pages plus linkable entity
 * pages (`types`) whose derived aliases are behind their content or
 * ALIAS_DERIVATION_VERSION. The status row's `pending` holds this count.
 */
export async function countIndexDuePages(engine: Pick<BrainEngine, 'countPagesDueForMentions'>, sourceId: string, types: string[]): Promise<number> {
  return engine.countPagesDueForMentions({ sourceId, mentionVersion: MENTION_EXTRACTOR_VERSION,
    aliases: { types, version: ALIAS_DERIVATION_VERSION } });
}

/**
 * The extractor versions a status row's `pending` count reflects, stored after
 * the policy hash in `mention_index_status.policy_fingerprint`
 * (`<hash>;v<mention>.<alias>`). A row without it, or with other versions,
 * was counted by another binary.
 */
export const INDEX_VERSION_STAMP = `v${MENTION_EXTRACTOR_VERSION}.${ALIAS_DERIVATION_VERSION}`;

export function splitStoredFingerprint(stored: string | null | undefined): { hash: string | null; versions: string | null } {
  if (!stored) return { hash: null, versions: null };
  const at = stored.indexOf(';');
  return at < 0 ? { hash: stored, versions: null } : { hash: stored.slice(0, at), versions: stored.slice(at + 1) };
}

async function sourcesInScope(engine: BrainEngine, sourceId?: string): Promise<string[]> {
  if (sourceId) return [sourceId];
  const rows = await engine.listMentionSourceIds();
  return rows.map(r => r.id);
}

function policyFingerprint(types: string[], crossSource: boolean, policy: MentionPolicy): string {
  return createHash('sha256').update(JSON.stringify({
    types, crossSource, ignore: [...policy.ignore].map(n => n.toLowerCase()).sort(),
    aliasDeny: [...policy.aliasDeny].map(n => n.toLowerCase()).sort(), multiword: policy.multiwordAliases, siblings: policy.siblingMerge,
  })).digest('hex').slice(0, 16);
}

async function writeStatus(engine: Pick<BrainEngine, 'writeMentionIndexStatus'>, sourceId: string, patch: {
  state: MentionState; pending?: number; error?: string | null; lastPassAt?: string | null; bumpGeneration?: boolean; fingerprint?: string | null;
}): Promise<void> {
  await engine.writeMentionIndexStatus(sourceId, { state: patch.state, pending: patch.pending ?? null, lastPassAt: patch.lastPassAt ?? null, error: patch.error ?? null,
    bumpGeneration: patch.bumpGeneration === true, fingerprint: patch.fingerprint ?? null, setFingerprint: patch.fingerprint !== undefined });
}

/**
 * #9548: a disable (exclusive) and each reconcile batch reading the source's generation (shared) take this first, before page
 * keys or status rows: a journaled disable locks its origin pages, which a cross-source batch holding the status row links to.
 */
async function lockMentionSources(tx: Pick<BrainEngine, 'lockMentionSources'>, sourceIds: string[], shared: boolean): Promise<void> {
  await tx.lockMentionSources(sourceIds, shared);
}

/** Run `fn` in a transaction; on a managed brain, as a coordinated write for `sourceId` (page_aliases is guarded). */
async function aliasWrite<T>(engine: BrainEngine, managed: boolean, sourceId: string, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  if (!managed) return engine.transaction(fn);
  const attribution = await maintenanceAttribution(engine);
  return engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => fn(tx), attribution));
}

/**
 * Replace one page's derived alias rows (declared, subject) with what its
 * current title and body yield, inside the caller's transaction (import and
 * `reindex --aliases`; on a managed brain the caller holds the coordinated
 * write). A page that is not a linkable entity, or linking that is off,
 * leaves no derived rows. Frontmatter rows are untouched.
 */
export async function writeDerivedAliases(tx: Pick<BrainEngine, 'replaceDerivedAliases' | 'executeRaw' | 'getConfig'>, sourceId: string,
  page: { slug: string; title: string | null; type: string | null; compiled_truth: string | null; timeline?: string | null; frontmatter?: Record<string, unknown> | null },
  opts: { pack?: PackTypes | null; policy?: MentionPolicy | null } = {}): Promise<number> {
  // A config read that fails (null policy) leaves the rows for the next sweep rather than failing the caller's write.
  const policy = opts.policy !== undefined ? opts.policy : await readMentionPolicy(tx).catch(() => null);
  if (!policy) return 0;
  const types = policy.enabled ? linkableTypesFor(opts.pack !== undefined ? opts.pack : await loadSourcePack(tx, sourceId), policy) : [];
  const aliases = types.includes(page.type ?? '') ? deriveEntityAliases(page, aliasOptsOf(policy)).aliases : [];
  await tx.replaceDerivedAliases(page.slug, sourceId, aliases);
  return aliases.length;
}

/**
 * Import's alias projection: the page's frontmatter aliases and, for a
 * linkable entity page, its derived aliases. Import never loads a schema
 * pack itself: it uses the pack the caller already resolved (none: the four
 * always-linkable types), and the next sweep refreshes with the source's pack.
 * The caller reads the mention policy before its transaction opens.
 */
export async function writePageAliases(tx: BrainEngine, slug: string, sourceId: string,
  page: { title: string; type: string; compiled_truth: string; timeline: string; frontmatter: Record<string, unknown> }, pack: unknown,
  policy: MentionPolicy | null): Promise<void> {
  // #5984: the frontmatter and derived rows are independent; their statements are pipelined, in the caller's transaction.
  await pipelined(tx, [
    () => tx.setPageAliases(slug, sourceId, normalizeAliasList(page.frontmatter.aliases), { inline: true }),
    () => writeDerivedAliases(tx, sourceId, { slug, ...page }, { pack: (pack as PackTypes | undefined) ?? null, policy }),
  ]);
}

/** Turn the index off for one source: plain mention links, derived aliases, entries and page state go; typed_ner rows stay. */
async function disableSource(engine: BrainEngine, managed: boolean, sourceId: string): Promise<number> {
  let beliefs = null as ReturnType<typeof unmanagedBeliefPoint> | null;
  const removed = await aliasWrite(engine, managed, sourceId, async tx => {
    await lockMentionSources(tx, [sourceId], false);
    // #9548: on a belief-covered source the removed links are journaled like the reconcile's; only origins whose page keys are held are swept.
    const origins = (await beliefCoveredSources(tx, [sourceId])).has(sourceId) ? (await tx.listMentionLinkOrigins(sourceId)).map(r => r.slug) : null;
    const unlink = async () => (await tx.deleteSourceMentionLinks(sourceId, origins)).length;
    if (origins?.length) beliefs = unmanagedBeliefPoint(sourceId, origins, 'mention_pass');
    const unlinked = beliefs ? await beliefs.run(tx, unlink) : await unlink();
    await tx.clearMentionSourceIndex(sourceId);
    await writeStatus(tx, sourceId, { state: 'disabled', pending: 0, error: null, bumpGeneration: true, fingerprint: null });
    return unlinked;
  });
  await beliefs?.commit(engine);
  return removed;
}

interface DuePage { id: number; slug: string; source_id: string; revision: string; title: string | null; type: string | null;
  compiled_truth: string | null; timeline: string | null; mention_ignore: unknown; frontmatter?: Record<string, unknown> | null; body_storage?: string }

/** What one run of a segmented body holds for the mention pass: its UTF-16 length and each target's first mention in it (offset run-local). */
interface MentionRunOutput { chars: number; mentions: Mention[] }

const gazetteerDigests = new WeakMap<Gazetteer, string>();

/** A digest of every gazetteer entry (all fields), computed once per gazetteer object: the input a body run's mentions depend on. */
function gazetteerDigest(gazetteer: Gazetteer): string {
  let digest = gazetteerDigests.get(gazetteer);
  if (digest === undefined) {
    digest = keyDigest(canonicalJson([...gazetteer].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
    gazetteerDigests.set(gazetteer, digest);
  }
  return digest;
}

/**
 * The body mentions of a segmented page per run (spec 8.2 mentions), in page order: runs whose rows match the gazetteer,
 * the scan options and their text are reused, the others are scanned block by block and stored. Null when the page is
 * not segmented.
 */
async function segmentedRunMentions(engine: BrainEngine, p: { id: number; slug: string; source_id: string }, gazetteer: Gazetteer,
  opts: FindMentionsOpts): Promise<Array<{ run: DeriveRun; output: MentionRunOutput }> | null> {
  const scope = await derivationScope(engine, p);
  if (!scope) return null;
  const inputs = { extractor: MENTION_EXTRACTOR_VERSION, gazetteer: gazetteerDigest(gazetteer), opts, separator: '\n\n' };
  const plan = await planRuns<MentionRunOutput>(engine, 'mentions', scope, () => inputs);
  const fresh = new Map(plan.todo.map(run => [run.index, { chars: 0, mentions: [] as Mention[], seen: new Set<string>() }]));
  await readRuns(engine, scope, new Set(fresh.keys()), (run, block) => {
    const out = run && fresh.get(run.index);
    if (!out) return;
    for (const m of findMentionedEntities(block.text, gazetteer, opts)) {
      if (out.seen.has(`${m.source_id}\0${m.slug}`)) continue;
      out.seen.add(`${m.source_id}\0${m.slug}`);
      out.mentions.push(detachedValue({ ...m, offset: m.offset + out.chars }));
    }
    out.chars += block.text.length;
  }, { separator: '\n\n' });
  const outputs = new Map([...fresh].map(([index, { chars, mentions }]) => [index, { chars, mentions }]));
  await commitRuns(engine, 'mentions', scope, outputs, () => inputs);
  return scope.runs.map(run => ({ run, output: outputs.get(run.index) ?? plan.current.get(run.index)! }));
}

/**
 * findMentionedEntities over `${title}\n\n${compiled_truth}\n\n${timeline}`; a segmented body is scanned block by block,
 * incrementally (segmentedRunMentions), or in a full pass when its body moves during the read.
 */
export async function pageMentions(engine: BrainEngine,
  p: { id: number; slug: string; source_id: string; title: string | null; compiled_truth?: string | null; timeline?: string | null; body_storage?: string | null },
  gazetteer: Gazetteer, opts: FindMentionsOpts): Promise<Mention[]> {
  if (p.body_storage !== 'segmented') {
    return (p.title || p.compiled_truth || p.timeline) ? findMentionedEntities(`${p.title ?? ''}\n\n${p.compiled_truth ?? ''}\n\n${p.timeline ?? ''}`, gazetteer, opts) : [];
  }
  const found = new Map<string, Mention>();
  const add = (mentions: Mention[], at: number) => {
    for (const m of mentions) if (!found.has(`${m.source_id}\0${m.slug}`)) found.set(`${m.source_id}\0${m.slug}`, { ...m, offset: m.offset + at });
  };
  add(findMentionedEntities(p.title ?? '', gazetteer, opts), 0);
  const base = (p.title ?? '').length + 2;
  const runs = await segmentedRunMentions(engine, p, gazetteer, opts).catch(error => {
    if (error instanceof SegmentDerivationRaced) return null;
    throw error;
  });
  if (!runs) {
    for await (const block of bodyBlocks(engine, p, { separator: '\n\n' })) add(findMentionedEntities(block.text, gazetteer, opts), base + block.at);
    return [...found.values()];
  }
  let at = base;
  for (const { run, output } of runs) {
    if (run.region === 'timeline' && (run.index === 0 || runs[run.index - 1]!.run.region === 'truth')) at += 2;
    add(output.mentions, at);
    at += output.chars;
  }
  return [...found.values()];
}

/** Alias derivation options from the mention policy (`mentions.alias_deny`, `mentions.multiword_aliases`). */
export function aliasOptsOf(policy: Pick<MentionPolicy, 'aliasDeny' | 'multiwordAliases'>): { deny: string[]; multiword: boolean } {
  return { deny: policy.aliasDeny, multiword: policy.multiwordAliases };
}

/** Refresh derived alias rows of due entity pages in one source; returns pages whose rows changed. */
async function refreshAliases(engine: BrainEngine, managed: boolean, sourceId: string, types: string[], deadline: number, policy: MentionPolicy): Promise<number> {
  let changed = 0;
  // Pages that stopped being linkable entities (retype, pack change, deletion) lose their derived rows.
  const stale = await engine.listStaleDerivedAliasSlugs(sourceId, types);
  if (stale.length) {
    await aliasWrite(engine, managed, sourceId, tx => tx.deleteDerivedAliasesForSlugs(sourceId, stale.map(r => r.slug)));
    changed += stale.length;
  }
  let after = 0;
  for (;;) {
    if (Date.now() > deadline) break;
    const pages = await engine.listAliasDuePages(sourceId, types, after, ALIAS_DERIVATION_VERSION, ALIAS_BATCH);
    if (!pages.length) break;
    after = pages[pages.length - 1]!.id;
    const desired = new Map(pages.map(p => [p.slug, deriveEntityAliases(p, aliasOptsOf(policy)).aliases]));
    const existing = await engine.listDerivedAliasRows(sourceId, pages.map(p => p.slug));
    const key = (a: { alias_norm: string; origin: string; case_sensitive: boolean; alias_text: string | null }) =>
      `${a.alias_norm}\0${a.origin}\0${a.case_sensitive}\0${a.case_sensitive ? a.alias_text : ''}`;
    const have = new Map<string, Set<string>>();
    for (const row of existing) {
      const set = have.get(row.slug) ?? new Set<string>();
      set.add(key(row));
      have.set(row.slug, set);
    }
    const rewrite = pages.filter(p => {
      const want = new Set((desired.get(p.slug) ?? []).map(a => key({ ...a, alias_text: a.alias_text })));
      const got = have.get(p.slug) ?? new Set<string>();
      return want.size !== got.size || [...want].some(k => !got.has(k));
    });
    await aliasWrite(engine, managed, sourceId, async tx => {
      const current = new Map((await tx.readMentionPageRevisions(pages.map(p => p.id), { forShare: false })).map(r => [Number(r.id), r.revision]));
      const fresh = pages.filter(p => current.get(Number(p.id)) === p.revision);
      const freshRewrite = rewrite.filter(p => current.get(Number(p.id)) === p.revision);
      if (freshRewrite.length) {
        await tx.deleteDerivedAliasesForSlugs(sourceId, freshRewrite.map(p => p.slug));
        const rows = freshRewrite.flatMap(p => (desired.get(p.slug) ?? []).map((a: DerivedAlias) => ({ slug: p.slug, ...a })));
        if (rows.length) {
          await tx.insertDerivedAliasRows(sourceId, rows);
        }
      }
      if (fresh.length) {
        await tx.upsertPageAliasState(sourceId, fresh.map(p => ({ id: p.id, revision: p.revision })), ALIAS_DERIVATION_VERSION);
      }
      changed += freshRewrite.length;
    });
  }
  return changed;
}

/**
 * Live pages in `sourceIds` whose text the mini-gazetteer of `added` matches (real tokenizer, substring-superset prefilter),
 * scanned in page-id order until `deadline`, PREFILTER_BATCH pages per statement whether they match or not (so one
 * statement never reads a whole source looking for a rare name). `through` is the last page id read when the deadline stopped the scan, null
 * when every page was read.
 */
async function pagesMatchingNames(engine: BrainEngine, sourceIds: string[], added: Gazetteer, allowCrossSource: boolean, deadline: number): Promise<{ ids: number[]; through: number | null }> {
  const longest = [...added.values()].flat().map(e => [...e.tokens].sort((a, b) => b.length - a.length)[0]!);
  // ASCII tokens: lower() in SQL agrees with the scanner's NFC+toLowerCase, so LIKE is a superset.
  // Otherwise every page in scope is scanned in JS.
  const ascii = longest.every(t => /^[\x20-\x7e]+$/.test(t));
  const patterns = [...new Set(longest)].map(t => `%${t.replace(/[\\%_]/g, m => `\\${m}`)}%`);
  const out: number[] = [];
  let after = 0;
  for (;;) {
    if (Date.now() > deadline) return { ids: out, through: after };
    const rows = await engine.listMentionCandidatePages(sourceIds, after, PREFILTER_BATCH, ascii ? patterns : null);
    if (!rows.length) break;
    after = rows[rows.length - 1]!.id;
    for (const r of rows) {
      if (r.body === null) continue;
      if (r.body_storage === 'segmented') { out.push(Number(r.id)); continue; }
      const hits = findMentionedEntities(r.body, added, { fromSlug: r.slug, fromSourceId: r.source_id, allowCrossSource });
      if (hits.length) out.push(Number(r.id));
    }
  }
  return { ids: out, through: null };
}

/**
 * The names a save must look for in page text: the added entries as they are, and each removed name (any case, any
 * spacing, since the saved form no longer has it; no target, so no guard skips it) because a page that contained it may now match another name it hid, even when it had
 * no mention link to the removed target.
 */
function scanGazetteer(gazetteer: Gazetteer, added: GazetteerEntryKey[], removed: GazetteerEntryKey[]): Gazetteer {
  const keys = new Set(added.map(entryKey));
  const out: Gazetteer = new Map();
  for (const [first, bucket] of gazetteer) {
    const kept = bucket.filter(e => keys.has(entryKey(e)));
    if (kept.length) out.set(first, kept);
  }
  const seen = new Set<string>();
  for (const k of removed) {
    const tokens = k.name_norm.replace(/^@/, '').toLowerCase().split(' ').filter(Boolean);
    if (!tokens.length || seen.has(`${k.source_id}\0${tokens.join(' ')}`)) continue;
    seen.add(`${k.source_id}\0${tokens.join(' ')}`);
    out.set(tokens[0]!, [...out.get(tokens[0]!) ?? [], { slug: '', source_id: k.source_id, title: k.name_norm, tokens, anySpacing: true }]);
  }
  for (const bucket of out.values()) bucket.sort((a, b) => b.tokens.length - a.tokens.length);
  return out;
}

function entryKey(e: GazetteerEntry | GazetteerEntryKey): string {
  if ('target_slug' in e) return `${e.source_id}\0${e.name_norm}\0${e.target_slug}\0${e.case_sensitive}`;
  return `${e.source_id}\0${entryNameNorm(e)}\0${e.slug}\0${!!e.caseTokens}`;
}

/**
 * Diff the saved entry set of one source against `gazetteer`; on change, save
 * it, bump the generation and mark affected pages due, in one transaction under
 * the source's advisory lock. Returns false when the set changed but no time
 * was left before `deadline` to save it this run.
 *
 * The scan for pages naming an added or removed name gets half the time left before
 * `deadline`. When it stops early, every page in scope it did not reach is
 * marked due as well, so the save never waits on a scan longer than a run and
 * the reconcile picks those pages up in resumable batches.
 */
async function saveEntries(engine: BrainEngine, sourceId: string, gazetteer: Gazetteer, scopeSources: string[], allowCrossSource: boolean, deadline: number): Promise<boolean> {
  const current = gazetteerEntryKeys(gazetteer).filter(k => k.source_id === sourceId);
  const read = async (db: Pick<BrainEngine, 'listGazetteerEntryKeys'>) => (await db.listGazetteerEntryKeys(sourceId));
  const before = await read(engine);
  const beforeKeys = new Set(before.map(entryKey));
  const currentKeys = new Set(current.map(entryKey));
  const added = current.filter(k => !beforeKeys.has(entryKey(k)));
  const removed = before.filter(k => !currentKeys.has(entryKey(k)));
  if (!added.length && !removed.length) return true;
  if (Date.now() > deadline) return false;
  // The first save for a source marks the whole candidate scope due (cheap); later saves only affected pages.
  const firstSave = before.length === 0;
  let candidates: number[] = [];
  let unscannedAfter: number | null = null;
  if (!firstSave) {
    const linked = removed.length ? await engine.listMentionLinkersOfTargets(sourceId, [...new Set(removed.map(k => k.target_slug))]) : [];
    const scanDeadline = deadline === Infinity ? Infinity : Date.now() + Math.max(0, deadline - Date.now()) / 2;
    const matched = added.length || removed.length ? await pagesMatchingNames(engine, scopeSources,
      scanGazetteer(gazetteer, added, removed), allowCrossSource, scanDeadline) : { ids: [], through: null };
    candidates = [...new Set([...linked.map(r => Number(r.id)), ...matched.ids])];
    unscannedAfter = matched.through;
  }
  return engine.transaction(async tx => {
    await tx.lockMentionEntries(sourceId);
    const locked = await read(tx);
    // Another sweep saved first: its pages and generation are authoritative; this pass's scan fails its conditional publish.
    if (locked.length !== before.length || locked.some(k => !beforeKeys.has(entryKey(k)))) return true;
    await tx.applyGazetteerEntryChanges(sourceId, removed, added);
    if (firstSave) {
      await tx.resetMentionRevisions({ sourceIds: scopeSources });
    } else if (candidates.length || unscannedAfter !== null) {
      await tx.resetMentionRevisions({ pageIds: candidates, ...(unscannedAfter === null ? {} : { sourceIds: scopeSources, afterPageId: unscannedAfter }) });
    }
    await writeStatus(tx, sourceId, { state: 'pending', bumpGeneration: true });
    return true;
  });
}

async function readGenerations(engine: Pick<BrainEngine, 'readMentionGenerations'>, sourceIds: string[], lock: boolean): Promise<Map<string, string>> {
  const rows = await engine.readMentionGenerations(sourceIds, lock);
  return new Map(rows.map(r => [r.source_id, r.generation]));
}

function sameGenerations(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** Reconcile due pages of one source; returns counts and whether a gazetteer change stopped it. */
async function reconcileSource(engine: BrainEngine, sourceId: string, gazetteer: Gazetteer, genSources: string[], allowCrossSource: boolean,
  opts: MentionPassOpts, deadline: number, result: MentionPassResult): Promise<void> {
  const generations = await readGenerations(engine, genSources, false);
  let after = 0;
  for (;;) {
    opts.signal?.throwIfAborted();
    if (Date.now() > deadline) return;
    const pages = await engine.listMentionDuePages(sourceId, MENTION_EXTRACTOR_VERSION, after, RECONCILE_BATCH);
    if (!pages.length) return;
    after = pages[pages.length - 1]!.id;
    const found = new Map<number, Mention[]>();
    const readable: DuePage[] = [];
    for (const p of pages) {
      try {
        found.set(Number(p.id), await pageMentions(engine, p, gazetteer,
          { fromSlug: p.slug, fromSourceId: p.source_id, allowCrossSource, ignoreNames: parseNameList(p.mention_ignore) }));
        readable.push(p);
      } catch (error) {
        const failure = classifyItemFailure(error);
        if (failure.scope !== 'item' || failure.class !== 'content') throw error;
        result.failed = (result.failed ?? 0) + 1;
        if ((result.failures ??= []).length < MENTION_FAILURE_REPORT_LIMIT) {
          result.failures.push({ slug: p.slug, source_id: p.source_id, code: failure.code, message: failure.message.slice(0, 500) });
        }
      }
    }
    if (!readable.length) continue;
    await opts.beforePublish?.(readable.map(p => Number(p.id)));
    // #7031: on a belief-covered source the link changes are an unmanaged projection point, like derived links; the
    // page keys are locked first, as every publisher locks them before the page rows.
    let beliefs = null as ReturnType<typeof unmanagedBeliefPoint> | null;
    const outcome = await engine.transaction(async tx => {
      beliefs = null; // A transaction callback may run more than once (the multi-user Rust engine retries it after a write conflict): only the committed run's point is committed.
      await lockMentionSources(tx, genSources, true);
      const journaled = (await beliefCoveredSources(tx, [sourceId])).has(sourceId);
      if (journaled) await tx.lockPageKeys(readable.map(p => ({ sourceId: p.source_id, slug: p.slug })));
      if (!sameGenerations(generations, await readGenerations(tx, genSources, true))) return null;
      const current = new Map((await tx.readMentionPageRevisions(readable.map(p => p.id), { forShare: true })).map(r => [Number(r.id), r.revision]));
      const fresh = readable.filter(p => current.get(Number(p.id)) === p.revision);
      if (!fresh.length) return { fresh: 0, created: 0, removed: 0 };
      const rows = await tx.listPageOutLinks(fresh.map(p => p.id));
      const existing = rows.filter(r => r.plain);
      // One link per page pair: a pair another producer already links (markdown, frontmatter, typed_ner, manual) gets no plain mention.
      // A cross-source mention is also covered by an explicit link to the same slug in any source (the resolver may pick another twin).
      const covered = new Set(rows.filter(r => !r.plain).flatMap(r => [`${r.from_page_id}\0${r.to_source_id}\0${r.to_slug}`, `${r.from_page_id}\0*\0${r.to_slug}`]));
      const pageSource = new Map(fresh.map(p => [Number(p.id), p.source_id]));
      const want = new Set(fresh.flatMap(p => (found.get(Number(p.id)) ?? [])
        .filter(m => !covered.has(`${p.id}\0${m.source_id}\0${m.slug}`) && !(m.source_id !== pageSource.get(Number(p.id)) && covered.has(`${p.id}\0*\0${m.slug}`)))
        .map(m => `${p.id}\0${m.source_id}\0${m.slug}`)));
      const have = new Set(existing.map(r => `${r.from_page_id}\0${r.to_source_id}\0${r.to_slug}`));
      const drop = existing.filter(r => !want.has(`${r.from_page_id}\0${r.to_source_id}\0${r.to_slug}`)).map(r => Number(r.id));
      const add: LinkBatchInput[] = fresh.flatMap(p => (found.get(Number(p.id)) ?? [])
        .filter(m => want.has(`${p.id}\0${m.source_id}\0${m.slug}`) && !have.has(`${p.id}\0${m.source_id}\0${m.slug}`))
        .map(m => ({ from_slug: p.slug, to_slug: m.slug, link_type: 'mentions', link_source: 'mentions', context: m.name,
          from_source_id: p.source_id, to_source_id: m.source_id })));
      const write = async () => {
        if (drop.length) await tx.deleteLinksById(drop);
        return add.length ? await tx.addLinksBatch(add, { auditSite: 'extract.mentions' }) : 0; // gbrain-allow-direct-insert: mention pass — reconciling write of the scan's own plain mention rows
      };
      const dropped = new Set(existing.filter(r => drop.includes(Number(r.id))).map(r => Number(r.from_page_id)));
      const changed = fresh.filter(p => dropped.has(Number(p.id))).map(p => p.slug).concat(add.map(link => link.from_slug));
      if (journaled && changed.length) beliefs = unmanagedBeliefPoint(sourceId, changed, 'mention_pass');
      const created = beliefs ? await beliefs.run(tx, write) : await write();
      await tx.upsertPageMentionState(sourceId, fresh.map(p => ({ id: p.id, revision: p.revision })), MENTION_EXTRACTOR_VERSION, generations.get(sourceId) ?? '0');
      return { fresh: fresh.length, created, removed: drop.length };
    });
    await beliefs?.commit(engine);
    if (!outcome) { result.skipped += readable.length; return; }
    result.pages += outcome.fresh;
    result.skipped += readable.length - outcome.fresh;
    result.created += outcome.created;
    result.removed += outcome.removed;
  }
}

/**
 * Run the mention pass for one source or every source. Never throws for a
 * pack, alias or entry-table failure: it writes nothing and returns
 * `state: 'failed'` with the error (recorded on the status rows).
 */
export async function runMentionPass(engine: BrainEngine, opts: MentionPassOpts = {}): Promise<MentionPassResult> {
  const result: MentionPassResult = { pages: 0, created: 0, removed: 0, skipped: 0, aliasPages: 0, remaining: 0, state: 'complete' };
  const deadline = opts.deadline ?? Infinity;
  const passStart = new Date().toISOString();
  const policy = await readMentionPolicy(engine);
  const sources = await sourcesInScope(engine, opts.sourceId);
  const managed = await managedPersistenceEnabled(engine);
  if (!policy.enabled) {
    const status = new Map((await engine.readMentionStatusStates(sources)).map(r => [r.source_id, r.state]));
    for (const sourceId of sources) {
      if (status.get(sourceId) === 'disabled') continue;
      result.removed += await disableSource(engine, managed, sourceId);
    }
    result.state = 'disabled';
    return result;
  }
  const allowCrossSource = await isCrossSourceLinksEnabled(engine);
  const types = new Map<string, string[]>();
  let gazetteer: Gazetteer;
  try {
    for (const sourceId of sources) types.set(sourceId, linkableTypesFor(await loadSourcePack(engine, sourceId, { strict: true }), policy));
    gazetteer = await buildGazetteer(engine, { policy, strict: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const sourceId of sources) await writeStatus(engine, sourceId, { state: 'failed', error: message });
    return { ...result, state: 'failed', error: message, remaining: await countMentionDuePages(engine, opts.sourceId) };
  }
  const allSources = allowCrossSource ? (await sourcesInScope(engine)) : [];
  const fingerprints = new Map<string, string>(sources.map(s => [s, policyFingerprint(types.get(s)!, allowCrossSource, policy)]));
  const stored = new Map((await engine.readMentionPolicyFingerprints(sources))
    .map(r => [r.source_id, r.policy_fingerprint]));
  // A changed policy makes every page due; a binary with other extractor versions only recounts (version-behind pages are already due).
  for (const sourceId of sources) {
    const { hash, versions } = splitStoredFingerprint(stored.get(sourceId));
    const policyChanged = hash !== fingerprints.get(sourceId);
    if (!policyChanged && versions === INDEX_VERSION_STAMP) continue;
    await engine.transaction(async tx => {
      if (policyChanged) await tx.resetSourceMentionIndexRevisions(sourceId);
      await writeStatus(tx, sourceId, { state: 'pending', bumpGeneration: policyChanged, pending: await countIndexDuePages(tx, sourceId, types.get(sourceId)!),
        fingerprint: `${fingerprints.get(sourceId)!};${INDEX_VERSION_STAMP}` });
    });
  }
  // A throw or an abort below stops the pass before its status write; the source it stopped on records why.
  let step = 'alias refresh';
  let current = sources[0];
  try {
    for (const sourceId of sources) {
      if (Date.now() > deadline) break;
      current = sourceId;
      result.aliasPages += await refreshAliases(engine, managed, sourceId, types.get(sourceId)!, deadline, policy);
    }
    // Aliases may have changed: the gazetteer the reconcile uses is built after the refresh.
    if (result.aliasPages > 0) {
      try { gazetteer = await buildGazetteer(engine, { policy, strict: true }); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const sourceId of sources) await writeStatus(engine, sourceId, { state: 'failed', error: message });
        return { ...result, state: 'failed', error: message, remaining: await countMentionDuePages(engine, opts.sourceId) };
      }
    }
    // With no time left a changed name list is not saved: its scan would only mark pages for a reconcile that cannot run.
    step = 'name list save';
    const unsaved = new Set<string>();
    for (const sourceId of sources) {
      current = sourceId;
      if (!await saveEntries(engine, sourceId, gazetteer, allowCrossSource ? allSources : [sourceId], allowCrossSource, deadline)) unsaved.add(sourceId);
    }
    step = 'reconcile';
    for (const sourceId of sources) {
      current = sourceId;
      await reconcileSource(engine, sourceId, gazetteer, allowCrossSource ? allSources : [sourceId], allowCrossSource, opts, deadline, result);
      const pending = await countIndexDuePages(engine, sourceId, types.get(sourceId)!);
      result.remaining += pending;
      // A source whose name list is still unsaved stays pending and keeps its last completed pass time.
      await writeStatus(engine, sourceId, unsaved.has(sourceId)
        ? { state: 'pending', pending, error: null }
        : { state: pending > 0 ? 'pending' : 'complete', pending, error: null, lastPassAt: passStart });
    }
    if (unsaved.size) result.state = 'pending';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (current) await writeStatus(engine, current, { state: 'failed', error: `stopped in the ${step}: ${message}`.slice(0, 2000) }).catch(() => {});
    throw error;
  }
  if (result.remaining > 0) result.state = 'pending';
  return result;
}

/** The gazetteer's entries targeting one page, with their origins (for explain). */
export function entriesFor(gazetteer: Gazetteer, sourceId: string, slug: string): GazetteerEntry[] {
  return [...gazetteer.values()].flat().filter(e => e.source_id === sourceId && e.slug === slug);
}

/** Normalized token key of a name, as the scanner compares it. */
export function nameKey(name: string): string {
  return tokenizeTitle(name).join(' ');
}
