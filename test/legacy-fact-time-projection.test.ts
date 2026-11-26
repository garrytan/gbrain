/**
 * Revision-bound edits of an old fact fence must keep the precision its renderer could not express.
 * A canonical rewrite used to truncate the stored instant and replace all last-writer fields.
 * Current date and restamp tests do not edit ordinary prose over a fixture with legacy precision.
 * Uses the existing managed operations and fixture writer, with no extra production seam.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
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
    // This row was imported with put_page and has no creation receipt from remember.
    // A legacy-shaped cell alone must not authorize keeping an unrelated fractional value.
    await put(text().replace(start + '.123Z', start + 'Z'));
    await withManagedFixtureWrite(engine, ['default'], tx => tx.executeRaw(
      "UPDATE facts SET valid_from=$1::timestamptz WHERE source_id='default' AND source_markdown_slug=$2 AND row_num=1",
      [start + '.789Z', slug]));
    await runExtractFacts(engine, { sourceId: 'default', slugs: [slug], deferEmbedding: true });
    expect(Date.parse((await rows())[0]!.value.valid_from)).toBe(Date.parse(start + 'Z'));
  }, { databaseUrl: backend === 'postgres' ? requirePostgresTestDatabase() : undefined }), 120_000);

for (const backend of testBackends()) test(`[${backend}] managed fence reconciliation verifies an exact remember receipt before retaining a legacy second`, () =>
  managedBrain(async ({ engine, root }) => {
    const member = 'sample', memberSlug = 'memory/members/sample';
    const precise = start + '.273Z', legacy = start + 'Z';
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    await addMember(engine, member);
    const client = await provider.registerClientManual('example-client', ['client_credentials'], 'read write', [], 'default');
    await bindCredential(engine, { kind: 'client', id: client.clientId }, { member });
    const token = await provider.exchangeClientCredentials(client.clientId, client.clientSecret ?? '');
    const auth = await provider.verifyAccessToken(token.access_token);
    const result = await dispatchToolCall(engine, 'remember', { request_id: randomUUID(), fact: 'The sample uses cobalt paper', provenance: 'test fixture', valid_from: precise },
      { remote: true, transport: 'http', sourceId: 'default', auth });
    expect(JSON.parse(result.content[0]!.text).status).toBe('inserted');
    await settleManagedGitEffects(engine);
    const file = join(root, memberSlug + '.md');
    const row = async () => (await engine.executeRaw<{ data: { id: number; valid_from: string } }>(
      'SELECT to_jsonb(f) AS data FROM facts f WHERE source_id=$1 AND source_markdown_slug=$2', ['default', memberSlug]))[0]!.data;
    // Represent bytes that an older release wrote to its canonical page and cache. The fact and receipt stay native.
    const replaceCell = async (oldValue: string, newValue: string) => {
      const before = readFileSync(file, 'utf8');
      expect(before).toContain(oldValue);
      writeFileSync(file, before.replace(oldValue, newValue));
      await withManagedFixtureWrite(engine, ['default'], tx => tx.executeRaw(
        'UPDATE pages SET compiled_truth=replace(compiled_truth,$1,$2) WHERE source_id=$3 AND slug=$4', [oldValue,newValue,'default',memberSlug]));
    };
    await replaceCell(precise, legacy);
    const original = await row();
    expect(Date.parse(original.valid_from)).toBe(Date.parse(precise));
    const reconcile = () => runExtractFacts(engine, { sourceId: 'default', slugs: [memberSlug], deferEmbedding: true });
    expect((await reconcile()).factsUpdated).toBe(0);
    expect(await row()).toEqual(original);

    // An explicit .000 is authoritative, even when creation and row previously agreed on a fraction.
    await replaceCell(legacy, start + '.000Z');
    expect((await reconcile()).factsUpdated).toBe(1);
    expect(Date.parse((await row()).valid_from)).toBe(Date.parse(legacy));
    expect((await row()).id).toBe(original.id);
  }, { databaseUrl: backend === 'postgres' ? requirePostgresTestDatabase() : undefined }), 120_000);
