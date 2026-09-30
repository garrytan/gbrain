// Guard self-test fixture (known-BAD): the generated PGLite template (refactor
// wave 1) carrying an unhardened trigger function.
export const PGLITE_SCHEMA_TEMPLATE = `
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;
`;
