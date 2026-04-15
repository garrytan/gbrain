#!/usr/bin/env bun

import path from 'node:path';
import process from 'node:process';
import { extractSelfThreadsToFile, resolveBookmarkWorkspace } from '../src/bookmarks/pipeline.ts';

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
const outputPath = path.join(workspace.rawDir, `${sourceName}-self-threads.json`);
const storageStatePath =
  process.env.PLAYWRIGHT_STORAGE_STATE ?? workspace.storageStatePath;

const payload = await extractSelfThreadsToFile({
  sourcePath,
  outputPath,
  storageStatePath,
});

console.log(
  JSON.stringify(
    payload.results.map((result) => ({
      url: result.url,
      author: result.author,
      rootId: result.rootId,
      candidates: result.candidateIds.length,
      threadLength: result.thread.length,
    })),
    null,
    2,
  ),
);
