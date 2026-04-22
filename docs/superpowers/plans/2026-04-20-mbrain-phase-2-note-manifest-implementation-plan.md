# MBrain Phase 2 Note Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the first deterministic structural-extraction slice for Phase 2 by introducing a durable `Note Manifest` that is rebuilt from canonical Markdown, refreshed on import/sync, and measurable through a dedicated benchmark.

**Architecture:** Keep Phase 2 structural-first and additive. Introduce a regenerable `note_manifest_entries` store behind the shared `BrainEngine` contract, build manifest entries with a focused deterministic extraction service, refresh them directly from canonical page writes, and expose only a narrow inspection surface so later map work has a stable substrate without turning the manifest into canonical truth.

**Tech Stack:** Bun, TypeScript, existing `BrainEngine` boundary, SQLite/Postgres/PGLite engines, shared `operations.ts`, `gray-matter` markdown parsing, Bun test, repo-local benchmark scripts.

---

## Scope and sequencing decisions

- Phase 2 in this plan implements only `Note Manifest` and deterministic structural extraction.
- `Context Map`, `Context Atlas`, semantic extraction, and higher-noise inferred edges are explicitly deferred to later phases.
- Manifest scope is explicit from day one, but the MVP uses a single published default scope: `workspace:default`.
- Manifest rows are derived artifacts. They may be deleted and rebuilt without loss of canonical truth.
- Refresh must happen from canonical writes, not by background magic only. Import and sync paths are the initial trigger points.
- The manifest must preserve enough structure for later map work: path, slug, title, aliases, tags, outgoing links, source refs, heading index, hash, extractor version, and freshness timestamps.
- The first public surface is inspection-oriented, not query-optimization-oriented. This phase should make the manifest visible and testable before it becomes a routing dependency.

## File Map

### Core files to create

- `src/core/services/note-manifest-service.ts` — deterministic manifest extraction from canonical page inputs
- `scripts/bench/phase2-note-manifest.ts` — reproducible Phase 2 benchmark runner
- `test/note-manifest-schema.test.ts` — cross-engine schema coverage for manifest storage
- `test/note-manifest-service.test.ts` — deterministic extractor behavior and projection tests
- `test/note-manifest-engine.test.ts` — persistence and refresh behavior across engines
- `test/note-manifest-operations.test.ts` — shared operation coverage for manifest inspection and rebuild
- `test/phase2-note-manifest.test.ts` — benchmark JSON shape and acceptance summary coverage

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
- `src/commands/sync.ts`
- `src/core/operations.ts`
- `package.json`
- `docs/MBRAIN_VERIFY.md`
- `test/cli.test.ts`

## Data model decisions to lock before implementation

- `scope_id` is required on every manifest row. MVP uses `workspace:default`, but the schema must not assume a single global corpus forever.
- Manifest rows reference canonical pages through `page_id` for cascade safety and also store current `slug` plus `path` for inspection and later routing.
- `heading_index`, `aliases`, `tags`, `outgoing_wikilinks`, `outgoing_urls`, and `source_refs` are stored as JSON arrays.
- `content_hash` tracks canonical content identity. `extractor_version` tracks structural-extraction contract identity.
- `last_indexed_at` records freshness. It is not an authority timestamp.

---

### Task 1: Add the Note Manifest schema and shared types

**Files:**
- Create: `test/note-manifest-schema.test.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/engine.ts`
- Modify: `src/schema.sql`
- Modify: `src/core/schema-embedded.ts`
- Modify: `src/core/pglite-schema.ts`
- Modify: `src/core/migrate.ts`

- [ ] **Step 1: Write the failing schema test**

