/**
 * Sink types by name. `slack` and `webhook` are built in; a deployment adds its own with `registerSinkType(type,
 * factory)` before the dispatcher starts, then names the type in `notify.sinks` (docs/integrations/notification-sinks.md).
 */
import type { SinkConfig } from './config.ts';
import type { NotificationSink, SinkFactory } from './types.ts';
import { createSlackSink } from './sinks/slack.ts';
import { createWebhookSink } from './sinks/webhook.ts';

const factories = new Map<string, SinkFactory>([
  ['slack', config => createSlackSink(config)],
  ['webhook', createWebhookSink],
]);

export function registerSinkType(type: string, factory: SinkFactory): void {
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(type)) throw new Error(`sink type '${type}' must be lower-case letters, digits, - or _`);
  factories.set(type, factory);
}

export function sinkTypes(): string[] { return [...factories.keys()].sort(); }

/** Build a sink, or the reason it cannot be built (unknown type, invalid settings). */
export function createSink(config: SinkConfig): { sink: NotificationSink } | { error: string } {
  const factory = factories.get(config.type);
  if (!factory) return { error: `unknown sink type '${config.type}' (known: ${sinkTypes().join(', ')})` };
  try { return { sink: factory(config) }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}
