/**
 * Ideas and initiatives over MCP and the CLI.
 *
 *   initiatives_list        read   ideas or initiatives with their status
 *   initiative_status       read   one initiative: status, facts so far, ideas, targets, Slack, merge
 *   initiative_start        write  create an initiative page (requirements body + lifecycle frontmatter)
 *   initiative_bind_slack   write  bind (or unbind) a Slack channel; its messages become facts on the initiative
 *   finish_initiative       write  mark done or cancelled; a job runs the final Slack sync, leaves the
 *                                  channels and (done) proposes the merge into the target pages
 *   initiative_merge_apply  write  apply the proposed merge plan (minus skipped items)
 *   idea_submit             write  add an idea, or find the existing duplicate; returns similar ideas,
 *                                  initiatives in progress and existing core pages
 *
 * Every write runs as the caller through the page mutation coordinator, so
 * scopes, slug fences, revisions and end-user attribution apply. Pages live in
 * the configured initiatives source (initiatives.source, default 'default').
 * Never import from '../operations.ts' here (cycle).
 */
import { opError, type Operation, type OperationContext } from './contract.ts';
import { enforceClientSlugFence, sourceScopeOpts, validatePageSlug } from './context.ts';
import { WRITE_REQUEST_PARAM } from '../persistence/params.ts';
import {
  INITIATIVE_TYPE, ideaStatusOf, initiativeStatusOf, readInitiativesConfig, slugSegment, stringList, today,
  type InitiativesConfig,
} from '../initiatives/model.ts';
import {
  initiativeChannels, listIdeas, listInitiatives, readPage, resolveUnderPrefix, slackChannelsOf, updatePage, writePage,
} from '../initiatives/store.ts';

const STR_LIST = (description: string) => ({ type: 'array' as const, items: { type: 'string' as const }, description });

async function scopedConfig(ctx: OperationContext, op: string): Promise<InitiativesConfig> {
  const cfg = await readInitiativesConfig(ctx.engine);
  const scope = sourceScopeOpts(ctx);
  const allowed = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : null);
  if (ctx.remote !== false && allowed && !allowed.includes(cfg.sourceId)) {
    throw opError('permission_denied', `${op}: initiatives live in source '${cfg.sourceId}', which this connection cannot read.`,
      'Use a connection whose source grant includes the initiatives source.');
  }
  return cfg;
}

/** `slug` or a bare name → an existing initiative page slug. */
async function initiativeSlug(ctx: OperationContext, cfg: InitiativesConfig, ref: unknown, op: string): Promise<string> {
  if (typeof ref !== 'string' || !ref.trim()) throw opError('invalid_params', `${op}: slug is required.`, 'Pass the initiative slug (initiatives_list shows them).');
  const slug = await resolveUnderPrefix(ctx.engine, cfg.sourceId, cfg.initiativesPrefix, ref);
  const page = slug ? await readPage(ctx.engine, cfg.sourceId, slug) : null;
  if (!page || page.type !== INITIATIVE_TYPE) {
    throw opError('initiative_not_found', `${op}: no initiative '${ref}' in source '${cfg.sourceId}'.`, 'List initiatives with initiatives_list, or create one with initiative_start.');
  }
  return page.slug;
}

const initiatives_list: Operation = {
  name: 'initiatives_list',
  outputRedaction: 'no_stored_text',
  description: 'List ideas or initiatives with status (filter by status). Ideas: open/planned/implemented/obsolete/rejected/withdrawn; initiatives: active/done/cancelled.',
  params: {
    kind: { type: 'string', enum: ['initiative', 'idea'], description: 'What to list (default initiative).' },
    status: { type: 'string', description: 'Only this status.' },
    limit: { type: 'number', description: 'Max rows (default 100, max 500).' },
  },
  scope: 'read',
  area: 'initiatives',
  handler: async (ctx, p) => {
    const cfg = await scopedConfig(ctx, 'initiatives_list');
    const kind = p.kind === 'idea' ? 'idea' : 'initiative';
    const limit = Math.min(500, Math.max(1, Number(p.limit) || 100));
    const rows = kind === 'idea' ? await listIdeas(ctx.engine, cfg) : await listInitiatives(ctx.engine, cfg);
    const items = rows.map(r => kind === 'idea'
      ? { slug: r.slug, title: r.title, status: ideaStatusOf(r.frontmatter), author: r.frontmatter.author ?? null,
          votes: Number(r.frontmatter.votes) || 0, implemented_by: r.frontmatter.implemented_by ?? null, similar: stringList(r.frontmatter.similar) }
      : { slug: r.slug, title: r.title, status: initiativeStatusOf(r.frontmatter), tracker: r.frontmatter.tracker ?? null,
          implements: stringList(r.frontmatter.implements), targets: stringList(r.frontmatter.targets),
          slack_channels: slackChannelsOf(r.frontmatter), started: r.frontmatter.started ?? null,
          finished_at: r.frontmatter.finished_at ?? null, merge_status: r.frontmatter.merge_status ?? null })
      .filter(i => typeof p.status !== 'string' || i.status === p.status);
    return { kind, source_id: cfg.sourceId, count: items.length, items: items.slice(0, limit) };
  },
};

