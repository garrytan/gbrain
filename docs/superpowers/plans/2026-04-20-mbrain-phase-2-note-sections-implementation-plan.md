# MBrain Phase 2 Note Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the second deterministic structural-extraction slice for Phase 2 by projecting canonical notes into stable section-level derived artifacts that can later feed Context Map entry points and path explanations.

**Architecture:** Build directly on the completed `Note Manifest` layer instead of jumping to maps. Introduce a regenerable `note_section_entries` store behind the shared `BrainEngine` contract, derive stable `section_id` and `heading_path` values from canonical Markdown plus manifest heading metadata, refresh section rows on canonical note writes, and expose only a narrow inspection surface so section entry points become testable before they are used as routing dependencies.

**Tech Stack:** Bun, TypeScript, existing `BrainEngine` boundary, SQLite/Postgres/PGLite engines, `gray-matter` markdown parsing already in use, shared `operations.ts`, Bun test, repo-local benchmark scripts.

---

## Scope and sequencing decisions

- This plan implements only deterministic section-level structural projection on top of `Note Manifest`.
- `Context Map`, `Context Atlas`, semantic extraction, and graph ranking are explicitly deferred.
- Section rows remain derived artifacts. They may be deleted and rebuilt without loss of canonical truth.
- Stable section identity is derived from canonical note slug plus deterministic heading path. It must not depend on mutable row ids.
- The first public surface is inspection-oriented: get one section, list sections for a note, rebuild section rows.
- Section projection must remain scope-aware from day one. MVP still publishes only `workspace:default`.
- Import and staged import commit paths are the initial refresh triggers. No background daemon work is required for this slice.

## File Map

### Core files to create

- `src/core/services/note-section-service.ts` — deterministic section extraction from canonical note + manifest inputs
- `scripts/bench/phase2-note-sections.ts` — reproducible Phase 2 section benchmark runner
- `test/note-section-schema.test.ts` — schema coverage for section storage across engines
- `test/note-section-service.test.ts` — deterministic section-id, heading-path, and section-body coverage
- `test/note-section-engine.test.ts` — persistence and refresh behavior across engines
- `test/note-section-operations.test.ts` — shared operation coverage for section inspection and rebuild
- `test/phase2-note-sections.test.ts` — benchmark JSON shape and acceptance summary coverage

### Existing files expected to change

- `src/core/types.ts`
- `src/core/engine.ts`
- `src/schema.sql`
- `src/core/schema-embedded.ts`
- `src/core/pglite-schema.ts`
- `src/core/migrate.ts`
- `src/core/sqlite-engine.ts`
- `src/core/pglite-engine.ts`
- `src/core/postgres-engine.ts`
- `src/core/import-file.ts`
- `src/core/services/import-service.ts`
- `src/core/services/note-manifest-service.ts`
- `src/core/operations.ts`
- `package.json`
- `docs/MBRAIN_VERIFY.md`
- `test/cli.test.ts`

## Data model decisions to lock before implementation

- `scope_id` is required on every section row and must match the associated manifest row.
- `section_id` is the durable identity for a section and is computed as `${page_slug}#${heading_path.join('/')}`.
- `heading_path` is the ordered array of ancestor heading slugs including the section’s own heading slug.
- `parent_section_id` is nullable only for top-level headings.
- `line_start` and `line_end` refer to canonical body line numbers after frontmatter parsing and timeline joining.
- `section_text` stores the heading-local content slice so later map work can explain why a section was retrieved.
- `outgoing_wikilinks`, `outgoing_urls`, and `source_refs` are extracted per section instead of per note.
- `content_hash` tracks section slice identity. `extractor_version` tracks section extractor contract identity.

---

### Task 1: Add the section schema and shared types

**Files:**
- Create: `test/note-section-schema.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/engine.ts`
- Modify: `src/schema.sql`
- Modify: `src/core/schema-embedded.ts`
- Modify: `src/core/pglite-schema.ts`
- Modify: `src/core/migrate.ts`

- [ ] **Step 1: Write the failing schema test**

