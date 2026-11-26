/**
 * C7 collapse (GST-3642): two person pages in one source with the same name and a shared id are one person's page kept
 * twice (every pair in its labelled sample was). gbrain dedupe auto --apply collapses each such pair. The newer page (the
 * retired one; the older page is kept, canonicalOf) gets `merged_into: <the kept page's slug>` and a `dedupe_collapse`
 * record (class, time, and the aliases it added), and the kept page gets the retired page's title and aliases in its
 * `aliases`. Entity lookup, link resolution, search and the mention pass already follow merged_into, and the duplicate
 * finder leaves retired pages out, so the pair is not proposed again. Only frontmatter changes: the retired page keeps
 * its body, and nothing is deleted or renamed.
 *
 * Where it is written. In a source whose root is a git work tree, both files are edited and committed in one commit
 * through the one door (commitBrainFiles: the checkout's commit lock, then gbrain git commit-push) before the database
 * reads them back (importFromFile); the commit's parent is the backup, and reverting the commit undoes the collapse. In a
 * source with no repository, both pages are edited through the page door (edit_page against the revision read), which
 * keeps each page's version before the edit in its history (gbrain revert). Either way the record names the collapse,
 * so gbrain dedupe undo <collapse id> removes exactly what it added (one commit, or two page edits), and gbrain dedupe
 * reject <collapse id> also keeps the pair apart for good.
 *
 * Every write re-reads the pages inside it (under the commit lock, or against the revision read) and leaves a pair whose
 * pages changed meanwhile (skipped, reason changed), so a stale plan never writes over a page that was retired, edited or
 * removed.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dump, JSON_SCHEMA } from 'js-yaml';
import type { BrainEngine } from '../../engine.ts';
import type { Page } from '../../types.ts';
import type { GBrainConfig } from '../../config.ts';
import type { IdentityMemberRef } from '../../engine-sql/identity-decisions.ts';
import { isGitWorkTree, sourcePolicyRoot } from '../../access/policy-git.ts';
import { readOnlyCheckout } from '../../persistence/mirror-read-only.ts';
import { loadBoundedYaml } from '../../data-frontmatter.ts';
import { serializePageToMarkdown } from '../../markdown.ts';
import { withoutBody } from '../../page-body/page-shape.ts';
import { importFromFile } from '../../import-file.ts';
import { OperationError } from '../../ops/contract.ts';
import { canonicalOf, commitBrainFiles, decisionId, git } from '../identity-decisions.ts';
import { personPageTypes, strictNameFold } from '../duplicates.ts';

export const COLLAPSE_KEY = 'dedupe_collapse';
export type CollapseClass = 'C7';

export interface CollapsePlan {
  /** The collapse id: decisionId of the two pages, so it reads like a decision id. */
  collapse: string;
  pair: string;
  class: CollapseClass;
  source_id: string;
  /** The page that stays. */
  canonical: string;
  /** The page that gets merged_into. */
  retired: string;
  /** What the kept page's aliases gain, as planned (the write recomputes it from the page it reads). */
  aliases: string[];
  store: 'git' | 'database';
}

export interface CollapseRecord { collapse: string; class: CollapseClass; source_id: string; retired: string; canonical: string; at: string; aliases: string[] }

/**
 * skipped: nothing was written, because a page changed since the plan or the undo (changed), a file's frontmatter cannot
 * be edited line by line without touching other keys (frontmatter_not_editable; edit it by hand), a file has edits not
 * committed yet (uncommitted_changes; commit them first), the source's checkout is read-only (read_only_source), or the
 * write failed (failed, with the error in note). A note on any outcome names what is left to do by hand.
 */
export type CollapseSkip = 'changed' | 'frontmatter_not_editable' | 'uncommitted_changes' | 'read_only_source' | 'failed';
export interface CollapseOutcome { collapse: string; status: 'collapsed' | 'undone' | 'skipped'; reason?: CollapseSkip; store: 'git' | 'database'; commit?: string | null; outcome?: string; note?: string }

