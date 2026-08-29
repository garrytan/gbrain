/**
 * codex-toml.ts — managed marker-block writer for Codex's config.toml
 * (#4043, the fired CX2-17 revisit; see TARGETS['codex-2026-08'] in
 * host-specs.ts for the verified format assumptions).
 *
 * Why a direct writer exists at all: `codex mcp add` cannot express an
 * inline credential (only `--bearer-token-env-var`, which reintroduces
 * the shell-profile dependency framework-spawned codex lacks), so the
 * harness lane owns exactly one `[mcp_servers.<name>]` table between two
 * full-line comment markers. Everything outside the markers survives
 * byte-for-byte. The credential is emitted as
 * `http_headers = { Authorization = "Bearer <token>" }` — codex-cli >=0.149
 * rejects an inline `bearer_token` for streamable_http AT CONFIG LOAD
 * (bricking every codex session, #4574), while the http_headers inline-table
 * shape loads on 0.147.x AND 0.149.x (reporter probe in #4574).
 *
 * Safety invariants [C10 + adversarial-verify corrections]:
 * - Foreign-server detection parses the file (Bun.TOML.parse) with our block
 *   stripped — a header-only regex false-negatives inline tables, dotted
 *   keys, and quoted headers, and a duplicate table definition is a HARD
 *   TOML parse error that bricks codex outright.
 * - Rewrites REMOVE the old block and RE-ANCHOR at EOF (refusing on trailing
 *   content would let any later legitimate codex write permanently block
 *   update/removal; at EOF our table can never absorb someone else's keys).
 * - The rendered output is parse-validated BEFORE rename, and our table's
 *   keys are asserted to be exactly what we wrote; on any failure the
 *   original file is kept.
 * - Exactly one begin/end pair, in order, full-line match — anything else is
 *   a hand-edit; refuse rather than guess.
 * - Secrets hygiene: tmp file created 0600 with a random suffix, the target
 *   is chmod'd 0600 (it carries a bearer token), and the .bak is chmod'd
 *   0600 (on re-runs it carries the PREVIOUS token).
 * - CRLF configs are scanned with `\r` stripped and re-emitted with their
 *   dominant EOL; a missing trailing newline is repaired before append so a
 *   marker can never glue onto the last line (the run-2 duplicate-append
 *   brick).
 */

import { chmodSync, copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { atomicWriteTextFile } from './atomic-write.ts';
import { CODEX_TOML_BLOCK_BEGIN, CODEX_TOML_BLOCK_END } from './host-specs.ts';

export interface CodexHttpServerBlock {
  /** MCP server name — bare-key charset only (goes into a table header). */
  name: string;
  /** Streamable-HTTP MCP endpoint url (normalized upstream). */
  url: string;
  /** Bearer token written inline as `http_headers.Authorization` (the whole
   * point of the direct writer; codex-cli >=0.149 rejects `bearer_token`). */
  bearerToken: string;
}

export interface WriteCodexBlockResult {
  configPath: string;
  /** True when a prior managed block was replaced (idempotent re-run). */
  replacedPrior: boolean;
  backupPath: string | null;
  notes: string[];
}

export interface RemoveCodexBlockResult {
  configPath: string;
  removed: boolean;
  backupPath: string | null;
  notes: string[];
}

/** Escape a value for a TOML basic string. */
export function tomlString(value: string): string {
  if (/[\n\r\0\t]/.test(value)) {
    throw new Error('control characters are not allowed in codex config values');
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function assertBareKeyName(name: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new Error(
      `MCP server name "${name}" is not a bare TOML key ([A-Za-z0-9_-]+) — pick a simpler --name`,
    );
  }
}

interface BlockSpan {
  /** Line index of the begin marker, or -1 when absent. */
  begin: number;
  /** Line index of the end marker, or -1 when absent. */
  end: number;
}

/**
 * Locate the managed block in \n-normalized lines. Throws on marker
 * anomalies (duplicates, out of order, one without the other) — those are
 * hand-edits we must not guess through.
 */
function findBlock(lines: string[]): BlockSpan {
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, i) => {
    if (line === CODEX_TOML_BLOCK_BEGIN) begins.push(i);
    if (line === CODEX_TOML_BLOCK_END) ends.push(i);
  });
  if (begins.length === 0 && ends.length === 0) return { begin: -1, end: -1 };
  if (begins.length !== 1 || ends.length !== 1 || begins[0] > ends[0]) {
    throw new Error(
      `the gbrain-managed block markers in this config.toml are damaged ` +
        `(${begins.length} begin / ${ends.length} end${begins.length === 1 && ends.length === 1 ? ', out of order' : ''}) — ` +
        `the file was hand-edited inside the managed region. Fix the markers (or delete the whole block) and re-run.`,
    );
  }
  return { begin: begins[0], end: ends[0] };
}

