#!/usr/bin/env bun
/**
 * Regenerates the three PostgreSQL goldens the keyword-search ports are tested against:
 *
 *   english_stem.tsv  `ts_lexize('english_stem', word)`   (src/keyword/stem.rs)
 *   ts_parse.json     `ts_parse('default', input)`         (src/keyword/parser.rs)
 *   tsearch.json      to_tsvector / tsquery builders / @@ / ts_rank / ts_rank_cd   (src/keyword/tsearch.rs)
 *
 * The goldens come from a real PostgreSQL, never from the Rust code under test: PGLite 0.5.16
 * (PostgreSQL 18.6). The repository's own PGLite (0.4.3) is a different PostgreSQL, so this script
 * installs the exact version into a scratch directory instead of using node_modules.
 *
 * What this script reads and what it computes. The INPUT columns (the words, parser inputs, texts,
 * queries and A/B/C document triples, including the `@rep:<unit>:<count>:<suffix>` long-input
 * shorthand the rank documents use) are read from the committed fixture files: they are the hand-written lists and the
 * seeded random corpora, and the fixtures are the only record of them. Every OUTPUT column
 * (lexeme, token list, tsvector text, tsquery text, match, rank, rank_cd, lexeme count and vector
 * md5) is recomputed by PGLite. So a clean run proves the committed goldens are what PostgreSQL
 * 18.6 says, byte for byte; it does not invent new inputs.
 *
 * Usage (from the repository root):
 *   bun rust/crates/gbrain-store/tests/fixtures/regen-search-goldens.ts           # check: exit 1 on any difference
 *   bun rust/crates/gbrain-store/tests/fixtures/regen-search-goldens.ts --write   # rewrite the three files
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installPglite, PGLITE_VERSION } from '../../../../scripts/lib/pglite-golden.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../../..');
const write = process.argv.includes('--write');

/** `gbrain_fts_input`, the function the indexing path installs (src/core/fts-language.ts). */
async function ftsInputSql(): Promise<string> {
  const mod = await import(join(repoRoot, 'src/core/fts-language.ts'));
  return mod.FTS_INPUT_FUNCTION_SQL as string;
}

/** Expands the `@rep:<unit>:<count>:<suffix>` shorthand exactly as tsearch.rs's `expand` does. */
function expand(t: string): string {
  if (!t.startsWith('@rep:')) return t;
  const spec = t.slice('@rep:'.length);
  const i = spec.indexOf(':');
  const unit = spec.slice(0, i);
  const rest = spec.slice(i + 1);
  const j = rest.indexOf(':');
  return unit.repeat(Number(rest.slice(0, j))) + rest.slice(j + 1);
}

/** The committed files are Python-style compact JSON, UTF-8, no trailing newline. */
const dump = (v: unknown) => JSON.stringify(v);

const { PGlite } = (await import(installPglite())) as { PGlite: new () => any };
const db = new PGlite();
await db.exec(await ftsInputSql());
const version = (await db.query('select version() as v')).rows[0].v as string;
console.log(`PGLite ${PGLITE_VERSION}: ${version}`);

const stemPath = join(here, 'english_stem.tsv');
const parsePath = join(here, 'ts_parse.json');
const tsearchPath = join(here, 'tsearch.json');

// english_stem.tsv: `word<TAB>lexeme`, `<stop>` for a stopword.
const stemWords = readFileSync(stemPath, 'utf8')
  .split('\n')
  .filter((l, i, a) => i < a.length - 1 || l !== '')
  .map((l) => l.slice(0, l.indexOf('\t')));
const stemLines: string[] = [];
for (let i = 0; i < stemWords.length; i += 2000) {
  const chunk = stemWords.slice(i, i + 2000);
  const res = await db.query(
    `select w, ts_lexize('english_stem', w) as lex from unnest($1::text[]) with ordinality as t(w, n) order by n`,
    [chunk],
  );
  for (const row of res.rows) stemLines.push(`${row.w}\t${row.lex === null || row.lex.length === 0 ? '<stop>' : row.lex[0]}`);
}
const stemOut = stemLines.join('\n') + '\n';

