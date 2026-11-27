/**
 * gbrain publish — Generate shareable HTML from brain markdown pages.
 *
 * Deterministic: zero LLM calls. The skill (skills/publish/SKILL.md)
 * tells the agent when and how to use this. This code does the work.
 *
 * Usage:
 *   gbrain publish <page-path>                         # local HTML file
 *   gbrain publish <page-path> --password              # auto-generated pw
 *   gbrain publish <page-path> --password "secret"     # custom pw
 *   gbrain publish <page-path> --out /tmp/share.html   # custom output
 *   gbrain publish <page-path> --title "Custom Title"  # override title
 */

import { readFileSync, writeFileSync, mkdirSync, realpathSync, statSync } from 'fs';
import { randomBytes, createCipheriv, pbkdf2Sync } from 'crypto';
import { dirname, basename } from 'path';
import { frontmatterBodyOffset, validatorFrontmatterFence } from '../core/markdown.ts';
import { FRONTMATTER_SCHEMA, FrontmatterLanguageError, loadBoundedYaml, scanDataFrontmatter } from '../core/data-frontmatter.ts';
import { GUEST_WARNING_LINE_RE } from '../core/guests/marker.ts';
import { opError } from '../core/ops/contract.ts';

// Inline marked.js so published HTML is truly self-contained (no CDN dependency). It is embedded at build time
// because a compiled binary has no node_modules (#10019), and vendored because marked's exports hide the UMD file.
import { MARKED_JS } from '../../vendor/marked/marked-source.ts';

// ── Content stripping ──────────────────────────────────────────────

