/**
 * audio-convert.mjs — µ-law ↔ PCM conversion for Twilio ↔ Gemini bridge
 * 
 * Twilio sends:  µ-law 8kHz mono base64 (20ms chunks = 160 bytes)
 * Gemini wants:  PCM 16-bit 16kHz mono base64 (buffered ~300ms)
 * Gemini sends:  PCM 16-bit 24kHz mono base64 (variable chunks)
 * Twilio wants:  µ-law 8kHz mono base64
 */

// ── µ-law decode table (ITU-T G.711) ─────────────────────
const ULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let u = ~i & 0xFF;
  let sign = u & 0x80;
  let exponent = (u >> 4) & 0x07;
  let mantissa = u & 0x0F;
  let sample = (mantissa << 3) + 0x84;
  sample <<= exponent;
  sample -= 0x84;
  ULAW_DECODE[i] = sign ? -sample : sample;
}

// ── PCM → µ-law encode ───────────────────────────────────
const ULAW_MAX = 0x1FFF;
const ULAW_BIAS = 0x84;

function pcmToUlaw(sample) {
  let sign = 0;
  if (sample < 0) { sign = 0x80; sample = -sample; }
  if (sample > ULAW_MAX) sample = ULAW_MAX;
  sample += ULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; exponent--, mask >>= 1) {}
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}

// ── Stateless converters (for unit tests + simple cases) ──

/**
 * Decode µ-law bytes to PCM 16-bit samples (no resampling)
 */
export function ulawToPcm8k(ulawBuf) {
  const pcm = new Int16Array(ulawBuf.length);
  for (let i = 0; i < ulawBuf.length; i++) {
    pcm[i] = ULAW_DECODE[ulawBuf[i]];
  }
  return pcm;
}

/**
 * Simple stateless: µ-law 8kHz base64 → PCM 16kHz base64
 * Uses linear interpolation. OK for testing, not ideal for production.
 */
export function ulawToGemini(base64Ulaw) {
  const ulawBuf = Buffer.from(base64Ulaw, 'base64');
  if (ulawBuf.length === 0) return '';
  const pcm8k = ulawToPcm8k(ulawBuf);
  const pcm16k = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    pcm16k[i * 2] = pcm8k[i];
    pcm16k[i * 2 + 1] = i < pcm8k.length - 1 ? (pcm8k[i] + pcm8k[i + 1]) >> 1 : pcm8k[i];
  }
  return Buffer.from(pcm16k.buffer).toString('base64');
}

/**
 * PCM 24kHz base64 → µ-law 8kHz base64 (downsample 3:1)
 */
export function geminiToUlaw(base64Pcm) {
  const pcmBuf = Buffer.from(base64Pcm, 'base64');
  const pcm24k = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.length / 2);
  const numOut = Math.floor(pcm24k.length / 3);
  const ulawBuf = Buffer.alloc(numOut);
  for (let i = 0; i < numOut; i++) {
    ulawBuf[i] = pcmToUlaw(pcm24k[i * 3]);
  }
  return ulawBuf.toString('base64');
}

/**
 * PCM 16kHz base64 → µ-law 8kHz base64 (downsample 2:1)
 */
export function gemini16kToUlaw(base64Pcm) {
  const pcmBuf = Buffer.from(base64Pcm, 'base64');
  const pcm16k = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.length / 2);
  const numOut = Math.floor(pcm16k.length / 2);
  const ulawBuf = Buffer.alloc(numOut);
  for (let i = 0; i < numOut; i++) {
    ulawBuf[i] = pcmToUlaw(pcm16k[i * 2]);
  }
  return ulawBuf.toString('base64');
}


// ── Stateful resampler for production use ─────────────────
// Proper linear interpolation with state across chunk boundaries

/**
 * Create a stateful 8kHz→16kHz upsampler.
 * Tracks the last sample across chunks for smooth interpolation.
 */
