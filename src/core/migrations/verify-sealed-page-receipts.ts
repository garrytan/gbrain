import type { BrainEngine } from '../engine.ts';

function normalizeCatalogDefinition(definition: string): string {
  return definition.replace(/::text/g, '').replace(/[()\s]+/g, '');
}

function normalizeFunctionBody(body: string): string {
  return body.replace(/\s+/g, ' ').trim();
}

export async function verifySealedPageReceiptsMigration(engine: BrainEngine): Promise<boolean> {
  const columns = await engine.executeRaw<{
    column_name: string;
    data_type: string;
    udt_name: string;
    is_nullable: string;
    column_default: string;
  }>(
    `SELECT column_name, data_type, udt_name, is_nullable,
            COALESCE(column_default, '') AS column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sealed_page_receipts'
      ORDER BY ordinal_position`,
  );
  const expectedColumns = [
    ['protocol_version', 'text', 'text', 'NO', ''],
    ['operation_id', 'text', 'text', 'NO', ''],
    ['source_id', 'text', 'text', 'NO', ''],
    ['slug', 'text', 'text', 'NO', ''],
    ['request_sha256', 'text', 'text', 'NO', ''],
    ['page_id', 'integer', 'int4', 'NO', ''],
    ['page_revision', 'bigint', 'int8', 'NO', ''],
    ['canonical_page_sha256', 'text', 'text', 'NO', ''],
    ['canonical_projection', 'jsonb', 'jsonb', 'NO', ''],
    ['committed_at', 'timestamp with time zone', 'timestamptz', 'NO', 'now()'],
    ['server_build_commit', 'text', 'text', 'NO', ''],
    ['receipt_id', 'text', 'text', 'NO', ''],
  ];
  const actualColumns = columns.map((column) => [
    column.column_name,
    column.data_type,
    column.udt_name,
    column.is_nullable,
    column.column_default,
  ]);
  if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) return false;

  const constraints = await engine.executeRaw<{ contype: string; definition: string }>(
    `SELECT c.contype::text, pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public' AND t.relname = 'sealed_page_receipts'`,
  );
  const actualConstraints = constraints
    .map((constraint) => `${constraint.contype}:${normalizeCatalogDefinition(constraint.definition)}`)
    .sort();
  const expectedConstraints = [
    "c:CHECK(protocol_version = 'gbrain.create_page.v1')",
    "c:CHECK(operation_id ~ '^[a-f0-9]{64}$')",
    "c:CHECK(request_sha256 ~ '^[a-f0-9]{64}$')",
    'c:CHECK(page_revision > 0)',
    "c:CHECK(canonical_page_sha256 ~ '^[a-f0-9]{64}$')",
    "c:CHECK(server_build_commit ~ '^[a-f0-9]{40}$')",
    "c:CHECK(receipt_id ~ '^[a-f0-9]{64}$')",
    `c:CHECK(
      canonical_projection = jsonb_build_object(
        'slug', canonical_projection->'slug',
        'type', canonical_projection->'type',
        'title', canonical_projection->'title',
        'compiled_truth', canonical_projection->'compiled_truth',
        'frontmatter', canonical_projection->'frontmatter'
      )
      AND canonical_projection->>'slug' = slug
      AND jsonb_typeof(canonical_projection->'slug') = 'string'
      AND jsonb_typeof(canonical_projection->'type') = 'string'
      AND jsonb_typeof(canonical_projection->'title') = 'string'
      AND jsonb_typeof(canonical_projection->'compiled_truth') = 'string'
      AND jsonb_typeof(canonical_projection->'frontmatter') = 'object'
    )`,
    'p:PRIMARY KEY (operation_id)',
    'f:FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE RESTRICT',
    'f:FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE RESTRICT',
    'u:UNIQUE (page_id)',
    'u:UNIQUE (receipt_id)',
    'u:UNIQUE (source_id, slug)',
  ].map((definition) => normalizeCatalogDefinition(definition)).sort();
  if (JSON.stringify(actualConstraints) !== JSON.stringify(expectedConstraints)) return false;

  const functions = await engine.executeRaw<{
    proname: string;
    prosrc: string;
    lanname: string;
    provolatile: string;
    proisstrict: boolean;
    prosecdef: boolean;
    proleakproof: boolean;
    proparallel: string;
    prokind: string;
    pronargs: number;
    return_type: string;
    function_config: string;
    trusted_owner: boolean;
    public_can_execute: boolean;
  }>(
    `SELECT p.proname, p.prosrc, l.lanname, p.provolatile::text,
            p.proisstrict, p.prosecdef, p.proleakproof, p.proparallel::text,
            p.prokind::text, p.pronargs, p.prorettype::regtype::text AS return_type,
            COALESCE(array_to_string(p.proconfig, ','), '') AS function_config,
            (NOT p.prosecdef OR p.proowner = (
              SELECT relowner FROM pg_class WHERE oid = 'public.sealed_page_receipts'::regclass
            )) AS trusted_owner,
            has_function_privilege('public', p.oid, 'EXECUTE') AS public_can_execute
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       JOIN pg_language l ON l.oid = p.prolang
      WHERE n.nspname = 'public'
        AND p.proname IN ('protect_sealed_page_fn', 'protect_sealed_receipt_fn', 'protect_sealed_chunk_fn')
      ORDER BY p.proname`,
  );
  const actualFunctions = functions.map((fn) => [
    fn.proname,
    normalizeFunctionBody(fn.prosrc),
    fn.lanname,
    fn.provolatile,
    fn.proisstrict,
    fn.prosecdef,
    fn.proleakproof,
    fn.proparallel,
    fn.prokind,
    Number(fn.pronargs),
    fn.return_type,
    fn.function_config,
    fn.trusted_owner,
    fn.public_can_execute,
  ]);
  const invokerProperties = ['plpgsql', 'v', false, false, false, 'u', 'f', 0, 'trigger', 'search_path=pg_catalog, public', true, true];
  const definerProperties = ['plpgsql', 'v', false, true, false, 'u', 'f', 0, 'trigger', 'search_path=pg_catalog, public', true, false];
  const expectedFunctions = [
    [
      'protect_sealed_chunk_fn',
      normalizeFunctionBody(`
        DECLARE protected_page_id INTEGER;
        BEGIN
          protected_page_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.page_id ELSE OLD.page_id END;
          IF EXISTS (SELECT 1 FROM public.sealed_page_receipts WHERE page_id = protected_page_id)
            OR (TG_OP = 'UPDATE' AND NEW.page_id <> OLD.page_id
                AND EXISTS (SELECT 1 FROM public.sealed_page_receipts WHERE page_id = NEW.page_id)) THEN
            RAISE EXCEPTION 'sealed page chunk is immutable: page_id=%', protected_page_id USING ERRCODE = '55000';
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END;
      `),
      ...definerProperties,
    ],
    [
      'protect_sealed_page_fn',
      normalizeFunctionBody(`
        BEGIN
          IF EXISTS (SELECT 1 FROM public.sealed_page_receipts WHERE page_id = OLD.id) THEN
            RAISE EXCEPTION 'sealed page is immutable: %/%', OLD.source_id, OLD.slug USING ERRCODE = '55000';
          END IF;
          RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
        END;
      `),
      ...definerProperties,
    ],
    [
      'protect_sealed_receipt_fn',
      normalizeFunctionBody(`
        BEGIN
          RAISE EXCEPTION 'sealed page receipt is immutable' USING ERRCODE = '55000';
        END;
      `),
      ...invokerProperties,
    ],
  ];
  if (JSON.stringify(actualFunctions) !== JSON.stringify(expectedFunctions)) return false;

  const triggers = await engine.executeRaw<{
    tgname: string;
    table_name: string;
    function_name: string;
    enabled: string;
    definition: string;
    function_config: string;
  }>(
    `SELECT tg.tgname, t.relname AS table_name, p.proname AS function_name,
            tg.tgenabled::text AS enabled, pg_get_triggerdef(tg.oid) AS definition,
            COALESCE(array_to_string(p.proconfig, ','), '') AS function_config
       FROM pg_trigger tg
       JOIN pg_class t ON t.oid = tg.tgrelid
       JOIN pg_namespace tn ON tn.oid = t.relnamespace
       JOIN pg_proc p ON p.oid = tg.tgfoid
       JOIN pg_namespace pn ON pn.oid = p.pronamespace
      WHERE NOT tg.tgisinternal
        AND tn.nspname = 'public'
        AND pn.nspname = 'public'
        AND tg.tgname IN ('protect_sealed_page_trg', 'protect_sealed_receipt_trg', 'protect_sealed_chunk_trg')
      ORDER BY tg.tgname`,
  );
  const actualTriggers = triggers.map((trigger) => [
    trigger.tgname,
    trigger.table_name,
    trigger.function_name,
    trigger.enabled,
    trigger.definition.replace(/\s+/g, ' ').trim(),
    trigger.function_config,
  ]);
  const expectedTriggers = [
    [
      'protect_sealed_chunk_trg', 'content_chunks', 'protect_sealed_chunk_fn', 'O',
      'CREATE TRIGGER protect_sealed_chunk_trg BEFORE INSERT OR DELETE OR UPDATE ON public.content_chunks FOR EACH ROW EXECUTE FUNCTION protect_sealed_chunk_fn()',
      'search_path=pg_catalog, public',
    ],
    [
      'protect_sealed_page_trg', 'pages', 'protect_sealed_page_fn', 'O',
      'CREATE TRIGGER protect_sealed_page_trg BEFORE DELETE OR UPDATE ON public.pages FOR EACH ROW EXECUTE FUNCTION protect_sealed_page_fn()',
      'search_path=pg_catalog, public',
    ],
    [
      'protect_sealed_receipt_trg', 'sealed_page_receipts', 'protect_sealed_receipt_fn', 'O',
      'CREATE TRIGGER protect_sealed_receipt_trg BEFORE DELETE OR UPDATE ON public.sealed_page_receipts FOR EACH ROW EXECUTE FUNCTION protect_sealed_receipt_fn()',
      'search_path=pg_catalog, public',
    ],
  ];
  if (JSON.stringify(actualTriggers) !== JSON.stringify(expectedTriggers)) return false;

  const table = await engine.executeRaw<{ relrowsecurity: boolean }>(
    `SELECT relrowsecurity FROM pg_class
      WHERE oid = 'public.sealed_page_receipts'::regclass`,
  );
  return table.length === 1 && table[0].relrowsecurity === true;
}
