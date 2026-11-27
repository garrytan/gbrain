/**
 * Cycle phase `ideas`: keeps idea pages in line with the initiatives that
 * implement them, and clusters similar ideas.
 *
 *   (a) status sync: an idea referenced by an initiative's `implements[]` is
 *       `implemented` (+ implemented_by) once any implementer is done,
 *       `planned` while one is active, and back to `open` when every
 *       implementer was cancelled. A human's rejected / withdrawn / obsolete
 *       stands unless an initiative is done. Slack-born ideas get one notice
 *       per new status (`status_notified`).
 *   (b) clustering: ideas whose substance changed since `similar_checked_hash`
 *       get findSimilar; hits >= similar_threshold join similar[] both ways.
 *       At most `initiatives.ideas.max_per_cycle` ideas per run.
 *
 * Kill switch: `cycle.ideas.enabled=false`. Writes use a trusted local context.
 */
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';
import {
  formatResolution, ideaResolutionOf, ideaStatusOf, initiativeStatusOf, readInitiativesConfig, stringList,
  type IdeaResolution, type IdeaStatus, type InitiativesConfig,
} from './model.ts';
import { listIdeas, listInitiatives, localContext, readPage, updatePage, type InitiativeRow } from './store.ts';
import { embeddingAvailable, findSimilar, linkSimilar, substanceHash, type IdeasDeps } from './ideas.ts';

export interface IdeaStatusNotice { ideaSlug: string; channel: string; ts: string; status: string; initiativeSlug?: string; text: string }

export interface IdeasPhaseOpts {
  dryRun?: boolean;
  signal?: AbortSignal;
  notify?: (n: IdeaStatusNotice) => Promise<void>;
  /** Test seams. */
  deps?: IdeasDeps;
  config?: InitiativesConfig;
}

const HUMAN_FINAL: readonly IdeaStatus[] = ['rejected', 'withdrawn', 'obsolete'];

/** idea slug → initiatives that implement it. */
function implementersByIdea(cfg: InitiativesConfig, ideas: InitiativeRow[], initiatives: InitiativeRow[]): Record<string, InitiativeRow[]> {
  const ideaSlugs = ideas.map(i => i.slug);
  const out: Record<string, InitiativeRow[]> = {};
  for (const ini of initiatives) {
    for (const ref of stringList(ini.frontmatter.implements)) {
      const clean = ref.replace(/\.md$/, '');
      const slug = ideaSlugs.includes(clean) ? clean
        : !clean.startsWith(cfg.ideasPrefix) && ideaSlugs.includes(`${cfg.ideasPrefix}${clean}`) ? `${cfg.ideasPrefix}${clean}` : null;
      if (!slug) continue;
      const list = out[slug] ?? (out[slug] = []);
      if (!list.some(x => x.slug === ini.slug)) list.push(ini);
    }
  }
  return out;
}

export interface StatusTarget { status: IdeaStatus; implementedBy?: string; initiative?: InitiativeRow }

/** Statuses a person set by hand (idea_resolve) that only a done initiative overrides. */
const MANUAL_NOTICE: readonly IdeaStatus[] = ['accepted', 'rejected', 'withdrawn', 'obsolete'];

/**
 * The status an idea should have given its implementers, or null to leave it as is. When the last active
 * implementer is cancelled, the idea returns to its manual resolution (accepted) or open.
 */
export function targetStatus(current: IdeaStatus, implementers: InitiativeRow[], resolution: IdeaResolution | null = null): StatusTarget | null {
  if (implementers.length === 0) return null;
  const done = implementers.find(i => initiativeStatusOf(i.frontmatter) === 'done');
  if (done) return { status: 'implemented', implementedBy: done.slug, initiative: done };
  if (HUMAN_FINAL.includes(current) || current === 'implemented') return null;
  const active = implementers.find(i => initiativeStatusOf(i.frontmatter) === 'active');
  if (active) return { status: 'planned', initiative: active };
  if (current === 'planned') return { status: resolution?.status === 'accepted' ? 'accepted' : 'open' };
  return null;
}

function noticeText(title: string, t: StatusTarget, resolution: IdeaResolution | null = null): string {
  if (resolution && resolution.status === t.status && MANUAL_NOTICE.includes(t.status)) {
    return `The idea *${title}* was ${formatResolution(resolution)}`;
  }
  const ini = t.initiative ? `*${t.initiative.title}* (\`${t.initiative.slug}\`)` : 'an initiative';
  if (t.status === 'implemented') return `The idea *${title}* has been implemented by ${ini}.`;
  if (t.status === 'planned') return `The idea *${title}* is now being worked on in ${ini}.`;
  if (t.status === 'open' && resolution?.status === 'open' && !t.initiative) return `The idea *${title}* was ${formatResolution(resolution)}`;
  if (t.status === 'open') return `The initiative working on the idea *${title}* was cancelled; the idea is open again.`;
  if (t.status === 'accepted') return `The initiative working on the idea *${title}* was cancelled; the idea stays accepted.`;
  return `The idea *${title}* is now ${t.status}.`;
}

