/**
 * Child process for test/backlinks-memory.slow.test.ts (wave 14 P1.1).
 * argv: <corpusRoot> <nonTargetMiB>. Builds the corpus if the root is empty
 * (50 fixed `people/`/`companies/` targets, non-target pages of ~1 MiB each
 * with one sparse ref apiece), runs findBacklinkGaps, prints one JSON line:
 * { gaps, rss_before_mb, rss_peak_mb, delta_peak_mb, heap_retained_mb, largest_file_mb }:
 * the RSS peak is read right after the scan (what the OOM killer sees; RSS
 * never shrinks back), the heap delta after a forced GC is what the scan
 * actually kept alive.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findBacklinkGaps } from '../../src/commands/backlinks.ts';

const [root, mibArg] = process.argv.slice(2);
const mib = Number(mibArg);
if (!root || !Number.isFinite(mib)) throw new Error('usage: backlinks-rss-child <root> <nonTargetMiB>');

const FILE_MIB = 1;
if (!existsSync(join(root, 'people')) || readdirSync(join(root, 'records')).length !== mib / FILE_MIB) {
  mkdirSync(join(root, 'people'), { recursive: true });
  mkdirSync(join(root, 'companies'), { recursive: true });
  mkdirSync(join(root, 'records'), { recursive: true });
  for (let i = 0; i < 25; i++) {
    writeFileSync(join(root, 'people', `person-${i}.md`), `# Person ${i}\n\nA fixed target.\n`);
    writeFileSync(join(root, 'companies', `company-${i}.md`), `# Company ${i}\n\nA fixed target.\n`);
  }
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor\n';
  const body = filler.repeat(Math.ceil((FILE_MIB * 1024 * 1024) / filler.length));
  for (let i = 0; i < mib / FILE_MIB; i++) {
    const dir = i % 2 === 0 ? 'people' : 'companies';
    const ref = `[Target ${i}](../${dir}/${dir === 'people' ? 'person' : 'company'}-${i % 25})`;
    writeFileSync(join(root, 'records', `record-${i}.md`), `# Record ${i}\n\n${ref}\n\n${body}`);
  }
}

Bun.gc(true);
const before = process.memoryUsage();
const gaps = findBacklinkGaps(root);
const peak = process.memoryUsage().rss;
Bun.gc(true);
const after = process.memoryUsage();
const mb = (n: number) => Math.round(n / (1024 * 1024));
console.log(JSON.stringify({
  gaps: gaps.length, rss_before_mb: mb(before.rss), rss_peak_mb: mb(peak),
  delta_peak_mb: mb(peak - before.rss), heap_retained_mb: mb(after.heapUsed - before.heapUsed), largest_file_mb: FILE_MIB,
}));
