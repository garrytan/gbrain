import matter from 'gray-matter';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { BrainEngine, LinkBatchInput, TimelineBatchInput } from './engine.ts';
import { parseMarkdown, resolvePageFilePath } from './markdown.ts';
import { slugifyPath } from './sync.ts';
import { filterAttendees, listPendingMeetings, type MeetingAttendee } from './meeting-sync.ts';

export interface MeetingPropagationOptions {
  repoPath: string;
  sourceId?: string;
  dryRun?: boolean;
  limit?: number;
  meetings?: string[];
}

export interface MeetingPropagationResult {
  repoPath: string;
  sourceId: string;
  dryRun: boolean;
  scanned: number;
  completed: number;
  failed: number;
  pending: number;
  meetings: MeetingPropagationMeetingResult[];
}

export interface MeetingPropagationMeetingResult {
  path: string;
  slug: string;
  title: string;
  externalSourceId?: string;
  status: 'complete' | 'pending' | 'failed';
  attendees: Array<{ name: string; slug: string; created: boolean }>;
  entities: Array<{ title: string; slug: string; type: string }>;
  actionItems: Array<{ text: string; owner?: string; slug: string }>;
  pagesCreated: number;
  linksCreated: number;
  timelineEntriesCreated: number;
  verificationErrors: string[];
  skipReasons: string[];
}

export interface MeetingCompletionOptions {
  repoPath: string;
  sourceId?: string;
  dryRun?: boolean;
  limit?: number;
  meetings?: string[];
  agentReviewed?: boolean;
}

export interface MeetingCompletionResult {
  repoPath: string;
  sourceId: string;
  dryRun: boolean;
  agentReviewed: boolean;
  scanned: number;
  completed: number;
  failed: number;
  meetings: MeetingCompletionMeetingResult[];
}

export interface MeetingCompletionMeetingResult {
  path: string;
  slug: string;
  title: string;
  externalSourceId?: string;
  status: 'complete' | 'blocked' | 'failed';
  verificationErrors: string[];
}

interface ParsedMeetingFile {
  path: string;
  slug: string;
  title: string;
  date: string;
  externalSourceId?: string;
  frontmatter: Record<string, unknown>;
  body: string;
  transcriptBlock: string;
  content: string;
}

interface TargetEntity {
  slug: string;
  title: string;
  type: string;
  kind: 'attendee' | 'entity' | 'action';
  created?: boolean;
}

const ENTITY_TYPES = ['person', 'company', 'organization', 'entity', 'project', 'concept'];

export async function propagatePendingMeetings(
  engine: BrainEngine,
  opts: MeetingPropagationOptions,
): Promise<MeetingPropagationResult> {
  const repoPath = resolve(opts.repoPath);
  const sourceId = opts.sourceId ?? 'default';
  const pending = selectPendingMeetings(repoPath, opts.meetings, opts.limit);
  const result: MeetingPropagationResult = {
    repoPath,
    sourceId,
    dryRun: Boolean(opts.dryRun),
    scanned: pending.length,
    completed: 0,
    failed: 0,
    pending: 0,
    meetings: [],
  };

  for (const path of pending) {
    const meeting = readMeetingFile(repoPath, path);
    try {
      const meetingResult = await propagateMeeting(engine, meeting, {
        repoPath,
        sourceId,
        dryRun: Boolean(opts.dryRun),
      });
      result.meetings.push(meetingResult);
      if (meetingResult.status === 'complete') result.completed++;
      else if (meetingResult.status === 'failed') result.failed++;
      else result.pending++;
    } catch (e) {
      result.failed++;
      result.meetings.push({
        path,
        slug: meeting?.slug ?? slugFromPath(repoPath, path),
        title: meeting?.title ?? '(unknown meeting)',
        externalSourceId: meeting?.externalSourceId,
        status: 'failed',
        attendees: [],
        entities: [],
        actionItems: [],
        pagesCreated: 0,
        linksCreated: 0,
        timelineEntriesCreated: 0,
        verificationErrors: [e instanceof Error ? e.message : String(e)],
        skipReasons: [],
      });
    }
  }

  return result;
}

