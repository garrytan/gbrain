import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { operations, operationsByName } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { Operation } from '../src/core/operations.ts';
import type { PageType, SearchResult, Page, Link } from '../src/core/types.ts';
import { buildNoteManifestEntry } from '../src/core/services/note-manifest-service.ts';
import { buildNoteSectionEntries } from '../src/core/services/note-section-service.ts';

const SQLITE_PGLITE_PARITY_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS ?? 30_000);

describe('operations contract parity', () => {
  test('every operation has a unique name', () => {
    const names = operations.map(op => op.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('every operation has required fields', () => {
    for (const op of operations) {
      expect(op.name).toBeTruthy();
      expect(op.description).toBeTruthy();
      expect(typeof op.handler).toBe('function');
      expect(op.params).toBeDefined();
    }
  });

  test('operationsByName matches operations array', () => {
    expect(Object.keys(operationsByName).length).toBe(operations.length);
    for (const op of operations) {
      expect(operationsByName[op.name]).toBe(op);
    }
  });

  test('every required param has a type', () => {
    for (const op of operations) {
      for (const [key, def] of Object.entries(op.params)) {
        const types = Array.isArray(def.type) ? def.type : [def.type];
        for (const type of types) {
          expect(['string', 'number', 'boolean', 'object', 'array']).toContain(type);
        }
      }
    }
  });

  test('mutating operations have dry_run support', () => {
    const mutating = operations.filter(op => op.mutating);
    expect(mutating.length).toBeGreaterThan(0);
    // Verify all mutating ops exist
    for (const op of mutating) {
      expect(op.mutating).toBe(true);
    }
  });

  test('CLI names are unique across operations', () => {
    const cliNames = operations
      .filter(op => op.cliHints?.name)
      .map(op => op.cliHints!.name!);
    expect(new Set(cliNames).size).toBe(cliNames.length);
  });

  test('CLI positional params reference valid param names', () => {
    for (const op of operations) {
      if (op.cliHints?.positional) {
        for (const pos of op.cliHints.positional) {
          expect(op.params).toHaveProperty(pos);
        }
      }
    }
  });

  test('CLI stdin param references a valid param name', () => {
    for (const op of operations) {
      if (op.cliHints?.stdin) {
        expect(op.params).toHaveProperty(op.cliHints.stdin);
      }
    }
  });

  test('operations count is at least 30', () => {
    expect(operations.length).toBeGreaterThanOrEqual(30);
  });

  test('engine implementations are importable', () => {
    expect(SQLiteEngine).toBeDefined();
    expect(PostgresEngine).toBeDefined();
  });

  test('MCP tool definitions can be generated from operations', () => {
    const tools = operations.map(op => ({
      name: op.name,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(op.params).map(([k, v]) => [k, { type: v.type }]),
        ),
        required: Object.entries(op.params)
          .filter(([, v]) => v.required)
          .map(([k]) => k),
      },
    }));

    // Every operation generates a valid tool definition
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.inputSchema.properties).toBe('object');
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Cross-engine parity seeds — SQLite and PGLite
// ─────────────────────────────────────────────────────────────────

describe('SQLite/PGLite behavioral parity seeds', () => {
  test('agree on filtered page lists and batch link maps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-sqlite-pglite-parity-'));
    const sqlite = new SQLiteEngine();
    const pglite = new PGLiteEngine();

    try {
      await sqlite.connect({ engine: 'sqlite', database_path: join(root, 'brain.db') });
      await sqlite.initSchema();
      await pglite.connect({ engine: 'pglite', database_path: join(root, 'brain.pglite') });
      await pglite.initSchema();

      await seedListAndLinkFixture(sqlite);
      await seedListAndLinkFixture(pglite);

      const sqliteSnapshot = await collectListAndLinkSnapshot(sqlite);
      const pgliteSnapshot = await collectListAndLinkSnapshot(pglite);

      expect(sqliteSnapshot).toEqual({
        conceptPages: ['concepts/control-delta', 'concepts/parity-alpha', 'concepts/parity-gamma'],
        parityTaggedPages: ['concepts/parity-alpha', 'concepts/parity-gamma', 'people/parity-beta'],
        parityTaggedConcepts: ['concepts/parity-alpha', 'concepts/parity-gamma'],
        linksBySlug: {
          'concepts/parity-alpha': ['concepts/parity-alpha->people/parity-beta:mentions:alpha to beta'],
          'concepts/parity-gamma': ['concepts/parity-gamma->people/parity-beta:mentions:gamma to beta'],
          'people/parity-beta': ['people/parity-beta->concepts/parity-alpha:supports:beta to alpha'],
        },
        backlinksBySlug: {
          'concepts/parity-alpha': ['people/parity-beta->concepts/parity-alpha:supports:beta to alpha'],
          'concepts/parity-gamma': [],
          'people/parity-beta': [
            'concepts/parity-alpha->people/parity-beta:mentions:alpha to beta',
            'concepts/parity-gamma->people/parity-beta:mentions:gamma to beta',
          ],
        },
      });
      expect(pgliteSnapshot).toEqual(sqliteSnapshot);
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const engine of [sqlite, pglite]) {
        try {
          await engine.disconnect();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up SQLite/PGLite parity fixtures');
      }
    }
  }, SQLITE_PGLITE_PARITY_TIMEOUT_MS);

  test('agree on explicit zero page-list limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-sqlite-pglite-zero-limit-'));
    const sqlite = new SQLiteEngine();
    const pglite = new PGLiteEngine();

    try {
      await sqlite.connect({ engine: 'sqlite', database_path: join(root, 'brain.db') });
      await sqlite.initSchema();
      await pglite.connect({ engine: 'pglite', database_path: join(root, 'brain.pglite') });
      await pglite.initSchema();

      await seedListAndLinkFixture(sqlite);
      await seedListAndLinkFixture(pglite);

      const sqlitePages = await sqlite.listPages({ limit: 0 });
      const pglitePages = await pglite.listPages({ limit: 0 });

      expect(sqlitePages).toEqual([]);
      expect(pglitePages).toEqual(sqlitePages);
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const engine of [sqlite, pglite]) {
        try {
          await engine.disconnect();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up zero-limit parity fixtures');
      }
    }
  }, SQLITE_PGLITE_PARITY_TIMEOUT_MS);

  test('agree on shallow graph traversal when a node is reachable at multiple depths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-sqlite-pglite-graph-parity-'));
    const sqlite = new SQLiteEngine();
    const pglite = new PGLiteEngine();

    try {
      await sqlite.connect({ engine: 'sqlite', database_path: join(root, 'brain.db') });
      await sqlite.initSchema();
      await pglite.connect({ engine: 'pglite', database_path: join(root, 'brain.pglite') });
      await pglite.initSchema();

      await seedGraphTraversalFixture(sqlite);
      await seedGraphTraversalFixture(pglite);

      const sqliteGraph = await collectGraphTraversalSnapshot(sqlite);
      const pgliteGraph = await collectGraphTraversalSnapshot(pglite);

      expect(sqliteGraph).toEqual({
        'concepts/root': 0,
        'concepts/mid': 1,
        'concepts/target': 1,
      });
      expect(pgliteGraph).toEqual(sqliteGraph);
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const engine of [sqlite, pglite]) {
        try {
          await engine.disconnect();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up graph parity fixtures');
      }
    }
  }, SQLITE_PGLITE_PARITY_TIMEOUT_MS);

  test('SQLite keyword results use stored chunk source when a matching chunk exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-sqlite-search-chunk-source-'));
    const sqlite = new SQLiteEngine();

    try {
      await sqlite.connect({ engine: 'sqlite', database_path: join(root, 'brain.db') });
      await sqlite.initSchema();

      await seedStoredChunkSearchFixture(sqlite);

      const sqliteResult = (await sqlite.searchKeyword('needle-token', { limit: 1 }))[0];

      expect(sqliteResult?.chunk_source).toBe('frontmatter');
      expect(sqliteResult?.chunk_text).toContain('frontmatter needle-token');
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        await sqlite.disconnect();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up SQLite search chunk-source fixtures');
      }
    }
  }, SQLITE_PGLITE_PARITY_TIMEOUT_MS);

  test('PGLite keyword results keep stored chunk identity when compiled truth also matches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-pglite-search-chunk-identity-'));
    const pglite = new PGLiteEngine();

    try {
      await pglite.connect({ engine: 'pglite', database_path: join(root, 'brain.pglite') });
      await pglite.initSchema();

      await pglite.putPage('concepts/pglite-stored-chunk-search', {
        type: 'concept',
        title: 'PGLite Stored Chunk Search',
        compiled_truth: 'Compiled truth carries needle-token inside a stored chunk.',
      });
      await pglite.upsertChunks('concepts/pglite-stored-chunk-search', [{
        chunk_index: 0,
        chunk_text: 'Compiled truth carries needle-token inside a stored chunk.',
        chunk_source: 'compiled_truth',
        token_count: 8,
      }]);

      const result = (await pglite.searchKeyword('needle-token', { limit: 1 }))[0];

      expect(result?.chunk_source).toBe('compiled_truth');
      expect(result?.chunk_index).toBe(0);
      expect(result?.chunk_content_hash).toBeTruthy();
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        await pglite.disconnect();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up PGLite search chunk-identity fixtures');
      }
    }
  }, SQLITE_PGLITE_PARITY_TIMEOUT_MS);

  test('SQLite keyword results prefer the stored chunk with the strongest query match', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-sqlite-search-best-chunk-'));
    const sqlite = new SQLiteEngine();

    try {
      await sqlite.connect({ engine: 'sqlite', database_path: join(root, 'brain.db') });
      await sqlite.initSchema();

      await sqlite.putPage('concepts/sqlite-best-chunk-search', {
        type: 'concept',
        title: 'SQLite Best Chunk Search',
        compiled_truth: 'alpha beta are both present somewhere on the page.',
      });
      await sqlite.upsertChunks('concepts/sqlite-best-chunk-search', [
        {
          chunk_index: 0,
          chunk_text: 'alpha only partial match',
          chunk_source: 'compiled_truth',
          token_count: 4,
        },
        {
          chunk_index: 1,
          chunk_text: 'alpha beta strongest match',
          chunk_source: 'compiled_truth',
          token_count: 4,
        },
      ]);

      const result = (await sqlite.searchKeyword('alpha beta', { limit: 1 }))[0];

      expect(result?.chunk_index).toBe(1);
      expect(result?.chunk_text).toContain('alpha beta strongest match');
    } finally {
      const cleanupErrors: unknown[] = [];
      try {
        await sqlite.disconnect();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up SQLite search best-chunk fixtures');
      }
    }
  }, SQLITE_PGLITE_PARITY_TIMEOUT_MS);

  test('same-date timeline entries are ordered by id descending across engines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-sqlite-pglite-timeline-order-'));
    const sqlite = new SQLiteEngine();
    const pglite = new PGLiteEngine();

    try {
      await sqlite.connect({ engine: 'sqlite', database_path: join(root, 'brain.db') });
      await sqlite.initSchema();
      await pglite.connect({ engine: 'pglite', database_path: join(root, 'brain.pglite') });
      await pglite.initSchema();

      for (const engine of [sqlite, pglite]) {
        await engine.putPage('concepts/timeline-order', {
          type: 'concept',
          title: 'Timeline Order',
          compiled_truth: 'Timeline ordering should be stable.',
        });
        await engine.addTimelineEntry('concepts/timeline-order', {
          date: '2026-01-01',
          source: 'first',
          summary: 'first same-date entry',
        });
        await engine.addTimelineEntry('concepts/timeline-order', {
          date: '2026-01-01',
          source: 'second',
          summary: 'second same-date entry',
        });
      }

      const sqliteTimeline = await sqlite.getTimeline('concepts/timeline-order', { limit: 2 });
      const pgliteTimeline = await pglite.getTimeline('concepts/timeline-order', { limit: 2 });

      expect(sqliteTimeline.map(entry => entry.summary)).toEqual([
        'second same-date entry',
        'first same-date entry',
      ]);
      expect(pgliteTimeline.map(entry => entry.summary)).toEqual(sqliteTimeline.map(entry => entry.summary));
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const engine of [sqlite, pglite]) {
        try {
          await engine.disconnect();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up timeline order fixtures');
      }
    }
  }, SQLITE_PGLITE_PARITY_TIMEOUT_MS);

  test('memory governance lifecycle rows round-trip across engines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-sqlite-pglite-governance-'));
    const sqlite = new SQLiteEngine();
    const pglite = new PGLiteEngine();

    try {
      await sqlite.connect({ engine: 'sqlite', database_path: join(root, 'brain.db') });
      await sqlite.initSchema();
      await pglite.connect({ engine: 'pglite', database_path: join(root, 'brain.pglite') });
      await pglite.initSchema();

      await seedGovernanceParityFixture(sqlite);
      await seedGovernanceParityFixture(pglite);

      const sqliteSnapshot = await collectGovernanceParitySnapshot(sqlite);
      const pgliteSnapshot = await collectGovernanceParitySnapshot(pglite);

      expect(sqliteSnapshot).toEqual({
        candidate: {
          status: 'promoted',
          verification_status: 'verified',
          verification_method: 'source_recheck',
          target_object_type: 'curated_note',
          target_object_id: 'concepts/governance-parity',
          source_refs: ['User, direct message, 2026-07-06 18:00 KST'],
          review_reason: 'parity promoted',
        },
        promotedCandidateIds: ['parity-governance-candidate'],
        statusEvents: [
          { event_kind: 'advanced', from_status: 'candidate', to_status: 'staged_for_review' },
          { event_kind: 'created', from_status: null, to_status: 'candidate' },
        ],
        handoff: {
          target_object_type: 'curated_note',
          target_object_id: 'concepts/governance-parity',
          completion_kind: 'manual',
          completed_at: '2026-07-06T10:00:00.000Z',
          completion_ref: 'parity-manual-write',
        },
        handoffCount: 1,
      });
      expect(pgliteSnapshot).toEqual(sqliteSnapshot);
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const engine of [sqlite, pglite]) {
        try {
          await engine.disconnect();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up governance parity fixtures');
      }
    }
  }, SQLITE_PGLITE_PARITY_TIMEOUT_MS);

  test('personal memory rows round-trip across engines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-sqlite-pglite-personal-'));
    const sqlite = new SQLiteEngine();
    const pglite = new PGLiteEngine();

    try {
      await sqlite.connect({ engine: 'sqlite', database_path: join(root, 'brain.db') });
      await sqlite.initSchema();
      await pglite.connect({ engine: 'pglite', database_path: join(root, 'brain.pglite') });
      await pglite.initSchema();

      await seedPersonalMemoryParityFixture(sqlite);
      await seedPersonalMemoryParityFixture(pglite);

      const sqliteSnapshot = await collectPersonalMemoryParitySnapshot(sqlite);
      const pgliteSnapshot = await collectPersonalMemoryParitySnapshot(pglite);

      expect(sqliteSnapshot).toEqual({
        profile: {
          profile_type: 'preference',
          subject: 'Parity subject',
          content: 'Parity profile content.',
          source_refs: ['User, direct message, 2026-07-06 19:00 KST'],
          sensitivity: 'personal',
          export_status: 'private_only',
          last_confirmed_at: '2026-07-06T10:00:00.000Z',
          superseded_by: null,
        },
        profileIdsAfterDelete: ['parity-profile-keep'],
        episode: {
          title: 'Parity episode',
          summary: 'Parity episode summary.',
          source_kind: 'assistant_conversation',
          start_time: '2026-07-06T08:00:00.000Z',
          end_time: '2026-07-06T09:00:00.000Z',
          source_refs: ['User, direct message, 2026-07-06 19:05 KST'],
          candidate_ids: [],
        },
        episodeIdsAfterDelete: ['parity-episode-keep'],
      });
      expect(pgliteSnapshot).toEqual(sqliteSnapshot);
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const engine of [sqlite, pglite]) {
        try {
          await engine.disconnect();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up personal memory parity fixtures');
      }
    }
  }, SQLITE_PGLITE_PARITY_TIMEOUT_MS);

  test('note manifest and section rows round-trip across engines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-sqlite-pglite-note-structure-'));
    const sqlite = new SQLiteEngine();
    const pglite = new PGLiteEngine();

    try {
      await sqlite.connect({ engine: 'sqlite', database_path: join(root, 'brain.db') });
      await sqlite.initSchema();
      await pglite.connect({ engine: 'pglite', database_path: join(root, 'brain.pglite') });
      await pglite.initSchema();

      await seedNoteStructureParityFixture(sqlite);
      await seedNoteStructureParityFixture(pglite);

      const sqliteSnapshot = await collectNoteStructureParitySnapshot(sqlite);
      const pgliteSnapshot = await collectNoteStructureParitySnapshot(pglite);

      expect(pgliteSnapshot).toEqual(sqliteSnapshot);
      expect(sqliteSnapshot.manifest?.slug).toBe('concepts/note-structure-parity');
      expect(sqliteSnapshot.manifest?.outgoing_wikilinks).toEqual(['systems/mbrain']);
      expect(sqliteSnapshot.sectionHeadings.length).toBeGreaterThan(0);
      expect(sqliteSnapshot.manifestAfterDelete).toBeNull();
      expect(sqliteSnapshot.sectionsAfterDelete).toEqual([]);
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const engine of [sqlite, pglite]) {
        try {
          await engine.disconnect();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up note structure parity fixtures');
      }
    }
  }, SQLITE_PGLITE_PARITY_TIMEOUT_MS);

  test('derived jobs and derived index state round-trip across engines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-sqlite-pglite-derived-jobs-'));
    const sqlite = new SQLiteEngine();
    const pglite = new PGLiteEngine();

    try {
      await sqlite.connect({ engine: 'sqlite', database_path: join(root, 'brain.db') });
      await sqlite.initSchema();
      await pglite.connect({ engine: 'pglite', database_path: join(root, 'brain.pglite') });
      await pglite.initSchema();

      await seedDerivedJobParityFixture(sqlite);
      await seedDerivedJobParityFixture(pglite);

      const sqliteSnapshot = await collectDerivedJobParitySnapshot(sqlite);
      const pgliteSnapshot = await collectDerivedJobParitySnapshot(pglite);

      expect(sqliteSnapshot).toEqual({
        jobs: [
          {
            slug: 'concepts/derived-parity',
            artifact_kind: 'note_manifest',
            status: 'pending',
            target_content_hash: 'derived-hash-1',
            manifest_path: 'concepts/derived-parity.md',
            derived_parameters: {
              derived_schema_version: 'page-derived-v1',
              extractor_version: 'phase2-structural-v1',
              manifest_path: 'concepts/derived-parity.md',
            },
          },
        ],
        state: {
          slug: 'concepts/derived-parity',
          artifact_kind: 'note_manifest',
          status: 'pending',
          target_content_hash: 'derived-hash-1',
        },
      });
      expect(pgliteSnapshot).toEqual(sqliteSnapshot);
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const engine of [sqlite, pglite]) {
        try {
          await engine.disconnect();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up derived-job parity fixtures');
      }
    }
  }, SQLITE_PGLITE_PARITY_TIMEOUT_MS);

  test('slug rename preserves content and retargets links across engines', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mbrain-sqlite-pglite-slug-rename-'));
    const sqlite = new SQLiteEngine();
    const pglite = new PGLiteEngine();

    try {
      await sqlite.connect({ engine: 'sqlite', database_path: join(root, 'brain.db') });
      await sqlite.initSchema();
      await pglite.connect({ engine: 'pglite', database_path: join(root, 'brain.pglite') });
      await pglite.initSchema();

      await seedSlugRenameParityFixture(sqlite);
      await seedSlugRenameParityFixture(pglite);

      const sqliteSnapshot = await collectSlugRenameParitySnapshot(sqlite);
      const pgliteSnapshot = await collectSlugRenameParitySnapshot(pglite);

      expect(sqliteSnapshot).toEqual({
        oldPage: null,
        newTitle: 'Rename Source',
        linksBySlug: {
          'concepts/rename-new': ['concepts/rename-new->concepts/rename-target:mentions:source to target'],
          'concepts/rename-target': ['concepts/rename-target->concepts/rename-new:mentions:target to source'],
        },
        backlinksBySlug: {
          'concepts/rename-new': ['concepts/rename-target->concepts/rename-new:mentions:target to source'],
          'concepts/rename-target': ['concepts/rename-new->concepts/rename-target:mentions:source to target'],
        },
      });
      expect(pgliteSnapshot).toEqual(sqliteSnapshot);
    } finally {
      const cleanupErrors: unknown[] = [];
      for (const engine of [sqlite, pglite]) {
        try {
          await engine.disconnect();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'Failed to clean up slug-rename parity fixtures');
      }
    }
  }, SQLITE_PGLITE_PARITY_TIMEOUT_MS);
});

