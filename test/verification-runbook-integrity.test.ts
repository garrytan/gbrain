import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = new URL('..', import.meta.url).pathname;

type MissingReference = {
  source: string;
  command: string;
  file: string;
};

type MissingScript = {
  source: string;
  command: string;
  script: string;
};

const RUNBOOK_CLASSIFICATIONS = ['executable', 'manual', 'external', 'obsolete'] as const;

type RunbookClassification = typeof RUNBOOK_CLASSIFICATIONS[number];

type MarkdownFence = {
  closed: boolean;
  line: number;
  endLine: number;
  info: string;
  language: string;
  runbookClassification: RunbookClassification | null;
};

const SHELL_FENCE_LANGUAGES = new Set(['bash', 'sh', 'shell', 'zsh']);

function repoFileExists(path: string): boolean {
  return existsSync(join(repoRoot, path));
}

function isRepoLocalFileToken(token: string): boolean {
  if (/[<>]|\bYYYY\b|\bMM\b|\bDD\b/.test(token)) return false;
  return /^(test|tests|scripts|src|docs|supabase|\.github)\//.test(token)
    && /\.(ts|tsx|js|mjs|cjs|json|md|sh|yml|yaml)$/.test(token);
}

function stripShellSyntax(token: string): string {
  return token
    .trim()
    .replace(/^[([{]+/, '')
    .replace(/[)\]}]+$/g, '')
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/[,;|&]+$/g, '')
    .replace(/^[([{]+/, '')
    .replace(/[)\]}]+$/g, '')
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/^\.\//, '');
}

function repoFileTokens(command: string): string[] {
  return command
    .split(/\s+/)
    .map(stripShellSyntax)
    .filter(isRepoLocalFileToken);
}

function packageScriptMissingReferences(packageJsonPath = 'package.json'): MissingReference[] {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, packageJsonPath), 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = packageJson.scripts ?? {};
  const missing: MissingReference[] = [];

  for (const [name, command] of Object.entries(scripts)) {
    for (const file of repoFileTokens(command)) {
      if (!repoFileExists(file)) {
        missing.push({ source: `package.json scripts.${name}`, command, file });
      }
    }
  }

  return missing;
}

function packageScriptNames(packageJsonPath = 'package.json'): Set<string> {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, packageJsonPath), 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  return new Set(Object.keys(packageJson.scripts ?? {}));
}

function runbookClassification(info: string): RunbookClassification | null {
  const match = info.match(/(?:^|\s)runbook:(executable|manual|external|obsolete)(?:\s|$)/);
  return (match?.[1] as RunbookClassification | undefined) ?? null;
}

function markdownFences(text: string): MarkdownFence[] {
  const fences: MarkdownFence[] = [];
  let pendingFence: (Omit<MarkdownFence, 'endLine'> & { closingFence: RegExp }) | null = null;
  const lines = text.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (pendingFence) {
      if (pendingFence.closingFence.test(line)) {
        fences.push({
          closed: true,
          line: pendingFence.line,
          endLine: index + 1,
          info: pendingFence.info,
          language: pendingFence.language,
          runbookClassification: pendingFence.runbookClassification,
        });
        pendingFence = null;
      }
      continue;
    }

    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!match) continue;

    const fenceMarker = match[1];
    const info = match[2].trim();
    if (fenceMarker.startsWith('`') && info.includes('`')) continue;

    const language = info.split(/\s+/)[0] ?? '';
    const fenceChar = fenceMarker[0];
    pendingFence = {
      closed: false,
      line: index + 1,
      info,
      language,
      runbookClassification: runbookClassification(info),
      closingFence: new RegExp('^ {0,3}' + fenceChar + '{' + fenceMarker.length + ',}\\s*$'),
    };
  }

  if (pendingFence) {
    fences.push({
      closed: false,
      line: pendingFence.line,
      endLine: lines.length,
      info: pendingFence.info,
      language: pendingFence.language,
      runbookClassification: pendingFence.runbookClassification,
    });
  }

  return fences;
}