type Store = { kind: 'git'; root: string } | { kind: 'database' } | { kind: 'read_only' };

async function storeOf(engine: BrainEngine, sourceId: string): Promise<Store> {
  if (!(await engine.listAllSources()).some(x => x.id === sourceId) || await readOnlyCheckout(engine, sourceId)) return { kind: 'read_only' };
  const root = await sourcePolicyRoot(engine, sourceId);
  return root && isGitWorkTree(root) ? { kind: 'git', root } : { kind: 'database' };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean);
const retiredFm = (fm: Record<string, unknown>) => ['merged_into', 'superseded_by'].some(k => strings(fm[k]).length > 0)
  || ['false', 'no'].includes(String(fm.canonical ?? '').toLowerCase()) || fm[COLLAPSE_KEY] !== undefined;

/** The aliases the kept page gains: the retired page's title and aliases, less any the kept page already answers to. */
function aliasesToAdd(keptTitle: string, keptFm: Record<string, unknown>, retiredTitle: string, retiredFm: Record<string, unknown>): string[] {
  const known = new Set([keptTitle, ...strings(keptFm.aliases)].map(a => strictNameFold(a)).filter(Boolean));
  const out: string[] = [];
  for (const a of [retiredTitle, ...strings(retiredFm.aliases)]) {
    const f = strictNameFold(a);
    if (!a.trim() || !f || known.has(f)) continue;
    known.add(f);
    out.push(a.trim());
  }
  return out;
}

const filePath = (p: { slug: string; source_path?: string | null }) => p.source_path?.trim() || `${p.slug}.md`;

/** What collapsing a same-source pair would do, or why it cannot be done (null plan, with the reason). Read-only. */
export async function planCollapse(engine: BrainEngine, pair: string, members: IdentityMemberRef[]): Promise<{ plan: CollapsePlan } | { reason: 'read_only_source' | 'no_file' }> {
  const sourceId = members[0]!.source_id;
  const store = await storeOf(engine, sourceId);
  if (store.kind === 'read_only') return { reason: 'read_only_source' };
  const canonical = await canonicalOf(engine, members, null);
  const retired = members.find(m => m.slug !== canonical.slug)!;
  const [kept, gone] = [await engine.getPage(canonical.slug, { sourceId }), await engine.getPage(retired.slug, { sourceId })];
  if (!kept || !gone) return { reason: 'no_file' };
  if (store.kind === 'git' && [kept, gone].some(p => !existsSync(join(store.root, filePath(p))))) return { reason: 'no_file' };
  const fm = (p: Page) => (p.frontmatter ?? {}) as Record<string, unknown>;
  return { plan: { collapse: decisionId(members), pair, class: 'C7', source_id: sourceId, canonical: canonical.slug, retired: retired.slug,
    aliases: aliasesToAdd(kept.title, fm(kept), gone.title, fm(gone)), store: store.kind } };
}

// ---- frontmatter text edits for the git store: only the keys the collapse owns change, byte for byte.

const HEAD = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

interface Head { yaml: string; fm: Record<string, unknown>; set: (yaml: string) => string }

function headOf(text: string): Head {
  const m = HEAD.exec(text);
  if (!m && /^(?:\uFEFF|\s*---)/.test(text)) throw new Error('a frontmatter block this editor does not read line by line');
  if (!m) return { yaml: '', fm: {}, set: yaml => (yaml ? `---\n${yaml}\n---\n${text}` : text) };
  const start = text.indexOf('\n') + 1;
  const raw = m[1] ?? '';
  const parsed = raw.trim() ? loadBoundedYaml(raw, { schema: JSON_SCHEMA }) : {};
  return { yaml: raw, fm: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {},
    set: yaml => (raw ? text.slice(0, start) + yaml + text.slice(start + raw.length) : text.slice(0, start) + (yaml ? `${yaml}\n` : '') + text.slice(start)) };
}

