#!/usr/bin/env node
/**
 * gdrive-sync.mjs — Sync Google Docs, Sheets, and Slides into kbrain
 *
 * Pulls files from Google Drive, converts to kbrain-format markdown,
 * and writes to the brain repo. Autopilot picks them up from there.
 *
 * Auth options (mirrors credential-gateway recipe):
 *   Option A: ClawVisor (CLAWVISOR_URL + CLAWVISOR_AGENT_TOKEN)
 *   Option B: Direct Google OAuth (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET)
 *             Tokens stored in ~/.gbrain/google-tokens.json, auto-refreshed on 401.
 *
 * Allowlist config (~/.gbrain/gdrive-config.json):
 *   Syncs only files/folders you explicitly add. No config = no firehose.
 *
 *   node scripts/gdrive-sync.mjs --add-file FILE_ID       # add a file to the allowlist
 *   node scripts/gdrive-sync.mjs --add-folder FOLDER_ID   # add a folder to the allowlist
 *   node scripts/gdrive-sync.mjs --list-config             # show current allowlist
 *   node scripts/gdrive-sync.mjs --remove-file FILE_ID    # remove from allowlist
 *   node scripts/gdrive-sync.mjs --remove-folder FOLDER_ID
 *
 * Running the sync:
 *   node scripts/gdrive-sync.mjs                           # sync everything in allowlist
 *   node scripts/gdrive-sync.mjs --file FILE_ID            # one-off: sync this file now (not saved)
 *   node scripts/gdrive-sync.mjs --folder FOLDER_ID        # one-off: sync this folder now
 *   node scripts/gdrive-sync.mjs --days 30                 # limit folder syncs to last 30 days
 *   node scripts/gdrive-sync.mjs --type docs               # docs only (docs|sheets|slides|all)
 *   node scripts/gdrive-sync.mjs --brain-dir ~/Documents/kbrain
 *   node scripts/gdrive-sync.mjs --dry-run                 # print what would sync, no writes
 *   node scripts/gdrive-sync.mjs --force                   # re-sync even if unchanged
 */

import { execSync } from 'node:child_process';
import {
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import https from 'node:https';
import http  from 'node:http';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_BRAIN_DIR = process.env.KBRAIN_DIR || join(process.env.HOME, 'Documents/kbrain');
const STATE_FILE   = join(process.env.HOME, '.gbrain', 'gdrive-state.json');
const TOKENS_FILE  = join(process.env.HOME, '.gbrain', 'google-tokens.json');
const CONFIG_FILE  = join(process.env.HOME, '.gbrain', 'gdrive-config.json');

const MIME_DOCS   = 'application/vnd.google-apps.document';
const MIME_SHEETS = 'application/vnd.google-apps.spreadsheet';
const MIME_SLIDES = 'application/vnd.google-apps.presentation';

const MIME_LABELS = {
  [MIME_DOCS]:   'doc',
  [MIME_SHEETS]: 'sheet',
  [MIME_SLIDES]: 'slide',
};

const TYPE_FILTER = {
  docs:   [MIME_DOCS],
  sheets: [MIME_SHEETS],
  slides: [MIME_SLIDES],
  all:    [MIME_DOCS, MIME_SHEETS, MIME_SLIDES],
};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    brainDir: DEFAULT_BRAIN_DIR,
    // Runtime-only (not saved to config)
    fileIds: [],      // --file FILE_ID (repeatable)
    folderIds: [],    // --folder FOLDER_ID (repeatable)
    days: null,
    type: 'all',
    dryRun: false,
    force: false,
    limit: 1000,
    // Config management subcommands
    addFile: null,
    addFolder: null,
    removeFile: null,
    removeFolder: null,
    listConfig: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--brain-dir' && args[i + 1])    opts.brainDir = args[++i];
    if (args[i] === '--file' && args[i + 1])         opts.fileIds.push(args[++i]);
    if (args[i] === '--folder' && args[i + 1])       opts.folderIds.push(args[++i]);
    if (args[i] === '--days' && args[i + 1])         opts.days = parseInt(args[++i], 10);
    if (args[i] === '--type' && args[i + 1])         opts.type = args[++i];
    if (args[i] === '--limit' && args[i + 1])        opts.limit = parseInt(args[++i], 10);
    if (args[i] === '--dry-run')                     opts.dryRun = true;
    if (args[i] === '--force')                       opts.force = true;
    if (args[i] === '--add-file' && args[i + 1])    opts.addFile = args[++i];
    if (args[i] === '--add-folder' && args[i + 1])  opts.addFolder = args[++i];
    if (args[i] === '--remove-file' && args[i + 1]) opts.removeFile = args[++i];
    if (args[i] === '--remove-folder' && args[i + 1]) opts.removeFolder = args[++i];
    if (args[i] === '--list-config')                 opts.listConfig = true;
  }

  if (!TYPE_FILTER[opts.type]) {
    console.error(`Unknown --type "${opts.type}". Use: docs, sheets, slides, all`);
    process.exit(1);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Allowlist config (~/.gbrain/gdrive-config.json)
// ---------------------------------------------------------------------------

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { files: [], folders: [] };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
    return {
      files:   Array.isArray(raw.files)   ? raw.files   : [],
      folders: Array.isArray(raw.folders) ? raw.folders : [],
    };
  } catch {
    return { files: [], folders: [] };
  }
}

