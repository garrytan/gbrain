/**
 * Ideas and initiatives: the shared model (page types, statuses, frontmatter
 * fields, config). Pages are ordinary brain pages typed by the
 * gbrain-initiatives schema pack:
 *
 *   idea        `<ideas_prefix><slug>`        status open | planned | implemented | obsolete | rejected | withdrawn
 *   initiative  `<initiatives_prefix><slug>`  status active | done | cancelled
 *
 * Everything the lifecycle needs lives in frontmatter (remote put_page skips
 * typed links, so the lifecycle never depends on the links table):
 *
 *   initiative: implements[], targets[], slack_channels[], tracker, started,
 *               finished_at, finish_note, slack_released_at, merge_status, merged_at
 *   idea:       author, similar[], related[], slack_channel, slack_ts, slack_permalink,
 *               implemented_by, status_notified
 *
 * Generic on purpose: no deployment names, every prefix is config.
 */
import type { BrainEngine } from '../engine.ts';

export const IDEA_TYPE = 'idea';
export const INITIATIVE_TYPE = 'initiative';

export const IDEA_STATUSES = ['open', 'planned', 'implemented', 'obsolete', 'rejected', 'withdrawn'] as const;
export type IdeaStatus = typeof IDEA_STATUSES[number];
export const INITIATIVE_STATUSES = ['active', 'done', 'cancelled'] as const;
export type InitiativeStatus = typeof INITIATIVE_STATUSES[number];

export interface InitiativesConfig {
  /** Source that holds idea and initiative pages (and new projects). */
  sourceId: string;
  ideasPrefix: string;
  initiativesPrefix: string;
  /** Where a finished initiative creates a page for a target that does not exist yet. */
  newProjectPrefix: string;
  /** finish_initiative posts a closing message and leaves the initiative's Slack channels. */
  slackLeaveOnFinish: boolean;
  /** merge_initiative applies its plan right away instead of proposing it. */
  mergeAutoApply: boolean;
  /** Cosine similarity at which an idea links to a similar idea or initiative. */
  similarThreshold: number;
  /** Cosine similarity at which a new idea is a duplicate of an existing one. */
  duplicateThreshold: number;
  /** Ideas the ideas phase clusters per run. */
  maxPerCycle: number;
}

export const INITIATIVES_CONFIG = {
  source: 'initiatives.source',
  ideasPrefix: 'initiatives.ideas_prefix',
  initiativesPrefix: 'initiatives.initiatives_prefix',
  newProjectPrefix: 'initiatives.new_project_prefix',
  slackLeaveOnFinish: 'initiatives.slack.leave_on_finish',
  mergeAutoApply: 'initiatives.merge.auto_apply',
  similarThreshold: 'initiatives.ideas.similar_threshold',
  duplicateThreshold: 'initiatives.ideas.duplicate_threshold',
  maxPerCycle: 'initiatives.ideas.max_per_cycle',
} as const;

/** A slug prefix: no leading slash, exactly one trailing slash. */
export function normalizePrefix(value: string | null | undefined, fallback: string): string {
  const v = (value ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return v ? `${v}/` : fallback;
}

function truthy(v: string | null | undefined, fallback: boolean): boolean {
  if (v == null || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function num(v: string | null | undefined, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export async function readInitiativesConfig(engine: Pick<BrainEngine, 'getConfig'>): Promise<InitiativesConfig> {
  const safe = (p: Promise<string | null>) => p.catch(() => null);
  const [source, ideas, inits, projects, leave, auto, similar, dup, max] = await Promise.all([
    safe(engine.getConfig('initiatives.source')),
    safe(engine.getConfig('initiatives.ideas_prefix')),
    safe(engine.getConfig('initiatives.initiatives_prefix')),
    safe(engine.getConfig('initiatives.new_project_prefix')),
    safe(engine.getConfig('initiatives.slack.leave_on_finish')),
    safe(engine.getConfig('initiatives.merge.auto_apply')),
    safe(engine.getConfig('initiatives.ideas.similar_threshold')),
    safe(engine.getConfig('initiatives.ideas.duplicate_threshold')),
    safe(engine.getConfig('initiatives.ideas.max_per_cycle')),
  ]);
  return {
    sourceId: (source ?? '').trim() || 'default',
    ideasPrefix: normalizePrefix(ideas, 'ideas/'),
    initiativesPrefix: normalizePrefix(inits, 'initiatives/'),
    newProjectPrefix: normalizePrefix(projects, 'projects/'),
    slackLeaveOnFinish: truthy(leave, true),
    mergeAutoApply: truthy(auto, false),
    similarThreshold: num(similar, 0.85, 0.5, 0.99),
    duplicateThreshold: num(dup, 0.92, 0.5, 0.999),
    maxPerCycle: Math.floor(num(max, 200, 1, 5000)),
  };
}

/** A frontmatter value as a list of non-empty strings (a scalar becomes one item; `[[slug]]` wikilinks unwrap). */
export function stringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const v = item.trim().replace(/^\[\[(.*?)(\|.*)?\]\]$/, '$1').trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/** Lowercase kebab slug segment from free text (max 60 chars). */
export function slugSegment(text: string): string {
  const s = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || 'untitled';
}

export const SLACK_CHANNEL_ID = /^[CGD][A-Z0-9]{6,}$/;

export function initiativeStatusOf(frontmatter: Record<string, unknown> | null | undefined): InitiativeStatus {
  const s = String(frontmatter?.status ?? 'active').trim().toLowerCase();
  return (INITIATIVE_STATUSES as readonly string[]).includes(s) ? s as InitiativeStatus : 'active';
}

export function ideaStatusOf(frontmatter: Record<string, unknown> | null | undefined): IdeaStatus {
  const s = String(frontmatter?.status ?? 'open').trim().toLowerCase();
  return (IDEA_STATUSES as readonly string[]).includes(s) ? s as IdeaStatus : 'open';
}

/** Today as YYYY-MM-DD (UTC). */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
