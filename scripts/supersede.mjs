#!/usr/bin/env bun
// Usage: supersede.mjs <slug> <row_num> <kind> <holder> <weight> <since> <source> <claim>
import { loadConfig, toEngineConfig } from '../src/core/config.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseTakesFence, supersedeRow } from '../src/core/takes-fence.ts';

const [slug, rowNumStr, kind, holder, weightStr, since, source, claim] = process.argv.slice(2);
if (!claim) {
  console.error('usage: supersede.mjs <slug> <row_num> <kind> <holder> <weight> <since> <source> <claim>');
  process.exit(1);
}
const rowNum = parseInt(rowNumStr, 10);
const weight = parseFloat(weightStr);
const cfg = loadConfig();
const ec = toEngineConfig(cfg);
const engine = await createEngine(ec);
await engine.connect(ec);

const [page] = await engine.executeRaw('SELECT id FROM pages WHERE slug=$1 LIMIT 1', [slug]);
if (!page) { console.error('page not found:', slug); process.exit(1); }
const pageId = page.id;

const result = await engine.supersedeTake(pageId, rowNum, {
  claim, kind, holder, weight, source, since_date: since || null, active: true,
});

// Update markdown
const brainDir = '/data/brain';
const path = join(brainDir, `${slug}.md`);
if (existsSync(path)) {
  const body = readFileSync(path, 'utf-8');
  if (parseTakesFence(body).takes.find(t => t.rowNum === rowNum)) {
    const { body: nextBody } = supersedeRow(body, rowNum, {
      claim, kind, holder, weight, source, sinceDate: since || null,
    });
    writeFileSync(path, nextBody);
  } else {
    console.warn('[mirror] markdown lacks row', rowNum);
  }
}
console.log(`Superseded #${result.oldRow} -> new #${result.newRow} on ${slug}`);
process.exit(0);