export async function verifyCompleteMeetings(
  engine: BrainEngine,
  opts: MeetingCompletionOptions,
): Promise<MeetingCompletionResult> {
  const repoPath = resolve(opts.repoPath);
  const sourceId = opts.sourceId ?? 'default';
  const paths = selectPendingMeetings(repoPath, opts.meetings, opts.limit);
  const result: MeetingCompletionResult = {
    repoPath,
    sourceId,
    dryRun: Boolean(opts.dryRun),
    agentReviewed: Boolean(opts.agentReviewed),
    scanned: paths.length,
    completed: 0,
    failed: 0,
    meetings: [],
  };

  for (const path of paths) {
    try {
      const meeting = readMeetingFile(repoPath, path);
      const verificationErrors = await verifyMeetingComplete(engine, meeting, {
        sourceId,
        agentReviewed: Boolean(opts.agentReviewed),
      });
      if (verificationErrors.length > 0) {
        result.failed++;
        result.meetings.push({
          path,
          slug: meeting.slug,
          title: meeting.title,
          externalSourceId: meeting.externalSourceId,
          status: 'blocked',
          verificationErrors,
        });
        continue;
      }

      if (!opts.dryRun) {
        const finalized = renderFinalizedMeeting(meeting, Boolean(opts.agentReviewed));
        writeFileSync(meeting.path, finalized);
        await ensureMeetingPage(engine, readMeetingFile(repoPath, meeting.path), { sourceId, dryRun: false });
      }
      result.completed++;
      result.meetings.push({
        path,
        slug: meeting.slug,
        title: meeting.title,
        externalSourceId: meeting.externalSourceId,
        status: 'complete',
        verificationErrors: [],
      });
    } catch (e) {
      result.failed++;
      result.meetings.push({
        path,
        slug: slugFromPath(repoPath, path),
        title: '(unknown meeting)',
        status: 'failed',
        verificationErrors: [e instanceof Error ? e.message : String(e)],
      });
    }
  }

  return result;
}

async function propagateMeeting(
  engine: BrainEngine,
  meeting: ParsedMeetingFile,
  opts: { repoPath: string; sourceId: string; dryRun: boolean },
): Promise<MeetingPropagationMeetingResult> {
  const attendees = filterAttendees(readAttendees(meeting.frontmatter));
  const actionItems = readActionItems(meeting.body);
  const pagesCreated = { count: 0 };
  const targetMap = new Map<string, TargetEntity>();
  const attendeeResults: MeetingPropagationMeetingResult['attendees'] = [];

  await ensureMeetingPage(engine, meeting, opts);

  for (const attendee of attendees) {
    const person = await ensurePersonPage(engine, meeting, attendee, opts, pagesCreated);
    targetMap.set(person.slug, person);
    attendeeResults.push({ name: person.title, slug: person.slug, created: Boolean(person.created) });
  }

  const mentionedEntities = await findMentionedExistingEntities(engine, meeting, opts.sourceId);
  for (const entity of mentionedEntities) {
    if (entity.slug === meeting.slug) continue;
    if (targetMap.has(entity.slug)) continue;
    if (!opts.dryRun) {
      await upsertPageTimelineFile(opts.repoPath, opts.sourceId, entity.slug, {
        type: entity.type,
        title: entity.title,
        compiledTruth: `${entity.title} was discussed in [${meeting.title}](${meeting.slug}).`,
        timelineLine: timelineMarkdownLine(meeting, `Discussed in [${meeting.title}](${meeting.slug})`),
      });
      const updated = readPageMarkdown(opts.repoPath, opts.sourceId, entity.slug);
      const parsed = parseMarkdown(updated, entity.slug);
      await engine.putPage(entity.slug, {
        type: parsed.type || entity.type,
        title: parsed.title || entity.title,
        compiled_truth: parsed.compiled_truth,
        timeline: parsed.timeline,
        frontmatter: parsed.frontmatter,
      }, { sourceId: opts.sourceId });
    }
    targetMap.set(entity.slug, { ...entity, kind: 'entity' });
  }

  const trackedActions = actionItems.length > 0
    ? await ensureActionItemsPage(engine, meeting, actionItems, attendees, opts, pagesCreated)
    : [];
  for (const action of trackedActions) {
    targetMap.set(action.slug, { slug: action.slug, title: `${meeting.title} Action Items`, type: 'task', kind: 'action', created: action.created });
  }

  const targets = Array.from(targetMap.values());
  const skipReasons = buildSkipReasons(meeting, targets, actionItems);
  const links = buildPropagationLinks(meeting, targets, opts.sourceId);
  const timelines = buildTimelineEntries(meeting, targets, opts.sourceId);

  let linksCreated = links.length;
  let timelineEntriesCreated = timelines.length;
  if (!opts.dryRun) {
    linksCreated = links.length > 0 ? await engine.addLinksBatch(links, { auditSite: 'addLinksBatch' }) : 0;
    timelineEntriesCreated = timelines.length > 0 ? await engine.addTimelineEntriesBatch(timelines, { auditSite: 'addTimelineEntriesBatch' }) : 0;
  }

  const verificationErrors = opts.dryRun
    ? []
    : await verifyPropagation(engine, meeting, targets, opts.sourceId);
  const complete = false;

  if (!opts.dryRun) {
    const updated = renderPropagatedMeeting(meeting, {
      complete,
      attendees: attendeeResults,
      entities: targets.filter(t => t.kind === 'entity'),
      actionItems: trackedActions,
      skipReasons,
    });
    writeFileSync(meeting.path, updated);
    await ensureMeetingPage(engine, readMeetingFile(opts.repoPath, meeting.path), opts);
  }

  return {
    path: meeting.path,
    slug: meeting.slug,
    title: meeting.title,
    externalSourceId: meeting.externalSourceId,
    status: verificationErrors.length > 0 ? 'failed' : 'pending',
    attendees: attendeeResults,
    entities: targets.filter(t => t.kind === 'entity').map(t => ({ title: t.title, slug: t.slug, type: t.type })),
    actionItems: trackedActions.map(a => ({ text: a.text, owner: a.owner, slug: a.slug })),
    pagesCreated: pagesCreated.count,
    linksCreated,
    timelineEntriesCreated,
    verificationErrors,
    skipReasons,
  };
}

