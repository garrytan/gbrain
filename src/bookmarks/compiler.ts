import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serializeMarkdown } from '../core/markdown.ts';
import { slugifySegment } from '../core/sync.ts';

interface RawThreadEntry {
  id?: string;
  url?: string | null;
  inReplyToStatusId?: string | null;
  text?: string | null;
}

interface RawThreadResult {
  rootId?: string;
  thread?: RawThreadEntry[];
}

interface RawTweetResult {
  targetUrl: string;
  tweetId?: string;
  normalized?: {
    id?: string | null;
    createdAt?: string | null;
    text?: string | null;
    author?: {
      handle?: string | null;
      name?: string | null;
    };
    quotedTweetId?: string | null;
  };
}

interface RawDataset {
  source?: string;
  urls?: string[];
  results: RawTweetResult[];
}

export interface BookmarkDatasetMeta {
  id: string;
  title: string;
  description: string;
  sourceType?: string;
  sourcePath: string;
  threadPath: string;
}

export interface ThemeDefinition {
  name: string;
  description: string;
  matchers: string[];
}

export interface CompiledPage {
  path: string;
  content: string;
}

export interface CompileBookmarkOpts {
  dataset: BookmarkDatasetMeta;
  outputDir: string;
  generatedAt?: string;
  cleanOutput?: boolean;
  themeDefinitions?: ThemeDefinition[];
  titleOverrides?: Record<string, string>;
}

export interface CompileBookmarkResult {
  outputDir: string;
  pages: string[];
  pageCount: number;
  people: number;
  concepts: number;
  collections: number;
  bookmarks: number;
}

interface BookmarkNote {
  tweetId: string;
  targetUrl: string;
  title: string;
  summary: string;
  text: string;
  authorHandle: string;
  authorName: string;
  authorSlug: string;
  date: string;
  themes: string[];
  themeSlugs: string[];
  mentionedHandles: string[];
  mentionedSlugs: string[];
  thread: RawThreadEntry[];
}

interface PersonPageData {
  handle: string;
  title: string;
  authoredNotes: BookmarkNote[];
  mentionOnlyNotes: BookmarkNote[];
  conceptSlugs: Set<string>;
  collectionSlugs: Set<string>;
}

interface ConceptPageData {
  name: string;
  description: string;
  notes: BookmarkNote[];
  people: Set<string>;
  collections: Set<string>;
}

const X_TITLE_OVERRIDES: Record<string, string> = {
  '2039805659525644595': 'LLM Knowledge Bases',
  '2039819092035780633': 'Obsidian As Local Wiki',
  '2039831289533227446': 'Separate Personal And Agent Vaults',
  '2039826228224430323': 'The Self-Improving Wiki Loop',
  '2042286186920550498': 'PaperWiki Plugin',
  '2041798871383441807': 'Compiled Wiki As Persistent Memory',
  '2042226854271099342': 'Follow-Up Resource Link',
  '2040563939797504467': 'Farzapedia',
  '2040572272944324650': 'Explicit Personal Memory',
  '2040482771576197377': 'LLMs As Knowledge Engineers',
  '2040470801506541998': 'Idea Files Over App Demos',
  '2039844072748204246': 'Personal Knowledge Bases For Agents',
};

export const DEFAULT_THEME_DEFINITIONS: ThemeDefinition[] = [
  {
    name: 'LLM Wikis',
    description: 'Compiling raw material into durable markdown knowledge artifacts.',
    matchers: ['wiki', 'knowledge base', 'knowledge bases', 'encyclopedia'],
  },
  {
    name: 'Obsidian Workflow',
    description: 'Using Obsidian as the human-facing interface for agent-written research.',
    matchers: ['obsidian', 'vault', 'web clipper', 'backlinks'],
  },
  {
    name: 'Research Loop',
    description: 'Ingest, synthesis, Q&A, and feeding outputs back into the corpus.',
    matchers: ['research', 'papers', 'sources', 'questions', 'loop', 'compile'],
  },
  {
    name: 'Explicit Memory',
    description: 'Personal wikipedia, explicit memory artifacts, and navigable memory.',
    matchers: ['memory', 'personal wikipedia', 'diary', 'notes', 'personal'],
  },
  {
    name: 'Productization',
    description: 'Plugins, skills, products, checkpoints, and reusable tooling.',
    matchers: ['plugin', 'product', 'skill', 'checkpoint', 'release', 'guides'],
  },
];

