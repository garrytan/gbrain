/**
 * `gbrain core`: manage always-loaded core memory (docs/guides/core-memory.md).
 *
 *   gbrain core list    [--source <id>] [--json]   core pages, priority order, rendered size
 *   gbrain core show    [--source <id>] [--json]   the exact block a session receives
 *   gbrain core status  [--json]                   usage against the budget, notices, settings
 *   gbrain core add     <slug> [--source <id>] [--priority <n>]
 *   gbrain core remove  <slug> [--source <id>]
 *   gbrain core diff    <slug> [--source <id>]     what remote edits changed since the last ack
 *   gbrain core ack     <slug> [--source <id>] --revision <token>
 *   gbrain core init    [--source <id>] [--slug <slug>]   starter profile page, marked core
 *   gbrain core suggest [--source <id>] [--apply] [--json]
 *
 * Marking writes go through put_page as the trusted local owner, so the
 * write-path guard (budget, page cap) applies to them like any other write.
 */
import type { BrainEngine } from '../core/engine.ts';
import { handleToolCall } from '../mcp/server.ts';
import {
  CORE_DEFAULT_PRIORITY, CORE_DOCS, coreNoticeLine, coreUsage, isCoreFrontmatter, loadCoreBlock,
  pendingCoreNotices, readCoreSettings, renderCorePage,
} from '../core/core-memory.ts';
import { serializePageToMarkdown } from '../core/markdown.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

/** Core is opt-in: marking a page does nothing for sessions until the owner turns delivery on. */
const CORE_OFF_HINT = 'Core memory is off (the default), so sessions do not load it yet. If the user wants it always loaded: gbrain config set memory.core.enabled true';

const USAGE = `Usage: gbrain core <list|show|status|add|remove|diff|ack|init|suggest> [options]
  list    [--source <id>] [--json]
  show    [--source <id>] [--json]
  status  [--json]
  add     <slug> [--source <id>] [--priority <n>]
  remove  <slug> [--source <id>]
  diff    <slug> [--source <id>]
  ack     <slug> [--source <id>] --revision <token>
  init    [--source <id>] [--slug <slug>]
  suggest [--source <id>] [--apply] [--json]
Docs: ${CORE_DOCS}`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

function positional(args: string[]): string | undefined {
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) { if (!['--json', '--apply'].includes(a)) i++; continue; }
    return a;
  }
  return undefined;
}

function fail(message: string, next?: string): void {
  console.error(`[core] ${message}`);
  if (next) console.error(`[core] Next: ${next}`);
  setCliExitVerdict(1);
}

/** Rewrites a page's core marking through put_page as the local owner. */
async function setMarking(engine: BrainEngine, sourceId: string, slug: string, marking: { core: boolean; priority?: number }): Promise<'changed' | 'unchanged' | 'missing'> {
  const snap = await engine.readPageSnapshot(slug, { sourceId });
  if (!snap || snap.page.deleted_at) return 'missing';
  const fm = { ...((snap.page.frontmatter ?? {}) as Record<string, unknown>) };
  const was = isCoreFrontmatter(fm);
  const wasPriority = fm.core_priority;
  delete fm.always_load;
  delete fm.core_priority;
  if (marking.core) {
    fm.always_load = true;
    const priority = marking.priority ?? (typeof wasPriority === 'number' ? wasPriority : undefined);
    if (priority !== undefined && priority !== CORE_DEFAULT_PRIORITY) fm.core_priority = priority;
  }
  if (was === marking.core && (!marking.core || fm.core_priority === wasPriority)) return 'unchanged';
  const tags = await engine.getTags(slug, { sourceId });
  const content = serializePageToMarkdown({ ...snap.page, frontmatter: fm }, tags);
  const receipt = await handleToolCall(engine, 'put_page', { slug, content, source_id: sourceId, expected_revision: snap.revision }, { sourceId }) as { state?: string; write_request?: { state?: string } };
  const state = receipt?.state ?? receipt?.write_request?.state;
  if (state && state !== 'committed') throw new Error(`the write is ${state}; check it with gbrain sources writer status --json`);
  return 'changed';
}

