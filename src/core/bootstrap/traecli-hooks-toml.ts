/** Marker-owned hook writer for TraeCLI's user-global traecli.toml. */

import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { atomicWriteTextFile } from './atomic-write.ts';
import { isAdoptableLegacyHookCommand } from './hooks.ts';
import {
  CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS,
  CLAUDE_HOOK_SUBCOMMAND,
  COMMON_HOOK_EVENTS,
  GBRAIN_MULTI_HOST_HOOK_MARKER_VALUE,
  type ClaudeHookEvent,
} from './host-specs.ts';

export const TRAECLI_HOOK_BLOCK_BEGIN =
  '# gbrain:' + GBRAIN_MULTI_HOST_HOOK_MARKER_VALUE + ' begin - managed by gbrain bootstrap hooks; do not edit inside';
export const TRAECLI_HOOK_BLOCK_END = '# gbrain:' + GBRAIN_MULTI_HOST_HOOK_MARKER_VALUE + ' end';
const FEATURE_MARKER = '# gbrain:' + GBRAIN_MULTI_HOST_HOOK_MARKER_VALUE;

export interface TraeCliHookWriteOptions {
  gbrainBin: string;
  sourceId: string;
  brainId?: string;
  gbrainHome?: string;
  repair?: boolean;
  dryRun?: boolean;
}

export interface TraeCliHookWriteResult {
  configPath: string;
  installed: Array<{ event: ClaudeHookEvent; command: string }>;
  replacedPrior: boolean;
  backupPath: string | null;
  notes: string[];
}

export interface TraeCliHookRemoveResult {
  configPath: string;
  removed: boolean;
  backupPath: string | null;
  notes: string[];
}

function tomlString(value: string): string {
  if (/[\n\r\0]/.test(value)) throw new Error('control characters are not allowed in TraeCLI hook values');
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_.:/@=-]+$/.test(arg)) return arg;
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

export function buildTraeCliHookCommand(event: ClaudeHookEvent, opts: TraeCliHookWriteOptions): string {
  const env = [
    'GBRAIN_SOURCE=' + opts.sourceId,
    ...(opts.brainId ? ['GBRAIN_BRAIN_ID=' + opts.brainId] : []),
    'GBRAIN_HARNESS=traecli',
    ...(opts.gbrainHome ? ['GBRAIN_HOME=' + opts.gbrainHome] : []),
  ];
  return ['env', ...env, opts.gbrainBin, 'hook', CLAUDE_HOOK_SUBCOMMAND[event], '--harness', 'traecli']
    .map(shellQuote)
    .join(' ');
}