function saveConfig(config) {
  mkdirSync(join(process.env.HOME, '.gbrain'), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

function printConfig(config) {
  const total = config.files.length + config.folders.length;
  if (total === 0) {
    console.log('gdrive-config is empty. Use --add-file or --add-folder to build the allowlist.');
    return;
  }
  console.log(`gdrive-config (${total} entries):`);
  if (config.files.length > 0) {
    console.log('\nFiles:');
    for (const id of config.files) console.log(`  ${id}`);
  }
  if (config.folders.length > 0) {
    console.log('\nFolders:');
    for (const id of config.folders) console.log(`  ${id}`);
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// OAuth — Option B (direct Google OAuth)
// ---------------------------------------------------------------------------

const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/documents.readonly',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/presentations.readonly',
].join(' ');

function loadTokens() {
  if (!existsSync(TOKENS_FILE)) return null;
  try {
    return JSON.parse(readFileSync(TOKENS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  mkdirSync(join(process.env.HOME, '.gbrain'), { recursive: true });
  writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

async function refreshAccessToken(tokens) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET required to refresh token. ' +
      'Set them or use ClawVisor (CLAWVISOR_URL + CLAWVISOR_AGENT_TOKEN).'
    );
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token',
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          if (data.error) return reject(new Error(`Token refresh failed: ${data.error_description}`));
          resolve(data);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function runOAuthFlow() {
  const clientId     = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      'Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET.\n' +
      'See recipes/gdrive-to-brain.md for setup instructions.'
    );
    process.exit(1);
  }

  // Start a local callback server — Google redirects here after the user grants access.
  // Desktop app OAuth clients allow any localhost port, no explicit registration needed.
  const server = http.createServer();
  const port   = await new Promise((resolve, reject) => {
    const try_ = (p) => {
      server.once('error', () => (p < 8770 ? try_(p + 1) : reject(new Error('No free port for OAuth callback'))));
      server.listen(p, '127.0.0.1', () => resolve(p));
    };
    try_(8765);
  });

  const redirectUri = `http://127.0.0.1:${port}`;
  const authUrl =
    `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(OAUTH_SCOPES)}` +
    `&access_type=offline` +
    `&prompt=consent`;

  // Open the browser automatically
  try {
    const opener = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    execSync(`${opener} "${authUrl}"`, { stdio: 'ignore' });
    console.log('Browser opened — authorize Google Drive access, then return here.');
  } catch {
    console.log('\nOpen this URL in your browser:\n');
    console.log(authUrl + '\n');
  }

  // Wait for Google to redirect back with the auth code (120s timeout)
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('OAuth timed out after 5 minutes. Run again to retry.'));
    }, 300_000);

    server.on('request', (req, res) => {
      clearTimeout(timer);
      const params = new URL(req.url, redirectUri).searchParams;
      const code   = params.get('code');
      const error  = params.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(code
        ? '<html><body style="font-family:sans-serif;padding:40px"><h2>✓ Authorized</h2><p>You can close this tab.</p></body></html>'
        : `<html><body style="font-family:sans-serif;padding:40px"><h2>✗ Failed: ${error}</h2></body></html>`);
      server.close();
      if (error) reject(new Error(`OAuth denied: ${error}`));
      else if (code) resolve(code);
      else reject(new Error('No code in OAuth callback'));
    });
  });

  // Exchange code for tokens
  const body = new URLSearchParams({
    client_id: clientId, client_secret: clientSecret,
    code, redirect_uri: redirectUri, grant_type: 'authorization_code',
  }).toString();

  const tokens = await new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'oauth2.googleapis.com', path: '/token', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          if (data.error) return reject(new Error(`Token exchange failed: ${data.error_description}`));
          resolve(data);
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  saveTokens({ ...tokens, obtained_at: Date.now() });
  console.log('Tokens saved.');
  return tokens;
}

// ---------------------------------------------------------------------------
// Auth: returns a function `apiGet(url) → { status, body }`
// ---------------------------------------------------------------------------

async function buildAuthClient() {
  // Option A: ClawVisor
  if (process.env.CLAWVISOR_URL && process.env.CLAWVISOR_AGENT_TOKEN) {
    const baseUrl = process.env.CLAWVISOR_URL.replace(/\/$/, '');
    const token = process.env.CLAWVISOR_AGENT_TOKEN;

    return async function clawvisorGet(url) {
      const proxyUrl = `${baseUrl}/proxy?url=${encodeURIComponent(url)}`;
      return httpsGet(proxyUrl, {
        Authorization: `Bearer ${token}`,
        'X-Clawvisor-Service': 'google-drive',
      });
    };
  }

  // Option B: Direct Google OAuth
  let tokens = loadTokens();
  if (!tokens) {
    console.log('No Google tokens found. Starting OAuth flow...');
    tokens = await runOAuthFlow();
  }

  // Return a client that auto-refreshes on 401
  return async function googleGet(url) {
    const res = await httpsGet(url, { Authorization: `Bearer ${tokens.access_token}` });

    if (res.status === 401) {
      console.log('Access token expired, refreshing...');
      const refreshed = await refreshAccessToken(tokens);
      tokens = { ...tokens, access_token: refreshed.access_token, obtained_at: Date.now() };
      saveTokens(tokens);
      return httpsGet(url, { Authorization: `Bearer ${tokens.access_token}` });
    }

    return res;
  };
}

