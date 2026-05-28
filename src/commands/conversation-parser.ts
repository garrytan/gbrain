/**
 * v0.41.16.0 — `gbrain conversation-parser` debug CLI.
 *
 * Three subcommands for operators:
 *   - scan <slug>       Dry-run the parser on a page; report which
 *                       pattern matched, message count, polish/fallback
 *                       diagnostics.
 *   - list-builtins     Print the 12 built-in pattern registry rows
 *                       with id, regex shape, source_doc.
 *   - validate <file>   Validate a user-declared simple_pattern JSON
 *                       spec (v0.42+ — see TODOS.md).
 *
 * Per D23 #10: wired into CLI_ONLY at cli.ts:38; thin-client refusal
 * surfaces at cli.ts:739 (handled by the dispatch table).
 */

import { readFileSync, existsSync } from 'node:fs';
import { BUILTIN_PATTERNS } from '../core/conversation-parser/builtins.ts';
import { parseConversation } from '../core/conversation-parser/parse.ts';
import type { BrainEngine } from '../core/engine.ts';

function printHelp(): void {
  process.stdout.write(`Usage: gbrain conversation-parser <subcommand> [options]

Subcommands:
  scan <slug>          Dry-run the parser on a page; report pattern hit.
  list-builtins        Print the built-in pattern registry.
  validate <file>      Validate a user-declared simple_pattern JSON spec.
                       (v1: simple_pattern compilation not yet implemented;
                        emits "TODO v0.42+" notice.)

Examples:
  gbrain conversation-parser scan conversations/imessage/alice-example
  gbrain conversation-parser list-builtins --json
  gbrain conversation-parser validate ./my-pattern.json

Global flags:
  --json               Emit JSON envelope on stdout (where applicable).
  --help, -h           Print this help.
`);
}

export async function runConversationParser(
  engine: BrainEngine | null,
  args: string[],
): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }

  const rest = args.slice(1);
  const json = rest.includes('--json');

  if (sub === 'list-builtins') {
    runListBuiltins(json);
    return;
  }
  if (sub === 'validate') {
    runValidate(rest, json);
    return;
  }
  if (sub === 'scan') {
    if (!engine) {
      process.stderr.write(
        '[conversation-parser scan] requires a connected brain.\n',
      );
      process.exit(2);
    }
    await runScan(engine, rest, json);
    return;
  }

  process.stderr.write(
    `[conversation-parser] unknown subcommand: ${sub}. See --help.\n`,
  );
  process.exit(2);
}

function runListBuiltins(json: boolean): void {
  if (json) {
    const payload = {
      schema_version: 1,
      total: BUILTIN_PATTERNS.length,
      patterns: BUILTIN_PATTERNS.map((p) => ({
        id: p.id,
        date_source: p.date_source,
        time_format: p.time_format,
        timezone_policy: p.timezone_policy,
        multi_line: p.multi_line,
        regex: p.regex.source,
        test_positive_count: p.test_positive.length,
        source_doc: p.source_doc,
      })),
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  process.stdout.write(
    `[conversation-parser] ${BUILTIN_PATTERNS.length} built-in patterns:\n\n`,
  );
  for (const p of BUILTIN_PATTERNS) {
    process.stdout.write(
      `  ${p.id.padEnd(25)} (${p.date_source}/${p.time_format}/${p.timezone_policy}, ` +
        `multi_line=${p.multi_line ? 'yes' : 'no'})\n`,
    );
    if (p.source_doc) {
      process.stdout.write(`    source: ${p.source_doc}\n`);
    }
    if (p.test_positive.length > 0) {
      process.stdout.write(`    sample: ${p.test_positive[0]}\n`);
    }
    process.stdout.write('\n');
  }
}

function runValidate(args: string[], json: boolean): void {
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    process.stderr.write(
      '[conversation-parser validate] USAGE: missing file path.\n',
    );
    process.exit(2);
  }
  if (!existsSync(file)) {
    process.stderr.write(
      `[conversation-parser validate] USAGE: file not found: ${file}\n`,
    );
    process.exit(2);
  }
  // v0.42+: simple_pattern compilation. v1 only emits an informational
  // notice — arbitrary user regex is intentionally out of v1 scope per
  // D16 (codex outside voice: Promise.race ReDoS guard is fake security).
  void readFileSync(file, 'utf8');
  const payload = {
    schema_version: 1,
    status: 'deferred',
    message:
      'User-declared simple_pattern compilation is deferred to v0.42+. ' +
      'v1 supports only the 12 built-in patterns (see `list-builtins`).',
    todo_ref: 'TODOS.md v0.41.16.0 follow-ups #1, #2',
  };
  if (json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    process.stdout.write(
      '[conversation-parser validate] ' + payload.message + '\n',
    );
  }
}

async function runScan(
  engine: BrainEngine,
  args: string[],
  json: boolean,
): Promise<void> {
  const slug = args.find((a) => !a.startsWith('--'));
  if (!slug) {
    process.stderr.write(
      '[conversation-parser scan] USAGE: missing page slug.\n',
    );
    process.exit(2);
  }
  const page = await engine.getPage(slug);
  if (!page) {
    process.stderr.write(
      `[conversation-parser scan] page not found: ${slug}\n`,
    );
    process.exit(2);
  }

  // Concatenate compiled_truth + timeline (matches the real parser's body shape).
  const body = `${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`.trim();

  const result = parseConversation(body, { page, diagnostic: true });

  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          schema_version: 1,
          slug,
          phase: result.phase,
          matched_pattern_id: result.matched_pattern_id,
          patterns_scored: result.patterns_scored,
          message_count: result.messages.length,
          unmatched_line_count: result.unmatched_line_count,
          timezone_warning: result.timezone_warning,
          first_3_messages: result.messages.slice(0, 3).map((m) => ({
            speaker: m.speaker,
            timestamp: m.timestamp,
            text_preview: m.text.slice(0, 80),
          })),
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  process.stdout.write(
    `[conversation-parser scan] ${slug}\n` +
      `  phase: ${result.phase}\n` +
      `  matched_pattern_id: ${result.matched_pattern_id ?? 'no_match'}\n` +
      `  patterns_scored: ${result.patterns_scored ?? 0}\n` +
      `  messages: ${result.messages.length}\n` +
      (result.unmatched_line_count !== undefined
        ? `  unmatched_lines: ${result.unmatched_line_count}\n`
        : '') +
      (result.timezone_warning
        ? `  timezone_warning: ${result.timezone_warning}\n`
        : ''),
  );
  if (result.messages.length > 0) {
    process.stdout.write('  first 3 messages:\n');
    for (const m of result.messages.slice(0, 3)) {
      process.stdout.write(
        `    - ${m.speaker} @ ${m.timestamp}: ${m.text.slice(0, 80)}\n`,
      );
    }
  }
}
