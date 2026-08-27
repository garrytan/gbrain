/**
 * registry.ts — the connector provider registry.
 *
 * The ONE place providers are enumerated (mirror of `transcripts/detect.ts`).
 * Adding a provider is a leaf module + one line here. Perplexity is
 * deliberately absent in v1: no `perplexity` transcript adapter exists, so a
 * registry entry would route to a lane that can't parse it — it stays a
 * documented manual-conversion path in the conversation-archive skill.
 */

import type { ChatHistoryProvider, ConnectorProviderName } from './types.ts';
import { chatgptProvider } from './providers/chatgpt.ts';
import { claudeProvider } from './providers/claude.ts';

export const connectorProviders: readonly ChatHistoryProvider[] = [chatgptProvider, claudeProvider];

export function getConnectorProvider(name: string): ChatHistoryProvider | null {
  return connectorProviders.find((p) => p.name === name) ?? null;
}

export function isConnectorProviderName(name: string): name is ConnectorProviderName {
  return connectorProviders.some((p) => p.name === name);
}

export function connectorProviderNames(): ConnectorProviderName[] {
  return connectorProviders.map((p) => p.name);
}