const block = (obj: Record<string, unknown>) => dump(obj, { lineWidth: -1, noRefs: true }).trimEnd();

/** The line range [from, to) of a top-level key, or null. */
function keyLines(lines: string[], key: string): [number, number] | null {
  const at = lines.findIndex(l => l.startsWith(`${key}:`));
  if (at < 0) return null;
  let end = at + 1;
  while (end < lines.length && (lines[end] === '' || /^[\s-]/.test(lines[end]!))) end++;
  while (end > at + 1 && lines[end - 1] === '') end--;
  return [at, end];
}

function withKey(yaml: string, key: string, value: unknown): string {
  const lines = yaml ? yaml.split('\n') : [];
  const at = keyLines(lines, key);
  const text = value === undefined ? [] : block({ [key]: value }).split('\n');
  if (at) lines.splice(at[0], at[1] - at[0], ...text);
  else lines.push(...text);
  return lines.join('\n');
}

/** Applies `delta` to a file's frontmatter text, or null unless the parsed result is exactly the intended one. */
function editFile(text: string, delta: Record<string, unknown | undefined>): string | null {
  const head = headOf(text);
  let yaml = head.yaml;
  for (const [k, v] of Object.entries(delta)) yaml = withKey(yaml, k, v);
  const next = head.set(yaml);
  const want = { ...head.fm };
  for (const [k, v] of Object.entries(delta)) if (v === undefined) delete want[k]; else want[k] = v;
  let parsed: Record<string, unknown>;
  try { parsed = headOf(next).fm; } catch { return null; }
  return JSON.stringify(sortKeys(parsed)) === JSON.stringify(sortKeys(want)) ? next : null;
}

const sortKeys = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// ---- the two changes, shared by both stores.

function collapseDelta(c: { canonical: string; retired: string; at: string }, keptTitle: string, keptFm: Record<string, unknown>, goneTitle: string, goneFm: Record<string, unknown>) {
  if (retiredFm(goneFm) || retiredFm(keptFm)) return null;
  if (strings(goneFm.distinct_from).includes(c.canonical) || strings(keptFm.distinct_from).includes(c.retired)) return null;
  const aliases = aliasesToAdd(keptTitle, keptFm, goneTitle, goneFm);
  return {
    aliases,
    retired: { merged_into: c.canonical, [COLLAPSE_KEY]: { class: 'C7', at: c.at, ...(aliases.length ? { aliases } : {}) } },
    kept: aliases.length ? { aliases: [...strings(keptFm.aliases), ...aliases] } : {},
  };
}

function undoDelta(rec: CollapseRecord, goneFm: Record<string, unknown>, keptFm: Record<string, unknown> | null) {
  if (strings(goneFm.merged_into)[0] !== rec.canonical || goneFm[COLLAPSE_KEY] === undefined) return null;
  const left = keptFm ? strings(keptFm.aliases).filter(a => !rec.aliases.includes(a)) : [];
  const kept = keptFm && rec.aliases.some(a => strings(keptFm.aliases).includes(a)) ? { aliases: left.length ? left : undefined } : {};
  return { retired: { merged_into: undefined, [COLLAPSE_KEY]: undefined }, kept };
}

// ---- git store