const initiative_status: Operation = {
  name: 'initiative_status',
  outputRedaction: 'no_stored_text',
  description: 'One initiative: status, recent facts collected (Slack, meetings, remember), ideas it implements, targets, Slack channels and merge state.',
  params: {
    slug: { type: 'string', required: true, description: 'Initiative slug or name.' },
    facts_limit: { type: 'number', description: 'Recent facts to return (default 20, max 100).' },
  },
  scope: 'read',
  area: 'initiatives',
  handler: async (ctx, p) => {
    const cfg = await scopedConfig(ctx, 'initiative_status');
    const slug = await initiativeSlug(ctx, cfg, p.slug, 'initiative_status');
    const page = (await readPage(ctx.engine, cfg.sourceId, slug))!;
    const fm = page.frontmatter;
    const limit = Math.min(100, Math.max(1, Number(p.facts_limit) || 20));
    const [count] = await ctx.engine.executeRaw<{ n: number | string }>(
      `SELECT count(*) AS n FROM facts WHERE source_id = $1 AND entity_slug = $2 AND expired_at IS NULL`, [cfg.sourceId, slug]);
    const facts = await ctx.engine.executeRaw<{ id: number; fact: string; kind: string; valid_from: string | Date; context: string | null }>(
      `SELECT id, fact, kind, valid_from, context FROM facts WHERE source_id = $1 AND entity_slug = $2 AND expired_at IS NULL
         ${ctx.remote !== false ? `AND visibility = 'world'` : ''}
        ORDER BY valid_from DESC, id DESC LIMIT $3`, [cfg.sourceId, slug, limit]);
    const ideas = [];
    for (const ref of stringList(fm.implements)) {
      const s = await resolveUnderPrefix(ctx.engine, cfg.sourceId, cfg.ideasPrefix, ref);
      const idea = s ? await readPage(ctx.engine, cfg.sourceId, s) : null;
      ideas.push({ ref, slug: idea?.slug ?? null, title: idea?.title ?? null, status: idea ? ideaStatusOf(idea.frontmatter) : 'missing' });
    }
    const targets = [];
    for (const ref of stringList(fm.targets)) {
      const t = await readPage(ctx.engine, cfg.sourceId, ref);
      targets.push({ slug: ref, exists: !!t, type: t?.type ?? null, title: t?.title ?? null });
    }
    const docs = await ctx.engine.executeRaw<{ slug: string; title: string | null }>(
      `SELECT slug, title FROM pages WHERE source_id = $1 AND slug LIKE $2 AND type = 'initiative-doc' AND deleted_at IS NULL ORDER BY slug`,
      [cfg.sourceId, `${slug.replace(/[\\%_]/g, '\\$&')}/%`]);
    const sources = await ctx.engine.executeRaw<{ id: string; last_sync_at: string | Date | null }>(
      `SELECT id, last_sync_at FROM sources WHERE config->>'kind' = 'slack' AND config->>'s_channels_from' = 'initiatives' ORDER BY id`);
    return {
      slug, title: page.title, status: initiativeStatusOf(fm), tracker: fm.tracker ?? null, started: fm.started ?? null,
      finished_at: fm.finished_at ?? null, finish_note: fm.finish_note ?? null,
      slack: { channels: slackChannelsOf(fm), released_at: fm.slack_released_at ?? null,
        sources: sources.map(s => ({ id: s.id, last_sync_at: s.last_sync_at })) },
      facts: { count: Number(count?.n ?? 0), recent: facts.map(f => ({ id: Number(f.id), fact: f.fact, kind: f.kind, valid_from: f.valid_from, provenance: f.context })) },
      implements: ideas, targets, docs: docs.map(d => ({ slug: d.slug, title: d.title })),
      merge: { status: fm.merge_status ?? null, merged_at: fm.merged_at ?? null },
    };
  },
};

