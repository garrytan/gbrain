/**
 * Same-author thread continuation extractor.
 *
 * Ported from personal-knowledge-base/scripts/extract-self-threads.mjs.
 * For each root tweet, finds same-author replies that trace back to the root
 * through the inReplyToStatusId chain.
 */

import type { BrowserContext } from 'playwright';
import { fetchTweetByUrl } from './fetch-tweet.ts';
import type { FetchTweetResult, ThreadResult, ThreadReply } from './types.ts';

interface ThreadNode {
  id: string;
  url: string;
  normalized: FetchTweetResult['normalized'];
}

export async function extractSelfThreads(
  results: FetchTweetResult[],
  context: BrowserContext,
  opts: { onProgress?: (msg: string) => void } = {},
): Promise<ThreadResult[]> {
  const fetchCache = new Map<string, Promise<FetchTweetResult>>();

  const fetchCached = (url: string): Promise<FetchTweetResult> => {
    if (!fetchCache.has(url)) {
      fetchCache.set(url, fetchTweetByUrl(url, { context }));
    }
    return fetchCache.get(url)!;
  };

  const threadResults: ThreadResult[] = [];

  for (const entry of results) {
    const author = entry.normalized?.author?.handle ?? null;
    const rootId = entry.tweetId;

    if (!author || !rootId) {
      threadResults.push({
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
            (tweet) =>
              tweet.handle === author &&
              tweet.statusId &&
              tweet.statusId !== rootId,
          )
          .map((tweet) => tweet.statusId!),
      ),
    ];

    const rootNode: ThreadNode = {
      id: rootId,
      url: entry.targetUrl,
      normalized: entry.normalized,
    };

    const nodes = new Map<string, ThreadNode>([[rootId, rootNode]]);

    for (const candidateId of candidateIds) {
      const candidateUrl = `https://x.com/${author}/status/${candidateId}`;
      opts.onProgress?.(`  thread: fetching ${candidateUrl}`);
      const candidate = await fetchCached(candidateUrl);
      nodes.set(candidateId, {
        id: candidateId,
        url: candidateUrl,
        normalized: candidate.normalized,
      });
    }

    const reachesRoot = (id: string, seen = new Set<string>()): boolean => {
      if (id === rootId) return true;
      if (seen.has(id)) return false;
      seen.add(id);

      const node = nodes.get(id);
      const parentId = node?.normalized?.inReplyToStatusId;
      const nodeAuthor = node?.normalized?.author?.handle;

      if (!parentId || nodeAuthor !== author) return false;
      if (parentId === rootId) return true;
      if (!nodes.has(parentId)) return false;

      return reachesRoot(parentId, seen);
    };

    const thread: ThreadReply[] = candidateIds
      .filter((candidateId) => reachesRoot(candidateId))
      .map((candidateId) => nodes.get(candidateId)!)
      .sort((a, b) => {
        const aDate = Date.parse(a.normalized?.createdAt ?? '');
        const bDate = Date.parse(b.normalized?.createdAt ?? '');
        return aDate - bDate;
      })
      .map((node) => ({
        id: node.id,
        url: node.url,
        inReplyToStatusId: node.normalized?.inReplyToStatusId ?? null,
        text: node.normalized?.text ?? null,
      }));

    threadResults.push({
      url: entry.targetUrl,
      author,
      rootId,
      candidateIds,
      thread,
    });
  }

  return threadResults;
}
