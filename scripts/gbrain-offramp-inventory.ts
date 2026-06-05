#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';

export type ListRow = {
  slug: string;
  type: string;
  updated: string;
  title: string;
};

type InventorySummary = {
  totalRows: number;
  topLevelCounts: Record<string, number>;
  typeCounts: Record<string, number>;
  sampleSlugs: string[];
};

export function parseListRow(line: string): ListRow | null {
  const parts = line.split('\t');
  if (parts.length < 4) return null;

  return {
    slug: parts[0],
    type: parts[1],
    updated: parts[2],
    title: parts.slice(3).join('\t'),
  };
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function summarizeRows(rows: ListRow[]): InventorySummary {
  const topLevelCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};

  for (const row of rows) {
    const topLevel = row.slug.split('/')[0] || '(root)';
    bump(topLevelCounts, topLevel);
    bump(typeCounts, row.type);
  }

  return {
    totalRows: rows.length,
    topLevelCounts: Object.fromEntries(Object.entries(topLevelCounts).sort()),
    typeCounts: Object.fromEntries(Object.entries(typeCounts).sort()),
    sampleSlugs: rows.slice(0, 20).map((row) => row.slug),
  };
}

export function parseListOutput(raw: string): ListRow[] {
  return raw
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
    .map(parseListRow)
    .filter((row): row is ListRow => row !== null);
}

export function collectDefaultInventory(limit = 2000): InventorySummary {
  const result = spawnSync(
    'bun',
    ['run', 'gbrain', 'list', '--limit', String(limit), '--sort', 'slug'],
    {
      cwd: process.cwd(),
      env: { ...process.env, GBRAIN_SOURCE: 'default' },
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
    },
  );

  if (result.status !== 0) {
    throw new Error(`gbrain list failed for default source:\n${result.stderr || result.stdout}`);
  }

  return summarizeRows(parseListOutput(result.stdout || ''));
}

function parseLimitArg(args: string[]): number {
  const limitFlag = args.indexOf('--limit');
  if (limitFlag === -1) return 2000;

  const raw = Number(args[limitFlag + 1] ?? '2000');
  return Number.isFinite(raw) && raw > 0 ? raw : 2000;
}

async function main(): Promise<number> {
  const summary = collectDefaultInventory(parseLimitArg(process.argv.slice(2)));
  console.log(JSON.stringify(summary, null, 2));
  return 0;
}

if (import.meta.main) {
  const code = await main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[offramp:inventory] ${message}\n`);
    return 1;
  });
  process.exit(code);
}
