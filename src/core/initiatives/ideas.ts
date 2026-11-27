/**
 * Ideas: submission, duplicate detection and similarity.
 *
 * `findSimilar` embeds a text and searches the idea's source for similar
 * ideas, initiatives and core pages (any other type). `submitIdea` turns a
 * proposal into an idea page (`<ideas_prefix><slug>`), or recognizes it as a
 * duplicate of an existing idea (cosine >= duplicate_threshold). Similar ideas
 * link both ways through frontmatter `similar[]`.
 *
 * Without an embedding provider there is no similarity: every submission is
 * created and `similar` stays empty. All writes go through writePage /
 * updatePage (put_page via the mutation coordinator).
 */
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import type { PageType } from '../types.ts';
import {
  IDEA_RESOLUTIONS, IDEA_TYPE, INITIATIVE_TYPE, ideaResolutionOf, ideaStatusOf, initiativeStatusOf, slugSegment, stringList, today,
  type IdeaResolution, type IdeaResolutionStatus, type InitiativesConfig,
} from './model.ts';
import { OperationError } from '../ops/contract.ts';
import { listIdeas, readPage, updatePage, writePage } from './store.ts';

export interface SimilarHit { slug: string; title: string; type: string; score: number; status?: string; resolution?: IdeaResolution }
/** `core` = any other type (project, concept, ...) in cfg.sourceId. */
export interface SimilarGroups { ideas: SimilarHit[]; initiatives: SimilarHit[]; core: SimilarHit[] }

export interface SimilarSearchHit { slug: string; title: string; type: string; score: number }

/** Injectable AI seams (tests; callers that already hold a vector or a model). */
export interface IdeasDeps {
  /** Query vector for a text, or null when no embedding provider is configured. */
  embed?: (text: string) => Promise<Float32Array | null>;
  /** Vector search scoped to one source; defaults to engine.searchVector. */
  search?: (vec: Float32Array, opts: { types?: string[]; limit: number; sourceId: string }) => Promise<SimilarSearchHit[]>;
  /** One JSON chat call; returns the reply text, or null when no chat provider is configured. */
  chat?: (req: { system: string; user: string; maxTokens: number; schema: { name: string; schema: Record<string, unknown> } }) => Promise<string | null>;
  now?: () => Date;
}

export function emptyGroups(): SimilarGroups {
  return { ideas: [], initiatives: [], core: [] };
}

async function defaultEmbed(text: string): Promise<Float32Array | null> {
  const gateway = await import('../ai/gateway.ts');
  if (!gateway.isAvailable('embedding')) return null;
  try { return await gateway.embedQuery(text.slice(0, 8000)); } catch { return null; }
}

/** Whether similarity can run at all (an embedding provider, or an injected embed that answers). */
export async function embeddingAvailable(deps: IdeasDeps = {}): Promise<boolean> {
  if (deps.embed) return (await deps.embed('probe')) !== null;
  const gateway = await import('../ai/gateway.ts');
  return gateway.isAvailable('embedding');
}

function defaultSearch(engine: BrainEngine) {
  return async (vec: Float32Array, opts: { types?: string[]; limit: number; sourceId: string }): Promise<SimilarSearchHit[]> => {
    const rows = await engine.searchVector(vec, {
      limit: opts.limit, sourceId: opts.sourceId, ...(opts.types ? { types: opts.types as PageType[] } : {}),
    });
    return rows.map(r => ({ slug: r.slug, title: r.title ?? r.slug, type: String(r.type ?? ''), score: Number(r.score) || 0 }));
  };
}

function dedupe(hits: SimilarSearchHit[]): SimilarSearchHit[] {
  const best: Record<string, SimilarSearchHit> = {};
  for (const h of hits) {
    const prev = best[h.slug];
    if (!prev || h.score > prev.score) best[h.slug] = h;
  }
  return Object.values(best).sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
}

async function statusesOf(engine: BrainEngine, sourceId: string, slugs: string[]): Promise<Record<string, Record<string, unknown>>> {
  const out: Record<string, Record<string, unknown>> = {};
  if (slugs.length === 0) return out;
  const rows = await engine.executeRaw<{ slug: string; frontmatter: Record<string, unknown> | null }>(
    `SELECT slug, frontmatter FROM pages WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL`, [sourceId, slugs]);
  for (const r of rows) out[r.slug] = r.frontmatter ?? {};
  return out;
}

/**
 * Similar ideas, initiatives and core pages for a text, best first. Hits below
 * `minScore` (default 0.9 x similar_threshold) are dropped; `limit` caps each group (default 5).
 */
