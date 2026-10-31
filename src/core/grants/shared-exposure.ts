/**
 * GST-363 (HARN-13 host-harness pilot, harness-evals#145): one credential with
 * no per-person scope, serving an agent that several people talk to, lets the
 * agent answer one person with pages only another person may read. Until
 * per-member keys ship (gbrain#7812) gbrain cannot tell people apart, so the
 * install routes and doctor warn instead. Nothing here changes a grant.
 *
 * A serve is likely multi-user when any signal holds:
 *  - `bot_harness`: the harness is a channel or bot agent (BOT_HARNESSES);
 *  - `channel_plugin`: Claude Code has a chat-channel plugin enabled;
 *  - `multi_channel_chat`: the read set holds remote-visible chat pages from
 *    MULTI_CHANNEL_MIN or more distinct channels (every DM page counts alone).
 *
 * Every input is a database row or a harness config file, never git, so a
 * repo-less brain is covered the same way as a repo brain.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { cliRenderContext, renderNotice, type Action, type Notice } from '../agent-output.ts';
import { renderCliNotices } from '../agent-markers.ts';
import { isInteractive } from '../interaction.ts';
import { hasScope } from '../scope.ts';
import { localFederatedSourceIds, resolveSourceWithTier } from '../source-resolver.ts';
import { privatePagesFilterFragmentFast, resolveExcludePrivatePages } from '../search/private-visibility.ts';
import { pageTypesForAllowed } from '../facts/conversation-types.ts';
import { claudeConfigDir } from '../bootstrap/host-specs.ts';
import type { PrincipalGrant } from './model.ts';

export const NOTICE_CODE = 'unscoped_multi_user_token';
export const BOT_HARNESSES: readonly string[] = ['openclaw', 'hermes', 'grok-bot', 'muse'];
export const CHANNEL_PLUGINS: readonly string[] = ['telegram', 'discord', 'slack', 'imessage', 'whatsapp', 'signal'];
const DM_PAGE_TYPES: readonly string[] = ['slack-dm-day', 'dm', 'sms'];
export const CHAT_PAGE_TYPES: readonly string[] = [...new Set([...pageTypesForAllowed(['slack', 'imessage', 'imessage-daily']), ...DM_PAGE_TYPES,
  'discord', 'telegram', 'whatsapp', 'signal', 'chat', 'channel'])];
export const MULTI_CHANNEL_MIN = 2;
const DOCS = 'docs/mcp/ADMIN.md#one-token-several-people';

export type ExposureReason = 'bot_harness' | 'channel_plugin' | 'multi_channel_chat';
/** `chat_sources`: the read sources that hold chat; channels across 2+ of them can be split by source grants, within one they cannot. */
export interface ChatCensus { sources: string[]; chat_pages: number; channels: number; chat_sources: string[] }

/** The chat-channel plugins Claude Code has enabled (settings.json `enabledPlugins`, `<name>@<marketplace>: true`). */
export function claudeCodeChannelPlugins(configDir = claudeConfigDir()): string[] {
  const path = join(configDir, 'settings.json');
  if (!existsSync(path)) return [];
  try {
    const enabled = (JSON.parse(readFileSync(path, 'utf8')) as { enabledPlugins?: Record<string, unknown> }).enabledPlugins ?? {};
    return Object.entries(enabled).filter(([key, on]) => on === true && CHANNEL_PLUGINS.includes(key.split('@')[0]!.toLowerCase())).map(([key]) => key);
  } catch {
    return [];
  }
}

/** The bot harness whose home holds this workspace (OpenClaw's ~/.openclaw*, Hermes's $HERMES_HOME or ~/.hermes), or null. */
export function botHarnessForWorkspace(workspace: string | null | undefined, home = homedir()): string | null {
  if (!workspace) return null;
  const path = resolve(workspace);
  const under = (dir: string) => path === dir || path.startsWith(dir + sep);
  const hermesHome = process.env.HERMES_HOME?.trim() ? resolve(process.env.HERMES_HOME.trim().replace(/^~(?=$|\/)/, home)) : join(home, '.hermes');
  if (under(hermesHome)) return 'hermes';
  const first = relative(home, path).split(sep)[0] ?? '';
  return first === '.openclaw' || first.startsWith('.openclaw-') ? 'openclaw' : null;
}

/**
 * The sources a credential reads with no per-call source_ids, as dispatch
 * resolves them: an unscoped legacy token reads the default source plus every
 * federated source (serve-http's noGrantFederatedScope); an unscoped OAuth
 * client reads `default`; a scalar grant its source; a federated grant its
 * read set. A credential without read scope reads nothing.
 */