function missingRunbookClassifications(path = 'docs/MBRAIN_VERIFY.md'): Array<{ source: string; info: string }> {
  return missingRunbookClassificationsFromText(readFileSync(join(repoRoot, path), 'utf-8'), path);
}

function missingRunbookClassificationsFromText(text: string, path = 'docs/example.md'): Array<{ source: string; info: string }> {
  return markdownFences(text)
    .filter((fence) => SHELL_FENCE_LANGUAGES.has(fence.language))
    .filter((fence) => fence.runbookClassification === null || !fence.closed)
    .map((fence) => ({ source: `${path}:${fence.line}`, info: fence.info }));
}

function commandFromParts(parts: string[]): string {
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

type InlineCommandStart = {
  closed: boolean;
  marker: string;
  nextIndex: number;
  segment: string;
  segmentEndIndex: number;
  segmentStartIndex: number;
  startIndex: number;
};

function inlineCommandSegment(text: string, marker: string): { closed: boolean; nextIndex: number; segment: string } {
  const closingTick = text.indexOf(marker);
  if (closingTick === -1) return { closed: false, nextIndex: text.length, segment: text };
  return { closed: true, nextIndex: closingTick + marker.length, segment: text.slice(0, closingTick) };
}

function inlineCommandStart(line: string, searchIndex = 0): InlineCommandStart | null {
  while (searchIndex < line.length) {
    const opening = line.slice(searchIndex).match(/`+/);
    if (!opening || opening.index === undefined) return null;

    const openingTick = searchIndex + opening.index;
    const marker = opening[0];
    const afterOpeningTick = line.slice(openingTick + marker.length);
    const closingTick = afterOpeningTick.indexOf(marker);
    const segment = closingTick === -1
      ? afterOpeningTick
      : afterOpeningTick.slice(0, closingTick);

    if (/\bbun\s+(run|test)\b/.test(segment)) {
      return {
        closed: closingTick !== -1,
        marker,
        nextIndex: closingTick === -1
          ? line.length
          : openingTick + marker.length + closingTick + marker.length,
        segment,
        segmentEndIndex: closingTick === -1
          ? line.length
          : openingTick + marker.length + closingTick,
        segmentStartIndex: openingTick + marker.length,
        startIndex: openingTick,
      };
    }

    if (closingTick === -1) return null;
    searchIndex = openingTick + marker.length + closingTick + marker.length;
  }

  return null;
}

type BunCommandRange = {
  command: string;
  endColumn: number;
  endLine: number;
  line: number;
  startColumn: number;
};

type CommandSegment = {
  endColumn: number;
  line: number;
  startColumn: number;
  text: string;
};

function trimCommandEnd(text: string, start: number, end: number): number {
  let trimmedEnd = end;
  while (trimmedEnd > start && /\s/.test(text[trimmedEnd - 1])) trimmedEnd -= 1;

  let previousEnd = -1;
  while (trimmedEnd !== previousEnd) {
    previousEnd = trimmedEnd;
    const command = text.slice(start, trimmedEnd);
    const stripped = command.replace(/\s*(?:&&|\|\||[;|&])\s*$/, '');
    trimmedEnd = start + stripped.length;
  }

  while (trimmedEnd > start && /\s/.test(text[trimmedEnd - 1])) trimmedEnd -= 1;
  return trimmedEnd;
}

function appendBunCommandRanges(commands: BunCommandRange[], segments: CommandSegment[]): void {
  const chars: string[] = [];
  const positions: Array<{ line: number; column: number }> = [];

  segments.forEach((segment, index) => {
    if (index > 0) {
      chars.push(' ');
      positions.push({ line: segment.line, column: segment.startColumn });
    }

    for (let offset = 0; offset < segment.text.length; offset += 1) {
      chars.push(segment.text[offset]);
      positions.push({ line: segment.line, column: segment.startColumn + offset });
    }
  });

  const text = chars.join('');
  const matches = Array.from(text.matchAll(/\bbun\s+(run|test)\b/g));

  matches.forEach((match, index) => {
    const start = match.index ?? 0;
    const rawEnd = index + 1 < matches.length
      ? matches[index + 1].index ?? text.length
      : text.length;
    const end = trimCommandEnd(text, start, rawEnd);
    if (end <= start) return;

    const startPosition = positions[start];
    const endPosition = positions[end - 1];
    if (!startPosition || !endPosition) return;

    commands.push({
      command: text.slice(start, end).trim(),
      endColumn: endPosition.column + 1,
      endLine: endPosition.line,
      line: startPosition.line,
      startColumn: startPosition.column,
    });
  });
}

function bunCommandRangesFromMarkdown(_path: string, text: string): Array<{
  command: string;
  endColumn: number;
  endLine: number;
  line: number;
  startColumn: number;
}> {
  const commands: BunCommandRange[] = [];
  let pending: {
    marker?: string;
    mode: 'inline' | 'shell';
    segments: CommandSegment[];
  } | null = null;

  const pushPending = () => {
    if (!pending) return;
    appendBunCommandRanges(commands, pending.segments);
    pending = null;
  };

  text
    .split('\n')
    .forEach((line, index) => {
      const lineNumber = index + 1;
      const trimmed = line.trim();
      const withoutContinuation = trimmed.replace(/\\$/, '').trim();
      let inlineSearchIndex = 0;

      if (pending) {
        if (pending.mode === 'inline') {
          const { closed, nextIndex, segment } = inlineCommandSegment(trimmed, pending.marker ?? '`');
          pending.segments.push({
            line: lineNumber,
            text: segment,
            startColumn: 0,
            endColumn: segment.length,
          });
          if (!closed) return;
          pushPending();
          inlineSearchIndex = nextIndex;
        } else {
          pending.segments.push({
            line: lineNumber,
            text: withoutContinuation,
            startColumn: 0,
            endColumn: withoutContinuation.length,
          });
          if (!trimmed.endsWith('\\')) pushPending();
          return;
        }
      }

      let foundInlineCommand = false;
      while (inlineSearchIndex < trimmed.length) {
        const inlineStart = inlineCommandStart(trimmed, inlineSearchIndex);
        if (!inlineStart) break;

        foundInlineCommand = true;
        pending = {
          marker: inlineStart.marker,
          mode: 'inline',
          segments: [{
            line: lineNumber,
            text: inlineStart.segment,
            startColumn: inlineStart.segmentStartIndex,
            endColumn: inlineStart.segmentEndIndex,
          }],
        };
        if (!inlineStart.closed) return;
        pushPending();
        inlineSearchIndex = inlineStart.nextIndex;
      }
      if (foundInlineCommand) return;

      if (!/\bbun\s+(run|test)\b/.test(trimmed)) return;
      pending = {
        mode: 'shell',
        segments: [{
          line: lineNumber,
          text: withoutContinuation,
          startColumn: 0,
          endColumn: withoutContinuation.length,
        }],
      };
      if (!trimmed.endsWith('\\')) pushPending();
    });

  pushPending();
  return commands;
}

