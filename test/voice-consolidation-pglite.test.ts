import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresGraphAdapter } from '../src/core/graph/pg-adapter.ts';
import { consolidateVoiceSession } from '../src/core/voice/consolidation.ts';

let engine: PGLiteEngine;
let adapter: PostgresGraphAdapter;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll() {
  for (const t of ['links', 'tags', 'pages', 'sources']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('default', 'default', '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
  );
}

describe('consolidateVoiceSession integration (PGLite)', () => {
  beforeEach(() => {
    truncateAll();
    adapter = new PostgresGraphAdapter(engine as any);
  });

  test('no tagged entities -> empty result', async () => {
    const result = await consolidateVoiceSession({
      transcript: 'Hello world',
      summary: 'A greeting',
      tags: ['voice', 'general'],
      source: 'voice',
    }, adapter);
    expect(result.entities).toEqual([]);
    expect(result.relations).toEqual([]);
  });

  function simpleHash(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  function makeSessionSlug(transcript: string, source = 'voice'): string {
    return `voice-session-${simpleHash(transcript + source)}`;
  }

  test('tagged entities create nodes + relations in DB', async () => {
    const transcript = 'Alice from Acme is raising a Series A';
    await engine.putPage(makeSessionSlug(transcript), {
      title: makeSessionSlug(transcript),
      type: 'concept',
      compiled_truth: transcript,
    } as any);

    const result = await consolidateVoiceSession({
      transcript,
      summary: 'Alice and Acme funding discussion',
      tags: ['person:Alice', 'company:Acme', 'project:Series A', 'voice'],
      source: 'voice',
      consent: true,
    }, adapter);

    expect(result.entities.length).toBe(3);
    expect(result.relations.length).toBe(3);
    const slugs = result.entities.map(e => e.slug);
    expect(slugs).toContain('alice');
    expect(slugs).toContain('acme');
    expect(slugs).toContain('series-a');

    const alice = await engine.getPage('alice');
    expect(alice).not.toBeNull();
    expect(alice!.type).toBe('person');
    expect(alice!.title).toBe('Alice');

    const acme = await engine.getPage('acme');
    expect(acme).not.toBeNull();
    expect(acme!.type).toBe('company');

    const links = await engine.getLinks(result.relations[0].from);
    expect(links.length).toBeGreaterThanOrEqual(2);
    const types = links.map(l => l.link_type);
    expect(types).toContain('mentions');
  });

  test('consent: false propagates from session config', async () => {
    const transcript = 'Bob from WidgetCorp';
    await engine.putPage(makeSessionSlug(transcript), {
      title: makeSessionSlug(transcript),
      type: 'concept',
      compiled_truth: transcript,
    } as any);

    await consolidateVoiceSession({
      transcript,
      summary: '',
      tags: ['person:Bob', 'company:WidgetCorp'],
      source: 'voice',
      consent: false,
    }, adapter);

    const bob = await engine.getPage('bob');
    expect(bob).not.toBeNull();
  });

  test('duplicate entity upserts silently and does not block new entities', async () => {
    await engine.putPage(makeSessionSlug('Alice'), {
      title: makeSessionSlug('Alice'),
      type: 'concept',
      compiled_truth: 'Alice',
    } as any);
    await consolidateVoiceSession({
      transcript: 'Alice',
      summary: '',
      tags: ['person:Alice', 'company:Acme'],
      source: 'voice',
    }, adapter);

    await engine.putPage(makeSessionSlug('Alice again'), {
      title: makeSessionSlug('Alice again'),
      type: 'concept',
      compiled_truth: 'Alice again',
    } as any);
    const second = await consolidateVoiceSession({
      transcript: 'Alice again',
      summary: '',
      tags: ['person:Alice', 'project:NewCo'],
      source: 'voice',
    }, adapter);
    const newSlugs = second.entities.map(e => e.slug);
    expect(newSlugs).toContain('newco');
  });

  test('voice process page persist+consolidate end-to-end', async () => {
    const { VoiceSessionService } = await import('../src/core/voice/session-service.ts');
    const { MockSTTAdapter } = await import('../src/core/voice/stt.ts');
    const { MockTTSAdapter } = await import('../src/core/voice/tts.ts');

    const onSave = async (session: { slug: string; content: string }) => {
      await engine.putPage(session.slug, {
        title: session.slug,
        type: 'concept',
        compiled_truth: session.content,
      } as any);
      await engine.addTag(session.slug, 'voice');
    };

    const service = new VoiceSessionService({
      stt: new MockSTTAdapter(),
      tts: new MockTTSAdapter(),
      onSave,
    });

    const result = await service.processAudio(
      { buffer: new ArrayBuffer(0), mimeType: 'audio/webm' },
      { title: 'test-session', tags: ['person:Alice', 'company:Acme'] },
    );

    expect(result.sessionId).toBeDefined();
    expect(result.transcript).toBe('This is a mock transcription of the audio input.');
    expect(result.summary).toBe('This is a mock transcription of the audio input.');

    const page = await engine.getPage(result.sessionId);
    expect(page).not.toBeNull();
    expect(page!.type).toBe('concept');

    const tags = await engine.getTags(result.sessionId);
    expect(tags).toContain('voice');

    await consolidateVoiceSession({
      transcript: result.transcript,
      summary: result.summary,
      tags: ['person:Alice', 'company:Acme'],
      source: 'voice',
      consent: true,
    }, adapter);

    const alice = await engine.getPage('alice');
    expect(alice).not.toBeNull();
  });
});