Create `test/note-manifest-schema.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('note-manifest schema', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  test('sqlite initSchema creates note_manifest_entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-note-manifest-sqlite-'));
    tempDirs.push(dir);

    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    const tables = (engine as any).database
      .query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'note_manifest_entries'`)
      .all();

    expect(tables).toHaveLength(1);
    await engine.disconnect();
  });

  test('pglite initSchema creates note_manifest_entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-note-manifest-pglite-'));
    tempDirs.push(dir);

    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();

    const result = await (engine as any).db.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = 'note_manifest_entries'`,
    );

    expect(result.rows).toHaveLength(1);
    await engine.disconnect();
  });
});
```

- [ ] **Step 2: Run the schema test to verify it fails**

Run:

```bash
bun test test/note-manifest-schema.test.ts
```

Expected: the test fails because `note_manifest_entries` does not exist yet.

- [ ] **Step 3: Add the shared manifest types**

Update `src/core/types.ts` with:

```ts
export interface NoteManifestHeading {
  slug: string;
  text: string;
  depth: number;
  line_start: number;
}

export interface NoteManifestEntry {
  scope_id: string;
  page_id: number;
  slug: string;
  path: string;
  page_type: PageType;
  title: string;
  frontmatter: Record<string, unknown>;
  aliases: string[];
  tags: string[];
  outgoing_wikilinks: string[];
  outgoing_urls: string[];
  source_refs: string[];
  heading_index: NoteManifestHeading[];
  content_hash: string;
  extractor_version: string;
  last_indexed_at: Date;
}

export interface NoteManifestEntryInput {
  scope_id: string;
  page_id: number;
  slug: string;
  path: string;
  page_type: PageType;
  title: string;
  frontmatter: Record<string, unknown>;
  aliases: string[];
  tags: string[];
  outgoing_wikilinks: string[];
  outgoing_urls: string[];
  source_refs: string[];
  heading_index: NoteManifestHeading[];
  content_hash: string;
  extractor_version: string;
}

export interface NoteManifestFilters {
  scope_id?: string;
  slug?: string;
  limit?: number;
}
```

Update `src/core/engine.ts` with:

```ts
  upsertNoteManifestEntry(input: NoteManifestEntryInput): Promise<NoteManifestEntry>;
  getNoteManifestEntry(scopeId: string, slug: string): Promise<NoteManifestEntry | null>;
  listNoteManifestEntries(filters?: NoteManifestFilters): Promise<NoteManifestEntry[]>;
  deleteNoteManifestEntry(scopeId: string, slug: string): Promise<void>;
```

- [ ] **Step 4: Add the additive schema and migration**

Update `src/schema.sql`, `src/core/schema-embedded.ts`, and `src/core/pglite-schema.ts` with:

```sql
CREATE TABLE IF NOT EXISTS note_manifest_entries (
  scope_id TEXT NOT NULL,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  path TEXT NOT NULL,
  page_type TEXT NOT NULL,
  title TEXT NOT NULL,
  frontmatter JSONB NOT NULL DEFAULT '{}',
  aliases JSONB NOT NULL DEFAULT '[]',
  tags JSONB NOT NULL DEFAULT '[]',
  outgoing_wikilinks JSONB NOT NULL DEFAULT '[]',
  outgoing_urls JSONB NOT NULL DEFAULT '[]',
  source_refs JSONB NOT NULL DEFAULT '[]',
  heading_index JSONB NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  last_indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope_id, page_id)
);

CREATE INDEX IF NOT EXISTS idx_note_manifest_scope_slug
  ON note_manifest_entries(scope_id, slug);
CREATE INDEX IF NOT EXISTS idx_note_manifest_scope_indexed
  ON note_manifest_entries(scope_id, last_indexed_at DESC);
```

Add a new migration to `src/core/migrate.ts`:

```ts
{
  version: 9,
  name: 'note_manifest_foundations',
  up: async (candidate) => {
    await candidate.sql`
      CREATE TABLE IF NOT EXISTS note_manifest_entries (
        scope_id TEXT NOT NULL,
        page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        path TEXT NOT NULL,
        page_type TEXT NOT NULL,
        title TEXT NOT NULL,
        frontmatter JSONB NOT NULL DEFAULT '{}',
        aliases JSONB NOT NULL DEFAULT '[]',
        tags JSONB NOT NULL DEFAULT '[]',
        outgoing_wikilinks JSONB NOT NULL DEFAULT '[]',
        outgoing_urls JSONB NOT NULL DEFAULT '[]',
        source_refs JSONB NOT NULL DEFAULT '[]',
        heading_index JSONB NOT NULL DEFAULT '[]',
        content_hash TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        last_indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (scope_id, page_id)
      )
    `;
    await candidate.sql`CREATE INDEX IF NOT EXISTS idx_note_manifest_scope_slug ON note_manifest_entries(scope_id, slug)`;
    await candidate.sql`CREATE INDEX IF NOT EXISTS idx_note_manifest_scope_indexed ON note_manifest_entries(scope_id, last_indexed_at DESC)`;
  },
}
```

- [ ] **Step 5: Run the schema test to verify it passes**

Run:

```bash
bun test test/note-manifest-schema.test.ts
```

Expected: both SQLite and PGLite schema tests pass.

- [ ] **Step 6: Commit**

```bash
git add test/note-manifest-schema.test.ts src/core/types.ts src/core/engine.ts src/schema.sql src/core/schema-embedded.ts src/core/pglite-schema.ts src/core/migrate.ts
git commit -m "feat: add note manifest schema foundations"
```

---

### Task 2: Build the deterministic extraction service

**Files:**
- Create: `src/core/services/note-manifest-service.ts`
- Create: `test/note-manifest-service.test.ts`
- Modify: `src/core/markdown.ts`

- [ ] **Step 1: Write the failing service tests**

Create `test/note-manifest-service.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { buildNoteManifestEntry, DEFAULT_NOTE_MANIFEST_SCOPE_ID } from '../src/core/services/note-manifest-service.ts';

test('buildNoteManifestEntry extracts headings, aliases, and outgoing links deterministically', () => {
  const entry = buildNoteManifestEntry({
    scopeId: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    pageId: 7,
    slug: 'concepts/task-memory',
    path: 'concepts/task-memory.md',
    pageType: 'concept',
    title: 'Task Memory',
    contentHash: 'hash-1',
    frontmatter: {
      aliases: ['Operational Memory'],
      tags: ['memory', 'tasks'],
      source: 'docs/architecture/redesign/04-workstream-operational-memory.md',
    },
    compiledTruth: [
      '# Task Memory',
      'See [[concepts/context-map]] and [design doc](https://example.com/design).',
      '## Resume Flow',
      'Preserve failed attempts before retrying.',
    ].join('\\n'),
  });

  expect(entry.scope_id).toBe(DEFAULT_NOTE_MANIFEST_SCOPE_ID);
  expect(entry.aliases).toEqual(['Operational Memory']);
  expect(entry.tags).toEqual(['memory', 'tasks']);
  expect(entry.outgoing_wikilinks).toEqual(['concepts/context-map']);
  expect(entry.outgoing_urls).toEqual(['https://example.com/design']);
  expect(entry.source_refs).toContain('docs/architecture/redesign/04-workstream-operational-memory.md');
  expect(entry.heading_index.map((heading) => `${heading.depth}:${heading.slug}`)).toEqual([
    '1:task-memory',
    '2:resume-flow',
  ]);
});
```

- [ ] **Step 2: Run the service test to verify it fails**

Run:

```bash
bun test test/note-manifest-service.test.ts
```

Expected: failure because `buildNoteManifestEntry` and `DEFAULT_NOTE_MANIFEST_SCOPE_ID` do not exist yet.

- [ ] **Step 3: Add the service implementation**

Create `src/core/services/note-manifest-service.ts`:

```ts
import type { NoteManifestEntry, NoteManifestEntryInput, NoteManifestHeading, PageType } from '../types.ts';

export const DEFAULT_NOTE_MANIFEST_SCOPE_ID = 'workspace:default';
export const NOTE_MANIFEST_EXTRACTOR_VERSION = 'phase2-structural-v1';

interface BuildNoteManifestEntryArgs {
  scopeId?: string;
  pageId: number;
  slug: string;
  path: string;
  pageType: PageType;
  title: string;
  frontmatter: Record<string, unknown>;
  compiledTruth: string;
  contentHash: string;
}

export function buildNoteManifestEntry(args: BuildNoteManifestEntryArgs): NoteManifestEntryInput {
  return {
    scope_id: args.scopeId ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    page_id: args.pageId,
    slug: args.slug,
    path: args.path,
    page_type: args.pageType,
    title: args.title,
    frontmatter: args.frontmatter,
    aliases: extractAliases(args.frontmatter),
    tags: extractTags(args.frontmatter),
    outgoing_wikilinks: extractOutgoingWikilinks(args.compiledTruth),
    outgoing_urls: extractOutgoingUrls(args.compiledTruth),
    source_refs: extractSourceRefs(args.slug, args.frontmatter),
    heading_index: extractHeadingIndex(args.compiledTruth),
    content_hash: args.contentHash,
    extractor_version: NOTE_MANIFEST_EXTRACTOR_VERSION,
  };
}

function extractAliases(frontmatter: Record<string, unknown>): string[] {
  const value = frontmatter.aliases ?? frontmatter.alias;
  if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
  if (typeof value === 'string') return [value.trim()].filter(Boolean);
  return [];
}

function extractTags(frontmatter: Record<string, unknown>): string[] {
  const value = frontmatter.tags;
  if (Array.isArray(value)) return value.map(String).map(v => v.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
  return [];
}

function extractOutgoingWikilinks(text: string): string[] {
  const matches = Array.from(text.matchAll(/\\[\\[([^\\]|]+)(?:\\|[^\\]]+)?\\]\\]/g));
  return Array.from(new Set(matches.map(match => match[1]!.trim()).filter(Boolean)));
}

function extractOutgoingUrls(text: string): string[] {
  const matches = Array.from(text.matchAll(/https?:\\/\\/[^)\\s]+/g));
  return Array.from(new Set(matches.map(match => match[0].trim())));
}

function extractSourceRefs(slug: string, frontmatter: Record<string, unknown>): string[] {
  const refs = [`page:${slug}`];
  const source = frontmatter.source;
  const sources = frontmatter.sources;
  if (typeof source === 'string' && source.trim()) refs.push(source.trim());
  if (Array.isArray(sources)) {
    for (const entry of sources) {
      const normalized = String(entry).trim();
      if (normalized) refs.push(normalized);
    }
  }
  return Array.from(new Set(refs));
}

function extractHeadingIndex(text: string): NoteManifestHeading[] {
  const headings: NoteManifestHeading[] = [];
  const lines = text.split('\\n');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]?.match(/^(#{1,6})\\s+(.+)$/);
    if (!match) continue;
    headings.push({
      slug: slugifyHeading(match[2]),
      text: match[2].trim(),
      depth: match[1].length,
      line_start: i + 1,
    });
  }
  return headings;
}

function slugifyHeading(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9\\s-]/g, '').replace(/[\\s]+/g, '-');
}
```

- [ ] **Step 4: Run the service test to verify it passes**

Run:

```bash
bun test test/note-manifest-service.test.ts
```

Expected: deterministic extraction test passes.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/note-manifest-service.ts test/note-manifest-service.test.ts
git commit -m "feat: add deterministic note manifest extraction"
```

---

### Task 3: Persist and refresh manifest entries from canonical writes

**Files:**
- Create: `test/note-manifest-engine.test.ts`
- Modify: `src/core/sqlite-engine.ts`
- Modify: `src/core/pglite-engine.ts`
- Modify: `src/core/postgres-engine.ts`
- Modify: `src/core/import-file.ts`
- Modify: `src/core/services/import-service.ts`
- Modify: `src/commands/sync.ts`

- [ ] **Step 1: Write the failing engine/refresh test**

Create `test/note-manifest-engine.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';

