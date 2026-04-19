#!/usr/bin/env bun
/**
 * eval:world:view — (re)generate world.html and open it in the default browser.
 *
 * Combines two steps the contributor shouldn't have to think about:
 *   1. Render eval/data/world-v1/world.html from the shard JSONs.
 *   2. Open it in the default browser via `open` (macOS) / `xdg-open` (Linux).
 *
 * If the HTML already exists and shards haven't changed since, we'd ideally
 * skip step 1 — but comparing timestamps is fragile and regeneration is fast
 * (~50ms on 240 entities). Just regenerate every time.
 *
 * Usage:
 *   bun run eval:world:view              (generates + opens)
 *   bun run eval:world:view --no-open    (generates only; useful in CI)
 */

import { execSync } from 'child_process';
import { platform } from 'os';
import { renderWorldHtmlToFile } from '../generators/world-html.ts';

function openInBrowser(path: string): void {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'start' : 'xdg-open';
  try {
    execSync(`${cmd} "${path}"`, { stdio: 'ignore' });
  } catch (e) {
    // Don't fail hard — the file is rendered, that's the main thing.
    console.error(`Could not open browser automatically. Open manually: ${path}`);
    console.error(`(${(e as Error).message})`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`eval:world:view — render + open world.html

USAGE
  bun run eval:world:view             render eval/data/world-v1/world.html and open it
  bun run eval:world:view --no-open   render only (CI-friendly)
  bun run eval:world:view --dir=PATH  render from a different shard directory

OUTPUT
  eval/data/world-v1/world.html (gitignored; regenerate with this command).
`);
    return;
  }

  const dir = args.find(a => a.startsWith('--dir='))?.slice('--dir='.length) ??
    'eval/data/world-v1';
  const noOpen = args.includes('--no-open');

  const target = renderWorldHtmlToFile(dir);
  console.log(`Rendered ${target}`);

  if (!noOpen) {
    openInBrowser(target);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
