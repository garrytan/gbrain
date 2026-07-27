/**
 * twilio-venus-bridge.mjs — Bridge Twilio Media Streams to Gemini Live API
 * 
 * Supports TWO-PHASE authentication:
 *   Phase 1: Gatekeeper (zero context, auth tools only)
 *   Phase 2: Full Venus (all context + tools, loaded after auth)
 * 
 * The Twilio WebSocket stays connected throughout. On upgrade,
 * the Gemini connection is closed and a new one opened with full context.
 */

import WebSocket from 'ws';
import { createTwilioToGeminiProcessor, createGeminiToTwilioProcessor } from './audio-convert.mjs';

/**
 * Create a Twilio↔Venus bridge with upgrade support.
 * 
 * @param {WebSocket} twilioWs - Twilio media stream WebSocket
 * @param {Object} opts
 * @param {string} opts.geminiApiKey
 * @param {string} opts.model
 * @param {string} opts.systemPrompt - Initial prompt (gatekeeper or full)
 * @param {Array} opts.toolDefs - Initial tool declarations
 * @param {Function} opts.onToolCall - (name, args) => Promise<result>
 * @param {Function} opts.onTranscript - (entry) => void  
 * @param {Function} opts.onCallStart - (callSid, callerPhone) => void
 * @param {Function} opts.onCallEnd - (callSid, callerPhone, duration, transcript) => void
 * @param {string} opts.voiceName
 */
