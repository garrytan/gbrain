// GOOD: component-aware checks, a comment that names the old pattern, and an opt-out.
import { relative, sep } from 'node:path';
declare function relativeEscapesRoot(rel: string): boolean;
export function inside(root: string, p: string): boolean {
  // The old check, rel.startsWith('..'), also matched a folder named `..drafts`.
  const rel = relative(root, p);
  return rel !== '' && !relativeEscapesRoot(rel);
}
export function upward(rel: string): boolean {
  return rel === '..' || rel.startsWith('../') || rel.startsWith(`..${sep}`);
}
export function isRangeToken(token: string): boolean {
  // gbrain-allow-dotdot-prefix: a `..` range token in a git revision, not a path
  return token.startsWith('..');
}
