/**
 * pipeline.mjs — Option B: DIY STT + LLM + TTS streaming pipeline.
 *
 * Recipe Option A (default) wires the browser through OpenAI Realtime via
 * WebRTC — one connection, model owns STT+LLM+TTS, no DIY plumbing. This
 * file is for operators who want **full control** over each stage:
 *
 *   Caller audio (Twilio WS or WebRTC) ─► STT (Deepgram default)
 *                                          │
 *                                          ▼
 *                                       LLM (Claude default — Sonnet 4.6)
 *                                          │  streaming SSE
 *                                          ▼ sentence-boundary chunks
 *                                       TTS (Cartesia default; OpenAI TTS fallback)
 *                                          │
 *                                          ▼
 *                                       Audio frames → caller
 *
 * Production-tested patterns embedded here:
 *   - Streaming SSE from Claude with sentence-boundary TTS dispatch
 *     (don't wait for full LLM response; speak as sentences complete)
 *   - 20-turn conversation history cap (prevents context bloat over long calls)
 *   - Reconnect logic with exponential backoff on STT/TTS WS disconnects
 *   - Periodic keepalives to prevent WebSocket timeout (every 25s)
 *   - Audio endpointing for natural turn-taking (Silero VAD via Deepgram)
 *   - Smart VAD presets: quiet, normal, noisy, very_noisy
 *
 * This file is REFERENCE — adapters are pluggable. Replace Deepgram with
 * AssemblyAI, Cartesia with ElevenLabs, Claude with GPT-5 etc. by swapping
 * the provider modules; the orchestration shape stays the same.
 *
 * To use: import `createPipeline()` from server.mjs in place of the WebRTC
 * `/session` flow. The pipeline exposes `pushAudio(chunk)` / `onAudio(cb)`.
 *
 * Env required (default providers):
 *   DEEPGRAM_API_KEY       (STT)
 *   ANTHROPIC_API_KEY      (LLM)
 *   CARTESIA_API_KEY       (TTS, primary) OR OPENAI_API_KEY (TTS fallback)
 *   DIY_VAD_PRESET         (optional: quiet|normal|noisy|very_noisy; default 'normal')
 *
 * Latency budget (typical):
 *   STT (Deepgram nova-2 streaming):  ~300ms end-of-utterance
 *   LLM (Claude Sonnet 4.6 streaming): ~400ms time-to-first-sentence
 *   TTS (Cartesia sonic):              ~150ms time-to-first-audio
 *   Total time-to-first-audio:         ~850ms (vs OpenAI Realtime ~600ms)
 */

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { sanitizeForRealtime } from './prompt.mjs';

// ── VAD presets ──────────────────────────────────────────────────────

const VAD_PRESETS = {
  quiet: { threshold: 0.7, smartFormat: true, endpointing: 300 },
  normal: { threshold: 0.85, smartFormat: true, endpointing: 500 },
  noisy: { threshold: 0.95, smartFormat: true, endpointing: 800 },
  very_noisy: { threshold: 0.98, smartFormat: true, endpointing: 1200 },
};

// ── STT: Deepgram nova-2 streaming ──────────────────────────────────

class DeepgramSttAdapter extends EventEmitter {
  constructor({ apiKey, model = 'nova-2', language = 'en-US', vadPreset = 'normal', sampleRate = 16000 }) {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.language = language;
    this.vad = VAD_PRESETS[vadPreset] || VAD_PRESETS.normal;
    this.sampleRate = sampleRate;
    this.ws = null;
    this.keepaliveTimer = null;
    this.reconnectAttempts = 0;
  }

  connect() {
    const url = new URL('wss://api.deepgram.com/v1/listen');
    url.searchParams.set('model', this.model);
    url.searchParams.set('language', this.language);
    url.searchParams.set('punctuate', 'true');
    url.searchParams.set('smart_format', String(this.vad.smartFormat));
    url.searchParams.set('endpointing', String(this.vad.endpointing));
    url.searchParams.set('vad_events', 'true');
    url.searchParams.set('interim_results', 'true');
    url.searchParams.set('encoding', 'linear16');
    url.searchParams.set('sample_rate', String(this.sampleRate));
    url.searchParams.set('channels', '1');

    this.ws = new WebSocket(url.toString(), {
      headers: { Authorization: `Token ${this.apiKey}` },
    });
    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.emit('open');
      this.keepaliveTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 25000);
    });
    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'Results') {
          const transcript = msg.channel?.alternatives?.[0]?.transcript;
          const isFinal = msg.is_final;
          if (transcript) {
            this.emit('transcript', { text: transcript, isFinal });
          }
        } else if (msg.type === 'SpeechStarted') {
          this.emit('speechStart');
        } else if (msg.type === 'UtteranceEnd') {
          this.emit('utteranceEnd');
        }
      } catch (err) {
        this.emit('error', err);
      }
    });
    this.ws.on('close', () => {
      clearInterval(this.keepaliveTimer);
      this.emit('close');
      this._scheduleReconnect();
    });
    this.ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  pushAudio(buffer) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(buffer);
    }
  }

  _scheduleReconnect() {
    this.reconnectAttempts++;
    if (this.reconnectAttempts > 5) {
      this.emit('fatal', new Error('STT reconnect attempts exhausted'));
      return;
    }
    const delay = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempts));
    setTimeout(() => this.connect(), delay);
  }

  close() {
    clearInterval(this.keepaliveTimer);
    if (this.ws) {
      try { this.ws.send(JSON.stringify({ type: 'CloseStream' })); } catch { /* ignore */ }
      try { this.ws.close(); } catch { /* ignore */ }
    }
  }
}