test('importFromContent refreshes the manifest entry for canonical markdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-note-manifest-engine-'));
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    const content = [
      '---',
      'type: concept',
      'title: Task Memory',
      'aliases: [Operational Memory]',
      'tags: [memory, tasks]',
      '---',
      '# Task Memory',
      'See [[concepts/context-map]].',
      '',
      '---',
      '',
      '- 2026-04-20 | Added source',
    ].join('\\n');

    await importFromContent(engine, 'concepts/task-memory', content);

    const entry = await engine.getNoteManifestEntry('workspace:default', 'concepts/task-memory');
    expect(entry?.aliases).toEqual(['Operational Memory']);
    expect(entry?.outgoing_wikilinks).toEqual(['concepts/context-map']);
    expect(entry?.heading_index.map((heading) => heading.slug)).toEqual(['task-memory']);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the engine test to verify it fails**

Run:

```bash
bun test test/note-manifest-engine.test.ts
```

Expected: failure because engine methods and import refresh do not exist yet.

- [ ] **Step 3: Implement engine persistence methods**

Add methods to each engine implementation following this SQLite shape:

```ts
async upsertNoteManifestEntry(input: NoteManifestEntryInput): Promise<NoteManifestEntry> {
  const page = await this.getPage(input.slug);
  if (!page) throw new Error(`Page not found for manifest: ${input.slug}`);

  this.database.query(
    `INSERT INTO note_manifest_entries (
       scope_id, page_id, slug, path, page_type, title, frontmatter,
       aliases, tags, outgoing_wikilinks, outgoing_urls, source_refs,
       heading_index, content_hash, extractor_version, last_indexed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(scope_id, page_id) DO UPDATE SET
       slug = excluded.slug,
       path = excluded.path,
       page_type = excluded.page_type,
       title = excluded.title,
       frontmatter = excluded.frontmatter,
       aliases = excluded.aliases,
       tags = excluded.tags,
       outgoing_wikilinks = excluded.outgoing_wikilinks,
       outgoing_urls = excluded.outgoing_urls,
       source_refs = excluded.source_refs,
       heading_index = excluded.heading_index,
       content_hash = excluded.content_hash,
       extractor_version = excluded.extractor_version,
       last_indexed_at = CURRENT_TIMESTAMP`
  ).run(
    input.scope_id,
    page.id,
    input.slug,
    input.path,
    input.page_type,
    input.title,
    JSON.stringify(input.frontmatter),
    JSON.stringify(input.aliases),
    JSON.stringify(input.tags),
    JSON.stringify(input.outgoing_wikilinks),
    JSON.stringify(input.outgoing_urls),
    JSON.stringify(input.source_refs),
    JSON.stringify(input.heading_index),
    input.content_hash,
    input.extractor_version,
  );

  return (await this.getNoteManifestEntry(input.scope_id, input.slug))!;
}
```

- [ ] **Step 4: Wire import and sync refresh**

Update `src/core/import-file.ts` after `putPage` succeeds:

```ts
import { buildNoteManifestEntry } from './services/note-manifest-service.ts';

const savedPage = await tx.putPage(slug, {
  type: parsed.type,
  title: parsed.title,
  compiled_truth: parsed.compiled_truth,
  timeline: parsed.timeline || '',
  frontmatter: parsed.frontmatter,
  content_hash: hash,
});

await tx.upsertNoteManifestEntry(buildNoteManifestEntry({
  pageId: savedPage.id,
  slug,
  path: slug + '.md',
  pageType: parsed.type,
  title: parsed.title,
  frontmatter: parsed.frontmatter,
  compiledTruth: parsed.compiled_truth,
  contentHash: hash,
}));
```

Update delete/rename handling in `src/commands/sync.ts`:

```ts
await engine.deletePage(slug);
await engine.deleteNoteManifestEntry('workspace:default', slug).catch(() => undefined);
```

Update rename path handling:

```ts
await engine.updateSlug(oldSlug, newSlug);
await engine.deleteNoteManifestEntry('workspace:default', oldSlug);
```

- [ ] **Step 5: Run the engine test to verify it passes**

Run:

```bash
bun test test/note-manifest-engine.test.ts
```

Expected: manifest refresh test passes.

- [ ] **Step 6: Commit**

```bash
git add test/note-manifest-engine.test.ts src/core/sqlite-engine.ts src/core/pglite-engine.ts src/core/postgres-engine.ts src/core/import-file.ts src/core/services/import-service.ts src/commands/sync.ts
git commit -m "feat: refresh note manifest from canonical writes"
```

---

### Task 4: Expose a minimal manifest inspection surface

**Files:**
- Create: `test/note-manifest-operations.test.ts`
- Modify: `src/core/operations.ts`
- Modify: `test/cli.test.ts`

- [ ] **Step 1: Write the failing shared-operation tests**

Create `test/note-manifest-operations.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';

test('note manifest operations are registered with CLI hints', () => {
  const getEntry = operations.find((operation) => operation.name === 'get_note_manifest_entry');
  const listEntries = operations.find((operation) => operation.name === 'list_note_manifest_entries');
  const rebuild = operations.find((operation) => operation.name === 'rebuild_note_manifest');

  expect(getEntry?.cliHints?.name).toBe('manifest-get');
  expect(listEntries?.cliHints?.name).toBe('manifest-list');
  expect(rebuild?.cliHints?.name).toBe('manifest-rebuild');
});
```

- [ ] **Step 2: Run the operation test to verify it fails**

Run:

```bash
bun test test/note-manifest-operations.test.ts
```

Expected: failure because the manifest operations do not exist yet.

- [ ] **Step 3: Add the shared operations**

Update `src/core/operations.ts` with:

```ts
const get_note_manifest_entry: Operation = {
  name: 'get_note_manifest_entry',
  description: 'Get one derived note-manifest entry by scope and slug.',
  params: {
    scope_id: { type: 'string', required: true, description: 'Manifest scope id.' },
    slug: { type: 'string', required: true, description: 'Canonical page slug.' },
  },
  handler: async (ctx, params) => {
    const entry = await ctx.engine.getNoteManifestEntry(params.scope_id as string, params.slug as string);
    if (!entry) throw new OperationError('page_not_found', `Manifest entry not found: ${params.slug}`);
    return entry;
  },
  cliHints: { name: 'manifest-get', positional: ['scope_id', 'slug'] },
};

const list_note_manifest_entries: Operation = {
  name: 'list_note_manifest_entries',
  description: 'List derived note-manifest entries for a scope.',
  params: {
    scope_id: { type: 'string', required: false, description: 'Manifest scope id.' },
    limit: { type: 'number', required: false, description: 'Maximum rows to return.' },
  },
  handler: async (ctx, params) => ctx.engine.listNoteManifestEntries({
    scope_id: params.scope_id as string | undefined,
    limit: params.limit as number | undefined,
  }),
  cliHints: { name: 'manifest-list', aliases: { n: 'limit' } },
};

const rebuild_note_manifest: Operation = {
  name: 'rebuild_note_manifest',
  description: 'Rebuild the derived note manifest from canonical pages.',
  params: {
    scope_id: { type: 'string', required: false, description: 'Manifest scope id.' },
  },
  handler: async (ctx, params) => rebuildNoteManifest(ctx.engine, params.scope_id as string | undefined),
  cliHints: { name: 'manifest-rebuild' },
};
```

- [ ] **Step 4: Add one CLI smoke test**

Append to `test/cli.test.ts`:

```ts
test('manifest-list --help is exposed', async () => {
  const proc = spawnSync(['bun', 'run', 'src/cli.ts', 'manifest-list', '--help'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  expect(proc.exitCode).toBe(0);
  expect(new TextDecoder().decode(proc.stdout)).toContain('Usage: mbrain manifest-list');
});
```

- [ ] **Step 5: Run the operation and CLI tests**

Run:

```bash
bun test test/note-manifest-operations.test.ts
bun test test/cli.test.ts -t "manifest-list --help"
```

Expected: both tests pass.

- [ ] **Step 6: Commit**

```bash
git add test/note-manifest-operations.test.ts test/cli.test.ts src/core/operations.ts
git commit -m "feat: add note manifest inspection operations"
```

---

### Task 5: Add Phase 2 benchmark and verification hooks

**Files:**
- Create: `scripts/bench/phase2-note-manifest.ts`
- Create: `test/phase2-note-manifest.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`

- [ ] **Step 1: Write the failing benchmark test**

Create `test/phase2-note-manifest.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'bun';

describe('phase2 note-manifest benchmark', () => {
  test('--json prints a benchmark report shape', () => {
    const proc = spawnSync(['bun', 'run', 'scripts/bench/phase2-note-manifest.ts', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const payload = JSON.parse(new TextDecoder().decode(proc.stdout));
    expect(payload.workloads.map((workload: any) => workload.name).sort()).toEqual([
      'heading_lookup',
      'manifest_projection',
      'manifest_rebuild',
      'wikilink_resolution',
    ]);
    expect(payload.acceptance.readiness_status).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the benchmark test to verify it fails**

Run:

```bash
bun test test/phase2-note-manifest.test.ts
```

Expected: failure because the benchmark script does not exist yet.

- [ ] **Step 3: Add the benchmark runner**

Create `scripts/bench/phase2-note-manifest.ts` with the same local SQLite execution style as Phase 1:

```ts
#!/usr/bin/env bun

import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { performance } from 'perf_hooks';
import { createLocalConfigDefaults } from '../../src/core/config.ts';
import { createConnectedEngine } from '../../src/core/engine-factory.ts';
import { importFromContent } from '../../src/core/import-file.ts';

const args = new Set(process.argv.slice(2));
if (args.has('--help')) {
  console.log('Usage: bun run scripts/bench/phase2-note-manifest.ts [--json]');
  process.exit(0);
}

// Seed canonical pages, rebuild/list manifest entries, and emit measured workloads.
```

Measure at minimum:

- `manifest_rebuild`
- `heading_lookup`
- `wikilink_resolution`
- `manifest_projection`

- [ ] **Step 4: Wire package and verification docs**

Update `package.json`:

```json
{
  "scripts": {
    "bench:phase2": "bun run ./scripts/bench/phase2-note-manifest.ts"
  }
}
```

Update `docs/MBRAIN_VERIFY.md`:

```md
## Phase 2 note-manifest benchmark

Run:

```bash
bun run bench:phase2 --json
```

Expected:

- manifest workloads report measurable rebuild and lookup latency
- manifest correctness stays deterministic on the published fixture workload
- readiness stays local/offline and does not weaken Markdown-first retrieval
```
```

- [ ] **Step 5: Run the benchmark test and the Phase 2 command**

Run:

```bash
bun test test/phase2-note-manifest.test.ts
bun run bench:phase2 --json
```

Expected: benchmark test passes and the command prints a JSON payload with `workloads` and `acceptance`.

- [ ] **Step 6: Commit**

```bash
git add scripts/bench/phase2-note-manifest.ts test/phase2-note-manifest.test.ts package.json docs/MBRAIN_VERIFY.md
git commit -m "test: add phase2 note manifest benchmark"
```

---

## Self-review checklist

- Phase 2 scope stays limited to `Note Manifest` and deterministic extraction.
- The plan does not smuggle in semantic graphs, atlas behavior, or governance-state changes.
- Every new durable artifact is explicitly derived from canonical page state.
- Import and sync remain the first refresh triggers.
- The first public surface is inspection-only and does not over-commit Phase 3 routing behavior.
- Benchmark and acceptance hooks exist before broader Phase 2 claims are made.
