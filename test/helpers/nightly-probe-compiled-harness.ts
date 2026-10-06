/**
 * Entry for test/nightly-probe-compiled-binary.serial.test.ts: runs both
 * autopilot probe steps (the daemon's real wiring) against a config-only
 * fake brain, with the gateway's chat and embed test transports as the
 * hermetic provider. Compiled with `bun build --compile` and run from a
 * directory with no gbrain checkout, it proves the embedded fixtures (#5187,
 * C-N6) reach the probes. Prints `PROBE_RESULT <json>` with the audit rows.
 */
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  configureGateway,
  type ChatResult,
} from '../../src/core/ai/gateway.ts';
import { runNightlyQualityProbeStep, runParserProbeStep } from '../../src/commands/autopilot-probes.ts';
import { readRecentQualityProbeEvents } from '../../src/core/audit-quality-probe.ts';
import { readRecentParserProbeEvents } from '../../src/core/audit-parser-probe.ts';

const DIMS = 1536;
const JUDGE_REPLY = JSON.stringify({
  scores: { CORRECTNESS: { score: 9, feedback: 'ok' }, DIRECTNESS: { score: 9, feedback: 'ok' } },
  overall: 9,
  improvements: Array.from({ length: 10 }, (_, i) => `${i + 1}. none`),
});

function reply(model: string, text: string): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: { input_tokens: 50, output_tokens: 20, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model,
    providerId: model.split(':')[0]!,
  };
}

configureGateway({
  chat_model: 'anthropic:claude-sonnet-4-6',
  embedding_model: 'openai:text-embedding-3-small',
  embedding_dimensions: DIMS,
  env: { ...process.env } as Record<string, string>,
});
__setChatTransportForTests(async (opts) => {
  const prompt = JSON.stringify(opts.messages);
  return reply(opts.model ?? 'anthropic:claude-sonnet-4-6', prompt.includes('EVALUATION INPUT') ? JUDGE_REPLY : 'widget-co');
});
__setEmbedTransportForTests((async (params: { values: string[] }) => ({
  embeddings: params.values.map((v, i) => Array.from({ length: DIMS }, (_, j) => ((v.length + i + j) % 11) / 11)),
  values: params.values,
  warnings: [],
  usage: { tokens: params.values.length },
})) as unknown as Parameters<typeof __setEmbedTransportForTests>[0]);

const rows: Record<string, string> = {
  'autopilot.nightly_quality_probe.enabled': 'true',
  'autopilot.conversation_parser_probe.enabled': 'true',
  'search.reranker.enabled': 'false',
  'models.eval.cross_modal.slot_a': 'anthropic:claude-opus-4-7',
  'models.eval.cross_modal.slot_b': 'anthropic:claude-sonnet-4-6',
  'models.eval.cross_modal.slot_c': 'anthropic:claude-haiku-4-5-20251001',
};
const engine = { getConfig: async (key: string) => rows[key] ?? null } as unknown as Parameters<typeof runNightlyQualityProbeStep>[0];

await runNightlyQualityProbeStep(engine, null);
await runParserProbeStep(engine, null);
console.log(`PROBE_RESULT ${JSON.stringify({ quality: readRecentQualityProbeEvents(1), parser: readRecentParserProbeEvents(1) })}`);
process.exit(0);
