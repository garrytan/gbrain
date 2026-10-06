/**
 * Write-path guard for the always-loaded core tier (src/core/core-memory.ts).
 *
 * Every page mutation that touches a core page (before or after the write)
 * passes through here: owner-only marking, the brain-wide character budget,
 * the remote-edit policy and its notices. Zero LLM.
 *
 * Two steps:
 *  - `prepareCoreGuard` runs at prepare time against the snapshot and the
 *    parsed incoming page. It refuses deterministic violations early and
 *    returns a plan (or null when no core page is involved).
 *  - The plan's `validate` re-runs the budget inside the publish transaction,
 *    after `lockCoreSources` serialized every core writer, so concurrent core
 *    writes can never pass the limit together.
 *
 * Lock order: worktree native lock, then the protocol declaration takes the
 * brain row first (protocol.ts: `declareDurablePersistence`, the first
 * statement of the publish transaction), then the `persistence_worktrees`
 * FOR SHARE ownership check, then `lockCoreSources` (source rows FOR UPDATE
 * in id order) before `authorizeStoredRequest` (source FOR SHARE), then
 * `lockCounters`: the global order protocol.ts documents, brain row →
 * worktree row → source rows (id order) → counters.
 */
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import type { Action } from '../agent-output.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import {
  CORE_DOCS, CORE_MAX_PAGES, coreChars, coreMarking, coreUsage, listCorePages, readCoreSettings, renderCorePage, type CoreSettings,
} from '../core-memory.ts';
import type { WriteRequest } from './model.ts';

/** Source rows a core-touching write locks: its own source and `default` (the brain-wide core lock). */
export function coreLockSources(sourceId: string): string[] {
  return [...new Set([sourceId, 'default'])].sort();
}

/**
 * The one lock function for core writers. Takes the listed `sources` rows
 * FOR UPDATE in id order inside the publish transaction (transaction-scoped,
 * PgBouncer-safe). See the module comment for the global order.
 */