function stripBlock(lines: string[]): { remainder: string[]; hadBlock: boolean } {
  const span = findBlock(lines);
  if (span.begin === -1) return { remainder: lines, hadBlock: false };
  const remainder = [...lines.slice(0, span.begin), ...lines.slice(span.end + 1)];
  return { remainder, hadBlock: true };
}

function parseToml(text: string): Record<string, unknown> {
  // Bun.TOML is available in this runtime (no dependency added).
  const parsed = (Bun as unknown as { TOML: { parse(t: string): unknown } }).TOML.parse(text);
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('config.toml did not parse to a table');
  }
  return parsed as Record<string, unknown>;
}

/**
 * True when `[mcp_servers.<name>]` is defined OUTSIDE our managed block, in
 * ANY toml spelling (header, inline table, dotted key, quoted header,
 * array-of-tables). Throws when the surrounding config does not parse —
 * appending to a broken file could only deepen the damage.
 */
export function detectForeignCodexServer(configText: string, name: string): boolean {
  const lines = configText.replace(/\r\n/g, '\n').split('\n');
  const { remainder } = stripBlock(lines);
  const parsed = parseToml(remainder.join('\n'));
  const servers = parsed.mcp_servers;
  if (typeof servers !== 'object' || servers === null) return false;
  return (servers as Record<string, unknown>)[name] !== undefined;
}

function renderBlock(block: CodexHttpServerBlock): string[] {
  // http_headers inline table, NOT `bearer_token`: codex-cli >=0.149 rejects
  // bearer_token for streamable_http at config load (#4574); this shape loads
  // on 0.147.x and 0.149.x.
  return [
    CODEX_TOML_BLOCK_BEGIN,
    `[mcp_servers.${block.name}]`,
    `url = ${tomlString(block.url)}`,
    `http_headers = { Authorization = ${tomlString(`Bearer ${block.bearerToken}`)} }`,
    CODEX_TOML_BLOCK_END,
  ];
}

/** Post-render assertion shared by the writer and the snippet renderer: our
 * table's keys are EXACTLY [http_headers, url], and the http_headers inline
 * table carries EXACTLY the Authorization header we wrote. Returns an error
 * string (caller prefixes its own context) or null when valid. */
function validateOurKeys(ours: unknown): string | null {
  const ourKeys = typeof ours === 'object' && ours !== null ? Object.keys(ours as object).sort() : [];
  if (ourKeys.join(',') !== 'http_headers,url') {
    return `keys are [${ourKeys.join(', ')}], expected exactly [http_headers, url]`;
  }
  const headers = (ours as Record<string, unknown>).http_headers;
  const headerKeys = typeof headers === 'object' && headers !== null ? Object.keys(headers as object) : [];
  if (headerKeys.join(',') !== 'Authorization') {
    return `http_headers keys are [${headerKeys.join(', ')}], expected exactly [Authorization]`;
  }
  return null;
}

/**
 * Render the `[mcp_servers.<name>]` table as a paste-ready snippet WITHOUT
 * the CODEX_TOML_BLOCK_BEGIN/END lines. The managed markers are SINGLETON —
 * findBlock refuses duplicate marker pairs and writeCodexHttpServerBlock
 * strips any prior managed block on rewrite — so a printed snippet carrying
 * markers would later be stripped or rejected by the writer. A marker-free
 * snippet stays ordinary user content: a later managed write sees it as a
 * FOREIGN table and refuses to double-define rather than silently absorbing
 * it.
 *
 * Validation mirrors the writer: the bare-key name assertion up front, then
 * the rendered text is parsed back and our table's keys are asserted to be
 * exactly [http_headers, url] (the same key-set check the writer's
 * post-render validation performs).
 */
export function renderCodexHttpServerBlock(block: CodexHttpServerBlock): string {
  assertBareKeyName(block.name);
  const lines = renderBlock(block).filter(
    (line) => line !== CODEX_TOML_BLOCK_BEGIN && line !== CODEX_TOML_BLOCK_END,
  );
  const text = lines.join('\n');
  const parsed = parseToml(text);
  const servers = parsed.mcp_servers as Record<string, unknown> | undefined;
  const problem = validateOurKeys(servers?.[block.name]);
  if (problem !== null) {
    throw new Error(`render validation failed: [mcp_servers.${block.name}] ${problem}.`);
  }
  return text;
}

/** Atomic 0600 write preserving symlinks and the file's dominant EOL
 * (forceMode: the file carries a bearer token regardless of prior mode). */
