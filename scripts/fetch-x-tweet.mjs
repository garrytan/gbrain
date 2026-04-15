#!/usr/bin/env bun

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  createXBrowserSession,
  fetchTweetByUrl,
  parseTweetIdFromUrl,
} from '../src/x/fetchTweet.mjs';

const targetUrl =
  process.argv[2] ?? 'https://x.com/karpathy/status/2039805659525644595';
const workspace = path.resolve(process.argv[3] ?? '.bookmarks');
const outputDir = path.join(workspace, 'raw', 'x');
const storageStatePath =
  process.env.PLAYWRIGHT_STORAGE_STATE ??
  path.join(workspace, 'playwright', '.auth', 'x.json');

await mkdir(outputDir, { recursive: true });

const { browser, context } = await createXBrowserSession({
  storageStatePath,
});

const result = await fetchTweetByUrl(targetUrl, {
  context,
  includeRaw: process.env.INCLUDE_RAW === '1',
});

const tweetId = parseTweetIdFromUrl(targetUrl) ?? 'unknown';

await writeFile(
  path.join(outputDir, `tweet-${tweetId}.json`),
  `${JSON.stringify(result, null, 2)}\n`,
  'utf8',
);

console.log(JSON.stringify(result, null, 2));

await context.close();
await browser.close();
