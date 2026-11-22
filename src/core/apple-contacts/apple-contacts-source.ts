/**
 * The apple-contacts source sweep (`sources.config.kind = 'apple-contacts'`): GBrain Helper's Contacts changes become
 * owner-only contact pages under the source's contacts directory (default contacts/apple), one per contact, owned by its
 * id (`apple_contact_id`). Plan GST-3256, route contract with ALPH-138 (11-20).
 *
 * Cursor. With no saved cursor (first run, --full, or after 410 cursor_expired) the run reads the whole snapshot, page
 * by page while `meta.more`, before it writes anything, so the delete floor can refuse it whole; the cursor its last
 * page carries is saved after the snapshot is applied. With a cursor the run applies each page of changes and saves
 * that page's `next_cursor` only after the page is applied. Upserts are idempotent: an unchanged contact (its
 * fingerprint) writes nothing.
 *
 * Deletes. A deletion retires only the page that contact owns (soft delete, restorable for the purge window). Absence
 * from a snapshot counts as a delete only when the snapshot's last page had `full: true`. The delete floor: a snapshot
 * that is empty while the source owns contacts, or would delete more than 20% of them, writes nothing at all and stops
 * with apple_contacts_delete_floor. An incremental run applies each page's upserts and records its `op: delete` items
 * as pending deletions in the database before it sends the page's cursor back (the helper commits a page when its
 * cursor is presented, so a held page is never re-sent); at the run's end the pending deletions pass the same floor
 * together, against the contacts the source owns, or stay pending and the run ends with apple_contacts_delete_floor. A
 * later upsert of a pending contact cancels its deletion; a complete snapshot settles them all.
 * GBRAIN_ALLOW_MASS_RECONCILE=1 takes a real large deletion through; it never applies to an empty snapshot or to every
 * contact the source owns.
 *
 * Identity (identity-match.ts) links a contact page to the one person page with the same email or phone; two or more
 * are an identity review for the owner. Person pages get only person-facts.ts rows in their ## Facts fence (company, job
 * title, groups), which only this source updates or retires; removals wait for a complete run and pass the delete floor
 * with the contact deletions behind them.
 *
 * Records: on a brain with a repository the source can record to Git (--record git with --dir; commits through the
 * door, connectors/api-source.ts); otherwise the database is the record. The source is owner-only.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { SyncOpts, SyncResult } from '../../commands/sync.ts';
import { OperationError } from '../ops/contract.ts';
import { runAppleContactsEnrichment, type EnrichDeps } from './enrich.ts';
import { withConnectorSync, pendingConnectorResult, type ManagedConnectorSync } from '../persistence/connector-sync.ts';
import { connectorIdentity } from '../persistence/connector-identity.ts';
import { abortsManagedRun, ConnectorHoldSession, connectorHoldsResult } from '../connectors/connector-hold-session.ts';
import { connectorDbCursorKey, readConnectorDbCursor, writeConnectorDbCursor } from '../connectors/db-cursor.ts';
import { connectorRender } from '../connectors/connector-text.ts';
import { afterConnectorPublish, connectorDryRunResult, deleteConnectorPage, publishConnectorPage, runScoped, type ConnectorPublishCtx, type PublishSummary } from '../connectors/api-source.ts';
import { slugifyPath } from '../sync.ts';
import { applyContactPage } from '../contact-page-apply.ts';
import { listEntityIdentities } from '../entity-identity.ts';
import { parsePhoneCountryCode, PHONE_COUNTRY_CODE_CONFIG_KEY } from '../phone-key.ts';
import { appleContactsError, appleContactsHelper, AppleContactsCursorExpiredError, AppleContactsShapeDriftError, readAppleContactsToken, type AppleContactsHelper } from '../apple/contacts-client.ts';
import { appleBaseSlug, appleContactFingerprint, appleContactRender, appleTombstoneSlugs, renderAppleContactPage } from './render.ts';
import { APPLE_CONTACTS_LINK_ORIGIN, decidedDifferent, exactPersonMatches, linkContactPage, readIdentityReviews, unlinkContact, writeIdentityReviews, type IdentityReview } from './identity-match.ts';
import { holderKey, personClaims, readPersonFactHolders, safePersonFields, syncPersonFacts, writePersonFactHolders, type PersonFields } from './person-facts.ts';
import { readPendingDeletes, writePendingDeletes, type HeldDeletes } from './review-status.ts';
import { APPLE_CONTACT_ID_KEY, APPLE_CONTACTS_DELETE_FLOOR, APPLE_CONTACTS_KIND, appleContactHoldKey, type AppleContact, type AppleContactChange, type AppleContactsSourceConfig } from './types.ts';

export interface AppleContactsState extends Record<string, unknown> {
  /** The helper's change-history cursor; null before the first complete snapshot. */
  cursor: string | null;
  /** Each contact's fingerprint as last written (contact id → fingerprint). */
  fps: Record<string, string>;
  /** Contacts whose person-page facts change waits for a complete run (or failed), decided again on the next run. */
  deferred?: string[];
  item_holds?: unknown;
}

