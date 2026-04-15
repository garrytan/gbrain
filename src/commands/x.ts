/**
 * gbrain x — X/Twitter scraping and ingestion pipeline.
 *
 * Subcommands:
 *   gbrain x auth                        Login to X via browser, save session
 *   gbrain x fetch <url>                 Fetch a single tweet
 *   gbrain x fetch --file <path>         Batch fetch from URL list
 *   gbrain x threads --input <json>      Extract self-threads from fetched data
 *   gbrain x ingest <url>                Single URL: fetch → compile → import
 *   gbrain x ingest --file <path>        Batch: fetch → threads → compile → import
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import readline from 'readline';
import type { BrainEngine } from '../core/engine.ts';

function printUsage() {
  console.log(`Usage: gbrain x <subcommand> [options]

Subcommands:
  auth                     Login to X in a browser, save session cookies
  fetch <url>              Fetch a single tweet via GraphQL interception
  fetch --file <path>      Batch fetch tweets from a URL list file
  threads --input <json>   Extract same-author thread continuations
  ingest <url>             Full pipeline: fetch → compile → import one URL
  ingest --file <path>     Full pipeline: fetch → threads → compile → import batch

Options:
  --auth <path>            Path to auth session file (default: ~/.gbrain/x-auth.json)
  --output <path>          Write raw JSON output to file
  --dry-run                Show what would be imported without writing to brain
  --include-raw            Include raw GraphQL payloads in output`);
}

function parseArgs(args: string[]): Record<string, string | boolean> {
  const parsed: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      parsed['dry-run'] = true;
    } else if (arg === '--include-raw') {
      parsed['include-raw'] = true;
    } else if (arg.startsWith('--') && i + 1 < args.length) {
      parsed[arg.slice(2)] = args[++i];
    } else if (!arg.startsWith('--')) {
      if (!parsed['_positional']) {
        parsed['_positional'] = arg;
      }
    }
  }
  return parsed;
}

function loadUrls(fileOrUrl: string): string[] {
  if (fileOrUrl.startsWith('http')) {
    return [fileOrUrl];
  }

  const contents = readFileSync(fileOrUrl, 'utf8');
  return contents
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function resolveAuthPath(args: Record<string, string | boolean>): string {
  if (typeof args.auth === 'string') return args.auth;
  const { AUTH_PATH_DEFAULT } = require('../core/x/fetch-tweet.ts');
  return AUTH_PATH_DEFAULT;
}

async function runAuth(args: Record<string, string | boolean>) {
  const { createXBrowserSession, AUTH_PATH_DEFAULT } = await import('../core/x/fetch-tweet.ts');
  const authPath = typeof args.auth === 'string' ? args.auth : AUTH_PATH_DEFAULT;

  mkdirSync(dirname(authPath), { recursive: true });

  console.log('Launching browser for X login...');
  console.log('Log in to X in the browser window, then press Enter here.');

  const { browser, context } = await createXBrowserSession({ headless: false });
  const page = await context.newPage();
  await page.goto('https://x.com/login', {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  await new Promise<void>((resolve) => {
    rl.question('Press Enter after logging in... ', () => {
      rl.close();
      resolve();
    });
  });

  await context.storageState({ path: authPath });
  await context.close();
  await browser.close();

  console.log(`Session saved to ${authPath}`);
}

async function runFetch(args: Record<string, string | boolean>) {
  const { createXBrowserSession, fetchTweetByUrl } = await import('../core/x/fetch-tweet.ts');
  const authPath = resolveAuthPath(args);

  if (!existsSync(authPath)) {
    console.error(`No auth session found at ${authPath}. Run: gbrain x auth`);
    process.exit(1);
  }

  const source = typeof args.file === 'string'
    ? args.file
    : typeof args._positional === 'string'
      ? args._positional
      : null;

  if (!source) {
    console.error('Provide a URL or --file <path>');
    process.exit(1);
  }

  const urls = loadUrls(source);
  console.error(`Fetching ${urls.length} URL(s)...`);

  const { browser, context } = await createXBrowserSession({ storageStatePath: authPath });
  const results = [];

  for (const url of urls) {
    process.stderr.write(`[fetch] ${url}\n`);
    const result = await fetchTweetByUrl(url, {
      context,
      includeRaw: Boolean(args['include-raw']),
    });
    results.push(result);
  }

  await context.close();
  await browser.close();

  const output = JSON.stringify({ source, urls, results }, null, 2);

  if (typeof args.output === 'string') {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, output + '\n', 'utf8');
    console.error(`Wrote ${args.output}`);
  }

  // Summary to stdout
  console.log(
    JSON.stringify(
      results.map((r) => ({
        url: r.targetUrl,
        tweetId: r.tweetId,
        author: r.normalized?.author?.handle ?? null,
        textPreview: r.normalized?.text?.slice(0, 120) ?? null,
        visibleTweets: r.pageState.visibleTweets.length,
      })),
      null,
      2,
    ),
  );

  return results;
}

async function runThreads(args: Record<string, string | boolean>) {
  const { createXBrowserSession } = await import('../core/x/fetch-tweet.ts');
  const { extractSelfThreads } = await import('../core/x/extract-threads.ts');
  const authPath = resolveAuthPath(args);

  const inputPath = typeof args.input === 'string' ? args.input : null;
  if (!inputPath) {
    console.error('Provide --input <json> (output from gbrain x fetch)');
    process.exit(1);
  }

  if (!existsSync(authPath)) {
    console.error(`No auth session found at ${authPath}. Run: gbrain x auth`);
    process.exit(1);
  }

  const data = JSON.parse(readFileSync(inputPath, 'utf8'));
  const { browser, context } = await createXBrowserSession({ storageStatePath: authPath });

  const threadResults = await extractSelfThreads(data.results, context, {
    onProgress: (msg) => process.stderr.write(msg + '\n'),
  });

  await context.close();
  await browser.close();

  const output = JSON.stringify({ source: inputPath, results: threadResults }, null, 2);

  if (typeof args.output === 'string') {
    mkdirSync(dirname(args.output), { recursive: true });
    writeFileSync(args.output, output + '\n', 'utf8');
    console.error(`Wrote ${args.output}`);
  }

  console.log(
    JSON.stringify(
      threadResults.map((r) => ({
        url: r.url,
        author: r.author,
        threadLength: r.thread.length,
      })),
      null,
      2,
    ),
  );

  return threadResults;
}

async function runIngest(
  engine: BrainEngine | null,
  args: Record<string, string | boolean>,
) {
  const { createXBrowserSession, fetchTweetByUrl } = await import('../core/x/fetch-tweet.ts');
  const { extractSelfThreads } = await import('../core/x/extract-threads.ts');
  const { compileBatch, compileAuthorPage } = await import('../core/x/compile.ts');
  const { importFromContent } = await import('../core/import-file.ts');

  const authPath = resolveAuthPath(args);
  const dryRun = Boolean(args['dry-run']);

  if (!existsSync(authPath)) {
    console.error(`No auth session found at ${authPath}. Run: gbrain x auth`);
    process.exit(1);
  }

  const source = typeof args.file === 'string'
    ? args.file
    : typeof args._positional === 'string'
      ? args._positional
      : null;

  if (!source) {
    console.error('Provide a URL or --file <path>');
    process.exit(1);
  }

  const urls = loadUrls(source);
  console.error(`Ingesting ${urls.length} URL(s)...`);

  // Step 1: Fetch
  console.error('[1/4] Fetching tweets...');
  const { browser, context } = await createXBrowserSession({ storageStatePath: authPath });
  const fetchResults = [];

  for (const url of urls) {
    process.stderr.write(`  fetch: ${url}\n`);
    const result = await fetchTweetByUrl(url, { context });
    fetchResults.push(result);
  }

  // Step 2: Extract threads
  console.error('[2/4] Extracting threads...');
  const threadResults = await extractSelfThreads(fetchResults, context, {
    onProgress: (msg) => process.stderr.write(msg + '\n'),
  });

  await context.close();
  await browser.close();

  // Step 3: Compile to GBrain pages
  console.error('[3/4] Compiling pages...');
  const { pages, authors } = compileBatch(fetchResults, threadResults);

  if (dryRun) {
    console.log('Dry run — would import:');
    for (const page of pages) {
      console.log(`  ${page.slug} (by @${page.authorHandle})`);
    }
    for (const [handle] of authors) {
      console.log(`  people/${handle.toLowerCase()} (author stub)`);
    }
    return;
  }

  if (!engine) {
    console.error('No brain connection. Run gbrain init first, or use --dry-run.');
    process.exit(1);
  }

  // Step 4: Import into brain
  console.error('[4/4] Importing into brain...');
  let imported = 0;
  let skipped = 0;

  // Import author stubs (only if page doesn't exist)
  for (const [handle, info] of authors) {
    const authorSlug = `people/${handle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const existing = await engine.getPage(authorSlug);
    if (!existing) {
      const authorPage = compileAuthorPage(handle, info.name);
      const result = await importFromContent(engine, authorPage.slug, authorPage.content);
      if (result.status === 'imported') {
        process.stderr.write(`  + ${authorPage.slug} (author)\n`);
        imported++;
      }
    }
  }

  // Import tweet pages
  for (const page of pages) {
    const result = await importFromContent(engine, page.slug, page.content);
    if (result.status === 'imported') {
      process.stderr.write(`  + ${page.slug}\n`);
      imported++;
    } else if (result.status === 'skipped') {
      skipped++;
    } else {
      process.stderr.write(`  ! ${page.slug}: ${result.error}\n`);
    }

    // Create link from tweet page to author page
    if (page.authorHandle) {
      const authorSlug = `people/${page.authorHandle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
      try {
        await engine.addLink(page.slug, authorSlug, 'authored_by');
      } catch {
        // Link may already exist
      }
    }
  }

  console.log(`Done: ${imported} imported, ${skipped} skipped (unchanged)`);
}

export async function runX(engine: BrainEngine | null, args: string[]) {
  const subcommand = args[0];
  const subArgs = parseArgs(args.slice(1));

  switch (subcommand) {
    case 'auth':
      await runAuth(subArgs);
      break;
    case 'fetch':
      await runFetch(subArgs);
      break;
    case 'threads':
      await runThreads(subArgs);
      break;
    case 'ingest':
      await runIngest(engine, subArgs);
      break;
    default:
      printUsage();
      break;
  }
}
