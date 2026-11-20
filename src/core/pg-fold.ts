/**
 * PGLite's case fold, spelled in SQL, so a Postgres server folds case exactly the way PGLite and the Rust engine do on
 * any server locale (#8433). Postgres' own `lower()` and `upper()` follow the server's C library: glibc lowers 69 code
 * points PGLite keeps (circled capitals, Vithkuqi, a few Latin Extended-D letters) and keeps U+00DF where PGLite
 * uppercases it to U+1E9E. Every case fold that reaches a stored hash uses these helpers instead; the whitespace half
 * is FACT_SPACE_CLASS (facts/withdrawal-schema.ts).
 *
 * The case maps are PGLite's per-code-point tables (PostgreSQL libc provider in PGLite, ctype C.UTF-8), the same
 * tables as rust/crates/gbrain-store/src/cli_reads/pg_case.rs CASE_MAP; test/pg-fold.test.ts pins both, and runs the
 * SQL against PGLite's own `lower()`/`upper()` over every code point. ASCII folds through `lower(x COLLATE "C")`,
 * which is ASCII-only on every server; each non-ASCII block is translated only when the text holds a character of
 * that block, so ASCII text pays nothing and other text scans one block's table per character.
 */

/**
 * Runs of the case maps: `start[*count[/2]]:delta`, hex start and delta, decimal count; `/2` steps every other code
 * point. A code point not covered maps to itself.
 */
const LOWER_RUNS =
  '41*26:20 c0*23:20 d8*7:20 100*24/2:1 130:-c7 132*3/2:1 139*8/2:1 14a*23/2:1 178:-79 179*3/2:1 181:d2 182*2/2:1 ' +
  '186:ce 187:1 189*2:cd 18b:1 18e:4f 18f:ca 190:cb 191:1 193:cd 194:cf 196:d3 197:d1 198:1 19c:d3 19d:d5 19f:d6 ' +
  '1a0*3/2:1 1a6:da 1a7:1 1a9:da 1ac:1 1ae:da 1af:1 1b1*2:d9 1b3*2/2:1 1b7:db 1b8:1 1bc:1 1c4:2 1c5:1 1c7:2 1c8:1 ' +
  '1ca:2 1cb*9/2:1 1de*9/2:1 1f1:2 1f2*2/2:1 1f6:-61 1f7:-38 1f8*20/2:1 220:-82 222*9/2:1 23a:2a2b 23b:1 23d:-a3 ' +
  '23e:2a28 241:1 243:-c3 244:45 245:47 246*5/2:1 370*2/2:1 376:1 37f:74 386:26 388*3:25 38c:40 38e*2:3f ' +
  '391*17:20 3a3*9:20 3cf:8 3d8*12/2:1 3f4:-3c 3f7:1 3f9:-7 3fa:1 3fd*3:-82 400*16:50 410*32:20 460*17/2:1 ' +
  '48a*27/2:1 4c0:f 4c1*7/2:1 4d0*48/2:1 531*38:30 10a0*38:1c60 10c7:1c60 10cd:1c60 13a0*80:97d0 13f0*6:8 ' +
  '1c90*43:-bc0 1cbd*3:-bc0 1e00*75/2:1 1e9e:-1dbf 1ea0*48/2:1 1f08*8:-8 1f18*6:-8 1f28*8:-8 1f38*8:-8 1f48*6:-8 ' +
  '1f59*4/2:-8 1f68*8:-8 1f88*8:-8 1f98*8:-8 1fa8*8:-8 1fb8*2:-8 1fba*2:-4a 1fbc:-9 1fc8*4:-56 1fcc:-9 1fd8*2:-8 ' +
  '1fda*2:-64 1fe8*2:-8 1fea*2:-70 1fec:-7 1ff8*2:-80 1ffa*2:-7e 1ffc:-9 2126:-1d5d 212a:-20bf 212b:-2046 2132:1c ' +
  '2160*16:10 2183:1 2c00*47:30 2c60:1 2c62:-29f7 2c63:-ee6 2c64:-29e7 2c67*3/2:1 2c6d:-2a1c 2c6e:-29fd ' +
  '2c6f:-2a1f 2c70:-2a1e 2c72:1 2c75:1 2c7e*2:-2a3f 2c80*50/2:1 2ceb*2/2:1 2cf2:1 a640*23/2:1 a680*14/2:1 ' +
  'a722*7/2:1 a732*31/2:1 a779*2/2:1 a77d:-8a04 a77e*5/2:1 a78b:1 a78d:-a528 a790*2/2:1 a796*10/2:1 a7aa:-a544 ' +
  'a7ab:-a54f a7ac:-a54b a7ad:-a541 a7ae:-a544 a7b0:-a512 a7b1:-a52a a7b2:-a515 a7b3:3a0 a7b4*6/2:1 a7c2:1 ' +
  'a7c4:-30 a7c5:-a543 a7c6:-8a38 ff21*26:20 10400*40:28 104b0*36:28 10c80*51:40 118a0*32:20 16e40*32:20 ' +
  '1e900*34:22 ';
