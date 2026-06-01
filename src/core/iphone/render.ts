import matter from 'gray-matter';
import { slugifySegment } from '../sync.ts';
import { computeContentHash } from '../ingestion/types.ts';
import type { ContactRecord, ConversationSegment, SmsMessage } from './types.ts';
import type { NameResolver } from './name-resolver.ts';
import { displayNameForContact } from './contacts.ts';

export interface RenderedIPhonePage {
  slug: string;
  content: string;
  content_hash: string;
  page_type: 'conversation' | 'person';
}

export function renderConversationMarkdown(
  segment: ConversationSegment,
  resolver: NameResolver,
): RenderedIPhonePage {
  const participants = participantNames(segment, resolver);
  const firstDate = segment.messages[0]?.timestamp ?? new Date(0);
  const title = conversationTitle(segment, participants);
  const body = segment.messages.map((msg) => renderMessageLine(msg, resolver)).join('\n');
  const slug = slugForConversation(segment, resolver);
  const content = matter.stringify(body + '\n', {
    type: 'conversation',
    title,
    date: isoDate(firstDate),
    participants,
    imported_from: 'iphone-backup',
    iphone_handles: segment.participantHandles,
    source_service: segment.service ?? 'iMessage',
  });

  return {
    slug,
    content,
    content_hash: computeContentHash(content),
    page_type: 'conversation',
  };
}

export function renderPersonMarkdown(contact: ContactRecord): RenderedIPhonePage {
  const name = displayNameForContact(contact);
  const slug = slugForContact(contact);
  const lines = [
    `# ${name}`,
    '',
    'Imported from iPhone contacts.',
  ];
  const content = matter.stringify(lines.join('\n') + '\n', {
    type: 'person',
    title: name,
    name,
    imported_from: 'iphone-backup',
    ...(contact.organization ? { organization: contact.organization } : {}),
    ...(contact.phones.length > 0 ? { phones: contact.phones } : {}),
    ...(contact.emails.length > 0 ? { emails: contact.emails } : {}),
  });

  return {
    slug,
    content,
    content_hash: computeContentHash(content),
    page_type: 'person',
  };
}

export function slugForContact(contact: ContactRecord): string {
  const name = displayNameForContact(contact);
  const base = slugifySegment(name) || `contact-${contact.recordId}`;
  return `people/${base}`;
}

export function slugForConversation(
  segment: ConversationSegment,
  resolver: NameResolver,
): string {
  const names = participantNames(segment, resolver).filter((name) => name !== resolver.selfName);
  const baseName = names.length === 1
    ? names[0]
    : segment.chatDisplayName || segment.chatIdentifier || names.join(' ');
  const base = slugifySegment(baseName || `chat-${segment.chatId ?? segment.id}`) || `chat-${segment.chatId ?? segment.id}`;
  return `conversations/imessage/${base}-${segment.month}`;
}

function renderMessageLine(msg: SmsMessage, resolver: NameResolver): string {
  const speaker = msg.isFromMe ? resolver.selfName : resolver.resolveHandle(msg.handle);
  return `**${sanitizeSpeaker(speaker)}** (${formatMessageTimestamp(msg.timestamp)}): ${sanitizeMessageText(msg.text)}`;
}

function participantNames(segment: ConversationSegment, resolver: NameResolver): string[] {
  const names = new Set<string>([resolver.selfName]);
  for (const handle of segment.participantHandles) {
    names.add(resolver.resolveHandle(handle));
  }
  return Array.from(names);
}

function conversationTitle(segment: ConversationSegment, participants: string[]): string {
  const label = segment.chatDisplayName || participants.join(', ');
  return `iMessage with ${label} (${segment.month})`;
}

function sanitizeSpeaker(input: string): string {
  return input.replace(/\*/g, '').replace(/\s+/g, ' ').trim() || 'Unknown';
}

function sanitizeMessageText(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+/g, ' / ').trim();
}

function formatMessageTimestamp(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  let hour = date.getUTCHours();
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${year}-${month}-${day} ${hour}:${minute} ${ampm}`;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
