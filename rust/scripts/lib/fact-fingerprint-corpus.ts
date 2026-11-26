/**
 * The claim corpus the fact-fingerprint differential runs: the Rust engine's `fact_fingerprint`,
 * `fact_fingerprint_v1` and `fact_normalize` (rust/crates/gbrain-store/src/trust/fingerprint.rs and
 * facts.rs) against the SQL functions `gbrain_fact_fingerprint`, `gbrain_fact_fingerprint_v1` and
 * `gbrain_fact_normalize` (src/core/facts/withdrawal-schema.ts).
 *
 * Withdrawals and purge tombstones key on these fingerprints, so one differing byte would let a
 * forgotten claim come back. The corpus therefore aims at what the SQL does per character
 * (`lower()`, the `[[:space:]]` class, the punctuation list) and at how the steps compose (runs of
 * mixed whitespace, the sentence-dot rule, `btrim`, empty and very long text):
 *
 *   - hand rows: every Unicode whitespace character and every character near the `[[:space:]]`
 *     class (NBSP, zero-width characters, the BOM), tab/CR/LF runs, Turkish I, German sharp s,
 *     Greek final sigma, ligatures, combining marks, NFC and NFD pairs, right-to-left text, CJK,
 *     emoji with ZWJ, case-fold edge cases, leading and trailing whitespace, empty and long text;
 *   - seeded rows: a fixed-seed generator that mixes those character pools with random code points.
 *
 * Text excludes U+0000 and lone surrogates: a Postgres `text` value cannot hold either, so no stored
 * claim has them. Long rows are written as `{ rep: [unit, count, suffix] }` (the text is `unit`
 * repeated `count` times, then `suffix`), so the committed fixture stays small; the Rust test expands
 * them the same way.
 *
 * rust/scripts/fact-fingerprint-fixture.ts runs this corpus through PGLite and writes the fixture
 * rust/crates/gbrain-store/tests/fixtures/fact_fingerprints.json.
 */

export interface CorpusRow {
  /** A stable, unique name: the test failure names it. */
  name: string;
  /** The claim text, or `rep` for a long one. */
  text?: string;
  rep?: [string, number, string];
}

/** The claim a row stands for. */
export function rowText(row: CorpusRow): string {
  if (row.rep) return row.rep[0].repeat(row.rep[1]) + row.rep[2];
  return row.text ?? '';
}

const hex = (cp: number) => cp.toString(16).toUpperCase().padStart(4, '0');
const ch = (cp: number) => String.fromCodePoint(cp);

/**
 * Whitespace and near-whitespace: the 21 characters PGLite's `[[:space:]]` holds (9-13, 32, U+0085,
 * U+2000-U+2006, U+2008-U+200A, U+2028, U+2029, U+205F, U+3000), U+1680 (which a glibc host also
 * counts), and characters a reader would take for whitespace that the class leaves out.
 */
export const WHITESPACE_CODE_POINTS: readonly number[] = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x205f, 0x3000,
  0x1680, 0xa0, 0x202f, 0x180e, 0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xad,
  0x1c, 0x1d, 0x1e, 0x1f, 0x7f, 0x01, 0x08, 0x0e,
];

/** `FINGERPRINT_PUNCTUATION` (withdrawal-schema.ts) plus punctuation it leaves alone. */
const PUNCTUATION = '!"$%&\'()*,-/:;<=>?@[\\]^_`{|}~\u2018\u2019\u201a\u201c\u201d\u201e\u00ab\u00bb\u2039\u203a\u2013\u2014\u2015\u2026\u00b7\u2022\u00a1\u00bf';
const OTHER_PUNCTUATION = '#+.\u00a7\u00b6\u2020\u2030\u2032\u2033\u203d\u3001\u3002\u300c\u300d\uff01\uff0c\uff1f\u061f\u060c\u2012\u2212\u00b4\u02bc';