Create `test/note-section-schema.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('note-section schema', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  test('sqlite initSchema creates note_section_entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-note-section-sqlite-'));
    tempDirs.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    const tables = (engine as any).database
      .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'note_section_entries'`)
      .all();

    expect(tables).toHaveLength(1);
    await engine.disconnect();
  });

  test('pglite initSchema creates note_section_entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-note-section-pglite-'));
    tempDirs.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();

    const result = await (engine as any).db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'note_section_entries'`,
    );

    expect(result.rows).toHaveLength(1);
    await engine.disconnect();
  });
});
```

- [ ] **Step 2: Run the schema test to verify it fails**

Run:

```bash
bun test test/note-section-schema.test.ts
```

Expected: the test fails because `note_section_entries` does not exist yet.

- [ ] **Step 3: Add the shared section types**

Update `src/core/types.ts` with:

```ts
export interface NoteSectionEntry {
  scope_id: string;
  page_id: number;
  page_slug: string;
  page_path: string;
  section_id: string;
  parent_section_id: string | null;
  heading_slug: string;
  heading_path: string[];
  heading_text: string;
  depth: number;
  line_start: number;
  line_end: number;
  section_text: string;
  outgoing_wikilinks: string[];
  outgoing_urls: string[];
  source_refs: string[];
  content_hash: string;
  extractor_version: string;
  last_indexed_at: Date;
}

export interface NoteSectionEntryInput {
  scope_id: string;
  page_id: number;
  page_slug: string;
  page_path: string;
  section_id: string;
  parent_section_id: string | null;
  heading_slug: string;
  heading_path: string[];
  heading_text: string;
  depth: number;
  line_start: number;
  line_end: number;
  section_text: string;
  outgoing_wikilinks: string[];
  outgoing_urls: string[];
  source_refs: string[];
  content_hash: string;
  extractor_version: string;
}

export interface NoteSectionFilters {
  scope_id?: string;
  page_slug?: string;
  section_id?: string;
  limit?: number;
}
```

Update `src/core/engine.ts` with:

```ts
  replaceNoteSectionEntries(
    scopeId: string,
    pageSlug: string,
    entries: NoteSectionEntryInput[],
  ): Promise<NoteSectionEntry[]>;
  getNoteSectionEntry(scopeId: string, sectionId: string): Promise<NoteSectionEntry | null>;
  listNoteSectionEntries(filters?: NoteSectionFilters): Promise<NoteSectionEntry[]>;
  deleteNoteSectionEntries(scopeId: string, pageSlug: string): Promise<void>;
```

- [ ] **Step 4: Add the additive schema and migration**

Update `src/schema.sql`, `src/core/schema-embedded.ts`, and `src/core/pglite-schema.ts` with:

```sql
CREATE TABLE IF NOT EXISTS note_section_entries (
  scope_id TEXT NOT NULL,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  page_slug TEXT NOT NULL,
  page_path TEXT NOT NULL,
  section_id TEXT NOT NULL,
  parent_section_id TEXT,
  heading_slug TEXT NOT NULL,
  heading_path JSONB NOT NULL DEFAULT '[]',
  heading_text TEXT NOT NULL,
  depth INTEGER NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  section_text TEXT NOT NULL,
  outgoing_wikilinks JSONB NOT NULL DEFAULT '[]',
  outgoing_urls JSONB NOT NULL DEFAULT '[]',
  source_refs JSONB NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  last_indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, section_id)
);

CREATE INDEX IF NOT EXISTS idx_note_sections_scope_page
  ON note_section_entries(scope_id, page_slug, line_start);
CREATE INDEX IF NOT EXISTS idx_note_sections_scope_indexed
  ON note_section_entries(scope_id, last_indexed_at DESC);
```

Add a new migration to `src/core/migrate.ts`:

```ts
{
  version: 10,
  name: 'note_section_foundations',
  up: async (candidate) => {
    await candidate.sql`
      CREATE TABLE IF NOT EXISTS note_section_entries (
        scope_id TEXT NOT NULL,
        page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        page_slug TEXT NOT NULL,
        page_path TEXT NOT NULL,
        section_id TEXT NOT NULL,
        parent_section_id TEXT,
        heading_slug TEXT NOT NULL,
        heading_path JSONB NOT NULL DEFAULT '[]',
        heading_text TEXT NOT NULL,
        depth INTEGER NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        section_text TEXT NOT NULL,
        outgoing_wikilinks JSONB NOT NULL DEFAULT '[]',
        outgoing_urls JSONB NOT NULL DEFAULT '[]',
        source_refs JSONB NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        last_indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (scope_id, section_id)
      )
    `;
    await candidate.sql`
      CREATE INDEX IF NOT EXISTS idx_note_sections_scope_page
      ON note_section_entries(scope_id, page_slug, line_start)
    `;
    await candidate.sql`
      CREATE INDEX IF NOT EXISTS idx_note_sections_scope_indexed
      ON note_section_entries(scope_id, last_indexed_at DESC)
    `;
  },
}
```

- [ ] **Step 5: Run the schema test to verify it passes**

Run:

```bash
bun test test/note-section-schema.test.ts
```

Expected: both sqlite and pglite schema tests pass.

- [ ] **Step 6: Commit**

```bash
git add test/note-section-schema.test.ts src/core/types.ts src/core/engine.ts src/schema.sql src/core/schema-embedded.ts src/core/pglite-schema.ts src/core/migrate.ts
git commit -m "feat: add note section schema foundations"
```

### Task 2: Build the deterministic section extraction service

**Files:**
- Create: `src/core/services/note-section-service.ts`
- Create: `test/note-section-service.test.ts`

- [ ] **Step 1: Write the failing service test**

Create `test/note-section-service.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { buildNoteManifestEntry } from '../src/core/services/note-manifest-service.ts';
import {
  NOTE_SECTION_EXTRACTOR_VERSION,
  buildNoteSectionEntries,
} from '../src/core/services/note-section-service.ts';

describe('note section service', () => {
  test('buildNoteSectionEntries derives stable ids and heading paths', () => {
    const page = {
      type: 'concept' as const,
      title: 'Section Projection',
      compiled_truth: [
        '# Overview',
        'Intro with [[systems/mbrain]].',
        '',
        '## Runtime',
        'Details with https://example.com/runtime.',
        '[Source: User, direct message, 2026-04-20 05:00 PM KST]',
      ].join('\n'),
      timeline: '',
      frontmatter: {
        aliases: ['Section Projection'],
      },
      content_hash: 'a'.repeat(64),
    };

    const manifest = buildNoteManifestEntry({
      page_id: 7,
      slug: 'concepts/section-projection',
      path: 'concepts/section-projection.md',
      tags: ['phase2', 'sections'],
      page,
    });

    const sections = buildNoteSectionEntries({
      page_id: 7,
      page_slug: 'concepts/section-projection',
      page_path: 'concepts/section-projection.md',
      page,
      manifest,
    });

    expect(sections.map((entry) => entry.section_id)).toEqual([
      'concepts/section-projection#overview',
      'concepts/section-projection#overview/runtime',
    ]);
    expect(sections.map((entry) => entry.parent_section_id)).toEqual([
      null,
      'concepts/section-projection#overview',
    ]);
    expect(sections.map((entry) => entry.heading_path)).toEqual([
      ['overview'],
      ['overview', 'runtime'],
    ]);
    expect(sections[1]?.outgoing_urls).toEqual(['https://example.com/runtime']);
    expect(sections[1]?.source_refs).toEqual([
      'User, direct message, 2026-04-20 05:00 PM KST',
    ]);
    expect(sections[0]?.extractor_version).toBe(NOTE_SECTION_EXTRACTOR_VERSION);
  });
});
```

- [ ] **Step 2: Run the service test to verify it fails**

Run:

```bash
bun test test/note-section-service.test.ts
```

Expected: failure because `note-section-service.ts` does not exist yet.

- [ ] **Step 3: Implement the minimal extraction service**

Create `src/core/services/note-section-service.ts`:

