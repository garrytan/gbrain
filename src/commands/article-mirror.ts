/**
 * `gbrain article-mirror` — personalized article companion to book-mirror.
 *
 * Takes one pre-extracted article text file plus optional context, submits
 * exactly one read-only subagent job, waits for the final markdown analysis,
 * and writes ONE operator-trust page at
 * `media/articles/<slug>-personalized.md`.
 *
 * Trust contract:
 * - The child subagent gets allowed_tools: ['get_page', 'search'] only.
 *   It can READ the brain, but it CANNOT call put_page or any mutating op.
 * - The child returns markdown analysis text in its final message.
 * - THIS CLI assembles the final page and writes it with a single
 *   operator-trust put_page call.
 *
 * This keeps untrusted article text outside the write path. The trust
 * narrowing happens at the tool allowlist, not at a slug-prefix rule.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { MinionQueue } from '../core/minions/queue.ts';
import { waitForCompletion, TimeoutError } from '../core/minions/wait-for-completion.ts';
import type { MinionJobInput, SubagentHandlerData } from '../core/minions/types.ts';
import { operations } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { getCliOptions } from '../core/cli-options.ts';

const COST_PER_RUN_OPUS = 0.30;
const COST_PER_RUN_SONNET = 0.06;
const DEFAULT_MAX_TURNS = 8;

interface ArticleMirrorFlags {
  articleFile?: string;
  contextFile?: string;
  slug?: string;
  title?: string;
  author?: string;
  url?: string;
  model: string;
  maxTurns: number;
  timeoutMs?: number;
  noConfirm: boolean;
  dryRun: boolean;
}

interface ArticleInput {
  fullPath: string;
  text: string;
  wordCount: number;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseFlags(args: string[]): ArticleMirrorFlags {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printHelp();
    process.exit(0);
  }

  const articleFile = parseFlag(args, '--article-file');
  const contextFile = parseFlag(args, '--context-file');
  const slug = parseFlag(args, '--slug');
  const title = parseFlag(args, '--title');
  const author = parseFlag(args, '--author');
  const url = parseFlag(args, '--url');
  const model = parseFlag(args, '--model') ?? 'claude-opus-4-7';
  const maxTurnsStr = parseFlag(args, '--max-turns');
  const timeoutMsStr = parseFlag(args, '--timeout-ms');

  return {
    articleFile,
    contextFile,
    slug,
    title,
    author,
    url,
    model,
    maxTurns: maxTurnsStr ? parseInt(maxTurnsStr, 10) : DEFAULT_MAX_TURNS,
    timeoutMs: timeoutMsStr ? parseInt(timeoutMsStr, 10) : undefined,
    noConfirm: hasFlag(args, '--no-confirm') || hasFlag(args, '--yes'),
    dryRun: hasFlag(args, '--dry-run'),
  };
}

function printHelp(): void {
  console.log(`gbrain article-mirror — personalized article mirror

USAGE
  gbrain article-mirror --article-file <path> --slug <slug> [flags]

REQUIRED
  --article-file <path>      Path to one pre-extracted article text file.
  --slug <slug>              Brain slug (kebab-case, no leading slash).
                             Output lands at media/articles/<slug>-personalized.md.

OPTIONAL
  --context-file <path>      Reader-context pack embedded in the child prompt.
  --title "<title>"         Article title for the assembled page header.
  --author "<author>"       Article author.
  --url <url>                Canonical article URL.
  --model <id>               Anthropic model id. Default: claude-opus-4-7.
  --max-turns <n>            Subagent turn budget. Default ${DEFAULT_MAX_TURNS}.
  --timeout-ms <n>           Child wall-clock timeout.
  --no-confirm / --yes       Skip the cost confirmation prompt.
  --dry-run                  Validate inputs + print plan; submit nothing.

TRUST CONTRACT
  The child subagent is read-only: allowed_tools is restricted to
  ['get_page', 'search']. It returns markdown analysis in its final
  message. THIS CLI writes the only brain artifact via operator-trust
  put_page under media/articles/<slug>-personalized.md.

EXAMPLES
  gbrain article-mirror \\
    --article-file /tmp/articles/this-piece.txt \\
    --context-file /tmp/articles/context.md \\
    --slug this-piece \\
    --title "This Piece" \\
    --author "Some Author" \\
    --url https://example.com/this-piece

  gbrain article-mirror --article-file ./article.txt --slug demo --dry-run
`);
}

function loadArticle(filePath: string): ArticleInput {
  if (!fs.existsSync(filePath)) {
    throw new Error(`--article-file not found: ${filePath}`);
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    throw new Error(`--article-file is not a file: ${filePath}`);
  }
  const text = fs.readFileSync(filePath, 'utf8');
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  if (wordCount === 0) {
    throw new Error(`--article-file is empty: ${filePath}`);
  }
  return {
    fullPath: path.resolve(filePath),
    text,
    wordCount,
  };
}

function estimateCost(model: string): number {
  return model.includes('opus') ? COST_PER_RUN_OPUS : COST_PER_RUN_SONNET;
}

async function confirmInteractive(estimateUsd: number): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    process.stderr.write(
      `gbrain article-mirror: refusing to spend ~$${estimateUsd.toFixed(2)} from a non-TTY context. ` +
      `Pass --yes to confirm.\n`
    );
    return false;
  }
  process.stderr.write(
    `\nThis will spawn 1 subagent job at ~$${estimateUsd.toFixed(2)}.\n` +
    `Continue? [y/N] `
  );
  return new Promise(resolve => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', chunk => {
      const reply = chunk.toString().trim().toLowerCase();
      resolve(reply === 'y' || reply === 'yes');
      process.stdin.pause();
    });
    process.stdin.resume();
  });
}

function buildArticlePrompt(opts: {
  articleText: string;
  articleTitle: string;
  articleAuthor?: string;
  articleUrl?: string;
  contextPack?: string;
  maxTurns: number;
}): string {
  const authorLine = opts.articleAuthor ? ` by ${opts.articleAuthor}` : '';
  const urlLine = opts.articleUrl ? `Source URL: ${opts.articleUrl}\n\n` : '';
  const contextSection = opts.contextPack
    ? `## READER CONTEXT\n\n${opts.contextPack}\n\n`
    : '## READER CONTEXT\n\n(No context pack supplied; use only what brain search can ground.)\n\n';

  return `You are analyzing one article, "${opts.articleTitle}"${authorLine}, for the user.

${urlLine}The goal is a personalized article mirror. Preserve the article's actual ideas, examples, and arguments on the left. Mirror them back to the user's actual life, projects, patterns, and words on the right.

## ARTICLE TEXT (full, do not summarize this away)

${opts.articleText}

${contextSection}## OUTPUT

Return ONLY a single markdown section in this exact shape:

\`\`\`
## ${opts.articleTitle}

### Core Thesis
[2-4 sentences on what the article is really arguing.]

| What the Article Says | How This Applies to You |
|---|---|
| [Detailed paragraph preserving a concrete idea, example, framework, or tension from the article. Use \`<br><br>\` for paragraph breaks inside the cell.] | [Specific personal connection grounded in the reader context. Name projects, people, dates, quotes, or recurring patterns when real evidence supports it. Same \`<br><br>\` rule.] |
| [Next section] | [Next mirror] |
| [4-8 rows total depending on article density] |  |

### Questions Worth Keeping
- [One question the article raises for this user.]
- [One more if warranted.]
\`\`\`

## RULES

- LEFT column: keep the article's texture. Preserve named examples, frameworks, counterarguments, and stakes.
- RIGHT column: be specific. Use the user's actual words or grounded brain context when possible.
- If a section is weakly relevant, say why plainly instead of forcing it.
- Never generic. Never preachy. Never write as if the article already changed the user's life.
- Use \`<br><br>\` for paragraph breaks inside table cells, not literal newlines.

You have ${opts.maxTurns} turns and read-only tools (get_page, search). You CANNOT call put_page. Your output is the markdown text in your final message. The CLI assembles the page and writes the only artifact.

When done, your final message should contain ONLY the \`## ${opts.articleTitle}\` section above. No preamble, no commentary, no postscript.`;
}

function buildAssembledPage(opts: {
  slug: string;
  title: string;
  author?: string;
  url?: string;
  contextPack?: string;
  result: string;
}): string {
  const today = new Date().toISOString().split('T')[0];
  const authorLine = opts.author ? `\nauthor: "${opts.author.replace(/"/g, '\\"')}"` : '';
  const urlLine = opts.url ? `\nsource_url: "${opts.url.replace(/"/g, '\\"')}"` : '';
  const contextSummary = opts.contextPack
    ? opts.contextPack.split('\n').slice(0, 3).join(' ').slice(0, 200)
    : 'No reader-context pack supplied.';

  const frontmatter = `---
title: "${opts.title.replace(/"/g, '\\"')} — Personalized"
type: article-analysis${authorLine}${urlLine}
date: ${today}
context: "${contextSummary.replace(/"/g, '\\"')}"
tags: [article, personalized, mirror]
---`;

  const intro = `# ${opts.title} — Personalized

## What this is

A personalized mirror of *${opts.title}*${opts.author ? ` by ${opts.author}` : ''}. The article's actual ideas stay intact on the left, while the right side maps them back to the reader's real life using grounded brain context.

This page was generated by \`gbrain article-mirror\`. The analysis came from one read-only subagent with access to the article text and reader context but no write tools. This page is the only brain artifact written.

`;

  return `${frontmatter}\n\n${intro}${opts.result.trim()}\n`;
}

export async function runArticleMirrorCmd(engine: BrainEngine, args: string[]): Promise<void> {
  const flags = parseFlags(args);

  if (!flags.articleFile) {
    console.error('gbrain article-mirror: --article-file is required. Run with --help.');
    process.exit(2);
  }
  if (!flags.slug) {
    console.error('gbrain article-mirror: --slug is required. Run with --help.');
    process.exit(2);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(flags.slug)) {
    console.error(`gbrain article-mirror: invalid --slug "${flags.slug}". Use kebab-case (a-z, 0-9, hyphens).`);
    process.exit(2);
  }
  if (flags.contextFile && !fs.existsSync(flags.contextFile)) {
    console.error(`gbrain article-mirror: --context-file not found: ${flags.contextFile}`);
    process.exit(2);
  }

  let article: ArticleInput;
  try {
    article = loadArticle(flags.articleFile);
  } catch (e) {
    console.error(`gbrain article-mirror: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const contextPack = flags.contextFile ? fs.readFileSync(flags.contextFile, 'utf8') : undefined;
  const articleTitle = flags.title ?? flags.slug;
  const targetSlug = `media/articles/${flags.slug}-personalized`;

  process.stderr.write(
    `\ngbrain article-mirror — plan\n` +
    `  slug:        ${flags.slug}\n` +
    `  output:      ${targetSlug}\n` +
    `  article:     ${article.fullPath}\n` +
    `  words:       ${article.wordCount}\n` +
    `  context:     ${flags.contextFile ?? '(none)'}\n` +
    `  model:       ${flags.model}\n` +
    `  max_turns:   ${flags.maxTurns}\n`
  );

  const estimateUsd = estimateCost(flags.model);
  process.stderr.write(`  est. cost:   ~$${estimateUsd.toFixed(2)} (1 subagent)\n\n`);

  if (flags.dryRun) {
    process.stderr.write('gbrain article-mirror: --dry-run — exiting without submission.\n');
    return;
  }

  if (!flags.noConfirm) {
    const ok = await confirmInteractive(estimateUsd);
    if (!ok) {
      process.stderr.write('gbrain article-mirror: cancelled by user.\n');
      process.exit(0);
    }
  }

  const queue = new MinionQueue(engine);
  const data: SubagentHandlerData = {
    prompt: buildArticlePrompt({
      articleText: article.text,
      articleTitle,
      articleAuthor: flags.author,
      articleUrl: flags.url,
      contextPack,
      maxTurns: flags.maxTurns,
    }),
    model: flags.model,
    max_turns: flags.maxTurns,
    allowed_tools: ['get_page', 'search'],
  };
  const submitOpts: Partial<MinionJobInput> = {
    max_stalled: 3,
    idempotency_key: `article-mirror:${flags.slug}`,
  };
  if (flags.timeoutMs) submitOpts.timeout_ms = flags.timeoutMs;

  const job = await queue.add(
    'subagent',
    data as unknown as Record<string, unknown>,
    submitOpts,
    { allowProtectedSubmit: true },
  );

  process.stderr.write(`submitted: 1 subagent job (${job.id})\n`);
  process.stderr.write('waiting for article analysis to complete...\n');

  let result = '';
  try {
    const completedJob = await waitForCompletion(queue, job.id, {
      timeoutMs: flags.timeoutMs ?? 30 * 60 * 1000,
      pollMs: 1000,
    });
    if (completedJob.status !== 'completed' || !completedJob.result || typeof completedJob.result !== 'object') {
      console.error(`gbrain article-mirror: job ${job.id} finished with status=${completedJob.status}. Not writing the brain page.`);
      process.exit(1);
    }
    result = (completedJob.result as { result?: string }).result ?? '';
    if (!result.trim()) {
      console.error(`gbrain article-mirror: job ${job.id} returned no final analysis. Not writing the brain page.`);
      process.exit(1);
    }
  } catch (e) {
    const msg = e instanceof TimeoutError
      ? `timeout after ${e.elapsedMs}ms`
      : (e instanceof Error ? e.message : String(e));
    console.error(`gbrain article-mirror: ${msg}. Not writing the brain page.`);
    process.exit(1);
  }

  const assembled = buildAssembledPage({
    slug: flags.slug,
    title: articleTitle,
    author: flags.author,
    url: flags.url,
    contextPack,
    result,
  });

  const putPageOp = operations.find(op => op.name === 'put_page');
  if (!putPageOp) {
    throw new Error('internal: put_page operation not registered');
  }

  await putPageOp.handler(
    {
      engine,
      config: loadConfig() || { engine: 'postgres' },
      logger: { info: console.log, warn: console.warn, error: console.error },
      dryRun: false,
      remote: false,             // local CLI caller — operator trust path
      cliOpts: getCliOptions(),
      sourceId: 'default',
      // viaSubagent intentionally omitted — operator trust path.
      // allowedSlugPrefixes intentionally omitted — operator can write anywhere.
    },
    {
      slug: targetSlug,
      content: assembled,
    },
  );

  process.stderr.write(`\nwrote: ${targetSlug} (${article.wordCount} words in, ${assembled.length} bytes out)\n`);
  process.stdout.write(JSON.stringify({
    slug: targetSlug,
    article_words: article.wordCount,
    model: flags.model,
  }) + '\n');
}
