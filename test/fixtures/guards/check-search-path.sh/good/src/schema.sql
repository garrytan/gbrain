-- Guard self-test fixture (known-GOOD): hardened trigger function.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger SET search_path = pg_catalog, public AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;
