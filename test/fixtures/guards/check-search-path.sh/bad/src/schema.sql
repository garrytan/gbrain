-- Guard self-test fixture (known-BAD): unhardened trigger function.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;
