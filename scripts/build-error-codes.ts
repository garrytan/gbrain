#!/usr/bin/env bun
/**
 * Generate docs/guides/error-codes.md from the error code registry
 * (src/core/error-registry.ts) — agent contract v1, A2.
 *   bun run build:error-codes          write the guide
 *   bun run build:error-codes --check  exit 1 when the committed guide is stale
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderErrorCodesMarkdown } from '../src/core/error-docs.ts';

const path = join(import.meta.dir, '..', 'docs', 'guides', 'error-codes.md');
const fresh = renderErrorCodesMarkdown();
if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(path, 'utf8'); } catch { /* missing */ }
  if (current !== fresh) {
    console.error('docs/guides/error-codes.md is stale. Run: bun run build:error-codes');
    process.exit(1);
  }
  console.log('error-codes.md: up to date');
} else {
  writeFileSync(path, fresh);
  console.log(`wrote ${path}`);
}
