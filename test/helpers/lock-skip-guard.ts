/**
 * The checks of test/serialized-transactions-guard.test.ts as pure functions, so fixtures can drive each one
 * (docs/designs/rust-engine/multi-user-server.md, groundwork G1). Two separate things:
 *
 * - Enforcement: the marked lock skips. A mark counts only where it is a real assertion call
 *   (`assertSerializedTransactions(engine, '<site>')`, `assertStoreSerializedTransactions(brain, '<site>')`,
 *   `self.assert_serialized_transactions("<site>")` / `store.assert_serialized_transactions("<site>")`), never in a comment
 *   or a string; the pinned baseline is per file; a site id is unique; each site has a refusal case.
 * - Discovery: files whose text states the single-writer model or (in Rust engine code) names a SQL lock. Discovery
 *   only asks for a reason; it never counts as a site.
 */
import ts from 'typescript';

export const TS_ASSERTS = new Set(['assertSerializedTransactions', 'assertStoreSerializedTransactions']);
export const RUST_ASSERT = 'assert_serialized_transactions';

/** Comments that state the single-writer model as a fact (the appendix search, widened). */
export const SINGLE_WRITER = /one write( transaction)? at a time|one writer|single writer|single-writer|writer gate|holds the writer|no other writer|nothing to wait for|takes no (row )?lock|no lock is needed|has nothing to (add|skip|wait)|nothing to skip|lock has nothing|locks? (is|are) (a )?no-?op|one process owns the brain|serializes? (its )?writes?\b|serialised|admits one write|store write is exclusive|write transaction is the (advisory )?lock|is the row lock|holds the whole store/i;
/** SQL lock words, checked in Rust engine code only (rust/crates, src/core/rust-engine). */
export const SQL_LOCK = /FOR UPDATE|FOR SHARE|FOR KEY SHARE|FOR NO KEY UPDATE|SKIP LOCKED|advisory|row lock|share lock|LOCK TABLE/i;

export interface Marks {
  /** Site ids of the real assertion calls, in source order. */
  sites: string[];
  /** Assertion-shaped text that is not a real call with a literal site (a comment, a string, a computed id). */
  stray: number;
}

/** The marks of a TypeScript file: assertion calls whose second argument is a string literal. */
export function tsMarks(file: string, text: string): Marks {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && TS_ASSERTS.has(n.expression.text)) {
      const site = n.arguments[1];
      if (n.arguments.length === 2 && site && ts.isStringLiteralLike(site)) sites.push(site.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  const shaped = [...text.matchAll(/\bassert(?:Store)?SerializedTransactions\(/g)].length;
  const declared = [...text.matchAll(/function assert(?:Store)?SerializedTransactions\(/g)].length;
  return { sites, stray: shaped - declared - sites.length };
}

/** Rust source with line and block comments blanked (string literals kept; a site id is a string literal). */
export function stripRustComments(text: string): string {
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text.startsWith('//', i)) { while (i < text.length && text[i] !== '\n') { out += ' '; i++; } }
    else if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); const stop = end < 0 ? text.length : end + 2; out += text.slice(i, stop).replace(/[^\n]/g, ' '); i = stop; }
    else if (text[i] === '"') { const start = i++; while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1; i++; out += text.slice(start, i); }
    else out += text[i++];
  }
  return out;
}

/** The marks of a Rust file: `.assert_serialized_transactions("<site>")` method calls outside comments. */
export function rustMarks(text: string): Marks {
  const code = stripRustComments(text);
  const sites = [...code.matchAll(/\.assert_serialized_transactions\(\s*"([^"]+)"\s*\)/g)].map(m => m[1]!);
  const shaped = [...text.matchAll(/\bassert_serialized_transactions\(/g)].length;
  const declared = [...code.matchAll(/fn assert_serialized_transactions\(/g)].length;
  return { sites, stray: shaped - declared - sites.length };
}

/** Whether discovery flags the file: a single-writer phrase, or in Rust engine code a SQL lock word. */
export function discovered(file: string, text: string): boolean {
  const rustEngine = file.endsWith('.rs') || file.startsWith('src/core/rust-engine');
  return text.split('\n').some(line => rustEngine
    ? SINGLE_WRITER.test(line) || SQL_LOCK.test(line)
    // Elsewhere in src only a line about the Rust store counts: PGLite's own single-writer lock is another thing.
    : SINGLE_WRITER.test(line) && /rust|store/i.test(line));
}

/** Differences between the marks found and the pinned baseline, one line each. */
export function baselineDrift(found: Readonly<Record<string, readonly string[]>>, pinned: Readonly<Record<string, readonly string[]>>): string[] {
  const out: string[] = [];
  for (const file of new Set([...Object.keys(found), ...Object.keys(pinned)])) {
    const a = (found[file] ?? []).join(','), b = (pinned[file] ?? []).join(',');
    if (a !== b) out.push(`${file}: found [${a}], pinned [${b}]`);
  }
  return out.sort();
}

/** Site ids that appear more than once. */
export function duplicateSites(found: Readonly<Record<string, readonly string[]>>): string[] {
  const all = Object.values(found).flat();
  return [...new Set(all.filter((s, i) => all.indexOf(s) !== i))].sort();
}

/** Sites with no refusal case naming them (TypeScript cases quote with ', Rust cases with "). */
export function sitesWithoutCases(found: Readonly<Record<string, readonly string[]>>, tsCases: string, rustCases: string): string[] {
  return Object.entries(found).flatMap(([file, sites]) => sites
    .filter(site => file.endsWith('.rs') ? !rustCases.includes(`"${site}"`) : !tsCases.includes(`'${site}'`))
    .map(site => `${file}: ${site}`));
}

/** How a Rust-served member whose SQL takes a lock is covered. */
export type Disposition = { sites: readonly string[] } | { atomic: string } | { refuses: string } | { notALock: string };

/**
 * The Rust-served locking members with no executed assertion and no stated reason: a member is covered by a marked site
 * of its own name, by the sites its disposition names (each must be marked), or by a stated reason.
 */
export function uncoveredLockingMembers(locking: Iterable<string>, served: ReadonlySet<string>, sites: ReadonlySet<string>,
  dispositions: Readonly<Record<string, Disposition>>): string[] {
  const out: string[] = [];
  for (const member of locking) {
    if (!served.has(member)) continue;
    const d = dispositions[member];
    if (d && 'sites' in d) { for (const s of d.sites) if (!sites.has(s)) out.push(`${member}: names site ${s}, which is not marked`); }
    else if (!d && !sites.has(member)) out.push(`${member}: no marked site and no disposition`);
  }
  return out;
}