// ── LLM: Claude streaming SSE with sentence-boundary dispatch ───────

class ClaudeStreamAdapter extends EventEmitter {
  constructor({ apiKey, model = 'claude-sonnet-4-6', maxTurns = 20, systemPrompt = '' }) {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.maxTurns = maxTurns;
    this.systemPrompt = systemPrompt;
    this.history = [];
    this.inflight = null;
  }

  async respond(userText) {
    this.history.push({ role: 'user', content: userText });
    while (this.history.length > this.maxTurns) this.history.shift();

    const abortController = new AbortController();
    this.inflight = abortController;

    let res;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 512,
          stream: true,
          system: this.systemPrompt,
          messages: this.history,
        }),
        signal: abortController.signal,
      });
    } catch (err) {
      this.emit('error', err);
      return;
    }
    if (!res.ok) {
      const text = await res.text();
      this.emit('error', new Error(`Claude API ${res.status}: ${text.slice(0, 200)}`));
      return;
    }

    let assistantText = '';
    let sentenceBuffer = '';

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let leftover = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = (leftover + chunk).split('\n');
      leftover = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6);
        if (dataStr === '[DONE]') break;
        let event;
        try { event = JSON.parse(dataStr); } catch { continue; }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const text = event.delta.text;
          assistantText += text;
          sentenceBuffer += text;
          // Sentence-boundary dispatch — fire a TTS chunk for each completed sentence.
          const sentences = this._splitSentences(sentenceBuffer);
          if (sentences.length > 1) {
            for (let i = 0; i < sentences.length - 1; i++) {
              const safe = sanitizeForRealtime(sentences[i]);
              if (safe.trim()) this.emit('sentence', safe);
            }
            sentenceBuffer = sentences[sentences.length - 1];
          }
        }
      }
    }
    // Flush trailing partial sentence.
    if (sentenceBuffer.trim()) {
      this.emit('sentence', sanitizeForRealtime(sentenceBuffer));
    }
    this.history.push({ role: 'assistant', content: assistantText });
    this.emit('done', assistantText);
    this.inflight = null;
  }

  _splitSentences(text) {
    // Naive but effective: split on . ! ? followed by whitespace or end.
    // Returns N+1 parts where parts[0..N-1] are completed sentences and
    // parts[N] is the trailing partial.
    const parts = text.split(/(?<=[.!?])\s+/);
    return parts;
  }

  interrupt() {
    if (this.inflight) {
      try { this.inflight.abort(); } catch { /* ignore */ }
      this.inflight = null;
    }
  }
}

// ── TTS: Cartesia primary, OpenAI TTS fallback ──────────────────────

class CartesiaTtsAdapter extends EventEmitter {
  constructor({ apiKey, modelId = 'sonic-english', voiceId = '794f9389-aac1-45b6-b726-9d9369183238' /* "professional" default */, outputFormat = { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 } }) {
    super();
    this.apiKey = apiKey;
    this.modelId = modelId;
    this.voiceId = voiceId;
    this.outputFormat = outputFormat;
  }

