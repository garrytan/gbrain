#!/usr/bin/env bun
/**
 * Regenerates rust/crates/gbrain-store/src/takes/zone_transitions.rs: every zone of the tzdata PGLite
 * ships (`share/postgresql/timezone/<name>`, TZif version 2 or later, 64-bit data) with its local time
 * types and transitions, the names that load each one (a link loads the same data as its target), and
 * the 50 date-dependent abbreviations of PostgreSQL's `timezone_abbreviations = 'Default'` set (`MSK`,
 * `SGT`, ...; the entries `share/timezonesets/Default` defines by a zone name, not a number of
 * seconds). `takes/zone_offset.rs` reads them as PostgreSQL's `DetermineTimeZoneOffset` and
 * `DetermineTimeZoneAbbrevOffset` do.
 *
 *   bun rust/scripts/gen-zone-transitions.ts           # check: exit 1 if the committed file differs
 *   bun rust/scripts/gen-zone-transitions.ts --write   # rewrite the file
 *
 * Uses the repository's own `@electric-sql/pglite` (the PGLite engine's tzdata); no network.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const target = resolve(dirname(fileURLToPath(import.meta.url)), '../crates/gbrain-store/src/takes/zone_transitions.rs');
const write = process.argv.includes('--write');

const db = new PGlite();
const version = (await db.query<{ v: string }>('select version() as v')).rows[0].v.split(' on ')[0];
const pgliteVersion = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/@electric-sql/pglite/package.json'), 'utf8')).version as string;
// biome-ignore lint/suspicious/noExplicitAny: the Emscripten module has no published type.
const FS = (db as any).mod.FS;
const share = '/pglite/share/postgresql';
const read = (path: string): Buffer => Buffer.from(FS.readFile(`${share}/${path}`));

// `ABBR ZONE` lines of the Default set (an offset in seconds is a fixed entry, zone_abbreviations.rs).
const dynamic = new Map<string, string>();
for (const raw of read('timezonesets/Default').toString('utf8').split('\n')) {
  const line = raw.replace(/#.*/, '').trim();
  if (!line) continue;
  if (line.startsWith('@')) throw new Error(`unexpected directive in Default: ${line}`);
  const [abbr, value] = line.split(/\s+/);
  if (!/^-?\d+$/.test(value)) dynamic.set(abbr.toLowerCase(), value);
}
if (dynamic.size !== 50) throw new Error(`expected 50 date-dependent abbreviations, got ${dynamic.size}`);

interface Zone {
  name: string;
  types: { utoff: number; isdst: boolean; abbr: string }[];
  at: bigint[];
  kind: number[];
  openEnded: boolean;
}

/** A TZif file's version 2+ (64-bit) data block and footer. */
function tzif(name: string, dynamicZone: boolean): Zone {
  const b = read(`timezone/${name}`);
  if (b.toString('latin1', 0, 4) !== 'TZif' || b[4] < 0x32) throw new Error(`${name}: not TZif version 2+`);
  const counts = (o: number) => [0, 1, 2, 3, 4, 5].map((i) => b.readInt32BE(o + 20 + 4 * i));
  let [isut, isstd, leap, timecnt, typecnt, charcnt] = counts(0);
  let o = 44 + timecnt * 5 + typecnt * 6 + charcnt + leap * 8 + isstd + isut;
  [isut, isstd, leap, timecnt, typecnt, charcnt] = counts(o);
  if (leap !== 0) throw new Error(`${name}: leap seconds`);
  o += 44;
  const at: bigint[] = [];
  for (let i = 0; i < timecnt; i++) at.push(b.readBigInt64BE(o + 8 * i));
  o += 8 * timecnt;
  const kind = [...b.subarray(o, o + timecnt)];
  o += timecnt;
  const raw = [];
  for (let i = 0; i < typecnt; i++) raw.push({ utoff: b.readInt32BE(o + 6 * i), isdst: b[o + 6 * i + 4] === 1, idx: b[o + 6 * i + 5] });
  o += 6 * typecnt;
  const chars = b.subarray(o, o + charcnt);
  o += charcnt + isstd + isut;
  const footer = b.toString('latin1', o).trim();
  const types = raw.map((t) => ({ utoff: t.utoff, isdst: t.isdst, abbr: chars.toString('latin1', t.idx, chars.indexOf(0, t.idx)) }));
  // A footer with a rule (a comma) keeps adding transitions after the file's last one; PostgreSQL
  // appends them on load. The reader refuses an instant past the file's last transition in such a zone.
  const openEnded = footer.includes(',');
  // Abbreviations of the footer must already be types, or the appended types could carry an
  // abbreviation the reader does not know.
  for (const abbr of dynamicZone ? (footer.match(/<[^>]+>|[A-Za-z]{3,}/g) ?? []) : []) {
    const plain = abbr.replace(/[<>]/g, '');
    if (!types.some((t) => t.abbr === plain)) throw new Error(`${name}: footer abbreviation ${plain} is not a type`);
  }
  for (let i = 1; i < at.length; i++) if (at[i] <= at[i - 1]) throw new Error(`${name}: transitions out of order`);
  return { name, types, at, kind, openEnded };
}

