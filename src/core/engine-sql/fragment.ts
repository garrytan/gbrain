/**
 * `sqlFragment`: the one composition primitive for engine-sql statements
 * (refactor wave 1, EO8 / EO17; docs/architecture/infra-layer.md).
 *
 * A fragment is SQL text plus its bound values. Interpolating into the
 * template does exactly what a postgres.js tagged template did on master:
 *
 *   - a nested `SqlFragment` is spliced in place (its values follow in order);
 *   - `trustedSql(text)` splices constant SQL text with no values (identifier
 *     and ORDER BY allowlists, vetted fragment builders; the engine-sql
 *     dynamic-SQL scanner restricts what may be passed);
 *   - anything else becomes the next positional parameter.
 *
 * Placeholders are numbered once, when the text is rendered, so composed
 * fragments never carry hand-written `$N` (literal `$<digit>` in composed
 * strings is banned by the scanner). The rendered text is byte-identical to
 * what postgres.js built from the equivalent tagged template, which is what
 * the SQL-text goldens (`test/fixtures/goldens/sql-text/`) pin.
 *
 * No identifier escaping: identifiers come only from constant allowlists.
 */

const FRAGMENT = Symbol('gbrain.engine-sql.fragment');
const TRUSTED = Symbol('gbrain.engine-sql.trusted');

export interface SqlFragment {
  readonly [FRAGMENT]: true;
  /** Literal text pieces; `strings.length === values.length + 1`. */
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
}

interface TrustedText {
  readonly [TRUSTED]: string;
}

function isFragment(value: unknown): value is SqlFragment {
  return typeof value === 'object' && value !== null && FRAGMENT in value;
}

function isTrusted(value: unknown): value is TrustedText {
  return typeof value === 'object' && value !== null && TRUSTED in value;
}

/** Tagged template that builds a composable fragment. See the module header. */
export function sqlFragment(template: TemplateStringsArray, ...args: unknown[]): SqlFragment {
  const strings: string[] = [template[0]];
  const values: unknown[] = [];
  args.forEach((arg, i) => {
    const next = template[i + 1];
    if (isTrusted(arg)) {
      strings[strings.length - 1] += arg[TRUSTED] + next;
      return;
    }
    if (isFragment(arg)) {
      strings[strings.length - 1] += arg.strings[0];
      for (let k = 0; k < arg.values.length; k++) {
        values.push(arg.values[k]);
        strings.push(arg.strings[k + 1]);
      }
      strings[strings.length - 1] += next;
      return;
    }
    values.push(arg);
    strings.push(next);
  });
  return { [FRAGMENT]: true, strings, values };
}

/**
 * Constant SQL text spliced verbatim (no values). Only for constant
 * identifier / ORDER BY allowlists and the vetted builders registered in
 * `scripts/check-engine-sql-dynamic.ts`.
 */
export function trustedSql(text: string): TrustedText {
  return { [TRUSTED]: text };
}

/** Join fragments with constant separator text (e.g. `, ` or ` AND `). */
export function joinFragments(parts: readonly SqlFragment[], separator: string): SqlFragment {
  const strings: string[] = [''];
  const values: unknown[] = [];
  parts.forEach((part, i) => {
    strings[strings.length - 1] += (i > 0 ? separator : '') + part.strings[0];
    for (let k = 0; k < part.values.length; k++) {
      values.push(part.values[k]);
      strings.push(part.strings[k + 1]);
    }
  });
  return { [FRAGMENT]: true, strings, values };
}

/** Render to positional text (`$1..$n`) and its parameter list. */
export function renderFragment(fragment: SqlFragment): { text: string; params: unknown[] } {
  let text = fragment.strings[0];
  for (let i = 0; i < fragment.values.length; i++) text += `$${i + 1}` + fragment.strings[i + 1];
  return { text, params: [...fragment.values] };
}