const initiative_start: Operation = {
  name: 'initiative_start',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Create an initiative: requirements as the page body, the ideas it implements, the project/concept pages it changes (targets; none = it becomes a new project), tracker key and optionally a Slack channel to bind.',
  params: {
    title: { type: 'string', required: true, description: 'Initiative title.' },
    body: { type: 'string', required: true, description: 'Requirements in markdown (problem, goals, requirements, affected systems, rollout, risks).' },
    slug: { type: 'string', description: 'Slug tail (default from the title); created under the initiatives prefix.' },
    implements: STR_LIST('Idea slugs this initiative implements.'),
    targets: STR_LIST('Slugs of project/concept pages this initiative changes; a slug that does not exist becomes a new project on finish.'),
    tracker: { type: 'string', description: 'Issue tracker key (epic), free-form.' },
    slack_channel: { type: 'string', description: 'Slack channel name or id to bind right away (the bot must be in it).' },
    request_id: WRITE_REQUEST_PARAM,
  },
  scope: 'write',
  mutating: true,
  area: 'initiatives',
  handler: async (ctx, p) => {
    const cfg = await scopedConfig(ctx, 'initiative_start');
    const title = typeof p.title === 'string' ? p.title.trim() : '';
    const body = typeof p.body === 'string' ? p.body.trim() : '';
    if (!title || !body) throw opError('invalid_params', 'initiative_start: title and body are required.', 'Pass the title and the requirements markdown.');
    const tail = typeof p.slug === 'string' && p.slug.trim() ? p.slug.trim().replace(/^.*\//, '') : slugSegment(title);
    const slug = `${cfg.initiativesPrefix}${slugSegment(tail)}`;
    validatePageSlug(slug);
    enforceClientSlugFence(ctx, slug, 'initiative_start');
    if (await readPage(ctx.engine, cfg.sourceId, slug)) {
      throw opError('invalid_params', `initiative_start: page '${slug}' already exists.`, 'Pick another slug, or edit the existing page with edit_page.');
    }
    const implementsRefs: string[] = [];
    for (const ref of stringList(p.implements)) implementsRefs.push(await resolveUnderPrefix(ctx.engine, cfg.sourceId, cfg.ideasPrefix, ref) ?? ref);
    const frontmatter: Record<string, unknown> = {
      status: 'active', started: today(),
      implements: implementsRefs, targets: stringList(p.targets), slack_channels: [],
      ...(typeof p.tracker === 'string' && p.tracker.trim() ? { tracker: p.tracker.trim() } : {}),
    };
    if (ctx.dryRun) return { dry_run: true, action: 'initiative_start', slug, frontmatter };
    await writePage(ctx, { sourceId: cfg.sourceId, slug, type: INITIATIVE_TYPE, title, frontmatter, body,
      requestKey: typeof p.request_id === 'string' ? ['initiative_start', p.request_id] : undefined });
    const out: Record<string, unknown> = { status: 'created', slug, source_id: cfg.sourceId, frontmatter };
    if (typeof p.slack_channel === 'string' && p.slack_channel.trim()) {
      try { out.slack = await bindSlack(ctx, cfg, slug, p.slack_channel.trim(), false); }
      catch (err) { out.slack = { error: (err as { code?: string }).code ?? 'error', message: (err as Error).message }; }
    }
    return out;
  },
};

async function bindSlack(ctx: OperationContext, cfg: InitiativesConfig, slug: string, channelRef: string, unbind: boolean): Promise<Record<string, unknown>> {
  const page = (await readPage(ctx.engine, cfg.sourceId, slug))!;
  if (initiativeStatusOf(page.frontmatter) !== 'active') {
    throw opError('initiative_not_active', `initiative_bind_slack: '${slug}' is ${initiativeStatusOf(page.frontmatter)}.`, 'Only an active initiative reads Slack channels.');
  }
  const { initiativesSlackApi } = await import('../initiatives/slack.ts');
  const api = initiativesSlackApi();
  let channel: { id: string; name: string; isMember: boolean };
  if (unbind && /^[CG][A-Z0-9]{6,}$/i.test(channelRef)) {
    channel = { id: channelRef.toUpperCase(), name: channelRef, isMember: true };
  } else {
    if (!api) throw opError('slack_not_configured', 'initiative_bind_slack: no Slack bot token is configured.', 'The operator sets GBRAIN_CONNECTOR_SLACK_TOKEN (or runs gbrain connectors auth slack).');
    const { resolveSlackChannel } = await import('../slack/client.ts');
    try { channel = await resolveSlackChannel(api, channelRef); }
    catch (err) {
      throw opError('slack_channel_not_found', `initiative_bind_slack: ${(err as Error).message}`, 'Check the channel name; for a private channel invite the bot first (/invite @<bot>).');
    }
  }
  if (unbind) {
    await updatePage(ctx, cfg.sourceId, slug, pg => {
      const list = slackChannelsOf(pg.frontmatter);
      return list.includes(channel.id) ? { frontmatter: { ...pg.frontmatter, slack_channels: list.filter(c => c !== channel.id) } } : null;
    });
    return { status: 'unbound', channel: { id: channel.id, name: channel.name } };
  }
  if (!channel.isMember) {
    try { await api!.joinChannel(channel.id); channel.isMember = true; } catch { /* private channel: needs an invite */ }
  }
  if (!channel.isMember) {
    throw opError('slack_bot_not_in_channel', `initiative_bind_slack: the bot is not in #${channel.name}.`, `In Slack, open #${channel.name} and run /invite @<bot>, then bind again.`);
  }
  const owner = (await initiativeChannels(ctx.engine, cfg)).find(c => c.channel === channel.id && c.initiative.slug !== slug);
  if (owner) throw opError('slack_channel_bound', `initiative_bind_slack: #${channel.name} is already bound to '${owner.initiative.slug}'.`, 'Unbind it there first, or use another channel.');
  const intake = await ctx.engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE config->>'kind' = 'slack' AND config->>'s_mode' = 'intake' AND position($1 in COALESCE(config->>'s_channels', '')) > 0`, [channel.id]);
  if (intake.length) throw opError('slack_channel_bound', `initiative_bind_slack: #${channel.name} is the ideas intake channel of source '${intake[0].id}'.`, 'Use a dedicated channel for the initiative.');
  await updatePage(ctx, cfg.sourceId, slug, pg => {
    const list = slackChannelsOf(pg.frontmatter);
    return list.includes(channel.id) ? null : { frontmatter: { ...pg.frontmatter, slack_channels: [...list, channel.id] } };
  });
  const sources = await ctx.engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE config->>'kind' = 'slack' AND config->>'s_channels_from' = 'initiatives' AND NOT COALESCE(archived, false) ORDER BY id`);
  const jobs: number[] = [];
  if (sources.length) {
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    for (const s of sources) {
      const job = await queue.add('sync', { sourceId: s.id, embed_reason: 'initiative_bind_slack' },
        { priority: -10, idempotency_key: `initiative-bind:${s.id}:${channel.id}`, maxWaiting: 1 } as never).catch(() => null);
      if (job && typeof (job as { id?: number }).id === 'number') jobs.push((job as { id: number }).id);
    }
  }
  return {
    status: 'bound', channel: { id: channel.id, name: channel.name }, sync_jobs: jobs,
    ...(sources.length ? {} : { warning: 'No Slack source reads initiative channels yet. The operator runs once: gbrain sources add <id> --kind slack --channels-from initiatives' }),
  };
}

const initiative_bind_slack: Operation = {
  name: 'initiative_bind_slack',
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description: 'Bind a Slack channel (name or id) to an active initiative: its messages and threads are synced and their facts land on the initiative. The bot must be in the channel (/invite @<bot> for private ones). unbind:true stops reading it.',
  params: {
    slug: { type: 'string', required: true, description: 'Initiative slug or name.' },
    channel: { type: 'string', required: true, description: 'Channel name (#name or name) or id.' },
    unbind: { type: 'boolean', description: 'Stop reading the channel instead.' },
  },
  scope: 'write',
  mutating: true,
  area: 'initiatives',
  handler: async (ctx, p) => {
    const cfg = await scopedConfig(ctx, 'initiative_bind_slack');
    const slug = await initiativeSlug(ctx, cfg, p.slug, 'initiative_bind_slack');
    enforceClientSlugFence(ctx, slug, 'initiative_bind_slack');
    if (typeof p.channel !== 'string' || !p.channel.trim()) throw opError('invalid_params', 'initiative_bind_slack: channel is required.', 'Pass the Slack channel name or id.');
    if (ctx.dryRun) return { dry_run: true, action: p.unbind === true ? 'unbind' : 'bind', slug, channel: p.channel };
    return { slug, ...await bindSlack(ctx, cfg, slug, p.channel.trim(), p.unbind === true) };
  },
};

const finish_initiative: Operation = {
  name: 'finish_initiative',
  outputRedaction: 'no_stored_text',
  description: 'Finish an active initiative as done or cancelled. A background job runs the final Slack sync, posts a closing note and leaves its channels; for done it writes a merge plan (facts added/replaced/obsoleted on the target pages, new projects) into the page for review (initiative_merge_apply applies it). dry_run shows the steps.',
  params: {
    slug: { type: 'string', required: true, description: 'Initiative slug or name.' },
    outcome: { type: 'string', required: true, enum: ['done', 'cancelled'], description: 'done (shipped) or cancelled.' },
    note: { type: 'string', description: 'Release or closing note.' },
    dry_run: { type: 'boolean', description: 'Show the steps without changing anything.' },
  },
  scope: 'write',
  mutating: true,
  area: 'initiatives',
  handler: async (ctx, p) => {
    const cfg = await scopedConfig(ctx, 'finish_initiative');
    const slug = await initiativeSlug(ctx, cfg, p.slug, 'finish_initiative');
    enforceClientSlugFence(ctx, slug, 'finish_initiative');
    if (p.outcome !== 'done' && p.outcome !== 'cancelled') throw opError('invalid_params', 'finish_initiative: outcome must be done or cancelled.', 'Pass outcome: "done" or "cancelled".');
    const { finishInitiative } = await import('../initiatives/finish.ts');
    return finishInitiative(ctx, cfg, slug, { outcome: p.outcome, ...(typeof p.note === 'string' ? { note: p.note } : {}), dryRun: p.dry_run === true || ctx.dryRun });
  },
};

const initiative_merge_apply: Operation = {
  name: 'initiative_merge_apply',
  outputRedaction: 'no_stored_text',
  description: 'Apply the merge plan of a finished (done) initiative to its target pages: facts added, replaced (old kept as history) or withdrawn, new project pages created, timeline entries linking back. skip: item ids to leave out. dry_run previews.',
  params: {
    slug: { type: 'string', required: true, description: 'Initiative slug or name.' },
    skip: STR_LIST('Merge plan item ids (m1, m2, …) to leave out.'),
    dry_run: { type: 'boolean', description: 'Preview without writing.' },
  },
  scope: 'write',
  mutating: true,
  area: 'initiatives',
  handler: async (ctx, p) => {
    const cfg = await scopedConfig(ctx, 'initiative_merge_apply');
    const slug = await initiativeSlug(ctx, cfg, p.slug, 'initiative_merge_apply');
    enforceClientSlugFence(ctx, slug, 'initiative_merge_apply');
    const { applyMerge } = await import('../initiatives/merge.ts');
    return applyMerge(ctx, cfg, slug, { skip: stringList(p.skip), dryRun: p.dry_run === true || ctx.dryRun });
  },
};

const idea_submit: Operation = {
  name: 'idea_submit',
  outputRedaction: 'no_stored_text',
  description: 'Add an idea (problem + proposal). Checks first: a near-identical idea returns status duplicate instead of a new page; always returns similar ideas, initiatives in progress and existing project/concept pages (maybe already implemented). dry_run only checks.',
  params: {
    text: { type: 'string', required: true, description: 'The idea in plain words.' },
    title: { type: 'string', description: 'Short title (default from the text).' },
    problem: { type: 'string', description: 'The problem it solves.' },
    proposal: { type: 'string', description: 'What to build or change.' },
    related: STR_LIST('Slugs of project/concept pages the idea concerns.'),
    dry_run: { type: 'boolean', description: 'Only check for duplicates and similar work.' },
    allow_duplicate: { type: 'boolean', description: 'Create even when a near-identical idea exists.' },
  },
  scope: 'write',
  mutating: true,
  area: 'initiatives',
  handler: async (ctx, p) => {
    const cfg = await scopedConfig(ctx, 'idea_submit');
    const text = typeof p.text === 'string' ? p.text.trim() : '';
    if (!text) throw opError('invalid_params', 'idea_submit: text is required.', 'Describe the idea in plain words.');
    const { submitIdea } = await import('../initiatives/ideas.ts');
    const author = ctx.agentLabel ?? undefined;
    return submitIdea(ctx, cfg, {
      text,
      ...(typeof p.title === 'string' && p.title.trim() ? { title: p.title.trim() } : {}),
      ...(typeof p.problem === 'string' ? { problem: p.problem } : {}),
      ...(typeof p.proposal === 'string' ? { proposal: p.proposal } : {}),
      ...(author ? { author } : {}),
      related: stringList(p.related),
      dryRun: p.dry_run === true || ctx.dryRun,
      allowDuplicate: p.allow_duplicate === true,
    });
  },
};

export const initiativeOperations: Operation[] = [
  initiatives_list, initiative_status, initiative_start, initiative_bind_slack, finish_initiative, initiative_merge_apply, idea_submit,
];
