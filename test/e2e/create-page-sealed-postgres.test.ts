import { createHash } from 'node:crypto';
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { operations, OperationError, type OperationContext } from '../../src/core/operations.ts';
import { __setServerBuildCommitForTests } from '../../src/core/sealed-page.ts';
import { verifySealedPageReceiptsMigration } from '../../src/core/migrations/verify-sealed-page-receipts.ts';
import { MigrationDriftError, runMigrations } from '../../src/core/migrate.ts';
import {
  assertSafeE2eDatabaseUrl,
  getConn,
  getEngine,
  hasDatabase,
  setupDB,
  teardownDB,
} from './helpers.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describePg = hasDatabase() ? describe : describe.skip;
const TEST_BUILD_COMMIT = '2'.repeat(40);
const APP_ROLE = 'gbrain_app';
const APP_PASSWORD = 'gbrain-create-page-e2e-only';

let appA: PostgresEngine;
let appB: PostgresEngine;

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const operationId = (label: string) => sha(`pg-operation:${label}`);
const slugFor = (label: string) => `synthetic/${sha(`pg-slug:${label}`)}`;
const markdownFor = (title: string, body = 'PostgreSQL sealed body.') =>
  `---\ntitle: ${title}\ntype: note\nowner: test\n---\n\n${body}`;
const requestHash = (slug: string, content: string) => sha(JSON.stringify({ slug, content }));

function appDatabaseUrl(): string {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required');
  assertSafeE2eDatabaseUrl(DATABASE_URL);
  const url = new URL(DATABASE_URL);
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.toString();
}

function context(engine: PostgresEngine): OperationContext {
  return {
    engine,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
  };
}

async function create(engine: PostgresEngine, slug: string, markdown: string, label: string) {
  const op = operations.find((candidate) => candidate.name === 'create_page');
  if (!op) throw new Error('create_page operation is missing');
  return await op.handler(context(engine), {
    operation_id: operationId(label),
    slug,
    content: markdown,
    request_sha256: requestHash(slug, markdown),
  }) as any;
}

async function expectOperationCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(OperationError);
    expect((error as OperationError).code).toBe(code);
  }
}

async function dropAppPolicies(): Promise<void> {
  const conn = getConn();
  await conn.unsafe('DROP POLICY IF EXISTS create_page_app_pages ON pages');
  await conn.unsafe('DROP POLICY IF EXISTS create_page_app_chunks ON content_chunks');
  await conn.unsafe('DROP POLICY IF EXISTS create_page_app_receipts ON sealed_page_receipts').catch(() => {});
}

async function installRestrictedAppRole(): Promise<void> {
  const conn = getConn();
  await dropAppPolicies();
  await conn.unsafe(`DROP OWNED BY ${APP_ROLE}`).catch(() => {});
  await conn.unsafe(`DROP ROLE IF EXISTS ${APP_ROLE}`);
  await conn.unsafe(
    `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
  );
  await conn.unsafe(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
  await conn.unsafe(`GRANT SELECT ON sources, timeline_entries TO ${APP_ROLE}`);
  await conn.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON pages, content_chunks, sealed_page_receipts TO ${APP_ROLE}`);
  await conn.unsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
  await conn.unsafe(
    `CREATE POLICY create_page_app_pages ON pages TO ${APP_ROLE}
       USING (source_id = 'default') WITH CHECK (source_id = 'default')`,
  );
  await conn.unsafe(
    `CREATE POLICY create_page_app_chunks ON content_chunks TO ${APP_ROLE}
       USING (EXISTS (SELECT 1 FROM pages WHERE pages.id = content_chunks.page_id))
       WITH CHECK (EXISTS (SELECT 1 FROM pages WHERE pages.id = content_chunks.page_id))`,
  );
  await conn.unsafe(
    `CREATE POLICY create_page_app_receipts ON sealed_page_receipts TO ${APP_ROLE}
       USING (source_id = 'default') WITH CHECK (source_id = 'default')`,
  );
}

async function resetSealedRows(): Promise<void> {
  await getConn().unsafe('TRUNCATE sealed_page_receipts, content_chunks, pages CASCADE');
}