function stripLegacyGroups(
  text: string,
  opts: TraeCliHookWriteOptions,
): { text: string; found: number } {
  const lines = text.split('\n');
  const starts: number[] = [];
  lines.forEach((line, index) => {
    // First-level matcher groups delimit one another. Nested
    // [[hooks.<Event>.hooks]] handlers stay inside their parent chunk.
    if (/^\s*\[\[hooks\.[^.\]]+\]\]\s*$/.test(line)) starts.push(index);
  });
  let found = 0;
  const remove = new Set<number>();
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i]!;
    const nextHook = starts[i + 1] ?? lines.length;
    let end = nextHook;
    for (let line = start + 1; line < nextHook; line++) {
      if (/^\s*\[(?!\[)/.test(lines[line]!)) {
        end = line;
        break;
      }
    }
    const chunkLines = lines.slice(start, end);
    const eventMatch = /^\s*\[\[hooks\.(SessionStart|UserPromptSubmit|Stop)\]\]\s*$/.exec(chunkLines[0]!);
    const event = eventMatch?.[1] as ClaudeHookEvent | undefined;
    if (!event) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = (Bun as unknown as { TOML: { parse(t: string): Record<string, unknown> } }).TOML.parse(chunkLines.join('\n'));
    } catch {
      continue;
    }
    const groups = ((parsed.hooks as Record<string, unknown> | undefined)?.[event] ?? []) as Array<Record<string, unknown>>;
    const entries = groups.length === 1 && Array.isArray(groups[0]?.hooks) ? groups[0]!.hooks as Array<Record<string, unknown>> : [];
    const commands = entries
      .filter((entry) => entry?.type === 'command' && typeof entry.command === 'string')
      .map((entry) => entry.command as string);
    const gbrainLike = commands.filter((command) =>
      /(?:\/src\/cli\.ts["']?|\/gbrain["']?|(?:^|\s)gbrain)\s+hook\s+/.test(command),
    );
    if (gbrainLike.length === 0) continue;
    if (entries.length !== 1 || gbrainLike.length !== 1 ||
        !isAdoptableLegacyHookCommand(gbrainLike[0]!, event, 'traecli', opts.sourceId)) {
      throw new Error(
        'traecli.toml contains an ambiguous gbrain hook for hooks.' + event +
          '; its source, harness, event, or group shape does not match this repair. ' +
          'Refusing to append a duplicate; inspect or remove that entry explicitly.',
      );
    }
    found++;
    for (let line = start; line < end; line++) remove.add(line);
  }
  if (found > 0 && !opts.repair) {
    throw new Error(
      'traecli.toml contains ' + found + ' legacy gbrain hook ' + (found === 1 ? 'entry' : 'entries') +
        '; re-run with --repair to adopt them without double-firing.',
    );
  }
  return { text: lines.filter((_line, index) => !remove.has(index)).join('\n'), found };
}

function findBlock(lines: string[]): { begin: number; end: number } {
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, i) => {
    if (line === TRAECLI_HOOK_BLOCK_BEGIN) begins.push(i);
    if (line === TRAECLI_HOOK_BLOCK_END) ends.push(i);
  });
  if (begins.length === 0 && ends.length === 0) return { begin: -1, end: -1 };
  if (begins.length !== 1 || ends.length !== 1 || begins[0]! > ends[0]!) {
    throw new Error(
      'the gbrain-managed hook markers in traecli.toml are damaged (' + begins.length +
        ' begin / ' + ends.length + ' end) — fix the markers or delete the whole block, then re-run.',
    );
  }
  return { begin: begins[0]!, end: ends[0]! };
}

function stripOwned(text: string): { text: string; hadBlock: boolean; hadFeatureLine: boolean; crlf: boolean } {
  const crlf = text.includes('\r\n');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const span = findBlock(lines);
  const withoutBlock = span.begin < 0 ? lines : [...lines.slice(0, span.begin), ...lines.slice(span.end + 1)];
  let hadFeatureLine = false;
  const kept = withoutBlock.filter((line) => {
    if (/^\s*hooks\s*=\s*true\s*#\s*gbrain:bootstrap-hooks-v1\s*$/.test(line)) {
      hadFeatureLine = true;
      return false;
    }
    return true;
  });
  return { text: kept.join('\n'), hadBlock: span.begin >= 0, hadFeatureLine, crlf };
}

function parseToml(text: string, configPath: string): Record<string, unknown> {
  try {
    const parsed = (Bun as unknown as { TOML: { parse(t: string): unknown } }).TOML.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('root is not a TOML table');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      configPath + ' is not valid TOML (' + (error as Error).message + ') — refusing to rewrite a config ' +
        'gbrain cannot parse. Fix it by hand, then re-run with --repair.',
    );
  }
}

