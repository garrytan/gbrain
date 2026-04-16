#!/usr/bin/env node
/**
 * slack-sync.mjs — Sync Slack channels, threads, and shared links into kbrain
 *
 * Pulls channel history from Slack, resolves threads, extracts deterministic
 * signals (links, decisions, action items), and writes searchable markdown
 * pages into the brain repo.
 *
 * Usage:
 *   node scripts/slack-sync.mjs                         # incremental sync
 *   node scripts/slack-sync.mjs --days 14              # backfill last 14 days
 *   node scripts/slack-sync.mjs --since 2026-04-01     # backfill since date
 *   node scripts/slack-sync.mjs --list-channels        # inspect filters
 *   node scripts/slack-sync.mjs --channel eng --dry-run
 */

import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const DEFAULT_BRAIN_DIR = process.env.KBRAIN_DIR || join(process.env.HOME || homedir(), 'Documents/kbrain');
const DEFAULT_DAYS = 7;
const DEFAULT_LIMIT = 200;
const DEFAULT_CHANNEL_TYPES = 'public_channel,private_channel';
const DEFAULT_OUTPUT_ROOT = join('sources', 'slack');
const DEFAULT_STATE_FILE = join(homedir(), '.gbrain', 'integrations', 'slack-to-brain', 'state.json');
const HEARTBEAT_FILE = join(homedir(), '.gbrain', 'integrations', 'slack-to-brain', 'heartbeat.jsonl');
const THREAD_LOOKBACK_DAYS = 14;
const DEFAULT_TIMEZONE = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const NOISE_CHANNEL_PATTERNS = [
  'random',
  'social',
  'watercooler',
  'standup',
  'alerts',
  'bot',
  'ops-',
  'build',
  'deploy',
  'notifications',
];
const MESSAGE_SUBTYPES_TO_SKIP = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'channel_posting_permissions',
  'message_deleted',
  'tombstone',
]);
const DECISION_PATTERNS = [
  /\bwe decided\b/i,
  /\bdecision\b/i,
  /\bagreed\b/i,
  /\bapproved\b/i,
  /\bship it\b/i,
  /\bgo with\b/i,
  /\blet'?s do\b/i,
  /\bwe'?ll do\b/i,
  /\bresolved\b/i,
];
const ACTION_PATTERNS = [
  /\baction item\b/i,
  /\btodo\b/i,
  /\bfollow up\b/i,
  /\bfollow-up\b/i,
  /\bneed to\b/i,
  /\bplease\b/i,
  /\bcan you\b/i,
  /\bwe should\b/i,
  /\bi(?:'|’)ll\b/i,
  /\bi will\b/i,
];

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    brainDir: DEFAULT_BRAIN_DIR,
    days: DEFAULT_DAYS,
    since: null,
    dryRun: false,
    listChannels: false,
    channelTypes: DEFAULT_CHANNEL_TYPES,
    limit: DEFAULT_LIMIT,
    channels: [],
    excludeChannels: [],
    allChannels: false,
    stateFile: DEFAULT_STATE_FILE,
    outputRoot: DEFAULT_OUTPUT_ROOT,
    timezone: DEFAULT_TIMEZONE,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--brain-dir' && argv[i + 1]) opts.brainDir = argv[++i];
    else if (arg === '--days' && argv[i + 1]) opts.days = parseInt(argv[++i], 10);
    else if (arg === '--since' && argv[i + 1]) opts.since = argv[++i];
    else if (arg === '--limit' && argv[i + 1]) opts.limit = parseInt(argv[++i], 10);
    else if (arg === '--channel' && argv[i + 1]) opts.channels.push(argv[++i]);
    else if (arg === '--exclude-channel' && argv[i + 1]) opts.excludeChannels.push(argv[++i]);
    else if (arg === '--channel-types' && argv[i + 1]) opts.channelTypes = argv[++i];
    else if (arg === '--state-file' && argv[i + 1]) opts.stateFile = argv[++i];
    else if (arg === '--output-root' && argv[i + 1]) opts.outputRoot = argv[++i];
    else if (arg === '--timezone' && argv[i + 1]) opts.timezone = argv[++i];
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--list-channels') opts.listChannels = true;
    else if (arg === '--all-channels') opts.allChannels = true;
  }

  if (!Number.isFinite(opts.days) || opts.days <= 0) opts.days = DEFAULT_DAYS;
  if (!Number.isFinite(opts.limit) || opts.limit <= 0) opts.limit = DEFAULT_LIMIT;
  return opts;
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function escapeYaml(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function asPosix(value) {
  return String(value).replace(/\\/g, '/');
}

function atomicWrite(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filePath);
}