export async function lockCoreSources(tx: Pick<BrainEngine, 'executeRaw'>, sourceIds: readonly string[]): Promise<void> {
  const ids = [...new Set(sourceIds)].sort();
  if (!ids.length) return;
  await tx.executeRaw('SELECT id FROM sources WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [ids]);
}

function ownerFix(row: WriteRequest, argv: string[], why: string): Action {
  return row.authority.remote
    ? { argv, consent: [], actor: 'user', why, requires_exclusive: false, docs: `${CORE_DOCS}#owner-only`,
      user_message: 'Only the brain owner can change which pages are always loaded. Please run the command shown in a terminal on the brain host.' }
    : { argv, consent: [], actor: 'agent', why, requires_exclusive: false, docs: `${CORE_DOCS}#owner-only` };
}

const statusFix = (): Action => readFix('Shows core usage against the budget, the largest core pages and what each lane delivers, read-only.',
  { argv: ['gbrain', 'core', 'status', '--json'] });

export interface CoreGuardInput {
  row: WriteRequest;
  snapshot: PageSnapshot | null;
  /** Parsed incoming page (title, compiled_truth, frontmatter); null when the write deletes the page. */
  incoming: Pick<Page, 'title' | 'compiled_truth' | 'frontmatter'> | null;
  settings?: CoreSettings;
}

export interface CoreGuardPlan {
  exclusiveSources: string[];
  afterChars: number;
  beforeChars: number;
  /** Brain-wide core chars after this write, from the latest check. */
  usage(): { chars_used: number; chars_limit: number; page_chars: number } | null;
  /** Re-checks the budget against in-transaction state; call after `lockCoreSources`. */
  validate(tx: BrainEngine): Promise<void>;
  /** Records a remote-edit notice in the publish transaction when the policy is `notify`. */
  record(tx: Pick<BrainEngine, 'executeRaw'>, revision: string | null): Promise<void>;
}

/** The incoming core marking for a remote write that omitted the keys: carried from the snapshot. */
export function carryCoreMarking(snapshotFrontmatter: unknown, incoming: Record<string, unknown>): Record<string, unknown> {
  const before = (snapshotFrontmatter && typeof snapshotFrontmatter === 'object' ? snapshotFrontmatter : {}) as Record<string, unknown>;
  const out = { ...incoming };
  if (out.always_load === undefined && before.always_load !== undefined) out.always_load = before.always_load;
  if (out.core_priority === undefined && before.core_priority !== undefined) out.core_priority = before.core_priority;
  return out;
}

function budgetError(row: WriteRequest, used: number, limit: number, pageChars: number, others: Array<{ source_id: string; slug: string; chars: number }>, hiddenChars: number): Error {
  const over = used - limit;
  const largest = others.slice().sort((a, b) => b.chars - a.chars).slice(0, 3).map(p => `${p.source_id}:${p.slug} (${p.chars})`);
  const otherLine = largest.length ? ` Largest other core pages you can see: ${largest.join(', ')}.` : '';
  const hiddenLine = hiddenChars > 0 ? ` Core pages in sources you cannot read use ${hiddenChars} chars.` : '';
  // The write journal keeps only code + message for asynchronous refusals, so the message carries every number.
  const e = opError('core_budget_exceeded',
    `This write would make always-loaded core memory ${used} chars, over the ${limit}-char budget by ${over} (page ${row.source_id}:${row.slug} renders at ${pageChars}). Shorten it by at least ${over} chars: move detail into a linked non-core page and keep a one-line pointer.${otherLine}${hiddenLine}`,
    `Page ${row.source_id}:${row.slug} would render at ${pageChars} chars. Nothing was written. Shorten it by at least ${over} chars: move detail into a linked non-core page and keep a one-line pointer here, then submit the shorter content with a new request_id.${otherLine}${hiddenLine} Shrinking writes always pass; the owner can raise memory.core.max_chars (up to 6000).`,
    { fix: statusFix(), docs: `${CORE_DOCS}#budget` });
  e.detail = `chars_used=${used} chars_limit=${limit} page_chars=${pageChars} over_by=${over}`;
  return e;
}

/**
 * Prepare-time guard. Returns null when neither the stored nor the incoming
 * page is core. Throws the owner-only, remote-edit and budget refusals.
 */
export async function prepareCoreGuard(engine: BrainEngine, input: CoreGuardInput): Promise<CoreGuardPlan | null> {
  const { row, snapshot, incoming } = input;
  const live = snapshot && !snapshot.page.deleted_at ? snapshot : null;
  const before = live ? coreMarking(live.page.frontmatter) : { core: false, priority: null };
  const after = incoming ? coreMarking(incoming.frontmatter) : { core: false, priority: null };
  if (!before.core && !after.core) return null;
  const remote = row.authority.remote;

  if (remote && (before.core !== after.core || before.priority !== after.priority)) {
    if (!incoming && before.core) {
      throw opError('core_delete_owner_only', `Page ${row.source_id}:${row.slug} is always-loaded core memory, so a remote caller cannot delete it. Ask the user to run: gbrain core remove --source ${row.source_id} ${row.slug}`,
        'Nothing was deleted. Ask the user to remove it from core first (command in fix), then delete it.',
        { fix: ownerFix(row, ['gbrain', 'core', 'remove', '--source', row.source_id, row.slug], 'Removes the page from always-loaded core memory on the brain host.') });
    }
    const argv = after.core && !before.core
      ? ['gbrain', 'core', 'add', '--source', row.source_id, row.slug]
      : before.core && !after.core ? ['gbrain', 'core', 'remove', '--source', row.source_id, row.slug]
        : ['gbrain', 'core', 'add', '--source', row.source_id, row.slug, '--priority', String(after.priority ?? before.priority ?? 100)];
    throw opError('core_mark_owner_only', `Only the brain owner can change always_load or core_priority on ${row.source_id}:${row.slug}. Resubmit without changing them (omitted keys keep their stored values); if the core marking should change, ask the user to run: ${argv.join(' ')}`,
      'Nothing was written. Submit the content without changing always_load or core_priority (omitted keys keep their stored values), and ask the user to run the command in fix if the core marking itself should change.',
      { fix: ownerFix(row, argv, 'Changes which pages are always loaded, from the trusted local CLI.') });
  }

  const settings = input.settings ?? await readCoreSettings(engine);
  const afterRendered = incoming && after.core ? renderCorePage({ source_id: row.source_id, slug: row.slug, title: incoming.title, compiled_truth: incoming.compiled_truth }) : '';
  const beforeRendered = live && before.core ? renderCorePage({ source_id: row.source_id, slug: row.slug, title: live.page.title, compiled_truth: live.page.compiled_truth }) : '';
  const contentChanged = afterRendered !== beforeRendered;

  if (remote && before.core && contentChanged && settings.remoteEdit === 'refuse') {
    throw opError('core_remote_edit_refused', `Page ${row.source_id}:${row.slug} is always-loaded core memory and memory.core.remote_edit is refuse. Ask the user to make this edit on the brain host, or to run: gbrain config set memory.core.remote_edit notify`,
      'Nothing was written. Ask the user to make this edit from the brain host, or to allow remote edits with notices (command in fix).',
      { fix: ownerFix(row, ['gbrain', 'config', 'set', 'memory.core.remote_edit', 'notify'], 'Lets agents edit core pages; each remote edit then shows a review notice in the core block.') });
  }

  const afterChars = afterRendered.length;
  const beforeChars = beforeRendered.length;
  let lastTotal: number | null = null;
  const check = async (exec: BrainEngine) => {
    if (!after.core) return;
    const { pages } = await coreUsage(exec, { exclude: { sourceId: row.source_id, slug: row.slug } });
    if (pages.length + 1 > CORE_MAX_PAGES && !before.core) {
      throw opError('core_budget_exceeded', `Always-loaded core memory already has ${pages.length} pages; the limit is ${CORE_MAX_PAGES}. Remove a core page first (gbrain core remove) or keep ${row.source_id}:${row.slug} out of core.`,
        `Nothing was written. Remove a core page first (gbrain core remove), or keep ${row.source_id}:${row.slug} out of core.`,
        { fix: statusFix(), docs: `${CORE_DOCS}#budget` });
    }
    const total = coreChars([...pages, { chars: afterChars }]);
    lastTotal = total;
    const grew = !before.core || afterChars > beforeChars;
    if (total > settings.maxChars && grew) {
      // Remote diagnostics never name pages outside the write's own source or private pages.
      const seen = remote
        ? await listCorePages(exec, { sourceIds: [row.source_id], excludePrivate: true, exclude: { sourceId: row.source_id, slug: row.slug } })
        : pages;
      const hidden = pages.reduce((n, p) => n + p.chars, 0) - seen.reduce((n, p) => n + p.chars, 0);
      throw budgetError(row, total, settings.maxChars, afterChars, seen, hidden);
    }
  };
  await check(engine);

  return {
    exclusiveSources: coreLockSources(row.source_id),
    afterChars, beforeChars,
    usage: () => lastTotal === null ? null : { chars_used: lastTotal, chars_limit: settings.maxChars, page_chars: afterChars },
    validate: tx => check(tx),
    record: async (tx, revision) => {
      if (!remote || !before.core || !contentChanged || settings.remoteEdit !== 'notify') return;
      const actor = `${row.authority.principal.kind}:${row.authority.principal.id}`;
      await tx.executeRaw(`INSERT INTO core_edit_notices (source_id, slug, page_id, revision, base_revision, base_text, actor) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.source_id, row.slug, live?.page.id ?? null, revision, live?.revision ?? null, beforeRendered, actor]);
    },
  };
}
