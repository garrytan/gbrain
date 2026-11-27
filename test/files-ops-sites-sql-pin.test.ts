/**
 * The typed file members (src/core/engine-sql/files-ops.ts) send Postgres the statement text and binds the files
 * commands (src/commands/files.ts) and the file operations (src/core/ops/files.ts) sent through `executeRaw`,
 * `executeRawJsonb` and the `sqlQueryForEngine` tag before the statements had members. A drift here changes a query
 * plan or a result on Postgres alone, which PGLite parity cannot see.
 *
 * Protects: each member's recorded text and params equal the old statement byte for byte: the tag's `$n` numbering for
 * the four reads of commands/files.ts, the three upsert texts of the commands (their indentation differs, so they stay
 * three texts), the two upserts of the operations, the readable-file predicate with and without the private-page
 * filter, and the hand-numbered `$1` limit that follows `$2` in the list texts. Fails when a member reorders a clause,
 * renumbers a placeholder, re-indents a statement or binds a value differently. No database: the engine runs on the
 * recording fake. The expected texts below are copied from the call sites at 5e22f0c134.
 *
 * Main join (da99c637a7): the cli-members line's call sites at de72811022 sorted in bytes: commands/files.ts:499
 * `ORDER BY storage_path COLLATE "C" LIMIT 1000`, ops/files.ts:45 `page_slug COLLATE "C", filename COLLATE "C", id` and
 * `filename COLLATE "C", id`, and ops/files.ts:363 `ORDER BY storage_path COLLATE "C"`. The join kept main's members and
 * re-applied that byte order and the `id` tie-break, so the verify and list pins below carry them; nothing else in those
 * texts differs from 5e22f0c134.
 *
 * Master sync 18 (913e459414, files follow their page, v336): the two upload upserts of commands/files.ts and the
 * file_upload upsert of ops/files.ts changed on master, and the pins carry master's text: the commands read the page id
 * with a subselect on pages (source_id and slug, deleted_at IS NULL) and a conflict takes that page id and, when it is
 * set, its slug; file_upload names the row's slug as the page has it now, read by id with FOR SHARE, and a conflict
 * takes the slug whenever the upload binds a page. The params are unchanged. The sync and register texts did not change.
 */
import { expect, test } from 'bun:test';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { privatePagesFilterForCaller } from '../src/core/search/private-visibility.ts';
import { FILES_METADATA_MERGE_SQL } from '../src/core/sql-query.ts';
import { makeFakeSql } from './helpers/fake-postgres-sql.ts';

function recordingEngine() {
  const fake = makeFakeSql(s => /count\(\*\)::int AS n/.test(s.text) ? [{ n: 0 }] : undefined);
  const engine = new PostgresEngine();
  (engine as unknown as { _sql: unknown })._sql = fake.sql;
  return { engine, statements: () => fake.statements().map(s => ({ text: s.text, params: s.params })) };
}

/** fileReadableSql of src/core/ops/files.ts at 5e22f0c134, with the exclusion already decided. */
const readable = (excludePrivate: boolean) => excludePrivate
  ? `NOT EXISTS (SELECT 1 FROM pages fp WHERE (fp.id = f.page_id OR fp.slug = f.page_slug) AND NOT ${privatePagesFilterForCaller('fp')})`
  : 'TRUE';

// src/commands/files.ts:212 uploadFile and :385 uploadRaw (the smart upload): one text.
const CLI_UPSERT = `INSERT INTO files (page_slug, page_id, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
     VALUES ($1, (SELECT id FROM pages WHERE source_id = 'default' AND slug = $1 AND deleted_at IS NULL), $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (storage_path) DO UPDATE SET
       content_hash = EXCLUDED.content_hash,
       size_bytes = EXCLUDED.size_bytes,
       mime_type = EXCLUDED.mime_type,
       page_id = COALESCE(EXCLUDED.page_id, files.page_id),
       page_slug = CASE WHEN EXCLUDED.page_id IS NULL THEN files.page_slug ELSE EXCLUDED.page_slug END,
       metadata = (CASE WHEN jsonb_typeof(files.metadata) = 'object' THEN files.metadata ELSE '{}'::jsonb END) || EXCLUDED.metadata`;
