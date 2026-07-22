/**
 * browser-audio.mjs — puppeteer + fake-audio harness for voice E2E tests.
 *
 * Drives a Chromium browser through the agent-voice WebRTC flow with a
 * pre-recorded WAV file injected via Chromium's
 * `--use-file-for-fake-audio-capture` flag. Reads the `?test=1`-gated
 * `window._gbrainTest` namespace for counter + Blob extraction.
 *
 * Usage:
 *   import { runBrowserRoundtrip } from './lib/browser-audio.mjs';
 *   const result = await runBrowserRoundtrip({
 *     serverUrl: 'http://localhost:8765',
 *     audioFixturePath: '/path/to/utterance-add.wav',
 *     persona: 'venus',
 *     timeoutMs: 60000,
 *   });
 *   // result = {
 *   //   setupDone: bool,
 *   //   audioSendCount: number,
 *   //   audioPlayCount: number,
 *   //   responseBlob: Buffer | null,   ← captured response audio (webm/opus)
 *   //   error: string | null,
 *   //   consoleLog: Array<{type, text, at}>,
 *   //   timings: { setupMs, audioSendMs, audioPlayMs, totalMs },
 *   // }
 */

import puppeteer from 'puppeteer';

const DEFAULT_TIMEOUT_MS = 60000;

/**
 * Drive a full WebRTC roundtrip through the agent-voice browser client.
 *
 * @param {object} opts
 * @param {string} opts.serverUrl — origin of the running agent-voice server
 * @param {string} opts.audioFixturePath — absolute path to a 16kHz mono WAV
 * @param {string} [opts.persona] — 'mars' or 'venus' (default: 'venus')
 * @param {number} [opts.timeoutMs] — overall timeout (default: 60s)
 * @param {boolean} [opts.headless] — default true
 * @param {boolean} [opts.captureBlob] — extract MediaRecorder Blob (default true)
 * @returns {Promise<object>}
 */
export async function runBrowserRoundtrip(opts) {
  const {
    serverUrl,
    audioFixturePath,
    persona = 'venus',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    headless = true,
    captureBlob = true,
  } = opts;

  if (!serverUrl) throw new Error('serverUrl required');
  if (!audioFixturePath) throw new Error('audioFixturePath required');

  const t0 = Date.now();
  const timings = { setupMs: 0, audioSendMs: 0, audioPlayMs: 0, totalMs: 0 };
  const consoleLog = [];

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: headless ? 'new' : false,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${audioFixturePath}`,
        '--autoplay-policy=no-user-gesture-required',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-web-security',
        '--disable-background-timer-throttling',
        '--disable-features=VizDisplayCompositor',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    page.on('console', (msg) => {
      consoleLog.push({ type: msg.type(), text: msg.text(), at: Date.now() - t0 });
    });
    page.on('pageerror', (err) => {
      consoleLog.push({ type: 'pageerror', text: err.message, at: Date.now() - t0 });
    });

    const url = `${serverUrl}/call?test=1&persona=${encodeURIComponent(persona)}`;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Click Connect.
    await page.waitForSelector('.call-btn', { timeout: 10000 });
    await page.click('.call-btn');

    // Phase 1: setupDone (SDP exchange complete; call active).
    const setupT0 = Date.now();
    await page.waitForFunction(
      () => window._gbrainTest && window._gbrainTest.setupDone === true,
      { timeout: 25000 },
    );
    timings.setupMs = Date.now() - setupT0;

    // Phase 2: audioSendCount > 0 (mic → WebRTC → server pipe alive).
    const sendT0 = Date.now();
    await page.waitForFunction(
      () => window._gbrainTest && window._gbrainTest.audioSendCount > 0,
      { timeout: 25000 },
    );
    timings.audioSendMs = Date.now() - sendT0;

    // Phase 3: audioPlayCount > 0 (server → WebRTC → speaker pipe alive).
    const playT0 = Date.now();
    let playReached = false;
    try {
      await page.waitForFunction(
        () => window._gbrainTest && window._gbrainTest.audioPlayCount > 0,
        { timeout: Math.max(5000, timeoutMs - (Date.now() - t0)) },
      );
      playReached = true;
    } catch {
      // timeout — phase 3 not reached; report counters as-is below
    }
    timings.audioPlayMs = Date.now() - playT0;

    // Let MediaRecorder collect a few more seconds of response audio before extraction.
    if (playReached && captureBlob) {
      await new Promise((r) => setTimeout(r, 4000));
    }

    // Read counters + extract Blob via page.evaluate.
    const finalCounters = await page.evaluate(() => ({
      setupDone: !!window._gbrainTest?.setupDone,
      audioSendCount: window._gbrainTest?.audioSendCount || 0,
      audioPlayCount: window._gbrainTest?.audioPlayCount || 0,
      hasBlob: !!window._gbrainTest?.lastResponseBlob,
      blobSize: window._gbrainTest?.lastResponseBlob?.size || 0,
      error: window._gbrainTest?.log
        ? window._gbrainTest.log.find((l) => /ERROR/.test(l.text))?.text || null
        : null,
    }));

    let responseBlob = null;
    if (captureBlob && finalCounters.hasBlob) {
      // Extract the Blob bytes via base64 hop (Buffer-of-arrayBuffer through evaluate).
      const blobBase64 = await page.evaluate(async () => {
        const blob = window._gbrainTest.lastResponseBlob;
        if (!blob) return null;
        const arrayBuffer = await blob.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      });
      if (blobBase64) {
        responseBlob = Buffer.from(blobBase64, 'base64');
      }
    }

    timings.totalMs = Date.now() - t0;

    return {
      setupDone: finalCounters.setupDone,
      audioSendCount: finalCounters.audioSendCount,
      audioPlayCount: finalCounters.audioPlayCount,
      responseBlob,
      responseBlobSize: finalCounters.blobSize,
      error: finalCounters.error,
      consoleLog,
      timings,
    };
  } catch (err) {
    timings.totalMs = Date.now() - t0;
    return {
      setupDone: false,
      audioSendCount: 0,
      audioPlayCount: 0,
      responseBlob: null,
      responseBlobSize: 0,
      error: err.message || String(err),
      consoleLog,
      timings,
    };
  } finally {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * Decode WAV file → PCM Int16Array. Used for RMS-variance assertion when
 * the response Blob is a WAV (e.g., when MediaRecorder defaults to WAV
 * instead of webm/opus on Linux without opus support).
 */
export function decodeWav(buffer) {
  // Minimal WAV parser — assumes 16-bit PCM mono.
  if (buffer.length < 44) throw new Error('WAV too small');
  const dataStart = buffer.indexOf('data');
  if (dataStart < 0) throw new Error('no data chunk');
  const pcmStart = dataStart + 8; // skip 'data' + uint32 size
  const pcm = new Int16Array(buffer.buffer, buffer.byteOffset + pcmStart, (buffer.length - pcmStart) / 2);
  return pcm;
}

/**
 * Compute PCM RMS variance — used by the "non-silent" assertion.
 * Returns a normalized 0..1 value (32767 max amplitude = 1.0).
 */
export function pcmRmsVariance(pcm) {
  if (!pcm || pcm.length === 0) return 0;
  let mean = 0;
  for (let i = 0; i < pcm.length; i++) mean += pcm[i];
  mean /= pcm.length;
  let varianceSum = 0;
  for (let i = 0; i < pcm.length; i++) {
    const d = pcm[i] - mean;
    varianceSum += d * d;
  }
  return Math.sqrt(varianceSum / pcm.length) / 32767;
}
