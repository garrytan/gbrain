/**
 * Skill drift and size analysis (pure). A skill is the instruction an agent
 * follows, so a `gbrain` invocation it shows must run as written and a tool
 * it declares must exist. The caller supplies the CLI surface (the same
 * validators the dispatcher runs, see src/cli/skill-surface.ts), so this
 * module never reads the repository or executes the CLI.
 */

export type DriftCode =
  | 'SKILL_DRIFT_UNKNOWN_SUBCOMMAND'
  | 'SKILL_DRIFT_UNKNOWN_FLAG'
  | 'SKILL_DRIFT_UNKNOWN_TOOL';

export interface DriftFinding {
  code: DriftCode;
  file: string;
  line: number;
  token: string;
  snippet: string;
  suggestion?: string;
  remedy: string;
}

export interface CliSurface {
  isCommand(name: string): boolean;
  /** Declared subcommands, or undefined when the command dispatches them by hand (not verifiable). */
  subcommands(command: string): readonly string[] | undefined;
  /** argv after global flags are stripped; argv[0] is the command. */
  stripGlobalFlags(argv: string[]): string[];
  /** The dispatcher's own unknown-flag check: the first unknown flag, or null. */
  unknownFlag(command: string, args: string[]): string | null;
  legalFlags(command: string): readonly string[];
  isOperation(name: string): boolean;
  operationNames(): readonly string[];
}

export interface Invocation {
  line: number;
  argv: string[];
  snippet: string;
}

export interface DriftReport {
  findings: DriftFinding[];
  invocations: number;
  /** Invocations of commands whose subcommands are not declared, so only their flags were checked. */
  subcommandUnverified: number;
}

const SHELL_FENCES = new Set(['', 'bash', 'sh', 'shell', 'zsh', 'console']);
const IGNORE_MARKER = '<!-- skill-drift-ok';
const GBRAIN_AT = /(?:^|[|&;(]|\$\()\s*(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:(?:nohup|exec|time)\s+)?gbrain\s+/g;
const HOST_TOOLS = new Set(['web_fetch', 'web_search']);

function splitShell(text: string): { words: string[]; rest: string } {
  const words: string[] = [];
  let word = '';
  let quote: string | null = null;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; continue; }
    if (c === '<' && /[a-z]/i.test(text[i + 1] ?? '')) {
      const close = text.indexOf('>', i);
      if (close > i) { word += text.slice(i, close + 1); started = true; i = close; continue; }
    }
    const two = text.slice(i, i + 2);
    if (c === '|' || c === ';' || c === '>' || c === '<' || c === ')' || two === '&&' || c === '#' && (i === 0 || /\s/.test(text[i - 1]!))) {
      if (started) words.push(word);
      return { words, rest: text.slice(i) };
    }
    if (/\s/.test(c)) {
      if (started) words.push(word);
      word = '';
      started = false;
      continue;
    }
    word += c;
    started = true;
  }
  if (started) words.push(word);
  return { words, rest: '' };
}

const isPlaceholder = (t: string) => /[<>{}]|\.\.\.|…/.test(t);

function invocationsIn(text: string, line: number, out: Invocation[]): void {
  for (const m of text.matchAll(GBRAIN_AT)) {
    const start = m.index! + m[0].length;
    const { words } = splitShell(text.slice(start));
    if (!words.length || isPlaceholder(words[0]!)) continue;
    out.push({ line, argv: words, snippet: `gbrain ${words.join(' ')}`.trim() });
  }
}

/** Every `gbrain ...` invocation in shell fences and inline code spans, with its 1-based line. */
export function extractInvocations(markdown: string): Invocation[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const out: Invocation[] = [];
  let fence: { marker: string; shell: boolean } | null = null;
  let frontmatter = lines[0] === '---';
  for (let i = frontmatter ? 1 : 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (frontmatter) { if (raw === '---') frontmatter = false; continue; }
    const fenceMatch = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(raw);
    if (fenceMatch) {
      if (!fence) fence = { marker: fenceMatch[1]!, shell: SHELL_FENCES.has(fenceMatch[2]!.toLowerCase()) };
      else if (raw.trim().startsWith(fence.marker)) fence = null;
      continue;
    }
    if (raw.includes(IGNORE_MARKER) || (lines[i - 1] ?? '').includes(IGNORE_MARKER)) continue;
    if (fence) {
      if (!fence.shell) continue;
      let text = raw.replace(/^\s*\$\s+/, '');
      const first = i;
      while (text.endsWith('\\') && i + 1 < lines.length) text = text.slice(0, -1) + ' ' + lines[++i]!.trim();
      invocationsIn(text, first + 1, out);
      continue;
    }
    for (const span of raw.matchAll(/(`+)([^`]+?)\1/g)) invocationsIn(span[2]!, i + 1, out);
  }
  return out;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** The closest candidate, when it is close enough to be the intended name. */