// src/commands/files.ts:310 uploadRaw (the git lane).
const RAW_UPSERT = `INSERT INTO files (source_id, page_slug, page_id, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
       VALUES ($1, $2, (SELECT id FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL), $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (storage_path) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         size_bytes = EXCLUDED.size_bytes,
         mime_type = EXCLUDED.mime_type,
         page_id = COALESCE(EXCLUDED.page_id, files.page_id),
         page_slug = CASE WHEN EXCLUDED.page_id IS NULL THEN files.page_slug ELSE EXCLUDED.page_slug END,
         metadata = (CASE WHEN jsonb_typeof(files.metadata) = 'object' THEN files.metadata ELSE '{}'::jsonb END) || EXCLUDED.metadata`;
// src/commands/files.ts:482 syncFiles (indented one level deeper than the other two).
const SYNC_UPSERT = `INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (storage_path) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         size_bytes = EXCLUDED.size_bytes,
         mime_type = EXCLUDED.mime_type,
         metadata = (CASE WHEN jsonb_typeof(files.metadata) = 'object' THEN files.metadata ELSE '{}'::jsonb END) || EXCLUDED.metadata`;
// src/core/ops/files.ts:166 file_upload.
const OP_UPSERT = `INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, source_id, page_id, metadata)
         VALUES (COALESCE((SELECT p.slug FROM pages p WHERE p.id = $8 FOR SHARE), $1), $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (storage_path) DO UPDATE SET
           content_hash = EXCLUDED.content_hash,
           size_bytes = EXCLUDED.size_bytes,
           mime_type = EXCLUDED.mime_type,
           source_id = CASE WHEN EXCLUDED.page_id IS NULL THEN files.source_id ELSE EXCLUDED.source_id END,
           page_id = COALESCE(EXCLUDED.page_id, files.page_id),
           page_slug = CASE WHEN EXCLUDED.page_id IS NULL THEN files.page_slug ELSE EXCLUDED.page_slug END,
           metadata = (CASE WHEN jsonb_typeof(files.metadata) = 'object' THEN files.metadata ELSE '{}'::jsonb END) || EXCLUDED.metadata`;
// src/core/ops/files.ts:317 file_register.
const REGISTER_UPSERT = `INSERT INTO files (page_slug, filename, storage_path, mime_type, size_bytes, content_hash, source_id, page_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       ON CONFLICT (storage_path) DO UPDATE SET
         content_hash = EXCLUDED.content_hash,
         size_bytes = EXCLUDED.size_bytes,
         mime_type = EXCLUDED.mime_type,
         metadata = (CASE WHEN jsonb_typeof(files.metadata) = 'object' THEN files.metadata ELSE '{}'::jsonb END) || EXCLUDED.metadata
       WHERE files.page_slug IS NOT DISTINCT FROM EXCLUDED.page_slug AND files.filename = EXCLUDED.filename
         AND files.source_id IS NOT DISTINCT FROM EXCLUDED.source_id AND files.page_id IS NOT DISTINCT FROM EXCLUDED.page_id
       RETURNING 1`;

const METADATA = { storage: 'local' };
const ROW = { page_slug: 'notes/plan', filename: 'report.pdf', storage_path: 'notes/plan/report.pdf', mime_type: 'application/pdf', size_bytes: 12, content_hash: 'abc' };

interface Pin {
  /** The call site the statement came from, at 5e22f0c134. */
  from: string;
  run: (e: PostgresEngine) => Promise<unknown>;
  /** The statements, in order, as the call site sent them. */
  sent: Array<{ text: string; params: unknown[] }>;
}

