import { readFileSync } from 'fs';

// The marker below lacks a category, so it justifies nothing.
// test-reads-source-ok: missing category
export const ENGINE_SRC = readFileSync('src/core/example.ts', 'utf8');
