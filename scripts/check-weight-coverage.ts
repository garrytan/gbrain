#!/usr/bin/env bun
/**
 * Shard weight-coverage ratchet (GBRA-47 C2; docs/TESTING.md#keeping-ci-partitions-balanced).
 *
 * Unit, serial and E2E shards are packed by the committed weight maps
 * (scripts/sharding.ts); a file with no weight is packed at the p75 fallback,
 * so a lane full of new, heavy, unweighted files runs one shard far past the
 * mean. The maps were refreshed by hand and went stale for weeks.
 *
 *   - An entry naming a file that no longer exists fails everywhere: a deleted
 *     or renamed test must take its weight with it.
 *   - A lane whose unweighted share passes its threshold (unit 5%, serial and
 *     E2E 10%) warns on pull requests, pushes and local runs, and fails only
 *     on the scheduled run (GITHUB_EVENT_NAME=schedule), where nightly-watch
 *     turns it into an issue. Both print the lane's miner command.
 *
 * scripts/ubicloud/weights.json (`<lane>:<path>` keys) gets the dead-entry
 * check only; ci:ubicloud --record-weights refreshes it.
 *
 * Seam: GBRAIN_GUARD_ROOT (fixture tree root); there `*.test.fixture.ts` files
 * count as their `*.test.ts` names so fixtures stay out of bun's discovery.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.env.GBRAIN_GUARD_ROOT ?? join(import.meta.dir, '..');
const TEST_FILE = process.env.GBRAIN_GUARD_ROOT ? /\.test(\.fixture)?\.ts$/ : /\.test\.ts$/;
const DOCS = 'docs/TESTING.md#keeping-ci-partitions-balanced';
const SCHEDULED = process.env.GITHUB_EVENT_NAME === 'schedule';
const latestRun = (workflow: string, event: string) =>
  `$(gh run list --workflow ${workflow} --branch master --event ${event} --status success --limit 1 --json databaseId --jq '.[0].databaseId')`;

function walk(dir: string): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(abs).sort()) {
    if (entry === 'node_modules') continue;
    const rel = `${dir}/${entry}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else if (TEST_FILE.test(entry)) out.push(rel.replace(/\.test\.fixture\.ts$/, '.test.ts'));
  }
  return out;
}
const exists = (path: string) => existsSync(join(ROOT, path)) || existsSync(join(ROOT, path.replace(/\.test\.ts$/, '.test.fixture.ts')));
const readMap = (path: string): Record<string, number> => existsSync(join(ROOT, path)) ? JSON.parse(readFileSync(join(ROOT, path), 'utf8')) : {};

const tests = [...walk('test'), ...walk('evals')];
const LANES = [
  {
    lane: 'unit', map: 'scripts/test-weights.json', threshold: 0.05,
    files: tests.filter(f => !f.endsWith('.serial.test.ts') && !f.startsWith('test/e2e/')),
    miner: 'bun run weights:mine --lane unit --latest 5 --coverage-only',
  },
  {
    lane: 'serial', map: 'scripts/serial-weights.json', threshold: 0.10,
    files: tests.filter(f => f.endsWith('.serial.test.ts') && f.startsWith('test/') && !f.startsWith('test/e2e/')),
    miner: 'bun run weights:mine --lane serial --latest 5',
  },
  {
    lane: 'e2e', map: 'scripts/e2e-weights.json', threshold: 0.10,
    files: tests.filter(f => /^test\/e2e\/[^/]+\.test\.ts$/.test(f)),
    miner: `bun run weights:mine --lane e2e --e2e-profile full --run ${latestRun('e2e.yml', 'schedule')}`,
  },
];

const listDead = (entries: string[]) => [...entries.slice(0, 10).map(e => `  ${e}`), ...(entries.length > 10 ? [`  ... and ${entries.length - 10} more`] : [])].join('\n');
const deadHeader = (map: string, n: number) => `${map}: ${n} ${n === 1 ? 'entry names a file that no longer exists' : 'entries name files that no longer exist'}:`;
const failures: string[] = [];
const warnings: string[] = [];
for (const { lane, map, threshold, files, miner } of LANES) {
  const weights = readMap(map);
  const dead = Object.keys(weights).filter(path => !exists(path));
  if (dead.length) failures.push(`${deadHeader(map, dead.length)}\n${listDead(dead)}\n  Fix: delete ${dead.length === 1 ? 'that entry' : 'those entries'} from ${map}, or re-mine: ${miner}`);
  const unweighted = files.filter(f => !(f in weights));
  const share = files.length ? unweighted.length / files.length : 0;
  if (share > threshold) {
    const line = `${lane}: ${unweighted.length} of ${files.length} files (${(share * 100).toFixed(1)}%) have no weight in ${map}, above the ${threshold * 100}% bound; shards are packed blind.\n  Fix: ${miner}`;
    (SCHEDULED ? failures : warnings).push(line);
  }
}
const ubicloud = readMap('scripts/ubicloud/weights.json');
const ubicloudDead = Object.keys(ubicloud).filter(key => !exists(key.slice(key.indexOf(':') + 1)));
if (ubicloudDead.length) failures.push(`${deadHeader('scripts/ubicloud/weights.json', ubicloudDead.length)}\n${listDead(ubicloudDead)}\n  Fix: delete ${ubicloudDead.length === 1 ? 'that entry' : 'those entries'}, or refresh with: bun run ci:ubicloud --record-weights`);

const why = 'Why: shard weights pack each CI lane; stale maps leave one shard far slower than the rest.';
if (warnings.length) {
  const text = `check-weight-coverage: WARN (fails only on the scheduled run)\n${warnings.join('\n')}\n${why}\nDocs: ${DOCS}`;
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Shard weight coverage\n\n\`\`\`\n${text}\n\`\`\`\n`);
}
if (failures.length) {
  console.error(`check-weight-coverage: FAIL\n${failures.join('\n')}\n${why}\nDocs: ${DOCS}`);
  process.exit(1);
}
console.log(`check-weight-coverage: OK (${LANES.map(l => `${l.lane} ${l.files.length} files`).join(', ')}; no dead entries)`);