// ---------------------------------------------------------------------------
// Drive API — file metadata + listing
// ---------------------------------------------------------------------------

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,webViewLink,parents,description';

/** Fetch metadata for a single known file ID. */
async function fetchFileMetadata(get, fileId) {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`;
  const res = await get(url);
  if (res.status === 404) throw new Error(`File not found: ${fileId}`);
  if (res.status !== 200) throw new Error(`Drive get failed (${res.status}): ${res.body.slice(0, 200)}`);
  return JSON.parse(res.body);
}

/**
 * List Drive files matching the query filters.
 * folderId: single folder to constrain search (optional).
 */
async function listFilesInFolder(get, opts, folderId = null) {
  const { days, type } = opts;
  const mimeTypes = TYPE_FILTER[type] || TYPE_FILTER.all;

  const mimeQuery = mimeTypes.map((m) => `mimeType='${m}'`).join(' or ');
  let query = `(${mimeQuery}) and trashed=false`;

  if (folderId) {
    query += ` and '${folderId}' in parents`;
  }

  if (days != null) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    query += ` and modifiedTime > '${since}'`;
  }

  const fields = `nextPageToken,files(${FILE_FIELDS})`;
  const files = [];
  let pageToken = '';

  do {
    const url =
      `https://www.googleapis.com/drive/v3/files?` +
      `q=${encodeURIComponent(query)}` +
      `&fields=${encodeURIComponent(fields)}` +
      `&pageSize=100` +
      `&orderBy=modifiedTime%20desc` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true` +
      (pageToken ? `&pageToken=${pageToken}` : '');

    const res = await get(url);
    if (res.status !== 200) {
      throw new Error(`Drive list failed (${res.status}): ${res.body.slice(0, 200)}`);
    }

    const data = JSON.parse(res.body);
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';

    if (files.length >= opts.limit) break;
  } while (pageToken);

  return files;
}

// ---------------------------------------------------------------------------
// Docs API — structured content extraction
// ---------------------------------------------------------------------------

/**
 * Convert a Docs API body `content` array to markdown text.
 * Preserves heading levels so splitDocSections can detect ## boundaries.
 * Exported for testing.
 */
export function docsApiToText(bodyContent) {
  let text = '';

  for (const element of bodyContent || []) {
    if (element.paragraph) {
      const style = element.paragraph.paragraphStyle?.namedStyleType || 'NORMAL_TEXT';
      let para = '';
      for (const pe of element.paragraph.elements || []) {
        para += pe.textRun?.content ?? '';
      }
      // Docs API includes a trailing \n in each paragraph run — strip it before
      // adding our own newline so we don't double-space.
      para = para.replace(/\n$/, '');
      if (!para.trim()) { text += '\n'; continue; }

      if      (style === 'HEADING_1') text += `# ${para}\n`;
      else if (style === 'HEADING_2') text += `## ${para}\n`;
      else if (style === 'HEADING_3') text += `### ${para}\n`;
      else if (style.startsWith('HEADING_')) text += `#### ${para}\n`;
      else                             text += `${para}\n`;

    } else if (element.table) {
      text += _docsTableToMd(element.table);
    }
    // sectionBreak, tableOfContents — skip
  }

  return text;
}

/** Convert a Docs API table object to a markdown table string. */
function _docsTableToMd(table) {
  const rows = (table.tableRows || []).map((row) =>
    (row.tableCells || []).map((cell) =>
      docsApiToText(cell.content || []).replace(/\n/g, ' ').trim()
    )
  );
  if (rows.length === 0) return '';
  const colCount = Math.max(...rows.map((r) => r.length));
  const pad = (r) => { while (r.length < colCount) r.push(''); return r; };
  const esc = (s) => s.replace(/\|/g, '\\|');
  const header = '| ' + pad(rows[0]).map(esc).join(' | ') + ' |';
  const sep    = '| ' + Array(colCount).fill('---').join(' | ') + ' |';
  const body   = rows.slice(1).map((r) => '| ' + pad(r).map(esc).join(' | ') + ' |');
  return [header, sep, ...body].join('\n') + '\n\n';
}

// ---------------------------------------------------------------------------
// Content fetchers
// ---------------------------------------------------------------------------

/**
 * Google Docs → per-tab text via Docs API (includeTabsContent=true).
 *
 * Returns [{title, tabId, slug, text}] — one entry per tab.
 * For pre-tabs documents (no tabs key in response), returns a single entry
 * with tabId='' so the caller can treat it as single-tab.
 *
 * Using the Docs API instead of the plain-text export endpoint lets us:
 *   - Get proper ## headings (HEADING_2 paragraphStyle → "## …")
 *   - Split per tab so new tabs in eternally-updated docs are detected
 */
