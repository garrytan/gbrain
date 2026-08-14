/**
 * gbrain sources demo github — offline demo of the github source kind.
 *
 *   gbrain sources demo github [--dir <path>] [--limit <n>]
 *
 * Renders a privacy-clean fixture dataset (alice-example placeholders)
 * through the exact same pure render functions the live sync uses
 * (renderItemPage / renderRepoCard / itemPagePath / repoCardPath), writing
 * pages to a directory. No network, no token, no brain required.
 *
 *   $ gbrain sources demo github
 *   wrote 5 pages to ./gbrain-demo (3 items, 2 repo cards)
 *   open gh/alice-example/sample-app/12.md to see a live-style page
 *   real sync:  gbrain sources add gh --kind github --scope auto
 *   guide:      docs/guides/github-source.md
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BrainEngine } from '../core/engine.ts';
import {
  renderItemPage,
  renderRepoCard,
  itemPagePath,
  repoCardPath,
} from '../core/github-source.ts';
import { DEMO_ITEMS, DEMO_REPOS } from '../fixtures/github-demo.ts';

export async function runSourcesDemo(
  _engine: BrainEngine,
  args: string[],
): Promise<void> {
  let dir = 'gbrain-demo';
  let limit = DEMO_ITEMS.length;
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(
      'Usage: gbrain sources demo github [--dir <path>] [--limit <n>]\n' +
        '\n' +
        'Render the offline github-source demo dataset into <dir>.\n' +
        'No network, no token, no brain: the same render functions a\n' +
        'real sync uses, on generic alice-example fixtures.\n' +
        '\n' +
        'Options:\n' +
        '  --dir <path>    output directory (default: ./gbrain-demo)\n' +
        '  --limit <n>     render only the first n items (default: all)',
    );
    return;
  }
  if (args[0] !== 'github') {
    console.error('Usage: gbrain sources demo github [--dir <path>] [--limit <n>]');
    process.exit(2);
  }
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--dir') {
      dir = args[++i];
      if (!dir) {
        console.error('Usage: gbrain sources demo github [--dir <path>] [--limit <n>]');
        process.exit(2);
      }
    } else if (args[i] === '--limit') {
      limit = Number(args[++i]);
      if (!Number.isInteger(limit) || limit < 1) {
        console.error('--limit must be a positive integer');
        process.exit(2);
      }
    } else {
      console.error(`Unknown option: ${args[i]}`);
      process.exit(2);
    }
  }

  mkdirSync(join(dir, 'gh'), { recursive: true });

  const items = DEMO_ITEMS.slice(0, limit);
  for (const item of items) {
    const page = renderItemPage(item);
    const p = itemPagePath(dir, item.repo, item.number);
    mkdirSync(join(dir, 'gh', item.repo), { recursive: true });
    writeFileSync(p, page);
  }

  const repoNames = new Set<string>();
  for (const item of items) repoNames.add(item.repo);
  for (const repo of DEMO_REPOS) {
    if (!repoNames.has(repo.full_name)) continue;
    const card = renderRepoCard(repo.full_name, repo);
    const p = repoCardPath(dir, repo.full_name);
    mkdirSync(join(dir, 'gh', repo.full_name), { recursive: true });
    writeFileSync(p, card);
  }

  console.log(`wrote ${items.length} item pages + ${repoNames.size} repo cards to ${dir}`);
  console.log('no network, no token, no brain required');
  console.log('real sync:  gbrain sources add gh --kind github --scope auto');
  console.log('guide:      docs/guides/github-source.md');
}
