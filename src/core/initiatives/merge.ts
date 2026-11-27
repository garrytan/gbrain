/**
 * Merge a finished initiative into its targets.
 *
 * "Core" pages (projects, concepts) describe the status quo. While an
 * initiative is active its knowledge lives on the initiative page (facts
 * remembered on it, its requirements body). When it finishes as `done`, the
 * durable part of that knowledge is merged into the pages it changed:
 *
 *   planMerge     one LLM call proposes add / replace / obsolete / skip items
 *                 per target, strictly validated against the real target facts
 *   writeMergePlan stores the plan on the initiative page (`## Merge plan`: a
 *                 readable list + one ```json block a human may edit)
 *   applyMerge    reads the plan back from the page and applies it as `ctx`
 *                 (new project pages first, then facts, then one timeline
 *                 entry per touched target). Deterministic request ids make a
 *                 retry replay instead of writing twice.
 */
import type { BrainEngine } from '../engine.ts';
import type { ChatOpts } from '../ai/gateway.ts';
import { parseLlmJson } from '../llm-json.ts';
import { resolveModel, TIER_DEFAULTS } from '../model-config.ts';
import { loadOperation } from '../operation-load.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { stripFactsFence } from '../facts-fence.ts';
import { INITIATIVE_TYPE, initiativeStatusOf, slugSegment, stringList, today, type InitiativesConfig } from './model.ts';
import { readPage, requestIdFor, resolveUnderPrefix, updatePage, writePage } from './store.ts';

export type ChatFn = (opts: ChatOpts) => Promise<{ text: string; stopReason?: string; model?: string }>;

export interface MergeItem { id: string; action: 'add' | 'replace' | 'obsolete' | 'skip'; target: string; fact?: string; replaces_fact_id?: number; reason: string; new_target?: boolean }
export interface MergePlan { initiative: string; generated_at: string; model: string; new_projects: Array<{ slug: string; title: string; body: string }>; items: MergeItem[] }
export interface MergeApplyResult { applied: number; skipped: number; created_pages: string[]; touched: string[]; errors: string[]; dry_run: boolean }

export const MERGE_MODEL_KEY = 'models.initiatives.merge';
const PLAN_HEADING = '## Merge plan';
const TARGET_BODY_CHARS = 4000;
const REQUIREMENTS_CHARS = 8000;
const MAX_FACTS = 300;
const FACT_MAX = 1000;
const ACTIONS = ['add', 'replace', 'obsolete', 'skip'] as const;

interface TargetContext { slug: string; ref: string; exists: boolean; title: string; body: string; facts: Array<{ id: number; fact: string }> }

async function liveFacts(engine: BrainEngine, sourceId: string, slug: string): Promise<Array<{ id: number; fact: string }>> {
  const rows = await engine.executeRaw<{ id: number | string; fact: string }>(
    `SELECT id, fact FROM facts WHERE source_id = $1 AND entity_slug = $2 AND expired_at IS NULL ORDER BY id LIMIT $3`,
    [sourceId, slug, MAX_FACTS]);
  return rows.map(r => ({ id: Number(r.id), fact: r.fact }));
}

/** Slug for a target that does not exist yet: a prefixed ref is kept, a bare name goes under the new-project prefix. */
export function newProjectSlug(cfg: InitiativesConfig, ref: string): string {
  const clean = ref.trim().replace(/^\[\[(.*?)(\|.*)?\]\]$/, '$1').replace(/\.md$/, '').replace(/^\/+|\/+$/g, '');
  if (clean.includes('/')) return clean.split('/').map(s => slugSegment(s)).join('/');
  return `${cfg.newProjectPrefix}${slugSegment(clean)}`;
}

function titleFromSlug(slug: string): string {
  const tail = slug.split('/').pop() ?? slug;
  return tail.split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || slug;
}

async function targetContexts(engine: BrainEngine, cfg: InitiativesConfig, initiativeSlug: string, refs: string[]): Promise<TargetContext[]> {
  const out: TargetContext[] = [];
  const list = refs.length ? refs : [newProjectSlug(cfg, initiativeSlug.split('/').pop() ?? initiativeSlug)];
  for (const ref of list) {
    const found = await resolveUnderPrefix(engine, cfg.sourceId, cfg.newProjectPrefix, ref);
    const page = found ? await readPage(engine, cfg.sourceId, found) : null;
    if (page) {
      if (out.some(t => t.slug === page.slug)) continue;
      out.push({ slug: page.slug, ref, exists: true, title: page.title || page.slug, body: withoutFactsFence(page.body).slice(0, TARGET_BODY_CHARS),
        facts: await liveFacts(engine, cfg.sourceId, page.slug) });
    } else {
      const slug = newProjectSlug(cfg, ref);
      if (out.some(t => t.slug === slug)) continue;
      out.push({ slug, ref, exists: false, title: titleFromSlug(slug), body: '', facts: [] });
    }
  }
  return out;
}