async function fetchDocTabs(get, fileId) {
  const fields = 'title,tabs(tabProperties(tabId,title,index),documentTab/body/content,childTabs)';
  const url    = `https://docs.googleapis.com/v1/documents/${fileId}?includeTabsContent=true&fields=${encodeURIComponent(fields)}`;
  const res    = await get(url);

  if (res.status !== 200) {
    // Docs API might not be enabled — fall back to plain text export
    console.warn(`  Docs API failed (${res.status}), falling back to plain text export`);
    const exportUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text%2Fplain&supportsAllDrives=true`;
    const exportRes = await get(exportUrl);
    if (exportRes.status !== 200) throw new Error(`Doc export failed (${exportRes.status})`);
    return [{ title: '', tabId: '', slug: '', text: exportRes.body }];
  }

  const doc  = JSON.parse(res.body);
  const tabs = [];

  function collectTabs(tabList) {
    for (const tab of tabList || []) {
      const title  = tab.tabProperties?.title || `Tab ${(tab.tabProperties?.index ?? tabs.length) + 1}`;
      const tabId  = tab.tabProperties?.tabId  || '';
      const slug   = slugify(title) || `tab-${tabs.length + 1}`;
      const text   = tab.documentTab?.body?.content
        ? docsApiToText(tab.documentTab.body.content)
        : '';
      tabs.push({ title, tabId, slug, text });
      if (tab.childTabs?.length > 0) collectTabs(tab.childTabs);
    }
  }

  collectTabs(doc.tabs);

  // No tabs in response (document predates the Tabs feature)
  if (tabs.length === 0) {
    const exportUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text%2Fplain&supportsAllDrives=true`;
    const exportRes = await get(exportUrl);
    if (exportRes.status !== 200) throw new Error(`Doc export failed (${exportRes.status})`);
    return [{ title: '', tabId: '', slug: '', text: exportRes.body }];
  }

  return tabs;
}

/**
 * Google Sheets → one {name, slug, content} entry per tab.
 * Each tab becomes its own brain page so new tabs are detected as new pages.
 */
async function fetchSheetTabs(get, fileId) {
  // Get tab names from Sheets API metadata
  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${fileId}?fields=sheets.properties(sheetId,title)`;
  const metaRes = await get(metaUrl);

  let tabNames = [];
  if (metaRes.status === 200) {
    try {
      const meta = JSON.parse(metaRes.body);
      tabNames = (meta.sheets || []).map((s) => s.properties?.title || '').filter(Boolean);
    } catch {
      // fallback to first-tab CSV export below
    }
  }

  if (tabNames.length === 0) {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text%2Fcsv&supportsAllDrives=true`;
    const res = await get(url);
    if (res.status !== 200) throw new Error(`Sheet export failed (${res.status})`);
    return [{ name: 'Sheet1', slug: 'sheet1', content: csvToMarkdownTable(res.body) }];
  }

  const tabs = [];
  for (const name of tabNames) {
    const url = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv&sheet=${encodeURIComponent(name)}`;
    const res = await get(url);
    const content = res.status === 200
      ? csvToMarkdownTable(res.body)
      : `_Export failed (${res.status})_`;
    tabs.push({ name, slug: slugify(name) || 'tab', content });
  }

  return tabs;
}

/** Google Slides → text extraction via Slides API */
async function fetchSlidesContent(get, fileId) {
  const url = `https://slides.googleapis.com/v1/presentations/${fileId}?fields=slides,title`;
  const res = await get(url);
  if (res.status !== 200) throw new Error(`Slides API failed (${res.status})`);

  const pres = JSON.parse(res.body);
  const sections = [];

  for (let i = 0; i < (pres.slides || []).length; i++) {
    const slide = pres.slides[i];
    const texts = extractSlideText(slide);
    if (texts.length > 0) {
      sections.push(`## Slide ${i + 1}\n\n${texts.join('\n\n')}`);
    }
  }

  return sections.join('\n\n') || '_No text content in slides._';
}

/** Recursively extract text from a Slides API slide object */
export function extractSlideText(slide) {
  const texts = [];

  for (const element of slide.pageElements || []) {
    if (element.shape?.text) {
      const text = extractTextContent(element.shape.text);
      if (text.trim()) texts.push(text.trim());
    }
    // Tables
    if (element.table) {
      const rows = [];
      for (const row of element.table.tableRows || []) {
        const cells = (row.tableCells || []).map((c) =>
          extractTextContent(c.text).replace(/\n/g, ' ').trim()
        );
        rows.push(cells.join(' | '));
      }
      if (rows.length > 0) {
        const header = rows[0];
        const sep = rows[0].split(' | ').map(() => '---').join(' | ');
        texts.push([header, sep, ...rows.slice(1)].join('\n'));
      }
    }
  }

  return texts;
}

/** Extract plain text from a Slides API text object */
export function extractTextContent(textObj) {
  if (!textObj?.textElements) return '';
  return textObj.textElements
    .map((el) => el.textRun?.content ?? '')
    .join('')
    .replace(/\u000b/g, '\n'); // vertical tab → newline (Slides uses this for line breaks)
}

// ---------------------------------------------------------------------------
// Doc section splitting
// ---------------------------------------------------------------------------

