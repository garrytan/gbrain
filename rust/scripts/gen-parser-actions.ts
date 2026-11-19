#!/usr/bin/env bun
/**
 * Regenerates rust/crates/gbrain-store/src/keyword/parser/actions.rs from PostgreSQL's own source: the
 * `TParserState` enum and the `actionTPS_*` state tables of src/backend/tsearch/wparser_def.c at
 * the PostgreSQL 18.6 release tag. One Rust item comes out per C row, in the same order. The Rust
 * parser engine (parser.rs) runs these tables the way the C parser does.
 *
 *   bun rust/scripts/gen-parser-actions.ts           # check: exit 1 if the committed file differs
 *   bun rust/scripts/gen-parser-actions.ts --write   # rewrite the file
 *
 * Needs the network once, to fetch wparser_def.c from raw.githubusercontent.com (it is checked against a
 * pinned SHA-256, so a moved tag fails loudly). Set GBRAIN_WPARSER_DEF_C to a local copy to skip the fetch.
 * The output is laid out the way rustfmt lays it out; `cargo fmt --check` accepts it.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PG_TAG = 'REL_18_6';
const SOURCE_URL = `https://raw.githubusercontent.com/postgres/postgres/${PG_TAG}/src/backend/tsearch/wparser_def.c`;
const SOURCE_SHA256 = 'ee458e41da57621472c0d8e268b6010fb696d64ac45f7707d98ee9479bb84f47';
const target = resolve(dirname(fileURLToPath(import.meta.url)), '../crates/gbrain-store/src/keyword/parser/actions.rs');
const write = process.argv.includes('--write');

async function loadSource(): Promise<string> {
  const local = process.env.GBRAIN_WPARSER_DEF_C;
  let bytes: Buffer | undefined;
  if (local) bytes = readFileSync(local);
  else {
    for (let attempt = 1; attempt <= 3 && !bytes; attempt++) {
      try {
        const res = await fetch(SOURCE_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        bytes = Buffer.from(await res.arrayBuffer());
      } catch (e) {
        if (attempt === 3) throw new Error(`could not fetch ${SOURCE_URL}: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
  }
  const sha = createHash('sha256').update(bytes!).digest('hex');
  if (sha !== SOURCE_SHA256) throw new Error(`wparser_def.c (${PG_TAG}) has SHA-256 ${sha}, expected ${SOURCE_SHA256}`);
  return bytes!.toString('utf8');
}

const c = await loadSource();

// States, in enum order: `TPS_InNumWord` becomes `State::InNumWord`.
const enumBody = c.match(/typedef enum\s*\{\s*TPS_Base = 0,([\s\S]*?)\}\s*TParserState;/)![1];
const states = ['Base', ...[...enumBody.matchAll(/TPS_(\w+)/g)].map((m) => m[1])];

// Token types: the numeric macros and the alias table give each Rust variant its name (`hword_numpart` is `HwordNumpart`).
const tokenIds = new Map<string, number>();
for (const m of c.matchAll(/^#define\s+(\w+)\s+(\d+)\s*$/gm)) if (m[1] !== 'LASTNUM') tokenIds.set(m[1], Number(m[2]));
const aliasBody = c.match(/tok_alias\[\]\s*=\s*\{([\s\S]*?)\};/)![1];
const aliases = [...aliasBody.matchAll(/"(\w*)"/g)].map((m) => m[1]);
const variant = (id: number) => aliases[id].split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join('');

const CLASSES: Record<string, string> = {
  p_isEOF: 'Eof', p_iseqC: 'Eq', p_isasclet: 'Asclet', p_isalpha: 'Alpha', p_isdigit: 'Digit', p_isalnum: 'Alnum',
  p_isnotalnum: 'NotAlnum', p_isspecial: 'Special', p_isspace: 'Space', p_isxdigit: 'Xdigit', p_isignore: 'Ignore',
  p_isstophost: 'StopHost', p_ishost: 'Host', p_isURLPath: 'UrlPath', p_isurlchar: 'UrlChar', NULL: 'Always',
};
const SPECIALS: Record<string, string> = {
  NULL: 'None', SpecialTags: 'Tags', SpecialFURL: 'Furl', SpecialHyphen: 'Hyphen', SpecialVerVersion: 'VerVersion',
};

/** One C row `{isclass, c, flags, tostate, type, special}` as the argument list of the Rust `item(...)` call. */
function rowArgs(row: string): string {
  const m = row.match(/^(\w+),\s*('(?:\\.|[^'\\])'|\d+),\s*([\w| ]+?),\s*TPS_(\w+),\s*(\w+),\s*(\w+)$/);
  if (!m) throw new Error(`cannot read the C row {${row}}`);
  const [, isclass, ch, flags, tostate, type, special] = m;
  if (!(isclass in CLASSES)) throw new Error(`unknown class ${isclass}`);
  if (!(special in SPECIALS)) throw new Error(`unknown special ${special}`);
  const cArg = ch.startsWith("'") ? `b${ch}` : ch;
  if ((isclass === 'p_iseqC') !== ch.startsWith("'") && !(isclass !== 'p_iseqC' && ch === '0')) throw new Error(`odd char in {${row}}`);
  let ty = 'None';
  if (type !== '0') {
    const id = tokenIds.get(type);
    if (id === undefined) throw new Error(`unknown token macro ${type}`);
    ty = `Some(TokenType::${variant(id)})`;
  }
  return [`Class::${CLASSES[isclass]}`, cArg, flags.trim().replace(/\s+/g, ' '), `State::${tostate}`, ty, `Special::${SPECIALS[special]}`].join(', ');
}