async function writeInGit(engine: BrainEngine, root: string, sourceId: string, slugs: { retired: string; canonical: string }, message: string,
  change: (gone: { title: string; fm: Record<string, unknown> }, kept: { title: string; fm: Record<string, unknown> } | null) =>
    { retired: Record<string, unknown>; kept: Record<string, unknown> } | null, guard?: () => Promise<boolean>): Promise<{ written: boolean; blocked?: CollapseSkip; commit?: string | null; outcome?: string; note?: string }> {
  const [gone, kept] = [await engine.getPage(slugs.retired, { sourceId }), await engine.getPage(slugs.canonical, { sourceId })];
  if (!gone) return { written: false };
  const paths = { retired: filePath(gone), kept: kept ? filePath(kept) : null };
  let blocked: CollapseSkip | undefined;
  const receipt = await commitBrainFiles(root, [], message, async () => {
    if (guard && !(await guard())) return [];
    if ((await git(root, ['status', '--porcelain', '-z', '--', paths.retired, ...(paths.kept ? [paths.kept] : [])])).length) { blocked = 'uncommitted_changes'; return []; }
    const read = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : null);
    const goneText = read(paths.retired);
    const keptText = paths.kept ? read(paths.kept) : null;
    if (goneText === null) return [];
    let goneHead: Head, keptHead: Head | null;
    try { [goneHead, keptHead] = [headOf(goneText), keptText === null ? null : headOf(keptText)]; } catch { blocked = 'frontmatter_not_editable'; return []; }
    const title = (h: Head, fallback: string) => (typeof h.fm.title === 'string' ? h.fm.title : fallback);
    const delta = change({ title: title(goneHead, gone.title), fm: goneHead.fm }, keptHead && { title: title(keptHead, kept!.title), fm: keptHead.fm });
    if (!delta) return [];
    const files = [{ path: paths.retired, text: editFile(goneText, delta.retired) }];
    if (keptText !== null && Object.keys(delta.kept).length) files.push({ path: paths.kept!, text: editFile(keptText, delta.kept) });
    if (files.some(f => f.text === null)) { blocked = 'frontmatter_not_editable'; return []; }
    return files as Array<{ path: string; text: string }>;
  });
  if (!receipt) return { written: false, ...(blocked ? { blocked } : {}) };
  for (const p of receipt.paths) await importFromFile(engine, join(root, p), p, { sourceId, noEmbed: true });
  return { written: true, commit: receipt.commit, outcome: receipt.outcome, ...(receipt.note ? { note: receipt.note } : {}) };
}

// ---- database store: frontmatter-only edits through the page door, as extraction_review's distinct does.

type HeadEdit = 'edited' | 'unchanged' | 'changed';

async function editPageHead(engine: BrainEngine, config: GBrainConfig | null, sourceId: string, slug: string, reason: string, revision: string | null,
  change: (fm: Record<string, unknown>) => Record<string, unknown | undefined> | null, guard?: () => Promise<boolean>): Promise<HeadEdit> {
  const { withPublicationGuard } = await import('../../persistence/publication-guard.ts');
  const { submitPageMutation } = await import('../../persistence/page-mutations.ts');
  return withPublicationGuard(engine, sourceId, async () => {
    if (guard && !(await guard())) return 'changed';
    const snapshot = await engine.readPageSnapshot(slug, { sourceId });
    if (!snapshot || snapshot.page.deleted_at || (revision && snapshot.revision !== revision)) return 'changed';
    const fm = (snapshot.page.frontmatter ?? {}) as Record<string, unknown>;
    const delta = change(fm);
    if (!delta) return 'changed';
    if (!Object.keys(delta).length) return 'unchanged';
    const next = { ...fm };
    for (const [k, v] of Object.entries(delta)) if (v === undefined) delete next[k]; else next[k] = v;
    const head = (frontmatter: Record<string, unknown>) =>
      serializePageToMarkdown({ ...withoutBody(snapshot.page), frontmatter, compiled_truth: '', timeline: '' } as Page, snapshot.tags).slice(0, -1);
    const ctx = { engine, config: config ?? ({ engine: engine.kind } as never), remote: false, dryRun: false, sourceId,
      logger: { info() {}, warn() {}, error() {} } } as unknown as Parameters<typeof submitPageMutation>[0];
    try {
      await submitPageMutation(ctx, { operation: 'edit_page', params: { slug, source_id: sourceId, edits: [{ old_text: head(fm), new_text: head(next) }],
        expected_revision: snapshot.revision, request_id: randomUUID(), reason } });
      return 'edited';
    } catch (error) {
      if (error instanceof OperationError && ['revision_conflict', 'changed_since_preview'].includes(error.code)) return 'changed';
      throw error;
    }
  });
}