export function createUpsampler() {
  let lastSample = 0;
  
  return function upsample(pcm8k) {
    const pcm16k = new Int16Array(pcm8k.length * 2);
    for (let i = 0; i < pcm8k.length; i++) {
      const prev = i === 0 ? lastSample : pcm8k[i - 1];
      pcm16k[i * 2] = (prev + pcm8k[i]) >> 1; // Interpolated sample
      pcm16k[i * 2 + 1] = pcm8k[i];            // Original sample
    }
    lastSample = pcm8k[pcm8k.length - 1] || 0;
    return pcm16k;
  };
}

/**
 * Create a stateful 24kHz→8kHz downsampler.
 * Averages 3 samples for each output (low-pass filter).
 */
export function createDownsampler24to8() {
  let remainder = new Int16Array(0);
  
  return function downsample(pcm24k) {
    // Prepend any remainder from last chunk
    let input;
    if (remainder.length > 0) {
      input = new Int16Array(remainder.length + pcm24k.length);
      input.set(remainder);
      input.set(pcm24k, remainder.length);
    } else {
      input = pcm24k;
    }
    
    const numOut = Math.floor(input.length / 3);
    const leftover = input.length - numOut * 3;
    const out = new Int16Array(numOut);
    
    for (let i = 0; i < numOut; i++) {
      // Average 3 samples (simple low-pass)
      const idx = i * 3;
      out[i] = Math.round((input[idx] + input[idx + 1] + input[idx + 2]) / 3);
    }
    
    // Save leftover samples for next chunk
    remainder = leftover > 0 ? input.slice(input.length - leftover) : new Int16Array(0);
    
    return out;
  };
}

/**
 * Create a buffered audio processor for Twilio→Gemini.
 * Buffers µ-law chunks and flushes PCM 16kHz every ~300ms.
 * 
 * @param {Function} onFlush - (base64Pcm16k) => void
 * @param {number} flushMs - buffer duration before flushing (default 200ms)
 */
export function createTwilioToGeminiProcessor(onFlush, flushMs = 200) {
  const upsample = createUpsampler();
  // 16kHz * 2 bytes * flushMs/1000 = buffer threshold
  const FLUSH_BYTES = Math.floor(16000 * 2 * flushMs / 1000);
  let pcmBuffer = [];
  let totalBytes = 0;
  
  return {
    /** Process a base64 µ-law chunk from Twilio */
    push(base64Ulaw) {
      const ulawBuf = Buffer.from(base64Ulaw, 'base64');
      const pcm8k = ulawToPcm8k(ulawBuf);
      const pcm16k = upsample(pcm8k);
      pcmBuffer.push(Buffer.from(pcm16k.buffer));
      totalBytes += pcm16k.length * 2;
      
      if (totalBytes >= FLUSH_BYTES) {
        this.flush();
      }
    },
    
    /** Force flush any buffered audio */
    flush() {
      if (pcmBuffer.length === 0) return;
      const combined = Buffer.concat(pcmBuffer);
      pcmBuffer = [];
      totalBytes = 0;
      onFlush(combined.toString('base64'));
    },
    
    /** Get current buffer size in bytes */
    get bufferedBytes() { return totalBytes; },
  };
}

/**
 * Create a Gemini→Twilio audio processor.
 * Converts PCM 24kHz to µ-law 8kHz with proper downsampling.
 */
export function createGeminiToTwilioProcessor() {
  const downsample = createDownsampler24to8();
  
  return {
    /** Process base64 PCM 24kHz from Gemini → base64 µ-law 8kHz for Twilio */
    process(base64Pcm) {
      const pcmBuf = Buffer.from(base64Pcm, 'base64');
      const pcm24k = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, pcmBuf.length / 2);
      const pcm8k = downsample(pcm24k);
      
      const ulawBuf = Buffer.alloc(pcm8k.length);
      for (let i = 0; i < pcm8k.length; i++) {
        ulawBuf[i] = pcmToUlaw(pcm8k[i]);
      }
      return ulawBuf.toString('base64');
    }
  };
}