function handRows(): CorpusRow[] {
  const rows: CorpusRow[] = [];
  const add = (name: string, text: string) => rows.push({ name, text });

  for (const cp of WHITESPACE_CODE_POINTS) {
    const w = ch(cp);
    add(`ws ${hex(cp)} alone`, w);
    add(`ws ${hex(cp)} between words`, `Alice${w}likes tea`);
    add(`ws ${hex(cp)} leading and trailing`, `${w}Alice likes tea${w}`);
    add(`ws ${hex(cp)} run with spaces`, `Alice ${w}${w} ${w}likes${w} \t tea`);
    add(`ws ${hex(cp)} after a sentence dot`, `Alice likes tea.${w}Bob too.${w}`);
    add(`ws ${hex(cp)} after space-trimmed edge`, ` ${w} Alice likes tea ${w} `);
  }
  add('ws every class char in one run', `a${WHITESPACE_CODE_POINTS.slice(0, 22).map(ch).join('')}b`);
  add('ws every near-space char in one run', `a${WHITESPACE_CODE_POINTS.slice(22).map(ch).join('')}b`);
  add('tabs CR LF runs', 'Alice\t\t\r\n\r\n  likes\n\n\ttea\r');
  add('CRLF only', '\r\n\r\n');
  add('leading CRLF', '\r\n\r\nAlice likes tea');
  add('trailing tabs and newlines', 'Alice likes tea\n\n\t');
  add('vertical tab and form feed', 'Alice\u000blikes\u000ctea');
  add('leading and trailing spaces', '   Alice likes tea   ');
  add('leading and trailing tabs', '\tAlice likes tea\t');
  add('leading and trailing NBSP', '\u00a0Alice likes tea\u00a0');
  add('space then NBSP edges', ' \u00a0Alice likes tea\u00a0 ');
  add('ideographic space edges', '\u3000Alice likes tea\u3000');
  add('only spaces', '     ');
  add('only tabs', '\t\t');
  add('only mixed whitespace', ' \t\n\u3000\u2003 ');
  add('only NBSP', '\u00a0\u00a0');
  add('empty', '');

  // Case mapping: Turkish, German, Greek, ligatures, title-case digraphs and other edge cases.
  add('turkish dotted capital I', '\u0130STANBUL');
  add('turkish plain capital I', 'ISTANBUL');
  add('turkish dotless small i', '\u0131stanbul');
  add('turkish small i', 'istanbul');
  add('turkish all four', '\u0130i I\u0131 \u0130\u0131');
  add('turkish city', 'D\u0130YARBAKIR is in T\u00fcrkiye');
  add('german capital sharp s', 'STRA\u1e9eE');
  add('german sharp s', 'Stra\u00dfe');
  add('german SS', 'STRASSE');
  add('german sharp s pair', '\u00df \u1e9e \u00df\u1e9e');
  add('greek capital word with final sigma', '\u039f\u0394\u03a5\u03a3\u03a3\u0395\u03a5\u03a3');
  add('greek lower word', '\u039f\u03b4\u03c5\u03c3\u03c3\u03b5\u03cd\u03c2');
  add('greek sigma forms', '\u03c3 \u03c2 \u03a3 \u03a3\u0391\u03a3');
  add('greek tonos capitals', '\u1f48\u0394\u03a5\u03a3\u03a3\u0395\u038e\u03a3');
  add('greek iota subscript capital', '\u1fbc \u1f88 \u1ffc');
  add('greek final sigma before punctuation', '\u039f\u0394\u03a5\u03a3\u03a3\u0395\u03a5\u03a3. \u03a3!');
  add('latin ligatures', '\ufb01 \ufb02 \ufb00 \ufb03 \ufb04 \ufb05 \ufb06');
  add('ligature words', 'O\ufb03ce \ufb02ow \u00c6sir \u00e6sir \u0152uvre \u0153uvre \u0132 \u0133');
  add('title-case digraphs', '\u01c4 \u01c5 \u01c6 \u01c7 \u01c8 \u01c9 \u01ca \u01cb \u01cc \u01f1 \u01f2 \u01f3');
  add('kelvin angstrom ohm signs', '\u212a \u212b \u2126 K \u00c5 \u03a9');
  add('roman numerals', '\u216b \u2160\u2161\u2162 \u217b');
  add('circled letters', '\u24b6\u24b7\u24b8 \u24d0\u24d1\u24d2');
  add('fullwidth latin', '\uff21\uff22\uff23 \uff41\uff42\uff43 \uff11\uff12\uff13');
  add('cherokee', '\u13a0\u13a1\u13a2 \uab70\uab71');
  add('georgian mtavruli', '\u1c90\u1c91\u1c92 \u10d0\u10d1');
  add('glagolitic', '\u2c00\u2c01 \u2c2f \u2c30');
  add('latin extended-d', '\ua7c0 \ua7c7 \ua7c9 \ua7d0 \ua7d6 \ua7d8 \ua7f5');
  add('deseret osage adlam', '\u{10400}\u{10401} \u{104b0} \u{1e900}\u{1e901}');
  add('vithkuqi', '\u{10570}\u{10571} \u{10597}');
  add('n preceded by apostrophe', '\u0149 \u02bcN');
  add('capital eszett mixed sentence', 'GRO\u1e9eE STRA\u1e9eE. gro\u00dfe stra\u00dfe.');
  add('ascii mixed case', 'aLiCe LiKeS TeA');

  // Combining marks and normalization forms: the SQL compares code points, never normal forms.
  add('nfc cafe', 'Caf\u00e9');
  add('nfd cafe', 'Cafe\u0301');
  add('nfc A ring', '\u00c5ngstr\u00f6m');
  add('nfd A ring', 'A\u030angstro\u0308m');
  add('angstrom sign word', '\u212bngstr\u00f6m');
  add('nfc hangul', '\ud55c\uad6d\uc5b4');
  add('nfd hangul jamo', '\u1112\u1161\u11ab\u1100\u116e\u11a8\u110b\u1165');
  add('combining mark first', '\u0301leading combining mark');
  add('stacked combining marks', 'a\u0300\u0301\u0302\u0303\u0304 E\u0301\u0302');
  add('combining mark after space', 'Alice \u0301likes tea');
  add('combining mark after punctuation', 'Alice!\u0301 likes tea.\u0301');
  add('combining mark after dot at end', 'tea.\u0308');
  add('zalgo', 'Z\u0351\u036b\u0343\u036a\u0302\u036b\u033d\u034f\u0334\u0319\u0324\u031e\u0349\u035a\u032f\u031e\u0320\u034dA\u036b\u0357\u0334\u0362\u0335\u031c\u0330\u0354L\u0368\u0367\u0369\u0358\u0320G\u0311\u0357\u030e\u0305\u035b\u0341\u0334\u033b\u0348\u034d\u0354\u0339O');

  // Right-to-left text and bidi controls.
  add('hebrew', '\u05e9\u05dc\u05d5\u05dd \u05e2\u05d5\u05dc\u05dd');
  add('arabic with tatweel', '\u0645\u0631\u062d\u0640\u0640\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645\u061f');
  add('mixed ltr rtl digits', 'abc \u05e9\u05dc\u05d5\u05dd 123 \u0645\u0631\u062d\u0628\u0627.');
  add('bidi marks', '\u200eAlice\u200f likes \u202etea\u202c \u2066x\u2069');
  add('arabic presentation forms', '\ufefb \ufdfa \ufe8d');

  // CJK and fullwidth punctuation.
  add('cjk', '\u4e2d\u6587 \u65e5\u672c\u8a9e \ud55c\uad6d\uc5b4');
  add('cjk with ideographic punctuation', '\u4e2d\u6587\u3001\u65e5\u672c\u8a9e\u3002 \u300c\u5f15\u7528\u300d\uff01\uff1f');
  add('cjk ideographic space run', '\u4e2d\u6587\u3000\u3000\u65e5\u672c\u8a9e');
  add('halfwidth katakana', '\uff76\uff80\uff76\uff85');
  add('cjk extension b', '\u{20000}\u{2a6d6}');

  // Emoji: ZWJ sequences, skin tones, flags, keycaps, variation selectors.
  add('emoji zwj family', 'family \u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466} trip');
  add('emoji rainbow flag', '\u{1f3f3}\ufe0f\u200d\u{1f308}');
  add('emoji skin tone', 'thumbs \u{1f44d}\u{1f3fd} up');
  add('emoji flag', 'From \u{1f1fa}\u{1f1f8}.');
  add('emoji keycap', '1\ufe0f\u20e3 first');
  add('emoji zwj with spaces around joiner', 'a \u200d b');
  add('variation selectors', 'x\ufe0e y\ufe0f \u{e0100}');

  // The sentence-dot rule: a dot folds only before a space, another dot or the end.
  add('dot rules', 'a. b a.. ... . . a .b 3.5. e.g. this U.S.A.');
  add('dots only', '...');
  add('single dot', '.');
  add('dot then ideographic space', 'end.\u3000next');
  add('dot then NEL', 'end.\u0085next');
  add('dot then ogham space', 'end.\u1680next');
  add('dot then NBSP', 'end.\u00a0next');
  add('dot then tab', 'end.\tnext');
  add('dot then punctuation', 'end.! next.? a.- b');
  add('dot then combining', 'end.\u0301 next');
  add('versions and names', 'Ships .NET 8, Node.js 22 and v3.5.1. Done.');
  add('C++ and C#', 'Uses C++ and C#, not C. Prefers F# over F.');

  // Punctuation: every listed character between words, and characters the list leaves out.
  for (const p of PUNCTUATION) add(`punct ${hex(p.codePointAt(0)!)}`, `Alice${p}likes${p}${p} tea${p}`);
  add('punct listed run', `${PUNCTUATION}`);
  add('punct listed run between words', `Alice ${PUNCTUATION} tea`);
  for (const p of OTHER_PUNCTUATION) add(`unlisted punct ${hex(p.codePointAt(0)!)}`, `Alice${p}likes ${p}tea${p}`);
  add('only punctuation', '!!!');
  add('punctuation and whitespace only', ' !? \u2014 \u3000 ... ');

  // Control characters, noncharacters and the edges of the code space.
  add('C0 controls', 'a\u0001b\u0007c\u001bd');
  add('C1 controls', 'a\u0080b\u009fc');
  add('noncharacters', 'a\ufffe b\uffff c\u{10ffff} \u{1fffe}');
  add('private use', '\ue000\uf8ff \u{f0000}');
  add('replacement character', '\ufffd broken');
  add('highest code point', '\u{10ffff}');

  // Long text.
  rows.push({ name: 'long ascii words', rep: ['Alice likes tea. ', 4000, 'END'] });
  rows.push({ name: 'long mixed whitespace', rep: [' \t\r\n\u3000\u2003\u0085', 5000, 'x'] });
  rows.push({ name: 'long sharp s', rep: ['\u1e9e', 20000, ''] });
  rows.push({ name: 'long turkish', rep: ['\u0130\u0131 ', 10000, '.'] });
  rows.push({ name: 'long dots', rep: ['.', 30000, ''] });
  rows.push({ name: 'long emoji zwj', rep: ['\u{1f468}\u200d\u{1f469} ', 5000, ''] });
  rows.push({ name: 'long nbsp', rep: ['\u00a0', 30000, ''] });
  rows.push({ name: 'long spaces around word', rep: [' ', 50000, 'x' + ' '.repeat(10)] });
  return rows;
}

