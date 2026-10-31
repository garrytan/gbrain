// Guard self-test fixture (known-GOOD): hardened trigger in the generated template.
export const PGLITE_SCHEMA_TEMPLATE = `
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;
`;