function loadJson(filePath, fallback) {
  if (!existsSync(filePath)) return fallback;
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, data) {
  atomicWrite(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function appendHeartbeat(event) {
  mkdirSync(dirname(HEARTBEAT_FILE), { recursive: true });
  writeFileSync(HEARTBEAT_FILE, `${JSON.stringify(event)}\n`, { encoding: 'utf-8', flag: 'a' });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLocalDate(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d), 0, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseSlackTs(ts) {
  return Number.parseFloat(ts);
}

function compareTsAsc(a, b) {
  return parseSlackTs(a.ts) - parseSlackTs(b.ts);
}

function subtractSeconds(ts, seconds) {
  const numeric = parseSlackTs(ts);
  if (!Number.isFinite(numeric)) return ts;
  return (numeric - seconds).toFixed(6);
}

function computeOldestTs(opts, channelState = {}) {
  if (opts.since) {
    const date = parseLocalDate(opts.since);
    if (!date) throw new Error(`Invalid --since date: ${opts.since}. Use YYYY-MM-DD.`);
    return (date.getTime() / 1000).toFixed(6);
  }

  const now = Date.now();
  const defaultCutoff = ((now - opts.days * 24 * 60 * 60 * 1000) / 1000).toFixed(6);
  if (!channelState.lastMessageTs) return defaultCutoff;

  const threadLookbackCutoff = ((now - THREAD_LOOKBACK_DAYS * 24 * 60 * 60 * 1000) / 1000).toFixed(6);
  const overlapTs = subtractSeconds(channelState.lastMessageTs, 1);
  return parseSlackTs(overlapTs) < parseSlackTs(threadLookbackCutoff) ? threadLookbackCutoff : overlapTs;
}

function formatDate(dateLike, timeZone = DEFAULT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(dateLike));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function formatTimestamp(ts, timeZone = DEFAULT_TIMEZONE) {
  const date = new Date(parseSlackTs(ts) * 1000);
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(date);
}

function compact(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function workspaceSlug(workspace) {
  const fromUrl = String(workspace.url || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.slack\.com$/, '');
  return slugify(fromUrl || workspace.team || workspace.team_id || 'workspace');
}

function buildChannelUrl(workspace, channelId) {
  const base = String(workspace.url || '').replace(/\/+$/, '');
  return `${base}/archives/${channelId}`;
}

function buildMessageUrl(workspace, channelId, ts) {
  return `${buildChannelUrl(workspace, channelId)}/p${String(ts).replace('.', '')}`;
}

function buildThreadUrl(workspace, channelId, threadTs) {
  return `${buildMessageUrl(workspace, channelId, threadTs)}?thread_ts=${encodeURIComponent(threadTs)}&cid=${channelId}`;
}

function resolveSlackToken() {
  return process.env.SLACK_BOT_TOKEN || process.env.SLACK_USER_TOKEN || process.env.SLACK_TOKEN || '';
}

function resolveSlackBaseUrl() {
  return (process.env.SLACK_API_BASE_URL || 'https://slack.com/api').replace(/\/+$/, '');
}

async function slackApi(method, params = {}, opts = {}) {
  const baseUrl = opts.baseUrl || resolveSlackBaseUrl();
  const token = opts.token || resolveSlackToken();
  if (!token) {
    throw new Error('Missing Slack token. Set SLACK_BOT_TOKEN, SLACK_USER_TOKEN, or SLACK_TOKEN.');
  }

  const httpMethod = opts.httpMethod || (method === 'auth.test' ? 'POST' : 'GET');
  const url = new URL(`${baseUrl}/${method}`);
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    searchParams.set(key, String(value));
  }

  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    const requestInit = {
      method: httpMethod,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    };

    if (httpMethod === 'GET') {
      url.search = searchParams.toString();
      response = await fetch(url, requestInit);
    } else {
      requestInit.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      requestInit.body = searchParams.toString();
      response = await fetch(url, requestInit);
    }

    if (response.status !== 429) break;
    const retryAfter = Number.parseInt(response.headers.get('retry-after') || '1', 10);
    await sleep(Math.max(retryAfter, 1) * 1000);
  }

  if (!response) throw new Error(`No response from Slack for ${method}`);
  if (!response.ok) {
    throw new Error(`Slack HTTP ${response.status} for ${method}`);
  }

  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(`Slack ${method} failed: ${payload.error || 'unknown_error'}`);
  }
  return payload;
}

async function fetchWorkspaceIdentity(clientOpts = {}) {
  return slackApi('auth.test', {}, clientOpts);
}

async function fetchUsers(clientOpts = {}) {
  const users = new Map();
  let cursor = '';

  do {
    const payload = await slackApi('users.list', { limit: DEFAULT_LIMIT, cursor }, clientOpts);
    for (const member of payload.members || []) {
      users.set(member.id, {
        id: member.id,
        name: member.name || member.real_name || member.profile?.real_name || 'unknown',
        realName: member.real_name || member.profile?.real_name || member.name || 'Unknown User',
        displayName: member.profile?.display_name || member.profile?.display_name_normalized || '',
        email: member.profile?.email || null,
        isBot: Boolean(member.is_bot),
        deleted: Boolean(member.deleted),
      });
    }
    cursor = payload.response_metadata?.next_cursor || '';
  } while (cursor);

  return users;
}

async function fetchChannels(opts, clientOpts = {}) {
  const channels = [];
  let cursor = '';

  do {
    const payload = await slackApi('conversations.list', {
      types: opts.channelTypes,
      exclude_archived: true,
      limit: opts.limit,
      cursor,
    }, clientOpts);
    channels.push(...(payload.channels || []));
    cursor = payload.response_metadata?.next_cursor || '';
  } while (cursor);

  return channels;
}

function channelMatchesPattern(channel, pattern) {
  const value = String(pattern || '').trim().toLowerCase();
  if (!value) return false;
  const haystacks = [channel.id, channel.name, channel.name_normalized].filter(Boolean).map((part) => String(part).toLowerCase());
  if (value.includes('*')) {
    const regex = new RegExp(`^${value.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return haystacks.some((candidate) => regex.test(candidate));
  }
  return haystacks.some((candidate) => candidate.includes(value));
}

export function selectChannels(channels, opts) {
  const includePatterns = [
    ...opts.channels,
    ...String(process.env.SLACK_INCLUDE_CHANNELS || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  ];
  const excludePatterns = [
    ...opts.excludeChannels,
    ...String(process.env.SLACK_EXCLUDE_CHANNELS || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  ];

  return channels.filter((channel) => {
    if (channel.is_archived) return false;
    if (channel.is_member === false) return false;
    if (excludePatterns.some((pattern) => channelMatchesPattern(channel, pattern))) return false;
    if (includePatterns.length > 0) {
      return includePatterns.some((pattern) => channelMatchesPattern(channel, pattern));
    }
    if (opts.allChannels) return true;
    return !NOISE_CHANNEL_PATTERNS.some((pattern) => String(channel.name || '').toLowerCase().includes(pattern));
  });
}

function extractAngleLinks(text) {
  const links = [];
  const angleLinkRegex = /<((?:https?:\/\/|mailto:)[^>|]+)(?:\|([^>]+))?>/g;
  let match;
  while ((match = angleLinkRegex.exec(text)) !== null) {
    links.push({
      url: match[1],
      label: match[2] || match[1],
    });
  }
  return links;
}

function extractRawLinks(text) {
  const links = [];
  const rawLinkRegex = /\bhttps?:\/\/[^\s<>()]+/g;
  let match;
  while ((match = rawLinkRegex.exec(text)) !== null) {
    links.push({ url: match[0], label: match[0] });
  }
  return links;
}

export function extractLinks(message) {
  const links = [];
  const push = (url, label = url) => {
    if (!url) return;
    const normalized = String(url).trim();
    if (!normalized) return;
    if (!links.some((entry) => entry.url === normalized)) {
      links.push({ url: normalized, label: compact(label || normalized) });
    }
  };

  const text = String(message.text || '');
  for (const link of [...extractAngleLinks(text), ...extractRawLinks(text)]) {
    push(link.url, link.label);
  }

  for (const attachment of message.attachments || []) {
    push(attachment.original_url, attachment.title || attachment.original_url);
    push(attachment.title_link, attachment.title || attachment.title_link);
    push(attachment.from_url, attachment.from_url);
  }

  for (const file of message.files || []) {
    push(file.permalink, file.title || file.name || file.permalink);
  }

  return links.filter((link) => !link.url.startsWith('mailto:'));
}

function inferPersonSlug(user) {
  if (!user || user.isBot || user.deleted) return null;
  return slugify(user.realName || user.displayName || user.name);
}

function personLinkForPage(pagePath, user) {
  const slug = inferPersonSlug(user);
  if (!slug) return null;
  return asPosix(relative(dirname(pagePath), join('people', `${slug}.md`)));
}

function userLabel(user) {
  if (!user) return 'Unknown User';
  return user.displayName || user.realName || user.name || 'Unknown User';
}

function replaceUserMentions(text, users, pagePath) {
  return text.replace(/<@([A-Z0-9]+)>/g, (_, userId) => {
    const user = users.get(userId);
    const label = userLabel(user);
    const personLink = personLinkForPage(pagePath, user);
    return personLink ? `[${label}](${personLink})` : `@${label}`;
  });
}

function replaceSlackLinks(text) {
  return text
    .replace(/<mailto:([^>|]+)(?:\|([^>]+))?>/g, (_, email, label) => label || email)
    .replace(/<https?:\/\/([^>|]+)\|([^>]+)>/g, (match) => {
      const [, urlPart, label] = /<(https?:\/\/[^>|]+)\|([^>]+)>/.exec(match) || [];
      if (!urlPart) return match;
      return `[${label}](${urlPart})`;
    })
    .replace(/<(https?:\/\/[^>|]+)>/g, (_, url) => url)
    .replace(/<#([A-Z0-9]+)\|([^>]+)>/g, (_, channelId, name) => `#${name || channelId}`)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function renderSlackText(text, users, pagePath) {
  const withMentions = replaceUserMentions(String(text || ''), users, pagePath);
  return replaceSlackLinks(withMentions).trim();
}

function extractSentences(text) {
  return compact(text)
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function extractStructuredSignals(message, users, pagePath) {
  const rendered = renderSlackText(message.text || '', users, pagePath);
  const sentences = extractSentences(rendered);
  const decisions = [];
  const actionItems = [];
  const links = extractLinks(message);
  const author = userLabel(users.get(message.user));
  const sourceUrl = message._sourceUrl;

  for (const sentence of sentences) {
    if (DECISION_PATTERNS.some((pattern) => pattern.test(sentence))) {
      decisions.push({
        text: sentence,
        author,
        ts: message.ts,
        url: sourceUrl,
      });
    }
    if (ACTION_PATTERNS.some((pattern) => pattern.test(sentence))) {
      actionItems.push({
        text: sentence,
        author,
        ts: message.ts,
        url: sourceUrl,
      });
    }
  }

  return { rendered, decisions, actionItems, links };
}

function shouldSkipMessage(message) {
  if (!message) return true;
  if (message.hidden) return true;
  if (message.subtype && MESSAGE_SUBTYPES_TO_SKIP.has(message.subtype)) return true;
  if (!compact(message.text) && extractLinks(message).length === 0) return true;
  return false;
}

function isStandaloneSignal(message, users, pagePath) {
  const signal = extractStructuredSignals(message, users, pagePath);
  if (signal.decisions.length > 0 || signal.actionItems.length > 0 || signal.links.length > 0) return true;
  return compact(signal.rendered).length >= 120;
}

function threadSignalScore(messages, users, pagePath) {
  let score = 0;
  for (const message of messages) {
    const signal = extractStructuredSignals(message, users, pagePath);
    if (signal.links.length > 0) score += 1;
    if (signal.decisions.length > 0) score += 2;
    if (signal.actionItems.length > 0) score += 2;
    if (compact(signal.rendered).length >= 120) score += 1;
  }
  if (messages.length >= 3) score += 2;
  return score;
}

function deriveTitle(message, fallback) {
  const raw = compact(
    String(message.text || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\[[^\]]+\]\([^)]+\)/g, ' ')
  );
  if (!raw) return fallback;
  const firstSentence = extractSentences(raw)[0] || raw;
  return firstSentence.slice(0, 90);
}

function formatParticipants(participants, pagePath, users) {
  return participants
    .map((userId) => {
      const user = users.get(userId);
      if (!user) return null;
      const label = userLabel(user);
      const personLink = personLinkForPage(pagePath, user);
      return personLink ? `[${label}](${personLink})` : label;
    })
    .filter(Boolean);
}

function formatSignalItems(items, workspace, channel, timeZone) {
  return items.map((item) =>
    `- ${item.author}: ${item.text} ([Source: Slack #${channel.name}, ${formatTimestamp(item.ts, timeZone)}](${item.url || buildMessageUrl(workspace, channel.id, item.ts)}))`
  );
}

function formatSharedLinks(links, users, workspace, channel, timeZone) {
  return links.map((entry) => {
    const author = userLabel(users.get(entry.user));
    const label = compact(entry.label || entry.url).slice(0, 120);
    return `- [${label}](${entry.url}) — shared by ${author} ([Source: Slack #${channel.name}, ${formatTimestamp(entry.ts, timeZone)}](${entry.sourceUrl || buildMessageUrl(workspace, channel.id, entry.ts)}))`;
  });
}

function buildFrontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - "${escapeYaml(item)}"`);
      }
      continue;
    }
    if (typeof value === 'string') {
      lines.push(`${key}: "${escapeYaml(value)}"`);
      continue;
    }
    lines.push(`${key}: ${value}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}`;
}

function buildThreadPage({ workspace, channel, pagePath, threadMessages, users, timeZone }) {
  const root = threadMessages[0];
  const pageUsers = new Set(threadMessages.map((message) => message.user).filter(Boolean));
  const participants = formatParticipants([...pageUsers], pagePath, users);
  const threadUrl = buildThreadUrl(workspace, channel.id, root.thread_ts || root.ts);
  const decisionItems = [];
  const actionItems = [];
  const sharedLinks = [];

  for (const message of threadMessages) {
    message._sourceUrl = buildMessageUrl(workspace, channel.id, message.ts);
    const signal = extractStructuredSignals(message, users, pagePath);
    decisionItems.push(...signal.decisions);
    actionItems.push(...signal.actionItems);
    for (const link of signal.links) {
      sharedLinks.push({
        ...link,
        user: message.user,
        ts: message.ts,
        sourceUrl: message._sourceUrl,
      });
    }
  }

  const uniqueLinks = [];
  for (const link of sharedLinks) {
    if (!uniqueLinks.some((entry) => entry.url === link.url)) uniqueLinks.push(link);
  }

  const title = `Slack #${channel.name} — ${deriveTitle(root, 'Thread')}`;
  const date = formatDate(parseSlackTs(root.ts) * 1000, timeZone);
  const fm = buildFrontmatter({
    title,
    type: 'workspace_thread',
    date,
    created: date,
    source: 'slack',
    workspace: workspace.team,
    workspace_id: workspace.team_id,
    channel: channel.name,
    channel_id: channel.id,
    source_id: `slack:${workspace.team_id}:${channel.id}:${root.thread_ts || root.ts}`,
    thread_ts: root.thread_ts || root.ts,
    tags: ['slack', 'thread', slugify(channel.name)].filter(Boolean),
  });

  const transcript = threadMessages.map((message) => {
    const author = userLabel(users.get(message.user));
    const rendered = renderSlackText(message.text || '', users, pagePath);
    const link = buildMessageUrl(workspace, channel.id, message.ts);
    return `- ${formatTimestamp(message.ts, timeZone)} — ${author}: ${rendered} ([Open in Slack](${link}))`;
  });

  const sections = [
    `# ${title}`,
    '',
    `- Workspace: ${workspace.team}`,
    `- Channel: [#${channel.name}](${buildChannelUrl(workspace, channel.id)})`,
    `- Thread: [Open in Slack](${threadUrl})`,
    ...(participants.length > 0 ? [`- Participants: ${participants.join(', ')}`] : []),
    '',
  ];

  if (decisionItems.length > 0) {
    sections.push('## Decisions', '', ...formatSignalItems(decisionItems, workspace, channel, timeZone), '');
  }
  if (actionItems.length > 0) {
    sections.push('## Action Items', '', ...formatSignalItems(actionItems, workspace, channel, timeZone), '');
  }
  if (uniqueLinks.length > 0) {
    sections.push('## Shared Links', '', ...formatSharedLinks(uniqueLinks, users, workspace, channel, timeZone), '');
  }
  sections.push('## Transcript', '', ...transcript, '');

  return {
    path: asPosix(pagePath),
    content: `${fm}${sections.join('\n').trim()}\n`,
    sourceId: `slack:${workspace.team_id}:${channel.id}:${root.thread_ts || root.ts}`,
    lastTs: threadMessages[threadMessages.length - 1].ts,
  };
}

