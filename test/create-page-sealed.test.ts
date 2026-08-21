import { createHash } from 'node:crypto';
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, type OperationContext, OperationError } from '../src/core/operations.ts';
import {
  canonicalJson,
  __setServerBuildCommitForTests,
} from '../src/core/sealed-page.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';

let engine: PGLiteEngine;
const TEST_BUILD_COMMIT = '1'.repeat(40);

beforeAll(async () => {
  __setServerBuildCommitForTests(TEST_BUILD_COMMIT);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  __setServerBuildCommitForTests(null);
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const operationId = (label: string) => sha(`operation:${label}`);
const syntheticSlug = (label: string) => `synthetic/${sha(`slug:${label}`)}`;
const requestHash = (slug: string, content: string) => sha(JSON.stringify({ slug, content }));
const content = (title = 'Sealed Example', body = 'Deterministic body.') =>
  `---\ntitle: ${title}\ntype: note\nowner: test\n---\n\n${body}`;

function context(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

async function create(slug: string, markdown: string, label: string, overrides: Partial<OperationContext> = {}) {
  const op = operations.find((candidate) => candidate.name === 'create_page');
  expect(op).toBeDefined();
  return await op!.handler(context(overrides), {
    operation_id: operationId(label),
    slug,
    content: markdown,
    request_sha256: requestHash(slug, markdown),
  }) as any;
}

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe(code);
  }
}

describe('create_page sealed contract', () => {
  test('operation exists with write scope', () => {
    const op = operations.find((candidate) => candidate.name === 'create_page');
    expect(op).toBeDefined();
    expect(op?.scope).toBe('write');
    expect(op?.mutating).toBe(true);
    expect(op?.localOnly).not.toBe(true);
  });

  test('creates once and returns the persisted receipt on identical retry', async () => {
    const slug = syntheticSlug('sealed-example');
    const markdown = content();
    const first = await create(slug, markdown, 'created-matched');
    const second = await create(slug, markdown, 'created-matched');

    expect(first.status).toBe('created');
    expect(second.status).toBe('matched');
    expect(second.receipt).toEqual(first.receipt);
    expect(Object.keys(first.receipt.canonical_projection).sort()).toEqual(
      ['compiled_truth', 'frontmatter', 'slug', 'title', 'type'].sort(),
    );
    expect(first.receipt.operation_id).toBe(operationId('created-matched'));
    expect(first.receipt.request_sha256).toBe(requestHash(slug, markdown));
    expect(first.receipt.source_id).toBe('default');
    expect(first.receipt.slug).toBe(slug);
    expect(first.receipt.receipt_id).toMatch(/^[a-f0-9]{64}$/);
    expect(first.receipt.canonical_page_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.receipt.server_build_commit).not.toBe(first.receipt.operation_id);
    expect(first.receipt.server_build_commit).toBe(TEST_BUILD_COMMIT);
    const chunks = await engine.getChunks(slug, { sourceId: 'default' });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.embedding == null)).toBe(true);
  });

  test('canonical JSON uses locale-independent UTF-16 key order', () => {
    expect(canonicalJson({ 'ä': 2, z: 1, '\u{10000}': 3, '\uE000': 4 })).toBe(
      '{"z":1,"ä":2,"𐀀":3,"":4}',
    );
  });

  test('rejects a non-empty timeline outside the canonical projection', async () => {
    const slug = syntheticSlug('timeline');
    const markdown = `${content('Timeline')}\n\n<!-- timeline -->\n\n- 2026-01-01: hidden event`;
    await expectCode(create(slug, markdown, 'timeline'), 'invalid_params');
    expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
  });

  test('same operation_id with a different request conflicts', async () => {
    const slug = syntheticSlug('idempotency');
    await create(slug, content(), 'same-op');
    await expectCode(create(slug, content('Changed'), 'same-op'), 'idempotency_conflict');
  });

  test('normal existing slug conflicts for identical and different content', async () => {
    const op = operations.find((candidate) => candidate.name === 'put_page')!;
    const same = content('Existing');
    const sameSlug = syntheticSlug('normal-same');
    const differentSlug = syntheticSlug('normal-different');
    await op.handler(context({ remote: false }), { slug: sameSlug, content: same });
    await op.handler(context({ remote: false }), { slug: differentSlug, content: content('Original') });

    await expectCode(create(sameSlug, same, 'normal-same'), 'page_conflict');
    await expectCode(create(differentSlug, content('Different'), 'normal-different'), 'page_conflict');
  });

  test('a different operation cannot claim an already sealed slug', async () => {
    const slug = syntheticSlug('claimed');
    await create(slug, content(), 'claim-a');
    await expectCode(create(slug, content(), 'claim-b'), 'page_conflict');
  });

  test('sealed page rejects put, soft delete, and hard delete', async () => {
    const slug = syntheticSlug('immutable');
    await create(slug, content(), 'immutable');
    const put = operations.find((candidate) => candidate.name === 'put_page')!;
    const del = operations.find((candidate) => candidate.name === 'delete_page')!;

    await expect(put.handler(context({ remote: false }), { slug, content: content('Changed') })).rejects.toThrow(/sealed/i);
    await expect(del.handler(context(), { slug })).rejects.toThrow(/sealed/i);
    await expect(engine.deletePage(slug, { sourceId: 'default' })).rejects.toThrow(/sealed/i);
    expect(await engine.getPage(slug, { sourceId: 'default' })).not.toBeNull();
  });

  test('sealed deleted rows reject restore and purge', async () => {
    const slug = syntheticSlug('deleted');
    await engine.putPage(slug, {
      type: 'note', title: 'Deleted', compiled_truth: 'body', timeline: '', frontmatter: {},
    }, { sourceId: 'default' });
    await engine.softDeletePage(slug, { sourceId: 'default' });
    const page = await engine.getPage(slug, { sourceId: 'default', includeDeleted: true });
    expect(page).not.toBeNull();
    const h = sha('deleted-seal');
    await engine.executeRaw(
      `INSERT INTO sealed_page_receipts
       (protocol_version, operation_id, source_id, slug, request_sha256, page_id,
        page_revision, canonical_page_sha256, canonical_projection,
        server_build_commit, receipt_id)
       VALUES ('gbrain.create_page.v1', $1, 'default', $2, $3, $4, 1, $5,
        $7::jsonb,
        $8, $6)`,
      [
        operationId('deleted-seal'), slug, h, page!.id, h,
        sha('receipt:deleted-seal'),
        JSON.stringify({ slug, type: 'note', title: 'Deleted', compiled_truth: 'body', frontmatter: {} }),
        TEST_BUILD_COMMIT,
      ],
    );

    await expect(engine.restorePage(slug, { sourceId: 'default' })).rejects.toThrow(/sealed/i);
    await expect(engine.purgeDeletedPages(0)).rejects.toThrow(/sealed/i);
    expect(await engine.getPage(slug, { sourceId: 'default', includeDeleted: true })).not.toBeNull();
  });

  test('receipts cannot be updated or deleted', async () => {
    await create(syntheticSlug('receipt'), content(), 'receipt-immutable');
    const id = operationId('receipt-immutable');
    await expect(engine.executeRaw('UPDATE sealed_page_receipts SET slug = $1 WHERE operation_id = $2', ['changed', id])).rejects.toThrow(/immutable/i);
    await expect(engine.executeRaw('DELETE FROM sealed_page_receipts WHERE operation_id = $1', [id])).rejects.toThrow(/immutable/i);
  });

  test('every receipt read verifies hashes and the persisted page exactly', async () => {
    const slug = syntheticSlug('forged-receipt');
    await create(slug, content(), 'forged-receipt');
    const id = operationId('forged-receipt');
    const forgedProjection = {
      slug,
      type: 'note',
      title: 'Forged',
      compiled_truth: 'forged body',
      frontmatter: { owner: 'test', title: 'Forged', type: 'note' },
    };
    const forgedCanonicalHash = sha(canonicalJson(forgedProjection));
    await engine.executeRaw('ALTER TABLE sealed_page_receipts DISABLE TRIGGER protect_sealed_receipt_trg');
    await engine.executeRaw(
      `UPDATE sealed_page_receipts
          SET canonical_projection=$1::text::jsonb,
              canonical_page_sha256=$2,
              receipt_id=$3
        WHERE operation_id=$4`,
      [canonicalJson(forgedProjection), forgedCanonicalHash, 'e'.repeat(64), id],
    );
    await engine.executeRaw('ALTER TABLE sealed_page_receipts ENABLE TRIGGER protect_sealed_receipt_trg');

    await expect(create(slug, content(), 'forged-receipt')).rejects.toThrow(/integrity/i);
  });

  test('every receipt read rejects altered deterministic chunk fields', async () => {
    const mutations = [
      "chunk_index = 77",
      "chunk_text = 'tampered chunk'",
      "chunk_source = 'timeline'",
      'token_count = 77',
      "modality = 'image'",
    ];

    for (const [index, mutation] of mutations.entries()) {
      const label = `forged-chunk-${index}`;
      const slug = syntheticSlug(label);
      const markdown = content(`Forged chunk ${index}`);
      await create(slug, markdown, label);
      const page = await engine.getPage(slug, { sourceId: 'default' });
      expect(page).not.toBeNull();

      await engine.executeRaw('ALTER TABLE content_chunks DISABLE TRIGGER protect_sealed_chunk_trg');
      await engine.executeRaw(
        `UPDATE content_chunks SET ${mutation} WHERE page_id = $1 AND chunk_index = 0`,
        [page!.id],
      );
      await engine.executeRaw('ALTER TABLE content_chunks ENABLE TRIGGER protect_sealed_chunk_trg');

      await expect(create(slug, markdown, label)).rejects.toThrow(/integrity/i);
    }
  });

  test('receipt schema enforces exact protocol and SHA forms', async () => {
    const slug = syntheticSlug('receipt-shapes');
    await create(slug, content(), 'receipt-shapes');
    const id = operationId('receipt-shapes');
    await engine.executeRaw('ALTER TABLE sealed_page_receipts DISABLE TRIGGER protect_sealed_receipt_trg');
    await expect(engine.executeRaw(
      'UPDATE sealed_page_receipts SET server_build_commit=$1 WHERE operation_id=$2',
      ['A'.repeat(40), id],
    )).rejects.toThrow();
    await expect(engine.executeRaw(
      'UPDATE sealed_page_receipts SET protocol_version=$1 WHERE operation_id=$2',
      ['gbrain.create_page.v2', id],
    )).rejects.toThrow();
    await engine.executeRaw('ALTER TABLE sealed_page_receipts ENABLE TRIGGER protect_sealed_receipt_trg');
  });

  test('sealed page chunks reject insert, update, and delete', async () => {
    const slug = syntheticSlug('chunk-immutable');
    await create(slug, content(), 'chunk-immutable');
    const page = await engine.getPage(slug, { sourceId: 'default' });
    expect(page).not.toBeNull();
    await expect(engine.executeRaw(
      "UPDATE content_chunks SET chunk_text='changed' WHERE page_id=$1", [page!.id],
    )).rejects.toThrow(/sealed/i);
    await expect(engine.executeRaw(
      'DELETE FROM content_chunks WHERE page_id=$1', [page!.id],
    )).rejects.toThrow(/sealed/i);
    await expect(engine.executeRaw(
      `INSERT INTO content_chunks
       (page_id, chunk_index, chunk_text, chunk_source, modality)
       VALUES ($1, 999, 'extra', 'compiled_truth', 'text')`,
      [page!.id],
    )).rejects.toThrow(/sealed/i);
  });

  test('chunk failure rolls back page and receipt', async () => {
    await engine.executeRaw(`CREATE OR REPLACE FUNCTION fail_sealed_chunk_test() RETURNS trigger AS $$
      BEGIN
        IF NEW.chunk_text LIKE '%ROLLBACK_SENTINEL%' THEN
          RAISE EXCEPTION 'forced chunk failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await engine.executeRaw('DROP TRIGGER IF EXISTS fail_sealed_chunk_test_trg ON content_chunks');
    await engine.executeRaw(`CREATE TRIGGER fail_sealed_chunk_test_trg BEFORE INSERT ON content_chunks
      FOR EACH ROW EXECUTE FUNCTION fail_sealed_chunk_test()`);
    const slug = syntheticSlug('rollback');
    const markdown = content('Rollback', 'ROLLBACK_SENTINEL');
    await expect(create(slug, markdown, 'rollback')).rejects.toThrow(/forced chunk failure/i);
    expect(await engine.getPage(slug, { sourceId: 'default' })).toBeNull();
    const rows = await engine.executeRaw('SELECT operation_id FROM sealed_page_receipts WHERE operation_id = $1', [operationId('rollback')]);
    expect(rows).toHaveLength(0);
    await engine.executeRaw('DROP TRIGGER fail_sealed_chunk_test_trg ON content_chunks');
    await engine.executeRaw('DROP FUNCTION fail_sealed_chunk_test()');
  });

  test('lost response is recovered by an identical retry', async () => {
    const slug = syntheticSlug('lost-response');
    const markdown = content('Lost response');
    await create(slug, markdown, 'lost-response');
    const retry = await create(slug, markdown, 'lost-response');
    expect(retry.status).toBe('matched');
    const rows = await engine.executeRaw('SELECT count(*)::int AS n FROM sealed_page_receipts WHERE operation_id = $1', [operationId('lost-response')]);
    expect(Number((rows[0] as any).n)).toBe(1);
  });

  test('concurrent operation ids on one slug produce one winner', async () => {
    const slug = syntheticSlug('concurrent');
    const markdown = content('Concurrent');
    const settled = await Promise.allSettled([
      create(slug, markdown, 'concurrent-a'),
      create(slug, markdown, 'concurrent-b'),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(OperationError);
    expect(rejected.reason.code).toBe('page_conflict');
  });

  test('enforces subagent and OAuth slug fences', async () => {
    const markdown = content('Fence');
    const slug = syntheticSlug('fence');
    await expectCode(create(slug, markdown, 'subagent-fence', {
      viaSubagent: true,
      subagentId: 7,
    }), 'permission_denied');
    await expectCode(create(slug, markdown, 'oauth-fence', {
      auth: { clientId: 'client-a', scopes: ['write'], boundSlugPrefixes: ['allowed/'] } as any,
    }), 'permission_denied');
  });

  test('rejects hostile hashes, empty content, and a false request hash', async () => {
    const op = operations.find((candidate) => candidate.name === 'create_page')!;
    const markdown = content('Hostile');
    const slug = syntheticSlug('hostile');
    const base = { slug, content: markdown, request_sha256: requestHash(slug, markdown) };
    await expectCode(op.handler(context(), { ...base, operation_id: 'A'.repeat(64) }), 'invalid_params');
    await expectCode(op.handler(context(), { ...base, operation_id: 'a'.repeat(63) }), 'invalid_params');
    await expectCode(op.handler(context(), { ...base, operation_id: operationId('hostile'), request_sha256: '0'.repeat(64) }), 'invalid_params');
    await expectCode(op.handler(context(), { ...base, operation_id: operationId('empty'), content: '   ', request_sha256: requestHash(slug, '   ') }), 'invalid_params');
  });

  test('ordinary put_page keeps update behavior', async () => {
    const put = operations.find((candidate) => candidate.name === 'put_page')!;
    await put.handler(context({ remote: false }), { slug: 'normal/update', content: content('Before') });
    await put.handler(context({ remote: false }), { slug: 'normal/update', content: content('After') });
    expect((await engine.getPage('normal/update', { sourceId: 'default' }))?.title).toBe('After');
  });

  test('v133 verifier rejects disabled triggers and unsafe function search paths on PGLite', async () => {
    const migration = MIGRATIONS.find((candidate) => candidate.version === 133);
    expect(migration?.verify).toBeDefined();
    expect(await migration!.verify!(engine)).toBe(true);

    await engine.executeRaw('ALTER TABLE content_chunks DISABLE TRIGGER protect_sealed_chunk_trg');
    try {
      expect(await migration!.verify!(engine)).toBe(false);
    } finally {
      await engine.executeRaw('ALTER TABLE content_chunks ENABLE TRIGGER protect_sealed_chunk_trg');
    }

    await engine.executeRaw('ALTER FUNCTION protect_sealed_chunk_fn() SET search_path = public');
    try {
      expect(await migration!.verify!(engine)).toBe(false);
    } finally {
      await engine.executeRaw("ALTER FUNCTION protect_sealed_chunk_fn() SET search_path = pg_catalog, public");
    }
    expect(await migration!.verify!(engine)).toBe(true);
  });
});