describePg('create_page sealed gate — real PostgreSQL', () => {
  beforeAll(async () => {
    if (!DATABASE_URL) return;
    assertSafeE2eDatabaseUrl(DATABASE_URL);
    __setServerBuildCommitForTests(TEST_BUILD_COMMIT);
    await setupDB();
    await installRestrictedAppRole();
    appA = new PostgresEngine();
    appB = new PostgresEngine();
    await appA.connect({ database_url: appDatabaseUrl(), poolSize: 1 });
    await appB.connect({ database_url: appDatabaseUrl(), poolSize: 1 });
  }, 120_000);

  afterAll(async () => {
    await appA?.disconnect();
    await appB?.disconnect();
    if (hasDatabase()) {
      await dropAppPolicies();
      await getConn().unsafe(`DROP OWNED BY ${APP_ROLE}`).catch(() => {});
      await getConn().unsafe(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => {});
    }
    await teardownDB();
    __setServerBuildCommitForTests(null);
  }, 60_000);

  beforeEach(async () => {
    await resetSealedRows();
  });

  test('two independent connections concurrently create exactly one sealed page', async () => {
    const [sessionA, sessionB] = await Promise.all([
      appA.executeRaw<{ pid: number }>('SELECT pg_backend_pid()::int AS pid'),
      appB.executeRaw<{ pid: number }>('SELECT pg_backend_pid()::int AS pid'),
    ]);
    expect(sessionA[0].pid).not.toBe(sessionB[0].pid);

    const slug = slugFor('same-concurrent');
    const markdown = markdownFor('Same concurrent request');
    const results = await Promise.all([
      create(appA, slug, markdown, 'same-concurrent'),
      create(appB, slug, markdown, 'same-concurrent'),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['created', 'matched']);
    expect(results[0].receipt).toEqual(results[1].receipt);
    const counts = await getEngine().executeRaw<{ pages: number; receipts: number }>(
      `SELECT
         (SELECT count(*)::int FROM pages WHERE source_id = 'default' AND slug = $1) AS pages,
         (SELECT count(*)::int FROM sealed_page_receipts WHERE source_id = 'default' AND slug = $1) AS receipts`,
      [slug],
    );
    expect(Number(counts[0].pages)).toBe(1);
    expect(Number(counts[0].receipts)).toBe(1);
  }, 30_000);

  test('an identical retry returns the persisted matched receipt', async () => {
    const slug = slugFor('retry');
    const markdown = markdownFor('Retry');
    const first = await create(appA, slug, markdown, 'retry');
    const retry = await create(appB, slug, markdown, 'retry');

    expect(first.status).toBe('created');
    expect(retry.status).toBe('matched');
    expect(retry.receipt).toEqual(first.receipt);
  });

  test('a different operation_id on the same slug returns page_conflict', async () => {
    const slug = slugFor('slug-conflict');
    const markdown = markdownFor('Slug conflict');
    await create(appA, slug, markdown, 'slug-conflict-a');
    await expectOperationCode(create(appB, slug, markdown, 'slug-conflict-b'), 'page_conflict');
  });

  test('a receipt failure rolls back the page, chunks, and receipt together', async () => {
    const slug = slugFor('receipt-rollback');
    const markdown = markdownFor('Receipt rollback', 'ROLLBACK_RECEIPT_SENTINEL');
    const conn = getConn();
    await conn.unsafe(`CREATE OR REPLACE FUNCTION fail_create_page_receipt_test() RETURNS trigger AS $$
      BEGIN
        IF NEW.slug = '${slug}' THEN RAISE EXCEPTION 'forced receipt failure'; END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await conn.unsafe(`CREATE TRIGGER fail_create_page_receipt_test_trg
      BEFORE INSERT ON sealed_page_receipts FOR EACH ROW EXECUTE FUNCTION fail_create_page_receipt_test()`);
    try {
      await expect(create(appA, slug, markdown, 'receipt-rollback')).rejects.toThrow(/forced receipt failure/i);
      const rows = await getEngine().executeRaw<{ pages: number; chunks: number; receipts: number }>(
        `SELECT
           (SELECT count(*)::int FROM pages WHERE slug = $1) AS pages,
           (SELECT count(*)::int FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1) AS chunks,
           (SELECT count(*)::int FROM sealed_page_receipts WHERE slug = $1) AS receipts`,
        [slug],
      );
      expect(rows[0]).toEqual({ pages: 0, chunks: 0, receipts: 0 });
    } finally {
      await conn.unsafe('DROP TRIGGER IF EXISTS fail_create_page_receipt_test_trg ON sealed_page_receipts');
      await conn.unsafe('DROP FUNCTION IF EXISTS fail_create_page_receipt_test()');
    }
  });

  test('gbrain_app creates and reads its receipt while RLS is active', async () => {
    const role = await appA.executeRaw<{ current_user: string; bypass: boolean }>(
      `SELECT current_user, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
    );
    expect(role[0]).toEqual({ current_user: APP_ROLE, bypass: false });
    const rls = await appA.executeRaw<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE oid = 'sealed_page_receipts'::regclass`,
    );
    expect(rls[0].relrowsecurity).toBe(true);

    const slug = slugFor('rls-create-read');
    const markdown = markdownFor('RLS create and read');
    const created = await create(appA, slug, markdown, 'rls-create-read');
    const rows = await appB.executeRaw<{ operation_id: string; slug: string }>(
      'SELECT operation_id, slug FROM sealed_page_receipts WHERE operation_id = $1',
      [operationId('rls-create-read')],
    );
    expect(created.status).toBe('created');
    expect(rows).toEqual([{ operation_id: operationId('rls-create-read'), slug }]);
  });

  test('gbrain_app cannot mutate sealed pages, chunks, or receipts', async () => {
    const slug = slugFor('restricted-immutable');
    await create(appA, slug, markdownFor('Restricted immutable'), 'restricted-immutable');
    const page = await appB.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]);
    const pageId = Number(page[0].id);

    await expect(appB.executeRaw('UPDATE pages SET title = $1 WHERE id = $2', ['changed', pageId])).rejects.toThrow(/sealed/i);
    await expect(appB.executeRaw('DELETE FROM pages WHERE id = $1', [pageId])).rejects.toThrow(/sealed/i);
    await expect(appB.executeRaw('UPDATE content_chunks SET chunk_text = $1 WHERE page_id = $2', ['changed', pageId])).rejects.toThrow(/sealed/i);
    await expect(appB.executeRaw('DELETE FROM content_chunks WHERE page_id = $1', [pageId])).rejects.toThrow(/sealed/i);
    await expect(appB.executeRaw('UPDATE sealed_page_receipts SET slug = $1 WHERE page_id = $2', ['changed', pageId])).rejects.toThrow(/immutable/i);
    await expect(appB.executeRaw('DELETE FROM sealed_page_receipts WHERE page_id = $1', [pageId])).rejects.toThrow(/immutable/i);
  });

  test('page trigger sees sealed receipts hidden from a NOBYPASSRLS caller', async () => {
    const sealedSlug = slugFor('rls-hidden-receipt');
    await create(appA, sealedSlug, markdownFor('RLS hidden receipt'), 'rls-hidden-receipt');
    const sealedPage = await appB.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [sealedSlug]);
    const sealedPageId = Number(sealedPage[0].id);
    const ordinarySlug = slugFor('rls-ordinary-page');
    const ordinaryPage = await getEngine().executeRaw<{ id: number }>(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth)
       VALUES ('default', $1, 'note', 'Ordinary page', 'Mutable body')
       RETURNING id`,
      [ordinarySlug],
    );
    const conn = getConn();

    await conn.unsafe('DROP POLICY create_page_app_receipts ON sealed_page_receipts');
    try {
      const hidden = await appB.executeRaw<{ count: number }>(
        'SELECT count(*)::int AS count FROM sealed_page_receipts WHERE page_id = $1',
        [sealedPageId],
      );
      expect(Number(hidden[0].count)).toBe(0);
      await expect(
        appB.executeRaw('UPDATE pages SET title = $1 WHERE id = $2', ['changed', sealedPageId]),
      ).rejects.toThrow(/sealed/i);
      await expect(
        appB.executeRaw('UPDATE pages SET title = $1 WHERE id = $2', ['Ordinary changed', Number(ordinaryPage[0].id)]),
      ).resolves.toBeDefined();
    } finally {
      await conn.unsafe(
        `CREATE POLICY create_page_app_receipts ON sealed_page_receipts TO ${APP_ROLE}
           USING (source_id = 'default') WITH CHECK (source_id = 'default')`,
      );
    }
  });

  test('migration verifier rejects additional permissive receipt policies', async () => {
    const engine = getEngine();
    const conn = getConn();
    await conn.unsafe('DROP POLICY create_page_app_receipts ON sealed_page_receipts');
    try {
      expect(await verifySealedPageReceiptsMigration(engine)).toBe(true);
      await conn.unsafe(
        'CREATE POLICY hostile_receipt_policy ON sealed_page_receipts TO PUBLIC USING (true) WITH CHECK (true)',
      );
      expect(await verifySealedPageReceiptsMigration(engine)).toBe(false);
    } finally {
      await conn.unsafe('DROP POLICY IF EXISTS hostile_receipt_policy ON sealed_page_receipts');
      await conn.unsafe(
        `CREATE POLICY create_page_app_receipts ON sealed_page_receipts TO ${APP_ROLE}
           USING (source_id = 'default') WITH CHECK (source_id = 'default')`,
      );
    }
  });

  test('migration verifier rejects coherent owner drift away from the migration user', async () => {
    const engine = getEngine();
    const conn = getConn();
    await conn.unsafe('DROP POLICY create_page_app_receipts ON sealed_page_receipts');
    const ownerRows = await conn.unsafe<{ owner: string }[]>(`
      SELECT current_user AS owner
    `);
    const trustedOwner = `"${String(ownerRows[0]?.owner).replaceAll('"', '""')}"`;
    const driftOwner = 'gbrain_drift_owner';
    expect(await verifySealedPageReceiptsMigration(engine)).toBe(true);
    await conn.unsafe(`DO $$ BEGIN
      CREATE ROLE ${driftOwner} NOLOGIN;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`);

    try {
      await conn.unsafe(`ALTER TABLE pages OWNER TO ${driftOwner}`);
      await conn.unsafe(`ALTER TABLE sealed_page_receipts OWNER TO ${driftOwner}`);
      await conn.unsafe(`ALTER FUNCTION protect_sealed_page_fn() OWNER TO ${driftOwner}`);
      await conn.unsafe(`ALTER FUNCTION protect_sealed_chunk_fn() OWNER TO ${driftOwner}`);
      expect(await verifySealedPageReceiptsMigration(engine)).toBe(false);
    } finally {
      await conn.unsafe(`ALTER TABLE pages OWNER TO ${trustedOwner}`);
      await conn.unsafe(`ALTER TABLE sealed_page_receipts OWNER TO ${trustedOwner}`);
      await conn.unsafe(`ALTER FUNCTION protect_sealed_page_fn() OWNER TO ${trustedOwner}`);
      await conn.unsafe(`ALTER FUNCTION protect_sealed_chunk_fn() OWNER TO ${trustedOwner}`);
      await conn.unsafe(`DROP ROLE IF EXISTS ${driftOwner}`);
      await conn.unsafe(
        `CREATE POLICY create_page_app_receipts ON sealed_page_receipts TO ${APP_ROLE}
           USING (source_id = 'default') WITH CHECK (source_id = 'default')`,
      );
    }
  });

  test('migration accepts an equivalent renamed source foreign key without duplicating it', async () => {
    const engine = getEngine();
    const conn = getConn();
    await dropAppPolicies();
    await conn.unsafe(
      'ALTER TABLE sealed_page_receipts RENAME CONSTRAINT sealed_page_receipts_source_id_fkey TO alternate_source_fk',
    );
    await engine.setConfig('version', '140');

    try {
      await expect(runMigrations(engine)).resolves.toMatchObject({ applied: 1 });
      const rows = await conn.unsafe<{ count: number }[]>(`
        SELECT count(*)::int AS count
          FROM pg_constraint
         WHERE conrelid = 'public.sealed_page_receipts'::regclass
           AND contype = 'f'
           AND pg_get_constraintdef(oid) =
             'FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE RESTRICT'
      `);
      expect(rows[0]?.count).toBe(1);
      expect(await engine.getConfig('version')).toBe('141');
    } finally {
      await conn.unsafe(
        'ALTER TABLE sealed_page_receipts DROP CONSTRAINT IF EXISTS sealed_page_receipts_source_id_fkey',
      );
      await conn.unsafe(
        'ALTER TABLE sealed_page_receipts RENAME CONSTRAINT alternate_source_fk TO sealed_page_receipts_source_id_fkey',
      );
      await engine.setConfig('version', '141');
    }
  }, 30_000);

  test('migration rejects a malformed pre-existing receipt table without advancing version', async () => {
    const engine = getEngine();
    const conn = getConn();
    await dropAppPolicies();
    await conn.unsafe('DROP TABLE sealed_page_receipts');
    await conn.unsafe('CREATE TABLE sealed_page_receipts (operation_id text PRIMARY KEY)');
    await engine.setConfig('version', '140');

    try {
      await expect(runMigrations(engine)).rejects.toThrow(/post-condition|schema does not match/i);
      expect(await engine.getConfig('version')).toBe('140');
    } finally {
      await conn.unsafe('DROP TABLE IF EXISTS sealed_page_receipts');
      await engine.setConfig('version', '140');
      await runMigrations(engine);
    }
  }, 30_000);

  test('migration rejects exact-shape drift and preserves the last successful version', async () => {
    const engine = getEngine();
    const conn = getConn();
    await dropAppPolicies();
    await conn.unsafe('DROP TABLE sealed_page_receipts');
    await conn.unsafe(`CREATE TABLE sealed_page_receipts (
      protocol_version varchar(99) NOT NULL CHECK (protocol_version = 'gbrain.create_page.v1'),
      operation_id varchar(64) PRIMARY KEY CHECK (operation_id ~ '^[a-f0-9]{64}$'),
      source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      slug text NOT NULL,
      request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[a-f0-9]{64}$'),
      page_id bigint NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
      page_revision integer NOT NULL CHECK (page_revision >= 0),
      canonical_page_sha256 text NOT NULL CHECK (canonical_page_sha256 ~ '^[a-f0-9]{64}$'),
      canonical_projection json NOT NULL CHECK (json_typeof(canonical_projection) = 'object'),
      committed_at timestamp NOT NULL DEFAULT now(),
      server_build_commit text NOT NULL CHECK (server_build_commit ~ '^[a-f0-9]{40}$'),
      receipt_id text NOT NULL UNIQUE CHECK (receipt_id ~ '^[a-f0-9]{64}$'),
      UNIQUE (source_id, slug)
    )`);
    await conn.unsafe(`CREATE FUNCTION wrong_sealed_trigger_fn() RETURNS trigger AS $$
      BEGIN RETURN NEW; END;
      $$ LANGUAGE plpgsql`);
    await conn.unsafe(`CREATE TRIGGER protect_sealed_chunk_trg
      BEFORE UPDATE ON timeline_entries
      FOR EACH ROW EXECUTE FUNCTION wrong_sealed_trigger_fn()`);
    await engine.setConfig('version', '140');

    try {
      await expect(runMigrations(engine)).rejects.toBeInstanceOf(MigrationDriftError);
      expect(await engine.getConfig('version')).toBe('140');
    } finally {
      await conn.unsafe('DROP TRIGGER IF EXISTS protect_sealed_chunk_trg ON timeline_entries');
      await conn.unsafe('DROP FUNCTION IF EXISTS wrong_sealed_trigger_fn()');
      await conn.unsafe('DROP TABLE IF EXISTS sealed_page_receipts');
      await engine.setConfig('version', '140');
      await runMigrations(engine);
    }
  }, 30_000);
});
