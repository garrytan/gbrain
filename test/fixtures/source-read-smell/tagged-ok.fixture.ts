import { readFileSync } from 'fs';
import { join } from 'path';

// test-reads-source-ok[structural]: fixture — a tagged marker justifies the read below.
export const ENGINE_SRC = readFileSync(join(import.meta.dir, '..', '..', 'src/core/example.ts'), 'utf8');

// A read that names no src path is not a site, and a mention of
// readFileSync('src/x.ts') inside a comment or string is ignored.
export const README = readFileSync(join(import.meta.dir, 'README.md'), 'utf8');
export const PROSE = "readFileSync('src/core/example.ts')";