function buildDigestPage({ workspace, channel, pagePath, messages, users, timeZone }) {
  const date = formatDate(parseSlackTs(messages[0].ts) * 1000, timeZone);
  const title = `Slack #${channel.name} digest — ${date}`;
  const pageUsers = new Set(messages.map((message) => message.user).filter(Boolean));
  const participants = formatParticipants([...pageUsers], pagePath, users);
  const decisionItems = [];
  const actionItems = [];
  const sharedLinks = [];

  for (const message of messages) {
    message._sourceUrl = buildMessageUrl(workspace, channel.id, message.ts);
    const signal = extractStructuredSignals(message, users, pagePath);
    decisionItems.push(...signal.decisions);
    actionItems.push(...signal.actionItems);
    for (const link of signal.links) {
      sharedLinks.push({
        ...link,
        user: message.user,
        ts: message.ts,
        sourceUrl: message._sourceUrl,
      });
    }
  }

  const uniqueLinks = [];
  for (const link of sharedLinks) {
    if (!uniqueLinks.some((entry) => entry.url === link.url)) uniqueLinks.push(link);
  }

  const fm = buildFrontmatter({
    title,
    type: 'workspace_digest',
    date,
    created: date,
    source: 'slack',
    workspace: workspace.team,
    workspace_id: workspace.team_id,
    channel: channel.name,
    channel_id: channel.id,
    source_id: `slack:${workspace.team_id}:${channel.id}:${date}`,
    tags: ['slack', 'digest', slugify(channel.name)].filter(Boolean),
  });

  const transcript = messages.map((message) => {
    const author = userLabel(users.get(message.user));
    const rendered = renderSlackText(message.text || '', users, pagePath);
    return `- ${formatTimestamp(message.ts, timeZone)} — ${author}: ${rendered} ([Open in Slack](${buildMessageUrl(workspace, channel.id, message.ts)}))`;
  });

  const sections = [
    `# ${title}`,
    '',
    `- Workspace: ${workspace.team}`,
    `- Channel: [#${channel.name}](${buildChannelUrl(workspace, channel.id)})`,
    ...(participants.length > 0 ? [`- Participants: ${participants.join(', ')}`] : []),
    '',
  ];

  if (decisionItems.length > 0) {
    sections.push('## Decisions', '', ...formatSignalItems(decisionItems, workspace, channel, timeZone), '');
  }
  if (actionItems.length > 0) {
    sections.push('## Action Items', '', ...formatSignalItems(actionItems, workspace, channel, timeZone), '');
  }
  if (uniqueLinks.length > 0) {
    sections.push('## Shared Links', '', ...formatSharedLinks(uniqueLinks, users, workspace, channel, timeZone), '');
  }
  sections.push('## Messages', '', ...transcript, '');

  return {
    path: asPosix(pagePath),
    content: `${fm}${sections.join('\n').trim()}\n`,
    sourceId: `slack:${workspace.team_id}:${channel.id}:${date}`,
    lastTs: messages[messages.length - 1].ts,
  };
}

