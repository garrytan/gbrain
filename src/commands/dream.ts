/**
 * gbrain dream — run one brain maintenance cycle.
 *
 * The README brand promise: "the agent runs while I sleep, the dream
 * cycle ... I wake up and the brain is smarter." Cron-friendly, JSON
 * report, phase-selectable.
 *
 * Thin alias over runCycle (src/core/cycle.ts). Both this command and
 * `gbrain autopilot` converge on the same primitive so there's one
 * source of truth for what "overnight maintenance" means.
 *
 * Usage:
 *   gbrain dream                       # full 6-phase cycle
 *   gbrain dream --dry-run             # preview, no writes
 *   gbrain dream --json                # CycleReport JSON (for agents)
 *   gbrain dream --phase lint          # run a single phase
 *   gbrain dream --pull                # also git pull the brain repo
 *   gbrain dream --dir /path/to/brain  # explicit brain location
 *
 * Cron: 0 2 * * * gbrain dream --json >> /var/log/gbrain-dream.log
 *
 * Related: `gbrain autopilot --install` for continuous daemonized
 * maintenance. dream is the one-shot, autopilot is the scheduler.
 */

import type { BrainEngine } from '../core/engine.ts';
import {
  runCycle,
  ALL_PHASES,
  type CyclePhase,
  type CycleReport,
} from '../core/cycle.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { fetchSource } from '../core/sources-load.ts';
import { existsSync } from 'fs';
import { resolve } from 'node:path';
import { loadConfig } from '../core/config.ts';
import { brainDirFromConfig, ensureSystemSkillAssets } from '../core/system-skill-assets.ts';

interface DreamArgs {
  json: boolean;
  dryRun: boolean;
  pull: boolean;
  phase: CyclePhase | null;
  dir: string | null;
  help: boolean;
  /** v0.21: ad-hoc transcript file or directory path; implies --phase synthesize. */
  inputFile: string | null;
  /** v0.21: restrict synthesize to a single date (YYYY-MM-DD). */
  date: string | null;
  /** v0.21: backfill range start (YYYY-MM-DD). */
  from: string | null;
  /** v0.21: backfill range end (YYYY-MM-DD). */
  to: string | null;
  /**
   * v0.23.2: disable the synthesize phase's self-consumption guard.
   * Long-form flag name to discourage casual use; loud stderr warning fires when set.
   * Never auto-applied for --input (codex finding #3).
   */
  bypassDreamGuard: boolean;
  /**
   * v0.41.13: per-source cycle scoping. Threaded into runCycle as
   * `sourceId` so `cycle.ts:1947-1967` writes `last_full_cycle_at`
   * to `sources.config` on success — without it, `gbrain doctor`'s
   * `cycle_freshness` check stays stale forever. Accepts `--source
   * <id>` and the alias `--source-id <id>` (the v0.37.7.0 #1167
   * canonical name across import/extract/graph-query); both work
   * until a follow-up CLI cleanup picks one. Supersedes PR #1559.
   */
  source: string | null;
  /**
   * Limits how many pages propose_takes scans in this dream run.
   * Forwarded to runCycle as proposeTakesPageLimit.
   */
  maxPages: number | null;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Collect every occurrence of `--<flag> <value>` in argv. Used to
 * detect repeated flags with different values (e.g.
 * `--source X --source Y`) and to surface a clean usage error
 * instead of silently last-wins. Repeated identical values are
 * collapsed to one (no-op). Missing values (flag at end of argv)
 * return null to let the caller raise an explicit usage error
 * rather than fall through with `undefined`.
 */
function collectFlagValues(args: string[], flag: string): string[] | null {
  const values: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) continue;
    const v = args[i + 1];
    if (v === undefined) return null; // flag at end of argv
    values.push(v);
  }
  return values;
}