export async function credentialReadSources(engine: BrainEngine, grant: Pick<PrincipalGrant, 'principal' | 'scopes' | 'sources'>): Promise<string[]> {
  if (!hasScope(grant.scopes, 'read')) return [];
  switch (grant.sources.kind) {
    case 'default': return grant.principal.kind === 'legacy_token'
      ? await localFederatedSourceIds(engine, 'default', 'seed_default').catch(() => undefined) ?? ['default']
      : ['default'];
    case 'scalar': return [grant.sources.writeSource];
    case 'federated': return [...grant.sources.readSources];
    case 'none': return [];
  }
}

/** What a local stdio server reads with no per-call source_ids (src/mcp/server.ts resolveMcpStdioSourceScope). */
export async function stdioReadSources(engine: BrainEngine, cwd = process.cwd()): Promise<string[]> {
  const resolved = await resolveSourceWithTier(engine, null, cwd).catch(() => ({ source_id: 'default', tier: 'seed_default' as const }));
  return await localFederatedSourceIds(engine, resolved.source_id, resolved.tier).catch(() => undefined) ?? [resolved.source_id];
}

/**
 * Chat pages a remote caller of these sources can see, and how many distinct
 * channels they come from. A channel is the page's frontmatter channel, chat
 * or conversation, else a leading `#name` in its title, else its source, so
 * unlabelled chat in one source counts as one channel. A DM page is its own
 * channel: it is the content another person must never see.
 */
export async function chatChannelCensus(engine: BrainEngine, sourceIds: readonly string[]): Promise<ChatCensus> {
  const empty: ChatCensus = { sources: [...sourceIds], chat_pages: 0, channels: 0, chat_sources: [] };
  if (sourceIds.length === 0) return empty;
  const hidePrivate = await resolveExcludePrivatePages(engine, true);
  const rows = await engine.executeRaw<{ source_id: string; chat_pages: number | string; channels: number | string }>(
    `SELECT p.source_id, count(*) AS chat_pages,
            count(DISTINCT CASE WHEN p.type = ANY($3::text[]) THEN 'dm:' || p.slug
              ELSE COALESCE(NULLIF(p.frontmatter->>'channel', ''), NULLIF(p.frontmatter->>'chat', ''), NULLIF(p.frontmatter->>'conversation', ''),
                lower(substring(p.title from '^#([A-Za-z0-9._-]+)')), '') END) AS channels
       FROM pages p
      WHERE p.deleted_at IS NULL AND p.type = ANY($1::text[]) AND p.source_id = ANY($2::text[])
        ${hidePrivate ? `AND ${privatePagesFilterFragmentFast('p')}` : ''}
      GROUP BY p.source_id ORDER BY p.source_id`,
    [[...CHAT_PAGE_TYPES], [...sourceIds], [...DM_PAGE_TYPES]],
  );
  return rows.reduce((c, r) => ({ ...c, chat_pages: c.chat_pages + Number(r.chat_pages), channels: c.channels + Number(r.channels), chat_sources: [...c.chat_sources, r.source_id] }), empty);
}

/** The census of what a credential reads, or null when it cannot be read (an install route never fails on its warning). */
export async function credentialCensus(engine: BrainEngine, grant: Pick<PrincipalGrant, 'principal' | 'scopes' | 'sources'>): Promise<ChatCensus | null> {
  try {
    return await chatChannelCensus(engine, await credentialReadSources(engine, grant));
  } catch {
    return null;
  }
}

export function exposureReasons(input: { harness?: string; channelPlugins?: readonly string[]; census?: ChatCensus | null }): ExposureReason[] {
  const reasons: ExposureReason[] = [];
  if (input.harness && BOT_HARNESSES.includes(input.harness)) reasons.push('bot_harness');
  if (input.channelPlugins?.length) reasons.push('channel_plugin');
  if (input.census && input.census.channels >= MULTI_CHANNEL_MIN) reasons.push('multi_channel_chat');
  return reasons;
}

/** Who the warning is about: a minted credential, or the local stdio server a harness spawns. */
export type ExposureSubject =
  | { kind: 'legacy_token'; name: string }
  | { kind: 'oauth_client'; id: string; name?: string }
  | { kind: 'stdio'; harness: string };

export function subjectLabel(s: ExposureSubject): string {
  if (s.kind === 'legacy_token') return `The token "${s.name}"`;
  if (s.kind === 'oauth_client') return `The OAuth client ${s.name ? `"${s.name}" (${s.id})` : s.id}`;
  return `The gbrain access ${s.harness} uses`;
}

/** Source grants can separate channels only when they sit in different sources. */
const splitBySource = (census: ChatCensus | null | undefined): boolean => !census || census.chat_sources.length >= 2;

/** The narrowing command: a credential's rescope, or a stdio server pinned to one source. Null when no source split exists. */
export function narrowArgv(s: ExposureSubject, census?: ChatCensus | null): string[] | null {
  if (!splitBySource(census)) return null;
  if (s.kind === 'legacy_token') return ['gbrain', 'auth', 'rescope', '--token', s.name, '--sources', '<source>'];
  if (s.kind === 'oauth_client') return ['gbrain', 'auth', 'rescope', '--client', s.id, '--sources', '<source>'];
  return null;
}