function selectPendingMeetings(repoPath: string, filters: string[] | undefined, limit: number | undefined): string[] {
  const normalizedFilters = (filters ?? []).map(f => f.trim()).filter(Boolean);
  const pending = listPendingMeetings(repoPath)
    .filter(p => {
      if (normalizedFilters.length === 0) return true;
      const rel = relative(repoPath, p.path);
      return normalizedFilters.some(f => f === p.sourceId || f === p.path || f === rel || f === rel.replace(/\.md$/i, ''));
    })
    .map(p => p.path);
  return typeof limit === 'number' ? pending.slice(0, limit) : pending;
}

function readMeetingFile(repoPath: string, path: string): ParsedMeetingFile {
  const abs = resolve(path);
  const content = readFileSync(abs, 'utf8');
  const parsed = matter(content);
  const split = splitTranscriptBlock(parsed.content);
  const relPath = relative(resolve(repoPath), abs);
  const slug = slugFromPath(repoPath, abs);
  const frontmatter = parsed.data as Record<string, unknown>;
  return {
    path: abs,
    slug,
    title: scalar(frontmatter.title) || titleFromSlug(slug),
    date: scalar(frontmatter.date) || dateFromSlug(slug) || new Date().toISOString().slice(0, 10),
    externalSourceId: scalar(frontmatter.source_id),
    frontmatter,
    body: split.body,
    transcriptBlock: split.transcriptBlock,
    content,
  };
}