export async function findSimilar(engine: BrainEngine, cfg: InitiativesConfig, text: string,
  opts: { excludeSlug?: string; limit?: number; minScore?: number } = {}, deps: IdeasDeps = {}): Promise<SimilarGroups> {
  const groups = emptyGroups();
  const query = text.trim();
  if (!query) return groups;
  const vec = await (deps.embed ?? defaultEmbed)(query);
  if (!vec) return groups;
  const search = deps.search ?? defaultSearch(engine);
  const limit = Math.max(1, opts.limit ?? 5);
  const minScore = opts.minScore ?? cfg.similarThreshold * 0.9;
  const pool = limit * 4;
  const [ideas, initiatives, any] = await Promise.all([
    search(vec, { types: [IDEA_TYPE], limit: pool, sourceId: cfg.sourceId }),
    search(vec, { types: [INITIATIVE_TYPE], limit: pool, sourceId: cfg.sourceId }),
    search(vec, { limit: pool, sourceId: cfg.sourceId }),
  ]);
  const keep = (h: SimilarSearchHit) => h.slug !== opts.excludeSlug && h.score >= minScore;
  const ideaHits = dedupe(ideas.filter(h => h.type === IDEA_TYPE && keep(h))).slice(0, limit);
  const initiativeHits = dedupe(initiatives.filter(h => h.type === INITIATIVE_TYPE && keep(h))).slice(0, limit);
  const coreHits = dedupe(any.filter(h => h.type !== IDEA_TYPE && h.type !== INITIATIVE_TYPE && keep(h))).slice(0, limit);
  const fm = await statusesOf(engine, cfg.sourceId, [...ideaHits, ...initiativeHits].map(h => h.slug));
  groups.ideas = ideaHits.map(h => {
    const resolution = ideaResolutionOf(fm[h.slug]);
    return { ...h, status: ideaStatusOf(fm[h.slug]), ...(resolution ? { resolution } : {}) };
  });
  groups.initiatives = initiativeHits.map(h => ({ ...h, status: initiativeStatusOf(fm[h.slug]) }));
  groups.core = coreHits.map(h => ({ ...h }));
  return groups;
}

export interface SubmitIdeaInput {
  title?: string;
  text: string;
  problem?: string;
  proposal?: string;
  author?: string;
  related?: string[];
  slack?: { channel: string; channelName?: string; ts: string; permalink?: string };
  dryRun?: boolean;
  allowDuplicate?: boolean;
}

export interface SubmitIdeaResult {
  status: 'created' | 'duplicate' | 'dry_run';
  slug?: string;
  duplicateOf?: SimilarHit;
  /** A duplicate's submission was recorded as support (a vote) on the existing idea. */
  support_added?: boolean;
  similar: SimilarGroups;
}