const SYSTEM = `You merge the outcome of a finished initiative into the pages it changed.
Core pages describe the CURRENT STATE (the status quo) of projects and concepts, not their history.
You get the initiative (requirements and the facts remembered while it ran) and its targets (existing pages with their numbered facts, or NEW projects to create).
Decide, for each durable piece of knowledge, one action:
- "add": a new behaviour, feature or property of a target that the initiative shipped.
- "replace": it supersedes one existing fact of that target; replaces_fact_id MUST be that target's fact id.
- "obsolete": an existing fact of that target is no longer true; replaces_fact_id = that fact id; "fact" is an optional replacement text.
- "skip": process chatter, meetings, intentions or plans not evidenced as shipped, details that only matter to the initiative itself.
Be conservative: only knowledge that describes the resulting status quo. Each fact is one self-contained claim in plain present tense.
For every NEW target also write new_projects[]: {slug, title, body} where body is a short Markdown overview from the requirements and the shipped decisions.
Reply with JSON only: {"items":[{"action","target","fact","replaces_fact_id","reason"}],"new_projects":[{"slug","title","body"}]}.`;

const RESPONSE_SCHEMA = {
  name: 'initiative_merge_plan',
  schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: [...ACTIONS] },
            target: { type: 'string' },
            fact: { type: 'string' },
            replaces_fact_id: { type: 'integer' },
            reason: { type: 'string' },
          },
          required: ['action', 'target', 'reason'],
        },
      },
      new_projects: {
        type: 'array',
        items: { type: 'object', properties: { slug: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['slug', 'title', 'body'] },
      },
    },
    required: ['items', 'new_projects'],
  },
};

function renderPrompt(initiative: { slug: string; title: string; body: string; facts: Array<{ id: number; fact: string }> }, targets: TargetContext[]): string {
  const lines: string[] = [];
  lines.push(`# Initiative ${initiative.slug}: ${initiative.title}`, '', '## Requirements', initiative.body.slice(0, REQUIREMENTS_CHARS) || '(none)', '');
  lines.push('## Facts remembered while it ran');
  for (const f of initiative.facts) lines.push(`- ${f.fact.slice(0, FACT_MAX)}`);
  if (!initiative.facts.length) lines.push('(none)');
  lines.push('', '# Targets');
  for (const t of targets) {
    lines.push('', t.exists ? `## ${t.slug} (existing): ${t.title}` : `## ${t.slug} (NEW project, does not exist yet)`);
    if (t.exists) {
      lines.push(t.body || '(empty body)', '', 'Facts:');
      for (const f of t.facts) lines.push(`- [${f.id}] ${f.fact.slice(0, FACT_MAX)}`);
      if (!t.facts.length) lines.push('(none)');
    }
  }
  return lines.join('\n');
}

interface RawPlan { items?: unknown; new_projects?: unknown }

