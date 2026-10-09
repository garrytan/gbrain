/**
 * Shared `gbrain <verb> [--flag ...]` scanner for the doc↔CLI truth checks
 * (test/docs-cli-commands.test.ts, test/remediation-command-resolution.test.ts).
 *
 * One definition of "a live verb", "command position", "code regions of a
 * markdown file" and "does this invocation's argv pass the real flag
 * validator", so both gates agree on the CLI surface by construction.
 *
 * Flags are checked by the production pipeline itself: parseGlobalFlags
 * (strips --brain/--quiet/--progress-*) followed by validateCommandFlags
 * (op commands: op.params + CLI-local flags; CLI_ONLY commands: the generated
 * CLI_FLAG_REGISTRY row). Limitations inherited from that validator: CLI_ONLY
 * flags are per top-level command, not per subcommand, and commands it exempts
 * (`call`, `config`, `jobs submit`, `eval brainbench`) are verb-checked only.
 *
 * Plain helper: no env mutation, no engine, no network.
 */
import { CLI_ONLY, cliAliases, validateCommandFlags } from '../../src/cli/main.ts';
import { parseGlobalFlags } from '../../src/core/cli-options.ts';
import { migrationCliArgumentError } from '../../src/core/embedding-migration-cli.ts';
import { operations } from '../../src/core/operations.ts';

/** Every verb the dispatcher accepts: CLI_ONLY, non-hidden op names, aliases. */
export function liveCliVerbs(): Set<string> {
  const valid = new Set<string>(CLI_ONLY);
  for (const op of operations) {
    const name = op.cliHints?.name;
    if (name && !op.cliHints?.hidden) valid.add(name);
  }
  for (const alias of cliAliases.keys()) valid.add(alias);
  return valid;
}

/** True when `gbrain` sits at command position (not mid-prose). */
export function commandPosition(prefix: string): boolean {
  const p = prefix.trimEnd();
  return p === '' || /[|;&`(={[]$/.test(p) || /\$$/.test(p);
}

/**
 * Marker that exempts one example from the truth check because it documents
 * an older release's CLI. Place it on the line directly above a code fence
 * (covers the whole block) or on/above a line with inline code.
 */
export const HISTORICAL_MARKER = '<!-- gbrain-cli: historical -->';

export interface CodeLine { code: string; line: number; historical: boolean }

/**
 * Fenced-block lines (backslash continuations joined) + inline code spans
 * that START with `gbrain `. Comment and ASCII-diagram lines are skipped.
 */
export function codeRegions(text: string): CodeLine[] {
  const out: CodeLine[] = [];
  const lines = text.split('\n');
  const markedAbove = (i: number) => i > 0 && lines[i - 1]!.includes(HISTORICAL_MARKER);
  let inFence = false;
  let fenceHistorical = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^\s*(```|~~~)/.test(l)) {
      inFence = !inFence;
      fenceHistorical = inFence && markedAbove(i);
      continue;
    }
    if (inFence) {
      const t = l.trim();
      if (/^(#|\/\/|--|\*)/.test(t)) continue;
      if (/[│┌┐└┘├┤─═╔╗╚╝]/.test(l)) continue;
      let code = l;
      const start = i;
      while (/\\\s*$/.test(code) && i + 1 < lines.length && !/^\s*(```|~~~)/.test(lines[i + 1]!)) {
        code = code.replace(/\\\s*$/, ' ') + lines[++i]!.trim();
      }
      out.push({ code, line: start + 1, historical: fenceHistorical });
      continue;
    }
    const historical = l.includes(HISTORICAL_MARKER) || markedAbove(i);
    for (const m of l.matchAll(/`(gbrain [^`]+)`/g)) out.push({ code: m[1]!, line: i + 1, historical });
  }
  return out;
}

export interface Invocation { verb: string; argv: string[] }

/** `gbrain <verb>` invocations at command position, with their argv up to the next shell operator. */
export function gbrainInvocations(code: string): Invocation[] {
  const out: Invocation[] = [];
  for (const m of code.matchAll(/\bgbrain\s+([A-Za-z][\w-]*)/g)) {
    const verb = m[1]!;
    if (!/^[a-z][a-z0-9_-]{2,}$/.test(verb)) continue;
    if (!commandPosition(code.slice(0, m.index))) continue;
    if (verb === 'notice' && code[m.index! - 1] === '[') continue; // `[gbrain notice <code> …]` block prefix, not a command
    out.push({ verb, argv: shellWords(code.slice(m.index! + m[0].length - verb.length)) });
  }
  return out;
}

/**
 * Shell-ish word split of one command: honors quotes, stops at an unquoted
 * pipe/list/redirect/substitution boundary or `#` comment. `[...]` optional
 * groups are unwrapped (their inner `|` is alternation, not a pipe).
 * Placeholder words (`<slug>`, `$VAR`, `{a,b}`, `N`, `CLIENT_ID`) become `1`,
 * a value every typed parser (ids, counts, costs, brain names) accepts.
 */
function shellWords(s: string): string[] {
  const words: string[] = [];
  let cur = '';
  let has = false;
  let depth = 0;
  const flush = () => {
    if (has) words.push(/^[A-Z][A-Z0-9_]*$/.test(cur) ? '1' : cur.replace(/^(--[a-z0-9-]+=)?[<${].*$/i, '$11'));
    cur = '';
    has = false;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "'" || c === '"') {
      const end = s.indexOf(c, i + 1);
      cur += end === -1 ? s.slice(i + 1) : s.slice(i + 1, end);
      has = true;
      if (end === -1) break;
      i = end;
      continue;
    }
    if (c === '[') { depth++; continue; }
    if (c === ']') { depth = Math.max(0, depth - 1); continue; }
    if (/\s/.test(c)) { flush(); continue; }
    if (c === '|' && depth > 0) { flush(); continue; }
    if (/[|;&`)]/.test(c) || (c === '>' && !cur.startsWith('<')) || (c === '#' && !has)) break;
    if (c === '<' && !has && /^<\s/.test(s.slice(i))) break;
    cur += c;
    has = true;
  }
  flush();
  return words.filter((w) => w !== '...' && w !== '…');
}

/**
 * Routes src/cli.ts main() dispatches BEFORE the unknown-flag validator runs:
 * their handlers parse their own flags, so only the verb is checked here.
 */
function dispatchedBeforeValidation(command: string, subArgs: string[]): boolean {
  if (command === 'search') return ['modes', 'stats', 'tune', 'diagnose'].includes(subArgs[0] ?? '');
  if (command === 'sources') return ['inspect', 'connect'].includes(subArgs[0] ?? '')
    || (subArgs[0] === 'demo' && subArgs[1] === 'company-brain');
  return false;
}

/**
 * Run an invocation through the production global-flag parser and the
 * pre-dispatch argument validators, in main()'s order. Returns the reason the
 * real CLI would reject it, or null when it accepts its flags.
 */
export function flagRejection(inv: Invocation): string | null {
  let rest: string[];
  try {
    rest = parseGlobalFlags(inv.argv).rest;
  } catch (e) {
    return (e as Error).message;
  }
  const [typed, ...subArgs] = rest;
  if (!typed || subArgs.some((a) => a === '--help' || a === '-h')) return null;
  const command = typed === 'ask' ? 'query' : typed;
  if (dispatchedBeforeValidation(command, subArgs)) return null;
  const migrationError = migrationCliArgumentError(command, subArgs);
  if (migrationError) return migrationError.message;
  const flag = validateCommandFlags(command, subArgs);
  return flag ? `unknown flag ${flag} for 'gbrain ${typed}'` : null;
}