function bunCommandsFromMarkdown(path: string, text: string): Array<{ line: number; command: string }> {
  return bunCommandRangesFromMarkdown(path, text).map(({ line, command }) => ({ line, command }));
}

function linesWithBunCommands(path: string): Array<{ line: number; command: string }> {
  return bunCommandsFromMarkdown(path, readFileSync(join(repoRoot, path), 'utf-8'));
}

function missingInlineCommandClassifications(path = 'docs/MBRAIN_VERIFY.md'): MissingScript[] {
  const text = readFileSync(join(repoRoot, path), 'utf-8');
  return missingInlineCommandClassificationsFromText(text, path);
}

function missingInlineCommandClassificationsFromText(text: string, path = 'docs/example.md'): MissingScript[] {
  const lines = text.split('\n').map((line) => line.trim());
  const classifiedShellFences = markdownFences(text)
    .filter((fence) => SHELL_FENCE_LANGUAGES.has(fence.language))
    .filter((fence) => fence.closed)
    .filter((fence) => fence.runbookClassification !== null);
  const commands = bunCommandRangesFromMarkdown(path, text);

  return commands
    .filter((command) => !classifiedShellFences.some((fence) => (
      fence.line <= command.line && command.endLine <= fence.endLine
    )))
    .filter((command) => {
      const nextCommand = commands.find((candidate) => (
        candidate.line === command.endLine && candidate.startColumn > command.endColumn
      ));
      const markerScopeEnd = nextCommand?.startColumn ?? lines[command.endLine - 1]?.length ?? command.endColumn;
      const markerScope = lines[command.endLine - 1]?.slice(command.endColumn, markerScopeEnd) ?? '';
      return runbookClassification(markerScope) === null;
    })
    .map((command) => ({ source: `${path}:${command.line}`, command: command.command, script: 'runbook:<class>' }));
}

