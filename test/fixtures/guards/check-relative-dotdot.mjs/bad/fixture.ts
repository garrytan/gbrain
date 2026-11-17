// BAD: a prefix-only check refuses a legal first folder such as `..drafts`.
import { relative } from 'node:path';
export function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== '' && !rel.startsWith('..');
}
