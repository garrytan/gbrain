import type { BrainEngine } from './engine.ts';

export interface ComposioConnectorDefinition {
  id: string;
  label: string;
  category: string;
  description: string;
  scopes: string[];
}

export interface ComposioConnectorStatus extends ComposioConnectorDefinition {
  sourceId: string;
  sourceName: string;
  connected: boolean;
  status: 'connected' | 'ready' | 'setup_required';
}

export interface ComposioIntegrationStatus {
  provider: 'Composio';
  configured: boolean;
  apiKeyConfigured: boolean;
  webhookSecretConfigured: boolean;
  dashboardUrl: string;
  webhookUrl: string;
  requiredEnv: string[];
  acceptedPayloads: string[];
  connectors: ComposioConnectorStatus[];
}

export const COMPOSIO_CONNECTORS: ComposioConnectorDefinition[] = [
  {
    id: 'github',
    label: 'GitHub',
    category: 'Engineering',
    description: 'Issues, pull requests, commits, release notes, and repo context.',
    scopes: ['repo', 'issues', 'pull_requests'],
  },
  {
    id: 'slack',
    label: 'Slack',
    category: 'Team chat',
    description: 'Channel decisions, customer escalations, and team operating memory.',
    scopes: ['channels:history', 'groups:history', 'users:read'],
  },
  {
    id: 'notion',
    label: 'Notion',
    category: 'Docs',
    description: 'Workspace pages, project specs, meeting notes, and internal wikis.',
    scopes: ['pages:read', 'databases:read'],
  },
  {
    id: 'gdrive',
    label: 'Google Drive',
    category: 'Docs',
    description: 'Docs, sheets, PDFs, decks, and shared-drive knowledge.',
    scopes: ['drive.readonly'],
  },
  {
    id: 'confluence',
    label: 'Confluence',
    category: 'Docs',
    description: 'Team spaces, runbooks, design docs, and knowledge base articles.',
    scopes: ['read:confluence-content.all'],
  },
  {
    id: 'linear',
    label: 'Linear',
    category: 'Product',
    description: 'Roadmap issues, cycles, project updates, and customer-linked work.',
    scopes: ['read'],
  },
];

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function defaultPublicUrl(input?: string | null): string {
  const configured = input?.trim() || process.env.CORTEX_PUBLIC_URL?.trim() || process.env.GBRAIN_PUBLIC_URL?.trim();
  return trimTrailingSlash(configured || 'https://<your-cortex-host>');
}

export function composioEnvStatus(publicUrl?: string | null): Omit<ComposioIntegrationStatus, 'connectors'> {
  const apiKeyConfigured = Boolean(process.env.COMPOSIO_API_KEY?.trim());
  const webhookSecretConfigured = Boolean(
    process.env.CORTEX_COMPOSIO_WEBHOOK_SECRET?.trim() || process.env.COMPOSIO_WEBHOOK_SECRET?.trim(),
  );
  const baseUrl = defaultPublicUrl(publicUrl);
  return {
    provider: 'Composio',
    configured: apiKeyConfigured,
    apiKeyConfigured,
    webhookSecretConfigured,
    dashboardUrl: 'https://app.composio.dev',
    webhookUrl: `${baseUrl}/webhooks/composio`,
    requiredEnv: ['COMPOSIO_API_KEY', 'CORTEX_COMPOSIO_WEBHOOK_SECRET'],
    acceptedPayloads: ['application/json'],
  };
}

export async function getComposioIntegrationStatus(
  engine: BrainEngine,
  publicUrl?: string | null,
): Promise<ComposioIntegrationStatus> {
  const env = composioEnvStatus(publicUrl);
  let sourceIds = new Set<string>();
  try {
    const rows = await engine.executeRaw<{ id: string }>(
      `SELECT id
         FROM sources
        WHERE archived IS NOT TRUE
          AND id LIKE 'composio-%'`,
    );
    sourceIds = new Set(rows.map(source => source.id));
  } catch {
    sourceIds = new Set<string>();
  }
  return {
    ...env,
    connectors: COMPOSIO_CONNECTORS.map(connector => {
      const sourceId = `composio-${connector.id}`;
      const connected = sourceIds.has(sourceId);
      return {
        ...connector,
        sourceId,
        sourceName: `${connector.label} via Composio`,
        connected,
        status: connected ? 'connected' : (env.apiKeyConfigured ? 'ready' : 'setup_required'),
      };
    }),
  };
}