const PINS: Pin[] = [
  {
    from: 'src/commands/files.ts:197 uploadFile and :467 syncFiles',
    run: e => e.hasFileWithHash('h1', 'notes/plan/report.pdf'),
    sent: [{ text: 'SELECT id FROM files WHERE content_hash = $1 AND storage_path = $2', params: ['h1', 'notes/plan/report.pdf'] }],
  },
  {
    from: 'src/commands/files.ts:505 verifyFiles',
    run: e => e.listFileRowsForVerify(),
    sent: [{ text: 'SELECT * FROM files ORDER BY storage_path COLLATE "C" LIMIT 1000', params: [] }],
  },
  {
    from: 'src/commands/files.ts:550 gitRootFor',
    run: e => e.readSourceLocalPathForVerify('src-a'),
    sent: [{ text: 'SELECT local_path FROM sources WHERE id = $1', params: ['src-a'] }],
  },
  {
    from: 'src/commands/files.ts:212 uploadFile and :385 uploadRaw',
    run: e => e.upsertCliFileRow(ROW, METADATA),
    sent: [{ text: CLI_UPSERT, params: ['notes/plan', 'report.pdf', 'notes/plan/report.pdf', 'application/pdf', 12, 'abc', METADATA] }],
  },
  {
    from: 'src/commands/files.ts:310 uploadRaw',
    run: e => e.upsertRawFileRow({ ...ROW, source_id: 'src-a', content_hash: 'sha256:abc' }, { storage: 'git', type: 'pdf' }),
    sent: [{ text: RAW_UPSERT, params: ['src-a', 'notes/plan', 'report.pdf', 'notes/plan/report.pdf', 'application/pdf', 12, 'sha256:abc', { storage: 'git', type: 'pdf' }] }],
  },
  {
    from: 'src/commands/files.ts:482 syncFiles',
    run: e => e.upsertSyncFileRow(ROW, METADATA),
    sent: [{ text: SYNC_UPSERT, params: ['notes/plan', 'report.pdf', 'notes/plan/report.pdf', 'application/pdf', 12, 'abc', METADATA] }],
  },
  {
    from: 'src/core/ops/files.ts:129 file_upload',
    run: e => e.sourceIdExists('src-a'),
    sent: [{ text: 'SELECT 1 FROM sources WHERE id = $1', params: ['src-a'] }],
  },
  {
    from: 'src/core/ops/files.ts:131 file_upload',
    run: e => e.readPageIdInSource('notes/plan', 'src-a'),
    sent: [{ text: 'SELECT id FROM pages WHERE slug = $1 AND source_id = $2', params: ['notes/plan', 'src-a'] }],
  },
  {
    from: 'src/core/ops/files.ts:134 file_upload',
    run: e => e.readFileOwner('notes/plan/report.pdf'),
    sent: [{ text: 'SELECT source_id, page_id, content_hash FROM files WHERE storage_path = $1', params: ['notes/plan/report.pdf'] }],
  },
  {
    from: 'src/core/ops/files.ts:146 file_upload',
    run: e => e.claimFilePage('notes/plan/report.pdf', 'src-a', 7),
    sent: [{ text: 'UPDATE files SET source_id = $2, page_id = $3 WHERE storage_path = $1', params: ['notes/plan/report.pdf', 'src-a', 7] }],
  },
  {
    from: 'src/core/ops/files.ts:166 file_upload',
    run: e => e.upsertOpFileRow({ ...ROW, source_id: 'src-a', page_id: 7 }, METADATA),
    sent: [{ text: OP_UPSERT, params: ['notes/plan', 'report.pdf', 'notes/plan/report.pdf', 'application/pdf', 12, 'abc', 'src-a', 7, METADATA] }],
  },
  {
    from: 'src/core/ops/files.ts:166 file_upload (no page)',
    run: e => e.upsertOpFileRow({ ...ROW, page_slug: null, mime_type: null, source_id: 'default', page_id: null }, METADATA),
    sent: [{ text: OP_UPSERT, params: [null, 'report.pdf', 'notes/plan/report.pdf', null, 12, 'abc', 'default', null, METADATA] }],
  },
  ...[false, true].flatMap(exclude => [
    {
      from: `src/core/ops/files.ts:45 file_list (all pages, excludePrivate ${exclude})`,
      run: (e: PostgresEngine) => e.listReadableFileRows(undefined, exclude),
      sent: [{ text: `SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at
      FROM files f WHERE (${'TRUE'}) AND ${readable(exclude)}
      ORDER BY ${'page_slug COLLATE "C", filename COLLATE "C", id'} LIMIT $1`, params: [100] }],
    },
    {
      from: `src/core/ops/files.ts:45 file_list (one page, excludePrivate ${exclude})`,
      run: (e: PostgresEngine) => e.listReadableFileRows('notes/plan', exclude),
      sent: [{ text: `SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at
      FROM files f WHERE (${'f.page_slug = $2'}) AND ${readable(exclude)}
      ORDER BY ${'filename COLLATE "C", id'} LIMIT $1`, params: [100, 'notes/plan'] }],
    },
    {
      from: `src/core/ops/files.ts:204 file_url (excludePrivate ${exclude})`,
      run: (e: PostgresEngine) => e.readReadableFileForUrl('notes/plan/report.pdf', exclude),
      sent: [{ text: `SELECT storage_path, mime_type, size_bytes FROM files f
      WHERE storage_path = $1 AND ${readable(exclude)}`, params: ['notes/plan/report.pdf'] }],
    },
    {
      from: `src/core/ops/files.ts:266 readablePageId (excludePrivate ${exclude})`,
      run: (e: PostgresEngine) => e.readReadablePageId('notes/plan', 'src-a', exclude),
      sent: [{ text: `SELECT fp.id FROM pages fp WHERE fp.slug = $1 AND fp.source_id = $2
    AND ${exclude ? privatePagesFilterForCaller('fp') : 'TRUE'}`, params: ['notes/plan', 'src-a'] }],
    },
    {
      from: `src/core/ops/files.ts:302 file_register (excludePrivate ${exclude})`,
      run: (e: PostgresEngine) => e.countUnreadableFilesAt('notes/plan/report.pdf', exclude),
      sent: [{ text: `SELECT count(*)::int AS n FROM files f WHERE f.storage_path = $1 AND NOT (${readable(exclude)})`, params: ['notes/plan/report.pdf'] }],
    },
    {
      from: `src/core/ops/files.ts:352 file_verify (excludePrivate ${exclude})`,
      run: (e: PostgresEngine) => e.readReadableFileForVerify('notes/plan/report.pdf', exclude),
      sent: [{ text: `SELECT size_bytes, content_hash FROM files f WHERE f.storage_path = $1 AND ${readable(exclude)}`, params: ['notes/plan/report.pdf'] }],
    },
    {
      from: `src/core/ops/files.ts:362 file_verify (all pages, excludePrivate ${exclude})`,
      run: (e: PostgresEngine) => e.listReadableFilePaths(undefined, exclude),
      sent: [{ text: `SELECT storage_path, page_slug FROM files f
      WHERE (${'TRUE'}) AND ${readable(exclude)} ORDER BY storage_path COLLATE "C" LIMIT $1`, params: [100] }],
    },
    {
      from: `src/core/ops/files.ts:362 file_verify (one page, excludePrivate ${exclude})`,
      run: (e: PostgresEngine) => e.listReadableFilePaths('notes/plan', exclude),
      sent: [{ text: `SELECT storage_path, page_slug FROM files f
      WHERE (${'f.page_slug = $2'}) AND ${readable(exclude)} ORDER BY storage_path COLLATE "C" LIMIT $1`, params: [100, 'notes/plan'] }],
    },
  ]),
  {
    from: 'src/core/ops/files.ts:304 file_register',
    run: e => e.countFilesRegisteredElsewhere({ storage_path: 'notes/plan/report.pdf', page_slug: null, filename: 'report.pdf', source_id: 'src-a', page_id: null }),
    sent: [{ text: `SELECT count(*)::int AS n FROM files WHERE storage_path = $1
      AND (page_slug IS DISTINCT FROM $2 OR filename <> $3 OR source_id IS DISTINCT FROM $4 OR page_id IS DISTINCT FROM $5)`, params: ['notes/plan/report.pdf', null, 'report.pdf', 'src-a', null] }],
  },
  {
    from: 'src/core/ops/files.ts:317 file_register',
    run: e => e.registerFileRow({ ...ROW, source_id: 'src-a', page_id: 7 }, METADATA),
    sent: [{ text: REGISTER_UPSERT, params: ['notes/plan', 'report.pdf', 'notes/plan/report.pdf', 'application/pdf', 12, 'abc', 'src-a', 7, METADATA] }],
  },
];

test.each(PINS.map(pin => [pin.from, pin] as const))('%s keeps its Postgres text and params byte for byte', async (_from, pin) => {
  const { engine, statements } = recordingEngine();
  await pin.run(engine);
  expect(statements()).toEqual(pin.sent);
});

test('the upsert texts still splice the merge fragment the other writers share', () => {
  for (const text of [CLI_UPSERT, RAW_UPSERT, SYNC_UPSERT, OP_UPSERT, REGISTER_UPSERT]) expect(text).toContain(FILES_METADATA_MERGE_SQL);
});

test('the readable predicate is the old one with the private-page filter spliced from the caller policy', () => {
  expect(readable(true)).toContain(privatePagesFilterForCaller('fp'));
  expect(readable(false)).toBe('TRUE');
});