/** Fast non-crypto content hash for change detection (djb2). */
export function hashContent(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (((hash << 5) + hash) ^ str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/** Try to extract an ISO date (YYYY-MM-DD) from a section heading. */
export function extractDateFromHeading(heading) {
  // ISO: "2026-04-15" or "2026-04-15 — Acme call"
  const iso = heading.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];

  // Numeric: "4/15/26" or "4/15/2026"
  const num = heading.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (num) {
    const year = num[3].length === 2 ? `20${num[3]}` : num[3];
    return `${year}-${num[1].padStart(2, '0')}-${num[2].padStart(2, '0')}`;
  }

  // Month name: "April 15", "April 15, 2026", "Apr 15"
  const MONTHS = {
    january:1, february:2, march:3, april:4, may:5, june:6,
    july:7, august:8, september:9, october:10, november:11, december:12,
    jan:1, feb:2, mar:3, apr:4, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12,
  };
  const m = heading.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\b\s+(\d{1,2})(?:,?\s+(\d{4}))?/i
  );
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    const d  = parseInt(m[2], 10);
    const y  = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  return null;
}

/**
 * Split a plain-text Google Doc export into sections on ## headings.
 *
 * Returns [{heading, slug, date, content}].
 * If no ## headings are found, returns a single entry with slug='' (whole doc as one page).
 *
 * New entries at the top of living docs get detected as new slugs → new brain pages.
 * Existing entries whose content hasn't changed are skipped by the hash check in main().
 */
export function splitDocSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;
  const slugCounts = {};

  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current !== null) sections.push(current);
      const heading = line.slice(3).trim();
      const date    = extractDateFromHeading(heading);
      const base    = slugify(heading);
      slugCounts[base] = (slugCounts[base] || 0) + 1;
      const slug    = slugCounts[base] > 1 ? `${base}-${slugCounts[base]}` : base;
      current = { heading, slug, date, content: '' };
    } else if (current !== null) {
      current.content += line + '\n';
    }
    // Lines before the first ## heading are dropped (usually the doc title / boilerplate)
  }
  if (current !== null) sections.push(current);

  // No ## headings → treat whole doc as one page
  if (sections.length === 0) {
    return [{ heading: '', slug: '', date: null, content: text }];
  }

  return sections;
}

// ---------------------------------------------------------------------------
// CSV → Markdown table
// ---------------------------------------------------------------------------

export function csvToMarkdownTable(csv) {
  if (!csv.trim()) return '_Empty sheet_';

  const lines = csv.trim().split('\n');
  if (lines.length === 0) return '_Empty sheet_';

  const rows = lines.map(parseCSVRow);

  // Determine column count from widest row
  const colCount = Math.max(...rows.map((r) => r.length));

  // Pad all rows to same width
  const padded = rows.map((r) => {
    while (r.length < colCount) r.push('');
    return r;
  });

  const escape = (s) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

  const header = '| ' + padded[0].map(escape).join(' | ') + ' |';
  const sep = '| ' + Array(colCount).fill('---').join(' | ') + ' |';
  const body = padded.slice(1).map((row) => '| ' + row.map(escape).join(' | ') + ' |');

  return [header, sep, ...body].join('\n');
}

/** Parse a single CSV row, handling quoted fields */
export function parseCSVRow(line) {
  const fields = [];
  let field = '';
  let inQuote = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
      } else if (ch === ',') {
        fields.push(field);
        field = '';
      } else {
        field += ch;
      }
    }
  }
  fields.push(field);
  return fields;
}

// ---------------------------------------------------------------------------
// Markdown builder
// ---------------------------------------------------------------------------

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function formatDate(dateStr) {
  return new Date(dateStr).toISOString().split('T')[0];
}

/** Infer doc type tag from mime type */
function mimeToType(mimeType) {
  return MIME_LABELS[mimeType] || 'gdoc';
}

/** Naive auto-tagging from title */
export function autoTag(title, mimeType) {
  const t = title.toLowerCase();
  const tags = [mimeToType(mimeType)];
  if (t.includes('standup') || t.includes('stand-up')) tags.push('standup');
  if (t.includes('meeting') || t.includes('sync')) tags.push('meeting');
  if (t.includes('gtm') || t.includes('go-to-market')) tags.push('gtm');
  if (t.includes('sales') || t.includes('prospect')) tags.push('sales');
  if (t.includes('roadmap') || t.includes('planning')) tags.push('planning');
  if (t.includes('retro') || t.includes('retrospective')) tags.push('retro');
  return [...new Set(tags)];
}

/**
 * Build frontmatter + body for a Drive file.
 * One brain page per file — simple and queryable.
 */
export function buildDocPage(file, content) {
  const title = file.name || 'Untitled';
  const date = formatDate(file.modifiedTime);
  const tags = autoTag(title, file.mimeType);
  const driveUrl = file.webViewLink || `https://drive.google.com/file/d/${file.id}`;
  const fileType = mimeToType(file.mimeType);

  let fm = `---\n`;
  fm += `title: "${title.replace(/"/g, '\\"')}"\n`;
  fm += `type: ${fileType}\n`;
  fm += `date: ${date}\n`;
  fm += `created: ${date}\n`;
  fm += `source: google-drive\n`;
  fm += `source_id: ${file.id}\n`;
  fm += `source_url: "${driveUrl}"\n`;
  if (file.description) {
    fm += `description: "${file.description.replace(/"/g, '\\"').replace(/\n/g, ' ')}"\n`;
  }
  fm += `tags: [${tags.join(', ')}]\n`;
  fm += `---\n\n`;

  let body = `# ${title}\n\n`;
  body += `> **Source:** [Open in Google Drive](${driveUrl}) | Last modified: ${date}\n\n`;

  if (content.trim()) {
    body += content.trimEnd();
    body += '\n';
  } else {
    body += '_No text content extracted._\n';
  }

  return fm + body;
}