/** Strict validation of the model's answer: unknown targets / fact ids never apply (the item becomes a `skip` naming why). */
export function validatePlan(raw: RawPlan | null, targets: TargetContext[], meta: { initiative: string; model: string; generatedAt: string },
  requirements: string): MergePlan {
  const items: MergeItem[] = [];
  const byTarget = new Map(targets.map(t => [t.slug, t]));
  const rawItems = Array.isArray(raw?.items) ? raw!.items as Array<Record<string, unknown>> : [];
  for (const r of rawItems) {
    if (!r || typeof r !== 'object') continue;
    const id = `m${items.length + 1}`;
    const action = String(r.action ?? '').trim() as MergeItem['action'];
    const target = String(r.target ?? '').trim().replace(/^\[\[(.*?)(\|.*)?\]\]$/, '$1');
    const fact = typeof r.fact === 'string' && r.fact.trim() ? r.fact.trim().slice(0, FACT_MAX) : undefined;
    const reason = typeof r.reason === 'string' ? r.reason.trim().slice(0, 500) : '';
    const factId = typeof r.replaces_fact_id === 'number' || (typeof r.replaces_fact_id === 'string' && /^\d+$/.test(r.replaces_fact_id))
      ? Number(r.replaces_fact_id) : undefined;
    const drop = (why: string) => items.push({ id, action: 'skip', target, ...(fact ? { fact } : {}), reason: `dropped: ${why}${reason ? ` (${reason})` : ''}` });
    if (!(ACTIONS as readonly string[]).includes(action)) { drop(`unknown action "${action}"`); continue; }
    const t = byTarget.get(target);
    if (action === 'skip') { items.push({ id, action, target, ...(fact ? { fact } : {}), reason }); continue; }
    if (!t) { drop(`unknown target "${target}"`); continue; }
    const newTarget = t.exists ? {} : { new_target: true };
    if (action === 'add') {
      if (!fact) { drop('add without fact'); continue; }
      items.push({ id, action, target, fact, reason, ...newTarget });
      continue;
    }
    if (factId == null || !t.facts.some(f => f.id === factId)) { drop(`unknown fact id ${factId ?? '(none)'} for ${target}`); continue; }
    if (action === 'replace' && !fact) { drop('replace without fact'); continue; }
    items.push({ id, action, target, ...(fact ? { fact } : {}), replaces_fact_id: factId, reason, ...newTarget });
  }
  const rawProjects = Array.isArray(raw?.new_projects) ? raw!.new_projects as Array<Record<string, unknown>> : [];
  const newProjects = targets.filter(t => !t.exists).map(t => {
    const p = rawProjects.find(x => x && String(x.slug ?? '').trim() === t.slug);
    const title = typeof p?.title === 'string' && p.title.trim() ? p.title.trim().slice(0, 200) : t.title;
    const body = typeof p?.body === 'string' && withoutFactsFence(p.body) ? withoutFactsFence(p.body) : `## Overview\n\n${requirements.slice(0, 2000).trim() || title}`;
    return { slug: t.slug, title, body };
  });
  return { initiative: meta.initiative, generated_at: meta.generatedAt, model: meta.model, new_projects: newProjects, items };
}

export async function planMerge(engine: BrainEngine, cfg: InitiativesConfig, initiativeSlug: string, deps: { chat?: ChatFn } = {}): Promise<MergePlan> {
  const page = await readPage(engine, cfg.sourceId, initiativeSlug);
  if (!page || page.type !== INITIATIVE_TYPE) throw new OperationError('initiative_not_found', `No initiative ${initiativeSlug} in source ${cfg.sourceId}.`, 'List initiatives with initiatives_list and pass one of their slugs.');
  const facts = await liveFacts(engine, cfg.sourceId, page.slug);
  const targets = await targetContexts(engine, cfg, page.slug, stringList(page.frontmatter.targets));
  const requirements = withoutFactsFence(stripPlanSection(page.body));
  const model = await resolveModel(engine, { configKey: MERGE_MODEL_KEY, tier: 'reasoning', fallback: TIER_DEFAULTS.reasoning });
  const chat: ChatFn = deps.chat ?? (async (opts) => (await import('../ai/gateway.ts')).chat(opts));
  const result = await chat({
    model, system: SYSTEM, messages: [{ role: 'user', content: renderPrompt({ slug: page.slug, title: page.title, body: requirements, facts }, targets) }],
    maxTokens: 8000, temperature: 0, responseSchema: RESPONSE_SCHEMA, purpose: 'initiatives.merge',
  });
  const refused = result.stopReason === 'refusal' || result.stopReason === 'content_filter';
  const raw = refused ? null : parseLlmJson<RawPlan>(result.text);
  if (!raw) throw new OperationError('unavailable', `The model returned no readable merge plan for ${page.slug}.`, 'Retry, or set models.initiatives.merge to another model.');
  return validatePlan(raw, targets, { initiative: page.slug, model: result.model || model, generatedAt: new Date().toISOString() }, requirements);
}

/** The body without its `## Merge plan` section. */
/**
 * The page body without its facts fence (and the `## Facts` heading it leaves empty). Facts reach a target only
 * through the plan's items: a fence copied into a new page's body would be imported as a second copy of every
 * initiative fact when the page is written.
 */