// ts_parse.json: [[input, [[tokid, token], ...]], ...]
const parseInputs: string[] = (JSON.parse(readFileSync(parsePath, 'utf8')) as [string, unknown][]).map((c) => c[0]);
const parseCases: [string, [number, string][]][] = [];
for (const input of parseInputs) {
  const res = await db.query(`select tokid, token from ts_parse('default', $1)`, [input]);
  parseCases.push([input, res.rows.map((r: any) => [Number(r.tokid), r.token as string])]);
}
const parseOut = dump(parseCases);

// tsearch.json
const old = JSON.parse(readFileSync(tsearchPath, 'utf8'));
const text1 = async (sql: string, params: unknown[]) => {
  const v = (await db.query(sql, params)).rows[0].x as string | null;
  return v === null ? '<null>' : v;
};
const vectors: any[] = [];
for (const { text } of old.vectors) {
  vectors.push({
    text,
    tsv: await text1(`select to_tsvector('english', $1)::text as x`, [text]),
    fts_input: await text1(`select gbrain_fts_input($1) as x`, [text]),
  });
}
const queries: any[] = [];
for (const { text } of old.queries) {
  const t = text;
  queries.push({
    text,
    plain: await text1(`select plainto_tsquery('english', $1)::text as x`, [t]),
    phrase: await text1(`select phraseto_tsquery('english', $1)::text as x`, [t]),
    web: await text1(`select websearch_to_tsquery('english', $1)::text as x`, [t]),
    or: await text1(`select NULLIF(replace(plainto_tsquery('english', $1)::text, ' & ', ' | '), '')::tsquery::text as x`, [t]),
  });
}
const queryOf: Record<string, string> = {
  plain: `plainto_tsquery('english', $4)`,
  phrase: `phraseto_tsquery('english', $4)`,
  web: `websearch_to_tsquery('english', $4)`,
  or: `NULLIF(replace(plainto_tsquery('english', $4)::text, ' & ', ' | '), '')::tsquery`,
};
const ranks: any[] = [];
for (const r of old.ranks) {
  const sql = `with d as (select
      setweight(to_tsvector('english', gbrain_fts_input($1)), 'A') ||
      setweight(to_tsvector('english', gbrain_fts_input($2)), 'B') ||
      setweight(to_tsvector('english', gbrain_fts_input($3)), 'C') as v),
    q as (select ${queryOf[r.kind]} as q)
    select (d.v @@ q.q)::text as m, ts_rank(d.v, q.q)::text as r, ts_rank_cd(d.v, q.q)::text as rcd,
           length(d.v) as nlex, md5(d.v::text) as vec_md5 from d, q`;
  const row = (await db.query(sql, [expand(r.a), expand(r.b), expand(r.c), r.q])).rows[0];
  ranks.push({
    a: r.a,
    b: r.b,
    c: r.c,
    q: r.q,
    kind: r.kind,
    match: row.m ?? '<null>',
    rank: row.r ?? '<null>',
    rank_cd: row.rcd ?? '<null>',
    nlex: Number(row.nlex),
    vec_md5: row.vec_md5,
  });
}
const tsearchOut = dump({ vectors, queries, ranks });

let differ = 0;
for (const [path, out] of [
  [stemPath, stemOut],
  [parsePath, parseOut],
  [tsearchPath, tsearchOut],
] as const) {
  const same = readFileSync(path, 'utf8') === out;
  console.log(`${same ? 'same   ' : 'DIFFERS'} ${path.slice(repoRoot.length + 1)}`);
  if (!same) {
    differ++;
    if (write) writeFileSync(path, out);
  }
}
await db.close();
process.exit(differ > 0 && !write ? 1 : 0);