const UPPER_RUNS =
  '61*26:-20 b5:2e7 df:1dbf e0*23:-20 f8*7:-20 ff:79 101*24/2:-1 131:-e8 133*3/2:-1 13a*8/2:-1 14b*23/2:-1 ' +
  '17a*3/2:-1 17f:-12c 180:c3 183*2/2:-1 188:-1 18c:-1 192:-1 195:61 199:-1 19a:a3 19e:82 1a1*3/2:-1 1a8:-1 ' +
  '1ad:-1 1b0:-1 1b4*2/2:-1 1b9:-1 1bd:-1 1bf:38 1c5:-1 1c6:-2 1c8:-1 1c9:-2 1cb:-1 1cc:-2 1ce*8/2:-1 1dd:-4f ' +
  '1df*9/2:-1 1f2:-1 1f3:-2 1f5:-1 1f9*20/2:-1 223*9/2:-1 23c:-1 23f*2:2a3f 242:-1 247*5/2:-1 250:2a1f 251:2a1c ' +
  '252:2a1e 253:-d2 254:-ce 256*2:-cd 259:-ca 25b:-cb 25c:a54f 260:-cd 261:a54b 263:-cf 265:a528 266:a544 268:-d1 ' +
  '269:-d3 26a:a544 26b:29f7 26c:a541 26f:-d3 271:29fd 272:-d5 275:-d6 27d:29e7 280:-da 282:a543 283:-da 287:a52a ' +
  '288:-da 289:-45 28a*2:-d9 28c:-47 292:-db 29d:a515 29e:a512 345:54 371*2/2:-1 377:-1 37b*3:82 3ac:-26 ' +
  '3ad*3:-25 3b1*17:-20 3c2:-1f 3c3*9:-20 3cc:-40 3cd*2:-3f 3d0:-3e 3d1:-39 3d5:-2f 3d6:-36 3d7:-8 3d9*12/2:-1 ' +
  '3f0:-56 3f1:-50 3f2:7 3f3:-74 3f5:-60 3f8:-1 3fb:-1 430*32:-20 450*16:-50 461*17/2:-1 48b*27/2:-1 4c2*7/2:-1 ' +
  '4cf:-f 4d1*48/2:-1 561*38:-30 10d0*43:bc0 10fd*3:bc0 13f8*6:-8 1c80:-186e 1c81:-186d 1c82:-1864 1c83*2:-1862 ' +
  '1c85:-1863 1c86:-185c 1c87:-1825 1c88:89c2 1d79:8a04 1d7d:ee6 1d8e:8a38 1e01*75/2:-1 1e9b:-3b 1ea1*48/2:-1 ' +
  '1f00*8:8 1f10*6:8 1f20*8:8 1f30*8:8 1f40*6:8 1f51*4/2:8 1f60*8:8 1f70*2:4a 1f72*4:56 1f76*2:64 1f78*2:80 ' +
  '1f7a*2:70 1f7c*2:7e 1f80*8:8 1f90*8:8 1fa0*8:8 1fb0*2:8 1fb3:9 1fbe:-1c25 1fc3:9 1fd0*2:8 1fe0*2:8 1fe5:7 ' +
  '1ff3:9 214e:-1c 2170*16:-10 2184:-1 2c30*47:-30 2c61:-1 2c65:-2a2b 2c66:-2a28 2c68*3/2:-1 2c73:-1 2c76:-1 ' +
  '2c81*50/2:-1 2cec*2/2:-1 2cf3:-1 2d00*38:-1c60 2d27:-1c60 2d2d:-1c60 a641*23/2:-1 a681*14/2:-1 a723*7/2:-1 ' +
  'a733*31/2:-1 a77a*2/2:-1 a77f*5/2:-1 a78c:-1 a791*2/2:-1 a794:30 a797*10/2:-1 a7b5*6/2:-1 a7c3:-1 ab53:-3a0 ' +
  'ab70*80:-97d0 ff41*26:-20 10428*40:-28 104d8*36:-28 10cc0*51:-40 118c0*32:-20 16e60*32:-20 1e922*34:-22 ';