const emptyState = (): AppleContactsState => ({ cursor: null, fps: {} });
/** Snapshot pages one run reads before it stops (at 200 a page, 200,000 contacts). */
const MAX_SNAPSHOT_PAGES = 1_000;

export interface AppleContactsSyncDeps {
  /** Test seam: a helper with its own transport or retry waits. */
  helper?: AppleContactsHelper;
  now?: () => number;
  log?: (line: string) => void;
  /** Test seam: the write route enrichment sends its batch to. */
  enrichSend?: EnrichDeps['send'];
}

interface Summary extends PublishSummary { status: 'synced' | 'partial'; failedFiles: number }

function deleteFloor(sourceId: string, why: string, held = false): OperationError {
  return appleContactsError('apple_contacts_delete_floor',
    `Apple Contacts source ${sourceId}: ${why} ${held ? 'No contact was deleted: the deletions are kept pending (gbrain sync status lists them) and apply on a later run once they are under the floor, or cancel when the contacts come back.'
      : 'Nothing was written and the saved cursor is unchanged.'} A revoked grant or a half-empty Contacts store cannot wipe the source.`,
    `Check Contacts on the Mac (and that GBrain Helper can read it), then run gbrain sync --source ${sourceId} again. If the deletions are real, run it once with GBRAIN_ALLOW_MASS_RECONCILE=1 (it never lets an empty snapshot through).`);
}

/** A failure that stops the whole run (the helper, the token, the floor, a shape drift, a cancel), never one contact. */
const stopsRun = (error: unknown) => runScoped(error) || error instanceof AppleContactsShapeDriftError
  || (error instanceof OperationError && error.code.startsWith('apple_contacts_'));

/** The snapshot's delete floor, checked before anything is written. */
async function checkSnapshotFloor(sourceId: string, owned: number, live: number, deletes: number): Promise<void> {
  if (owned === 0) return;
  if (live === 0) throw deleteFloor(sourceId, `the snapshot holds no contact with an email or a phone while the source owns ${owned} contact(s).`);
  if (deletes >= owned) throw deleteFloor(sourceId, `the snapshot would delete every one of the ${owned} contacts the source owns.`);
  const { massReconcileAllowed } = await import('../../commands/sync.ts');
  if (deletes > owned * APPLE_CONTACTS_DELETE_FLOOR && !massReconcileAllowed()) {
    throw deleteFloor(sourceId, `the snapshot would delete ${deletes} of the ${owned} contacts the source owns (more than ${APPLE_CONTACTS_DELETE_FLOOR * 100}%).`);
  }
}