export function createBridge(twilioWs, opts) {
  const {
    geminiApiKey,
    model = 'gemini-2.5-flash-native-audio-latest',
    systemPrompt = '',
    toolDefs = [],
    onToolCall = async () => ({}),
    onTranscript = () => {},
    onCallStart = () => {},
    onCallEnd = () => {},
    voiceName = 'Aoede',
  } = opts;

  // Mutable state — persists across upgrades
  let streamSid = null;
  let callSid = null;
  let callerPhone = '';
  let callEnded = false;
  const callStartTime = Date.now();
  const transcript = [];
  let audioChunksIn = 0;
  let audioChunksOut = 0;
  let audioFlushes = 0;

  // Current Gemini session — replaced on upgrade
  let geminiWs = null;
  let setupDone = false;
  let currentToolCall = opts.onToolCall;
  let _twilioToolAbort = null;
  let _twilioToolCancelled = false;
  
  // Audio processors — recreated on upgrade for clean state
  let inProcessor = null;
  let outProcessor = null;

  function createAudioProcessors() {
    outProcessor = createGeminiToTwilioProcessor();
    inProcessor = createTwilioToGeminiProcessor((pcmBase64) => {
      audioFlushes++;
      if (setupDone && geminiWs?.readyState === WebSocket.OPEN) {
        geminiWs.send(JSON.stringify({
          realtime_input: {
            audio: { mime_type: 'audio/pcm;rate=16000', data: pcmBase64 }
          }
        }));
        if (audioFlushes % 50 === 1) {
          console.log(`[twilio-venus] Audio: ${audioChunksIn} in, ${audioFlushes} flushes, ${audioChunksOut} out`);
        }
      }
    }, 200);
  }

  // ── Connect to Gemini ─────────────────────────────────
  function connectGemini(prompt, tools, toolHandler, voice) {
    setupDone = false;
    currentToolCall = toolHandler;
    createAudioProcessors();

    const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${geminiApiKey}`;
    geminiWs = new WebSocket(geminiUrl);

    geminiWs.on('open', () => {
      console.log('[twilio-venus] Gemini connected, sending setup');
      const setup = {
        setup: {
          model: `models/${model}`,
          generation_config: Object.assign(
            { response_modalities: ['AUDIO'] },
            !model.includes('3.1-flash-live') ? {
              speech_config: { voice_config: { prebuilt_voice_config: { voice_name: voice || voiceName } } }
            } : {}
          ),
          system_instruction: { parts: [{ text: prompt }] },
          tools: tools.length > 0 ? [{ function_declarations: tools }] : undefined,
        }
      };
      geminiWs.send(JSON.stringify(setup));
    });

    geminiWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.setupComplete) {
          setupDone = true;
          console.log(`[twilio-venus] Gemini setupComplete (${audioChunksIn} chunks buffered)`);
          return;
        }

        // Tool call cancellation (BUG FIX 2026-04-23)
        if (msg.toolCallCancellation) {
          console.log(`[twilio-venus] Tool call cancelled: ${JSON.stringify(msg.toolCallCancellation?.ids || [])}`);
          if (_twilioToolAbort) { _twilioToolAbort.abort(); _twilioToolAbort = null; }
          _twilioToolCancelled = true;
          return;
        }

        // Tool call
        if (msg.toolCall) {
          _twilioToolCancelled = false;
          _twilioToolAbort = new AbortController();
          const calls = msg.toolCall.functionCalls || [];
          Promise.all(calls.map(async (fc) => {
            if (_twilioToolCancelled) return null;
            console.log(`[twilio-venus] Tool: ${fc.name}(${JSON.stringify(fc.args).slice(0, 80)})`);
            const elapsed = ((Date.now() - callStartTime) / 1000).toFixed(1);
            transcript.push({ role: 'tool', text: `[${elapsed}s] ${fc.name}`, ts: elapsed });
            onTranscript({ role: 'tool', text: fc.name, ts: elapsed });

            try {
              const result = await currentToolCall(fc.name, fc.args || {});
              if (_twilioToolCancelled) return null;
              return { id: fc.id, name: fc.name, response: result };
            } catch (e) {
              if (_twilioToolCancelled || e.name === 'AbortError') return null;
              return { id: fc.id, name: fc.name, response: { error: e.message } };
            }
          })).then((responses) => {
            const valid = responses.filter(r => r !== null);
            if (!_twilioToolCancelled && valid.length > 0 && geminiWs?.readyState === WebSocket.OPEN) {
              geminiWs.send(JSON.stringify({
                tool_response: { function_responses: valid }
              }));
            } else if (_twilioToolCancelled) {
              console.log('[twilio-venus] Tool response suppressed — cancelled');
            }
            _twilioToolAbort = null;
          });
          return;
        }

        // Audio/text from Gemini → Twilio
        if (msg.serverContent?.modelTurn?.parts) {
          for (const part of msg.serverContent.modelTurn.parts) {
            if (part.inlineData?.data && streamSid && twilioWs.readyState === WebSocket.OPEN) {
              const ulawBase64 = outProcessor.process(part.inlineData.data);
              audioChunksOut++;
              twilioWs.send(JSON.stringify({
                event: 'media', streamSid,
                media: { payload: ulawBase64 }
              }));
            }
            if (part.text) {
              const elapsed = ((Date.now() - callStartTime) / 1000).toFixed(1);
              transcript.push({ role: 'venus', text: part.text, ts: elapsed });
              onTranscript({ role: 'venus', text: part.text, ts: elapsed });
            }
          }
        }

        // Turn complete
        if (msg.serverContent?.turnComplete) {
          if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'turn-end' } }));
          }
        }
      } catch (e) {
        console.error('[twilio-venus] Parse error:', e.message);
      }
    });

    geminiWs.on('close', (code, reason) => {
      console.log(`[twilio-venus] Gemini closed: ${code} ${reason?.toString()?.slice(0, 80)}`);
    });

    geminiWs.on('error', (e) => {
      console.error('[twilio-venus] Gemini error:', e.message);
    });
  }

  // Start initial Gemini connection
  connectGemini(systemPrompt, toolDefs, opts.onToolCall, voiceName);

  // ── Handle Twilio messages ────────────────────────────
  twilioWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        callerPhone = msg.start.customParameters?.callerPhone || '';
        console.log(`[twilio-venus] Call started: ${streamSid} from ${callerPhone || 'unknown'}`);
        onCallStart(callSid, callerPhone);
      }

      if (msg.event === 'media' && msg.media?.payload) {
        audioChunksIn++;
        if (setupDone && inProcessor) {
          inProcessor.push(msg.media.payload);
        }
      }

      if (msg.event === 'stop') {
        console.log(`[twilio-venus] Call stopped: ${streamSid} (${audioChunksIn} in, ${audioFlushes} flushes, ${audioChunksOut} out)`);
        if (inProcessor) inProcessor.flush();
        if (!callEnded) {
          callEnded = true;
          const duration = Math.round((Date.now() - callStartTime) / 1000);
          onCallEnd(callSid, callerPhone, duration, transcript);
        }
        if (geminiWs?.readyState === WebSocket.OPEN) geminiWs.close();
      }
    } catch (e) {
      console.error('[twilio-venus] Twilio msg error:', e.message);
    }
  });

  twilioWs.on('close', () => {
    console.log('[twilio-venus] Twilio disconnected');
    if (!callEnded && callSid) {
      callEnded = true;
      const duration = Math.round((Date.now() - callStartTime) / 1000);
      onCallEnd(callSid, callerPhone, duration, transcript);
    }
    if (geminiWs?.readyState === WebSocket.OPEN) geminiWs.close();
  });

  // ── Public API ────────────────────────────────────────
  return {
    get streamSid() { return streamSid; },
    get callSid() { return callSid; },
    get callerPhone() { return callerPhone; },
    get transcript() { return transcript; },

    /**
     * UPGRADE: Close gatekeeper Gemini, open full Venus Gemini.
     * Twilio audio stream stays connected throughout.
     * Caller hears a brief pause while the new session connects.
     */
    upgrade(newPrompt, newTools, newToolHandler, newVoice) {
      console.log('[twilio-venus] ⬆️ UPGRADING: gatekeeper → full Venus');
      
      // Close gatekeeper Gemini
      if (geminiWs?.readyState === WebSocket.OPEN) {
        geminiWs.close();
      }

      // Log the upgrade in transcript
      const elapsed = ((Date.now() - callStartTime) / 1000).toFixed(1);
      transcript.push({ role: 'system', text: `[${elapsed}s] UPGRADED to full Venus (${newTools.length} tools)`, ts: elapsed });

      // Connect new Gemini with full context
      connectGemini(newPrompt, newTools, newToolHandler, newVoice);
    },

    close() {
      if (geminiWs?.readyState === WebSocket.OPEN) geminiWs.close();
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    }
  };
}