function atomicWriteToml(configPath: string, unixText: string, crlf: boolean): void {
  const out = crlf ? unixText.replace(/\n/g, '\r\n') : unixText;
  atomicWriteTextFile(configPath, out, { forceMode: 0o600 });
}

/**
 * Idempotently write the managed `[mcp_servers.<name>]` block: strip any
 * prior managed block, re-anchor the fresh one at EOF, validate the render,
 * then swap atomically. The token lands inline, so the file is forced 0600.
 */
export function writeCodexHttpServerBlock(
  configPath: string,
  block: CodexHttpServerBlock,
): WriteCodexBlockResult {
  assertBareKeyName(block.name);
  const notes: string[] = [];

  let rawText = '';
  let existed = false;
  if (existsSync(configPath)) {
    existed = true;
    rawText = readFileSync(configPath, 'utf8');
  }
  const crlf = rawText.includes('\r\n');
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');

  const { remainder, hadBlock } = stripBlock(lines);

  // Foreign ownership guard — a duplicate table definition is a hard TOML
  // parse error that would brick codex entirely.
  const remainderText = remainder.join('\n');
  let parsedRemainder: Record<string, unknown>;
  try {
    parsedRemainder = parseToml(remainderText);
  } catch (e) {
    throw new Error(
      `${configPath} does not parse as TOML outside the gbrain-managed block ` +
        `(${(e as Error).message}) — fix the config (codex itself cannot read it either) and re-run.`,
    );
  }
  const servers = parsedRemainder.mcp_servers;
  if (typeof servers === 'object' && servers !== null && (servers as Record<string, unknown>)[block.name] !== undefined) {
    throw new Error(
      `[mcp_servers.${block.name}] is already defined in ${configPath} outside the gbrain-managed block — ` +
        `refusing to double-define it (that is a hard TOML parse error). ` +
        `Remove the existing entry (codex mcp remove ${block.name}) or pick another name (--name).`,
    );
  }

  // Assemble: remainder (trailing newline repaired, trailing blank run
  // collapsed to one separator line) + block at EOF.
  const trimmed = [...remainder];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();
  const body = trimmed.length > 0 ? [...trimmed, ''] : [];
  const nextLines = [...body, ...renderBlock(block), ''];
  const nextText = nextLines.join('\n');

  // Post-render validation: parse + assert OUR table's keys are exactly ours.
  const rendered = parseToml(nextText);
  const renderedServers = rendered.mcp_servers as Record<string, unknown> | undefined;
  const problem = validateOurKeys(renderedServers?.[block.name]);
  if (problem !== null) {
    throw new Error(
      `post-render validation failed: [mcp_servers.${block.name}] ${problem} — original file left untouched.`,
    );
  }

  let backupPath: string | null = null;
  if (existed) {
    backupPath = `${configPath}.bak`;
    copyFileSync(configPath, backupPath);
    chmodSync(backupPath, 0o600); // on re-runs the .bak carries the previous token
    const mode = statSync(configPath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      notes.push(
        `${configPath} was group/other-readable (mode ${mode.toString(8)}); tightened to 0600 — it now carries a bearer token.`,
      );
    }
  }
  atomicWriteToml(configPath, nextText, crlf);

  return { configPath, replacedPrior: hadBlock, backupPath, notes };
}

/**
 * Remove the managed block (marker-keyed; content outside survives
 * byte-for-byte). Absent file / absent block are calm no-ops. Damaged
 * markers refuse via findBlock — removal never guesses.
 */
export function removeCodexHttpServerBlock(
  configPath: string,
  name: string,
): RemoveCodexBlockResult {
  assertBareKeyName(name);
  const notes: string[] = [];
  if (!existsSync(configPath)) {
    return { configPath, removed: false, backupPath: null, notes: ['no config.toml — nothing to remove'] };
  }
  const rawText = readFileSync(configPath, 'utf8');
  const crlf = rawText.includes('\r\n');
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');

  const { remainder, hadBlock } = stripBlock(lines);
  if (!hadBlock) {
    return { configPath, removed: false, backupPath: null, notes: ['no gbrain-managed block — nothing to remove'] };
  }

  // Validate what we are about to write back — never leave codex unreadable.
  const trimmed = [...remainder];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === '') trimmed.pop();
  const nextText = trimmed.length > 0 ? `${trimmed.join('\n')}\n` : '';
  if (nextText !== '') parseToml(nextText);

  const backupPath = `${configPath}.bak`;
  copyFileSync(configPath, backupPath);
  chmodSync(backupPath, 0o600);
  atomicWriteToml(configPath, nextText, crlf);
  return { configPath, removed: true, backupPath, notes };
}