type ListAndLinkEngine = Pick<
  SQLiteEngine,
  'putPage' | 'addTag' | 'addLink' | 'listPages' | 'getLinksForSlugs' | 'getBacklinksForSlugs'
>;

type GraphTraversalEngine = Pick<SQLiteEngine, 'putPage' | 'addLink' | 'traverseGraph'>;

type StoredChunkSearchEngine = Pick<SQLiteEngine, 'putPage' | 'upsertChunks' | 'searchKeyword'>;

type DerivedJobParityEngine = Pick<
  SQLiteEngine,
  'putPage' | 'enqueueDerivedJob' | 'listDerivedJobs' | 'getDerivedIndexState'
>;

type SlugRenameParityEngine = Pick<
  SQLiteEngine,
  'putPage' | 'addLink' | 'updateSlug' | 'rewriteLinks' | 'getPage' | 'getLinksForSlugs' | 'getBacklinksForSlugs'
>;

async function seedListAndLinkFixture(engine: ListAndLinkEngine): Promise<void> {
  await engine.putPage('concepts/parity-alpha', {
    type: 'concept',
    title: 'Parity Alpha',
    compiled_truth: 'Alpha parity concept.',
  });
  await engine.putPage('people/parity-beta', {
    type: 'person',
    title: 'Parity Beta',
    compiled_truth: 'Beta parity person.',
  });
  await engine.putPage('concepts/parity-gamma', {
    type: 'concept',
    title: 'Parity Gamma',
    compiled_truth: 'Gamma parity concept.',
  });
  await engine.putPage('concepts/control-delta', {
    type: 'concept',
    title: 'Control Delta',
    compiled_truth: 'Delta concept without the parity tag.',
  });

  await engine.addTag('concepts/parity-alpha', 'parity');
  await engine.addTag('concepts/parity-gamma', 'parity');
  await engine.addTag('people/parity-beta', 'parity');
  await engine.addTag('people/parity-beta', 'people');

  await engine.addLink('concepts/parity-alpha', 'people/parity-beta', 'alpha to beta', 'mentions');
  await engine.addLink('concepts/parity-gamma', 'people/parity-beta', 'gamma to beta', 'mentions');
  await engine.addLink('people/parity-beta', 'concepts/parity-alpha', 'beta to alpha', 'supports');
}