/** mulberry32: a tiny deterministic PRNG, so the seeded rows are the same on every machine. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The seed and size of the generated part. Changing either changes the fixture (`--write`). */
export const SEEDED_ROWS = { seed: 0x5eed_f1a6, count: 600 } as const;

const POOLS: ReadonlyArray<{ weight: number; chars: readonly string[] }> = [
  { weight: 18, chars: [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'] },
  { weight: 14, chars: WHITESPACE_CODE_POINTS.map(ch) },
  { weight: 8, chars: [...PUNCTUATION, ...OTHER_PUNCTUATION, '.', '.', '.'] },
  { weight: 8, chars: [...'\u0130\u0131Ii\u00df\u1e9e\u03a3\u03c3\u03c2\u039f\u0394\u1fbc\u01c4\u01c5\u01c6\ufb01\ufb03\u0149\u212a\u212b\u2126\u216b\u24b6\u24d0\uff21\uff41\u13a0\uab70\u1c90\u10d0\u2c00\u2c2f\ua7c0\ua7f5\u00c5\u00c9\u00e9\u00d8\u0152'] },
  { weight: 4, chars: ['\u{10400}', '\u{104b0}', '\u{1e900}', '\u{10570}', '\u{10597}', '\u{16ea0}', '\u{1df40}'] },
  { weight: 6, chars: [...'\u0300\u0301\u0302\u0303\u0308\u030a\u0327\u0345\u034f\u0361\u20dd\u20e3'] },
  { weight: 5, chars: [...'\u4e2d\u6587\u65e5\u672c\u8a9e\ud55c\uad6d\uc5b4\u3001\u3002\u300c\u300d\u1112\u1161\u11ab'] },
  { weight: 5, chars: [...'\u05e9\u05dc\u05d5\u05dd\u0645\u0631\u062d\u0628\u0627\u0640\u061f\u200e\u200f\u202e\u202c'] },
  { weight: 5, chars: ['\u{1f468}', '\u{1f469}', '\u{1f467}', '\u200d', '\ufe0f', '\u{1f3fd}', '\u{1f1fa}', '\u{1f1f8}', '\u20e3', '\u{1f308}'] },
];
const POOL_TOTAL = POOLS.reduce((sum, p) => sum + p.weight, 0);

/** A random scalar value from any plane, never U+0000 and never a surrogate. */
function randomCodePoint(next: () => number): string {
  const planes = [0x80, 0x800, 0x10000, 0x110000];
  const top = planes[Math.floor(next() * planes.length)]!;
  for (;;) {
    const cp = 1 + Math.floor(next() * (top - 1));
    if (cp < 0xd800 || cp > 0xdfff) return ch(cp);
  }
}

function seededRows(): CorpusRow[] {
  const next = mulberry32(SEEDED_ROWS.seed);
  const pick = (): string => {
    if (next() < 0.08) return randomCodePoint(next);
    let r = next() * POOL_TOTAL;
    for (const pool of POOLS) {
      r -= pool.weight;
      if (r < 0) return pool.chars[Math.floor(next() * pool.chars.length)]!;
    }
    return 'x';
  };
  const rows: CorpusRow[] = [];
  for (let i = 0; i < SEEDED_ROWS.count; i++) {
    // Mostly short claims, some long ones, a few empty.
    const length = next() < 0.05 ? 0 : next() < 0.9 ? 1 + Math.floor(next() * 40) : 40 + Math.floor(next() * 160);
    let text = '';
    for (let j = 0; j < length; j++) text += pick();
    rows.push({ name: `seeded ${String(i).padStart(4, '0')}`, text });
  }
  return rows;
}

/** The whole corpus, hand rows first. Names are unique. */
export function fingerprintCorpus(): CorpusRow[] {
  const rows = [...handRows(), ...seededRows()];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.name)) throw new Error(`duplicate corpus row name: ${row.name}`);
    seen.add(row.name);
    const text = rowText(row);
    if (text.includes('\u0000')) throw new Error(`corpus row ${row.name} holds U+0000`);
    if (/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)) {
      throw new Error(`corpus row ${row.name} holds a lone surrogate`);
    }
  }
  return rows;
}

