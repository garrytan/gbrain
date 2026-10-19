/**
 * D-8 (GBRA-131, #6982): the patterns phase's reverse-write never replaces a
 * checkout file that holds an edit the database lacks.
 *
 * Protects: after the patterns child wrote a page in the database, its markdown
 * file is written only when the file is absent or holds nothing the database
 * lacks (it equals the live page or one of its page_versions rows); otherwise
 * the file keeps its bytes and the phase reports the page with
 * `file_database_drift` and its fix. The write honors `sync.write_through` off
 * and `storage.db_only` (no file), lands in the page's recorded source_path,
 * and is bound to the bytes it compared, so an edit landing in between is kept.
 * Fails when: the reverse-write (patterns.ts reverseWriteRefs) writes every page's file
 * unconditionally with writeFileSync at a slug-derived path, ignoring write-through, db_only and the recorded source_path.
 * Seams: an engine proxy that edits the file once the reverse-write has read the
 * page history it compares against. PGLite always, Postgres when DATABASE_URL
 * is set.
 */
import { __testing } from '../../src/core/cycle/patterns.ts';
import { reverseWriteCases, type ReverseWrite } from './dream-reverse-write-fixture.ts';
import { pathologicalArms } from './harness.ts';

for (const arm of pathologicalArms()) reverseWriteCases('D-8', 'patterns', __testing.reverseWriteRefs as ReverseWrite, arm);
