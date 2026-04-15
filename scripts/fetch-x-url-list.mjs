#!/usr/bin/env bun

import path from 'node:path';
import process from 'node:process';
import { fetchXUrlListToFile, resolveBookmarkWorkspace } from '../src/bookmarks/pipeline.ts';

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

const inputPath = filteredArgs[0] && !filteredArgs[0].startsWith('http')
  ? path.resolve(filteredArgs[0])
  : undefined;
const urls = filteredArgs.filter((arg) => arg.startsWith('http'));
const sourceName = inputPath
  ? path.basename(inputPath, path.extname(inputPath))
  : 'x-url-list';
const outputPath = path.join(workspace.rawDir, `${sourceName}.json`);
const storageStatePath =
  process.env.PLAYWRIGHT_STORAGE_STATE ?? workspace.storageStatePath;

const payload = await fetchXUrlListToFile({
  inputPath,
  urls,
  outputPath,
  storageStatePath,
  includeRaw: process.env.INCLUDE_RAW === '1',
  onProgress: (url, index, total) => {
    process.stderr.write(`[fetch ${index + 1}/${total}] ${url}\n`);
  },
});

console.log(
  JSON.stringify(
    payload.results.map((result) => ({
      url: result.targetUrl,
      tweetId: result.tweetId,
      author: result.normalized?.author?.handle ?? null,
      textPreview: result.normalized?.text?.slice(0, 120) ?? null,
      requiresAuthForReplies: result.pageState.hasLoggedOutReadRepliesPivot,
      visibleTweets: result.pageState.visibleTweets.length,
    })),
    null,
    2,
  ),
);