```ts
import type { BrainEngine } from '../engine.ts';
import type { NoteManifestEntry, NoteSectionEntryInput, Page, PageInput } from '../types.ts';
import { importContentHash } from '../utils.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';

export const NOTE_SECTION_EXTRACTOR_VERSION = 'phase2-sections-v1';

export interface BuildNoteSectionEntriesInput {
  scope_id?: string;
  page_id: number;
  page_slug: string;
  page_path: string;
  page: Pick<PageInput, 'compiled_truth' | 'timeline' | 'frontmatter' | 'title' | 'type'> & {
    content_hash?: string;
  };
  manifest: NoteManifestEntry;
}

export function buildNoteSectionEntries(input: BuildNoteSectionEntriesInput): NoteSectionEntryInput[] {
  const scopeId = input.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
  const body = joinCanonicalBody(input.page.compiled_truth, input.page.timeline ?? '');
  const lines = body.split('\n');
  const headings = input.manifest.heading_index;
  const stack: Array<{ depth: number; slug: string; section_id: string }> = [];

  return headings.map((heading, index) => {
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= heading.depth) {
      stack.pop();
    }

    const headingPath = [...stack.map((entry) => entry.slug), heading.slug];
    const sectionId = `${input.page_slug}#${headingPath.join('/')}`;
    const parentSectionId = stack.length > 0 ? stack[stack.length - 1]!.section_id : null;
    const nextLine = headings[index + 1]?.line_start ?? (lines.length + 1);
    const lineEnd = nextLine - 1;
    const sectionLines = lines.slice(heading.line_start - 1, lineEnd);
    const sectionText = sectionLines.join('\n').trim();

    const entry: NoteSectionEntryInput = {
      scope_id: scopeId,
      page_id: input.page_id,
      page_slug: input.page_slug,
      page_path: input.page_path,
      section_id: sectionId,
      parent_section_id: parentSectionId,
      heading_slug: heading.slug,
      heading_path: headingPath,
      heading_text: heading.text,
      depth: heading.depth,
      line_start: heading.line_start,
      line_end: lineEnd,
      section_text: sectionText,
      outgoing_wikilinks: extractOutgoingWikilinks(sectionText),
      outgoing_urls: extractOutgoingUrls(sectionText),
      source_refs: extractSourceRefs(sectionText),
      content_hash: importContentHash({
        title: input.page.title,
        type: input.page.type,
        compiled_truth: sectionText,
        timeline: '',
        frontmatter: { heading_path: headingPath },
        tags: [],
      }),
      extractor_version: NOTE_SECTION_EXTRACTOR_VERSION,
    };

    stack.push({ depth: heading.depth, slug: heading.slug, section_id: sectionId });
    return entry;
  });
}

export async function rebuildNoteSectionEntries(
  engine: BrainEngine,
  input: { scope_id?: string; page_slug?: string } = {},
): Promise<NoteSectionEntryInput[]> {
  const scopeId = input.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
  const pages = input.page_slug ? [await requirePage(engine, input.page_slug)] : await listAllPages(engine);
  const rebuilt: NoteSectionEntryInput[] = [];

  for (const page of pages) {
    const manifest = await engine.getNoteManifestEntry(scopeId, page.slug);
    if (!manifest) continue;
    const entries = buildNoteSectionEntries({
      scope_id: scopeId,
      page_id: page.id,
      page_slug: page.slug,
      page_path: manifest.path,
      page,
      manifest,
    });
    await engine.replaceNoteSectionEntries(scopeId, page.slug, entries);
    rebuilt.push(...entries);
  }

  return rebuilt;
}

function joinCanonicalBody(compiledTruth: string, timeline: string): string {
  if (!timeline.trim()) return compiledTruth;
  return `${compiledTruth}\n\n---\n\n${timeline}`;
}

function extractOutgoingWikilinks(body: string): string[] {
  return Array.from(body.matchAll(/\[\[([^\]]+)\]\]/g))
    .map((match) => match[1]?.trim().split('|')[0]?.split('#')[0]?.trim() ?? '')
    .filter(Boolean);
}

