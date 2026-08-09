/**
 * A remote list_pages request is capped at 100 rows to protect the MCP
 * transport. The thin-client CLI is a trusted local consumer, so it can page
 * through that bounded API and render one complete list without weakening the
 * server-side cap.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const REMOTE_LIST_PAGE_SIZE = 100;
export const REMOTE_LIST_MAX_PAGES = 10_000;
export const REMOTE_LIST_MAX_DURATION_MS = 30 * 60 * 1000;

type PageFetcher = (params: Record<string, unknown>) => Promise<unknown>;
type PageFormatter = (page: unknown[]) => string;
type OutputPublisher = (chunk: string) => Promise<void>;

export type ThinClientPaginationOptions = {
  deadlineAt?: number;
  maxPages?: number;
  stabilityAttempts?: number;
};

function asAggregateLimit(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= REMOTE_LIST_PAGE_SIZE) {
    return null;
  }
  return Math.floor(value);
}

function needsMultipleRequests(params: Record<string, unknown>): boolean {
  return (params.limit === undefined && params.offset === undefined)
    || asAggregateLimit(params.limit) !== null;
}

function pageFingerprint(hash: ReturnType<typeof createHash>, page: unknown[]): void {
  const serialized = JSON.stringify(page);
  hash.update(String(serialized.length));
  hash.update(':');
  hash.update(serialized);
}

/**
 * Collect the complete result for a bare remote list, or honor an explicit
 * limit above the per-request cap by issuing multiple offset pages. Explicit
 * offsets and limits at or below the cap preserve the single-request API.
 */
export async function collectThinClientListPages(
  params: Record<string, unknown>,
  fetchPage: PageFetcher,
): Promise<unknown[]> {
  const pages: unknown[] = [];
  for await (const page of paginateThinClientListPages(params, fetchPage)) {
    pages.push(...page);
  }
  return pages;
}

/**
 * Yield bounded remote pages as they arrive. The CLI consumes this iterator
 * directly so a complete bare list does not retain both the full object array
 * and a second fully formatted output string in memory.
 */
export async function* paginateThinClientListPages(
  params: Record<string, unknown>,
  fetchPage: PageFetcher,
  options: ThinClientPaginationOptions = {},
): AsyncGenerator<unknown[]> {
  const deadlineAt = options.deadlineAt ?? Date.now() + REMOTE_LIST_MAX_DURATION_MS;
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? REMOTE_LIST_MAX_PAGES));
  let pageCount = 0;
  const assertWithinBudget = () => {
    if (Date.now() >= deadlineAt) {
      throw new Error('Remote list_pages exceeded the whole-command pagination deadline.');
    }
    if (pageCount >= maxPages) {
      throw new Error(`Remote list_pages exceeded the ${maxPages}-page safety limit.`);
    }
    pageCount++;
  };

  const isBareList = params.limit === undefined && params.offset === undefined;
  const aggregateLimit = asAggregateLimit(params.limit);
  if (!isBareList && aggregateLimit === null) {
    assertWithinBudget();
    const result = await fetchPage(params);
    if (Date.now() >= deadlineAt) {
      throw new Error('Remote list_pages exceeded the whole-command pagination deadline.');
    }
    if (!Array.isArray(result)) throw new Error('Remote list_pages response was not an array.');
    yield result;
    return;
  }

  const target = aggregateLimit ?? Number.POSITIVE_INFINITY;
  let produced = 0;
  let previousFullPageSignature: string | undefined;
  const requestedOffset = typeof params.offset === 'number' && Number.isFinite(params.offset) && params.offset > 0
    ? Math.floor(params.offset)
    : 0;
  let offset = requestedOffset;

  while (produced < target) {
    assertWithinBudget();
    const requestLimit = Math.min(REMOTE_LIST_PAGE_SIZE, target - produced);
    const result = await fetchPage({
      ...params,
      limit: requestLimit,
      offset,
    });
    if (Date.now() >= deadlineAt) {
      throw new Error('Remote list_pages exceeded the whole-command pagination deadline.');
    }
    if (!Array.isArray(result)) throw new Error('Remote list_pages response was not an array.');

    if (result.length > requestLimit) {
      throw new Error(`Remote list_pages returned ${result.length} rows for limit ${requestLimit}.`);
    }
    if (result.length === requestLimit) {
      // Defense against an older/broken server silently ignoring offset. A
      // repeated full page would otherwise make a bare list loop forever.
      const signature = JSON.stringify(result);
      if (signature === previousFullPageSignature) {
        throw new Error('Remote list_pages repeated a page while paginating; the server may be ignoring offset.');
      }
      previousFullPageSignature = signature;
    }

    yield result;
    produced += result.length;
    if (result.length < requestLimit) break;
    offset += result.length;
  }
}

/**
 * Render remote pages to a private spool, verify that a second pass sees the
 * same ordered rows, then publish the file. Concurrent writes therefore
 * either settle to one stable view or fail without leaving partial stdout.
 */
export async function publishThinClientListPagesAtomically(
  params: Record<string, unknown>,
  fetchPage: PageFetcher,
  formatPage: PageFormatter,
  publish: OutputPublisher,
  options: ThinClientPaginationOptions = {},
): Promise<void> {
  const scratchDir = await mkdtemp(join(tmpdir(), 'gbrain-list-'));
  const outputPath = join(scratchDir, 'output');
  const sharedOptions: ThinClientPaginationOptions = {
    ...options,
    deadlineAt: options.deadlineAt ?? Date.now() + REMOTE_LIST_MAX_DURATION_MS,
  };
  const stabilityAttempts = Math.max(1, Math.floor(options.stabilityAttempts ?? 2));

  const spoolPass = async (): Promise<string> => {
    const hash = createHash('sha256');
    const output = await open(outputPath, 'w');
    let wroteRows = false;
    try {
      for await (const page of paginateThinClientListPages(params, fetchPage, sharedOptions)) {
        pageFingerprint(hash, page);
        if (page.length === 0) continue;
        await output.writeFile(formatPage(page));
        wroteRows = true;
      }
      if (!wroteRows) await output.writeFile(formatPage([]));
    } finally {
      await output.close();
    }
    return hash.digest('hex');
  };

  const fingerprintPass = async (): Promise<string> => {
    const hash = createHash('sha256');
    for await (const page of paginateThinClientListPages(params, fetchPage, sharedOptions)) {
      pageFingerprint(hash, page);
    }
    return hash.digest('hex');
  };

  try {
    let stable = false;
    for (let attempt = 1; attempt <= stabilityAttempts; attempt++) {
      const renderedFingerprint = await spoolPass();
      if (!needsMultipleRequests(params) || renderedFingerprint === await fingerprintPass()) {
        stable = true;
        break;
      }
    }
    if (!stable) {
      throw new Error('Remote list_pages changed while paginating; retry when writes have settled.');
    }

    for await (const chunk of createReadStream(outputPath, { encoding: 'utf8' })) {
      await publish(chunk);
    }
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}