const STARTER_SLUG = 'core/about-the-user';
const STARTER_BODY = `- Who the user is and what they do: (fill in)
- How they like answers: (fill in, e.g. short, direct, with commands to run)
- Current focus: (fill in the projects that matter this month)
- Standing preferences: (fill in tools, conventions, things to avoid)`;

/** Zero-LLM candidates: small pages whose title or slug reads like a profile, preference or convention page, plus the most linked-to small pages. */
async function suggestCandidates(engine: BrainEngine, sourceId: string, room: number): Promise<Array<{ slug: string; title: string; chars: number; why: string }>> {
  const rows = await engine.executeRaw<{ slug: string; title: string | null; compiled_truth: string | null; frontmatter: unknown; inbound: number }>(
    `SELECT p.slug, p.title, p.compiled_truth, p.frontmatter,
            (SELECT count(*)::int FROM links l WHERE l.to_page_id = p.id) AS inbound
       FROM pages p
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND length(coalesce(p.compiled_truth, '')) BETWEEN 40 AND 1500
      ORDER BY inbound DESC, p.updated_at DESC LIMIT 400`, [sourceId]);
  const named = /(about[-_ ]?me|profile|preference|working[-_ ]?style|conventions?|how[-_ ]?i[-_ ]?work|user[-_ ]?context|standing[-_ ]?instructions)/i;
  const out: Array<{ slug: string; title: string; chars: number; why: string }> = [];
  for (const r of rows) {
    const fm = typeof r.frontmatter === 'string' ? JSON.parse(r.frontmatter) : r.frontmatter;
    if (isCoreFrontmatter(fm) || (fm as { visibility?: string } | null)?.visibility === 'private') continue;
    const title = r.title ?? r.slug;
    const chars = renderCorePage({ source_id: sourceId, slug: r.slug, title, compiled_truth: r.compiled_truth ?? '' }).length;
    const why = named.test(`${r.slug} ${title}`) ? 'profile/preference page' : r.inbound >= 5 ? `${r.inbound} pages link to it` : '';
    if (why && chars <= room) out.push({ slug: r.slug, title, chars, why });
  }
  return out.sort((a, b) => Number(b.why.startsWith('profile')) - Number(a.why.startsWith('profile'))).slice(0, 10);
}

/** Minimal line diff (longest common subsequence) for small core pages. */
function lineDiff(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push(`  ${a[i]}`); i++; j++; } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push(`- ${a[i++]}`); else out.push(`+ ${b[j++]}`);
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out.join('\n');
}

