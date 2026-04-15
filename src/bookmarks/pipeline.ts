import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createXBrowserSession,
  fetchTweetByUrl,
} from '../x/fetchTweet.mjs';

export interface BookmarkWorkspace {
  rootDir: string;
  rawDir: string;
  compiledDir: string;
  authDir: string;
  storageStatePath: string;
}

export interface FetchUrlListOpts {
  inputPath?: string;
  urls?: string[];
  outputPath: string;
  storageStatePath: string;
  includeRaw?: boolean;
  onProgress?: (url: string, index: number, total: number) => void;
}

export interface ExtractSelfThreadsOpts {
  sourcePath: string;
  outputPath: string;
  storageStatePath: string;
}

export function resolveBookmarkWorkspace(rootDir: string): BookmarkWorkspace {
  const resolvedRoot = path.resolve(rootDir);
  return {
    rootDir: resolvedRoot,
    rawDir: path.join(resolvedRoot, 'raw', 'x'),
    compiledDir: path.join(resolvedRoot, 'compiled'),
    authDir: path.join(resolvedRoot, 'playwright', '.auth'),
    storageStatePath: path.join(resolvedRoot, 'playwright', '.auth', 'x.json'),
  };
}

export async function loadUrls(
  inputPath?: string,
  cliUrls: string[] = [],
): Promise<{ urls: string[]; source: string }> {
  if (inputPath) {
    const contents = await readFile(inputPath, 'utf8');
    return {
      source: inputPath,
      urls: contents
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#')),
    };
  }

  if (cliUrls.length > 0) {
    return { source: 'argv', urls: cliUrls };
  }

  throw new Error('No bookmark URLs provided. Pass --input <file> or one or more X URLs.');
}

export async function fetchXUrlListToFile(opts: FetchUrlListOpts) {
  const loaded = await loadUrls(opts.inputPath, opts.urls ?? []);
  if (loaded.urls.length === 0) {
    throw new Error('No bookmark URLs found.');
  }

  await mkdir(path.dirname(opts.outputPath), { recursive: true });

  const { browser, context } = await createXBrowserSession({
    storageStatePath: opts.storageStatePath,
  });

  const results = [];
  try {
    for (const [index, url] of loaded.urls.entries()) {
      opts.onProgress?.(url, index, loaded.urls.length);
      try {
        const result = await fetchTweetByUrl(url, {
          context,
          includeRaw: opts.includeRaw === true,
        });
        results.push(result);
      } catch (err) {
        console.warn(`[warn] Failed to fetch ${url}: ${(err as Error).message}`);
        results.push({ targetUrl: url, error: (err as Error).message });
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const payload = {
    source: loaded.source,
    urls: loaded.urls,
    results,
  };

  await writeFile(opts.outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

export async function extractSelfThreadsToFile(opts: ExtractSelfThreadsOpts) {
  const source = JSON.parse(await readFile(opts.sourcePath, 'utf8'));
  await mkdir(path.dirname(opts.outputPath), { recursive: true });

  const { browser, context } = await createXBrowserSession({
    storageStatePath: opts.storageStatePath,
  });

  const byUrlCache = new Map<string, Promise<any>>();

  const fetchCached = async (url: string) => {
    if (!byUrlCache.has(url)) {
      byUrlCache.set(
        url,
        fetchTweetByUrl(url, { context }).catch(() => null),
      );
    }

    return byUrlCache.get(url)!;
  };

  const results = [];

  try {
    for (const entry of source.results ?? []) {
      const author = entry.normalized?.author?.handle;
      const rootId = entry.tweetId;

      if (!author || !rootId) {
        results.push({
          url: entry.targetUrl,
          author,
          rootId,
          thread: [],
          notes: ['missing root author or tweet id'],
        });
        continue;
      }

      const candidateIds = [
        ...new Set(
          (entry.pageState?.visibleTweets ?? [])
            .filter(
              (tweet: any) =>
                tweet.handle === author &&
                tweet.statusId &&
                tweet.statusId !== rootId,
            )
            .map((tweet: any) => tweet.statusId),
        ),
      ];

      const rootNode = {
        id: rootId,
        url: entry.targetUrl,
        normalized: entry.normalized,
      };

      const nodes = new Map([[rootId, rootNode]]);

      for (const candidateId of candidateIds) {
        const candidateUrl = `https://x.com/${author}/status/${candidateId}`;
        const candidate = await fetchCached(candidateUrl);
        nodes.set(candidateId, {
          id: candidateId,
          url: candidateUrl,
          normalized: candidate.normalized,
        });
      }

      const reachesRoot = (id: string, seen = new Set<string>()): boolean => {
        if (id === rootId) {
          return true;
        }

        if (seen.has(id)) {
          return false;
        }

        seen.add(id);

        const node = nodes.get(id);
        const parentId = node?.normalized?.inReplyToStatusId;
        const nodeAuthor = node?.normalized?.author?.handle;

        if (!parentId || nodeAuthor !== author) {
          return false;
        }

        if (parentId === rootId) {
          return true;
        }

        if (!nodes.has(parentId)) {
          return false;
        }

        return reachesRoot(parentId, seen);
      };

      const thread = candidateIds
        .filter((candidateId) => reachesRoot(candidateId))
        .map((candidateId) => nodes.get(candidateId))
        .sort((a, b) => {
          const aDate = Date.parse(a?.normalized?.createdAt ?? '');
          const bDate = Date.parse(b?.normalized?.createdAt ?? '');
          return aDate - bDate;
        })
        .map((node) => ({
          id: node?.id,
          url: node?.url,
          inReplyToStatusId: node?.normalized?.inReplyToStatusId ?? null,
          text: node?.normalized?.text ?? null,
        }));

      results.push({
        url: entry.targetUrl,
        author,
        rootId,
        candidateIds,
        thread,
      });
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const payload = {
    source: opts.sourcePath,
    results,
  };

  await writeFile(opts.outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}
