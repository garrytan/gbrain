import type { SourceKind } from '../source-registry/source-policy.ts';

export const CONNECTOR_CLASSES = [
  'agent_session_import',
  'filesystem_markdown_documents',
  'pdf_document_import',
  'meeting_transcripts',
  'code_repositories',
  'email',
  'calendar',
  'browser_bookmarks_history',
  'chat_exports',
  'slack_discord',
  'generic_archive_import',
] as const;

export type ConnectorClass = typeof CONNECTOR_CLASSES[number];

export interface ConnectorDefinition {
  id: string;
  class: ConnectorClass;
  source_kind: SourceKind;
  display_name: string;
  default_scopes: string[];
}

export const CONNECTOR_DEFINITIONS: readonly ConnectorDefinition[] = [
  {
    id: 'agent_session',
    class: 'agent_session_import',
    source_kind: 'agent_session',
    display_name: 'Agent Sessions',
    default_scopes: ['sessions.read'],
  },
  {
    id: 'filesystem_markdown',
    class: 'filesystem_markdown_documents',
    source_kind: 'markdown_file',
    display_name: 'Filesystem Markdown',
    default_scopes: ['files.read'],
  },
  {
    id: 'pdf_document',
    class: 'pdf_document_import',
    source_kind: 'pdf',
    display_name: 'PDF Documents',
    default_scopes: ['documents.read'],
  },
  {
    id: 'meeting_transcripts',
    class: 'meeting_transcripts',
    source_kind: 'meeting_transcript',
    display_name: 'Meeting Transcripts',
    default_scopes: ['meetings.read'],
  },
  {
    id: 'code_repositories',
    class: 'code_repositories',
    source_kind: 'code_repo',
    display_name: 'Code Repositories',
    default_scopes: ['repos.read'],
  },
  {
    id: 'gmail',
    class: 'email',
    source_kind: 'email',
    display_name: 'Gmail',
    default_scopes: ['gmail.readonly'],
  },
  {
    id: 'calendar',
    class: 'calendar',
    source_kind: 'calendar',
    display_name: 'Calendar',
    default_scopes: ['calendar.readonly'],
  },
  {
    id: 'browser_history',
    class: 'browser_bookmarks_history',
    source_kind: 'browser',
    display_name: 'Browser History',
    default_scopes: ['browser.history.read'],
  },
  {
    id: 'browser_bookmarks',
    class: 'browser_bookmarks_history',
    source_kind: 'bookmark',
    display_name: 'Browser Bookmarks',
    default_scopes: ['browser.bookmarks.read'],
  },
  {
    id: 'chat_exports',
    class: 'chat_exports',
    source_kind: 'chat_export',
    display_name: 'Chat Exports',
    default_scopes: ['chat.read'],
  },
  {
    id: 'slack',
    class: 'slack_discord',
    source_kind: 'slack',
    display_name: 'Slack',
    default_scopes: ['channels.history'],
  },
  {
    id: 'discord',
    class: 'slack_discord',
    source_kind: 'discord',
    display_name: 'Discord',
    default_scopes: ['messages.read'],
  },
  {
    id: 'generic_archive',
    class: 'generic_archive_import',
    source_kind: 'imported_archive',
    display_name: 'Generic Archive',
    default_scopes: ['archive.read'],
  },
] as const;

export function getConnectorDefinition(connectorId: string): ConnectorDefinition {
  const definition = CONNECTOR_DEFINITIONS.find((candidate) => candidate.id === connectorId);
  if (!definition) {
    throw new Error(`unknown connector: ${connectorId}`);
  }
  return definition;
}
