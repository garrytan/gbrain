/**
 * Deterministic Markdown renderers for LinkedIn contact sources, seed person dossiers,
 * and verbatim published LinkedIn posts (`originals/linkedin-posts`).
 */
import { createHash } from 'node:crypto';
import { dumpFrontmatterYaml } from '../data-frontmatter.ts';
import { neutralizeOutsideText } from '../outside-content.ts';
import type {
  LinkedInConnection,
  LinkedInMessage,
  LinkedInShare,
  LinkedInWhitelistEntry,
} from './types.ts';

function cleanInline(text: string): string {
  return neutralizeOutsideText(text.replace(/\s+/g, ' ').trim());
}

function cleanSpeaker(text: string): string {
  return cleanInline(text.replace(/[*:()[\]]/g, ' ')) || 'Unknown';
}

export function hashLinkedInContact(
  contact: LinkedInWhitelistEntry,
  profile: LinkedInConnection | undefined,
  messages: readonly LinkedInMessage[],
): string {
  const payload = {
    key: contact.key,
    company: profile?.company ?? '',
    position: profile?.position ?? '',
    connected_on: profile?.connected_on ?? '',
    messages: messages.map((m) => [m.date, m.from_owner, m.content]),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

export function renderLinkedInSourcePage(opts: {
  contact: LinkedInWhitelistEntry;
  profile?: LinkedInConnection;
  messages: readonly LinkedInMessage[];
  ownerLabel?: string;
}): { slug: string; markdown: string; date: string; fingerprint: string } {
  const { contact, profile, messages } = opts;
  const lastMsgDate = messages.length > 0 ? messages[messages.length - 1]!.date : '';
  const dateMatch = lastMsgDate.match(/\d{4}-\d{2}-\d{2}/);
  const date = dateMatch ? dateMatch[0] : new Date().toISOString().slice(0, 10);
  const year = date.slice(0, 4);
  const slug = `source/linkedin/${year}/${date}-${contact.slug}`;
  const fingerprint = hashLinkedInContact(contact, profile, messages);
  const safeName = cleanInline(contact.name);

  const frontmatter: Record<string, unknown> = {
    type: 'source',
    title: `LinkedIn Profile & DMs — ${safeName}`,
    date,
    connector: 'linkedin',
    source_kind: 'linkedin',
    linkedin_key: contact.key,
    linkedin_url: profile?.url || contact.url || '',
    company: profile?.company ? cleanInline(profile.company) : '',
    position: profile?.position ? cleanInline(profile.position) : '',
    connected_on: profile?.connected_on ?? '',
    message_count: messages.length,
    fingerprint,
    tags: ['linkedin', 'personal-crm', contact.category],
    visibility: 'private',
    immutable: true,
  };

  const owner = cleanSpeaker(opts.ownerLabel || 'Me');
  const peer = cleanSpeaker(contact.name);

  const lines: string[] = [
    `# LinkedIn Profile & DMs — ${safeName}`,
    '',
    `- **Contact:** [[people/${contact.slug}|${safeName}]]`,
  ];
  if (profile?.position || profile?.company) {
    lines.push(
      `- **Role:** ${cleanInline(profile.position || '—')}${profile.company ? ` at ${cleanInline(profile.company)}` : ''}`,
    );
  }
  if (profile?.url || contact.url) {
    lines.push(`- **Profile URL:** ${profile?.url || contact.url}`);
  }
  if (profile?.connected_on) {
    lines.push(`- **Connected On:** ${cleanInline(profile.connected_on)}`);
  }
  lines.push(`- **Messages:** ${messages.length}`);

  if (messages.length > 0) {
    lines.push('', '## Direct Messages', '');
    for (const m of messages) {
      const speaker = m.from_owner ? owner : peer;
      const body = neutralizeOutsideText(m.content).replace(/\r\n/g, '\n');
      const parts = body.split('\n');
      lines.push(`**${speaker}** (${cleanInline(m.date || 'unknown')}): ${parts[0] ?? ''}`);
      for (let i = 1; i < parts.length; i++) lines.push(`  ${parts[i]}`);
    }
  }

  const markdown = `---\n${dumpFrontmatterYaml(frontmatter, { lineWidth: 1000 })}---\n\n${lines.join('\n')}\n`;
  return { slug, markdown, date, fingerprint };
}

export function renderLinkedInSeedPersonPage(opts: {
  contact: LinkedInWhitelistEntry;
  profile?: LinkedInConnection;
  sourceSlug: string;
  date: string;
  messageCount: number;
}): string {
  const { contact, profile, sourceSlug, date, messageCount } = opts;
  const safeName = cleanInline(contact.name);
  const roleLine =
    profile?.position || profile?.company
      ? `${cleanInline(profile.position || 'Connection')}${profile.company ? ` at ${cleanInline(profile.company)}` : ''}`
      : `Whitelisted LinkedIn contact (${contact.category})`;

  const frontmatter: Record<string, unknown> = {
    type: 'person',
    title: safeName,
    tags: ['person', 'personal-crm', 'linkedin', contact.category],
    category: contact.category,
    company: profile?.company ? cleanInline(profile.company) : '',
    role: profile?.position ? cleanInline(profile.position) : '',
    linkedin_url: profile?.url || contact.url || '',
    updated: date,
    visibility: 'private',
  };

  const body = [
    `# ${safeName}`,
    '',
    '## State',
    `- ${roleLine}. ${messageCount} LinkedIn DM(s) captured through ${date} \`[Source: ${sourceSlug}]\`.`,
    '',
    '## Open Threads',
    `- Review LinkedIn profile & DMs \`[Source: ${sourceSlug}]\` for relationship context.`,
  ].join('\n');

  return `---\n${dumpFrontmatterYaml(frontmatter, { lineWidth: 1000 })}---\n\n${body}\n`;
}

export function renderLinkedInPostsPages(posts: readonly LinkedInShare[]): {
  date: string;
  sourceSlug: string;
  originalSlug: string;
  sourceMarkdown: string;
  originalMarkdown: string;
} {
  const date = new Date().toISOString().slice(0, 10);
  const year = date.slice(0, 4);
  const sourceSlug = `source/linkedin/${year}/${date}-published-posts`;
  const originalSlug = 'originals/linkedin-posts';

  const blocks = posts.map((p) => {
    const header = `## ${p.date || date}${p.share_link ? ` — ${p.share_link}` : ''}`;
    const urlLine = p.shared_url ? `\n*Shared URL:* ${p.shared_url}\n` : '';
    return `${header}\n${urlLine}\n${p.commentary}`;
  });

  const sourceFm: Record<string, unknown> = {
    type: 'source',
    title: `Published LinkedIn Posts (${posts.length} posts)`,
    date,
    connector: 'linkedin',
    source_kind: 'linkedin_posts',
    post_count: posts.length,
    tags: ['linkedin', 'originals', 'writing'],
    visibility: 'private',
    immutable: true,
  };
  const origFm: Record<string, unknown> = {
    type: 'original',
    title: 'Published LinkedIn Posts (Exact Phrasing)',
    tags: ['originals', 'linkedin', 'writing'],
    updated: date,
    visibility: 'private',
  };

  const sourceMarkdown =
    `---\n${dumpFrontmatterYaml(sourceFm, { lineWidth: 1000 })}---\n\n` +
    `# Published LinkedIn Posts (${posts.length} posts)\n\n` +
    `${blocks.join('\n\n---\n\n')}\n`;

  const originalMarkdown =
    `---\n${dumpFrontmatterYaml(origFm, { lineWidth: 1000 })}---\n\n` +
    `# Published LinkedIn Posts (${posts.length} posts)\n\n` +
    `*Exact published words imported from \`Shares.csv\`; never paraphrased \`[Source: ${sourceSlug}]\`.*\n\n` +
    `${blocks.join('\n\n---\n\n')}\n`;

  return { date, sourceSlug, originalSlug, sourceMarkdown, originalMarkdown };
}