function enableHooks(text: string, parsed: Record<string, unknown>, configPath: string): string {
  const features = parsed.features;
  if (features !== undefined && (typeof features !== 'object' || features === null || Array.isArray(features))) {
    throw new Error(configPath + ': features is not a TOML table — refusing to rewrite it.');
  }
  const hooks = (features as Record<string, unknown> | undefined)?.hooks;
  if (hooks === false) {
    throw new Error(
      configPath + ': features.hooks is explicitly false — refusing to override the user setting. ' +
        'Enable it manually, then re-run with --repair.',
    );
  }
  if (hooks === true) return text;
  if (hooks !== undefined) throw new Error(configPath + ': features.hooks is not boolean — refusing to rewrite it.');

  const lines = text.split('\n');
  const header = lines.findIndex((line) => /^\s*\[features\]\s*(?:#.*)?$/.test(line));
  if (header >= 0) {
    lines.splice(header + 1, 0, 'hooks = true ' + FEATURE_MARKER);
    return lines.join('\n');
  }
  const trimmed = text.replace(/\n+$/, '');
  return trimmed + (trimmed ? '\n\n' : '') + '[features]\nhooks = true ' + FEATURE_MARKER + '\n';
}

function renderBlock(opts: TraeCliHookWriteOptions): { lines: string[]; installed: TraeCliHookWriteResult['installed'] } {
  const installed = COMMON_HOOK_EVENTS.map((event) => ({ event, command: buildTraeCliHookCommand(event, opts) }));
  const lines = [TRAECLI_HOOK_BLOCK_BEGIN];
  for (const item of installed) {
    lines.push(
      '[[hooks.' + item.event + ']]',
      '[[hooks.' + item.event + '.hooks]]',
      'type = "command"',
      'command = ' + tomlString(item.command),
      'timeout = ' + CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS[item.event],
      '',
    );
  }
  while (lines.at(-1) === '') lines.pop();
  lines.push(TRAECLI_HOOK_BLOCK_END);
  return { lines, installed };
}

function writeToml(configPath: string, unixText: string, crlf: boolean): void {
  atomicWriteTextFile(configPath, crlf ? unixText.replace(/\n/g, '\r\n') : unixText, { freshMode: 0o600 });
}

export function writeTraeCliHooks(configPath: string, opts: TraeCliHookWriteOptions): TraeCliHookWriteResult {
  if (!isAbsolute(opts.gbrainBin)) throw new Error('gbrainBin must be an absolute path; got: ' + opts.gbrainBin);
  let raw = '';
  const existed = existsSync(configPath);
  if (existed) raw = readFileSync(configPath, 'utf8');
  const stripped = stripOwned(raw);
  const legacy = stripLegacyGroups(stripped.text, opts);
  let remainder = legacy.text;
  const parsed = parseToml(remainder, configPath);
  remainder = enableHooks(remainder, parsed, configPath);
  const rendered = renderBlock(opts);
  const base = remainder.replace(/\n+$/, '');
  const next = base + (base ? '\n\n' : '') + rendered.lines.join('\n') + '\n';
  parseToml(next, configPath);

  let backupPath: string | null = null;
  if (!opts.dryRun && existed) {
    backupPath = configPath + '.bak-' + Date.now();
    copyFileSync(configPath, backupPath);
  }
  if (!opts.dryRun) writeToml(configPath, next, stripped.crlf);
  return {
    configPath,
    installed: rendered.installed,
    replacedPrior: stripped.hadBlock,
    backupPath,
    notes: [
      ...(stripped.hadFeatureLine ? ['refreshed the gbrain-owned features.hooks activation'] : []),
      ...(legacy.found > 0 ? ['adopted ' + legacy.found + ' legacy TraeCLI hook ' + (legacy.found === 1 ? 'entry' : 'entries')] : []),
    ],
  };
}

export function removeTraeCliHooks(configPath: string): TraeCliHookRemoveResult {
  if (!existsSync(configPath)) {
    return { configPath, removed: false, backupPath: null, notes: ['no traecli.toml — nothing to remove'] };
  }
  const raw = readFileSync(configPath, 'utf8');
  const stripped = stripOwned(raw);
  if (!stripped.hadBlock && !stripped.hadFeatureLine) {
    return { configPath, removed: false, backupPath: null, notes: ['no gbrain-managed hooks — nothing to remove'] };
  }
  const next = stripped.text.replace(/\n{3,}/g, '\n\n');
  parseToml(next, configPath);
  const backupPath = configPath + '.bak-' + Date.now();
  copyFileSync(configPath, backupPath);
  writeToml(configPath, next, stripped.crlf);
  return { configPath, removed: true, backupPath, notes: [] };
}
