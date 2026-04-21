/**
 * Audio transcription service.
 *
 * Default provider: Groq Whisper (fast, cheap, OpenAI-compatible API format).
 * Fallback: OpenAI Whisper if Groq unavailable.
 * For files >25MB: ffmpeg segmentation into <25MB chunks, transcribe each, concatenate.
 */

import { statSync, readFileSync } from 'fs';
import { basename, extname } from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface TranscriptionResult {
  text: string;
  segments: TranscriptionSegment[];
  language: string;
  duration: number;
  provider: string;
}

export interface TranscriptionConfig {
  provider?: 'groq' | 'openai' | 'deepgram';
  apiKey?: string;
  model?: string;
  language?: string;
  diarize?: boolean;
}

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

// Supported audio formats
const AUDIO_EXTENSIONS = new Set([
  '.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm', '.ogg', '.flac',
]);

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Transcribe an audio file using Groq Whisper (default) or OpenAI Whisper.
 * Files >25MB are segmented with ffmpeg before transcription.
 */
export async function transcribe(
  audioPath: string,
  config: TranscriptionConfig = {},
): Promise<TranscriptionResult> {
  // Validate file exists and is audio
  const stat = statSync(audioPath);
  const ext = extname(audioPath).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported audio format: ${ext}. Supported: ${[...AUDIO_EXTENSIONS].join(', ')}`);
  }

  // Determine provider and API key
  const provider = config.provider || detectProvider();
  const apiKey = config.apiKey || getApiKey(provider);
  if (!apiKey) {
    const envVar = provider === 'groq' ? 'GROQ_API_KEY' : 'OPENAI_API_KEY';
    throw new Error(
      `${provider} API key not set. Set ${envVar} environment variable. ` +
      (provider === 'groq' ? 'Or set OPENAI_API_KEY to use OpenAI Whisper as fallback.' : '')
    );
  }

  // Handle large files via segmentation
  if (stat.size > MAX_FILE_SIZE) {
    return transcribeLargeFile(audioPath, provider, apiKey, config);
  }

  // Single file transcription
  return transcribeFile(audioPath, provider, apiKey, config);
}

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

function detectProvider(): 'groq' | 'openai' {
  if (process.env.GROQ_API_KEY) return 'groq';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'groq'; // default, will fail with clear error if no key
}

function getApiKey(provider: string): string | undefined {
  switch (provider) {
    case 'groq': return process.env.GROQ_API_KEY;
    case 'openai': return process.env.OPENAI_API_KEY;
    case 'deepgram': return process.env.DEEPGRAM_API_KEY;
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------
// Single file transcription
// ---------------------------------------------------------------------------

async function transcribeFile(
  audioPath: string,
  provider: string,
  apiKey: string,
  config: TranscriptionConfig,
): Promise<TranscriptionResult> {
  const model = config.model || (provider === 'groq' ? 'whisper-large-v3' : 'whisper-1');
  const baseUrl = provider === 'groq'
    ? 'https://api.groq.com/openai/v1'
    : 'https://api.openai.com/v1';

  // Both Groq and OpenAI use the same API format
  const fileData = readFileSync(audioPath);
  const formData = new FormData();
  formData.append('file', new Blob([fileData]), basename(audioPath));
  formData.append('model', model);
  formData.append('response_format', 'verbose_json');
  if (config.language) formData.append('language', config.language);

  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Transcription failed (${provider} ${response.status}): ${errorText}`);
  }

  const data = await response.json() as any;

  return {
    text: data.text || '',
    segments: (data.segments || []).map((s: any) => ({
      start: s.start || 0,
      end: s.end || 0,
      text: s.text || '',
    })),
    language: data.language || config.language || 'unknown',
    duration: data.duration || 0,
    provider,
  };
}

// ---------------------------------------------------------------------------
// Large file segmentation
// ---------------------------------------------------------------------------

async function transcribeLargeFile(
  audioPath: string,
  provider: string,
  apiKey: string,
  config: TranscriptionConfig,
): Promise<TranscriptionResult> {
  // Check ffmpeg availability
  const ffmpegAvailable = await checkFfmpeg();
  if (!ffmpegAvailable) {
    throw new Error(
      'File exceeds 25MB and ffmpeg is required for segmentation. ' +
      'Install ffmpeg: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)'
    );
  }

  // Segment into ~20MB chunks (with some overlap for better joining)
  const { execSync } = await import('child_process');
  const tmpDir = execSync('mktemp -d').toString().trim();

  try {
    // Get audio duration
    const durationStr = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`,
      { encoding: 'utf-8' }
    ).trim();
    const totalDuration = parseFloat(durationStr) || 0;

    // Calculate segment length (~20MB per segment, estimate from file size)
    const stat = statSync(audioPath);
    const bytesPerSecond = stat.size / Math.max(totalDuration, 1);
    const segmentSeconds = Math.floor((20 * 1024 * 1024) / bytesPerSecond);

    // Split audio
    const ext = extname(audioPath);
    execSync(
      `ffmpeg -i "${audioPath}" -f segment -segment_time ${segmentSeconds} -c copy "${tmpDir}/segment_%03d${ext}"`,
      { stdio: 'pipe' }
    );

    // Transcribe each segment
    const { readdirSync } = await import('fs');
    const segments = readdirSync(tmpDir).filter(f => f.startsWith('segment_')).sort();
    const results: TranscriptionResult[] = [];
    let timeOffset = 0;

    for (const seg of segments) {
      const segPath = `${tmpDir}/${seg}`;
      const result = await transcribeFile(segPath, provider, apiKey, config);
      // Offset timestamps
      result.segments = result.segments.map(s => ({
        ...s,
        start: s.start + timeOffset,
        end: s.end + timeOffset,
      }));
      results.push(result);
      timeOffset += result.duration;
    }

    // Concatenate results
    return {
      text: results.map(r => r.text).join(' '),
      segments: results.flatMap(r => r.segments),
      language: results[0]?.language || 'unknown',
      duration: timeOffset,
      provider,
    };
  } finally {
    // Cleanup temp directory
    try { execSync(`rm -rf "${tmpDir}"`); } catch {}
  }
}

async function checkFfmpeg(): Promise<boolean> {
  try {
    const { execSync } = await import('child_process');
    execSync('ffmpeg -version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
