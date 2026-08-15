#!/usr/bin/env bun
/**
 * E6 — auto-generate docs/TOOL_CATALOG.md from src/mcp/tool-catalog.ts.
 *
 * Run: bun run scripts/generate-tool-catalog.ts
 *
 * CI guard `scripts/check-tool-catalog-fresh.sh` (in `bun run verify`)
 * regenerates and diffs against the committed version — an out-of-date doc
 * fails the build. Mirrors the METRIC_GLOSSARY generator pattern
 * (scripts/generate-metric-glossary.ts).
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { renderToolCatalogMarkdown } from '../src/mcp/tool-catalog.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_PATH = join(REPO_ROOT, 'docs', 'TOOL_CATALOG.md');

const md = renderToolCatalogMarkdown() + '\n';

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, md, 'utf-8');

console.log(`Wrote ${OUT_PATH} (${md.length} bytes, ${md.split('\n').length} lines).`);
