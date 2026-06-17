import { readFileSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import { MockSTTAdapter } from '../core/voice/stt.ts';
import { MockTTSAdapter } from '../core/voice/tts.ts';
import { VoiceSessionService } from '../core/voice/session-service.ts';

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
  const subcommand = args[0] ?? 'help';

  switch (subcommand) {
    case 'transcribe': {
      const filePath = args[1];
      if (!filePath) {
        console.error('Usage: gbrain voice transcribe <file>');
        process.exit(1);
      }
      const audioBuf = readFileSync(filePath);
      const stt = new MockSTTAdapter();
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
      const tts = new MockTTSAdapter();
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
          type: 'voice_session',
          content: session.content,
          tags: ['voice'],
        } as any);
      };

      const service = new VoiceSessionService({
        stt: new MockSTTAdapter(),
        tts: new MockTTSAdapter(),
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
      const listResult = await engine.listPages({ limit: 50 });
      const pages = ((listResult as any)?.pages ?? listResult ?? []) as any[];
      const voicePages = pages.filter((p: any) => (p.type ?? p.page_type) === 'voice_session');

      let consolidated = 0;
      for (const page of voicePages) {
        const pageContent = await engine.getPage(page.slug);
        if (pageContent) {
          const content = (pageContent as any)?.content ?? '';
          const transcriptMatch = content.match(/## Transcript\n\n([\s\S]*?)\n\n##/);
          const tagsMatch = content.match(/tags:\s*\[([^\]]*)\]/);
          const transcript = transcriptMatch ? transcriptMatch[1].trim() : '';
          const tags = tagsMatch
            ? tagsMatch[1].split(',').map((t: string) => t.trim().replace(/"/g, ''))
            : ['voice'];

          const memorySlug = `memory-${page.slug}`;
          const memoryContent = [
            '---',
            `type: memory`,
            `source: voice`,
            `tags: [${tags.map((t: string) => `"${t}"`).join(', ')}]`,
            `---`,
            '',
            `# ${page.slug}`,
            '',
            transcript,
          ].join('\n');

          await engine.putPage(memorySlug, {
            title: page.slug,
            type: 'memory',
            content: memoryContent,
            tags,
          } as any);
          consolidated++;
        }
      }
      console.log(`Consolidated ${consolidated} voice session(s) into memory page(s).`);
      break;
    }
    default:
      console.log(HELP);
  }
}