export function withoutFactsFence(body: string): string {
  return stripFactsFence(body).replace(/^#{1,6}\s+Facts\s*\n(?:\s*\n)*(?=#{1,6}\s|$(?![\s\S]))/gim, '').replace(/\n{3,}/g, '\n\n').trim();
}

function stripPlanSection(body: string): string {
  const at = body.indexOf(`\n${PLAN_HEADING}`) >= 0 ? body.indexOf(`\n${PLAN_HEADING}`) + 1 : body.startsWith(PLAN_HEADING) ? 0 : -1;
  if (at < 0) return body;
  const rest = body.slice(at + PLAN_HEADING.length);
  const next = rest.search(/\n## /);
  return (body.slice(0, at) + (next >= 0 ? rest.slice(next + 1) : '')).trim();
}

function planSection(plan: MergePlan): string {
  const lines = [PLAN_HEADING, '',
    `_Proposed ${plan.generated_at.slice(0, 10)} by ${plan.model}. The JSON block is what merge applies: edit or delete its items first; \`skip\` items are never applied._`, ''];
  if (plan.new_projects.length) {
    lines.push('New pages:');
    for (const p of plan.new_projects) lines.push(`- [[${p.slug}]] — ${p.title}`);
    lines.push('');
  }
  for (const i of plan.items) {
    const what = i.action === 'skip' ? (i.fact ?? '') : i.action === 'obsolete' ? `fact ${i.replaces_fact_id}${i.fact ? ` → ${i.fact}` : ''}`
      : i.action === 'replace' ? `fact ${i.replaces_fact_id} → ${i.fact}` : i.fact ?? '';
    lines.push(`- ${i.id} **${i.action}** [[${i.target}]]: ${what}${i.reason ? ` _(${i.reason})_` : ''}`);
  }
  if (!plan.items.length) lines.push('- (nothing to merge)');
  lines.push('', '```json', JSON.stringify(plan, null, 2), '```');
  return lines.join('\n');
}

export async function writeMergePlan(ctx: OperationContext, cfg: InitiativesConfig, initiativeSlug: string, plan: MergePlan): Promise<void> {
  const updated = await updatePage({ ...ctx, sourceId: cfg.sourceId }, cfg.sourceId, initiativeSlug, page => ({
    body: `${stripPlanSection(page.body)}\n\n${planSection(plan)}\n`,
    frontmatter: { ...page.frontmatter, merge_status: 'proposed' },
  }));
  if (!updated) throw new OperationError('initiative_not_found', `No initiative ${initiativeSlug} in source ${cfg.sourceId}.`, 'List initiatives with initiatives_list and pass one of their slugs.');
}

export function readMergePlan(body: string): MergePlan | null {
  const at = body.indexOf(PLAN_HEADING);
  if (at < 0) return null;
  const rest = body.slice(at + PLAN_HEADING.length);
  const next = rest.search(/\n## /);
  const section = next >= 0 ? rest.slice(0, next) : rest;
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(section);
  if (!m) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(m[1]); } catch { return null; }
  const p = parsed as Partial<MergePlan> | null;
  if (!p || typeof p !== 'object' || !Array.isArray(p.items)) return null;
  const items = p.items.filter((i): i is MergeItem => !!i && typeof i === 'object' && typeof i.id === 'string'
    && (ACTIONS as readonly string[]).includes(i.action) && typeof i.target === 'string');
  const newProjects = (Array.isArray(p.new_projects) ? p.new_projects : [])
    .filter(n => n && typeof n.slug === 'string' && n.slug.trim())
    .map(n => ({ slug: n.slug.trim(), title: typeof n.title === 'string' && n.title.trim() ? n.title.trim() : titleFromSlug(n.slug), body: typeof n.body === 'string' ? withoutFactsFence(n.body) : '' }));
  return {
    initiative: String(p.initiative ?? ''), generated_at: String(p.generated_at ?? ''), model: String(p.model ?? ''),
    new_projects: newProjects, items: items.map(i => ({ ...i, reason: typeof i.reason === 'string' ? i.reason : '' })),
  };
}

export async function applyMerge(ctx: OperationContext, cfg: InitiativesConfig, initiativeSlug: string,
  opts: { skip?: string[]; dryRun?: boolean } = {}): Promise<MergeApplyResult> {
  const engine = ctx.engine;
  const page = await readPage(engine, cfg.sourceId, initiativeSlug);
  if (!page || page.type !== INITIATIVE_TYPE) throw new OperationError('initiative_not_found', `No initiative ${initiativeSlug} in source ${cfg.sourceId}.`, 'List initiatives with initiatives_list and pass one of their slugs.');
  if (initiativeStatusOf(page.frontmatter) !== 'done') {
    throw new OperationError('initiative_not_done', `Initiative ${page.slug} is ${initiativeStatusOf(page.frontmatter)}; only a done initiative merges.`,
      'Finish it with outcome done first.');
  }
  const plan = readMergePlan(page.body);
  if (!plan) throw new OperationError('merge_plan_missing', `Initiative ${page.slug} has no merge plan.`, 'Finish the initiative as done (finish_initiative) so its job writes the merge plan, then apply it.');
  const skip = new Set(opts.skip ?? []);
  const todo = plan.items.filter(i => i.action !== 'skip' && !skip.has(i.id));
  const result: MergeApplyResult = { applied: 0, skipped: plan.items.length - todo.length, created_pages: [], touched: [], errors: [], dry_run: !!opts.dryRun };
  const date = today();
  const tracker = typeof page.frontmatter.tracker === 'string' && page.frontmatter.tracker.trim() ? page.frontmatter.tracker.trim() : '';
  const provenance = `initiative ${page.slug}${tracker ? ` (${tracker})` : ''} finished ${String(page.frontmatter.finished_at ?? date)}`;
  const wctx: OperationContext = { ...ctx, sourceId: cfg.sourceId, dryRun: false };
  const rid = (...parts: string[]) => requestIdFor('initiative-merge', cfg.sourceId, page.slug, ...parts);

  // New pages first: facts and timeline entries need their page.
  for (const p of plan.new_projects) {
    if (await readPage(engine, cfg.sourceId, p.slug)) continue;
    result.created_pages.push(p.slug);
    if (opts.dryRun) continue;
    try {
      await writePage(wctx, {
        sourceId: cfg.sourceId, slug: p.slug, type: 'project', title: p.title, body: withoutFactsFence(p.body),
        frontmatter: { created_by: [page.slug], created: date }, requestKey: ['merge', page.slug, 'create', p.slug],
      });
    } catch (err) {
      result.errors.push(`create ${p.slug}: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  const remember = opts.dryRun ? null : await loadOperation('remember');
  const forget = opts.dryRun ? null : await loadOperation('forget_fact');
  if (!opts.dryRun && (!remember || !forget)) throw new Error('remember / forget_fact operation unavailable');
  const appliedByTarget = new Map<string, MergeItem[]>();
  for (const item of todo) {
    if (!opts.dryRun) {
      try {
        const base = { entity: item.target, provenance, kind: 'fact', source_id: cfg.sourceId, infer_entity: false };
        if (item.action === 'add') {
          if (!item.fact) throw new Error('add without fact');
          await remember!.handler(wctx, { ...base, fact: item.fact, request_id: rid(item.id, 'add') });
        } else if (item.action === 'replace') {
          if (!item.fact || item.replaces_fact_id == null) throw new Error('replace needs fact and replaces_fact_id');
          await remember!.handler(wctx, { ...base, fact: item.fact, replaces: String(item.replaces_fact_id), request_id: rid(item.id, 'replace') });
        } else {
          if (item.replaces_fact_id == null) throw new Error('obsolete needs replaces_fact_id');
          await forget!.handler(wctx, { id: item.replaces_fact_id, reason: `obsolete after ${provenance}${item.reason ? `: ${item.reason}` : ''}`.slice(0, 500),
            request_id: rid(item.id, 'forget') });
          if (item.fact) await remember!.handler(wctx, { ...base, fact: item.fact, request_id: rid(item.id, 'obsolete-add') });
        }
      } catch (err) {
        result.errors.push(`${item.id} ${item.action} ${item.target}: ${(err as Error)?.message ?? String(err)}`);
        continue;
      }
    }
    result.applied++;
    const list = appliedByTarget.get(item.target) ?? [];
    list.push(item);
    appliedByTarget.set(item.target, list);
  }
  result.touched = [...appliedByTarget.keys()];
  if (opts.dryRun) return result;

  for (const [target, items] of appliedByTarget) {
    const detail = [...items.map(i => `- ${i.action}: ${i.action === 'obsolete' ? `fact ${i.replaces_fact_id} withdrawn${i.fact ? ` → ${i.fact}` : ''}` : i.fact}`),
      `From [[${page.slug}]]`].join('\n');
    try {
      await submitPageMutation(wctx, {
        operation: 'add_timeline_entry',
        params: { slug: target, date, summary: `Changed by initiative ${page.title || page.slug}`, detail, source_id: cfg.sourceId,
          request_id: rid('timeline', target) },
      });
    } catch (err) {
      result.errors.push(`timeline ${target}: ${(err as Error)?.message ?? String(err)}`);
    }
  }
  await updatePage(wctx, cfg.sourceId, page.slug, p => ({
    frontmatter: { ...p.frontmatter, merge_status: result.errors.length ? 'partial' : 'applied', merged_at: date },
  }));
  return result;
}
