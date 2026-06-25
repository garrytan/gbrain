import type { BrainEngine } from '../core/engine.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMarkdown } from '../core/markdown.ts';
import type { Page } from '../core/types.ts';
import {
  buildDreamQualityReceipt,
  defaultDreamQualityReceiptPath,
  readSummarySlugsFromFile,
  writeDreamQualityReceipt,
} from '../core/dream-quality.ts';

interface Args {
  summaryFile?: string;
  summarySlug?: string;
  slugs: string[];
  output?: string;
  json: boolean;
  help: boolean;
}

export async function runEvalDreamQuality(engine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  if (opts.help) {
    printHelp();
    return;
  }

  let slugs = opts.slugs;
  let summarySlug = opts.summarySlug ?? null;
  if (opts.summaryFile) {
    slugs = readSummarySlugsFromFile(opts.summaryFile);
    summarySlug = summarySlug ?? inferSummarySlug(opts.summaryFile);
  }

  if (slugs.length === 0) {
    console.error('Error: pass --summary-file <path> or at least one --slug <slug>');
    process.exit(2);
  }

  const pages = [];
  for (const slug of slugs) {
    const page = await getPageOrLocalMarkdown(engine, slug);
    if (!page) {
      console.error(`Error: dream page not found: ${slug}`);
      process.exit(1);
    }
    pages.push(page);
  }

  const receipt = buildDreamQualityReceipt({
    pages,
    summarySlug,
    source: opts.summaryFile ? 'summary' : 'slugs',
  });
  const output = opts.output ?? defaultDreamQualityReceiptPath();
  writeDreamQualityReceipt(output, receipt);

  if (opts.json) {
    console.log(JSON.stringify({ ...receipt, output }, null, 2));
  } else {
    console.log(`Dream quality: ${receipt.verdict.toUpperCase()} (${receipt.pages_passed}/${receipt.pages_scored} passed, avg=${receipt.average_score}, min=${receipt.min_score})`);
    console.log(`Promotion candidates: ${receipt.promotion_candidates}`);
    console.log(`Receipt: ${output}`);
    for (const p of receipt.promotion_queue) {
      console.log(`  - ${p.owner}: ${p.slug}`);
    }
  }

  if (receipt.verdict === 'fail') process.exit(1);
  if (receipt.verdict === 'inconclusive') process.exit(2);
}

export async function getPageOrLocalMarkdown(
  engine: Pick<BrainEngine, 'getPage'>,
  slug: string,
  cwd = process.cwd(),
): Promise<Page | null> {
  const localPage = readLocalDreamPage(slug, cwd);
  const page = await engine.getPage(slug);
  if (page && localPage) {
    return {
      ...page,
      type: localPage.type,
      title: localPage.title,
      compiled_truth: localPage.compiled_truth,
      timeline: localPage.timeline,
      frontmatter: {
        ...(page.frontmatter ?? {}),
        ...(localPage.frontmatter ?? {}),
      },
    };
  }
  if (page) return page;
  return localPage;
}

function readLocalDreamPage(slug: string, cwd = process.cwd()): Page | null {
  const localPath = join(cwd, `${slug}.md`);
  if (!existsSync(localPath)) return null;
  const parsed = parseMarkdown(readFileSync(localPath, 'utf8'));
  const now = new Date();
  return {
    id: 0,
    slug,
    type: parsed.type,
    title: parsed.title,
    compiled_truth: parsed.compiled_truth,
    timeline: parsed.timeline,
    frontmatter: parsed.frontmatter,
    created_at: now,
    updated_at: now,
    source_id: 'default',
  };
}

export function parseArgs(args: string[]): Args {
  const out: Args = { slugs: [], json: false, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--summary-file':
        out.summaryFile = next;
        i++;
        break;
      case '--summary-slug':
        out.summarySlug = next;
        i++;
        break;
      case '--slug':
        out.slugs.push(next);
        i++;
        break;
      case '--output':
        out.output = next;
        i++;
        break;
      case '--json':
        out.json = true;
        break;
      default:
        if (arg && !arg.startsWith('-')) out.slugs.push(arg);
        break;
    }
  }
  return out;
}

function inferSummarySlug(path: string): string | null {
  const m = path.match(/dream-cycle-summaries\/([^/]+)\.md$/);
  return m ? `dream-cycle-summaries/${m[1]}` : null;
}

function printHelp(): void {
  console.log(`gbrain eval dream-quality — score Dream synthesis pages and surface promotion candidates

Usage:
  gbrain eval dream-quality --summary-file dream-cycle-summaries/YYYY-MM-DD.md [--output receipt.json] [--json]
  gbrain eval dream-quality --slug wiki/originals/ideas/example --slug wiki/personal/reflections/example

What it does:
  - Scores Dream pages for useful structure, traceability, links, and non-fluff.
  - Writes a JSON receipt.
  - Surfaces "needs promotion" candidates with owning repo labels.
  - Does NOT write to Seascape Hub, Sawyer Hub, Ops, Site, or any other repo.
`);
}