/** What the SQL functions answer for one claim. `normalize` is `gbrain_fact_normalize`. */
export interface FingerprintAnswer {
  normalize: string;
  fingerprint: string;
  fingerprint_v1: string;
}

/** The minimal engine surface the SQL arms need: `executeRaw` (PGLite and Postgres engines both have it). */
export interface SqlArm {
  executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

/**
 * Runs `texts` through the database's own `gbrain_fact_normalize`, `gbrain_fact_fingerprint` and
 * `gbrain_fact_fingerprint_v1`. The normalized text comes back as UTF-8 hex and is decoded here,
 * because a client text decoder may drop a leading U+FEFF. The texts travel as one JSON array
 * bound as text and cast to jsonb (never a JSON string bound straight into `::jsonb`).
 */
export async function sqlFingerprints(arm: SqlArm, texts: readonly string[]): Promise<FingerprintAnswer[]> {
  const out: FingerprintAnswer[] = [];
  const batch = 200;
  for (let start = 0; start < texts.length; start += batch) {
    const slice = texts.slice(start, start + batch);
    const rows = await arm.executeRaw<{ ord: number | string; n: string; fp: string; v1: string }>(
      `SELECT u.ord, encode(convert_to(gbrain_fact_normalize(u.t), 'UTF8'), 'hex') AS n,
              gbrain_fact_fingerprint(u.t) AS fp, gbrain_fact_fingerprint_v1(u.t) AS v1
         FROM jsonb_array_elements_text($1::text::jsonb) WITH ORDINALITY AS u(t, ord)
        ORDER BY u.ord`,
      [JSON.stringify(slice)],
    );
    if (rows.length !== slice.length) throw new Error(`expected ${slice.length} fingerprint rows, got ${rows.length}`);
    for (const r of rows) {
      out.push({ normalize: Buffer.from(r.n, 'hex').toString('utf8'), fingerprint: r.fp, fingerprint_v1: r.v1 });
    }
  }
  return out;
}

/** The database's per-character tables over every scalar value but U+0000. */
export interface CharTables {
  /** `[cp, lower(chr(cp))]` for every code point `lower()` changes to exactly one code point. */
  lower: Array<[number, number]>;
  /** Every code point `chr(cp) ~ '[[:space:]]'` matches. */
  space: number[];
  /**
   * Only for a scan limited to some code points (`only`, the Postgres host): the ones this host's `lower()` cannot be
   * written down per character, because it returns several code points (an ICU database lowers U+0130 to two) or reads
   * the neighbours (ICU lowers a Greek capital sigma at the end of a word differently). They are left out of `lower`.
   */
  unmodelled: number[];
}

/**
 * Reads `lower()` and the `[[:space:]]` class for every code point (1,112,063 of them) from the
 * database. Rows come back as integers, so no client text decoding is involved. `only` limits the
 * scan to the given code points (the Postgres arm checks just the corpus's characters).
 */
export async function sqlCharTables(arm: SqlArm, only?: readonly number[]): Promise<CharTables> {
  const source = only
    ? `jsonb_array_elements_text($1::text::jsonb) AS g(v) CROSS JOIN LATERAL (SELECT g.v::int AS cp) c`
    : `generate_series(1, 1114111) AS c(cp)`;
  const params = only ? [JSON.stringify(only.map(String))] : [];
  const lower = await arm.executeRaw<{ cp: number | string; l: number | string; n: number | string }>(
    `SELECT cp, ascii(lower(chr(cp))) AS l, length(lower(chr(cp))) AS n FROM ${source}
      WHERE (cp < 55296 OR cp > 57343) AND lower(chr(cp)) <> chr(cp) ORDER BY cp`, params);
  const multi = lower.filter((r) => Number(r.n) !== 1);
  // Greek capital alpha then capital sigma: a per-character `lower()` gives alpha, small sigma; a contextual one ends in the final sigma.
  const [{ ok: perCharacter }] = (await arm.executeRaw<{ ok: boolean }>(
    `SELECT lower(chr(913) || chr(931)) = chr(945) || chr(963) AS ok`)) as [{ ok: boolean }];
  const unmodelled = new Set<number>(multi.map((r) => Number(r.cp)));
  if (!perCharacter && (!only || only.includes(931))) unmodelled.add(931);
  // PGLite (the whole scan) is the reference: a per-character `lower()` is what its fixture is built on.
  if (!only && unmodelled.size > 0) throw new Error(`lower() is not a per-character mapping for ${[...unmodelled].join(', ')}`);
  const space = await arm.executeRaw<{ cp: number | string }>(
    `SELECT cp FROM ${source} WHERE (cp < 55296 OR cp > 57343) AND chr(cp) ~ '[[:space:]]' ORDER BY cp`, params);
  return {
    lower: lower.filter((r) => !unmodelled.has(Number(r.cp))).map((r) => [Number(r.cp), Number(r.l)]),
    space: space.map((r) => Number(r.cp)),
    unmodelled: [...unmodelled].sort((a, b) => a - b),
  };
}

/** One fixture row: the corpus row and what PGLite answered. */
export interface FixtureRow extends CorpusRow, FingerprintAnswer {}

export interface FingerprintFixture {
  /** `version()` of the PGLite that produced the answers. */
  pglite: string;
  seed: number;
  seeded_count: number;
  lower: Array<[number, number]>;
  space: number[];
  rows: FixtureRow[];
}

/** Runs the whole corpus and the per-character tables through one SQL arm (PGLite for the fixture). */
export async function buildFingerprintFixture(arm: SqlArm): Promise<FingerprintFixture> {
  const corpus = fingerprintCorpus();
  const answers = await sqlFingerprints(arm, corpus.map(rowText));
  const [{ v }] = (await arm.executeRaw<{ v: string }>('SELECT version() AS v')) as [{ v: string }];
  const { lower, space } = await sqlCharTables(arm);
  return {
    pglite: v,
    seed: SEEDED_ROWS.seed,
    seeded_count: SEEDED_ROWS.count,
    lower,
    space,
    rows: corpus.map((row, i) => ({ ...row, ...answers[i]! })),
  };
}

/**
 * The committed form: JSON with one table entry or row per line, so a change reviews as a small
 * diff. Seeded and long rows store no `normalize` (their fingerprint is its digest); the other hand
 * rows keep it so a failure shows the text the SQL produced.
 */
export function renderFingerprintFixture(f: FingerprintFixture): string {
  // Pure ASCII: every character outside printable ASCII is written as a \\u escape (a pair for
  // astral characters), so invisible and right-to-left characters stay visible in review.
  const line = (v: unknown) =>
    JSON.stringify(v).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  const row = (r: FixtureRow) => {
    const { name, text, rep, normalize, fingerprint, fingerprint_v1 } = r;
    const keepNormalize = !rep && !name.startsWith('seeded ');
    return line({ name, ...(rep ? { rep } : { text }), ...(keepNormalize ? { normalize } : {}), fingerprint, fingerprint_v1 });
  };
  return [
    '{',
    `"pglite": ${line(f.pglite)},`,
    `"seed": ${f.seed},`,
    `"seeded_count": ${f.seeded_count},`,
    '"lower": [',
    f.lower.map((p) => line(p)).join(',\n'),
    '],',
    `"space": ${line(f.space)},`,
    '"rows": [',
    f.rows.map(row).join(',\n'),
    ']',
    '}',
    '',
  ].join('\n');
}