async function revisionOf(engine: BrainEngine, slug: string, sourceId: string) {
  return (await engine.readPageSnapshot(slug, { sourceId }))?.revision ?? null;
}

// ---- the verbs

const gitOutcome = (collapse: string, done: 'collapsed' | 'undone', r: Awaited<ReturnType<typeof writeInGit>>): CollapseOutcome => (r.written
  ? { collapse, status: done, store: 'git', commit: r.commit ?? null, ...(r.outcome ? { outcome: r.outcome } : {}), ...(r.note ? { note: r.note } : {}) }
  : { collapse, status: 'skipped', reason: r.blocked ?? 'changed', store: 'git' });

/**
 * Collapses one planned pair; skipped, writing nothing, when a page changed since the plan or `guard` (run inside the
 * write: under the commit lock, or under the source's publication guard before the first edit) says the pair may no
 * longer be collapsed.
 */
export async function applyCollapse(engine: BrainEngine, c: CollapsePlan, config: GBrainConfig | null = null, guard?: () => Promise<boolean>): Promise<CollapseOutcome> {
  const at = new Date().toISOString();
  const store = await storeOf(engine, c.source_id);
  if (store.kind === 'read_only') return { collapse: c.collapse, status: 'skipped', reason: 'read_only_source', store: c.store };
  const message = `dedupe: collapse ${c.source_id}:${c.retired} into ${c.canonical} (C7)\n\nDedupe-Collapse: ${c.collapse}`;
  if (store.kind === 'git') {
    const r = await writeInGit(engine, store.root, c.source_id, c, message, (gone, kept) => {
      if (!kept) return null;
      const d = collapseDelta({ canonical: c.canonical, retired: c.retired, at }, kept.title, kept.fm, gone.title, gone.fm);
      return d && { retired: d.retired, kept: d.kept };
    }, guard);
    return gitOutcome(c.collapse, 'collapsed', r);
  }
  const kept = await engine.readPageSnapshot(c.canonical, { sourceId: c.source_id });
  const gone = await engine.getPage(c.retired, { sourceId: c.source_id });
  if (!kept || !gone) return { collapse: c.collapse, status: 'skipped', reason: 'changed', store: 'database' };
  const keptFm = (kept.page.frontmatter ?? {}) as Record<string, unknown>;
  const delta = collapseDelta({ canonical: c.canonical, retired: c.retired, at }, kept.page.title, keptFm, gone.title, (gone.frontmatter ?? {}) as Record<string, unknown>);
  if (!delta) return { collapse: c.collapse, status: 'skipped', reason: 'changed', store: 'database' };
  const reason = `dedupe collapse ${c.collapse}`;
  const first = await editPageHead(engine, config, c.source_id, c.retired, reason, null,
    fm => (retiredFm(fm) || strings(fm.distinct_from).includes(c.canonical) ? null : delta.retired), guard);
  if (first !== 'edited') return { collapse: c.collapse, status: 'skipped', reason: 'changed', store: 'database' };
  const takeBack = async (why: string): Promise<string | undefined> => {
    const r = await editPageHead(engine, config, c.source_id, c.retired, `${reason}: ${why}, so the collapse is taken back`, null,
      fm => (fm[COLLAPSE_KEY] !== undefined ? { merged_into: undefined, [COLLAPSE_KEY]: undefined } : {})).catch(() => 'changed' as const);
    return r === 'changed' ? `${c.retired} still points at ${c.canonical}: run gbrain dedupe undo ${c.collapse}` : undefined;
  };
  let second: HeadEdit;
  try { second = await editPageHead(engine, config, c.source_id, c.canonical, reason, kept.revision, () => delta.kept); }
  catch (error) {
    if (error instanceof OperationError && error.code === 'write_pending') return { collapse: c.collapse, status: 'collapsed', store: 'database',
      note: `the aliases for ${c.canonical} were accepted and are still being written` };
    const note = await takeBack('the kept page could not be edited');
    return { collapse: c.collapse, status: 'skipped', reason: 'failed', store: 'database', note: [error instanceof Error ? error.message : String(error), note].filter(Boolean).join('; ') };
  }
  if (second === 'changed') {
    const note = await takeBack('the kept page changed');
    return { collapse: c.collapse, status: 'skipped', reason: 'changed', store: 'database', ...(note ? { note } : {}) };
  }
  return { collapse: c.collapse, status: 'collapsed', store: 'database' };
}

