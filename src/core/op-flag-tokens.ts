/**
 * Token predicates shared by the op-command flag parser (`parseOpArgs`) and
 * its pre-dispatch validator (`findUnknownOpFlag`), both in `src/cli.ts`.
 *
 * They live here rather than in cli.ts because the two call sites must never
 * disagree about what a flag swallows: the parser decides what becomes a
 * param, and the validator mirrors that traversal to decide whether a token
 * it skipped was an unknown flag. A predicate defined twice drifts; one
 * defined once and imported cannot.
 */

import type { Operation } from './operations.ts';

/**
 * #4602: the ONE definition of "a literal true/false value token" — parseOpArgs
 * consumes it as a boolean flag's value, and findUnknownOpFlag mirrors the
 * traversal so the token counts as consumed.
 */
export const isBooleanLiteral = (tok: string | undefined): boolean =>
  tok === 'true' || tok === 'false';

/**
 * #5700: the ONE definition of "a flag this command knows" — an op-contract
 * param, one of the CLI-locals parseOpArgs/findUnknownOpFlag handle by name
 * (`json`, `dry-run`, `source`, `explain`, `help`), or the `--no-<boolean>`
 * form.
 *
 * parseOpArgs uses it to refuse letting a non-boolean flag swallow such a
 * token as its value: `gbrain put x --content --source default` stored the
 * literal "--source" as the page body, dropped the real --source (so the write
 * landed on an ambient source instead of the requested one) and never read the
 * stdin pipe, because `content` was already set. Flag order alone decided
 * whether the body or the flag won.
 *
 * `--` is excluded: it is the end-of-flags separator, never a value or a flag.
 * A token that merely starts with `--` but names no flag of this command (a
 * markdown body opening with an em-dash, say) is not a known flag and stays a
 * value.
 */
export const isKnownOpFlag = (op: Operation, tok: string | undefined): boolean => {
  if (!tok || !tok.startsWith('--') || tok === '--') return false;
  const eq = tok.indexOf('=');
  if (eq >= 0 && eq <= 2) return false; // `--=x` is junk, not a flag
  const raw = (eq > 2 ? tok.slice(2, eq) : tok.slice(2)).replace(/-/g, '_');
  if (!raw) return false;
  if (raw === 'json' || raw === 'dry_run' || raw === 'source' || raw === 'explain' || raw === 'help') {
    return true;
  }
  if (op.params[raw]) return true;
  if (raw.startsWith('no_') && op.params[raw.slice(3)]?.type === 'boolean') return true;
  return false;
};
