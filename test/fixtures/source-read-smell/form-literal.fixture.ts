import { readFileSync } from 'fs';

export function load(): string {
  // Same-line literal path.
  return readFileSync('src/core/example.ts', 'utf8');
}