export function nearest(token: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = distance(token, c);
    if (d < bestD) { best = c; bestD = d; }
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(token.length / 3)) ? best : undefined;
}

function frontmatterTools(markdown: string): { line: number; tool: string }[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  if (lines[0] !== '---') return [];
  const out: { line: number; tool: string }[] = [];
  let inTools = false;
  for (let i = 1; i < lines.length && lines[i] !== '---'; i++) {
    const l = lines[i]!;
    const inline = /^tools:\s*\[(.*)\]\s*$/.exec(l);
    if (inline) { for (const t of inline[1]!.split(',')) if (t.trim()) out.push({ line: i + 1, tool: t.trim().replace(/^["']|["']$/g, '') }); continue; }
    if (/^tools:\s*$/.test(l)) { inTools = true; continue; }
    if (inTools) {
      const item = /^\s+-\s*(.+?)\s*$/.exec(l);
      if (item) out.push({ line: i + 1, tool: item[1]!.replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '') });
      else if (!/^\s*$/.test(l)) inTools = false;
    }
  }
  return out;
}

/** Drift findings for one skill file (path is for reporting only). */
export function analyzeSkillDrift(file: string, markdown: string, surface: CliSurface): DriftReport {
  const findings: DriftFinding[] = [];
  let invocations = 0;
  let subcommandUnverified = 0;
  for (const inv of extractInvocations(markdown)) {
    let argv: string[];
    try {
      argv = surface.stripGlobalFlags(inv.argv.filter(t => !/^(\.\.\.|…)$/.test(t) && !(t.startsWith('-') && isPlaceholder(t))).map(t => isPlaceholder(t) ? 'placeholder' : t));
    } catch {
      continue;
    }
    const command = argv[0];
    if (!command || command.startsWith('-') || !surface.isCommand(command)) continue;
    invocations++;
    const declared = surface.subcommands(command);
    const sub = inv.argv[inv.argv.indexOf(command) + 1];
    if (!declared) subcommandUnverified++;
    else if (sub && !sub.startsWith('-') && sub !== 'help' && !isPlaceholder(sub) && !declared.includes(sub)) {
      const suggestion = nearest(sub, declared);
      findings.push({
        code: 'SKILL_DRIFT_UNKNOWN_SUBCOMMAND', file, line: inv.line, token: `${command} ${sub}`, snippet: inv.snippet, suggestion: suggestion && `${command} ${suggestion}`,
        remedy: `name a real subcommand of ${command} (${declared.join(', ')})${suggestion ? `; did you mean '${command} ${suggestion}'` : ''}, or restore the subcommand in the CLI`,
      });
      continue;
    }
    const unknown = surface.unknownFlag(command, argv.slice(1));
    if (unknown) {
      const suggestion = nearest(unknown, surface.legalFlags(command));
      findings.push({
        code: 'SKILL_DRIFT_UNKNOWN_FLAG', file, line: inv.line, token: `${command} ${unknown}`, snippet: inv.snippet, suggestion,
        remedy: `${command} rejects ${unknown}${suggestion ? `; did you mean ${suggestion}` : ''}. Edit the line, or restore the flag in the CLI (the command's --help lists its flags)`,
      });
    }
  }
  for (const { line, tool } of frontmatterTools(markdown)) {
    const name = tool.replace(/^mcp:/, '');
    const opShaped = tool.startsWith('mcp:') || /^[a-z]+(?:_[a-z]+)+$/.test(name);
    if (!opShaped || HOST_TOOLS.has(name) || surface.isOperation(name)) continue;
    const suggestion = nearest(name, surface.operationNames());
    findings.push({
      code: 'SKILL_DRIFT_UNKNOWN_TOOL', file, line, token: tool, snippet: `tools: ${tool}`, suggestion,
      remedy: `'${name}' is not a gbrain operation${suggestion ? `; did you mean ${suggestion}` : ''}. Declare a real operation or a host tool (shell, web_search, ...)`,
    });
  }
  return { findings, invocations, subcommandUnverified };
}

/** Size of a skill's frontmatter `description:` value in bytes (0 when absent). */
export function descriptionBytes(markdown: string): number {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1];
  if (!fm) return 0;
  const m = /^description:([\s\S]*?)(?=^[A-Za-z_][\w-]*:|(?![\s\S]))/m.exec(fm);
  return m ? Buffer.byteLength(m[1]!.trim()) : 0;
}