function runbookMissingFileReferences(path = 'docs/MBRAIN_VERIFY.md'): MissingReference[] {
  const missing: MissingReference[] = [];

  for (const { line, command } of linesWithBunCommands(path)) {
    for (const file of repoFileTokens(command)) {
      if (!repoFileExists(file)) {
        missing.push({ source: `${path}:${line}`, command, file });
      }
    }
  }

  return missing;
}

function runbookMissingPackageScripts(path = 'docs/MBRAIN_VERIFY.md'): MissingScript[] {
  const scripts = packageScriptNames();
  return missingPackageScriptsFromCommands(
    scripts,
    linesWithBunCommands(path).map(({ line, command }) => ({ source: `${path}:${line}`, command })),
  );
}

function packageScriptsMissingPackageScripts(scripts: Record<string, string>): MissingScript[] {
  return missingPackageScriptsFromCommands(
    new Set(Object.keys(scripts)),
    Object.entries(scripts).map(([name, command]) => ({ source: `package.json scripts.${name}`, command })),
  );
}

function packageScriptMissingPackageScripts(packageJsonPath = 'package.json'): MissingScript[] {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, packageJsonPath), 'utf-8')) as {
    scripts?: Record<string, string>;
  };
  return packageScriptsMissingPackageScripts(packageJson.scripts ?? {});
}

function missingPackageScriptsFromCommands(
  scripts: Set<string>,
  commands: Array<{ source: string; command: string }>,
): MissingScript[] {
  const missing: MissingScript[] = [];

  for (const { source, command } of commands) {
    const tokens = command.split(/\s+/).map(stripShellSyntax);
    for (let i = 0; i < tokens.length - 2; i += 1) {
      if (tokens[i] !== 'bun' || tokens[i + 1] !== 'run') continue;
      const script = tokens[i + 2];
      if (!script || script.startsWith('-') || script.includes('/') || script.includes('=')) continue;
      if (!scripts.has(script)) {
        missing.push({ source, command, script });
      }
    }
  }

  return missing;
}