function parseArgs(args: string[]): DreamArgs {
  const phaseIdx = args.indexOf('--phase');
  const rawPhase = phaseIdx !== -1 ? args[phaseIdx + 1] : null;
  let phase = rawPhase && (ALL_PHASES as string[]).includes(rawPhase)
    ? (rawPhase as CyclePhase)
    : null;
  if (rawPhase && !phase) {
    console.error(`Unknown phase "${rawPhase}". Valid: ${ALL_PHASES.join(', ')}`);
    process.exit(1);
  }

  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx !== -1 ? args[dirIdx + 1] : null;

  const inputIdx = args.indexOf('--input');
  const inputFile = inputIdx !== -1 ? args[inputIdx + 1] ?? null : null;

  const dateIdx = args.indexOf('--date');
  const date = dateIdx !== -1 ? args[dateIdx + 1] ?? null : null;
  if (date && !ISO_DATE_RE.test(date)) {
    console.error(`--date must be YYYY-MM-DD; got "${date}"`);
    process.exit(2);
  }

  const fromIdx = args.indexOf('--from');
  const from = fromIdx !== -1 ? args[fromIdx + 1] ?? null : null;
  if (from && !ISO_DATE_RE.test(from)) {
    console.error(`--from must be YYYY-MM-DD; got "${from}"`);
    process.exit(2);
  }

  const toIdx = args.indexOf('--to');
  const to = toIdx !== -1 ? args[toIdx + 1] ?? null : null;
  if (to && !ISO_DATE_RE.test(to)) {
    console.error(`--to must be YYYY-MM-DD; got "${to}"`);
    process.exit(2);
  }
  if (from && to && from > to) {
    console.error(`--from (${from}) is after --to (${to}); empty range`);
    process.exit(2);
  }

  // --input + --date / --from / --to is incoherent: --input targets a specific
  // file or directory, the date filters scan the configured corpus dir.
  if (inputFile && (date || from || to)) {
    console.error('--input cannot be combined with --date / --from / --to');
    process.exit(2);
  }

  // --input implies --phase synthesize.
  if (inputFile && !phase) phase = 'synthesize';

  // v0.41.13: --source <id> (and the --source-id alias) drives per-source
  // cycle scoping. Resolution rules:
  //   - missing value (flag at end of argv) → exit 2 with usage
  //   - repeated with different values (e.g. --source X --source Y) → exit 2
  //   - --source X --source-id Y (conflicting flag aliases) → exit 2
  //   - --source X --source X (or --source-id repeated with same value) → accepted
  //   - --help short-circuits BEFORE this block fires (see runDream).
  // Closes the PR #1559 silent-no-op class through a clean argv contract.
  const sourceValues = collectFlagValues(args, '--source');
  const sourceIdValues = collectFlagValues(args, '--source-id');
  if (sourceValues === null) {
    console.error('--source <id>: missing value. Usage: gbrain dream --source <source-id>');
    process.exit(2);
  }
  if (sourceIdValues === null) {
    console.error('--source-id <id>: missing value. Usage: gbrain dream --source-id <source-id>');
    process.exit(2);
  }
  const uniqSource = Array.from(new Set(sourceValues));
  const uniqSourceId = Array.from(new Set(sourceIdValues));
  if (uniqSource.length > 1) {
    console.error(`specify --source once; got [${uniqSource.map(v => `"${v}"`).join(', ')}]`);
    process.exit(2);
  }
  if (uniqSourceId.length > 1) {
    console.error(`specify --source-id once; got [${uniqSourceId.map(v => `"${v}"`).join(', ')}]`);
    process.exit(2);
  }
  if (uniqSource.length === 1 && uniqSourceId.length === 1 && uniqSource[0] !== uniqSourceId[0]) {
    console.error(
      `use --source OR --source-id, not both (different values): ` +
      `--source="${uniqSource[0]}" vs --source-id="${uniqSourceId[0]}"`,
    );
    process.exit(2);
  }
  const source = uniqSource[0] ?? uniqSourceId[0] ?? null;

  const maxPagesValues = collectFlagValues(args, '--max-pages');
  if (maxPagesValues === null) {
    console.error('--max-pages <n>: missing value. Usage: gbrain dream --phase propose_takes --max-pages 25');
    process.exit(2);
  }
  const uniqMaxPages = Array.from(new Set(maxPagesValues));
  if (uniqMaxPages.length > 1) {
    console.error(`specify --max-pages once; got [${uniqMaxPages.map(v => `"${v}"`).join(', ')}]`);
    process.exit(2);
  }
  let maxPages: number | null = null;
  if (uniqMaxPages.length === 1) {
    const parsed = Number(uniqMaxPages[0]);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.error(`--max-pages must be a positive integer; got "${uniqMaxPages[0]}"`);
      process.exit(2);
    }
    maxPages = parsed;
  }

  return {
    json: args.includes('--json'),
    dryRun: args.includes('--dry-run'),
    pull: args.includes('--pull'),
    phase,
    dir,
    help: args.includes('--help') || args.includes('-h'),
    inputFile,
    date,
    from,
    to,
    bypassDreamGuard: args.includes('--unsafe-bypass-dream-guard'),
    source,
    maxPages,
  };
}