export async function runAppleContactsSync(engine: BrainEngine, sourceId: string, cfg: AppleContactsSourceConfig, opts: SyncOpts, deps: AppleContactsSyncDeps = {}): Promise<SyncResult> {
  if ((opts as SyncOpts & { resetCheckpoint?: boolean }).resetCheckpoint) {
    throw new OperationError('invalid_params', '--reset-checkpoint does not apply to an Apple Contacts source.',
      `Run gbrain sync --source ${sourceId} --full instead: it reads every contact from GBrain Helper again, under the delete floor.`);
  }
  const result = await withConnectorSync(engine, sourceId, APPLE_CONTACTS_KIND, cfg, opts,
    async (managed, options) => options.dryRun ? connectorDryRunResult('Apple Contacts', sourceId) : runInner(engine, sourceId, cfg, options, managed, deps), pendingConnectorResult);
  // Enrichment reads what the pull just wrote, so it runs only after a clean one; its failure never fails the pull.
  if (opts.dryRun || (result.status !== 'synced' && result.status !== 'up_to_date')) return result;
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  try {
    const countryCode = parsePhoneCountryCode(await engine.getConfig(PHONE_COUNTRY_CODE_CONFIG_KEY).catch(() => null));
    const record = await runAppleContactsEnrichment(engine, sourceId, cfg, countryCode, { send: deps.enrichSend, now: deps.now });
    if (record?.note) log('[apple-contacts] ' + sourceId + ': enrichment: ' + record.note + ': gbrain apple-contacts enrich status --source ' + sourceId);
  } catch (error) {
    if (runScoped(error)) throw error;
    log('[apple-contacts] ' + sourceId + ': enrichment did not run: ' + (error instanceof Error ? error.message : String(error)));
  }
  return result;
}