export function compileSlackChannel({ workspace, channel, historyMessages, threadMessagesByRoot, users, outputRoot = DEFAULT_OUTPUT_ROOT, timeZone = DEFAULT_TIMEZONE }) {
  const pages = [];
  const channelDir = join(outputRoot, workspaceSlug(workspace), slugify(channel.name || channel.id));
  const sorted = [...historyMessages].filter((message) => !shouldSkipMessage(message)).sort(compareTsAsc);
  const digestBuckets = new Map();
  const emittedThreads = new Set();

  for (const message of sorted) {
    if (message.thread_ts && message.thread_ts !== message.ts) continue;
    const threadKey = message.thread_ts || message.ts;
    const threadMessages = (threadMessagesByRoot.get(threadKey) || [message])
      .filter((entry) => !shouldSkipMessage(entry))
      .sort(compareTsAsc);

    if (threadMessages.length > 1 && !emittedThreads.has(threadKey)) {
      const threadPagePath = join(
        channelDir,
        `${formatDate(parseSlackTs(threadMessages[0].ts) * 1000, timeZone)}-${String(threadKey).replace('.', '')}-${slugify(deriveTitle(threadMessages[0], 'thread')).slice(0, 48)}.md`,
      );
      if (threadSignalScore(threadMessages, users, threadPagePath) >= 3) {
        pages.push(buildThreadPage({
          workspace,
          channel,
          pagePath: threadPagePath,
          threadMessages,
          users,
          timeZone,
        }));
        emittedThreads.add(threadKey);
        continue;
      }
    }

    const digestPagePath = join(channelDir, `${formatDate(parseSlackTs(message.ts) * 1000, timeZone)}-digest.md`);
    if (isStandaloneSignal(message, users, digestPagePath)) {
      const bucketKey = formatDate(parseSlackTs(message.ts) * 1000, timeZone);
      const bucket = digestBuckets.get(bucketKey) || [];
      bucket.push(message);
      digestBuckets.set(bucketKey, bucket);
    }
  }

  for (const [day, messages] of [...digestBuckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    pages.push(buildDigestPage({
      workspace,
      channel,
      pagePath: join(channelDir, `${day}-digest.md`),
      messages,
      users,
      timeZone,
    }));
  }

  return pages;
}

async function fetchChannelHistory(channel, oldest, state, opts, clientOpts = {}, persistState = () => {}) {
  const messages = [];
  let cursor = state.pendingHistoryCursor || '';

  do {
    const payload = await slackApi('conversations.history', {
      channel: channel.id,
      oldest,
      inclusive: false,
      limit: opts.limit,
      cursor,
    }, clientOpts);
    messages.push(...(payload.messages || []));
    cursor = payload.response_metadata?.next_cursor || '';
    state.pendingHistoryCursor = cursor || null;
    state.pendingHistoryOldest = oldest;
    if (!opts.dryRun) persistState();
  } while (cursor);

  state.pendingHistoryCursor = null;
  state.pendingHistoryOldest = null;
  if (!opts.dryRun) persistState();
  return messages;
}

async function fetchThreadMessages(channelId, rootTs, clientOpts = {}) {
  const messages = [];
  let cursor = '';
  do {
    const payload = await slackApi('conversations.replies', {
      channel: channelId,
      ts: rootTs,
      limit: 200,
      cursor,
    }, clientOpts);
    messages.push(...(payload.messages || []));
    cursor = payload.response_metadata?.next_cursor || '';
  } while (cursor);
  return messages;
}

function defaultState() {
  return {
    version: 1,
    workspace: null,
    channels: {},
    updatedAt: null,
  };
}

async function main() {
  const opts = parseArgs();
  const state = loadJson(opts.stateFile, defaultState());
  const clientOpts = {};

  const token = resolveSlackToken();
  if (!token) {
    console.error('Missing Slack credentials. Set SLACK_BOT_TOKEN, SLACK_USER_TOKEN, or SLACK_TOKEN.');
    process.exit(1);
  }

  const workspace = await fetchWorkspaceIdentity(clientOpts);
  const users = await fetchUsers(clientOpts);
  const channels = await fetchChannels(opts, clientOpts);
  const selectedChannels = selectChannels(channels, opts);

  if (opts.listChannels) {
    for (const channel of channels.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      const selected = selectedChannels.some((entry) => entry.id === channel.id) ? 'selected' : 'skipped';
      const privacy = channel.is_private ? 'private' : 'public';
      console.log(`${selected.padEnd(8)} ${String(channel.name).padEnd(30)} ${privacy} ${channel.id}`);
    }
    return;
  }

  state.workspace = {
    team: workspace.team,
    team_id: workspace.team_id,
    url: workspace.url,
  };

  let totalMessages = 0;
  let totalPages = 0;

  for (const channel of selectedChannels.sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
    const channelState = state.channels[channel.id] || {
      name: channel.name,
      lastMessageTs: null,
      lastRunAt: null,
      pendingHistoryCursor: null,
      pendingHistoryOldest: null,
      lastPageCount: 0,
    };
    state.channels[channel.id] = channelState;
    const oldest = computeOldestTs(opts, channelState);
    console.log(`Syncing #${channel.name} since ${oldest}`);

    const historyMessages = await fetchChannelHistory(
      channel,
      oldest,
      channelState,
      opts,
      clientOpts,
      () => saveJson(opts.stateFile, state),
    );
    const threadMessagesByRoot = new Map();
    const rootCandidates = historyMessages
      .filter((message) => !shouldSkipMessage(message))
      .filter((message) => !message.thread_ts || message.thread_ts === message.ts)
      .filter((message) => Number(message.reply_count || 0) > 0);

    for (const root of rootCandidates) {
      const threadMessages = await fetchThreadMessages(channel.id, root.ts, clientOpts);
      if (threadMessages.length > 0) {
        threadMessagesByRoot.set(root.ts, threadMessages);
      }
    }

    const pages = compileSlackChannel({
      workspace,
      channel,
      historyMessages,
      threadMessagesByRoot,
      users,
      outputRoot: opts.outputRoot,
      timeZone: opts.timezone,
    });

    for (const page of pages) {
      const filePath = join(opts.brainDir, page.path);
      if (!opts.dryRun) atomicWrite(filePath, page.content);
      console.log(`  ${opts.dryRun ? 'Would write' : 'Wrote'} ${page.path}`);
    }

    const latestTs = [...historyMessages, ...[...threadMessagesByRoot.values()].flat()]
      .map((message) => message.ts)
      .filter(Boolean)
      .sort((a, b) => parseSlackTs(a) - parseSlackTs(b))
      .pop();

    state.channels[channel.id] = {
      name: channel.name,
      lastMessageTs: latestTs || channelState.lastMessageTs || null,
      lastRunAt: new Date().toISOString(),
      pendingHistoryCursor: null,
      pendingHistoryOldest: null,
      lastPageCount: pages.length,
    };

    totalMessages += historyMessages.length;
    totalPages += pages.length;
    if (!opts.dryRun) saveJson(opts.stateFile, state);
  }

  state.updatedAt = new Date().toISOString();
  if (!opts.dryRun) saveJson(opts.stateFile, state);

  appendHeartbeat({
    ts: new Date().toISOString(),
    event: opts.dryRun ? 'dry_run' : 'sync_complete',
    source_version: '0.10.1',
    status: 'ok',
    details: {
      workspace: workspace.team,
      channels: selectedChannels.length,
      pages: totalPages,
      messages: totalMessages,
      mode: opts.since ? `since:${opts.since}` : `days:${opts.days}`,
      dry_run: opts.dryRun,
    },
  });

  console.log(`Done. ${selectedChannels.length} channels, ${totalMessages} messages, ${totalPages} pages.`);
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === entryUrl) {
  main().catch((error) => {
    appendHeartbeat({
      ts: new Date().toISOString(),
      event: 'sync_failed',
      source_version: '0.10.1',
      status: 'fail',
      error: error instanceof Error ? error.message : String(error),
    });
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export {
  buildChannelUrl,
  buildMessageUrl,
  buildThreadUrl,
  computeOldestTs,
  parseArgs,
};
