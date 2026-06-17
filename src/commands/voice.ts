import { readFileSync } from 'fs';
import { loadConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import { MockSTTAdapter, DeepgramSTTAdapter } from '../core/voice/stt.ts';
import { MockTTSAdapter, SupertonicTTSAdapter } from '../core/voice/tts.ts';
import { VoiceSessionService } from '../core/voice/session-service.ts';
import { consolidateVoiceSession } from '../core/voice/consolidation.ts';
import { PostgresGraphAdapter } from '../core/graph/pg-adapter.ts';

const HELP = `Usage: gbrain voice <subcommand> [options]

Subcommands:
  transcribe <file>       Transcribe audio file to text
  synthesize <text>       Synthesize text to speech (writes audio to stdout)
  process <file>          Full session: transcribe -> summarize -> respond -> persist
  consolidate             Consolidate pending voice_session pages into memory
  help                    Show this help
`;

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return new Uint8Array(buf).buffer;
}

export async function runVoice(engine: BrainEngine, args: string[]): Promise<void> {
  const config = loadConfig();
  const subcommand = args[0] ?? 'help';

  switch (subcommand) {
    case 'transcribe': {
      const filePath = args[1];
      if (!filePath) {
        console.error('Usage: gbrain voice transcribe <file>');
        process.exit(1);
      }
      const audioBuf = readFileSync(filePath);
      const vCfg = config?.voice;
      const stt = vCfg?.stt_provider === 'deepgram' && vCfg?.deepgram_api_key
        ? new DeepgramSTTAdapter(vCfg.deepgram_api_key)
        : new MockSTTAdapter();
      const result = await stt.transcribe({ buffer: toArrayBuffer(audioBuf), mimeType: 'audio/webm' });
      console.log(JSON.stringify({ text: result.text, confidence: result.confidence, segments: result.segments }, null, 2));
      break;
    }
    case 'synthesize': {
      const text = args.slice(1).join(' ');
      if (!text) {
        console.error('Usage: gbrain voice synthesize <text>');
        process.exit(1);
      }
      const vCfg = config?.voice;
      const tts = vCfg?.tts_provider === 'supertonic' && vCfg?.supertonic_base_url
        ? new SupertonicTTSAdapter(vCfg.supertonic_base_url)
        : new MockTTSAdapter();
      const audio = await tts.synthesize(text);
      process.stdout.write(Buffer.from(audio));
      break;
    }
    case 'process': {
      const filePath = args[1];
      if (!filePath) {
        console.error('Usage: gbrain voice process <file>');
        process.exit(1);
      }
      const audioBuf = readFileSync(filePath);

      const onSave = async (session: { slug: string; content: string }) => {
        await engine.putPage(session.slug, {
          title: session.slug,
          type: 'concept',
          compiled_truth: session.content,
        } as any);
        await engine.addTag(session.slug, 'voice');
        const v = config?.voice?.page_title_prefix;
        if (v) {
          await engine.addTag(session.slug, v);
        }
      };

      const vCfg = config?.voice;
      const service = new VoiceSessionService({
        stt: vCfg?.stt_provider === 'deepgram' && vCfg?.deepgram_api_key
          ? new DeepgramSTTAdapter(vCfg.deepgram_api_key)
          : new MockSTTAdapter(),
        tts: vCfg?.tts_provider === 'supertonic' && vCfg?.supertonic_base_url
          ? new SupertonicTTSAdapter(vCfg.supertonic_base_url)
          : new MockTTSAdapter(),
        onSave,
      });
      const result = await service.processAudio(
        { buffer: toArrayBuffer(audioBuf), mimeType: 'audio/webm' },
        { title: filePath },
      );
      console.log(JSON.stringify({ sessionId: result.sessionId, transcript: result.transcript, summary: result.summary }, null, 2));
      break;
    }
    case 'consolidate': {
      const pages = await engine.listPages({ limit: 50 });
      const voicePages = pages.filter(p => p.type === 'concept' && p.title.startsWith('voice-session-'));

      const graph = new PostgresGraphAdapter(engine as any);
      let consolidated = 0;
      for (const page of voicePages) {
        const pageTags = await engine.getTags(page.slug);
        const transcript = page.compiled_truth;
        const summary = transcript.slice(0, 200);

        try {
          const result = await consolidateVoiceSession({
            transcript,
            summary,
            tags: pageTags,
            source: 'voice',
          }, graph);
          if (result.entities.length > 0) {
            console.error(`Consolidated ${result.entities.length} entit(ies) from ${page.slug}`);
          }
          consolidated++;
        } catch (err) {
          console.error(`Failed to consolidate ${page.slug}:`, err);
        }
      }
      console.log(`Consolidated ${consolidated} voice session(s).`);
      break;
    }
    default:
      console.log(HELP);
  }
}