export async function runCore(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  const json = args.includes('--json');
  const sourceId = flag(args, '--source') ?? 'default';
  const slug = positional(args);
  const print = (value: unknown, text: () => string) => console.log(json ? JSON.stringify(value, null, 2) : text());

  switch (sub) {
    case 'list': {
      const pages = (await coreUsage(engine)).pages.filter(p => !flag(args, '--source') || p.source_id === sourceId);
      print({ pages: pages.map(p => ({ source_id: p.source_id, slug: p.slug, title: p.title, priority: p.priority, chars: p.chars })) },
        () => pages.length ? pages.map(p => `${String(p.priority).padStart(4)}  ${p.source_id}:${p.slug}  ${p.chars} chars  ${p.title}`).join('\n')
          : 'No core pages. Mark one with: gbrain core add <slug>  (or start with: gbrain core init)');
      return;
    }
    case 'show': {
      const block = await loadCoreBlock(engine, { sessionSourceId: sourceId, excludePrivate: true });
      print(block, () => block.text || (block.enabled ? '(core memory is empty)' : '(core memory is disabled: memory.core.enabled=false)'));
      return;
    }
    case 'status': {
      const settings = await readCoreSettings(engine);
      const usage = await coreUsage(engine);
      const notices = await pendingCoreNotices(engine);
      const block = await loadCoreBlock(engine, { sessionSourceId: sourceId, excludePrivate: true });
      const status = {
        enabled: settings.enabled, chars_used: usage.chars, chars_limit: settings.maxChars, over_budget: usage.chars > settings.maxChars,
        pages: usage.pages.length, remote_edit: settings.remoteEdit, revision: block.revision,
        largest: [...usage.pages].sort((a, b) => b.chars - a.chars).slice(0, 5).map(p => ({ source_id: p.source_id, slug: p.slug, chars: p.chars })),
        withheld: block.omitted.filter(o => o.reason === 'withheld'),
        pending_notices: notices.map(n => ({ ...n, next: coreNoticeLine(n) })),
        delivery: {
          'claude-code': 'session-start hook (core printed first)', openclaw: 'context engine, every turn',
          mcp: 'context_pack core field', 'static files': 'gbrain compile-context --include-core',
        },
        docs: CORE_DOCS,
      };
      print(status, () => [
        `Core memory: ${settings.enabled ? 'enabled' : 'disabled'} — ${usage.chars.toLocaleString('en-US')}/${settings.maxChars.toLocaleString('en-US')} chars, ${usage.pages.length} page(s), remote edits: ${settings.remoteEdit}`,
        ...(status.over_budget ? [`OVER BUDGET by ${usage.chars - settings.maxChars} chars: shorten a page (move detail into a linked page) or gbrain config set memory.core.max_chars <n>`] : []),
        ...status.largest.map(p => `  ${p.source_id}:${p.slug}  ${p.chars} chars`),
        ...status.withheld.map(w => `  withheld from delivery: ${w.source_id}:${w.slug} (sensitive content)`),
        ...notices.map(n => `  notice: ${coreNoticeLine(n)}`),
      ].join('\n'));
      return;
    }
    case 'add':
    case 'remove': {
      if (!slug) { fail(`${sub} needs a page slug.`, `gbrain core ${sub} <slug> [--source <id>]`); return; }
      const rawPriority = flag(args, '--priority');
      const priority = rawPriority === undefined ? undefined : Number(rawPriority);
      if (priority !== undefined && !Number.isInteger(priority)) { fail('--priority must be an integer (lower renders first; default 100).'); return; }
      try {
        const result = await setMarking(engine, sourceId, slug, { core: sub === 'add', ...(priority !== undefined ? { priority } : {}) });
        if (result === 'missing') { fail(`No live page ${sourceId}:${slug}.`, 'check the slug with gbrain get <slug> or create the page first'); return; }
        if (sub === 'remove') await engine.executeRaw('UPDATE core_edit_notices SET acked_at = now() WHERE source_id = $1 AND slug = $2 AND acked_at IS NULL', [sourceId, slug]);
        const usage = await coreUsage(engine);
        const settings = await readCoreSettings(engine);
        console.log(`${result === 'unchanged' ? 'Already' : 'Now'} ${sub === 'add' ? 'in' : 'out of'} core: ${sourceId}:${slug}. Core uses ${usage.chars}/${settings.maxChars} chars.`);
        if (sub === 'add' && !settings.enabled) console.log(CORE_OFF_HINT);
      } catch (e) {
        fail((e as Error).message, sub === 'add' ? 'run gbrain core status to see where the budget goes' : undefined);
      }
      return;
    }
    case 'diff': {
      if (!slug) { fail('diff needs a page slug.', 'gbrain core diff <slug> [--source <id>]'); return; }
      const [oldest] = await engine.executeRaw<{ base_text: string | null; actor: string; created_at: string }>(
        `SELECT base_text, actor, created_at::text AS created_at FROM core_edit_notices WHERE source_id = $1 AND slug = $2 AND acked_at IS NULL ORDER BY id LIMIT 1`, [sourceId, slug]);
      const snap = await engine.readPageSnapshot(slug, { sourceId });
      const current = snap ? renderCorePage({ source_id: sourceId, slug, title: snap.page.title, compiled_truth: snap.page.compiled_truth }) : '';
      if (!oldest) { print({ pending: false }, () => `No unacknowledged remote edits to ${sourceId}:${slug}.`); return; }
      print({ pending: true, since: oldest.created_at, actor: oldest.actor, before: oldest.base_text, after: current, revision: snap?.revision ?? null },
        () => `Remote edits to ${sourceId}:${slug} since ${oldest.created_at} (first by ${oldest.actor}):\n${lineDiff(oldest.base_text ?? '', current)}\n\nIf this is fine: gbrain core ack --source ${sourceId} ${slug} --revision ${snap?.revision ?? 'latest'}`);
      return;
    }
    case 'ack': {
      const revision = flag(args, '--revision');
      if (!slug || !revision) { fail('ack needs a slug and --revision (from gbrain core diff or the notice).', 'gbrain core ack <slug> --revision <token>'); return; }
      const snap = await engine.readPageSnapshot(slug, { sourceId });
      if (revision !== 'latest' && snap && snap.revision !== revision) {
        const [known] = await engine.executeRaw<{ id: number }>('SELECT id FROM core_edit_notices WHERE source_id = $1 AND slug = $2 AND revision = $3 ORDER BY id DESC LIMIT 1', [sourceId, slug, revision]);
        if (!known) { fail(`Revision ${revision} is not a reviewed edit of ${sourceId}:${slug}.`, `gbrain core diff --source ${sourceId} ${slug}`); return; }
        const rows = await engine.executeRaw<{ n: number }>('WITH a AS (UPDATE core_edit_notices SET acked_at = now() WHERE source_id = $1 AND slug = $2 AND acked_at IS NULL AND id <= $3 RETURNING 1) SELECT count(*)::int AS n FROM a', [sourceId, slug, known.id]);
        console.log(`Acknowledged ${rows[0]?.n ?? 0} edit(s) up to ${revision}; later edits stay pending.`);
        return;
      }
      const rows = await engine.executeRaw<{ n: number }>('WITH a AS (UPDATE core_edit_notices SET acked_at = now() WHERE source_id = $1 AND slug = $2 AND acked_at IS NULL RETURNING 1) SELECT count(*)::int AS n FROM a', [sourceId, slug]);
      console.log(`Acknowledged ${rows[0]?.n ?? 0} edit(s) to ${sourceId}:${slug}.`);
      return;
    }
    case 'init': {
      const target = flag(args, '--slug') ?? STARTER_SLUG;
      const existing = await engine.readPageSnapshot(target, { sourceId });
      if (existing && !existing.page.deleted_at) {
        const result = await setMarking(engine, sourceId, target, { core: true, priority: 10 }).catch((e: Error) => { fail(e.message); return null; });
        if (result) console.log(`${sourceId}:${target} exists and is ${result === 'unchanged' ? 'already' : 'now'} in core.`);
        if (result && !(await readCoreSettings(engine)).enabled) console.log(CORE_OFF_HINT);
        return;
      }
      const content = `---\ntitle: About the user\nalways_load: true\ncore_priority: 10\n---\n\n${STARTER_BODY}\n`;
      try {
        await handleToolCall(engine, 'put_page', { slug: target, content, source_id: sourceId }, { sourceId });
      } catch (e) { fail((e as Error).message); return; }
      console.log(`Created ${sourceId}:${target} in core. Next: ask the user the four questions on that page and replace each "(fill in)" with edit_page, keeping it short.`);
      if (!(await readCoreSettings(engine)).enabled) console.log(CORE_OFF_HINT);
      return;
    }
    case 'suggest': {
      const settings = await readCoreSettings(engine);
      const usage = await coreUsage(engine);
      const room = settings.maxChars - usage.chars;
      const candidates = await suggestCandidates(engine, sourceId, room);
      if (!args.includes('--apply')) {
        print({ room, candidates }, () => candidates.length
          ? `Candidates that fit the ${room} chars left (read-only; ask the user before applying):\n${candidates.map(c => `  ${sourceId}:${c.slug}  ${c.chars} chars  ${c.why}`).join('\n')}\nApply one: gbrain core add <slug>  (or all that fit: gbrain core suggest --apply)`
          : `No candidates fit the ${room} chars left. Start with: gbrain core init`);
        return;
      }
      let left = room;
      const applied: string[] = [];
      for (const c of candidates) {
        if (c.chars + 2 > left) continue;
        try { if (await setMarking(engine, sourceId, c.slug, { core: true }) === 'changed') { applied.push(c.slug); left -= c.chars + 2; } } catch { /* budget moved: skip */ }
      }
      print({ applied }, () => applied.length ? `Added to core: ${applied.map(s => `${sourceId}:${s}`).join(', ')}` : 'Nothing applied.');
      return;
    }
    default:
      console.log(USAGE);
      if (sub && sub !== '--help' && sub !== 'help') setCliExitVerdict(1);
  }
}