function extractOutgoingUrls(body: string): string[] {
  return Array.from(body.matchAll(/https?:\/\/[^\s<>"')\]]+/g))
    .map((match) => match[0]?.trim().replace(/[.,;:!?]+$/g, '') ?? '')
    .filter(Boolean);
}

function extractSourceRefs(body: string): string[] {
  return Array.from(body.matchAll(/\[Source:\s*([^\]\n]+)\]/g))
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
}

async function requirePage(engine: BrainEngine, slug: string): Promise<Page> {
  const page = await engine.getPage(slug);
  if (!page) throw new Error(`Page not found: ${slug}`);
  return page;
}

async function listAllPages(engine: BrainEngine): Promise<Page[]> {
  return engine.listPages({ limit: 500, offset: 0 });
}
```

- [ ] **Step 4: Run the service test to verify it passes**

Run:

```bash
bun test test/note-section-service.test.ts
```

Expected: service test passes with stable section ids and parent paths.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/note-section-service.ts test/note-section-service.test.ts
git commit -m "feat: add note section extraction service"
```

### Task 3: Refresh section rows from canonical writes

**Files:**
- Create: `test/note-section-engine.test.ts`
- Modify: `src/core/sqlite-engine.ts`
- Modify: `src/core/pglite-engine.ts`
- Modify: `src/core/postgres-engine.ts`
- Modify: `src/core/import-file.ts`
- Modify: `src/core/services/import-service.ts`
- Modify: `src/core/services/note-manifest-service.ts`

- [ ] **Step 1: Write the failing refresh test**

Create `test/note-section-engine.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from '../src/core/services/note-manifest-service.ts';

test('importFromContent refreshes deterministic note-section rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-note-section-engine-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();

    const content = [
      '---',
      'type: concept',
      'title: Refresh Sections',
      'tags: [phase2, sections]',
      '---',
      '# One',
      'Body',
      '',
      '## Two',
      'Nested body',
    ].join('\\n');

    await importFromContent(engine, 'concepts/refresh-sections', content, {
      path: 'concepts/refresh-sections.md',
    });

    const entries = await engine.listNoteSectionEntries({
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      page_slug: 'concepts/refresh-sections',
    });

    expect(entries.map((entry) => entry.section_id)).toEqual([
      'concepts/refresh-sections#one',
      'concepts/refresh-sections#one/two',
    ]);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the refresh test to verify it fails**

Run:

```bash
bun test test/note-section-engine.test.ts
```

Expected: failure because section rows are not written yet.

- [ ] **Step 3: Add replace/get/list/delete engine support**

Update each engine with:

```ts
async replaceNoteSectionEntries(scopeId: string, pageSlug: string, entries: NoteSectionEntryInput[]) {
  await this.deleteNoteSectionEntries(scopeId, pageSlug);
  for (const entry of entries) {
    await this.sql`
      INSERT INTO note_section_entries (
        scope_id, page_id, page_slug, page_path, section_id, parent_section_id,
        heading_slug, heading_path, heading_text, depth, line_start, line_end,
        section_text, outgoing_wikilinks, outgoing_urls, source_refs,
        content_hash, extractor_version
      ) VALUES (
        ${entry.scope_id}, ${entry.page_id}, ${entry.page_slug}, ${entry.page_path},
        ${entry.section_id}, ${entry.parent_section_id}, ${entry.heading_slug},
        ${JSON.stringify(entry.heading_path)}, ${entry.heading_text}, ${entry.depth},
        ${entry.line_start}, ${entry.line_end}, ${entry.section_text},
        ${JSON.stringify(entry.outgoing_wikilinks)}, ${JSON.stringify(entry.outgoing_urls)},
        ${JSON.stringify(entry.source_refs)}, ${entry.content_hash}, ${entry.extractor_version}
      )
    `;
  }
  return this.listNoteSectionEntries({ scope_id: scopeId, page_slug: pageSlug, limit: entries.length });
}
```

Use the local row parser pattern already used for manifest rows so sqlite, pglite, and postgres normalize JSON arrays consistently.

- [ ] **Step 4: Refresh section rows in canonical write paths**

Update `src/core/import-file.ts` and `src/core/services/import-service.ts` so the transaction order is:

```ts
const storedPage = await tx.putPage(...);
const manifest = await tx.upsertNoteManifestEntry(buildNoteManifestEntry(...));
await tx.replaceNoteSectionEntries(
  manifest.scope_id,
  manifest.slug,
  buildNoteSectionEntries({
    scope_id: manifest.scope_id,
    page_id: storedPage.id,
    page_slug: storedPage.slug,
    page_path: manifest.path,
    page: storedPage,
    manifest,
  }),
);
```

Keep note-manifest refresh first so section extraction can rely on the normalized heading index and canonicalized tags already stored in the manifest.

- [ ] **Step 5: Run the refresh test to verify it passes**

Run:

```bash
bun test test/note-section-engine.test.ts
```

Expected: imported notes immediately expose deterministic section rows.

- [ ] **Step 6: Commit**

```bash
git add test/note-section-engine.test.ts src/core/sqlite-engine.ts src/core/pglite-engine.ts src/core/postgres-engine.ts src/core/import-file.ts src/core/services/import-service.ts src/core/services/note-manifest-service.ts
git commit -m "feat: refresh note sections on canonical writes"
```

### Task 4: Expose a minimal section inspection surface

**Files:**
- Create: `test/note-section-operations.test.ts`
- Modify: `src/core/operations.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write the failing operation test**

Create `test/note-section-operations.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';

test('note section operations are registered with CLI hints', () => {
  const get = operations.find((operation) => operation.name === 'get_note_section_entry');
  const list = operations.find((operation) => operation.name === 'list_note_section_entries');
  const rebuild = operations.find((operation) => operation.name === 'rebuild_note_sections');

  expect(get?.cliHints?.name).toBe('section-get');
  expect(list?.cliHints?.name).toBe('section-list');
  expect(rebuild?.cliHints?.name).toBe('section-rebuild');
});
```

- [ ] **Step 2: Run the operation test to verify it fails**

Run:

```bash
bun test test/note-section-operations.test.ts
```

Expected: failure because section operations do not exist yet.

- [ ] **Step 3: Implement the minimal operations**

Add to `src/core/operations.ts`:

```ts
const get_note_section_entry: Operation = {
  name: 'get_note_section_entry',
  description: 'Get one derived note-section entry by scope and section id.',
  params: {
    section_id: { type: 'string', required: true, description: 'Durable section id.' },
    scope_id: { type: 'string', default: DEFAULT_NOTE_MANIFEST_SCOPE_ID, description: 'Section scope.' },
  },
  cliHints: { name: 'section-get', positional: ['section_id'] },
  handler: async ({ engine }, params) => {
    const scopeId = String(params.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID);
    const sectionId = String(params.section_id);
    const entry = await engine.getNoteSectionEntry(scopeId, sectionId);
    if (!entry) throw new OperationError('page_not_found', `Section not found: ${sectionId}`);
    return entry;
  },
};

const list_note_section_entries: Operation = {
  name: 'list_note_section_entries',
  description: 'List derived note-section entries for one note.',
  params: {
    page_slug: { type: 'string', required: true, description: 'Page slug to inspect.' },
    scope_id: { type: 'string', default: DEFAULT_NOTE_MANIFEST_SCOPE_ID, description: 'Section scope.' },
    limit: { type: 'number', default: 50, description: 'Maximum number of entries to list.' },
  },
  cliHints: { name: 'section-list', positional: ['page_slug'], aliases: { n: 'limit' } },
  handler: async ({ engine }, params) =>
    engine.listNoteSectionEntries({
      scope_id: String(params.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      page_slug: String(params.page_slug),
      limit: Number(params.limit ?? 50),
    }),
};

const rebuild_note_sections: Operation = {
  name: 'rebuild_note_sections',
  description: 'Rebuild derived note-section rows from canonical note state.',
  params: {
    page_slug: { type: 'string', required: false, description: 'Optional single-page target.' },
    scope_id: { type: 'string', default: DEFAULT_NOTE_MANIFEST_SCOPE_ID, description: 'Section scope.' },
  },
  cliHints: { name: 'section-rebuild', positional: [] },
  handler: async ({ engine }, params) => {
    const entries = await rebuildNoteSectionEntries(engine, {
      scope_id: String(params.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      page_slug: typeof params.page_slug === 'string' ? params.page_slug : undefined,
    });
    return {
      scope_id: params.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      rebuilt: entries.length,
      section_ids: entries.map((entry) => entry.section_id),
    };
  },
};
```

Add CLI assertions to `test/cli.test.ts`:

```ts
test('section-list --help is exposed', async () => {
  const proc = spawnSync(['bun', 'run', 'src/cli.ts', 'section-list', '--help'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(proc.exitCode).toBe(0);
  expect(new TextDecoder().decode(proc.stdout)).toContain('Usage: mbrain section-list');
});
```

- [ ] **Step 4: Run the operation and CLI tests to verify they pass**

Run:

```bash
bun test test/note-section-operations.test.ts
bun test test/cli.test.ts -t "section-list --help"
```

Expected: section operations are registered and surfaced through CLI help.

- [ ] **Step 5: Commit**

```bash
git add test/note-section-operations.test.ts test/cli.test.ts src/core/operations.ts
git commit -m "feat: add note section inspection operations"
```

### Task 5: Add Phase 2 section benchmark and verification hooks

**Files:**
- Create: `scripts/bench/phase2-note-sections.ts`
- Create: `test/phase2-note-sections.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

- [ ] **Step 1: Write the failing benchmark test**

Create `test/phase2-note-sections.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase2 note-sections benchmark', () => {
  test('--json prints a phase2 section benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase2-note-sections.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));

    const names = payload.workloads.map((workload: any) => workload.name).sort();
    expect(names).toEqual([
      'section_get',
      'section_list',
      'section_rebuild',
      'section_projection',
    ]);
    expect(payload.acceptance.readiness_status).toBe('pass');
    expect(payload.acceptance.phase2_status).toBe('pass');
  });
});
```

- [ ] **Step 2: Run the benchmark test to verify it fails**

Run:

```bash
bun test test/phase2-note-sections.test.ts
```

Expected: failure because the benchmark script does not exist yet.

- [ ] **Step 3: Implement the local benchmark runner**

Create `scripts/bench/phase2-note-sections.ts` using the same local sqlite execution envelope as earlier phase runners:

```ts
#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { createLocalConfigDefaults } from '../../src/core/config.ts';
import { createConnectedEngine } from '../../src/core/engine-factory.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { rebuildNoteSectionEntries } from '../../src/core/services/note-section-service.ts';

