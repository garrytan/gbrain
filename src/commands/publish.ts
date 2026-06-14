/**
 * mbrain publish — Generate shareable HTML from brain markdown pages.
 *
 * Deterministic: zero LLM calls. The skill (skills/publish/SKILL.md)
 * tells the agent when and how to use this. This code does the work.
 *
 * Usage:
 *   mbrain publish <page-path>                         # local HTML file
 *   mbrain publish <page-path> --password              # auto-generated pw
 *   mbrain publish <page-path> --password "secret"     # custom pw
 *   mbrain publish <page-path> --out /tmp/share.html   # custom output
 *   mbrain publish <page-path> --title "Custom Title"  # override title
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { randomBytes, createCipheriv, pbkdf2Sync } from 'crypto';
import { dirname, basename, join } from 'path';
import { createRequire } from 'module';

// Inline marked.js so published HTML is truly self-contained (no CDN dependency)
const require = createRequire(import.meta.url);
const MARKED_JS = readFileSync(join(dirname(require.resolve('marked')), 'marked.umd.js'), 'utf8');
export const PUBLISH_PBKDF2_ITERATIONS = 600_000;

// ── Content stripping ──────────────────────────────────────────────

/** Strip private/internal data from brain markdown before publishing */
export function makeShareable(content: string): string {
  let clean = content;

  // Remove YAML frontmatter
  clean = clean.replace(/^---[\s\S]*?---\n*/, '');

  // Remove the private evidence/timeline zone used by brain pages.
  clean = clean.replace(/\n---\n[\s\S]*$/, '');

  // Remove [Source: ...] citations (all formats)
  clean = stripSourceCitations(clean);

  // Remove confirmation numbers
  clean = clean.replace(/\*\*Confirmation:\*\*\s*[A-Z0-9]{6,}/gi, '**Confirmation:** on file');
  clean = clean.replace(/Confirmation[:#]?\s*[A-Z0-9]{6,}/gi, 'Confirmation: on file');
  clean = clean.replace(/\bconf\s*#?\s*[A-Z0-9]{6,}/gi, 'Confirmation: on file');

  // Remove brain cross-links but keep display text
  clean = clean.replace(/\[([^\]]+)\]\(\.[^)]*\/[^)]+\)/g, '$1');

  // Remove "See also" brain-internal lines
  clean = clean.replace(/^-?\s*See also:.*$/gm, '');

  // Clean up excessive blank lines
  clean = clean.replace(/\n{3,}/g, '\n\n');

  return clean.trim();
}

function stripSourceCitations(content: string): string {
  let result = '';
  for (let i = 0; i < content.length;) {
    if (content.startsWith('[Source:', i)) {
      const closing = findClosingBracket(content, i);
      if (closing >= 0) {
        i = closing + 1;
        continue;
      }
      const newline = content.indexOf('\n', i);
      i = newline >= 0 ? newline : content.length;
      continue;
    }
    result += content[i];
    i += 1;
  }
  return result.replace(/[ \t]{2,}/g, ' ');
}