const TIMELINE_MARKER = /<!--+\s*timeline\s*-*-->/i;
const TIMELINE_LINE = /^(?:[^\S\n]*-{3,}[^\S\n]*timeline[^\S\n]*-{3,}[^\S\n]*$|[ \t]*#{1,6}[ \t][^A-Za-z0-9\n]*(?:timelines?|history)\b|[^A-Za-z0-9\n]*(?:timelines?|history)\b[^\n]*\n[ \t]*(?:=+|-+)[ \t]*$)/im;
const MANAGED_BLOCK_END = /<!--+\s*gbrain:([a-z0-9_-]+):end\b[^>]*>/gi;
const MANAGED_BLOCK_BEGIN = /^(?:[ \t]*#{1,6}[ \t]+(?:facts|takes)[ \t]*\n(?:[ \t]*\n)*)?[^\n]*?<!--+\s*gbrain:([a-z0-9_-]+):begin\b[^>]*>/im;

const WRAPPED_FRONTMATTER_WINDOW = 5;
const LEADING_BLANK_OR_COMMENT_LINES = /^(?:[ \t]*(?:#[^\n]*)?\n)*/;
const KEY_SEPARATOR = /:(?:[ \t]|$)/m;

/**
 * Whether a wrapped block holds frontmatter, decided by the YAML parser sync uses rather than by key shape: it parses as
 * a mapping, or as a sequence holding one (`- key: value` items carry the same data). A block the parser rejects fails
 * closed when it holds a `key:` separator (a colon then a space or the line end), so malformed private YAML never
 * publishes; prose it rejects without one still does.
 */
function holdsFrontmatter(block: string): boolean {
  let value: unknown;
  try {
    value = loadBoundedYaml(block, { schema: FRONTMATTER_SCHEMA });
  } catch {
    return KEY_SEPARATOR.test(block);
  }
  const isMapping = (node: unknown) => Object.prototype.toString.call(node) === '[object Object]';
  return isMapping(value) || (Array.isArray(value) && value.some(isMapping));
}

/**
 * Whether a column-0 frontmatter fence pair, as parseDataFrontmatter reads one, starts on one of the first
 * WRAPPED_FRONTMATTER_WINDOW non-blank lines: an opener naming its language (`---yaml`, `---yml`, `---json`), a block
 * starting with a `{` flow mapping, or a block that holdsFrontmatter. The block is the text between a closed pair, or
 * for a fence that never closes the text after it, past any leading blank and # comment lines, up to the next blank line.
 * Two horizontal rules with only prose between them are not, and neither is one rule followed by prose.
 */
function startsFrontmatterPair(text: string): boolean {
  const lines = text.split('\n');
  for (let i = 0, seen = 0; i < lines.length && seen < WRAPPED_FRONTMATTER_WINDOW; i++) {
    if (!lines[i]!.trim()) continue;
    seen++;
    let fenced;
    try {
      fenced = scanDataFrontmatter(lines.slice(i).join('\n')).fenced;
    } catch (e) {
      if (e instanceof FrontmatterLanguageError) continue;
      throw e;
    }
    if (!fenced) continue;
    if (fenced.language !== '') return true;
    const block = fenced.content != null ? fenced.block : fenced.block.replace(LEADING_BLANK_OR_COMMENT_LINES, '').split(/\n[ \t]*\n/, 1)[0]!;
    if (/^\s*\{/.test(block) || holdsFrontmatter(block)) return true;
  }
  return false;
}

/** The text before the first match of `pattern`, or all of it when nothing matches. */
function before(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  return match ? text.slice(0, match.index) : text;
}

/**
 * Strip private/internal data from brain markdown before publishing. Fails closed (#10020): the page is cut at the
 * first line that could start its timeline (any timeline sentinel, or a Timeline or History heading at any level,
 * with or without a --- rule before it), a gbrain fence or HTML comment that never closes drops the rest of the
 * page, and frontmatter that never closes refuses to publish. A guest page saved from `gbrain get` starts with its
 * warning line; when frontmatter opens right after it, the line is dropped and the frontmatter stripped as usual. Any
 * other text above frontmatter (the quote fence a paged `gbrain get` prints, a wrapper line) refuses to publish.
 */
export function makeShareable(content: string): string {
  let clean = content.replace(/\r\n?/g, '\n');
  const opensFrontmatter = (text: string) => validatorFrontmatterFence(text.split('\n')).opens;

  const guestLine = GUEST_WARNING_LINE_RE.exec(clean);
  if (guestLine && opensFrontmatter(clean.slice(guestLine[0].length))) clean = clean.slice(guestLine[0].length);

  // Remove YAML frontmatter
  if (opensFrontmatter(clean)) {
    const offset = frontmatterBodyOffset(clean);
    if (offset === 0) throw opError('invalid_frontmatter', 'The page opens a frontmatter block with --- and never closes it, so nothing was published.', 'Close the frontmatter with a --- line that starts at the beginning of the line (an indented --- does not close it), then publish again.', { why: 'Publishing cannot tell where the private frontmatter ends, so it publishes nothing rather than guess.' });
    clean = clean.slice(offset);
  } else if (startsFrontmatterPair(clean)) {
    throw opError('invalid_frontmatter', 'The page has frontmatter below other text, such as the quote fence a paged gbrain get prints, so nothing was published.', 'Save the page again with plain gbrain get, or delete the lines above the opening --- so the frontmatter starts the file, then publish again.', { why: 'Publishing strips frontmatter only where it starts the file; it refuses rather than share frontmatter it did not strip.' });
  }

  // Remove the Timeline section and everything after it
  clean = before(before(clean, TIMELINE_MARKER), TIMELINE_LINE);

  // Remove gbrain fences (facts, takes and other machine blocks) with their Facts/Takes headings
  for (let match = MANAGED_BLOCK_BEGIN.exec(clean); match; match = MANAGED_BLOCK_BEGIN.exec(clean)) {
    const rest = clean.slice(match.index + match[0].length);
    const end = [...rest.matchAll(MANAGED_BLOCK_END)].find(candidate => candidate[1]!.toLowerCase() === match![1]!.toLowerCase());
    clean = clean.slice(0, match.index) + (end ? rest.slice(end.index! + end[0].length) : '');
  }

  // Remove HTML comments
  let visible = '';
  let at = 0;
  for (let open = clean.indexOf('<!--'); open !== -1; open = clean.indexOf('<!--', at)) {
    visible += clean.slice(at, open).replace(/[ \t]+$/, '');
    const close = clean.indexOf('-->', open + 4);
    at = close === -1 ? clean.length : close + 3;
  }
  clean = visible + clean.slice(at);

  // Remove [Source: ...] citations (all formats)
  clean = clean.split(/\[Source:[^\]]*\]/).map((part, i, parts) => i < parts.length - 1 ? part.trimEnd() : part).join('');

  // Remove confirmation numbers
  clean = clean.replace(/\*\*Confirmation:\*\*\s*[A-Z0-9]{6,}/gi, '**Confirmation:** on file');
  clean = clean.replace(/Confirmation[:#]?\s*[A-Z0-9]{6,}/gi, 'Confirmation: on file');
  clean = clean.replace(/\bconf\s*#?\s*[A-Z0-9]{6,}/gi, 'Confirmation: on file');

  // Remove brain cross-links but keep display text
  clean = clean.replace(/\[([^\]]+)\]\(\.[^)]*\/[^)]+\)/g, '$1');

  // Remove "See also" brain-internal lines
  clean = clean.replace(/^-?\s*See also:.*$/gm, '');

  // Clean up excessive blank lines and the --- rule left above a removed timeline
  clean = clean.replace(/\n{3,}/g, '\n\n');

  return clean.trim().replace(/(?:\n+[ \t]*---[ \t]*)+$/, '').trim();
}

// ── Title extraction ───────────────────────────────────────────────

export function extractTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : 'Document';
}

// ── Encryption ─────────────────────────────────────────────────────

export interface EncryptedContent {
  salt: string;
  iv: string;
  ciphertext: string;
}

export function encryptContent(plaintext: string, password: string): EncryptedContent {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(password, salt, 100_000, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  let encrypted = cipher.update(plaintext, 'utf8');
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: Buffer.concat([encrypted, authTag]).toString('base64'),
  };
}

export function generatePassword(length: number = 16): string {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(length);
  return Array.from(bytes).map(b => chars[b % chars.length]).join('');
}

// ── HTML generation ────────────────────────────────────────────────

const CSS = `
  :root {
    --bg: #fafaf9; --fg: #1c1917; --muted: #78716c;
    --accent: #d97706; --border: #e7e5e4; --card-bg: #ffffff;
    --code-bg: #f5f5f4; --link: #2563eb; --error: #dc2626;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0c0a09; --fg: #fafaf9; --muted: #a8a29e;
      --accent: #fbbf24; --border: #292524; --card-bg: #1c1917;
      --code-bg: #1c1917; --link: #60a5fa; --error: #f87171;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'SF Pro', Roboto, sans-serif;
    background: var(--bg); color: var(--fg);
    line-height: 1.7; padding: 1rem;
    max-width: 720px; margin: 0 auto; font-size: 15px;
  }
  h1 { font-size: 1.75rem; font-weight: 700; margin: 1.5rem 0 0.5rem; letter-spacing: -0.02em; }
  h2 { font-size: 1.3rem; font-weight: 600; margin: 2rem 0 0.75rem; padding-bottom: 0.4rem; border-bottom: 2px solid var(--accent); }
  h3 { font-size: 1.1rem; font-weight: 600; margin: 1.5rem 0 0.5rem; color: var(--accent); }
  h4 { font-size: 1rem; font-weight: 600; margin: 1.25rem 0 0.4rem; }
  p { margin: 0.5rem 0; }
  blockquote { border-left: 3px solid var(--accent); padding: 0.75rem 1rem; margin: 1rem 0; background: var(--card-bg); border-radius: 0 8px 8px 0; font-style: italic; color: var(--muted); }
  ul, ol { margin: 0.5rem 0; padding-left: 1.5rem; }
  li { margin: 0.3rem 0; }
  a { color: var(--link); text-decoration: none; }
  a:hover { text-decoration: underline; }
  strong { font-weight: 600; }
  code { background: var(--code-bg); padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 8px; padding: 0.75rem 1rem; margin: 1rem 0; overflow-x: auto; line-height: 1.5; }
  pre code { background: none; padding: 0; border-radius: 0; font-size: 0.85em; }
  .code-block { position: relative; margin: 1rem 0; }
  .code-block pre { margin: 0; padding-right: 4.5rem; }
  .copy-btn {
    position: absolute; top: 0.5rem; right: 0.5rem;
    font: inherit; font-size: 12px; line-height: 1; padding: 0.35rem 0.6rem;
    color: var(--muted); background: var(--card-bg); border: 1px solid var(--border); border-radius: 6px; cursor: pointer;
  }
  .copy-btn:hover, .copy-btn:focus-visible { color: var(--fg); border-color: var(--accent); }
  .copy-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  hr { border: none; border-top: 1px solid var(--border); margin: 2rem 0; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 14px; }
  th, td { padding: 8px 12px; border: 1px solid var(--border); text-align: left; }
  th { background: var(--card-bg); font-weight: 600; }
  @media (max-width: 600px) {
    body { font-size: 14px; padding: 0.75rem; }
    h1 { font-size: 1.4rem; }
    h2 { font-size: 1.15rem; }
    table { font-size: 12px; }
    th, td { padding: 6px 8px; }
  }
`;

const PASSWORD_CSS = `
  .pw-overlay {
    position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    background: var(--bg); z-index: 1000;
  }
  .pw-card {
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 16px;
    padding: 2.5rem; max-width: 380px; width: 90%; text-align: center;
    box-shadow: 0 4px 24px rgba(0,0,0,0.1);
  }
  .pw-lock { font-size: 3rem; margin-bottom: 1rem; }
  .pw-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 0.5rem; }
  .pw-subtitle { font-size: 0.85rem; color: var(--muted); margin-bottom: 1.5rem; }
  .pw-input {
    width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--bg); color: var(--fg); font-size: 15px; margin-bottom: 1rem;
    outline: none; transition: border-color 0.2s;
  }
  .pw-input:focus { border-color: var(--accent); }
  .pw-btn {
    width: 100%; padding: 10px 14px; border: none; border-radius: 8px;
    background: var(--accent); color: #fff; font-size: 15px; font-weight: 600;
    cursor: pointer; transition: opacity 0.2s;
  }
  .pw-btn:hover { opacity: 0.9; }
  .pw-error { color: var(--error); font-size: 0.85rem; margin-top: 0.75rem; display: none; }
  .pw-remember { display: flex; align-items: center; justify-content: center; gap: 6px; margin-bottom: 1rem; font-size: 0.85rem; color: var(--muted); cursor: pointer; }
  .pw-remember input { cursor: pointer; }
  @keyframes shake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-8px)} 75%{transform:translateX(8px)} }
  .shake { animation: shake 0.3s ease-in-out; }
`;

const DECRYPT_JS = `
const STORAGE_KEY = 'bp_' + location.pathname;

async function deriveKey(password, salt) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

async function decryptContent(password) {
  try {
    const salt = Uint8Array.from(atob(window.__SALT), c => c.charCodeAt(0));
    const iv = Uint8Array.from(atob(window.__IV), c => c.charCodeAt(0));
    const data = Uint8Array.from(atob(window.__CT), c => c.charCodeAt(0));
    const ciphertext = data.slice(0, data.length - 16);
    const authTag = data.slice(data.length - 16);
    const combined = new Uint8Array(ciphertext.length + authTag.length);
    combined.set(ciphertext);
    combined.set(authTag, ciphertext.length);
    const key = await deriveKey(password, salt);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, combined);
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

async function unlock(pw, remember) {
  const result = await decryptContent(pw);
  if (result) {
    if (remember) {
      try { localStorage.setItem(STORAGE_KEY, pw); } catch {}
    }
    document.getElementById('pw-overlay').remove();
    renderPage(result);
    return true;
  }
  return false;
}

(async () => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && await unlock(saved, false)) return;
  } catch {}

  document.getElementById('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('pw-input');
    const error = document.getElementById('pw-error');
    const card = document.querySelector('.pw-card');
    const remember = document.getElementById('pw-remember').checked;
    const pw = input.value;

    if (await unlock(pw, remember)) return;

    error.style.display = 'block';
    error.textContent = 'Wrong password. Try again.';
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
    input.value = '';
    input.focus();
  });

  document.getElementById('pw-input').addEventListener('input', () => {
    document.getElementById('pw-error').style.display = 'none';
  });
})();
`;

// Runs in the published page. Renders markdown through the sanitizer, then adds
// a copy button to every code block. The buttons are built with DOM calls and
// wired with addEventListener after sanitizing, so no page content can reach
// them and the sanitizer never has to allow an inline handler.
const RENDER_JS = `
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try { copied = document.execCommand('copy'); } catch {}
    area.remove();
    copied ? resolve() : reject(new Error('copy failed'));
  });
}

function addCopyButtons(root) {
  for (const pre of root.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code) continue;
    const block = document.createElement('div');
    block.className = 'code-block';
    pre.replaceWith(block);
    block.appendChild(pre);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-btn';
    const show = (text, label) => { button.textContent = text; button.setAttribute('aria-label', label); };
    show('Copy', 'Copy code block');
    let reset;
    button.addEventListener('click', () => {
      copyText(code.textContent.replace(/\\n$/, '')).then(
        () => show('Copied', 'Copied'),
        () => show('Select and copy', 'Copy failed, select the text and copy it'),
      ).finally(() => {
        clearTimeout(reset);
        reset = setTimeout(() => show('Copy', 'Copy code block'), 1500);
      });
    });
    block.appendChild(button);
  }
}

function renderPage(markdown) {
  const content = document.getElementById('content');
  content.innerHTML = sanitizeHtml(marked.parse(markdown));
  addCopyButtons(content);
}
`;

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface GenerateHtmlOptions {
  title: string;
  markdown: string;
  encrypted?: EncryptedContent | null;
}

export function generateHtml({ title, markdown, encrypted }: GenerateHtmlOptions): string {
  const passwordHtml = encrypted ? `
    <div id="pw-overlay" class="pw-overlay">
      <div class="pw-card">
        <div class="pw-lock">&#x1F512;</div>
        <div class="pw-title">${escapeHtml(title)}</div>
        <div class="pw-subtitle">This document is password protected</div>
        <form id="pw-form">
          <input type="password" id="pw-input" class="pw-input" placeholder="Enter password" autofocus>
          <label class="pw-remember"><input type="checkbox" id="pw-remember" checked> Remember on this device</label>
          <button type="submit" class="pw-btn">Unlock</button>
        </form>
        <div id="pw-error" class="pw-error"></div>
      </div>
    </div>` : '';

  const encryptedVars = encrypted ? `
    <script>
      window.__SALT = ${JSON.stringify(encrypted.salt)};
      window.__IV = ${JSON.stringify(encrypted.iv)};
      window.__CT = ${JSON.stringify(encrypted.ciphertext)};
    </script>` : '';

  // Sanitize markdown rendering to prevent XSS from embedded HTML in brain pages
  const sanitizeScript = `
    function sanitizeHtml(html) {
      const div = document.createElement('div');
      div.innerHTML = html;
      div.querySelectorAll('script,iframe,object,embed,form').forEach(el => el.remove());
      div.querySelectorAll('*').forEach(el => {
        for (const attr of [...el.attributes]) {
          if (attr.name.startsWith('on') || attr.value.startsWith('javascript:')) {
            el.removeAttribute(attr.name);
          }
        }
      });
      return div.innerHTML;
    }
  `;

  const contentScript = encrypted
    ? `<script>${sanitizeScript}${RENDER_JS}${DECRYPT_JS}<\/script>`
    : `<script>${sanitizeScript}${RENDER_JS}
        renderPage(${JSON.stringify(markdown).replace(/</g, '\\u003c')});
      <\/script>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>${CSS}${encrypted ? PASSWORD_CSS : ''}</style>
</head>
<body>
${passwordHtml}
<div id="content"></div>
${encryptedVars}
<script>${MARKED_JS}<\/script>
${contentScript}
</body>
</html>`;
}

// ── CLI entry point ────────────────────────────────────────────────

/**
 * Refuse an --out that names the page itself: the same real path or the same file by device and inode when it exists
 * (a symlink, a hard link, a case variant on a case-insensitive filesystem), else the same name in the page's real
 * parent folder. Checked before anything is written.
 */
function refuseOutOverPage(inputPath: string, outPath: string): void {
  const page = statSync(inputPath);
  const pageReal = realpathSync(inputPath);
  let same = false;
  try {
    const out = statSync(outPath);
    same = realpathSync(outPath) === pageReal || (out.dev === page.dev && out.ino === page.ino);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
    try {
      same = basename(outPath) === basename(pageReal) && realpathSync(dirname(outPath)) === dirname(pageReal);
    } catch {
      same = false;
    }
  }
  if (same) throw opError('invalid_params', `--out ${outPath} is the page itself, so the published copy would replace it; nothing was written.`, 'Pass a different --out path.');
}

export async function runPublish(args: string[]) {
  const inputPath = args.find(a => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  const titleIdx = args.indexOf('--title');
  const pwIdx = args.indexOf('--password');
  const markdownOnly = args.includes('--markdown');

  if (!inputPath) {
    console.error('Usage: gbrain publish <page.md> [--password ["secret"]] [--title "Title"] [--out path]');
    console.error('');
    console.error('  Generates a shareable HTML page from brain markdown.');
    console.error('  Strips private data (frontmatter, citations, timeline, brain links).');
    console.error('  Optionally encrypts with AES-256-GCM (client-side, no server needed).');
    console.error('');
    console.error('  --password          Auto-generate a password');
    console.error('  --password "secret" Use a specific password');
    console.error('  --title "Title"     Override the page title');
    console.error('  --markdown          Write the stripped markdown instead of HTML, for another renderer (brain-pdf)');
    console.error('  --out path          Output file (default: <input-basename>.html, or <input-basename>.shared.md with --markdown)');
    process.exit(1);
  }

  if (markdownOnly && pwIdx >= 0) throw opError('invalid_params', '--password encrypts the HTML page, and --markdown writes plain markdown, so nothing was written.', 'Drop --password to write the stripped markdown, or drop --markdown to publish encrypted HTML.');

  const raw = readFileSync(inputPath, 'utf-8');
  const cleaned = makeShareable(raw);

  if (markdownOnly) {
    const outPath = outIdx >= 0 ? args[outIdx + 1] : basename(inputPath, '.md') + '.shared.md';
    refuseOutOverPage(inputPath, outPath);
    mkdirSync(dirname(outPath), { recursive: true });
    try {
      writeFileSync(outPath, cleaned + '\n', { flag: outIdx >= 0 ? 'w' : 'wx' });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw opError('invalid_params', `${outPath} already exists, so nothing was written.`, 'Pass --out to choose the file to write.');
      throw e;
    }
    console.log(`Stripped markdown: ${outPath}`);
    return;
  }
  const title = (titleIdx >= 0 ? args[titleIdx + 1] : null) || extractTitle(cleaned);

  // Handle password
  let encrypted: EncryptedContent | null = null;
  if (pwIdx >= 0) {
    const nextArg = args[pwIdx + 1];
    const password = (nextArg && !nextArg.startsWith('--')) ? nextArg : generatePassword();
    encrypted = encryptContent(cleaned, password);
    if (!nextArg || nextArg.startsWith('--')) {
      console.error(`Password: ${password}`);
    }
  }

  const html = generateHtml({ title, markdown: cleaned, encrypted });

  // Determine output path
  const outPath = outIdx >= 0 ? args[outIdx + 1] : basename(inputPath, '.md') + '.html';
  refuseOutOverPage(inputPath, outPath);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);

  console.log(`Published: ${outPath}`);
  if (encrypted) {
    console.log('  (password protected, AES-256-GCM encrypted)');
  } else {
    console.log('  (no password, content in cleartext)');
  }
}