/** First non-empty line of a text, max 80 chars. */
export function titleFromText(text: string): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? '';
  const clean = line.replace(/^[#>*\-\s]+/, '').trim();
  return clean.length > 80 ? `${clean.slice(0, 77).trimEnd()}...` : clean || 'Untitled idea';
}

function quote(text: string): string {
  return text.trim().split('\n').map(l => (l.trim() ? `> ${l}` : '>')).join('\n');
}

export function ideaBody(input: { problem?: string; proposal?: string; text: string }): string {
  const parts: string[] = [];
  if (input.problem?.trim()) parts.push(`## Problem\n\n${input.problem.trim()}`);
  if (input.proposal?.trim()) parts.push(`## Proposal\n\n${input.proposal.trim()}`);
  parts.push(`## Original\n\n${quote(input.text)}`);
  return `${parts.join('\n\n')}\n`;
}

/** The body without the sections that change with conversation and triage (Discussion, Support, Resolution). */
export function ideaSubstance(title: string, body: string): string {
  return `${title}\n${body.replace(/\n?## (Discussion|Support|Resolution)\n[\s\S]*?(?=\n## |$)/g, '')}`.trim();
}

export function substanceHash(title: string, body: string): string {
  return createHash('sha256').update(ideaSubstance(title, body)).digest('hex').slice(0, 16);
}

/** Replace (or append) a `## <name>` section; an empty content removes it. */
export function setSection(body: string, name: string, content: string): string {
  const re = new RegExp(`(^|\\n)## ${name}\\n[\\s\\S]*?(?=\\n## |$)`);
  const block = content.trim() ? `## ${name}\n\n${content.trim()}\n` : '';
  if (re.test(body)) {
    return body.replace(re, (_m, lead: string) => (block ? `${lead}${block}` : lead)).replace(/\n{3,}/g, '\n\n');
  }
  if (!block) return body;
  return `${body.replace(/\s+$/, '')}\n\n${block}`;
}

export function sectionOf(body: string, name: string): string {
  const m = body.match(new RegExp(`(?:^|\\n)## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`));
  return m ? m[1]!.trim() : '';
}

async function freeSlug(engine: BrainEngine, sourceId: string, base: string): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const slug = n === 1 ? base : `${base}-${n}`;
    const [row] = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id = $1 AND slug = $2 LIMIT 1`, [sourceId, slug]);
    if (!row) return slug;
  }
  throw new Error(`no free idea slug under ${base}`);
}

export async function findSlackIdea(engine: BrainEngine, cfg: InitiativesConfig, channel: string, ts: string): Promise<string | null> {
  const hit = (await listIdeas(engine, cfg)).find(i => String(i.frontmatter.slack_channel ?? '') === channel && String(i.frontmatter.slack_ts ?? '') === ts);
  return hit?.slug ?? null;
}

/** Adds `others` to an idea's similar[] (ideas only; never itself). */
export async function linkSimilar(ctx: OperationContext, cfg: InitiativesConfig, slug: string, others: string[]): Promise<boolean> {
  let changed = false;
  await updatePage(ctx, cfg.sourceId, slug, page => {
    if (page.type !== IDEA_TYPE) return null;
    const current = stringList(page.frontmatter.similar);
    const next = [...current];
    for (const o of others) if (o !== slug && !next.includes(o)) next.push(o);
    if (next.length === current.length) return null;
    changed = true;
    return { frontmatter: { ...page.frontmatter, similar: next } };
  });
  return changed;
}

function slackDate(ts: string, fallback: Date): string {
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? today(new Date(n * 1000)) : today(fallback);
}

/**
 * Records a near-identical submission as support on the existing idea: one line under `## Support` and votes + 1.
 * Idempotent per Slack message, or per author + text for other callers.
 */
async function addSupport(ctx: OperationContext, cfg: InitiativesConfig, slug: string, input: SubmitIdeaInput, now: Date): Promise<boolean> {
  const slack = input.slack;
  const who = input.author?.trim() || 'someone';
  const text = input.text.trim().replace(/\s*\n\s*/g, ' ');
  const marker = slack
    ? `<!-- slack:${slack.channel}:${slack.ts} -->`
    : `<!-- support:${createHash('sha256').update(`${who}\u0000${text}`).digest('hex').slice(0, 16)} -->`;
  let added = false;
  await updatePage(ctx, cfg.sourceId, slug, page => {
    const support = sectionOf(page.body, 'Support');
    if (support.includes(marker)) return null;
    const link = slack?.permalink ? ` ([Slack](${slack.permalink}))` : '';
    const date = slack ? slackDate(slack.ts, now) : today(now);
    const line = `- **${who}** (${date})${link}: ${text} ${marker}`;
    const votes = (Number(page.frontmatter.votes) || 0) + 1;
    added = true;
    return { frontmatter: { ...page.frontmatter, votes }, body: setSection(page.body, 'Support', support ? `${support}\n${line}` : line) };
  });
  return added;
}

/**
 * Submit an idea as `ctx`. A Slack message already recorded (same channel+ts)
 * returns its idea instead of writing twice.
 */
export async function submitIdea(ctx: OperationContext, cfg: InitiativesConfig, input: SubmitIdeaInput, deps: IdeasDeps = {}): Promise<SubmitIdeaResult> {
  const engine = ctx.engine;
  const now = (deps.now ?? (() => new Date()))();
  const title = input.title?.trim() || titleFromText(input.text);
  if (input.slack) {
    const existing = await findSlackIdea(engine, cfg, input.slack.channel, input.slack.ts);
    if (existing) {
      const similar = await findSimilar(engine, cfg, `${title}\n${input.text}`, { excludeSlug: existing }, deps);
      return { status: 'created', slug: existing, similar };
    }
  }
  const similar = await findSimilar(engine, cfg, `${title}\n${input.text}`, {}, deps);
  const top = similar.ideas[0];
  if (top && top.score >= cfg.duplicateThreshold && !input.allowDuplicate) {
    const supportAdded = !input.dryRun && !ctx.dryRun ? await addSupport(ctx, cfg, top.slug, input, now) : false;
    return { status: 'duplicate', slug: top.slug, duplicateOf: top, support_added: supportAdded, similar };
  }
  const slug = await freeSlug(engine, cfg.sourceId, `${cfg.ideasPrefix}${slugSegment(title)}`);
  if (input.dryRun || ctx.dryRun) return { status: 'dry_run', slug, similar };

  const similarSlugs = [...similar.ideas, ...similar.initiatives].filter(h => h.score >= cfg.similarThreshold).map(h => h.slug);
  const body = ideaBody(input);
  const frontmatter: Record<string, unknown> = {
    status: 'open',
    ...(input.author?.trim() ? { author: input.author.trim() } : {}),
    created: input.slack ? slackDate(input.slack.ts, now) : today(now),
    related: stringList(input.related ?? []),
    similar: similarSlugs,
    similar_checked_at: now.toISOString(),
    similar_checked_hash: substanceHash(title, body),
    ...(input.slack ? {
      slack_channel: input.slack.channel,
      ...(input.slack.channelName ? { slack_channel_name: input.slack.channelName } : {}),
      slack_ts: input.slack.ts,
      ...(input.slack.permalink ? { slack_permalink: input.slack.permalink } : {}),
    } : {}),
  };
  await writePage(ctx, { sourceId: cfg.sourceId, slug, type: IDEA_TYPE, title, frontmatter, body,
    requestKey: ['idea', cfg.sourceId, slug, input.slack ? `${input.slack.channel}:${input.slack.ts}` : body] });
  for (const other of similar.ideas.filter(h => h.score >= cfg.similarThreshold)) {
    await linkSimilar(ctx, cfg, other.slug, [slug]);
  }
  return { status: 'created', slug, similar };
}

export interface ResolveIdeaInput { status: IdeaResolutionStatus; by: string; reason?: string; dryRun?: boolean }
export interface ResolveIdeaResult {
  slug: string; title: string; status: string; previous_status: string; resolution: IdeaResolution; dry_run: boolean;
}

const RESOLUTION_HISTORY_MAX = 50;

/**
 * Set an idea's status by hand (accepted, rejected, obsolete, withdrawn, or open to reopen) and record who did it,
 * when and why: frontmatter `resolution` (the latest), `resolutions[]` (history) and a line under `## Resolution`.
 * An implemented idea is not resolvable: its initiative shipped it. The ideas phase keeps manual resolutions.
 */
export async function resolveIdea(ctx: OperationContext, cfg: InitiativesConfig, ideaSlug: string, input: ResolveIdeaInput,
  deps: { now?: () => Date } = {}): Promise<ResolveIdeaResult> {
  if (!(IDEA_RESOLUTIONS as readonly string[]).includes(input.status)) {
    throw new OperationError('invalid_params', `idea_resolve: status must be one of ${IDEA_RESOLUTIONS.join(', ')}.`,
      'planned and implemented come from initiatives; pick accepted, rejected, obsolete, withdrawn, or open to reopen.');
  }
  const current = await readPage(ctx.engine, cfg.sourceId, ideaSlug);
  if (!current || current.type !== IDEA_TYPE) {
    throw new OperationError('idea_not_found', `No idea ${ideaSlug} in source ${cfg.sourceId}.`,
      'List ideas with initiatives_list { kind: "idea" } and pass one of their slugs.');
  }
  const previous = ideaStatusOf(current.frontmatter);
  if (previous === 'implemented') {
    throw new OperationError('idea_implemented', `Idea ${current.slug} is implemented by ${String(current.frontmatter.implemented_by ?? 'an initiative')}.`,
      'An implemented idea stays implemented; submit a new idea for follow-up work.');
  }
  const now = (deps.now ?? (() => new Date()))();
  const reason = input.reason?.trim() || undefined;
  const resolution: IdeaResolution = { status: input.status, by: input.by.trim() || 'someone', at: now.toISOString(), ...(reason ? { reason } : {}) };
  // While an initiative works on it the idea stays planned; the resolution is kept and applies when that ends.
  const status = previous === 'planned' && (input.status === 'accepted' || input.status === 'open') ? 'planned' : input.status;
  const result: ResolveIdeaResult = { slug: current.slug, title: current.title, status, previous_status: previous, resolution, dry_run: !!input.dryRun || ctx.dryRun };
  if (result.dry_run) return result;
  await updatePage(ctx, cfg.sourceId, current.slug, page => {
    const history = Array.isArray(page.frontmatter.resolutions) ? (page.frontmatter.resolutions as unknown[]) : [];
    const line = `- ${resolution.at.slice(0, 10)} **${resolution.status === 'open' ? 'reopened' : resolution.status}** by ${resolution.by}${reason ? `: ${reason}` : ''}`;
    const section = sectionOf(page.body, 'Resolution');
    return {
      frontmatter: { ...page.frontmatter, status, resolution, resolutions: [...history, resolution].slice(-RESOLUTION_HISTORY_MAX) },
      body: setSection(page.body, 'Resolution', section ? `${section}\n${line}` : line),
    };
  });
  return result;
}