// The tables. The C file defines them in a slightly different order than the enum lists the states; the C parser
// finds them by state (see the CppConcat table at the end of the file), so they are emitted here in enum order.
const defined = new Map<string, string[]>();
for (const m of c.matchAll(/static const TParserStateActionItem actionTPS_(\w+)\[\]\s*=\s*\{([\s\S]*?)\n\};/g)) {
  defined.set(m[1], [...m[2].matchAll(/^\s*\{(.*)\},?\s*$/gm)].map((r) => rowArgs(r[1].trim())));
}
const tables = states.filter((s) => s !== 'Null').map((state) => {
  const args = defined.get(state);
  if (!args) throw new Error(`no actionTPS_${state} table in wparser_def.c`);
  return { state, args };
});
if (tables.length !== defined.size) throw new Error('wparser_def.c has an action table that no TParserState names');

// rustfmt layout: a call whose arguments fit in 60 columns (and the line in 100) stays on one line.
function item(args: string, indent: number, suffix: string): string {
  const pad = ' '.repeat(indent);
  if (args.length <= 60 && indent + 'item('.length + args.length + 1 + suffix.length <= 100) return `${pad}item(${args})${suffix}\n`;
  return `${pad}item(\n${args.split(', ').map((a) => `${pad}    ${a},\n`).join('')}${pad})${suffix}\n`;
}

const FIXED = `/// The \`p_is*\` tests of the C parser. \`Always\` is the table terminator (a NULL \`isclass\`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Class {
    Eof,
    Eq,
    Asclet,
    Alpha,
    Digit,
    Alnum,
    NotAlnum,
    Special,
    Space,
    Xdigit,
    Ignore,
    StopHost,
    Host,
    UrlPath,
    UrlChar,
    Always,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Special {
    None,
    Tags,
    Furl,
    Hyphen,
    VerVersion,
}

pub(super) const A_NEXT: u16 = 0x0000;
pub(super) const A_BINGO: u16 = 0x0001;
pub(super) const A_POP: u16 = 0x0002;
pub(super) const A_PUSH: u16 = 0x0004;
pub(super) const A_RERUN: u16 = 0x0008;
pub(super) const A_CLEAR: u16 = 0x0010;
pub(super) const A_MERGE: u16 = 0x0020;
pub(super) const A_CLRALL: u16 = 0x0040;

#[derive(Debug, Clone, Copy)]
pub(super) struct Item {
    pub(super) class: Class,
    pub(super) c: u8,
    pub(super) flags: u16,
    pub(super) tostate: State,
    pub(super) ty: Option<TokenType>,
    pub(super) special: Special,
}

const fn item(
    class: Class,
    c: u8,
    flags: u16,
    tostate: State,
    ty: Option<TokenType>,
    special: Special,
) -> Item {
    Item {
        class,
        c,
        flags,
        tostate,
        ty,
        special,
    }
}

`;

let out = `//! Generated from the PostgreSQL 18.6 \`wparser_def.c\` \`actionTPS_*\` tables (one item per C row,
//! same order) by \`bun rust/scripts/gen-parser-actions.ts --write\`. Do not edit by hand; see \`parser.rs\`
//! for the engine that runs them.
//! Derived from PostgreSQL 18.6; licence and notice: third-party/postgresql/NOTICE.md

use super::TokenType;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum State {
${states.map((s) => `    ${s},\n`).join('')}}

${FIXED}`;

for (const { state, args } of tables) {
  const name = `ACT_${state.toUpperCase()}`;
  if (args.length === 1) {
    const oneLine = `const ${name}: &[Item] = &[item(${args[0]})];`;
    if (args[0].length <= 60 && oneLine.length <= 100) out += oneLine + '\n\n';
    else out += `const ${name}: &[Item] = &[item(\n${args[0].split(', ').map((a) => `    ${a},\n`).join('')})];\n\n`;
  } else {
    out += `const ${name}: &[Item] = &[\n${args.map((a) => item(a, 4, ',')).join('')}];\n\n`;
  }
}
out += `pub(super) fn actions(state: State) -> &'static [Item] {\n    match state {\n`;
for (const s of states) out += s === 'Null' ? `        State::Null => &[],\n` : `        State::${s} => ACT_${s.toUpperCase()},\n`;
out += `    }\n}\n`;

if (write) {
  writeFileSync(target, out);
  console.log(`wrote ${target}`);
} else if (readFileSync(target, 'utf8') === out) {
  console.log('gen-parser-actions: actions.rs same');
} else {
  console.error('gen-parser-actions: actions.rs differs from the PostgreSQL 18.6 tables; run with --write and review the diff');
  process.exit(1);
}