function splitTranscriptBlock(body: string): { body: string; transcriptBlock: string } {
  const match = body.match(/\n---\n\n## Transcript\b[\s\S]*$/);
  if (!match || match.index == null) return { body, transcriptBlock: '' };
  return {
    body: body.slice(0, match.index),
    transcriptBlock: body.slice(match.index),
  };
}

async function ensureMeetingPage(
  engine: BrainEngine,
  meeting: ParsedMeetingFile,
  opts: { sourceId: string; dryRun: boolean },
): Promise<void> {
  if (opts.dryRun) return;
  const parsed = parseMarkdown(meeting.content, meeting.path);
  await engine.putPage(meeting.slug, {
    type: 'meeting',
    title: meeting.title,
    compiled_truth: parsed.compiled_truth,
    timeline: parsed.timeline,
    frontmatter: {
      ...parsed.frontmatter,
      source_id: meeting.externalSourceId,
    },
  }, { sourceId: opts.sourceId });
}

async function ensurePersonPage(
  engine: BrainEngine,
  meeting: ParsedMeetingFile,
  attendee: MeetingAttendee,
  opts: { repoPath: string; sourceId: string; dryRun: boolean },
  pagesCreated: { count: number },
): Promise<TargetEntity> {
  const name = attendee.name || 'Unknown';
  const existing = await resolvePerson(engine, name, attendee.email, opts.sourceId);
  const slug = existing?.slug ?? `people/${slugifyPath(name)}`;
  const created = !existing;
  const timelineLine = timelineMarkdownLine(meeting, `Attended [${meeting.title}](${meeting.slug})`);

  if (!opts.dryRun) {
    if (created) pagesCreated.count++;
    await upsertPageTimelineFile(opts.repoPath, opts.sourceId, slug, {
      type: 'person',
      title: name,
      compiledTruth: personCompiledTruth(meeting, name),
      frontmatter: attendee.email ? { email: attendee.email } : {},
      timelineLine,
    });
    const updated = readPageMarkdown(opts.repoPath, opts.sourceId, slug);
    const parsed = parseMarkdown(updated, slug);
    await engine.putPage(slug, {
      type: parsed.type || 'person',
      title: parsed.title || name,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: parsed.frontmatter,
    }, { sourceId: opts.sourceId });
  }

  return { slug, title: name, type: 'person', kind: 'attendee', created };
}

async function resolvePerson(
  engine: BrainEngine,
  name: string,
  email: string | undefined,
  sourceId: string,
): Promise<{ slug: string } | null> {
  if (email) {
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages
       WHERE type = 'person'
         AND source_id = $1
         AND deleted_at IS NULL
         AND (
           frontmatter->>'email' = $2
           OR frontmatter->>'emails' LIKE $3
           OR compiled_truth ILIKE $3
         )
       ORDER BY slug
       LIMIT 1`,
      [sourceId, email, `%${email}%`],
    );
    if (rows[0]) return { slug: rows[0].slug };
  }

  const exact = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages
     WHERE type = 'person'
       AND source_id = $1
       AND deleted_at IS NULL
       AND lower(title) = lower($2)
     ORDER BY slug
     LIMIT 1`,
    [sourceId, name],
  );
  if (exact[0]) return { slug: exact[0].slug };

  return null;
}

async function findMentionedExistingEntities(
  engine: BrainEngine,
  meeting: ParsedMeetingFile,
  sourceId: string,
): Promise<Array<{ slug: string; title: string; type: string }>> {
  const rows = await engine.executeRaw<{ slug: string; source_id: string; title: string; type: string }>(
    `SELECT slug, source_id, title, type
     FROM pages
     WHERE source_id = $1
       AND deleted_at IS NULL
       AND type = ANY($2::text[])`,
    [sourceId, ENTITY_TYPES],
  );
  const transcript = meeting.transcriptBlock || meeting.body;
  const out: Array<{ slug: string; title: string; type: string }> = [];
  for (const row of rows) {
    if (!row.title || row.slug === meeting.slug) continue;
    if (mentionsTitle(transcript, row.title)) out.push({ slug: row.slug, title: row.title, type: row.type });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

function mentionsTitle(text: string, title: string): boolean {
  const tokens = title.match(/[a-zA-Z0-9]+/g) ?? [];
  if (tokens.length === 0) return false;
  if (tokens.length === 1 && tokens[0].length < 4) return false;
  const pattern = tokens.map(escapeRegExp).join('[^a-zA-Z0-9]+');
  return new RegExp(`\\b${pattern}\\b`, 'i').test(text);
}

async function ensureActionItemsPage(
  engine: BrainEngine,
  meeting: ParsedMeetingFile,
  items: string[],
  attendees: MeetingAttendee[],
  opts: { repoPath: string; sourceId: string; dryRun: boolean },
  pagesCreated: { count: number },
): Promise<Array<{ text: string; owner?: string; slug: string; created: boolean }>> {
  const slug = `tasks/${meeting.slug.split('/').pop()}-action-items`;
  const ownerMap = new Map(attendees.map(a => [(a.name ?? '').toLowerCase(), a.name ?? '']));
  const tracked = items.map((text, index) => ({
    text,
    owner: ownerForAction(text, ownerMap),
    slug,
    created: index === 0 && !existsSync(resolvePageFilePath(opts.repoPath, slug, opts.sourceId)),
  }));

  if (!opts.dryRun) {
    if (tracked[0]?.created) pagesCreated.count++;
    const bullets = tracked.map(a => `- [ ] ${a.owner ? `**${a.owner}:** ` : ''}${stripOwnerPrefix(a.text)} ([meeting](${meeting.slug}))`).join('\n');
    const timelineLine = timelineMarkdownLine(meeting, `Action items captured from [${meeting.title}](${meeting.slug})`);
    await upsertPageTimelineFile(opts.repoPath, opts.sourceId, slug, {
      type: 'task',
      title: `${meeting.title} Action Items`,
      compiledTruth: `Action items captured from [${meeting.title}](${meeting.slug}).\n\n${bullets}`,
      frontmatter: { meeting: meeting.slug, source_id: meeting.externalSourceId },
      timelineLine,
    });
    const updated = readPageMarkdown(opts.repoPath, opts.sourceId, slug);
    const parsed = parseMarkdown(updated, slug);
    await engine.putPage(slug, {
      type: parsed.type || 'task',
      title: parsed.title || `${meeting.title} Action Items`,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: parsed.frontmatter,
    }, { sourceId: opts.sourceId });
  }

  return tracked;
}

async function upsertPageTimelineFile(
  repoPath: string,
  sourceId: string,
  slug: string,
  page: { type: string; title: string; compiledTruth: string; frontmatter?: Record<string, unknown>; timelineLine: string },
): Promise<void> {
  const path = resolvePageFilePath(repoPath, slug, sourceId);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    const content = matter.stringify(
      `${page.compiledTruth}${timelineSeparator()}${page.timelineLine}\n`,
      { type: page.type, title: page.title, ...(page.frontmatter ?? {}) },
    );
    writeFileSync(path, content);
    return;
  }

  const current = readFileSync(path, 'utf8');
  if (current.includes(page.timelineLine)) return;
  writeFileSync(path, appendTimelineLine(current, page.timelineLine));
}

function timelineSeparator(): string {
  return '\n\n---\n\n## Timeline\n\n';
}

function appendTimelineLine(current: string, timelineLine: string): string {
  const trimmed = current.trimEnd();
  const normalized = trimmed
    .replace(/\n+<!--\s*timeline\s*-->\s*/i, timelineSeparator())
    .replace(/\n+---\s+timeline\s+---\s*/i, timelineSeparator());
  if (/\n---\s*\n\s*##\s+Timeline\b/i.test(normalized)) {
    return `${normalized}\n${timelineLine}\n`;
  }
  return `${normalized}${timelineSeparator()}${timelineLine}\n`;
}

function buildPropagationLinks(meeting: ParsedMeetingFile, targets: TargetEntity[], sourceId: string): LinkBatchInput[] {
  const links: LinkBatchInput[] = [];
  for (const target of targets) {
    const linkType = target.kind === 'attendee' ? 'attended' : target.kind === 'action' ? 'action_item' : 'discussed';
    const context = `${meeting.title} (${meeting.date})`;
    links.push({
      from_slug: meeting.slug,
      to_slug: target.slug,
      link_type: linkType,
      context,
      link_source: 'manual',
      from_source_id: sourceId,
      to_source_id: sourceId,
    });
    links.push({
      from_slug: target.slug,
      to_slug: meeting.slug,
      link_type: linkType,
      context,
      link_source: 'manual',
      from_source_id: sourceId,
      to_source_id: sourceId,
    });
  }
  return links;
}

function buildTimelineEntries(meeting: ParsedMeetingFile, targets: TargetEntity[], sourceId: string): TimelineBatchInput[] {
  return targets.map(target => ({
    slug: target.slug,
    source_id: sourceId,
    date: meeting.date,
    source: `meeting-sync:${meeting.slug}`,
    summary: target.kind === 'attendee'
      ? `Attended ${meeting.title}`
      : target.kind === 'action'
        ? `Action items captured from ${meeting.title}`
        : `Discussed in ${meeting.title}`,
    detail: `Meeting: ${meeting.slug}`,
  }));
}

async function verifyPropagation(
  engine: BrainEngine,
  meeting: ParsedMeetingFile,
  targets: TargetEntity[],
  sourceId: string,
): Promise<string[]> {
  const errors: string[] = [];
  const meetingPage = await engine.getPage(meeting.slug, { sourceId });
  if (!meetingPage) errors.push(`meeting page ${meeting.slug} is missing from source ${sourceId}`);

  const meetingLinks = await engine.getLinks(meeting.slug, { sourceId });
  for (const target of targets) {
    const page = await engine.getPage(target.slug, { sourceId });
    if (!page) {
      errors.push(`target page ${target.slug} is missing`);
      continue;
    }
    if (!meetingLinks.some(l => l.to_slug === target.slug)) {
      errors.push(`missing link ${meeting.slug} -> ${target.slug}`);
    }
    const backlinks = await engine.getLinks(target.slug, { sourceId });
    if (!backlinks.some(l => l.to_slug === meeting.slug)) {
      errors.push(`missing link ${target.slug} -> ${meeting.slug}`);
    }
    const timeline = await engine.getTimeline(target.slug, { sourceId });
    if (!timeline.some(t => t.source === `meeting-sync:${meeting.slug}`)) {
      errors.push(`missing timeline entry on ${target.slug}`);
    }
  }
  return errors;
}

function renderPropagatedMeeting(
  meeting: ParsedMeetingFile,
  data: {
    complete: boolean;
    attendees: MeetingPropagationMeetingResult['attendees'];
    entities: TargetEntity[];
    actionItems: Array<{ text: string; owner?: string; slug: string }>;
    skipReasons: string[];
  },
): string {
  const bodyWithoutPropagation = meeting.body.replace(/\n*## Propagation\n[\s\S]*$/m, '').trimEnd();
  const propagation = [
    '## Propagation',
    '',
    '### Attendees',
    data.attendees.length > 0
      ? data.attendees.map(a => `- [${a.name}](${a.slug})${a.created ? ' (created)' : ''}`).join('\n')
      : 'None',
    '',
    '### Mentioned Entities',
    data.entities.length > 0
      ? data.entities.map(e => `- [${e.title}](${e.slug}) (${e.type})`).join('\n')
      : 'None',
    '',
    '### Action Items',
    data.actionItems.length > 0
      ? data.actionItems.map(a => `- ${a.owner ? `**${a.owner}:** ` : ''}${stripOwnerPrefix(a.text)} ([tracked](${a.slug}))`).join('\n')
      : 'None',
    '',
    '### Skip Reasons',
    data.skipReasons.length > 0 ? data.skipReasons.map(s => `- ${s}`).join('\n') : 'None',
  ].join('\n');
  const frontmatter = {
    ...meeting.frontmatter,
    ingestion_status: data.complete ? 'complete' : 'pending_propagation',
    propagation_status: data.complete ? 'complete' : 'deterministic_propagated_pending_agent_review',
    propagated_at: new Date().toISOString(),
  };
  const aboveTranscript = `${bodyWithoutPropagation}\n\n${propagation}\n`;
  return matter.stringify(aboveTranscript, frontmatter).trimEnd() + meeting.transcriptBlock + (meeting.transcriptBlock.endsWith('\n') ? '' : '\n');
}

async function verifyMeetingComplete(
  engine: BrainEngine,
  meeting: ParsedMeetingFile,
  opts: { sourceId: string; agentReviewed: boolean },
): Promise<string[]> {
  const errors: string[] = [];
  const propagation = parsePropagation(meeting.body);
  const attendees = filterAttendees(readAttendees(meeting.frontmatter));
  const actionItems = readActionItems(meeting.body);

  if (!opts.agentReviewed) {
    errors.push('missing --agent-reviewed; guidelines require explicit agent review before completion');
  }
  if (!meeting.transcriptBlock.trim()) {
    errors.push('missing transcript block');
  }
  if (!propagation.found) {
    errors.push('missing ## Propagation section');
  }
  for (const reason of propagation.skipReasons) {
    // This marker is deliberately written by deterministic propagation and
    // must be removed by an agent before --verify-complete can finalize.
    if (/needs agent review|deterministic propagation does not mark meetings complete/i.test(reason)) {
      errors.push(`unresolved propagation review marker: ${reason}`);
    }
  }

  const targetMap = new Map<string, { slug: string; label: string; kind: 'attendee' | 'entity' | 'action' }>();
  for (const target of propagation.attendees) {
    targetMap.set(target.slug, { ...target, kind: 'attendee' });
  }
  for (const target of propagation.entities) {
    targetMap.set(target.slug, { ...target, kind: 'entity' });
  }
  for (const target of propagation.actionTargets) {
    targetMap.set(target.slug, { ...target, kind: 'action' });
  }

  if (attendees.length > 0 && propagation.attendees.length < attendees.length) {
    errors.push(`attendee propagation incomplete: expected ${attendees.length}, found ${propagation.attendees.length}`);
  }
  if (actionItems.length > 0 && propagation.actionTargets.length === 0) {
    errors.push('action items are present but no tracked action-item page is linked');
  }

  const meetingPage = await engine.getPage(meeting.slug, { sourceId: opts.sourceId });
  if (!meetingPage) errors.push(`meeting page ${meeting.slug} is missing from source ${opts.sourceId}`);

  const graphErrors = await verifyPropagationTargets(engine, meeting, Array.from(targetMap.values()), opts.sourceId);
  errors.push(...graphErrors);

  const searchResults = await engine.searchKeyword(meeting.title, { limit: 3, sourceId: opts.sourceId });
  if (!searchResults.some(r => r.slug === meeting.slug)) {
    errors.push(`searchability check failed: top 3 keyword results for "${meeting.title}" did not include ${meeting.slug}`);
  }

  return errors;
}

async function verifyPropagationTargets(
  engine: BrainEngine,
  meeting: ParsedMeetingFile,
  targets: Array<{ slug: string; label: string; kind: 'attendee' | 'entity' | 'action' }>,
  sourceId: string,
): Promise<string[]> {
  const errors: string[] = [];
  const meetingLinks = await engine.getLinks(meeting.slug, { sourceId });
  for (const target of targets) {
    const page = await engine.getPage(target.slug, { sourceId });
    if (!page) {
      errors.push(`${target.kind} target page ${target.slug} is missing`);
      continue;
    }
    if (!meetingLinks.some(l => l.to_slug === target.slug)) {
      errors.push(`missing link ${meeting.slug} -> ${target.slug}`);
    }
    const backLinks = await engine.getLinks(target.slug, { sourceId });
    if (!backLinks.some(l => l.to_slug === meeting.slug)) {
      errors.push(`missing link ${target.slug} -> ${meeting.slug}`);
    }
    const timeline = await engine.getTimeline(target.slug, { sourceId });
    if (!timeline.some(t => t.source === `meeting-sync:${meeting.slug}`)) {
      errors.push(`missing timeline entry on ${target.slug}`);
    }
  }
  return errors;
}

interface ParsedPropagationSection {
  found: boolean;
  attendees: Array<{ label: string; slug: string }>;
  entities: Array<{ label: string; slug: string }>;
  actionTargets: Array<{ label: string; slug: string }>;
  skipReasons: string[];
}

function parsePropagation(body: string): ParsedPropagationSection {
  const block = body.match(/\n## Propagation\s*\n([\s\S]*)$/)?.[1] ?? '';
  const section: ParsedPropagationSection = {
    found: Boolean(block),
    attendees: [],
    entities: [],
    actionTargets: [],
    skipReasons: [],
  };
  if (!block) return section;

  const attendeesText = subsection(block, 'Attendees');
  const entitiesText = subsection(block, 'Mentioned Entities');
  const actionsText = subsection(block, 'Action Items');
  const skipsText = subsection(block, 'Skip Reasons');
  section.attendees = extractMarkdownLinks(attendeesText);
  section.entities = extractMarkdownLinks(entitiesText);
  section.actionTargets = extractMarkdownLinks(actionsText).filter(l => l.label.toLowerCase() === 'tracked' || l.slug.startsWith('tasks/'));
  section.skipReasons = skipsText
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[-*]\s+/.test(line))
    .map(line => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);
  return section;
}

function subsection(block: string, heading: string): string {
  const escaped = escapeRegExp(heading);
  return block.match(new RegExp(`###\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n###\\s+|$)`))?.[1] ?? '';
}

function extractMarkdownLinks(text: string): Array<{ label: string; slug: string }> {
  const out: Array<{ label: string; slug: string }> = [];
  for (const match of text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const label = match[1]?.trim() ?? '';
    const slug = match[2]?.trim() ?? '';
    if (label && slug && !/^https?:\/\//i.test(slug)) out.push({ label, slug });
  }
  return out;
}

function renderFinalizedMeeting(meeting: ParsedMeetingFile, agentReviewed: boolean): string {
  const parsed = matter(meeting.content);
  const body = parsed.content;
  const frontmatter = {
    ...(parsed.data as Record<string, unknown>),
    ingestion_status: 'complete',
    propagation_status: 'complete',
    ...(agentReviewed ? { propagation_reviewed_at: new Date().toISOString() } : {}),
    propagation_verified_at: new Date().toISOString(),
  };
  return matter.stringify(body, frontmatter).trimEnd() + '\n';
}

function readAttendees(frontmatter: Record<string, unknown>): MeetingAttendee[] {
  const raw = frontmatter.attendees;
  if (!Array.isArray(raw)) return [];
  return raw.map((a) => {
    if (typeof a === 'string') return { name: a };
    if (a && typeof a === 'object') {
      const row = a as Record<string, unknown>;
      return { name: scalar(row.name), email: scalar(row.email) };
    }
    return {};
  });
}

function readActionItems(body: string): string[] {
  const match = body.match(/## Action Items\s*\n([\s\S]*?)(?=\n## |\n*$)/);
  if (!match) return [];
  return match[1]
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[-*]\s+/.test(line))
    .map(line => line.replace(/^[-*]\s+(?:\[[ xX]\]\s*)?/, '').trim())
    .filter(line => line && line.toLowerCase() !== 'none');
}

function buildSkipReasons(meeting: ParsedMeetingFile, targets: TargetEntity[], actionItems: string[]): string[] {
  const reasons: string[] = [];
  if (!meeting.transcriptBlock.trim()) {
    reasons.push('No transcript block found below the meeting separator; entity detection used above-separator notes only.');
  }
  if (!targets.some(t => t.kind === 'entity')) {
    reasons.push('No additional existing people/company/project/topic pages were mentioned in the full transcript.');
  }
  for (const candidate of candidateEntityMentions(meeting, targets)) {
    reasons.push(`Candidate entity "${candidate}" needs agent review before completion; deterministic propagation does not create unverified entity pages.`);
  }
  if (actionItems.length === 0) {
    reasons.push('No action items were present in the meeting page.');
  }
  reasons.push('Deterministic propagation does not mark meetings complete; an agent must verify exhaustive entity propagation and searchability first.');
  return reasons;
}

function personCompiledTruth(meeting: ParsedMeetingFile, name: string): string {
  const evidence = transcriptEvidenceForName(meeting, name);
  return [
    `## Meeting Context`,
    `- Attended [${meeting.title}](${meeting.slug}) on ${meeting.date}.`,
    ...(evidence.length > 0 ? [`- Transcript-grounded notes:`, ...evidence.map(line => `  - ${line}`)] : []),
  ].join('\n');
}

function transcriptEvidenceForName(meeting: ParsedMeetingFile, name: string): string[] {
  const first = name.split(/\s+/)[0]?.toLowerCase();
  if (!first) return [];
  const lines = meeting.transcriptBlock
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const evidence: string[] = [];
  for (const line of lines) {
    const speaker = line.match(/^\*\*([^*]+)\*\*/)?.[1]?.toLowerCase();
    if (speaker?.includes(first) || line.toLowerCase().includes(first)) {
      evidence.push(line.replace(/\s+/g, ' ').slice(0, 240));
      if (evidence.length >= 3) break;
    }
  }
  return evidence;
}

function candidateEntityMentions(meeting: ParsedMeetingFile, targets: TargetEntity[]): string[] {
  const known = new Set<string>([
    meeting.title.toLowerCase(),
    ...targets.map(t => t.title.toLowerCase()),
  ]);
  const ignored = new Set([
    'None', 'Summary', 'Key Decisions', 'Action Items', 'Discussion Notes', 'Key Points',
    'Attendees', 'Transcript', 'Source', 'Google Meet', 'Zoom',
  ].map(s => s.toLowerCase()));
  const out = new Set<string>();
  const text = meeting.transcriptBlock.replace(/\*\*([^*]+)\*\*/g, ' $1 ');
  const candidatePattern = /\b(?:[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}|[A-Z]{3,}(?:\s+[A-Z]{3,}){0,2})\b/g;
  for (const match of text.matchAll(candidatePattern)) {
    const candidate = match[0].trim();
    const lower = candidate.toLowerCase();
    if (candidate.length < 4 || known.has(lower) || ignored.has(lower)) continue;
    if (/^(The|This|That|There|Then|When|Where|What|And|But)\b/.test(candidate)) continue;
    out.add(candidate);
    if (out.size >= 12) break;
  }
  return Array.from(out).sort((a, b) => a.localeCompare(b));
}

function ownerForAction(text: string, ownerMap: Map<string, string>): string | undefined {
  const prefix = text.match(/^([^:—-]{2,80})\s*[:—-]\s+/)?.[1]?.trim();
  if (!prefix) return undefined;
  const direct = ownerMap.get(prefix.toLowerCase());
  if (direct) return direct;
  for (const [key, name] of ownerMap) {
    if (key && prefix.toLowerCase().includes(key)) return name;
  }
  return prefix;
}

function stripOwnerPrefix(text: string): string {
  return text.replace(/^([^:—-]{2,80})\s*[:—-]\s+/, '').trim();
}

function timelineMarkdownLine(meeting: ParsedMeetingFile, text: string): string {
  return `- **${meeting.date}** | ${text} [Source: ${meeting.slug}]`;
}

function readPageMarkdown(repoPath: string, sourceId: string, slug: string): string {
  return readFileSync(resolvePageFilePath(repoPath, slug, sourceId), 'utf8');
}

function slugFromPath(repoPath: string, path: string): string {
  return relative(resolve(repoPath), resolve(path)).replace(/\.md$/i, '').split('/').join('/');
}

function titleFromSlug(slug: string): string {
  const last = slug.split('/').pop() || slug;
  return last.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function dateFromSlug(slug: string): string | undefined {
  return slug.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
}

function scalar(value: unknown): string | undefined {
  if (value == null) return undefined;
  const s = String(value).trim();
  return s || undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