// Seed two canonical notes, then measure:
// - section_get
// - section_list
// - section_rebuild
// - section_projection
//
// Acceptance checks:
// - section_get_p95_ms <= 100
// - section_list_p95_ms <= 100
// - section_rebuild_p95_ms <= 150
// - section_projection_success_rate === 100
```

Update `package.json`:

```json
{
  "scripts": {
    "bench:phase2-sections": "bun run ./scripts/bench/phase2-note-sections.ts"
  }
}
```

Update `docs/MBRAIN_VERIFY.md` with:

~~~md
## Phase 2 note-sections verification

Run:

```bash
bun test test/note-section-schema.test.ts test/note-section-service.test.ts test/note-section-engine.test.ts test/note-section-operations.test.ts test/phase2-note-sections.test.ts
```

Expected:

- section rows stay deterministic across import and rebuild
- stable section ids and heading paths remain reproducible
- section inspection commands stay available through the shared operation surface

## Phase 2 note-sections benchmark

Run:

```bash
bun run bench:phase2-sections --json
```

Expected:

- the report includes `section_get`, `section_list`, `section_rebuild`, and `section_projection`
- `section_projection.success_rate` is `100`
- `acceptance.readiness_status` and `acceptance.phase2_status` both report `pass`
~~~

- [ ] **Step 4: Run the benchmark and regression suite**

Run:

```bash
bun test test/note-section-schema.test.ts test/note-section-service.test.ts test/note-section-engine.test.ts test/note-section-operations.test.ts test/phase2-note-sections.test.ts
bun run bench:phase2-sections --json
bun run test:phase1
```

Expected:

- section tests pass with deterministic ids and refresh semantics
- benchmark reports `phase2_status: pass`
- Phase 1 regressions remain green

- [ ] **Step 5: Commit**

```bash
git add scripts/bench/phase2-note-sections.ts test/phase2-note-sections.test.ts package.json docs/MBRAIN_VERIFY.md
git commit -m "test: add phase2 note sections benchmark"
```

---

## Self-review checklist

- This plan stays inside the approved Phase 2 workstream and does not jump ahead to Context Map or Atlas behavior.
- Every new artifact remains derived and rebuildable from canonical notes plus manifest metadata.
- Stable section identity is explicit and deterministic instead of relying on row ids or mutable ordering.
- Import and staged import paths remain the only required refresh triggers for this slice.
- Benchmark and verification hooks exist before broader Phase 2 retrieval claims are made.
