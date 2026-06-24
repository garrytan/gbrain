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
    .replace(/^\.\//, '')
    .replace(/^['"]|['"]$/g, '')
    .replace(/[,;|&]+$/g, '')
    .replace(/^`|`$/g, '');
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

function commandFromParts(parts: string[]): string {
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

function inlineCommandSegment(text: string): { closed: boolean; segment: string } {
  const closingTick = text.indexOf('`');
  if (closingTick === -1) return { closed: false, segment: text.trim() };
  return { closed: true, segment: text.slice(0, closingTick).trim() };
}

function inlineCommandStart(line: string): { closed: boolean; segment: string } | null {
  let searchIndex = 0;

  while (searchIndex < line.length) {
    const openingTick = line.indexOf('`', searchIndex);
    if (openingTick === -1) return null;

    const afterOpeningTick = line.slice(openingTick + 1);
    const closingTick = afterOpeningTick.indexOf('`');
    const segment = closingTick === -1
      ? afterOpeningTick.trim()
      : afterOpeningTick.slice(0, closingTick).trim();

    if (/\bbun\s+(run|test)\b/.test(segment)) {
      return { closed: closingTick !== -1, segment };
    }

    if (closingTick === -1) return null;
    searchIndex = openingTick + closingTick + 2;
  }

  return null;
}

function bunCommandsFromMarkdown(_path: string, text: string): Array<{ line: number; command: string }> {
  const commands: Array<{ line: number; command: string }> = [];
  let pending: { line: number; mode: 'inline' | 'shell'; parts: string[] } | null = null;

  const pushPending = () => {
    if (!pending) return;
    commands.push({ line: pending.line, command: commandFromParts(pending.parts) });
    pending = null;
  };

  text
    .split('\n')
    .forEach((line, index) => {
      const lineNumber = index + 1;
      const trimmed = line.trim();
      const withoutContinuation = trimmed.replace(/\\$/, '').trim();

      if (pending) {
        if (pending.mode === 'inline') {
          const { closed, segment } = inlineCommandSegment(trimmed);
          pending.parts.push(segment);
          if (closed) pushPending();
          return;
        }

        pending.parts.push(withoutContinuation);
        if (!trimmed.endsWith('\\')) pushPending();
        return;
      }

      const inlineStart = inlineCommandStart(trimmed);
      if (inlineStart) {
        pending = { line: lineNumber, mode: 'inline', parts: [inlineStart.segment] };
        if (inlineStart.closed) pushPending();
        return;
      }

      if (!/\bbun\s+(run|test)\b/.test(trimmed)) return;
      pending = { line: lineNumber, mode: 'shell', parts: [withoutContinuation] };
      if (!trimmed.endsWith('\\')) pushPending();
    });

  pushPending();
  return commands;
}

function linesWithBunCommands(path: string): Array<{ line: number; command: string }> {
  return bunCommandsFromMarkdown(path, readFileSync(join(repoRoot, path), 'utf-8'));
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

  test('finds prose inline-code commands after earlier inline-code spans', () => {
    expect(bunCommandsFromMarkdown('docs/example.md', [
      'Markdown import, `projection-explain`, `bun run test:phase13`, and',
      '`doctor --json`.',
    ].join('\n'))).toEqual([{
      line: 1,
      command: 'bun run test:phase13',
    }]);
  });

  test('package scripts reference existing repo-local files', () => {
    expect(packageScriptMissingReferences()).toEqual([]);
    expect(packageScriptMissingPackageScripts()).toEqual([]);
  });

  test('verification runbook references existing repo-local files and package scripts', () => {
    expect(runbookMissingFileReferences()).toEqual([]);
    expect(runbookMissingPackageScripts()).toEqual([]);
  });
});