/** Removes exactly what a collapse added: the retired page's pointer and record, and the aliases it gave the kept page. */
export async function undoCollapse(engine: BrainEngine, rec: CollapseRecord, config: GBrainConfig | null = null): Promise<CollapseOutcome> {
  const store = await storeOf(engine, rec.source_id);
  if (store.kind === 'read_only') return { collapse: rec.collapse, status: 'skipped', reason: 'read_only_source', store: 'database' };
  if (store.kind === 'git') {
    const r = await writeInGit(engine, store.root, rec.source_id, rec,
      `dedupe: undo the collapse of ${rec.source_id}:${rec.retired} into ${rec.canonical} (C7)\n\nDedupe-Collapse-Undo: ${rec.collapse}`,
      (gone, kept) => undoDelta(rec, gone.fm, kept?.fm ?? null));
    return gitOutcome(rec.collapse, 'undone', r);
  }
  const reason = `dedupe undo collapse ${rec.collapse}`;
  const keptRevision = await revisionOf(engine, rec.canonical, rec.source_id);
  const kept = keptRevision ? await engine.getPage(rec.canonical, { sourceId: rec.source_id }) : null;
  const first = await editPageHead(engine, config, rec.source_id, rec.retired, reason, null, fm => undoDelta(rec, fm, null)?.retired ?? null);
  if (first !== 'edited') return { collapse: rec.collapse, status: 'skipped', reason: 'changed', store: 'database' };
  const second = kept ? await editPageHead(engine, config, rec.source_id, rec.canonical, reason, null, fm => undoDelta(rec, { merged_into: rec.canonical, [COLLAPSE_KEY]: {} }, fm)?.kept ?? {}) : 'unchanged';
  if (second === 'changed') return { collapse: rec.collapse, status: 'skipped', reason: 'changed', store: 'database',
    note: `${rec.retired} is live again, but ${rec.canonical} changed meanwhile, so the aliases this collapse gave it (${rec.aliases.join(', ') || 'none'}) are still there: remove them by hand` };
  return { collapse: rec.collapse, status: 'undone', store: 'database' };
}

/** Every collapse still in place, newest first: retired person pages that carry a dedupe_collapse record. Read-only. */
export async function listCollapses(engine: BrainEngine): Promise<CollapseRecord[]> {
  const types = await personPageTypes(engine);
  const out: CollapseRecord[] = [];
  for (let after: { source_id: string; slug: string } | undefined; ;) {
    const rows = await engine.listEntityKeyRows({ types, keys: ['merged_into', COLLAPSE_KEY], collapsed: true, limit: 2000, ...(after ? { after } : {}) });
    for (const row of rows) {
      const rec = row.keys[COLLAPSE_KEY] as Record<string, unknown> | null;
      const canonical = strings(row.keys.merged_into)[0];
      if (!rec || typeof rec !== 'object' || rec.class !== 'C7' || !canonical) continue;
      out.push({ collapse: decisionId([{ source_id: row.source_id, slug: row.slug }, { source_id: row.source_id, slug: canonical }]), class: 'C7',
        source_id: row.source_id, retired: row.slug, canonical, at: typeof rec.at === 'string' ? rec.at : '', aliases: strings(rec.aliases) });
    }
    if (rows.length < 2000) break;
    after = { source_id: rows.at(-1)!.source_id, slug: rows.at(-1)!.slug };
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
