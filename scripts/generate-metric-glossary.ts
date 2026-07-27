#!/usr/bin/env bun
/**
 * v0.32.3 — auto-generate docs/eval/METRIC_GLOSSARY.md from
 * src/core/eval/metric-glossary.ts.
 *
 * Run: bun run scripts/generate-metric-glossary.ts
 *
 * CI guard `scripts/check-eval-glossary-fresh.sh` regenerates and diffs
 * against the committed version — out-of-date doc fails the build.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { renderMetricGlossaryMarkdown } from '../src/core/eval/metric-glossary.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OUT_PATH = join(REPO_ROOT, 'docs', 'eval', 'METRIC_GLOSSARY.md');

const md = renderMetricGlossaryMarkdown();

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, md, 'utf-8');

console.log(`Wrote ${OUT_PATH} (${md.length} bytes, ${md.split('\n').length} lines).`);