/** Non-ASCII blocks, each translated only when the text holds a character in it. */
const BLOCKS: ReadonlyArray<readonly [number, number]> = [[0x80, 0x250], [0x250, 0x530], [0x530, 0x2000], [0x2000, 0x10000], [0x10000, 0x110000]];

/** The case map a run string encodes, keyed by code point. */
export function decodeCaseRuns(runs: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const run of runs.trim().split(/ +/)) {
    const m = /^([0-9a-f]+)(?:\*(\d+)(\/2)?)?:(-?[0-9a-f]+)$/.exec(run);
    if (!m) throw new Error(`pg-fold: bad case run ${run}`);
    const start = parseInt(m[1]!, 16), count = Number(m[2] ?? 1), step = m[3] ? 2 : 1, delta = parseInt(m[4]!, 16);
    for (let i = 0; i < count; i++) map.set(start + i * step, start + i * step + delta);
  }
  return map;
}

export const PGLITE_LOWER_MAP: ReadonlyMap<number, number> = decodeCaseRuns(LOWER_RUNS);
export const PGLITE_UPPER_MAP: ReadonlyMap<number, number> = decodeCaseRuns(UPPER_RUNS);

const hex4 = (c: number) => c.toString(16).padStart(4, '0');
const regexChar = (c: number) => c > 0xffff ? `\\U${c.toString(16).padStart(8, '0')}` : `\\u${hex4(c)}`;

/** The per-block translate tables of a case map: the block's guard class and its from/to strings. */
function blockTables(map: ReadonlyMap<number, number>) {
  return BLOCKS.flatMap(([lo, hi]) => {
    const keys = [...map.keys()].filter(c => c >= lo && c < hi).sort((a, b) => a - b);
    if (!keys.length) return [];
    return [{ guard: `[${regexChar(lo)}-${regexChar(hi - 1)}]`, from: String.fromCodePoint(...keys), to: String.fromCodePoint(...keys.map(c => map.get(c)!)) }];
  });
}

function foldSql(x: string, base: 'lower' | 'upper', tables: ReturnType<typeof blockTables>): string {
  const pick = (part: 'from' | 'to') => tables.map(t => `CASE WHEN pg_catalog.textregexeq(${x}, '${t.guard}') THEN '${t[part]}' ELSE '' END`)
    .reduce((acc, next) => `pg_catalog.textcat(${acc}, ${next})`);
  const ascii = `pg_catalog.${base}((${x}) COLLATE "C")`;
  return `CASE WHEN pg_catalog.octet_length(${x}) = pg_catalog.char_length(${x}) THEN ${ascii} ELSE pg_catalog.translate(${ascii}, ${pick('from')}, ${pick('to')}) END`;
}

const LOWER_TABLES = blockTables(PGLITE_LOWER_MAP), UPPER_TABLES = blockTables(PGLITE_UPPER_MAP);

/**
 * SQL for PGLite's `lower(x)` on any server. `x` is repeated, so pass a column, a parameter or another cheap
 * expression. Built-ins are schema-qualified, so the fingerprint functions that inline it stay index-safe.
 */
export function pgliteLowerSql(x: string): string {
  return foldSql(x, 'lower', LOWER_TABLES);
}

/** SQL for PGLite's `upper(x)` on any server (U+00DF uppercases to U+1E9E); `x` is repeated, as in pgliteLowerSql. */
export function pgliteUpperSql(x: string): string {
  return foldSql(x, 'upper', UPPER_TABLES);
}