function reach(reasons: readonly ExposureReason[], census: ChatCensus | null | undefined, plugins: readonly string[] | undefined): string {
  const parts: string[] = [];
  if (reasons.includes('multi_channel_chat') && census) parts.push(`it reads chat from ${census.channels} channels in ${census.chat_sources.join(', ')}`);
  if (reasons.includes('channel_plugin') && plugins?.length) parts.push(`Claude Code takes messages from ${plugins.join(', ')}`);
  if (reasons.includes('bot_harness')) parts.push('it serves a chat agent several people can talk to');
  return parts.join('; ');
}

/**
 * Today's fixes, chosen by where the chat lives, then the per-member keys
 * gbrain#7812 adds. One string so every route prints the same commands.
 */
export function remedyText(s: ExposureSubject, census?: ChatCensus | null): string {
  const steps: string[] = [];
  if (splitBySource(census)) {
    steps.push(s.kind === 'stdio'
      ? 'pin the agent to one audience\'s source by setting GBRAIN_SOURCE=<source> in its MCP server environment'
      : `grant one audience's source only (${narrowArgv(s, census)!.join(' ')}; a new harness grant: gbrain mcp grant <name> --source <source> --federated-read <source>)`);
    steps.push('keep a channel\'s source out of unscoped reads (gbrain sources unfederate <id>)');
  } else {
    steps.push(`the chat sits in one source (${census!.chat_sources[0]}), so a source grant cannot separate it`);
  }
  steps.push('mark pages nobody else may see visibility: private (hidden from every remote caller while search.remote_private_pages stays off)');
  return `Fix: ${steps.join('; ')}. source_ids narrows only the call that sends it, so recall, list_pages or any read without it reads the token's full grant; the fix is ${splitBySource(census) ? 'a member-bound or rescoped token (gbrain auth rescope …)' : 'a member-bound token'}, not per-call narrowing. Per-member keys arrive with gbrain#7812 and are not in this version.`;
}

export function exposureFix(s: ExposureSubject, census?: ChatCensus | null): Action {
  const argv = narrowArgv(s, census);
  const verify = { argv: ['gbrain', 'doctor', '--only', NOTICE_CODE, '--json'] };
  const message = `${subjectLabel(s)} lets the agent read every channel it reaches, so when several people use the agent it may show one person another person's messages. ${remedyText(s, census).replace(/^Fix: (.)/, (_m, c: string) => c.toUpperCase())}`;
  if (argv) {
    return { ask_user: true, argv, consent: ['credentials'], actor: 'agent', requires_exclusive: false, docs: DOCS, verify,
      inputs: [{ name: 'source', how: 'Ask the user which one source this agent\'s audience may read (gbrain sources list).' }],
      why: 'Narrowing the grant limits what the agent can show anyone to one audience\'s source; the secret is unchanged.', user_message: message };
  }
  return { ask_user: true, consent: [], actor: 'user', requires_exclusive: false, docs: DOCS, verify,
    why: 'gbrain cannot tell the people in a chat apart yet; scoping this agent is the user\'s choice of source, private pages or a narrower deployment.', user_message: message };
}

/** The install-time warning. Null when no signal holds. */
export function sharedTokenNotice(s: ExposureSubject, input: { harness?: string; channelPlugins?: readonly string[]; census?: ChatCensus | null }): Notice | null {
  const reasons = exposureReasons(input);
  if (reasons.length === 0) return null;
  const fix = exposureFix(s, input.census);
  return {
    code: NOTICE_CODE, kind: 'safety', fix, user_message: fix.user_message,
    why: `WARNING: ${subjectLabel(s)} is not scoped to a person (${reach(reasons, input.census, input.channelPlugins)}). `
      + 'An agent using it can read every page that grant reaches, so when several people talk to the agent it may answer one person with another person\'s messages. '
      + remedyText(s, input.census),
  };
}

/** The notice as the JSON receipts carry it (`warnings`/`notices`). */
export function renderedExposure(notice: Notice | null): ReturnType<typeof renderNotice>[] {
  return notice ? [renderNotice(notice, cliRenderContext())] : [];
}

/** Install routes print on stderr: their stdout carries a token or a JSON document. A terminal gets readable lines, an agent an [AGENT] block. */
export function writeExposureNotice(notice: Notice | null): void {
  if (!notice) return;
  try {
    const out = renderCliNotices([renderNotice(notice, cliRenderContext())], { json: false, tty: isInteractive(), stdoutIsData: true });
    if (out.stderr) process.stderr.write(out.stderr);
  } catch { /* a warning never breaks the install */ }
}