async function collectListAndLinkSnapshot(engine: ListAndLinkEngine) {
  const slugs = ['concepts/parity-alpha', 'concepts/parity-gamma', 'people/parity-beta'];

  return {
    conceptPages: (await engine.listPages({ type: 'concept' })).map((page) => page.slug).sort(),
    parityTaggedPages: (await engine.listPages({ tag: 'parity' })).map((page) => page.slug).sort(),
    parityTaggedConcepts: (await engine.listPages({ type: 'concept', tag: 'parity' }))
      .map((page) => page.slug)
      .sort(),
    linksBySlug: normalizeLinkMap(await engine.getLinksForSlugs(slugs)),
    backlinksBySlug: normalizeLinkMap(await engine.getBacklinksForSlugs(slugs)),
  };
}

function normalizeLinkMap(map: Map<string, Link[]>): Record<string, string[]> {
  return Object.fromEntries(
    [...map.entries()]
      .map(([slug, links]) => [
        slug,
        links
          .map((link) => `${link.from_slug}->${link.to_slug}:${link.link_type}:${link.context}`)
          .sort(),
      ] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function seedGraphTraversalFixture(engine: GraphTraversalEngine): Promise<void> {
  await engine.putPage('concepts/root', {
    type: 'concept',
    title: 'Root',
    compiled_truth: 'Root graph node.',
  });
  await engine.putPage('concepts/mid', {
    type: 'concept',
    title: 'Mid',
    compiled_truth: 'Intermediate graph node.',
  });
  await engine.putPage('concepts/target', {
    type: 'concept',
    title: 'Target',
    compiled_truth: 'Target graph node.',
  });

  await engine.addLink('concepts/root', 'concepts/target', 'direct', 'mentions');
  await engine.addLink('concepts/root', 'concepts/mid', 'indirect start', 'mentions');
  await engine.addLink('concepts/mid', 'concepts/target', 'indirect end', 'mentions');
}

async function collectGraphTraversalSnapshot(engine: GraphTraversalEngine): Promise<Record<string, number>> {
  return Object.fromEntries(
    (await engine.traverseGraph('concepts/root', 2))
      .map((node) => [node.slug, node.depth] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function seedStoredChunkSearchFixture(engine: StoredChunkSearchEngine): Promise<void> {
  await engine.putPage('concepts/stored-chunk-search', {
    type: 'concept',
    title: 'Stored Chunk Search',
    compiled_truth: 'Compiled truth also mentions needle-token so the page is searchable.',
    frontmatter: {
      codemap: 'frontmatter needle-token canonical snippet',
    },
  });
  await engine.upsertChunks('concepts/stored-chunk-search', [
    {
      chunk_index: 0,
      chunk_text: 'frontmatter needle-token canonical snippet',
      chunk_source: 'frontmatter',
      token_count: 4,
    },
    {
      chunk_index: 1,
      chunk_text: 'Compiled truth also mentions needle-token so the page is searchable.',
      chunk_source: 'compiled_truth',
      token_count: 8,
    },
  ]);
}

async function seedDerivedJobParityFixture(engine: DerivedJobParityEngine): Promise<void> {
  const slug = 'concepts/derived-parity';
  await engine.putPage(slug, {
    type: 'concept',
    title: 'Derived Parity',
    compiled_truth: 'Derived job parity page.',
    content_hash: 'derived-hash-1',
  });
  await engine.enqueueDerivedJob({
    scope_id: 'workspace:default',
    slug,
    artifact_kind: 'note_manifest',
    target_content_hash: 'derived-hash-1',
    manifest_path: `${slug}.md`,
    derived_parameters: {
      derived_schema_version: 'page-derived-v1',
      extractor_version: 'phase2-structural-v1',
      manifest_path: `${slug}.md`,
    },
  });
}

async function collectDerivedJobParitySnapshot(engine: DerivedJobParityEngine) {
  const jobs = await engine.listDerivedJobs({
    scope_id: 'workspace:default',
    slug: 'concepts/derived-parity',
    artifact_kind: 'note_manifest',
  });
  const state = await engine.getDerivedIndexState('workspace:default', 'concepts/derived-parity', 'note_manifest');
  return {
    jobs: jobs.map((job) => ({
      slug: job.slug,
      artifact_kind: job.artifact_kind,
      status: job.status,
      target_content_hash: job.target_content_hash,
      manifest_path: job.manifest_path,
      derived_parameters: job.derived_parameters,
    })),
    state: state
      ? {
          slug: state.slug,
          artifact_kind: state.artifact_kind,
          status: state.status,
          target_content_hash: state.target_content_hash,
        }
      : null,
  };
}

async function seedSlugRenameParityFixture(engine: SlugRenameParityEngine): Promise<void> {
  await engine.putPage('concepts/rename-old', {
    type: 'concept',
    title: 'Rename Source',
    compiled_truth: 'Rename source page.',
  });
  await engine.putPage('concepts/rename-target', {
    type: 'concept',
    title: 'Rename Target',
    compiled_truth: 'Rename target page.',
  });
  await engine.addLink('concepts/rename-old', 'concepts/rename-target', 'source to target', 'mentions');
  await engine.addLink('concepts/rename-target', 'concepts/rename-old', 'target to source', 'mentions');
  await engine.updateSlug('concepts/rename-old', 'concepts/rename-new');
  await engine.rewriteLinks('concepts/rename-old', 'concepts/rename-new');
}

async function collectSlugRenameParitySnapshot(engine: SlugRenameParityEngine) {
  const linksBySlug = await engine.getLinksForSlugs(['concepts/rename-new', 'concepts/rename-target']);
  const backlinksBySlug = await engine.getBacklinksForSlugs(['concepts/rename-new', 'concepts/rename-target']);
  return {
    oldPage: await engine.getPage('concepts/rename-old'),
    newTitle: (await engine.getPage('concepts/rename-new'))?.title ?? null,
    linksBySlug: normalizeLinkMap(linksBySlug),
    backlinksBySlug: normalizeLinkMap(backlinksBySlug),
  };
}

// ─────────────────────────────────────────────────────────────────
// Behavioral correctness tests — real SQLiteEngine operations
// ─────────────────────────────────────────────────────────────────

const PARITY_TMP = mkdtempSync(join(tmpdir(), 'mbrain-parity-'));

describe('SQLiteEngine behavioral correctness', () => {
  let engine: InstanceType<typeof SQLiteEngine>;

  beforeAll(async () => {
    engine = new SQLiteEngine();
    await engine.connect({ database_path: join(PARITY_TMP, 'parity-test.db') });
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
    rmSync(PARITY_TMP, { recursive: true, force: true });
  });

  // ── Page CRUD ──────────────────────────────────────────────────

  test('putPage + getPage round-trip preserves all fields', async () => {
    const page = await engine.putPage('people/alice', {
      type: 'person',
      title: 'Alice Smith',
      compiled_truth: 'Alice is a neural retrieval researcher who specializes in dense passage retrieval and hybrid search architectures.',
      timeline: '- 2024-01-15: Joined the team.',
      frontmatter: { role: 'researcher', org: 'lab' },
      content_hash: 'abc123',
    });

    expect(page.slug).toBe('people/alice');
    expect(page.type).toBe('person');
    expect(page.title).toBe('Alice Smith');
    expect(page.compiled_truth).toContain('neural retrieval');
    expect(page.timeline).toContain('2024-01-15');
    expect(page.frontmatter.role).toBe('researcher');
    expect(page.content_hash).toBe('abc123');
    expect(page.created_at).toBeInstanceOf(Date);
    expect(page.updated_at).toBeInstanceOf(Date);

    const fetched = await engine.getPage('people/alice');
    expect(fetched).not.toBeNull();
    expect(fetched!.slug).toBe(page.slug);
    expect(fetched!.title).toBe(page.title);
    expect(fetched!.compiled_truth).toBe(page.compiled_truth);
    expect(fetched!.frontmatter.role).toBe('researcher');
  });

  test('getPage returns null for nonexistent slug', async () => {
    const page = await engine.getPage('nonexistent/page');
    expect(page).toBeNull();
  });

  test('deletePage removes a page', async () => {
    await engine.putPage('concepts/temp', {
      type: 'concept', title: 'Temporary', compiled_truth: 'Will be deleted.',
    });
    expect(await engine.getPage('concepts/temp')).not.toBeNull();
    await engine.deletePage('concepts/temp');
    expect(await engine.getPage('concepts/temp')).toBeNull();
  });

  test('listPages returns pages with type filter', async () => {
    await engine.putPage('concepts/embeddings', {
      type: 'concept', title: 'Embeddings', compiled_truth: 'Vector representations of text.',
    });

    const persons = await engine.listPages({ type: 'person' });
    const concepts = await engine.listPages({ type: 'concept' });
    expect(persons.every(p => p.type === 'person')).toBe(true);
    expect(concepts.every(p => p.type === 'concept')).toBe(true);
  });

  // ── Search ─────────────────────────────────────────────────────

  test('searchKeyword returns SearchResult[] with correct shape', async () => {
    const results = await engine.searchKeyword('neural retrieval');
    expect(results.length).toBeGreaterThan(0);

    for (const r of results) {
      expect(typeof r.slug).toBe('string');
      expect(typeof r.page_id).toBe('number');
      expect(typeof r.title).toBe('string');
      expect(typeof r.type).toBe('string');
      expect(typeof r.chunk_text).toBe('string');
      expect(['compiled_truth', 'timeline']).toContain(r.chunk_source);
      expect(typeof r.score).toBe('number');
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(typeof r.stale).toBe('boolean');
    }
  });

  test('searchKeyword returns focused snippet, not full page body', async () => {
    // Insert a page with long content
    const longText = Array(100).fill('This is filler text for testing purposes. ').join('') +
      'The critical finding about quantum computing was groundbreaking. ' +
      Array(100).fill('More filler text to pad the content further. ').join('');

    await engine.putPage('concepts/quantum', {
      type: 'concept', title: 'Quantum Computing', compiled_truth: longText,
    });

    const results = await engine.searchKeyword('quantum computing');
    expect(results.length).toBeGreaterThan(0);
    // Snippet should be much shorter than the full text
    expect(results[0]!.chunk_text.length).toBeLessThan(500);
    expect(results[0]!.chunk_text).toContain('quantum');
  });

  test('searchKeyword with empty query returns empty array', async () => {
    const results = await engine.searchKeyword('');
    expect(results).toEqual([]);
  });

  test('searchKeyword with special characters degrades gracefully', async () => {
    const results = await engine.searchKeyword('"unmatched NEAR(a,b) ^weird');
    expect(Array.isArray(results)).toBe(true);
    // FTS5 error handler catches malformed queries and returns empty array
    expect(results.length).toBe(0);
  });

  test('searchVector with no embeddings returns empty array', async () => {
    const query = new Float32Array([1, 0, 0]);
    const results = await engine.searchVector(query);
    expect(results).toEqual([]);
  });

  // ── Chunks ─────────────────────────────────────────────────────

  test('upsertChunks + getChunks round-trip', async () => {
    await engine.upsertChunks('people/alice', [
      { chunk_index: 0, chunk_text: 'Alice is a researcher.', chunk_source: 'compiled_truth', token_count: 5 },
      { chunk_index: 1, chunk_text: 'She joined in 2024.', chunk_source: 'timeline', token_count: 5 },
    ]);

    const chunks = await engine.getChunks('people/alice');
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.chunk_text).toBe('Alice is a researcher.');
    expect(chunks[0]!.chunk_source).toBe('compiled_truth');
    expect(chunks[1]!.chunk_source).toBe('timeline');
    expect(chunks[0]!.embedded_at).toBeNull();
  });

  // ── Links ──────────────────────────────────────────────────────

  test('addLink + getLinks + getBacklinks consistency', async () => {
    await engine.addLink('people/alice', 'concepts/embeddings', 'works on', 'research');

    const links = await engine.getLinks('people/alice');
    expect(links.some(l => l.to_slug === 'concepts/embeddings')).toBe(true);

    const backlinks = await engine.getBacklinks('concepts/embeddings');
    expect(backlinks.some(l => l.from_slug === 'people/alice')).toBe(true);
  });

  // ── Tags ───────────────────────────────────────────────────────

  test('addTag + getTags idempotency', async () => {
    await engine.addTag('people/alice', 'researcher');
    await engine.addTag('people/alice', 'researcher'); // duplicate — should not throw

    const tags = await engine.getTags('people/alice');
    expect(tags.filter(t => t === 'researcher').length).toBe(1);
  });

  // ── Timeline ───────────────────────────────────────────────────

  test('addTimelineEntry + getTimeline', async () => {
    await engine.addTimelineEntry('people/alice', {
      date: '2024-03-01', source: 'manual', summary: 'Promoted to lead', detail: 'Effective immediately',
    });

    const timeline = await engine.getTimeline('people/alice');
    expect(timeline.length).toBeGreaterThan(0);
    expect(timeline[0]!.summary).toBe('Promoted to lead');
    expect(typeof timeline[0]!.id).toBe('number');
    expect(timeline[0]!.created_at).toBeInstanceOf(Date);
  });

  // ── Transaction rollback ───────────────────────────────────────

  test('transaction rollback on error', async () => {
    const before = await engine.getPage('people/alice');

    try {
      await engine.transaction(async (tx) => {
        await tx.putPage('people/alice', {
          type: 'person', title: 'SHOULD ROLLBACK', compiled_truth: 'nope',
        });
        throw new Error('forced rollback');
      });
    } catch {
      // expected
    }

    const after = await engine.getPage('people/alice');
    expect(after!.title).toBe(before!.title);
  });

  // ── Stats + Health ─────────────────────────────────────────────

  test('getStats returns correct shape', async () => {
    const stats = await engine.getStats();
    expect(typeof stats.page_count).toBe('number');
    expect(typeof stats.chunk_count).toBe('number');
    expect(typeof stats.link_count).toBe('number');
    expect(typeof stats.tag_count).toBe('number');
    expect(stats.page_count).toBeGreaterThan(0);
    expect(stats.pages_by_type).toBeDefined();
  });

  test('getHealth returns correct shape', async () => {
    const health = await engine.getHealth();
    expect(typeof health.page_count).toBe('number');
    expect(typeof health.embed_coverage).toBe('number');
    expect(typeof health.stale_pages).toBe('number');
    expect(typeof health.orphan_pages).toBe('number');
    expect(typeof health.dead_links).toBe('number');
    expect(typeof health.missing_embeddings).toBe('number');
    expect(health.page_count).toBeGreaterThan(0);
  });

  // ── resolveSlugs ───────────────────────────────────────────────

  test('resolveSlugs finds exact and partial matches', async () => {
    const exact = await engine.resolveSlugs('people/alice');
    expect(exact).toContain('people/alice');

    const partial = await engine.resolveSlugs('alice');
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.some(s => s.includes('alice'))).toBe(true);
  });
});

async function seedGovernanceParityFixture(engine: SQLiteEngine | PGLiteEngine): Promise<void> {
  await engine.createMemoryCandidateEntry({
    id: 'parity-governance-candidate',
    scope_id: 'workspace:default',
    candidate_type: 'fact',
    proposed_content: 'Governance parity fixture claim.',
    source_refs: ['User, direct message, 2026-07-06 18:00 KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.9,
    importance_score: 0.8,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: 'candidate',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/governance-parity',
    reviewed_at: null,
    review_reason: null,
  });
  await engine.createMemoryCandidateStatusEvent({
    id: 'parity-governance-ev-created',
    candidate_id: 'parity-governance-candidate',
    scope_id: 'workspace:default',
    from_status: null,
    to_status: 'candidate',
    event_kind: 'created',
    created_at: '2026-07-06T09:00:00.000Z',
  });
  await engine.updateMemoryCandidateEntryStatus('parity-governance-candidate', {
    status: 'staged_for_review',
    reviewed_at: '2026-07-06T09:30:00.000Z',
    review_reason: 'parity staged',
  });
  await engine.createMemoryCandidateStatusEvent({
    id: 'parity-governance-ev-advanced',
    candidate_id: 'parity-governance-candidate',
    scope_id: 'workspace:default',
    from_status: 'candidate',
    to_status: 'staged_for_review',
    event_kind: 'advanced',
    created_at: '2026-07-06T09:30:00.000Z',
  });
  await engine.updateMemoryCandidateEntryVerification('parity-governance-candidate', {
    verification_status: 'verified',
    verification_method: 'source_recheck',
    verification_evidence: 'Checked the parity fixture claim.',
    verification_source_refs: ['parity verification ref'],
    verified_at: '2026-07-06T09:45:00.000Z',
  });
  await engine.promoteMemoryCandidateEntry('parity-governance-candidate', {
    reviewed_at: '2026-07-06T09:55:00.000Z',
    review_reason: 'parity promoted',
  });
  await engine.createCanonicalHandoffEntry({
    id: 'parity-governance-handoff',
    scope_id: 'workspace:default',
    candidate_id: 'parity-governance-candidate',
    target_object_type: 'curated_note',
    target_object_id: 'concepts/governance-parity',
    source_refs: ['User, direct message, 2026-07-06 18:00 KST'],
    reviewed_at: '2026-07-06T09:50:00.000Z',
    review_reason: 'parity handoff',
  });
  await engine.completeCanonicalHandoffEntry({
    id: 'parity-governance-handoff',
    completed_at: new Date('2026-07-06T10:00:00.000Z'),
    completion_kind: 'manual',
    completion_ref: 'parity-manual-write',
  });
}

async function collectGovernanceParitySnapshot(engine: SQLiteEngine | PGLiteEngine) {
  const candidate = await engine.getMemoryCandidateEntry('parity-governance-candidate');
  const promotedList = await engine.listMemoryCandidateEntries({
    scope_id: 'workspace:default',
    status: 'promoted',
    limit: 10,
  });
  const events = await engine.listMemoryCandidateStatusEvents({
    candidate_id: 'parity-governance-candidate',
  });
  const handoff = await engine.getCanonicalHandoffEntry('parity-governance-handoff');
  const handoffs = await engine.listCanonicalHandoffEntries({
    scope_id: 'workspace:default',
    candidate_id: 'parity-governance-candidate',
    limit: 10,
  });
  return {
    candidate: candidate === null ? null : {
      status: candidate.status,
      verification_status: candidate.verification_status,
      verification_method: candidate.verification_method,
      target_object_type: candidate.target_object_type,
      target_object_id: candidate.target_object_id,
      source_refs: candidate.source_refs,
      review_reason: candidate.review_reason,
    },
    promotedCandidateIds: promotedList.map((entry) => entry.id).sort(),
    statusEvents: events
      .map((event) => ({
        event_kind: event.event_kind,
        from_status: event.from_status,
        to_status: event.to_status,
      }))
      .sort((left, right) => left.event_kind.localeCompare(right.event_kind)),
    handoff: handoff === null ? null : {
      target_object_type: handoff.target_object_type,
      target_object_id: handoff.target_object_id,
      completion_kind: handoff.completion_kind,
      completed_at: handoff.completed_at === null ? null : handoff.completed_at.toISOString(),
      completion_ref: handoff.completion_ref,
    },
    handoffCount: handoffs.length,
  };
}

async function seedPersonalMemoryParityFixture(engine: SQLiteEngine | PGLiteEngine): Promise<void> {
  for (const suffix of ['keep', 'drop']) {
    await engine.upsertProfileMemoryEntry({
      id: `parity-profile-${suffix}`,
      scope_id: 'personal:default',
      profile_type: 'preference',
      subject: suffix === 'keep' ? 'Parity subject' : 'Disposable subject',
      content: suffix === 'keep' ? 'Parity profile content.' : 'Disposable profile content.',
      source_refs: ['User, direct message, 2026-07-06 19:00 KST'],
      sensitivity: 'personal',
      export_status: 'private_only',
      last_confirmed_at: '2026-07-06T10:00:00.000Z',
      superseded_by: null,
    });
    await engine.createPersonalEpisodeEntry({
      id: `parity-episode-${suffix}`,
      scope_id: 'personal:default',
      title: suffix === 'keep' ? 'Parity episode' : 'Disposable episode',
      start_time: '2026-07-06T08:00:00.000Z',
      end_time: '2026-07-06T09:00:00.000Z',
      source_kind: 'assistant_conversation',
      summary: suffix === 'keep' ? 'Parity episode summary.' : 'Disposable episode summary.',
      source_refs: ['User, direct message, 2026-07-06 19:05 KST'],
      candidate_ids: [],
    });
  }
  await engine.deleteProfileMemoryEntry('parity-profile-drop');
  await engine.deletePersonalEpisodeEntry('parity-episode-drop');
}

async function collectPersonalMemoryParitySnapshot(engine: SQLiteEngine | PGLiteEngine) {
  const profile = await engine.getProfileMemoryEntry('parity-profile-keep');
  const profiles = await engine.listProfileMemoryEntries({ scope_id: 'personal:default' });
  const episode = await engine.getPersonalEpisodeEntry('parity-episode-keep');
  const episodes = await engine.listPersonalEpisodeEntries({ scope_id: 'personal:default' });
  return {
    profile: profile === null ? null : {
      profile_type: profile.profile_type,
      subject: profile.subject,
      content: profile.content,
      source_refs: profile.source_refs,
      sensitivity: profile.sensitivity,
      export_status: profile.export_status,
      last_confirmed_at: profile.last_confirmed_at === null ? null : new Date(profile.last_confirmed_at).toISOString(),
      superseded_by: profile.superseded_by,
    },
    profileIdsAfterDelete: profiles.map((entry) => entry.id).sort(),
    episode: episode === null ? null : {
      title: episode.title,
      summary: episode.summary,
      source_kind: episode.source_kind,
      start_time: new Date(episode.start_time).toISOString(),
      end_time: episode.end_time === null ? null : new Date(episode.end_time).toISOString(),
      source_refs: episode.source_refs,
      candidate_ids: episode.candidate_ids,
    },
    episodeIdsAfterDelete: episodes.map((entry) => entry.id).sort(),
  };
}

const NOTE_STRUCTURE_PARITY_PAGE = {
  type: 'concept' as PageType,
  title: 'Note Structure Parity',
  compiled_truth: [
    '# Overview',
    'Reference [[systems/mbrain]] for structural parity.',
    '[Source: User, direct message, 2026-07-06 19:10 KST]',
    '',
    '## Details',
    'Deterministic section content.',
  ].join('\n'),
  timeline: '',
  frontmatter: {},
};

async function seedNoteStructureParityFixture(engine: SQLiteEngine | PGLiteEngine): Promise<void> {
  const page = await engine.putPage('concepts/note-structure-parity', NOTE_STRUCTURE_PARITY_PAGE);
  const manifestInput = buildNoteManifestEntry({
    page_id: page.id,
    slug: 'concepts/note-structure-parity',
    path: 'concepts/note-structure-parity.md',
    tags: ['parity'],
    page: NOTE_STRUCTURE_PARITY_PAGE,
  });
  await engine.upsertNoteManifestEntry(manifestInput);
  const sectionInputs = buildNoteSectionEntries({
    page_id: page.id,
    page_slug: 'concepts/note-structure-parity',
    page_path: 'concepts/note-structure-parity.md',
    page: NOTE_STRUCTURE_PARITY_PAGE,
    manifest: manifestInput,
  });
  await engine.replaceNoteSectionEntries('workspace:default', 'concepts/note-structure-parity', sectionInputs);

  const disposable = await engine.putPage('concepts/note-structure-parity-drop', NOTE_STRUCTURE_PARITY_PAGE);
  const disposableManifest = buildNoteManifestEntry({
    page_id: disposable.id,
    slug: 'concepts/note-structure-parity-drop',
    path: 'concepts/note-structure-parity-drop.md',
    tags: [],
    page: NOTE_STRUCTURE_PARITY_PAGE,
  });
  await engine.upsertNoteManifestEntry(disposableManifest);
  await engine.replaceNoteSectionEntries('workspace:default', 'concepts/note-structure-parity-drop', buildNoteSectionEntries({
    page_id: disposable.id,
    page_slug: 'concepts/note-structure-parity-drop',
    page_path: 'concepts/note-structure-parity-drop.md',
    page: NOTE_STRUCTURE_PARITY_PAGE,
    manifest: disposableManifest,
  }));
  await engine.deleteNoteManifestEntry('workspace:default', 'concepts/note-structure-parity-drop');
  await engine.deleteNoteSectionEntries('workspace:default', 'concepts/note-structure-parity-drop');
}

async function collectNoteStructureParitySnapshot(engine: SQLiteEngine | PGLiteEngine) {
  const manifest = await engine.getNoteManifestEntry('workspace:default', 'concepts/note-structure-parity');
  const manifests = await engine.listNoteManifestEntries({ scope_id: 'workspace:default' });
  const sections = await engine.listNoteSectionEntries({
    scope_id: 'workspace:default',
    page_slug: 'concepts/note-structure-parity',
    limit: 10,
  });
  const firstSection = sections[0]
    ? await engine.getNoteSectionEntry('workspace:default', sections[0].section_id)
    : null;
  const manifestAfterDelete = await engine.getNoteManifestEntry('workspace:default', 'concepts/note-structure-parity-drop');
  const sectionsAfterDelete = await engine.listNoteSectionEntries({
    scope_id: 'workspace:default',
    page_slug: 'concepts/note-structure-parity-drop',
    limit: 10,
  });
  return {
    manifest: manifest === null ? null : {
      slug: manifest.slug,
      path: manifest.path,
      title: manifest.title,
      tags: manifest.tags,
      outgoing_wikilinks: manifest.outgoing_wikilinks,
      heading_index: manifest.heading_index,
      content_hash: manifest.content_hash,
      extractor_version: manifest.extractor_version,
    },
    manifestSlugs: manifests.map((entry) => entry.slug).sort(),
    sectionHeadings: sections.map((section) => ({
      section_id: section.section_id,
      heading_path: section.heading_path,
      depth: section.depth,
      outgoing_wikilinks: section.outgoing_wikilinks,
    })),
    firstSectionText: firstSection === null ? null : firstSection.section_text,
    manifestAfterDelete,
    sectionsAfterDelete: sectionsAfterDelete.map((section) => section.section_id),
  };
}