/**
 * Build a brain page for one section of a Google Doc.
 * tabName: pass the Docs tab title for multi-tab documents, null for single-tab.
 */
export function buildSectionPage(file, section, tabName = null) {
  const docTitle     = file.name || 'Untitled';
  const sectionTitle = section.heading || (tabName || docTitle);
  const pageTitle    = section.heading
    ? (tabName ? `${docTitle} — ${tabName} — ${sectionTitle}` : `${docTitle} — ${sectionTitle}`)
    : (tabName ? `${docTitle} — ${tabName}` : docTitle);
  const date         = section.date || formatDate(file.modifiedTime);
  const tags         = autoTag(docTitle, file.mimeType);
  const driveUrl     = file.webViewLink || `https://drive.google.com/file/d/${file.id}`;

  let fm  = `---\n`;
  fm += `title: "${pageTitle.replace(/"/g, '\\"')}"\n`;
  fm += `type: doc\n`;
  fm += `date: ${date}\n`;
  fm += `created: ${date}\n`;
  fm += `source: google-drive\n`;
  fm += `source_id: ${file.id}\n`;
  fm += `source_url: "${driveUrl}"\n`;
  fm += `parent_doc: "${docTitle.replace(/"/g, '\\"')}"\n`;
  if (tabName) fm += `tab: "${tabName.replace(/"/g, '\\"')}"\n`;
  fm += `tags: [${tags.join(', ')}]\n`;
  fm += `---\n\n`;

  let body  = `# ${sectionTitle}\n\n`;
  body += tabName
    ? `> **Doc:** [${docTitle}](${driveUrl}) | **Tab:** ${tabName} | **Date:** ${date}\n\n`
    : `> **Doc:** [${docTitle}](${driveUrl}) | **Date:** ${date}\n\n`;
  body += section.content.trim() || '_No content._';
  body += '\n';

  return fm + body;
}

/**
 * Build a brain page for one tab of a Google Sheet.
 * Called once per tab so new tabs are detected as new brain pages.
 */
export function buildTabPage(file, tab) {
  const sheetTitle = file.name || 'Untitled';
  const pageTitle  = `${sheetTitle} — ${tab.name}`;
  const date       = formatDate(file.modifiedTime);
  const tags       = autoTag(sheetTitle, file.mimeType);
  const driveUrl   = file.webViewLink || `https://drive.google.com/file/d/${file.id}`;

  let fm  = `---\n`;
  fm += `title: "${pageTitle.replace(/"/g, '\\"')}"\n`;
  fm += `type: sheet\n`;
  fm += `date: ${date}\n`;
  fm += `created: ${date}\n`;
  fm += `source: google-drive\n`;
  fm += `source_id: ${file.id}\n`;
  fm += `source_url: "${driveUrl}"\n`;
  fm += `parent_doc: "${sheetTitle.replace(/"/g, '\\"')}"\n`;
  fm += `tab: "${tab.name.replace(/"/g, '\\"')}"\n`;
  fm += `tags: [${tags.join(', ')}]\n`;
  fm += `---\n\n`;

  let body  = `# ${tab.name}\n\n`;
  body += `> **Sheet:** [${sheetTitle}](${driveUrl}) | **Last modified:** ${date}\n\n`;
  body += tab.content.trim() || '_Empty tab._';
  body += '\n';

  return fm + body;
}

