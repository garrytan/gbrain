#!/usr/bin/env bun

import path from 'node:path';
import process from 'node:process';
import { compileBookmarks } from '../src/bookmarks/compiler.ts';
import { resolveBookmarkWorkspace } from '../src/bookmarks/pipeline.ts';

const args = process.argv.slice(2);
const workspaceArgIndex = args.indexOf('--workspace');
const workspace = resolveBookmarkWorkspace(
  workspaceArgIndex >= 0 ? args[workspaceArgIndex + 1] : '.bookmarks',
);

const filteredArgs = args.filter((arg, index) => {
  if (arg === '--workspace') return false;
  if (workspaceArgIndex >= 0 && index === workspaceArgIndex + 1) return false;
  return true;
});

const sourcePath = filteredArgs[0]
  ? path.resolve(filteredArgs[0])
  : path.join(workspace.rawDir, 'x-bookmarks.json');
const sourceName = path.basename(sourcePath, path.extname(sourcePath));
const threadsPath = filteredArgs[1]
  ? path.resolve(filteredArgs[1])
  : path.join(workspace.rawDir, `${sourceName}-self-threads.json`);
const outputDir = filteredArgs[2]
  ? path.resolve(filteredArgs[2])
  : path.join(workspace.compiledDir, sourceName);

const result = await compileBookmarks({
  dataset: {
    id: sourceName,
    title: sourceName
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(' '),
    description: `Bookmarked X posts compiled for ${sourceName}.`,
    sourceType: 'x',
    sourcePath,
    threadPath: threadsPath,
  },
  outputDir,
});

console.log(JSON.stringify(result, null, 2));
