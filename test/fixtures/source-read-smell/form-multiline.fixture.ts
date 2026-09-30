import { readFileSync } from 'fs';
import { join } from 'path';

export function load(): string {
  return readFileSync(
    join(import.meta.dir, '..', '..', 'src/core/example.ts'),
    'utf8',
  );
}