/**
 * Resolve the brain directory without the `findRepoRoot` footgun.
 *
 * Prior dream.ts walked up 10 levels of cwd looking for `.git` and would
 * happily run lint + sync against an unrelated git repo the user happened
 * to be cd'd into. This resolver only trusts two sources:
 *   1. An explicit --dir argument.
 *   2. The `sync.repo_path` config key set by `gbrain init` (engine-backed).
 *
 * If neither is available, we error out instead of guessing.
 */
async function resolveBrainDir(
  engine: BrainEngine | null,
  explicit: string | null,
): Promise<string> {
  if (explicit) {
    if (!existsSync(explicit)) {
      console.error(`--dir path does not exist: ${explicit}`);
      process.exit(1);
    }
    // Resolve to absolute so downstream writeFileSync(join(brainDir, slug))
    // can't silently land at cwd when explicit is `.` / `./brain` / etc.
    return resolve(explicit);
  }

  if (engine) {
    const configured = await engine.getConfig('sync.repo_path');
    if (configured && existsSync(configured)) {
      return resolve(configured);
    }
  }

  console.error(
    'No brain directory found. Pass --dir <path> or configure one via `gbrain init`.',
  );
  process.exit(1);
}

function printHelp() {
  console.log(`用法：gbrain dream [选项]

运行一次 PMBrain 维护周期。当前阶段：
  ${ALL_PHASES.join(' -> ')}

重点流程：
  1. sync / extract / extract_facts 等阶段把页面、链接、事实索引更新到数据库。
  2. propose_takes 从页面正文里抽取“候选观点”，写入 take_proposals，状态为 pending。
  3. 在 Admin Console 的“观点审批”页面查看原文依据，人工接受或拒绝。
  4. 接受后的候选观点才会进入正式 takes；grade_takes 和 calibration_profile 再基于正式 takes 工作。

选项：
  --dry-run           预览执行，不写入数据。propose_takes 在 dry-run 下只统计哪些页面
                      需要 LLM，不调用 LLM，也不写入候选观点。其他阶段仍按各自
                      dry-run 语义执行。
  --json              以 JSON 输出 CycleReport，供 Agent 读取。
  --phase <name>      仅运行单个阶段：${ALL_PHASES.join(' | ')}
  --pull              同步前对大脑仓库执行 git pull，默认不执行。
  --dir <path>        大脑目录，默认使用已配置目录。

  --source <id>       将周期限定到指定来源；propose_takes、grade_takes、
                      calibration_profile 也会使用这个 source。
  --source-id <id>    --source 的别名。
  --max-pages <n>     限制 propose_takes 最多处理的页面数，适合分批执行。

  --input <path>      综合指定转录文件或文件夹，隐含 --phase synthesize。
  --date YYYY-MM-DD   综合指定日期的转录文本。
  --from YYYY-MM-DD   回填范围开始日期，与 --to 配合使用。
  --to   YYYY-MM-DD   回填范围结束日期。

  --unsafe-bypass-dream-guard
                      禁用自消费保护。仅在确定输入文件不是 dream 周期产物、
                      但保护仍被触发时使用。

  --help, -h          显示此帮助。

示例：
  gbrain dream --dry-run --json
  gbrain dream --phase propose_takes --dry-run --source pmgbrain
  gbrain dream --phase propose_takes --source pmgbrain --max-pages 25
  gbrain dream --phase calibration_profile --source pmgbrain
  gbrain dream --phase synthesize --input ~/transcripts/2026-04-25.txt
  gbrain dream --phase synthesize --input ~/transcripts/

审批入口：
  启动服务后打开 http://localhost:3131/admin ，进入“观点审批”。
`);
}

