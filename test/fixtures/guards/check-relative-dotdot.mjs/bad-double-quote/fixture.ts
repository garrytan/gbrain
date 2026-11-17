// BAD: the same prefix-only check, spelled with double quotes.
export function scope(rel: string): string {
  return rel.startsWith("..") ? '' : rel;
}