const root = `${share}/timezone`;
const files = (dir: string): string[] =>
  (FS.readdir(dir) as string[]).filter((n) => n !== '.' && n !== '..').flatMap((n) => {
    const path = `${dir}/${n}`;
    return FS.isDir(FS.stat(path).mode) ? files(path) : [path.slice(root.length + 1)];
  });
const dynamicZones = new Set(dynamic.values());
// One entry per distinct zone; every name whose file holds the same rules points at it.
const zones: Zone[] = [];
const byRules = new Map<string, number>();
const names = new Map<string, number>();
for (const name of files(root).sort()) {
  const zone = tzif(name, dynamicZones.has(name));
  const key = JSON.stringify([zone.types, zone.at.map(String), zone.kind, zone.openEnded]);
  let index = byRules.get(key);
  if (index === undefined) {
    index = zones.length;
    zones.push(zone);
    byRules.set(key, index);
  }
  const lower = name.toLowerCase();
  if (names.has(lower)) throw new Error(`two zone files named ${lower} ignoring case`);
  names.set(lower, index);
}
for (const zone of dynamicZones) if (!names.has(zone.toLowerCase())) throw new Error(`no zone ${zone}`);
const sortedNames = [...names.keys()].sort();

const lines: string[] = [];
lines.push(
  '//! GENERATED by `rust/scripts/gen-zone-transitions.ts`; do not edit. The zone names, the 50',
  "//! date-dependent abbreviations of PostgreSQL's `timezone_abbreviations = 'Default'` set, and the local time types and",
  `//! transitions of every zone, from the tzdata of PGLite ${pgliteVersion} (${version}).`,
  '',
  '/// A zone of the tz database, as PostgreSQL loads it from its TZif file.',
  'pub(super) struct ZoneRules {',
  '    /// Each local time type: seconds east of UTC, whether it is daylight time, its abbreviation.',
  "    pub(super) types: &'static [(i64, bool, &'static str)],",
  '    /// The transition instants, seconds since the epoch, ascending.',
  "    pub(super) at: &'static [i64],",
  '    /// The local time type in effect from each transition on (an index into `types`).',
  "    pub(super) kind: &'static [u8],",
  "    /// The zone's rules add transitions after `at`'s last one (a footer with a rule).",
  '    pub(super) open_ended: bool,',
  '}',
  '',
  '/// (abbreviation in lower case, index into [`ZONES`]), in byte order of the abbreviation.',
  `pub(super) static DYNAMIC_ZONE_ABBREVIATIONS: [(&str, usize); ${dynamic.size}] = [`,
);
for (const abbr of [...dynamic.keys()].sort()) lines.push(`    ("${abbr}", ${names.get(dynamic.get(abbr)!.toLowerCase())}),`);
lines.push('];', '', '/// (zone name in lower case, index into [`ZONES`]), in byte order of the name.', `pub(super) static ZONE_NAMES: [(&str, usize); ${sortedNames.length}] = [`);
for (const name of sortedNames) lines.push(`    ("${name}", ${names.get(name)}),`);
lines.push('];', '', '/// Each distinct zone, in byte order of its first name (the comment above it).', `pub(super) static ZONES: [ZoneRules; ${zones.length}] = [`);
const packed = (items: string[], indent: string): string[] => {
  const out: string[] = [];
  let line = '';
  for (const item of items) {
    const next = line ? `${line} ${item},` : `${item},`;
    if (indent.length + next.length > 100) {
      out.push(indent + line);
      line = `${item},`;
    } else line = next;
  }
  if (line) out.push(indent + line);
  return out;
};
for (const z of zones) {
  lines.push(`    // ${z.name}`, '    ZoneRules {', '        types: &[');
  lines.push(...packed(z.types.map((t) => `(${t.utoff}, ${t.isdst}, "${t.abbr}")`), '            '));
  lines.push('        ],', '        at: &[');
  lines.push(...packed(z.at.map(String), '            '));
  lines.push('        ],', '        kind: &[');
  lines.push(...packed(z.kind.map(String), '            '));
  lines.push('        ],', `        open_ended: ${z.openEnded},`, '    },');
}
lines.push('];', '');
const text = lines.join('\n');
await db.close();

if (write) {
  writeFileSync(target, text);
  console.log(`wrote ${target}: ${dynamic.size} abbreviations, ${sortedNames.length} names, ${zones.length} zones, ${zones.reduce((n, z) => n + z.at.length, 0)} transitions`);
} else if (readFileSync(target, 'utf8') !== text) {
  console.error(`${target} differs from PGLite's tzdata; run with --write`);
  process.exit(1);
} else {
  console.log('zone_transitions.rs is current');
}