// ─── Human-friendly report printing ────────────────────────────────

function printHuman(report: CycleReport) {
  if (report.status === 'skipped') {
    if (report.reason === 'cycle_already_running') {
      console.log(`Skipped: another cycle is already running. (locked)`);
    } else if (report.reason === 'no_database') {
      console.log(`Skipped: no database available.`);
    } else {
      console.log(`Skipped: ${report.reason ?? 'unknown reason'}.`);
    }
    return;
  }

  if (report.status === 'clean') {
    console.log(
      `Brain is healthy. ${report.phases.length} phase(s) checked in ${(report.duration_ms / 1000).toFixed(1)}s.`,
    );
    return;
  }

  console.log(`Dream cycle (${report.status}) in ${(report.duration_ms / 1000).toFixed(1)}s:`);
  for (const p of report.phases) {
    const icon =
      p.status === 'ok' ? '✓' :
      p.status === 'warn' ? '!' :
      p.status === 'skipped' ? '-' : '✗';
    const line = `  ${icon} ${p.phase.padEnd(10)}  ${p.summary}`;
    console.log(line);
    if (p.error) {
      const hint = p.error.hint ? ` (${p.error.hint})` : '';
      console.log(`      [${p.error.class}/${p.error.code}] ${p.error.message}${hint}`);
    }
  }

  const t = report.totals;
  const hasTotals =
    t.lint_fixes > 0 || t.backlinks_added > 0 || t.pages_synced > 0 ||
    t.pages_extracted > 0 || t.pages_embedded > 0 || t.orphans_found > 0 ||
    t.transcripts_processed > 0 || t.synth_pages_written > 0 || t.patterns_written > 0;
  if (hasTotals) {
    console.log(
      `  totals: lint=${t.lint_fixes} backlinks=${t.backlinks_added} synced=${t.pages_synced} ` +
      `extracted=${t.pages_extracted} embedded=${t.pages_embedded} orphans=${t.orphans_found} ` +
      `synth_transcripts=${t.transcripts_processed} synth_pages=${t.synth_pages_written} ` +
      `patterns=${t.patterns_written}`,
    );
  }
}

// ─── CLI entry ─────────────────────────────────────────────────────

/**
 * Predicate: is this error one of the resolver's user-facing throws
 * we want to surface as a clean stderr line + exit 1?
 *
 * Matches the message prefixes thrown from
 * `src/core/source-resolver.ts:resolveSourceId` and
 * `assertSourceExists`. Anything else (TypeError / ReferenceError /
 * postgres connection failures / unexpected bugs) is intentionally
 * NOT caught — those propagate to Bun's default unhandled handler
 * with a stack trace so genuine programmer bugs aren't hidden as
 * if they were operator errors. (Plan D-T3, codex C-7.)
 */
function isResolverUserError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const m = e.message;
  return (m.startsWith('Source "') && m.includes(' not found.'))
      || m.startsWith('Invalid --source value')
      || m.startsWith('Invalid GBRAIN_SOURCE value');
}