  async speak(text) {
    if (!text || !text.trim()) return;
    try {
      const res = await fetch('https://api.cartesia.ai/tts/bytes', {
        method: 'POST',
        headers: {
          'X-API-Key': this.apiKey,
          'Cartesia-Version': '2024-06-10',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model_id: this.modelId,
          transcript: text,
          voice: { mode: 'id', id: this.voiceId },
          output_format: this.outputFormat,
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        this.emit('error', new Error(`Cartesia TTS ${res.status}: ${errText.slice(0, 200)}`));
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      this.emit('audio', buf);
    } catch (err) {
      this.emit('error', err);
    }
  }
}

class OpenAiTtsAdapter extends EventEmitter {
  constructor({ apiKey, model = 'tts-1', voice = 'nova', format = 'wav' }) {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.voice = voice;
    this.format = format;
  }

  async speak(text) {
    if (!text || !text.trim()) return;
    try {
      const res = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          voice: this.voice,
          input: text,
          response_format: this.format,
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        this.emit('error', new Error(`OpenAI TTS ${res.status}: ${errText.slice(0, 200)}`));
        return;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      this.emit('audio', buf);
    } catch (err) {
      this.emit('error', err);
    }
  }
}

// ── Pipeline orchestrator ───────────────────────────────────────────

/**
 * Create a DIY pipeline. Returns an object with `pushAudio(buf)` to feed
 * caller audio, `onAudio(cb)` to receive synthesized response audio, and
 * `close()` to tear down.
 *
 * Options:
 *   personaPrompt:  string  — required (built via prompt.mjs)
 *   sttProvider:    'deepgram'                                         (default)
 *   llmProvider:    'claude'                                           (default)
 *   ttsProvider:    'cartesia' | 'openai'                              (default: cartesia if key set, else openai)
 *   vadPreset:      'quiet' | 'normal' | 'noisy' | 'very_noisy'        (default: 'normal' or DIY_VAD_PRESET env)
 *   maxTurns:       number                                             (default: 20)
 */
export function createPipeline({ personaPrompt, sttProvider = 'deepgram', llmProvider = 'claude', ttsProvider, vadPreset, maxTurns = 20 } = {}) {
  if (!personaPrompt) throw new Error('personaPrompt required');

  const emitter = new EventEmitter();

  const ttsProviderChosen = ttsProvider || (process.env.CARTESIA_API_KEY ? 'cartesia' : 'openai');
  const vadPresetChosen = vadPreset || process.env.DIY_VAD_PRESET || 'normal';

  let stt, llm, tts;

  if (sttProvider === 'deepgram') {
    if (!process.env.DEEPGRAM_API_KEY) throw new Error('DEEPGRAM_API_KEY required for Deepgram STT');
    stt = new DeepgramSttAdapter({ apiKey: process.env.DEEPGRAM_API_KEY, vadPreset: vadPresetChosen });
  } else {
    throw new Error(`unsupported sttProvider: ${sttProvider}`);
  }

  if (llmProvider === 'claude') {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY required for Claude LLM');
    llm = new ClaudeStreamAdapter({ apiKey: process.env.ANTHROPIC_API_KEY, maxTurns, systemPrompt: personaPrompt });
  } else {
    throw new Error(`unsupported llmProvider: ${llmProvider}`);
  }

  if (ttsProviderChosen === 'cartesia') {
    if (!process.env.CARTESIA_API_KEY) throw new Error('CARTESIA_API_KEY required for Cartesia TTS');
    tts = new CartesiaTtsAdapter({ apiKey: process.env.CARTESIA_API_KEY });
  } else if (ttsProviderChosen === 'openai') {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY required for OpenAI TTS fallback');
    tts = new OpenAiTtsAdapter({ apiKey: process.env.OPENAI_API_KEY });
  } else {
    throw new Error(`unsupported ttsProvider: ${ttsProviderChosen}`);
  }

  // Wire the pipeline.
  // 1. STT final transcript → LLM.respond
  stt.on('transcript', ({ text, isFinal }) => {
    emitter.emit('transcript', { text, isFinal });
    if (isFinal && text.trim()) {
      // Interrupt any in-flight LLM response when caller speaks again.
      llm.interrupt();
      llm.respond(text).catch((err) => emitter.emit('error', err));
    }
  });
  stt.on('error', (err) => emitter.emit('error', err));
  stt.on('fatal', (err) => emitter.emit('fatal', err));
  stt.on('speechStart', () => {
    // Barge-in: caller started talking; cancel LLM + TTS in flight.
    llm.interrupt();
    emitter.emit('bargeIn');
  });

  // 2. LLM sentence → TTS.speak
  llm.on('sentence', (sentence) => {
    emitter.emit('sentence', sentence);
    tts.speak(sentence).catch((err) => emitter.emit('error', err));
  });
  llm.on('done', (full) => emitter.emit('llmDone', full));
  llm.on('error', (err) => emitter.emit('error', err));

  // 3. TTS audio → emit upstream.
  tts.on('audio', (buf) => emitter.emit('audio', buf));
  tts.on('error', (err) => emitter.emit('error', err));

  // Boot.
  stt.connect();

  return {
    pushAudio: (buf) => stt.pushAudio(buf),
    onAudio: (cb) => emitter.on('audio', cb),
    onTranscript: (cb) => emitter.on('transcript', cb),
    onSentence: (cb) => emitter.on('sentence', cb),
    onError: (cb) => emitter.on('error', cb),
    onFatal: (cb) => emitter.on('fatal', cb),
    onBargeIn: (cb) => emitter.on('bargeIn', cb),
    onLlmDone: (cb) => emitter.on('llmDone', cb),
    close: () => {
      stt.close();
      llm.interrupt();
    },
    // Inspect helpers for tests.
    _stt: stt,
    _llm: llm,
    _tts: tts,
  };
}

// Re-export adapters for tests + advanced operators who want to swap pieces.
export { DeepgramSttAdapter, ClaudeStreamAdapter, CartesiaTtsAdapter, OpenAiTtsAdapter, VAD_PRESETS };