async function runInner(engine: BrainEngine, sourceId: string, cfg: AppleContactsSourceConfig, opts: SyncOpts,
  managed: ManagedConnectorSync | null, deps: AppleContactsSyncDeps): Promise<SyncResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const runId = randomUUID();
  const signal = opts.signal;
  const helper = deps.helper ?? appleContactsHelper({ sourceId, cfg, token: readAppleContactsToken(sourceId, cfg.tokenFile) });

  const [source] = await engine.executeRaw<{ incarnation: string; local_path: string | null; config: Record<string, unknown> }>(
    'SELECT incarnation::text AS incarnation,local_path,config FROM sources WHERE id=$1', [sourceId]);
  const identity = connectorIdentity(APPLE_CONTACTS_KIND, source!.config, source!.local_path);
  const cursorKey = connectorDbCursorKey(sourceId, source!.incarnation, identity);
  const state: AppleContactsState = managed ? { ...emptyState(), ...managed.state<AppleContactsState>(emptyState()) }
    : { ...emptyState(), ...(await readConnectorDbCursor(engine, cursorKey)).state as AppleContactsState | null };
  const countryCode = parsePhoneCountryCode(await engine.getConfig(PHONE_COUNTRY_CODE_CONFIG_KEY).catch(() => null));

  const summary: Summary = { status: 'synced', added: 0, modified: 0, deleted: 0, chunksCreated: 0, embedded: 0, pagesAffected: [], factsRetired: 0, failedFiles: 0 };
  const holds = await ConnectorHoldSession.open(engine, sourceId, managed, emptyState(), state.item_holds, { full: opts.full });
  const ctx: ConnectorPublishCtx = { engine, sourceId, managed, summary, label: 'Apple Contacts', tag: APPLE_CONTACTS_KIND, record: cfg.record, dir: cfg.dir, gated: true };
  const reviews = new Map((await readIdentityReviews(engine, sourceId)).map(r => [r.contact_id, r]));
  const holders = await readPersonFactHolders(engine, sourceId);
  /** Contacts whose person-page facts this run decides: contact id → the person page it may write (null: none). */
  const factTargets = new Map<string, { person: { source_id: string; slug: string }; fields: PersonFields } | null>();
  const touched = new Set<string>();
  const deferred = new Set(state.deferred ?? []);
  /** Contacts the helper reported deleted whose deletion waits for the end of the run (the delete floor), kept in the database. */
  const pendingRow = await readPendingDeletes(engine, sourceId);
  const pending = new Set(pendingRow.ids);
  const persistPending = (held: HeldDeletes | null) => writePendingDeletes(engine, sourceId, [...pending].sort(), held);
  const floor: { refusal: OperationError | null } = { refusal: null };
  let blocked = false;

  const save = async (final: boolean) => {
    if (managed) { await managed.saveState(state, final && summary.status === 'synced'); return; }
    await writeConnectorDbCursor(engine, cursorKey, state, final ? { run_id: runId, finished_at: new Date(now()).toISOString(),
      counts: { added: summary.added, modified: summary.modified, deleted: summary.deleted, failed: summary.failedFiles, identity_reviews: [...reviews.values()].filter(r => !r.decided).length } } : undefined);
  };

  const ownerOf = async (relPath: string): Promise<string | null> => {
    const slug = slugifyPath(relPath);
    const page = managed ? await managed.page(slug) : await engine.getPage(slug, { sourceId });
    if (page) return typeof page.frontmatter?.[APPLE_CONTACT_ID_KEY] === 'string' ? page.frontmatter[APPLE_CONTACT_ID_KEY] as string : 'hand-authored';
    if (cfg.record === 'git' && cfg.dir && existsSync(join(cfg.dir, relPath))) {
      return readFileSync(join(cfg.dir, relPath), 'utf8').match(/^apple_contact_id:\s*"([^"]+)"/m)?.[1] ?? 'hand-authored';
    }
    return null;
  };
  const existingPath = async (id: string) => (await engine.executeRaw<{ source_path: string | null }>(
    `SELECT source_path FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND frontmatter->>'${APPLE_CONTACT_ID_KEY}'=$2 LIMIT 1`, [sourceId, id]))[0]?.source_path ?? null;
  const ownedContacts = async () => new Set((await engine.executeRaw<{ id: string }>(
    `SELECT frontmatter->>'${APPLE_CONTACT_ID_KEY}' AS id FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND frontmatter ? '${APPLE_CONTACT_ID_KEY}'`, [sourceId])).map(r => r.id));

  const unlinkOurs = async (slug: string) => {
    const current = (await listEntityIdentities(engine, { slug, slugSourceId: sourceId })).find(m => m.slug === slug && m.source_id === sourceId);
    if (current?.established_by === APPLE_CONTACTS_LINK_ORIGIN) await unlinkContact(engine, current.entity_id, slug, sourceId);
  };
  const removePage = async (relPath: string) => {
    await unlinkOurs(slugifyPath(relPath));
    await deleteConnectorPage(ctx, relPath, `apple-contacts(${sourceId}): remove ${relPath}`, 'the contact was deleted in Apple Contacts', { soft: true });
  };
  const io = (id: string, render: ReturnType<typeof appleContactRender> | null, onWrite: (relPath: string) => void) => ({
    existingPath: () => existingPath(id),
    owner: ownerOf,
    baseSlug: () => (render ? appleBaseSlug(render, cfg.contactsDir) : null),
    tombstoneSlugs: () => appleTombstoneSlugs(id, cfg.contactsDir),
    render: (disambiguate: boolean) => (render ? renderAppleContactPage(render, disambiguate, cfg.contactsDir) : null),
    write: async (relPath: string, markdown: string) => {
      await publishConnectorPage(ctx, { relPath, markdown: connectorRender(markdown, { path: relPath, [APPLE_CONTACT_ID_KEY]: id }),
        commitMessage: `apple-contacts(${sourceId}): ${relPath}`, privateMessage: `apple-contacts(${sourceId}): ${relPath} is private; database only`,
        retireReason: 'the contact changed in Apple Contacts' });
      onWrite(relPath);
    },
    remove: removePage,
    skippedHandAuthored: (relPath: string) => log(`[apple-contacts] skipping hand-authored ${relPath}`),
    applied: () => {},
  });

  /** Link (or unlink) one contact page and decide its person-page facts from what the page now holds. */
  const decideIdentity = async (id: string, slug: string, emails: string[], phones: string[], fields: PersonFields) => {
    const link = await linkContactPage(engine, sourceId, slug, emails, phones, countryCode);
    if (link.outcome === 'many') reviews.set(id, { contact_id: id, slug, candidates: link.candidates! });
    else reviews.delete(id);
    let target: { source_id: string; slug: string } | null = null;
    if (link.outcome === 'one') {
      const { pages } = await exactPersonMatches(engine, sourceId, emails, phones, countryCode);
      if (pages.length === 1 && pages[0]!.slug.startsWith('people/')) target = pages[0]!;
    }
    factTargets.set(id, target ? { person: target, fields: safePersonFields(fields, emails, phones, countryCode) } : null);
  };

  const applyUpsert = async (contact: AppleContact) => {
    const render = appleContactRender(contact);
    if (!renderAppleContactPage(render, false, cfg.contactsDir)) {
      // A contact left with no email and no phone has no page: the one it owned waits for the delete floor like a deletion.
      if (await existingPath(contact.id) !== null) pending.add(contact.id);
      else { pending.delete(contact.id); delete state.fps[contact.id]; }
      return;
    }
    pending.delete(contact.id);
    let written: string | null = null;
    await applyContactPage(contact.id, false, io(contact.id, render, relPath => { written = relPath; }));
    touched.add(contact.id);
    const slug = written !== null ? slugifyPath(written) : null;
    if (slug) await decideIdentity(contact.id, slug, render.data.emails, render.data.phones, { company: contact.organization, jobTitle: contact.jobTitle, groups: contact.groups });
    else { reviews.delete(contact.id); factTargets.set(contact.id, null); }
    state.fps[contact.id] = appleContactFingerprint(contact);
  };
  const applyDelete = async (id: string) => {
    await applyContactPage(id, true, io(id, null, () => {}));
    touched.add(id);
    reviews.delete(id);
    factTargets.set(id, null);
    delete state.fps[id];
  };

  const handle = async (change: AppleContactChange) => {
    const key = appleContactHoldKey(change.id);
    const version = change.op === 'upsert' ? appleContactFingerprint(change.contact) : 'delete';
    if (!holds.shouldAttempt(key, version)) return;
    try {
      if (change.op === 'upsert') await applyUpsert(change.contact); else await applyDelete(change.id);
      holds.succeed(key);
    } catch (error) {
      if (stopsRun(error) || (managed && abortsManagedRun(error))) throw error;
      const wasHeld = holds.isHeld(key);
      summary.failedFiles++;
      await holds.fail(key, error, { version, slug: null });
      log(`[apple-contacts] contact ${JSON.stringify(change.id)} failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!wasHeld) blocked = true;
    }
  };

  /** No cursor: read the whole snapshot, check the floor, then apply it. Returns whether it ended with full:true. */
  const snapshot = async (): Promise<boolean> => {
    const items = new Map<string, AppleContactChange>();
    let cursor: string | null = null;
    let meta = { nextCursor: null as string | null, more: true, full: false };
    for (let pages = 0; meta.more; pages++) {
      if (pages >= MAX_SNAPSHOT_PAGES) throw appleContactsError('apple_contacts_helper_error', `The Apple Contacts snapshot for ${sourceId} ran past ${MAX_SNAPSHOT_PAGES} pages. Nothing was written.`,
        'Report this with gbrain doctor --json; the helper may be returning the same page again.');
      const page = await helper.changes(cursor, signal);
      for (const item of page.items) items.set(item.id, item);
      meta = page.meta;
      cursor = page.meta.nextCursor;
    }
    const owned = await ownedContacts();
    const upserts = [...items.values()].filter((i): i is Extract<AppleContactChange, { op: 'upsert' }> => i.op === 'upsert');
    // A contact with no email and no phone renders no page: the page it owned is a deletion, counted against the floor.
    const blank = new Set(upserts.filter(i => !renderAppleContactPage(appleContactRender(i.contact), false, cfg.contactsDir)).map(i => i.id));
    const deletes = new Set([...items.values()].filter(i => (i.op === 'delete' || blank.has(i.id)) && owned.has(i.id)).map(i => i.id));
    if (meta.full) for (const id of owned) if (!items.has(id) || items.get(id)!.op === 'delete') deletes.add(id);
    await checkSnapshotFloor(sourceId, owned.size, upserts.length - blank.size, deletes.size);
    if (!meta.full) log(`[apple-contacts] ${sourceId}: the snapshot did not end with full:true; nothing is deleted for being absent and no person-page fact is retired`);
    for (const change of upserts) pending.delete(change.id);
    for (const change of upserts) {
      if (signal?.aborted) return meta.full;
      if (blank.has(change.id)) continue;
      if (!opts.full && owned.has(change.id) && state.fps[change.id] === appleContactFingerprint(change.contact)) continue;
      await handle(change);
    }
    for (const id of deletes) await handle({ op: 'delete', id });
    if (meta.full) for (const id of Object.keys(state.fps)) if (!items.has(id) && !owned.has(id)) delete state.fps[id];
    // A complete snapshot settles every pending deletion: what it does not hold was deleted above, under its own floor.
    if (meta.full && !blocked) pending.clear();
    await persistPending(pending.size ? pendingRow.held : null);
    if (!blocked) state.cursor = meta.nextCursor;
    return meta.full;
  };

  /** A saved cursor: apply each page of changes, saving its next_cursor once it is applied. */
  const incremental = async (): Promise<boolean> => {
    let cursor = state.cursor;
    for (;;) {
      let page;
      try { page = await helper.changes(cursor, signal); } catch (error) {
        if (!(error instanceof AppleContactsCursorExpiredError)) throw error;
        log(`[apple-contacts] ${sourceId}: the helper no longer knows the saved cursor (410 cursor_expired, or 400 bad_param); reading a full snapshot`);
        state.cursor = null;
        return snapshot();
      }
      for (const change of page.items) {
        if (change.op === 'upsert') { await handle(change); continue; }
        // A deletion is recorded, not applied: the run's deletions pass the delete floor together at the end.
        if (await existingPath(change.id) !== null) pending.add(change.id);
        else delete state.fps[change.id];
      }
      if (blocked || signal?.aborted) return true;
      // The page is applied (upserts written, deletions pending in the database) before its cursor goes back.
      await persistPending(pendingRow.held);
      state.cursor = page.meta.nextCursor ?? cursor;
      cursor = state.cursor;
      await save(false);
      if (!page.meta.more) break;
    }
    await settlePending();
    return true;
  };

  /** The end of an incremental run: apply the pending deletions when they pass the delete floor, else keep them. */
  const settlePending = async () => {
    const owned = await ownedContacts();
    for (const id of [...pending]) if (!owned.has(id)) pending.delete(id);
    if (!pending.size) { if (pendingRow.ids.length || pendingRow.held) await persistPending(null); return; }
    const { massReconcileAllowed } = await import('../../commands/sync.ts');
    const all = pending.size >= owned.size;
    if (all || (pending.size > owned.size * APPLE_CONTACTS_DELETE_FLOOR && !massReconcileAllowed())) {
      await persistPending({ code: 'apple_contacts_delete_floor', contacts: pending.size, owned: owned.size, since: pendingRow.held?.since ?? new Date(now()).toISOString() });
      floor.refusal = deleteFloor(sourceId, all ? `the helper reported every one of the ${owned.size} contacts the source owns as deleted.`
        : `the helper reported ${pending.size} of the ${owned.size} contacts the source owns as deleted (more than ${APPLE_CONTACTS_DELETE_FLOOR * 100}%).`, true);
      log(`[apple-contacts] ${floor.refusal.message}`);
      return;
    }
    for (const id of [...pending]) await handle({ op: 'delete', id });
    for (const id of [...pending]) if (await existingPath(id) === null) pending.delete(id);
    await persistPending(null);
  };

  try {
    const complete = opts.full || !state.cursor ? await snapshot() : await incremental();

    // Reviews and deferred person-page facts this run did not reach are decided again from the contact page itself.
    for (const id of new Set([...reviews.keys(), ...deferred])) {
      if (touched.has(id)) continue;
      const [page] = await engine.executeRaw<{ slug: string; frontmatter: Record<string, unknown> }>(
        `SELECT slug, frontmatter FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND frontmatter->>'${APPLE_CONTACT_ID_KEY}'=$2 LIMIT 1`, [sourceId, id]);
      if (!page) { reviews.delete(id); factTargets.set(id, null); continue; }
      const fm = typeof page.frontmatter === 'string' ? JSON.parse(page.frontmatter) as Record<string, unknown> : page.frontmatter;
      const list = (v: unknown) => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);
      await decideIdentity(id, page.slug, list(fm.emails), list(fm.phones), { company: typeof fm.company === 'string' ? fm.company : null,
        jobTitle: typeof fm.role === 'string' ? fm.role : null, groups: list(fm.tags) });
    }
    for (const review of reviews.values()) {
      if (await decidedDifferent(engine, review.candidates)) review.decided = 'different'; else delete review.decided;
    }
    await writeIdentityReviews(engine, sourceId, [...reviews.values()]);
    const waiting = [...reviews.values()].filter(r => !r.decided).length;
    if (waiting) log(`[apple-contacts] ${sourceId}: ${waiting} contact(s) match two or more people and wait for the owner: gbrain sync status --source ${sourceId}`);

    // Person-page facts. A page another contact of this source already holds keeps its rows (first writer wins).
    const holderOf = new Map(Object.entries(holders));
    const pageOf = new Map(Object.entries(holders).map(([page, id]) => [id, page]));
    state.deferred = [];
    const sync = async (id: string, person: { source_id: string; slug: string }, claims: string[]) => {
      try { return await syncPersonFacts(engine, sourceId, person, claims, log); } catch (error) {
        if (stopsRun(error)) throw error;
        summary.failedFiles++;
        state.deferred!.push(id);
        log('[apple-contacts] ' + sourceId + ': the facts on ' + person.slug + ' were not updated: ' + (error instanceof Error ? error.message : String(error)));
        return null;
      }
    };
    for (const [id, target] of factTargets) {
      const had = pageOf.get(id) ?? null;
      const want = target ? holderKey(target.person) : null;
      const claims = target ? personClaims(target.fields) : [];
      if (had && had !== want) {
        if (!complete) { state.deferred.push(id); continue; }
        const [source_id, slug] = had.split('\t') as [string, string];
        if (await sync(id, { source_id, slug }, []) === null) continue;
        delete holders[had]; holderOf.delete(had); pageOf.delete(id);
      }
      if (!target || !want) continue;
      const holder = holderOf.get(want);
      if (holder && holder !== id) { log('[apple-contacts] ' + sourceId + ': ' + target.person.slug + ' already carries the facts of another contact; left as it is'); continue; }
      if (!claims.length && !complete) { state.deferred.push(id); continue; }
      const result = await sync(id, target.person, claims);
      if (result === null) continue;
      if (claims.length && result !== 'skipped') { holders[want] = id; holderOf.set(want, id); pageOf.set(id, want); }
      else if (!claims.length) { delete holders[want]; holderOf.delete(want); pageOf.delete(id); }
    }
    if (!state.deferred.length) delete state.deferred;
    await writePersonFactHolders(engine, sourceId, holders);

    if (summary.failedFiles > 0 || blocked || floor.refusal) summary.status = 'partial';
    state.item_holds = holds.finish();
    await save(true);
    await holds.complete();
    if (!managed) await engine.executeRaw('UPDATE sources SET last_sync_at=now() WHERE id=$1', [sourceId]).catch(() => undefined);
  } catch (error) {
    if (stopsRun(error) && !(error as { name?: string }).name?.startsWith('Lock')) {
      try { state.item_holds = holds.holds.finish().state; await save(false); } catch { /* the original error is what the caller sees */ }
    }
    throw error;
  }

  // Contact cards are structured fields, not prose: no fact extraction; embeddings as every connector page gets them.
  await afterConnectorPublish(ctx, { ...opts, noExtract: true });
  // Deletions the floor held: the run's other changes are applied and its cursor saved; the named error is the result.
  if (floor.refusal) throw floor.refusal;
  return {
    status: summary.status === 'partial' ? 'partial' : summary.added + summary.modified + summary.deleted > 0 ? 'synced' : 'up_to_date',
    fromCommit: null, toCommit: '', added: summary.added, modified: summary.modified, deleted: summary.deleted, renamed: 0,
    chunksCreated: summary.chunksCreated, embedded: summary.embedded, pagesAffected: summary.pagesAffected,
    ...(summary.failedFiles > 0 ? { failedFiles: summary.failedFiles } : {}),
    ...(summary.status === 'partial' ? { filesImported: summary.added + summary.modified, reason: summary.failedFiles > 0 ? 'connector_item_failures' as const : 'connector_partial' as const } : {}),
    ...connectorHoldsResult(sourceId, holds.summary()),
  };
}