function ensureDreamSystemSkillAssets(brainDir: string): void {
  const targetDir = brainDirFromConfig(loadConfig()) ?? brainDir;
  try {
    const result = ensureSystemSkillAssets(targetDir);
    const changed = result.created.length + result.updated.length;
    if (changed > 0) {
      process.stderr.write(`[dream] initialized system skill assets in ${result.skillsDir} (${changed} changed)\n`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[dream] warning: system skill asset initialization skipped: ${msg}\n`);
  }
}

function validateDreamInputPath(inputFile: string | null): void {
  if (!inputFile) return;
  if (existsSync(inputFile)) return;
  console.error(`--input path does not exist: ${inputFile}`);
  process.exit(2);
}

export async function runDream(engine: BrainEngine | null, args: string[]): Promise<CycleReport | void> {
  const opts = parseArgs(args);

  // ─── IRON RULE: --help short-circuits BEFORE any engine-bearing work ─
  // Tests pin this ordering so `gbrain dream --help --source whatever`
  // ALWAYS prints help and exits 0, never reaching the engine-null gate
  // below. If you reorder this, dream-cli-flags.test.ts will fail.
  if (opts.help) {
    printHelp();
    return;
  }

  // v0.41.13: --source <id> resolution. Three guards in order:
  //   1. engine null → exit 1 (the writeback in cycle.ts requires a
  //      DB connection; without engine we'd silently fail the same way
  //      PR #1559 was created to fix)
  //   2. resolveSourceId throws on unknown id → typed-error catch
  //      surfaces clean message; non-resolver throws propagate
  //   3. archived source → exit 1 with restore hint (writing
  //      last_full_cycle_at to an archived source would mask data
  //      staleness when the source is later restored)
  let resolvedSourceId: string | undefined;
  if (opts.source !== null) {
    if (engine === null) {
      console.error(
        'gbrain dream --source <id> requires a connected brain ' +
        '(no engine available); omit --source or run `gbrain init` first',
      );
      process.exit(1);
    }
    try {
      resolvedSourceId = await resolveSourceId(engine, opts.source);
    } catch (e) {
      if (isResolverUserError(e)) {
        console.error((e as Error).message);
        process.exit(1);
      }
      throw e; // genuine bugs propagate with stack trace
    }
    // Archived-source guard via fetchSource from sources-load.ts
    // (single-row SELECT that projects `archived` and falls back to
    // pre-v0.26.5 schemas via isUndefinedColumnError catch — same
    // legacy-safety net the rest of the codebase uses). engine's
    // built-in listAllSources defaults to includeArchived=false AND
    // doesn't project the archived column, so it cannot be used here.
    const src = await fetchSource(engine, resolvedSourceId);
    if (src?.archived === true) {
      console.error(
        `source ${resolvedSourceId} is archived; restore with ` +
        `\`gbrain sources restore ${resolvedSourceId}\` before cycling`,
      );
      process.exit(1);
    }
  }

  const brainDir = await resolveBrainDir(engine, opts.dir);
  ensureDreamSystemSkillAssets(brainDir);
  validateDreamInputPath(opts.inputFile);
  const phases: CyclePhase[] | undefined = opts.phase ? [opts.phase] : undefined;

  const report = await runCycle(engine, {
    brainDir,
    dryRun: opts.dryRun,
    pull: opts.pull,
    phases,
    sourceId: resolvedSourceId, // undefined when --source not set → legacy back-compat
    synthInputFile: opts.inputFile ?? undefined,
    synthDate: opts.date ?? undefined,
    synthFrom: opts.from ?? undefined,
    synthTo: opts.to ?? undefined,
    synthBypassDreamGuard: opts.bypassDreamGuard,
    proposeTakesPageLimit: opts.maxPages ?? undefined,
  });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }

  // Exit non-zero when the cycle failed overall (helps cron spot real problems).
  // 'partial' is not a failure — it means some phase warned but the cycle ran.
  if (report.status === 'failed') {
    process.exit(1);
  }

  return report;
}