const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
const stripUrls = (value: string) =>
  value.replace(/https?:\/\/\S+/g, '').replace(/t\.co\/\S+/g, '');
const cleanText = (value: string) => compact(stripUrls(value ?? ''));

function excerptFromText(value: string, maxLength = 180): string {
  const cleaned = cleanText(value);
  if (!cleaned) return '';
  if (cleaned.length <= maxLength) return cleaned;
  const sliced = cleaned.slice(0, maxLength);
  const boundary = sliced.lastIndexOf(' ');
  return `${(boundary > 0 ? sliced.slice(0, boundary) : sliced).trim()}...`;
}

function titleFromText(text: string, fallback: string): string {
  const firstLine = cleanText(
    (text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean) ?? '',
  );

  return sanitizeTitle(firstLine || fallback).slice(0, 56);
}

function sanitizeTitle(value: string): string {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeDate(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toISOString().slice(0, 10);
}

function slugifyHandle(handle: string): string {
  return (
    slugifySegment(handle)
      .replace(/_/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'unknown'
  );
}

function pagePathForPerson(handle: string): string {
  return path.join('people', `${slugifyHandle(handle)}.md`);
}

function pagePathForConcept(name: string): string {
  return path.join('concepts', `${slugifySegment(name)}.md`);
}

function pagePathForCollection(title: string, id: string): string {
  return path.join('collections', `${slugifySegment(title || id)}.md`);
}

function relativeMarkdownLink(fromPath: string, toPath: string, label: string): string {
  const relativeTarget = path.relative(path.dirname(fromPath), toPath).replace(/\\/g, '/');
  return `[${label}](${relativeTarget})`;
}

function quoteBlock(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function extractMentionHandles(text: string): string[] {
  const matches = text.match(/@([A-Za-z0-9_]{1,15})/g) ?? [];
  return [...new Set(matches.map((match) => match.slice(1)).filter(Boolean))];
}

function matchThemes(corpusText: string, themeDefinitions: ThemeDefinition[]): string[] {
  const scored = themeDefinitions
    .map((theme) => ({
      name: theme.name,
      score: theme.matchers.reduce(
        (count, matcher) => count + (corpusText.includes(matcher) ? 1 : 0),
        0,
      ),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

  return scored.map((entry) => entry.name);
}

function sortNotes(notes: BookmarkNote[]): BookmarkNote[] {
  return [...notes].sort((a, b) => {
    if (a.date === b.date) return a.title.localeCompare(b.title);
    return a.date.localeCompare(b.date);
  });
}

function renderThread(thread: RawThreadEntry[]): string[] {
  const blocks: string[] = [];
  if (thread.length === 0) return blocks;
  blocks.push('#### Same-Author Thread');
  thread.forEach((entry, index) => {
    const label = entry.url
      ? `[Source: X, ${entry.url}]`
      : '[Source: X thread continuation]';
    blocks.push(`Continuation ${index + 1}. ${label}`);
    if (entry.text?.trim()) {
      blocks.push(quoteBlock(entry.text));
    }
    blocks.push('');
  });
  return blocks;
}

function buildBookmarkNotes(
  dataset: RawDataset,
  threads: Map<string, RawThreadEntry[]>,
  generatedAt: string,
  themeDefinitions: ThemeDefinition[],
  titleOverrides: Record<string, string>,
): BookmarkNote[] {
  return dataset.results
    .map((entry) => {
      const text = entry.normalized?.text?.trim() ?? '';
      const authorHandle = entry.normalized?.author?.handle?.trim() ?? 'unknown';
      const authorName = entry.normalized?.author?.name?.trim() || authorHandle;
      const title =
        titleOverrides[entry.tweetId ?? ''] ??
        titleFromText(text, `${authorHandle} ${entry.tweetId ?? 'bookmark'}`);
      const thread = threads.get(entry.tweetId ?? '') ?? [];
      const corpusText = compact(
        [text, ...thread.map((item) => item.text ?? '')].join(' ').toLowerCase(),
      );
      const themes = matchThemes(corpusText, themeDefinitions);
      const mentionedHandles = extractMentionHandles(
        [text, ...thread.map((item) => item.text ?? '')].join('\n'),
      ).filter((handle) => handle.toLowerCase() !== authorHandle.toLowerCase());

      return {
        tweetId: entry.tweetId ?? entry.normalized?.id ?? title,
        targetUrl: entry.targetUrl,
        title,
        summary: excerptFromText(text || title, 220),
        text,
        authorHandle,
        authorName,
        authorSlug: pagePathForPerson(authorHandle).replace(/\.md$/, ''),
        date: safeDate(entry.normalized?.createdAt, generatedAt),
        themes,
        themeSlugs: themes.map((theme) => pagePathForConcept(theme).replace(/\.md$/, '')),
        mentionedHandles,
        mentionedSlugs: mentionedHandles.map((handle) =>
          pagePathForPerson(handle).replace(/\.md$/, ''),
        ),
        thread,
      } satisfies BookmarkNote;
    })
    .filter((note) => Boolean(note.targetUrl));
}

export function buildBookmarkPages(
  datasetMeta: BookmarkDatasetMeta,
  rawDataset: RawDataset,
  rawThreads: RawThreadResult[],
  opts: { generatedAt?: string; themeDefinitions?: ThemeDefinition[]; titleOverrides?: Record<string, string> } = {},
): CompiledPage[] {
  const generatedAt = opts.generatedAt ?? new Date().toISOString().slice(0, 10);
  const themeDefinitions = opts.themeDefinitions ?? DEFAULT_THEME_DEFINITIONS;
  const titleOverrides = { ...X_TITLE_OVERRIDES, ...(opts.titleOverrides ?? {}) };
  const collectionPath = pagePathForCollection(datasetMeta.title, datasetMeta.id);
  const collectionSlug = collectionPath.replace(/\.md$/, '');

  const threadsByRoot = new Map<string, RawThreadEntry[]>(
    rawThreads.map((entry) => [entry.rootId ?? '', entry.thread ?? []]),
  );
  const notes = buildBookmarkNotes(
    rawDataset,
    threadsByRoot,
    generatedAt,
    themeDefinitions,
    titleOverrides,
  );

  const people = new Map<string, PersonPageData>();
  const concepts = new Map<string, ConceptPageData>();

  const ensurePerson = (handle: string, title?: string) => {
    const personPath = pagePathForPerson(handle);
    const slug = personPath.replace(/\.md$/, '');
    if (!people.has(slug)) {
      people.set(slug, {
        handle,
        title: title || handle,
        authoredNotes: [],
        mentionOnlyNotes: [],
        conceptSlugs: new Set<string>(),
        collectionSlugs: new Set<string>([collectionSlug]),
      });
    }
    return people.get(slug)!;
  };

  const ensureConcept = (name: string, description: string) => {
    const conceptPath = pagePathForConcept(name);
    const slug = conceptPath.replace(/\.md$/, '');
    if (!concepts.has(slug)) {
      concepts.set(slug, {
        name,
        description,
        notes: [],
        people: new Set<string>(),
        collections: new Set<string>([collectionSlug]),
      });
    }
    return concepts.get(slug)!;
  };

  for (const note of notes) {
    const author = ensurePerson(note.authorHandle, note.authorName);
    author.authoredNotes.push(note);
    note.themeSlugs.forEach((slug) => author.conceptSlugs.add(slug));

    for (const handle of note.mentionedHandles) {
      const mentionPage = ensurePerson(handle, handle);
      mentionPage.mentionOnlyNotes.push(note);
    }

    note.themes.forEach((theme) => {
      const themeDef = themeDefinitions.find((entry) => entry.name === theme);
      const concept = ensureConcept(theme, themeDef?.description ?? theme);
      concept.notes.push(note);
      concept.people.add(note.authorSlug);
      note.mentionedSlugs.forEach((slug) => concept.people.add(slug));
    });
  }

  const collectionFrontmatter = {
    source_type: datasetMeta.sourceType ?? 'x',
    dataset_id: datasetMeta.id,
    generated_at: generatedAt,
    tags: ['x-bookmarks', 'bookmarks', 'collection'],
  };

  const collectionConceptLinks = [...concepts.entries()]
    .sort((a, b) => a[1].name.localeCompare(b[1].name))
    .map(([slug, concept]) =>
      `- ${relativeMarkdownLink(collectionPath, `${slug}.md`, concept.name)}: ${concept.description} [Source: compiled from X bookmarks, ${datasetMeta.id}, ${generatedAt}]`,
    );

  const collectionPeopleLinks = [...people.entries()]
    .sort((a, b) => a[1].title.localeCompare(b[1].title))
    .map(([slug, person]) =>
      `- ${relativeMarkdownLink(collectionPath, `${slug}.md`, person.title)} [Source: compiled from X bookmarks, ${datasetMeta.id}, ${generatedAt}]`,
    );

  const collectionBookmarks = sortNotes(notes).map((note) => {
    const primarySlug = note.themeSlugs[0] ?? note.authorSlug;
    const primaryPath = `${primarySlug}.md`;
    const primaryLabel =
      note.themeSlugs[0]
        ? note.themes[0]
        : people.get(note.authorSlug)?.title ?? note.authorName;
    return `- ${relativeMarkdownLink(collectionPath, primaryPath, note.title)} by ${relativeMarkdownLink(collectionPath, `${note.authorSlug}.md`, note.authorName)}. Filed under ${relativeMarkdownLink(collectionPath, primaryPath, primaryLabel)}. [Source: X, ${note.targetUrl}]`;
  });

  const collectionTimeline = [
    '## Timeline',
    '',
    ...sortNotes(notes).map(
      (note) =>
        `- **${note.date}** | X bookmark — ${relativeMarkdownLink(collectionPath, `${note.authorSlug}.md`, note.authorName)} saved "${note.title}". [Source: X, ${note.targetUrl}]`,
    ),
  ].join('\n');

  const pages: CompiledPage[] = [
    {
      path: collectionPath,
      content: serializeMarkdown(
        collectionFrontmatter,
        [
          `# ${datasetMeta.title}`,
          '',
          `${datasetMeta.description} [Source: compiled from X bookmarks, ${datasetMeta.id}, ${generatedAt}]`,
          '',
          '## Concepts',
          ...(collectionConceptLinks.length > 0
            ? collectionConceptLinks
            : [`- No concept pages were derived deterministically. [Source: compiled from X bookmarks, ${datasetMeta.id}, ${generatedAt}]`]),
          '',
          '## People',
          ...(collectionPeopleLinks.length > 0
            ? collectionPeopleLinks
            : [`- No person pages were derived deterministically. [Source: compiled from X bookmarks, ${datasetMeta.id}, ${generatedAt}]`]),
          '',
          '## Bookmarks',
          ...collectionBookmarks,
        ].join('\n'),
        collectionTimeline,
        { type: 'concept', title: datasetMeta.title, tags: collectionFrontmatter.tags },
      ),
    },
  ];

  for (const [slug, person] of [...people.entries()].sort((a, b) =>
    a[1].title.localeCompare(b[1].title),
  )) {
    const filePath = `${slug}.md`;
    const authored = sortNotes(person.authoredNotes);
    const referenced = sortNotes(
      person.mentionOnlyNotes.filter(
        (note) => !authored.some((authoredNote) => authoredNote.tweetId === note.tweetId),
      ),
    );
    const collectionLinks = [...person.collectionSlugs].map((collectionSlugRef) =>
      relativeMarkdownLink(filePath, `${collectionSlugRef}.md`, datasetMeta.title),
    );
    const conceptLinks = [...person.conceptSlugs]
      .sort()
      .map((conceptSlug) =>
        relativeMarkdownLink(
          filePath,
          `${conceptSlug}.md`,
          concepts.get(conceptSlug)?.name ?? conceptSlug.split('/').pop() ?? conceptSlug,
        ),
      );

    const compiledTruth = [
      `# ${person.title}`,
      '',
      `${person.title} appears in bookmarked X posts compiled into ${collectionLinks.join(', ')}. [Source: compiled from X bookmarks, ${datasetMeta.id}, ${generatedAt}]`,
      '',
      '## Identity',
      `- Handle: @${person.handle}. [Source: X, https://x.com/${person.handle}]`,
      ...(person.title !== person.handle
        ? [`- Display name: ${person.title}. [Source: X, https://x.com/${person.handle}]`]
        : []),
      ...(conceptLinks.length > 0
        ? [`- Related concepts: ${conceptLinks.join(', ')}. [Source: compiled from X bookmarks, ${datasetMeta.id}, ${generatedAt}]`]
        : []),
      '',
    ];

    if (authored.length > 0) {
      compiledTruth.push('## Authored Bookmarks', '');
      for (const note of authored) {
        const themeLinks = note.themeSlugs.map((conceptSlug) =>
          relativeMarkdownLink(
            filePath,
            `${conceptSlug}.md`,
            concepts.get(conceptSlug)?.name ?? conceptSlug,
          ),
        );
        const mentionLinks = note.mentionedSlugs.map((mentionedSlug) =>
          relativeMarkdownLink(
            filePath,
            `${mentionedSlug}.md`,
            people.get(mentionedSlug)?.title ?? mentionedSlug.split('/').pop() ?? mentionedSlug,
          ),
        );
        compiledTruth.push(`### ${note.title}`);
        compiledTruth.push(
          `Filed from ${relativeMarkdownLink(filePath, collectionPath, datasetMeta.title)}.${themeLinks.length > 0 ? ` Related concepts: ${themeLinks.join(', ')}.` : ''}${mentionLinks.length > 0 ? ` Mentions: ${mentionLinks.join(', ')}.` : ''} [Source: X, ${note.targetUrl}]`,
        );
        if (note.text.trim()) {
          compiledTruth.push('');
          compiledTruth.push(quoteBlock(note.text));
        }
        const threadBlocks = renderThread(note.thread);
        if (threadBlocks.length > 0) {
          compiledTruth.push('', ...threadBlocks);
        }
        compiledTruth.push('');
      }
    }

    if (referenced.length > 0) {
      compiledTruth.push('## Referenced In', '');
      for (const note of referenced) {
        const topicLink = note.themeSlugs[0]
          ? relativeMarkdownLink(
              filePath,
              `${note.themeSlugs[0]}.md`,
              concepts.get(note.themeSlugs[0])?.name ?? note.themes[0],
            )
          : relativeMarkdownLink(filePath, collectionPath, datasetMeta.title);
        compiledTruth.push(
          `- Mentioned from ${topicLink} via "${note.title}". [Source: X, ${note.targetUrl}]`,
        );
      }
      compiledTruth.push('');
    }

    const timelineEntries = [
      '## Timeline',
      '',
      ...authored.map(
        (note) =>
          `- **${note.date}** | X bookmark — Posted "${note.title}" in ${relativeMarkdownLink(filePath, collectionPath, datasetMeta.title)}. [Source: X, ${note.targetUrl}]`,
      ),
    ];

    pages.push({
      path: filePath,
      content: serializeMarkdown(
        {
          source_type: datasetMeta.sourceType ?? 'x',
          x_handle: person.handle,
          aliases:
            person.title !== person.handle
              ? [person.title, `@${person.handle}`]
              : [`@${person.handle}`],
          generated_at: generatedAt,
        },
        compiledTruth.join('\n').trim(),
        timelineEntries.join('\n'),
        {
          type: 'person',
          title: person.title,
          tags: ['x-bookmarks', 'person'],
        },
      ),
    });
  }

  for (const [slug, concept] of [...concepts.entries()].sort((a, b) =>
    a[1].name.localeCompare(b[1].name),
  )) {
    const filePath = `${slug}.md`;
    const relatedPeople = [...concept.people]
      .sort((a, b) =>
        (people.get(a)?.title ?? a).localeCompare(people.get(b)?.title ?? b),
      )
      .map((personSlug) =>
        relativeMarkdownLink(
          filePath,
          `${personSlug}.md`,
          people.get(personSlug)?.title ?? personSlug.split('/').pop() ?? personSlug,
        ),
      );

    const compiledTruth = [
      `# ${concept.name}`,
      '',
      `${concept.description} [Source: compiled from X bookmarks in ${relativeMarkdownLink(filePath, collectionPath, datasetMeta.title)}, ${generatedAt}]`,
      '',
      '## Evidence',
      '',
    ];

    for (const note of sortNotes(concept.notes)) {
      const mentionLinks = note.mentionedSlugs.map((mentionedSlug) =>
        relativeMarkdownLink(
          filePath,
          `${mentionedSlug}.md`,
          people.get(mentionedSlug)?.title ?? mentionedSlug.split('/').pop() ?? mentionedSlug,
        ),
      );
      compiledTruth.push(`### ${note.title}`);
      compiledTruth.push(
        `${relativeMarkdownLink(filePath, `${note.authorSlug}.md`, note.authorName)} posted this bookmark in ${relativeMarkdownLink(filePath, collectionPath, datasetMeta.title)}.${mentionLinks.length > 0 ? ` Related people: ${mentionLinks.join(', ')}.` : ''} [Source: X, ${note.targetUrl}]`,
      );
      if (note.text.trim()) {
        compiledTruth.push('');
        compiledTruth.push(quoteBlock(note.text));
      }
      const threadBlocks = renderThread(note.thread);
      if (threadBlocks.length > 0) {
        compiledTruth.push('', ...threadBlocks);
      }
      compiledTruth.push('');
    }

    compiledTruth.push('## Related People');
    compiledTruth.push('');
    compiledTruth.push(
      ...(relatedPeople.length > 0
        ? relatedPeople.map(
            (link) =>
              `- ${link} [Source: compiled from X bookmarks in ${datasetMeta.id}, ${generatedAt}]`,
          )
        : [`- No related people were derived deterministically. [Source: compiled from X bookmarks, ${datasetMeta.id}, ${generatedAt}]`]),
    );

    const timelineEntries = [
      '## Timeline',
      '',
      ...sortNotes(concept.notes).map(
        (note) =>
          `- **${note.date}** | X bookmark — ${relativeMarkdownLink(filePath, `${note.authorSlug}.md`, note.authorName)} posted "${note.title}". [Source: X, ${note.targetUrl}]`,
      ),
    ];

    pages.push({
      path: filePath,
      content: serializeMarkdown(
        {
          source_type: datasetMeta.sourceType ?? 'x',
          dataset_id: datasetMeta.id,
          generated_at: generatedAt,
        },
        compiledTruth.join('\n').trim(),
        timelineEntries.join('\n'),
        {
          type: 'concept',
          title: concept.name,
          tags: ['x-bookmarks', 'concept'],
        },
      ),
    });
  }

  return pages;
}

export async function compileBookmarks(opts: CompileBookmarkOpts): Promise<CompileBookmarkResult> {
  const generatedAt = opts.generatedAt ?? new Date().toISOString().slice(0, 10);
  const themeDefinitions = opts.themeDefinitions ?? DEFAULT_THEME_DEFINITIONS;
  const titleOverrides = { ...X_TITLE_OVERRIDES, ...(opts.titleOverrides ?? {}) };

  const rawDataset = JSON.parse(
    await readFile(path.resolve(opts.dataset.sourcePath), 'utf8'),
  ) as RawDataset;
  const rawThreads = JSON.parse(
    await readFile(path.resolve(opts.dataset.threadPath), 'utf8'),
  ) as { results: RawThreadResult[] };

  const pages = buildBookmarkPages(opts.dataset, rawDataset, rawThreads.results ?? [], {
    generatedAt,
    themeDefinitions,
    titleOverrides,
  });

  if (opts.cleanOutput !== false) {
    await rm(opts.outputDir, { recursive: true, force: true });
  }

  for (const page of pages) {
    const outputPath = path.join(opts.outputDir, page.path);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, page.content, 'utf8');
  }

  const peopleCount = pages.filter((page) => page.path.startsWith('people/')).length;
  const conceptCount = pages.filter((page) => page.path.startsWith('concepts/')).length;
  const collectionCount = pages.filter((page) => page.path.startsWith('collections/')).length;

  return {
    outputDir: path.resolve(opts.outputDir),
    pages: pages.map((page) => page.path).sort(),
    pageCount: pages.length,
    people: peopleCount,
    concepts: conceptCount,
    collections: collectionCount,
    bookmarks: rawDataset.results.length,
  };
}