export async function runIdeasPhase(engine: BrainEngine, opts: IdeasPhaseOpts = {}): Promise<PhaseResult> {
  const enabled = await engine.getConfig('cycle.ideas.enabled');
  if (enabled === 'false') {
    return { phase: 'ideas', status: 'skipped', duration_ms: 0, summary: 'cycle.ideas.enabled is false', details: { reason: 'disabled' } };
  }
  const cfg = opts.config ?? await readInitiativesConfig(engine);
  const ctx = localContext(engine, cfg.sourceId);
  const dryRun = opts.dryRun === true;
  const ideas = await listIdeas(engine, cfg);
  const initiatives = await listInitiatives(engine, cfg);
  const byIdea = implementersByIdea(cfg, ideas, initiatives);
  const tally = { ideas: ideas.length, status_changed: 0, notified: 0, notify_failed: 0, clustered: 0, similar_links: 0, failed: 0 };
  const changes: Array<{ slug: string; from: string; to: string }> = [];

  // (a) status sync
  for (const idea of ideas) {
    opts.signal?.throwIfAborted();
    const fm = idea.frontmatter;
    const current = ideaStatusOf(fm);
    const resolution = ideaResolutionOf(fm);
    const target = targetStatus(current, byIdea[idea.slug] ?? [], resolution);
    const changed = !!target && (target.status !== current || (target.implementedBy !== undefined && fm.implemented_by !== target.implementedBy));
    const status = changed ? target!.status : current;
    const slackBorn = typeof fm.slack_channel === 'string' && typeof fm.slack_ts === 'string' && !!fm.slack_channel && !!fm.slack_ts;
    const wantsNotice = slackBorn && String(fm.status_notified ?? '') !== status
      && ((changed && target!.status !== current) || status === 'planned' || status === 'implemented'
        // a manual resolution (idea_resolve), told once in the idea's Slack thread
        || (resolution !== null && resolution.status === status && (MANUAL_NOTICE.includes(status) || (status === 'open' && !!fm.status_notified))));
    if (!changed && !wantsNotice) continue;
    if (changed) changes.push({ slug: idea.slug, from: current, to: status });
    if (dryRun) { if (changed) tally.status_changed++; continue; }
    let notified = false;
    if (wantsNotice && opts.notify) {
      try {
        await opts.notify({
          ideaSlug: idea.slug, channel: String(fm.slack_channel), ts: String(fm.slack_ts), status,
          ...(target?.initiative ? { initiativeSlug: target.initiative.slug } : {}),
          text: noticeText(idea.title, target ?? { status }, resolution),
        });
        notified = true; tally.notified++;
      } catch { tally.notify_failed++; }
    }
    if (!changed && !notified) continue;
    try {
      await updatePage(ctx, cfg.sourceId, idea.slug, page => {
        const next = { ...page.frontmatter };
        if (changed) {
          next.status = status;
          if (target!.implementedBy) next.implemented_by = target!.implementedBy;
        }
        if (notified) next.status_notified = status;
        return { frontmatter: next };
      });
      if (changed) tally.status_changed++;
    } catch (e) {
      tally.failed++;
      ctx.logger.warn(`[ideas] status sync for ${idea.slug} failed: ${(e as Error).message}`);
    }
  }

  // (b) clustering
  const canCluster = await embeddingAvailable(opts.deps ?? {});
  let budget = canCluster ? cfg.maxPerCycle : 0;
  for (const row of ideas) {
    if (budget <= 0) break;
    opts.signal?.throwIfAborted();
    const page = await readPage(engine, cfg.sourceId, row.slug);
    if (!page) continue;
    const hash = substanceHash(page.title, page.body);
    if (page.frontmatter.similar_checked_hash === hash) continue;
    budget--;
    if (dryRun) { tally.clustered++; continue; }
    try {
      const groups = await findSimilar(engine, cfg, `${page.title}\n${page.body}`, { excludeSlug: page.slug }, opts.deps ?? {});
      const hits = [...groups.ideas, ...groups.initiatives].filter(h => h.score >= cfg.similarThreshold).map(h => h.slug);
      await updatePage(ctx, cfg.sourceId, page.slug, p => {
        const current = stringList(p.frontmatter.similar);
        const similar = [...current, ...hits.filter(h => h !== p.slug && !current.includes(h))];
        tally.similar_links += similar.length - current.length;
        return { frontmatter: { ...p.frontmatter, similar, similar_checked_at: new Date().toISOString(), similar_checked_hash: hash } };
      });
      for (const other of groups.ideas.filter(h => h.score >= cfg.similarThreshold)) {
        if (await linkSimilar(ctx, cfg, other.slug, [page.slug])) tally.similar_links++;
      }
      tally.clustered++;
    } catch (e) {
      tally.failed++;
      ctx.logger.warn(`[ideas] clustering for ${page.slug} failed: ${(e as Error).message}`);
    }
  }

  const status = tally.failed > 0 || tally.notify_failed > 0 ? 'warn' : tally.status_changed + tally.clustered === 0 ? 'skipped' : 'ok';
  return {
    phase: 'ideas', status, duration_ms: 0,
    summary: `${tally.status_changed} status changes, ${tally.notified} notices, ${tally.clustered} ideas clustered (${tally.similar_links} links)${dryRun ? ' (dry run)' : ''}`,
    details: { ...tally, dry_run: dryRun, clustering: canCluster ? 'on' : 'no_embedding_provider', max_per_cycle: cfg.maxPerCycle, changes },
  };
}
