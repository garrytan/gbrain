import type { BrainEngine, TimelineBatchInput } from '../engine.ts';

const STATE_HEADING = /^(#{2})[ \t]+(?:State|当前状态)(?:[ \t]*[（(][^）)]*[）)])?[ \t]*$/i;
const SECTION_END = /^(#{1,2})[ \t]/;
const ENTITY_TYPES = new Set(['person', 'company', 'organization', 'project', 'concept', 'entity']);

export function collapseStateSections(markdown: string): string {
  const lines = markdown.split('\n');
  const heads: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (STATE_HEADING.test(lines[i] ?? '')) heads.push(i);
  }
  if (heads.length < 2) return markdown;
  const drop = new Set<number>();
  for (const start of heads.slice(0, -1)) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (SECTION_END.test(lines[i] ?? '')) {
        end = i;
        break;
      }
    }
    for (let i = start; i < end; i++) drop.add(i);
  }
  return lines.filter((_, index) => !drop.has(index)).join('\n');
}

function calendarDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2199 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function sentenceDate(sentence: string): string | null {
  const iso = sentence.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (iso) return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const zh = sentence.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (zh) return calendarDate(Number(zh[1]), Number(zh[2]), Number(zh[3]));
  return null;
}

export interface TimelineFact {
  slug: string;
  date: string;
  summary: string;
  source: string;
}

export function timelineFactsFromSources(
  sources: Array<{ slug: string; body: string }>,
  entities: Array<{ slug: string; title: string }>,
): TimelineFact[] {
  const titles = entities.filter(entity => entity.title.trim().length >= 2);
  const facts: TimelineFact[] = [];
  for (const source of sources) {
    for (const raw of source.body.split(/[。！？\n]+/)) {
      const sentence = raw.trim();
      if (!sentence) continue;
      const date = sentenceDate(sentence);
      if (!date) continue;
      const mentioned = titles.filter(entity => sentence.includes(entity.title.trim()));
      if (mentioned.length < 2) continue;
      const summary = sentence.length > 240 ? sentence.slice(0, 240) : sentence;
      for (const entity of mentioned) {
        facts.push({ slug: entity.slug, date, summary, source: source.slug });
      }
    }
  }
  return facts;
}

export function timelineCopies(
  entries: TimelineFact[],
  entities: Array<{ slug: string; title: string }>,
): TimelineFact[] {
  const titles = entities.filter(entity => entity.title.trim().length >= 2);
  const copies: TimelineFact[] = [];
  for (const entry of entries) {
    for (const entity of titles) {
      if (entity.slug === entry.slug) continue;
      if (!entry.summary.includes(entity.title.trim())) continue;
      copies.push({
        slug: entity.slug,
        date: entry.date,
        summary: entry.summary,
        source: entry.source,
      });
    }
  }
  return copies;
}

function dated(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }
  const match = String(value ?? '').match(/(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? '';
}

function dedupeFacts(facts: TimelineFact[]): TimelineFact[] {
  const seen = new Set<string>();
  const rows: TimelineFact[] = [];
  for (const fact of facts) {
    if (!fact.date || !fact.summary || !fact.slug) continue;
    const key = `${fact.slug}\0${fact.date}\0${fact.summary}\0${fact.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(fact);
  }
  return rows;
}

export async function alignCapturedEntityGraph(
  engine: BrainEngine,
  input: {
    sourceId?: string;
    entitySlugs: string[];
    sources: Array<{ slug: string; body: string }>;
  },
): Promise<{ statesRewritten: number; timelineAdded: number }> {
  const slugs = [...new Set(input.entitySlugs.map(slug => slug.trim()).filter(Boolean))];
  if (slugs.length === 0) return { statesRewritten: 0, timelineAdded: 0 };
  const pages = [];
  for (const slug of slugs) {
    const scoped = input.sourceId ? await engine.getPage(slug, { sourceId: input.sourceId }) : null;
    const page = scoped ?? (input.sourceId ? await engine.getPage(slug, { sourceId: 'default' }) : await engine.getPage(slug));
    if (!page || !ENTITY_TYPES.has(page.type)) continue;
    pages.push(page);
  }
  if (pages.length === 0) return { statesRewritten: 0, timelineAdded: 0 };

  let statesRewritten = 0;
  for (const page of pages) {
    const next = collapseStateSections(page.compiled_truth ?? '');
    if (next === page.compiled_truth) continue;
    await engine.putPage(page.slug, {
      type: page.type,
      title: page.title,
      compiled_truth: next,
      timeline: page.timeline ?? '',
      frontmatter: page.frontmatter ?? {},
    }, { sourceId: page.source_id || input.sourceId });
    page.compiled_truth = next;
    statesRewritten += 1;
  }

  const entities = pages.map(page => ({
    slug: page.slug,
    title: page.title?.trim() || '',
    sourceId: page.source_id || input.sourceId || 'default',
  }));
  const existing: TimelineFact[] = [];
  for (const entity of entities) {
    const rows = await engine.getTimeline(entity.slug, { sourceId: entity.sourceId });
    for (const row of rows) {
      const date = dated(row.date);
      if (!date || !row.summary) continue;
      existing.push({ slug: entity.slug, date, summary: row.summary, source: row.source || '' });
    }
  }
  const facts = dedupeFacts([
    ...timelineFactsFromSources(input.sources, entities),
    ...timelineCopies(existing, entities),
    ...timelineCopies(timelineFactsFromSources(input.sources, entities), entities),
  ]);
  if (facts.length === 0) return { statesRewritten, timelineAdded: 0 };
  const batch: TimelineBatchInput[] = facts.map(fact => ({
    slug: fact.slug,
    date: fact.date,
    summary: fact.summary,
    source: fact.source,
    source_id: entities.find(entity => entity.slug === fact.slug)?.sourceId,
  }));
  const timelineAdded = await engine.addTimelineEntriesBatch(batch);
  return { statesRewritten, timelineAdded };
}
