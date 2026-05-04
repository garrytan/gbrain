/**
 * `gbrain book-mirror` — flagship of the v0.25.1 skills wave.
 *
 * Takes pre-extracted chapter text + context, fans out N read-only Opus
 * subagents (one per chapter), waits for all to complete, assembles the
 * two-column personalized analysis, and writes ONE put_page under
 * `media/books/<slug>-personalized.md` using the operator-trust path.
 *
 * Trust contract (D2/α + codex HIGH-1 fix):
 * - Subagents have allowed_tools: ['get_page', 'search'] only — they
 *   can READ the brain, but they CANNOT call put_page. They produce
 *   markdown analysis text via their final_message; the CLI reads
 *   job.result and assembles the final page itself.
 * - The CLI calls put_page once at the end with operator-level trust
 *   (no viaSubagent flag), so the subagent namespace check doesn't
 *   apply. Untrusted EPUB content cannot prompt-inject any people/*
 *   page because subagents lack write access entirely.
 *
 * The skill (skills/book-mirror/SKILL.md) handles EPUB/PDF extraction
 * via the agent's shell + python access (BeautifulSoup4, pdftotext) and
 * invokes this CLI with --chapters-dir pointing at the extracted text.
 * Separation of concerns: skill prepares inputs, CLI is the trusted
 * runtime.
 *
 * Cost: a 20-chapter book at Opus pricing is ~$6/run. The CLI prints an
 * estimate before launching and prompts for confirmation unless
 * --no-confirm is passed.
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

const COST_PER_CHAPTER_OPUS = 0.30;     // rough; depends on chapter length
const COST_PER_CHAPTER_SONNET = 0.06;
const DEFAULT_MAX_TURNS = 10;
const DEFAULT_WORKERS = 4;              // queue concurrency hint; rate-leases enforce real cap

interface BookMirrorFlags {
  chaptersDir?: string;
  contextFile?: string;
  slug?: string;
  title?: string;
  author?: string;
  model: string;
  maxTurns: number;
  timeoutMs?: number;
  noConfirm: boolean;
  follow: boolean;
  dryRun: boolean;
}

interface ChapterEntry {
  index: number;
  filename: string;
  fullPath: string;
  text: string;
  wordCount: number;
}

// ── arg parsing ────────────────────────────────────────────

function parseFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parseFlags(args: string[]): BookMirrorFlags {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    printHelp();
    process.exit(0);
  }

  const chaptersDir = parseFlag(args, '--chapters-dir');
  const contextFile = parseFlag(args, '--context-file');
  const slug = parseFlag(args, '--slug');
  const title = parseFlag(args, '--title');
  const author = parseFlag(args, '--author');
  const model = parseFlag(args, '--model') ?? 'claude-opus-4-7';
  const maxTurnsStr = parseFlag(args, '--max-turns');
  const timeoutMsStr = parseFlag(args, '--timeout-ms');

  return {
    chaptersDir,
    contextFile,
    slug,
    title,
    author,
    model,
    maxTurns: maxTurnsStr ? parseInt(maxTurnsStr, 10) : DEFAULT_MAX_TURNS,
    timeoutMs: timeoutMsStr ? parseInt(timeoutMsStr, 10) : undefined,
    noConfirm: hasFlag(args, '--no-confirm') || hasFlag(args, '--yes'),
    follow: process.stdout.isTTY === true && !hasFlag(args, '--no-follow'),
    dryRun: hasFlag(args, '--dry-run'),
  };
}

function printHelp(): void {
  console.log(`gbrain book-mirror — personalized chapter-by-chapter book analysis

USAGE
  gbrain book-mirror --chapters-dir <path> --slug <slug> [flags]

REQUIRED
  --chapters-dir <path>     Directory containing chapter text files (.txt).
                            Files sort alphabetically; chapter order = sort order.
                            The skill (skills/book-mirror/SKILL.md) handles EPUB
                            and PDF extraction; this CLI takes pre-extracted
                            chapter text as its input contract.
  --slug <slug>             Brain page slug (kebab-case, no leading slash).
                            Output lands at media/books/<slug>-personalized.md.

OPTIONAL
  --context-file <path>     Path to a context pack (USER.md + SOUL.md + memory
                            excerpts + entity searches). Embedded in every
                            child subagent's prompt. The skill prepares this.
  --title "<title>"         Book title (used in the assembled page header).
                            Defaults to slug if omitted.
  --author "<author>"       Book author (used in frontmatter + page header).
  --model <id>              Anthropic model id for chapter analysis.
                            Default: claude-opus-4-7. Sonnet works but the
                            right-column quality drops.
  --max-turns <n>           Per-chapter subagent turn budget. Default ${DEFAULT_MAX_TURNS}.
  --timeout-ms <n>          Per-chapter wall-clock timeout.
  --no-confirm / --yes      Skip the cost-estimate confirmation prompt.
  --no-follow               Submit and exit; don't tail children.
  --dry-run                 Validate inputs + print plan; submit nothing.

TRUST CONTRACT (read this)
  Each chapter is analyzed by a separate subagent with allowed_tools
  restricted to ['get_page', 'search'] — read-only. Subagents return
  markdown analysis text in their final message. THIS CLI assembles all
  child outputs and writes one put_page under media/books/<slug>-personalized.md
  with operator trust. Subagents NEVER call put_page; untrusted book
  content cannot prompt-inject any people/* page.

  See src/commands/book-mirror.ts top-of-file comment for the full
  rationale (codex HIGH-1 fix vs the v0.25.1 plan's earlier draft).

COST
  ~\$${COST_PER_CHAPTER_OPUS.toFixed(2)} per chapter at Opus, ~\$${COST_PER_CHAPTER_SONNET.toFixed(2)} at Sonnet. A 20-chapter book
  is ~\$${(20 * COST_PER_CHAPTER_OPUS).toFixed(2)} at Opus. The CLI prints an estimate before launching.

EXAMPLES
  # After the skill extracts chapters to /tmp/books/<slug>/chapters/:
  gbrain book-mirror \\
    --chapters-dir /tmp/books/this-book/chapters \\
    --context-file /tmp/books/this-book/context.md \\
    --slug this-book \\
    --title "This Book Title" \\
    --author "Some Author"

  # Dry run (no subagent submission, just plan):
  gbrain book-mirror --chapters-dir ./chapters --slug test --dry-run
`);
}

// ── chapter loading ────────────────────────────────────────

function loadChapters(dir: string): ChapterEntry[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`--chapters-dir not found: ${dir}`);
  }
  const stat = fs.statSync(dir);
  if (!stat.isDirectory()) {
    throw new Error(`--chapters-dir is not a directory: ${dir}`);
  }
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.txt'))
    .sort();
  if (files.length === 0) {
    throw new Error(`No .txt files in --chapters-dir: ${dir}`);
  }
  const chapters: ChapterEntry[] = [];
  for (let i = 0; i < files.length; i++) {
    const filename = files[i]!;
    const fullPath = path.join(dir, filename);
    const text = fs.readFileSync(fullPath, 'utf8');
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    chapters.push({
      index: i + 1,
      filename,
      fullPath,
      text,
      wordCount,
    });
  }
  return chapters;
}

// ── cost confirm ───────────────────────────────────────────

function estimateCost(chapters: ChapterEntry[], model: string): number {
  const perChapter = model.includes('opus') ? COST_PER_CHAPTER_OPUS : COST_PER_CHAPTER_SONNET;
  return chapters.length * perChapter;
}

async function confirmInteractive(estimateUsd: number, chapters: number): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    // Non-TTY: refuse to spend without an explicit --yes / --no-confirm.
    process.stderr.write(
      `gbrain book-mirror: refusing to spend ~$${estimateUsd.toFixed(2)} on ${chapters} chapters from a non-TTY context. ` +
      `Pass --yes to confirm.\n`
    );
    return false;
  }
  process.stderr.write(
    `\nThis will spawn ${chapters} subagent jobs at ~$${(estimateUsd / chapters).toFixed(2)} each = ~$${estimateUsd.toFixed(2)} total.\n` +
    `Continue? [y/N] `
  );
  return new Promise(resolve => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => {
      const reply = chunk.toString().trim().toLowerCase();
      resolve(reply === 'y' || reply === 'yes');
      process.stdin.pause();
    });
    process.stdin.resume();
  });
}

// ── prompt assembly ────────────────────────────────────────

function buildChapterPrompt(
  chapter: ChapterEntry,
  totalChapters: number,
  bookTitle: string,
  bookAuthor: string | undefined,
  contextPack: string | undefined,
): string {
  const authorLine = bookAuthor ? ` by ${bookAuthor}` : '';
  const contextSection = contextPack
    ? `\n\n## READER CONTEXT\n\n${contextPack}\n\n`
    : '\n\n## READER CONTEXT\n\n(No context pack supplied; right column will be limited to brain-search-discoverable content.)\n\n';

  return `You are analyzing one chapter of "${bookTitle}"${authorLine} for the user.

Your output is a markdown two-column table where the LEFT column preserves the chapter's actual content (stories, frameworks, statistics, named examples) and the RIGHT column maps each idea to the user's actual life using their words, situations, and patterns from the brain.

This is chapter ${chapter.index} of ${totalChapters}.

## CHAPTER ${chapter.index} TEXT (full, do not summarize this away)

${chapter.text}
${contextSection}

## OUTPUT

Return ONLY a single markdown section in this exact shape:

\`\`\`
## Chapter ${chapter.index}: [Title from the chapter — extract or infer]

### Key Ideas
[2-4 sentence thesis of the chapter — what the author is actually arguing.]

| What the Author Says | How This Applies to You |
|---|---|
| [Detailed paragraph: a section/argument from the chapter, preserving stories, stats, frameworks, named examples. Use \`<br><br>\` for paragraph breaks within the cell.] | [Specific personal connection: name dates, people, exact quotes from the user, real situations. Same \`<br><br>\` for breaks.] |
| [Next section] | [Next mirror] |
| [4-10 rows depending on chapter density] |  |
\`\`\`

## RULES

- LEFT column: preserve stories, stats, frameworks. Don't summarize away the texture.
- RIGHT column: use the user's actual words from READER CONTEXT. Name specific people, dates, situations. Read like a therapist who knows them.
- 4-10 rows per chapter. If a section honestly doesn't apply, write \`*This section is less directly relevant because [specific reason].*\` Don't force connections.
- Never generic ("This might apply if you've ever felt..."). Never sycophantic. Never preach.
- Use \`<br><br>\` for paragraph breaks inside table cells, not literal newlines.

You have ${DEFAULT_MAX_TURNS} turns and read-only tools (get_page, search). You CANNOT call put_page — your output is the markdown text in your final message. The CLI assembles all chapters and writes the brain page.

When done, your final message should contain ONLY the \`## Chapter ${chapter.index}: ...\` section above. No preamble, no postscript, no commentary.`;
}

function buildAssembledPage(opts: {
  slug: string;
  title: string;
  author: string | undefined;
  contextPack: string | undefined;
  chapterAnalyses: Array<{ index: number; result: string; failed: boolean; error?: string }>;
}): string {
  const today = new Date().toISOString().split('T')[0];
  const authorLine = opts.author ? `\nauthor: "${opts.author}"` : '';
  const contextSummary = opts.contextPack
    ? opts.contextPack.split('\n').slice(0, 3).join(' ').slice(0, 200)
    : 'No reader-context pack supplied.';

  const frontmatter = `---
title: "${opts.title} — Personalized"
type: book-analysis${authorLine}
date: ${today}
context: "${contextSummary.replace(/"/g, '\\"')}"
tags: [book, personalized, two-column]
---`;

  const intro = `# ${opts.title} — Personalized

## What this is

A chapter-by-chapter personalized analysis of *${opts.title}*${opts.author ? ` by ${opts.author}` : ''}. Each chapter is summarized in detail on the left and mirrored to the reader's actual life on the right, drawing on brain context.

This page was generated by \`gbrain book-mirror\`. Each chapter analysis came from a separate read-only subagent that had access to the chapter text and a reader-context pack but no write tools — so the brain wasn't modified during the per-chapter analysis. This page is the only artifact written.

`;

  const failedSection = opts.chapterAnalyses
    .filter(a => a.failed)
    .map(a => `> Chapter ${a.index}: analysis failed (${a.error ?? 'unknown error'}). Re-run \`gbrain book-mirror\` to retry; idempotent on the same inputs.`)
    .join('\n\n');

  const failedHeader = failedSection
    ? `\n\n## Failed chapters (${opts.chapterAnalyses.filter(a => a.failed).length})\n\n${failedSection}\n\n---\n`
    : '';

  const completed = opts.chapterAnalyses
    .filter(a => !a.failed)
    .sort((a, b) => a.index - b.index)
    .map(a => a.result.trim())
    .join('\n\n---\n\n');

  return `${frontmatter}\n\n${intro}${failedHeader}\n${completed}\n`;
}

// ── main entry ─────────────────────────────────────────────

export async function runBookMirrorCmd(engine: BrainEngine, args: string[]): Promise<void> {
  const flags = parseFlags(args);

  if (!flags.chaptersDir) {
    console.error('gbrain book-mirror: --chapters-dir is required. Run with --help.');
    process.exit(2);
  }
  if (!flags.slug) {
    console.error('gbrain book-mirror: --slug is required. Run with --help.');
    process.exit(2);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(flags.slug)) {
    console.error(`gbrain book-mirror: invalid --slug "${flags.slug}". Use kebab-case (a-z, 0-9, hyphens).`);
    process.exit(2);
  }
  if (flags.contextFile && !fs.existsSync(flags.contextFile)) {
    console.error(`gbrain book-mirror: --context-file not found: ${flags.contextFile}`);
    process.exit(2);
  }

  // Load chapter files.
  let chapters: ChapterEntry[];
  try {
    chapters = loadChapters(flags.chaptersDir);
  } catch (e) {
    console.error(`gbrain book-mirror: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const contextPack = flags.contextFile ? fs.readFileSync(flags.contextFile, 'utf8') : undefined;
  const bookTitle = flags.title ?? flags.slug;
  const targetSlug = `media/books/${flags.slug}-personalized`;

  process.stderr.write(
    `\ngbrain book-mirror — plan\n` +
    `  slug:        ${flags.slug}\n` +
    `  output:      ${targetSlug}\n` +
    `  chapters:    ${chapters.length} (from ${flags.chaptersDir})\n` +
    `  context:     ${flags.contextFile ?? '(none)'}\n` +
    `  model:       ${flags.model}\n` +
    `  max_turns:   ${flags.maxTurns}\n`
  );

  const estimateUsd = estimateCost(chapters, flags.model);
  process.stderr.write(`  est. cost:   ~$${estimateUsd.toFixed(2)} (${chapters.length} subagents)\n\n`);

  if (flags.dryRun) {
    process.stderr.write(`gbrain book-mirror: --dry-run — exiting without submission.\n`);
    return;
  }

  if (!flags.noConfirm) {
    const ok = await confirmInteractive(estimateUsd, chapters.length);
    if (!ok) {
      process.stderr.write(`gbrain book-mirror: cancelled by user.\n`);
      process.exit(0);
    }
  }

  // Submit fan-out: N children, no aggregator. Each child gets read-only
  // tools so the codex HIGH-1 prompt-injection vector is closed at the
  // tool-allowlist layer rather than at allowedSlugPrefixes scope.
  const queue = new MinionQueue(engine);
  const childIds: number[] = [];
  for (const ch of chapters) {
    const data: SubagentHandlerData = {
      prompt: buildChapterPrompt(ch, chapters.length, bookTitle, flags.author, contextPack),
      model: flags.model,
      max_turns: flags.maxTurns,
      // CODEX HIGH-1 FIX: read-only tool allowlist. Subagents cannot call
      // put_page or any mutating op. Their only output is final_message text.
      allowed_tools: ['get_page', 'search'],
    };
    const submitOpts: Partial<MinionJobInput> = {
      max_stalled: 3,
      // Loose idempotency: same chapter file + slug → same idempotency key,
      // so re-running the CLI on identical input dedups against the queue.
      idempotency_key: `book-mirror:${flags.slug}:ch-${ch.index}`,
    };
    if (flags.timeoutMs) submitOpts.timeout_ms = flags.timeoutMs;
    const job = await queue.add(
      'subagent',
      data as unknown as Record<string, unknown>,
      submitOpts,
      { allowProtectedSubmit: true },
    );
    childIds.push(job.id);
  }

  process.stderr.write(
    `submitted: ${childIds.length} subagent jobs (${childIds[0]}..${childIds[childIds.length - 1]})\n`
  );

  if (!flags.follow) {
    process.stdout.write(JSON.stringify({ child_ids: childIds, slug: targetSlug }) + '\n');
    process.stderr.write(
      `gbrain book-mirror: detached. Run \`gbrain jobs get <id>\` per child, then re-run with same args once all are complete.\n`
    );
    return;
  }

  // Wait for every child. Order doesn't matter for the wait, but it does
  // matter for the assembly — we sort by chapter index in buildAssembledPage.
  process.stderr.write(`waiting for all ${childIds.length} chapters to complete...\n`);
  const analyses: Array<{ index: number; result: string; failed: boolean; error?: string }> = [];
  for (let i = 0; i < childIds.length; i++) {
    const childId = childIds[i]!;
    const chapterIndex = chapters[i]!.index;
    try {
      const job = await waitForCompletion(queue, childId, {
        timeoutMs: flags.timeoutMs ?? 30 * 60 * 1000, // 30 min per child
        pollMs: 1000,
      });
      if (job.status === 'completed' && job.result && typeof job.result === 'object') {
        const result = (job.result as { result?: string }).result ?? '';
        analyses.push({ index: chapterIndex, result, failed: false });
        process.stderr.write(`  chapter ${chapterIndex}: complete (job ${childId})\n`);
      } else {
        analyses.push({
          index: chapterIndex,
          result: '',
          failed: true,
          error: `job ${childId} status=${job.status}`,
        });
        process.stderr.write(`  chapter ${chapterIndex}: FAILED (job ${childId} status=${job.status})\n`);
      }
    } catch (e) {
      const msg = e instanceof TimeoutError
        ? `timeout after ${e.elapsedMs}ms`
        : (e instanceof Error ? e.message : String(e));
      analyses.push({ index: chapterIndex, result: '', failed: true, error: msg });
      process.stderr.write(`  chapter ${chapterIndex}: ERROR — ${msg}\n`);
    }
  }

  const failed = analyses.filter(a => a.failed).length;
  const completed = analyses.length - failed;
  process.stderr.write(
    `\nassembled: ${completed} chapters successful, ${failed} failed.\n`
  );

  if (completed === 0) {
    console.error(`gbrain book-mirror: every chapter failed. Not writing the brain page. Re-run after diagnosing.`);
    process.exit(1);
  }

  // Assemble the final page.
  const assembled = buildAssembledPage({
    slug: flags.slug!,
    title: bookTitle,
    author: flags.author,
    contextPack,
    chapterAnalyses: analyses,
  });

  // Operator-trust put_page — viaSubagent is NOT set, so the namespace
  // check doesn't fire. The CLI is the trusted writer.
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
      // viaSubagent intentionally omitted — operator trust path.
      // allowedSlugPrefixes intentionally omitted — operator can write anywhere.
    },
    {
      slug: targetSlug,
      content: assembled,
    },
  );

  process.stderr.write(`\nwrote: ${targetSlug} (${chapters.length} chapter sections, ${assembled.length} bytes)\n`);
  process.stdout.write(JSON.stringify({
    slug: targetSlug,
    chapters_total: chapters.length,
    chapters_completed: completed,
    chapters_failed: failed,
  }) + '\n');

  if (failed > 0) {
    process.stderr.write(
      `\ngbrain book-mirror: ${failed} chapter(s) failed. The page was written with the completed chapters; run again to retry the failed ones (idempotency keys dedupe successful chapters).\n`
    );
    process.exit(1);
  }
}