function findClosingBracket(content: string, start: number): number {
  let depth = 0;
  for (let i = start; i < content.length; i += 1) {
    if (content[i] === '[') depth += 1;
    if (content[i] === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
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
  const key = pbkdf2Sync(password, salt, PUBLISH_PBKDF2_ITERATIONS, 32, 'sha256');
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
    { name: 'PBKDF2', salt, iterations: ${PUBLISH_PBKDF2_ITERATIONS}, hash: 'SHA-256' },
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
    renderMarkdownInto(document.getElementById('content'), result);
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

  // Sanitize markdown rendering to prevent XSS from embedded HTML in brain pages.
  const sanitizeScript = `
    const ALLOWED_TAGS = new Set([
      'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'hr', 'li', 'ol', 'p', 'pre', 's', 'strong', 'table', 'tbody', 'td', 'th', 'thead',
      'tr', 'ul'
    ]);
    const DROP_TAGS = new Set([
      'audio', 'button', 'canvas', 'embed', 'form', 'iframe', 'img', 'input', 'link', 'math',
      'meta', 'object', 'option', 'script', 'select', 'source', 'style', 'svg', 'textarea',
      'video'
    ]);
    const ALLOWED_ATTRS = {
      a: new Set(['href', 'title']),
      td: new Set(['colspan', 'rowspan']),
      th: new Set(['colspan', 'rowspan'])
    };
    function isSafeUrl(value) {
      try {
        const url = new URL(value, window.location.href);
        return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
      } catch {
        return false;
      }
    }
    function copySafeAttributes(source, target, tag) {
      const allowed = ALLOWED_ATTRS[tag];
      if (!allowed) return;
      for (const attr of Array.from(source.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        if (!allowed.has(name)) continue;
        if (name === 'href' && !isSafeUrl(value)) continue;
        if ((name === 'colspan' || name === 'rowspan') && !/^[1-9]\\d{0,2}$/.test(value)) continue;
        target.setAttribute(name, value);
      }
      if (tag === 'a' && target.hasAttribute('href')) {
        target.setAttribute('rel', 'noopener noreferrer');
      }
    }
    function sanitizeNode(node) {
      if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent || '');
      if (node.nodeType !== Node.ELEMENT_NODE) return document.createDocumentFragment();
      const tag = node.nodeName.toLowerCase();
      if (DROP_TAGS.has(tag)) return document.createDocumentFragment();
      const output = ALLOWED_TAGS.has(tag) ? document.createElement(tag) : document.createDocumentFragment();
      if (output.nodeType === Node.ELEMENT_NODE) copySafeAttributes(node, output, tag);
      for (const child of Array.from(node.childNodes)) {
        output.appendChild(sanitizeNode(child));
      }
      return output;
    }
    function sanitizedMarkdownFragment(markdown) {
      const rendered = marked.parse(markdown);
      const parsed = new DOMParser().parseFromString(String(rendered), 'text/html');
      const fragment = document.createDocumentFragment();
      for (const child of Array.from(parsed.body.childNodes)) {
        fragment.appendChild(sanitizeNode(child));
      }
      return fragment;
    }
    function renderMarkdownInto(target, markdown) {
      target.replaceChildren(sanitizedMarkdownFragment(markdown));
    }
  `;

  const contentScript = encrypted
    ? `<script>${sanitizeScript}${DECRYPT_JS}<\/script>`
    : `<script>${sanitizeScript}
        const md = ${JSON.stringify(markdown)};
        renderMarkdownInto(document.getElementById('content'), md);
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

export async function runPublish(args: string[]) {
  const inputPath = args.find(a => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  const titleIdx = args.indexOf('--title');
  const pwIdx = args.indexOf('--password');

  if (!inputPath) {
    console.error('Usage: mbrain publish <page.md> [--password ["secret"]] [--title "Title"] [--out path]');
    console.error('');
    console.error('  Generates a shareable HTML page from brain markdown.');
    console.error('  Strips private data (frontmatter, citations, timeline, brain links).');
    console.error('  Optionally encrypts with AES-256-GCM (client-side, no server needed).');
    console.error('');
    console.error('  --password          Auto-generate a password');
    console.error('  --password "secret" Use a specific password');
    console.error('  --title "Title"     Override the page title');
    console.error('  --out path          Output file (default: <input-basename>.html)');
    process.exit(1);
  }

  const raw = readFileSync(inputPath, 'utf-8');
  const cleaned = makeShareable(raw);
  const title = (titleIdx >= 0 ? args[titleIdx + 1] : null) || extractTitle(raw);

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
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html);

  console.log(`Published: ${outPath}`);
  if (encrypted) {
    console.log('  (password protected, AES-256-GCM encrypted)');
  } else {
    console.log('  (no password, content in cleartext)');
  }
}