describe('verification runbook integrity', () => {
  test('detects missing package scripts referenced by package scripts', () => {
    expect(packageScriptsMissingPackageScripts({
      build: 'bun run build:schema && bun build src/cli.ts',
      'build:schema': 'bash scripts/build-schema.sh',
    })).toEqual([]);
    expect(packageScriptsMissingPackageScripts({
      build: 'bun run missing:schema && bun build src/cli.ts',
    })).toEqual([{
      source: 'package.json scripts.build',
      command: 'bun run missing:schema && bun build src/cli.ts',
      script: 'missing:schema',
    }]);
  });

  test('joins shell continuation lines before checking runbook commands', () => {
    expect(bunCommandsFromMarkdown('docs/example.md', [
      '```bash',
      'bun test test/one.test.ts \\',
      '  test/two.test.ts',
      '```',
    ].join('\n'))).toEqual([{
      line: 2,
      command: 'bun test test/one.test.ts test/two.test.ts',
    }]);
  });

  test('joins wrapped inline-code commands before checking runbook commands', () => {
    expect(bunCommandsFromMarkdown('docs/example.md', [
      'Descriptor hardening is covered by',
      '`bun test test/one.test.ts test/two.test.ts',
      'test/three.test.ts`: descriptors include titles.',
    ].join('\n'))).toEqual([{
      line: 2,
      command: 'bun test test/one.test.ts test/two.test.ts test/three.test.ts',
    }]);
  });

  test('parses multi-backtick inline-code commands before checking runbook references', () => {
    const commands = bunCommandsFromMarkdown(
      'docs/example.md',
      'Covered by ``bun run missing:script test/nope.test.ts`` <!-- runbook:executable -->.',
    );

    expect(commands).toEqual([{
      line: 1,
      command: 'bun run missing:script test/nope.test.ts',
    }]);
    expect(repoFileTokens(commands[0].command)).toEqual(['test/nope.test.ts']);
    expect(missingPackageScriptsFromCommands(new Set(), [{
      source: 'docs/example.md:1',
      command: commands[0].command,
    }])).toEqual([{
      source: 'docs/example.md:1',
      command: 'bun run missing:script test/nope.test.ts',
      script: 'missing:script',
    }]);
  });

  test('parses every inline-code command on the same line', () => {
    const text = 'Covered by `bun run typecheck` <!-- runbook:executable --> and `bun run missing:script test/nope.test.ts`.';
    const commands = bunCommandsFromMarkdown('docs/example.md', text);

    expect(commands).toEqual([
      { line: 1, command: 'bun run typecheck' },
      { line: 1, command: 'bun run missing:script test/nope.test.ts' },
    ]);
    expect(missingInlineCommandClassificationsFromText(text)).toEqual([{
      source: 'docs/example.md:1',
      command: 'bun run missing:script test/nope.test.ts',
      script: 'runbook:<class>',
    }]);
    expect(repoFileTokens(commands[1].command)).toEqual(['test/nope.test.ts']);
    expect(missingPackageScriptsFromCommands(new Set(['typecheck']), [{
      source: 'docs/example.md:1',
      command: commands[1].command,
    }])).toEqual([{
      source: 'docs/example.md:1',
      command: 'bun run missing:script test/nope.test.ts',
      script: 'missing:script',
    }]);
  });

  test('parses every runnable command inside one inline-code span', () => {
    const text = 'Covered by `bun run typecheck && bun run missing:script test/nope.test.ts` <!-- runbook:executable -->.';
    const commands = bunCommandsFromMarkdown('docs/example.md', text);

    expect(commands).toEqual([
      { line: 1, command: 'bun run typecheck' },
      { line: 1, command: 'bun run missing:script test/nope.test.ts' },
    ]);
    expect(missingInlineCommandClassificationsFromText(text)).toEqual([{
      source: 'docs/example.md:1',
      command: 'bun run typecheck',
      script: 'runbook:<class>',
    }]);
    expect(missingPackageScriptsFromCommands(new Set(['typecheck']), [{
      source: 'docs/example.md:1',
      command: commands[1].command,
    }])).toEqual([{
      source: 'docs/example.md:1',
      command: 'bun run missing:script test/nope.test.ts',
      script: 'missing:script',
    }]);
  });

  test('does not let a marker after a later inline command classify an earlier command', () => {
    const text = 'Covered by `bun run typecheck` and `bun run build` <!-- runbook:executable -->.';

    expect(missingInlineCommandClassificationsFromText(text)).toEqual([{
      source: 'docs/example.md:1',
      command: 'bun run typecheck',
      script: 'runbook:<class>',
    }]);
  });

  test('normalizes grouped shell tokens before checking file and script refs', () => {
    const command = '(bun run missing:script test/nope.test.ts)';

    expect(repoFileTokens(command)).toEqual(['test/nope.test.ts']);
    expect(missingPackageScriptsFromCommands(new Set(), [{ source: 'docs/example.md:1', command }])).toEqual([{
      source: 'docs/example.md:1',
      command,
      script: 'missing:script',
    }]);
  });

  test('normalizes quoted grouped relative file tokens before checking file refs', () => {
    expect(repoFileTokens('bun run typecheck ("./test/nope.test.ts")')).toEqual(['test/nope.test.ts']);
  });

  test('finds prose inline-code commands after earlier inline-code spans', () => {
    expect(bunCommandsFromMarkdown('docs/example.md', [
      'Markdown import, bounded `mbrain call get_page`, `bun run test:phase13`, and',
      '`doctor --json`.',
    ].join('\n'))).toEqual([{
      line: 1,
      command: 'bun run test:phase13',
    }]);
  });

  test('requires every runbook bash fence to carry an explicit classification', () => {
    expect(markdownFences([
      '```bash runbook:executable',
      'bun run typecheck',
      '```',
      '   ````bash runbook:manual',
      'mbrain stats',
      '   ````',
      '```bash runbook:manual-typo',
      'mbrain stats',
      '```',
      '```bash not-runbook:manual',
      'mbrain stats',
      '```',
      '````bash',
      'mbrain stats',
      '````',
      '~~~bash runbook:external',
      'gh run watch 123',
      '~~~',
      '~~~bash',
      'echo bypass',
      '~~~',
      '```text `invalid-commonmark-opener',
      '```sh',
      'echo bypass',
      '```',
      '```shell runbook:manual',
      'mbrain stats',
      '```',
      '```zsh runbook:external',
      'gh run watch 123',
      '```',
      '```bash runbook:executable',
      'bun run typecheck',
    ].join('\n'))).toEqual([
      { closed: true, line: 1, endLine: 3, info: 'bash runbook:executable', language: 'bash', runbookClassification: 'executable' },
      { closed: true, line: 4, endLine: 6, info: 'bash runbook:manual', language: 'bash', runbookClassification: 'manual' },
      { closed: true, line: 7, endLine: 9, info: 'bash runbook:manual-typo', language: 'bash', runbookClassification: null },
      { closed: true, line: 10, endLine: 12, info: 'bash not-runbook:manual', language: 'bash', runbookClassification: null },
      { closed: true, line: 13, endLine: 15, info: 'bash', language: 'bash', runbookClassification: null },
      { closed: true, line: 16, endLine: 18, info: 'bash runbook:external', language: 'bash', runbookClassification: 'external' },
      { closed: true, line: 19, endLine: 21, info: 'bash', language: 'bash', runbookClassification: null },
      { closed: true, line: 23, endLine: 25, info: 'sh', language: 'sh', runbookClassification: null },
      { closed: true, line: 26, endLine: 28, info: 'shell runbook:manual', language: 'shell', runbookClassification: 'manual' },
      { closed: true, line: 29, endLine: 31, info: 'zsh runbook:external', language: 'zsh', runbookClassification: 'external' },
      { closed: false, line: 32, endLine: 33, info: 'bash runbook:executable', language: 'bash', runbookClassification: 'executable' },
    ]);
    expect(missingRunbookClassificationsFromText([
      '```bash runbook:executable',
      'bun run typecheck',
    ].join('\n'))).toEqual([{
      source: 'docs/example.md:1',
      info: 'bash runbook:executable',
    }]);
    expect(missingRunbookClassifications()).toEqual([]);
  });

  test('requires inline runbook commands outside shell fences to carry an explicit classification', () => {
    expect(missingInlineCommandClassificationsFromText([
      'Covered by `bun run test:phase13`.',
      'Covered by `bun test test/one.test.ts` <!-- runbook:executable -->.',
      '```bash runbook:executable',
      'bun run typecheck',
      '```',
    ].join('\n'))).toEqual([{
      source: 'docs/example.md:1',
      command: 'bun run test:phase13',
      script: 'runbook:<class>',
    }]);
  });

  test('package scripts reference existing repo-local files', () => {
    expect(packageScriptMissingReferences()).toEqual([]);
    expect(packageScriptMissingPackageScripts()).toEqual([]);
  });

  test('verification runbook references existing repo-local files and package scripts', () => {
    expect(runbookMissingFileReferences()).toEqual([]);
    expect(runbookMissingPackageScripts()).toEqual([]);
    expect(missingInlineCommandClassifications()).toEqual([]);
  });
});
