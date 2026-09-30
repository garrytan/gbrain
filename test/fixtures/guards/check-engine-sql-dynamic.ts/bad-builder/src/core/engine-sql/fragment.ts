// Guard self-test fixture stub (exempt renderer): mirrors src/core/engine-sql/fragment.ts.
export interface SqlFragment {
  readonly strings: readonly string[];
  readonly values: readonly unknown[];
}

export function sqlFragment(template: TemplateStringsArray, ...values: unknown[]): SqlFragment {
  return { strings: [...template], values };
}

export function trustedSql(text: string): { readonly text: string } {
  return { text };
}

export function renderFragment(fragment: SqlFragment): string {
  let text = fragment.strings[0];
  for (let i = 0; i < fragment.values.length; i++) text += `$${i + 1}` + fragment.strings[i + 1];
  return text;
}