// ---------------------------------------------------------------------------
// State — per-file modifiedTime + per-section/tab content hashes
//
// Format: { [fileId]: { modifiedTime, chunks: { [sectionOrTabSlug]: hash } } }
// Backwards compat: old entries stored as bare strings (just modifiedTime).
// ---------------------------------------------------------------------------

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  mkdirSync(join(process.env.HOME, '.gbrain'), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/** Read state for a file, normalising old string-format entries. */
function getFileState(state, fileId) {
  const entry = state[fileId];
  if (!entry) return { modifiedTime: null, chunks: {} };
  if (typeof entry === 'string') return { modifiedTime: entry, chunks: {} };
  return { modifiedTime: entry.modifiedTime ?? null, chunks: entry.chunks ?? {} };
}

// ---------------------------------------------------------------------------
// Determine output directory per file type
// ---------------------------------------------------------------------------

function outputDir(brainDir, mimeType) {
  const sub = {
    [MIME_DOCS]:   'gdocs',
    [MIME_SHEETS]: 'gsheets',
    [MIME_SLIDES]: 'gslides',
  }[mimeType] || 'gdocs';
  return join(brainDir, sub);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs();

  // ---------------------------------------------------------------------------
  // Config management subcommands (no auth needed)
  // ---------------------------------------------------------------------------

  if (opts.listConfig) {
    printConfig(loadConfig());
    return;
  }

  if (opts.addFile || opts.addFolder || opts.removeFile || opts.removeFolder) {
    const config = loadConfig();

    if (opts.addFile) {
      if (!config.files.includes(opts.addFile)) {
        config.files.push(opts.addFile);
        saveConfig(config);
        console.log(`Added file to allowlist: ${opts.addFile}`);
      } else {
        console.log(`Already in allowlist: ${opts.addFile}`);
      }
    }

    if (opts.addFolder) {
      if (!config.folders.includes(opts.addFolder)) {
        config.folders.push(opts.addFolder);
        saveConfig(config);
        console.log(`Added folder to allowlist: ${opts.addFolder}`);
      } else {
        console.log(`Already in allowlist: ${opts.addFolder}`);
      }
    }

    if (opts.removeFile) {
      const before = config.files.length;
      config.files = config.files.filter((id) => id !== opts.removeFile);
      saveConfig(config);
      console.log(config.files.length < before
        ? `Removed file: ${opts.removeFile}`
        : `Not in allowlist: ${opts.removeFile}`);
    }

    if (opts.removeFolder) {
      const before = config.folders.length;
      config.folders = config.folders.filter((id) => id !== opts.removeFolder);
      saveConfig(config);
      console.log(config.folders.length < before
        ? `Removed folder: ${opts.removeFolder}`
        : `Not in allowlist: ${opts.removeFolder}`);
    }

    printConfig(loadConfig());
    return;
  }

  // ---------------------------------------------------------------------------
  // Resolve what to sync: merge config allowlist + runtime flags
  // ---------------------------------------------------------------------------

  const config = loadConfig();

  // File IDs: config allowlist + --file flags (runtime, not saved)
  const allFileIds = [...new Set([...config.files, ...opts.fileIds])];

  // Folder IDs: config allowlist + --folder flags (runtime, not saved)
  const allFolderIds = [...new Set([...config.folders, ...opts.folderIds])];

  if (allFileIds.length === 0 && allFolderIds.length === 0) {
    console.error(
      'Nothing to sync.\n\n' +
      'Build your allowlist first:\n' +
      '  node scripts/gdrive-sync.mjs --add-file FILE_ID\n' +
      '  node scripts/gdrive-sync.mjs --add-folder FOLDER_ID\n\n' +
      'Get file/folder IDs from the Drive URL:\n' +
      '  File:   https://docs.google.com/document/d/FILE_ID/edit\n' +
      '  Folder: https://drive.google.com/drive/folders/FOLDER_ID\n\n' +
      'Or pass --file / --folder at runtime (not saved to config).\n' +
      'Run --list-config to see current allowlist.'
    );
    process.exit(1);
  }

  console.log(`gdrive-sync: starting (files=${allFileIds.length}, folders=${allFolderIds.length}, type=${opts.type})`);

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  let get;
  try {
    get = await buildAuthClient();
  } catch (e) {
    console.error('Auth setup failed:', e.message);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Collect file metadata
  // ---------------------------------------------------------------------------

  const files = [];
  const mimeAllowed = TYPE_FILTER[opts.type] || TYPE_FILTER.all;

  // Fetch specific file IDs directly (no list query needed — precise and fast)
  if (allFileIds.length > 0) {
    console.log(`Fetching metadata for ${allFileIds.length} file(s) from allowlist...`);
    for (const fileId of allFileIds) {
      try {
        const file = await fetchFileMetadata(get, fileId);
        if (!mimeAllowed.includes(file.mimeType)) {
          console.log(`  Skipping (not a ${opts.type}): ${file.name}`);
          continue;
        }
        files.push(file);
      } catch (e) {
        console.error(`  Failed to fetch metadata for ${fileId}: ${e.message}`);
      }
    }
  }

  // List files from each allowlisted folder
  if (allFolderIds.length > 0) {
    for (const folderId of allFolderIds) {
      console.log(`Listing files in folder: ${folderId}...`);
      try {
        const folderFiles = await listFilesInFolder(get, opts, folderId);
        files.push(...folderFiles);
      } catch (e) {
        console.error(`  Failed to list folder ${folderId}: ${e.message}`);
      }
    }
  }

  // Deduplicate (a file ID could be in both an allowlisted file and folder)
  const seen = new Set();
  const deduped = files.filter((f) => {
    if (seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  }).slice(0, opts.limit);

  if (deduped.length === 0) {
    console.log('No files found to sync.');
    return;
  }

  console.log(`Found ${deduped.length} file(s) to process.`);

  // ---------------------------------------------------------------------------
  // Sync loop
  // ---------------------------------------------------------------------------

  const state = loadState();
  let synced  = 0;  // individual section/tab files written
  let skipped = 0;  // whole files skipped (modifiedTime unchanged)
  let failed  = 0;

  for (const file of deduped) {
    const { id, name, mimeType, modifiedTime } = file;
    const label = `[${mimeToType(mimeType)}] ${name}`;

    // Fast gate: entire file unchanged → skip without fetching
    const fileState = getFileState(state, id);
    if (!opts.force && fileState.modifiedTime === modifiedTime) {
      skipped++;
      continue;
    }

    console.log(`  Syncing: ${label}`);

    if (opts.dryRun) {
      synced++;
      continue;
    }

    const baseDir  = outputDir(opts.brainDir, mimeType);
    const docSlug  = slugify(name);
    const docDate  = formatDate(modifiedTime);
    const newChunks = { ...fileState.chunks };

    try {
      // ---- Google Docs -------------------------------------------------------
      if (mimeType === MIME_DOCS) {
        const docTabs   = await fetchDocTabs(get, id);
        // A doc is "multi-tab" when the Docs API returned real tab objects (tabId !== '')
        const isMultiTab = docTabs.length > 1 || docTabs[0].tabId !== '';

        for (const tab of docTabs) {
          const sections   = splitDocSections(tab.text);
          const hasSections = sections.length > 1 || sections[0].slug !== '';
          const tabName    = isMultiTab ? tab.title : null;

          for (const section of sections) {
            const hash     = hashContent(section.content);
            // Namespace chunk key by tab so identical headings in different tabs
            // are tracked independently.
            const chunkKey = isMultiTab
              ? `${tab.slug}::${section.slug || '_whole'}`
              : (section.slug || '_whole');

            if (!opts.force && fileState.chunks[chunkKey] === hash) continue;

            const sectionDate = section.date || docDate;

            let filepath;
            if (isMultiTab && hasSections) {
              // gdocs/{doc-slug}/{tab-slug}/{date}-{section-slug}.md
              const dir = join(baseDir, docSlug, tab.slug);
              mkdirSync(dir, { recursive: true });
              filepath = join(dir, `${sectionDate}-${section.slug}.md`);
            } else if (isMultiTab) {
              // gdocs/{doc-slug}/{tab-slug}.md  (whole tab, no ## headings)
              const dir = join(baseDir, docSlug);
              mkdirSync(dir, { recursive: true });
              filepath = join(dir, `${tab.slug}.md`);
            } else if (hasSections) {
              // gdocs/{doc-slug}/{date}-{section-slug}.md
              const dir = join(baseDir, docSlug);
              mkdirSync(dir, { recursive: true });
              filepath = join(dir, `${sectionDate}-${section.slug}.md`);
            } else {
              // gdocs/{date}-{doc-slug}.md  (whole doc, no ## headings, no tabs)
              mkdirSync(baseDir, { recursive: true });
              filepath = join(baseDir, `${docDate}-${docSlug}.md`);
            }

            writeFileSync(filepath, buildSectionPage(file, section, tabName), 'utf-8');
            newChunks[chunkKey] = hash;
            synced++;

            const label = isMultiTab
              ? `[${tab.title}] ${section.heading || '(whole tab)'}`
              : (section.heading || name);
            console.log(`    → ${label}`);
          }
        }

      // ---- Google Sheets -----------------------------------------------------
      } else if (mimeType === MIME_SHEETS) {
        const tabs    = await fetchSheetTabs(get, id);
        const tabDir  = join(baseDir, docSlug);
        mkdirSync(tabDir, { recursive: true });

        for (const tab of tabs) {
          const hash     = hashContent(tab.content);
          const chunkKey = tab.slug || 'tab';

          if (!opts.force && fileState.chunks[chunkKey] === hash) continue;

          const filepath = join(tabDir, `${tab.slug}.md`);
          writeFileSync(filepath, buildTabPage(file, tab), 'utf-8');
          newChunks[chunkKey] = hash;
          synced++;
          console.log(`    → tab: ${tab.name}`);
        }

      // ---- Google Slides -----------------------------------------------------
      } else if (mimeType === MIME_SLIDES) {
        const content = await fetchSlidesContent(get, id);
        const hash    = hashContent(content);

        if (!opts.force && fileState.chunks['_slides'] === hash) {
          // Content hash unchanged even though modifiedTime changed — skip write
        } else {
          mkdirSync(baseDir, { recursive: true });
          const filepath = join(baseDir, `${docDate}-${docSlug}.md`);
          writeFileSync(filepath, buildDocPage(file, content), 'utf-8');
          newChunks['_slides'] = hash;
          synced++;
          console.log(`    → slides (${docSlug})`);
        }

      } else {
        console.warn(`  Unsupported mime type: ${mimeType}`);
      }

    } catch (e) {
      console.error(`  Failed to sync "${name}": ${e.message}`);
      failed++;
      continue;
    }

    // Update file state regardless of how many chunks changed
    state[id] = { modifiedTime, chunks: newChunks };
  }

  if (!opts.dryRun) {
    saveState(state);
  }

  console.log(`\nDone. Sections/tabs written: ${synced}, Files skipped (unchanged): ${skipped}, Failed: ${failed}`);

  if (synced > 0 && !opts.dryRun) {
    const dirs = [...new Set(deduped.map((f) => outputDir(opts.brainDir, f.mimeType)))];
    console.log('\nOutput directories:');
    for (const d of dirs) console.log(`  ${d}`);
    console.log('\nImport into brain:');
    console.log(`  gbrain sync --repo ${opts.brainDir}`);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error('Fatal:', e.message);
    process.exit(1);
  });
}
