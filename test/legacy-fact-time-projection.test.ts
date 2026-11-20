/**
 * Revision-bound edits of an old fact fence must keep the precision its renderer could not express.
 * A canonical rewrite used to truncate the stored instant and replace all last-writer fields.
 * Current date and restamp tests do not edit ordinary prose over a fixture with legacy precision.
 * Uses the existing managed operations and fixture writer, with no extra production seam.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { operationsByName } from '../src/core/operations.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const slug = 'notes/legacy-date-example';
const start = '2026-01-05T10:11:12', end = '2026-04-01T15:01:05';
const initial = [
  '---', 'type: note', 'title: Example', '---', 'First sentence.', '', '## Facts', '',
  '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|---|---|---|---|---|---|---|---|---|',
  `| 1 | A synthetic fact | fact | 1.0 | private | medium | ${start}Z | ${end}Z | fixture | |`,
  '| 2 | A second synthetic fact | fact | 1.0 | private | medium | 2026-01-06 | | fixture | |',
  `| 3 | ~~An inactive synthetic fact~~ | fact | 1.0 | private | medium | ${start}Z | ${end}Z | fixture | superseded by #2 |`,
  '<!--- gbrain:facts:end -->', '',
].join('\n');

for (const backend of testBackends()) test(`[${backend}] an unrelated edit preserves old fact timestamp precision and attribution; an explicit correction applies`, () =>
  managedBrain(async ({ engine, ctx, root }) => {
    await operationsByName.put_page.handler(ctx, { slug, content: initial, request_id: randomUUID() });
    await settleManagedGitEffects(engine);
    // The pre-fix renderer wrote seconds to the page while remember kept milliseconds in the database.
    await withManagedFixtureWrite(engine, ['default'], async tx => {
      await tx.executeRaw("UPDATE facts SET valid_from=$1::timestamptz,valid_until=$2::timestamptz WHERE source_id='default' AND source_markdown_slug=$3 AND row_num=1",
        [start + '.273Z', end + '.456Z', slug]);
      await tx.executeRaw("UPDATE facts SET valid_until=$1::timestamptz,expired_at=$1::timestamptz WHERE source_id='default' AND source_markdown_slug=$2 AND row_num=3",
        [end + '.789Z', slug]);
    });
    const snapshot = async () => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    const rows = () => engine.executeRaw<{ value: { id: number; valid_from: string; valid_until: string | null } }>(
      "SELECT to_jsonb(f) AS value FROM facts f WHERE source_id='default' AND source_markdown_slug=$1 ORDER BY row_num", [slug]);
    const text = () => readFileSync(join(root, slug + '.md'), 'utf8');
    const put = async (content: string) => operationsByName.put_page.handler(ctx, { slug, content, expected_revision: (await snapshot()).revision, request_id: randomUUID() });
    const before = await rows();
    expect(before).toHaveLength(3);
    const original = text();
    await operationsByName.edit_page.handler(ctx, { slug, expected_revision: (await snapshot()).revision, request_id: randomUUID(),
      edits: [{ old_text: 'First sentence.', new_text: 'Second sentence.' }] });
    // Frontmatter can change order during an edit. Compare all prose and the protected fence byte for byte.
    const edited = text();
    expect(edited.substring(edited.indexOf('Second sentence.'))).toBe(original.substring(original.indexOf('First sentence.')).replace('First sentence.', 'Second sentence.'));
    expect(await rows()).toEqual(before);

    // Changing another row must leave this row's exact start and end alone too.
    await put(text().replace('2026-01-06', '2026-01-07'));
    expect((await rows())[0]).toEqual(before[0]);
    expect(Date.parse((await rows())[1]!.value.valid_from)).toBe(Date.parse('2026-01-07T00:00:00Z'));

    // The same nominal second with explicit .000 means exactly that instant. A new end instant applies too.
    const correctedEnd = '2026-04-02T15:01:05Z';
    await put(text().replace(start + 'Z', start + '.000Z').replace(end + 'Z', correctedEnd));
    const corrected = (await rows())[0]!.value;
    expect(corrected.id).toBe(before[0]!.value.id);
    expect(Date.parse(corrected.valid_from)).toBe(Date.parse(start + '.000Z'));
    expect(Date.parse(corrected.valid_until!)).toBe(Date.parse(correctedEnd));
    expect((await rows())[2]).toEqual(before[2]);
    await put(text().replace(start + '.000Z', start + '.123Z'));
    expect(Date.parse((await rows())[0]!.value.valid_from)).toBe(Date.parse(start + '.123Z'));
  }, { databaseUrl: backend === 'postgres' ? requirePostgresTestDatabase() : undefined }), 120_000);
