/**
 * TTS MCP Server for NanoClaw
 * Converts text to Finnish MP3 using ElevenLabs TTS (eleven_multilingual_v2).
 * Falls back to Piper TTS (fi_FI-harri-medium) if ELEVENLABS_API_KEY is not set.
 * Files are saved to /workspace/group/tts-cache/ and served via dashboard HTTP.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const PIPER_BIN = '/opt/piper/piper';
const PIPER_MODEL = '/opt/piper/fi_FI-harri-medium.onnx';
const TTS_CACHE_DIR = '/workspace/group/tts-cache';
const TTS_BASE_URL = 'http://192.168.1.122:8080/tts';
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const SONOS_API_URL = process.env.SONOS_API_URL || 'http://localhost:5005';
const SONOS_ROOM = 'Olohuone';
const TTS_VOLUME_CAP = 30;

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
// Default voice: Rachel (21m00Tcm4TlvDq8ikWAM) — natural female, works well with Finnish via eleven_multilingual_v2
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const TOKEN_USAGE_LOG = '/workspace/group/token-usage.jsonl';

// ElevenLabs pricing: ~$0.30 per 1k characters (Creator plan)
const ELEVENLABS_TTS_COST_PER_MILLION_CHARS = 300.00;

function logTtsUsage(text: string, engine: string): void {
  const chars = text.length;
  const isElevenLabs = engine === 'elevenlabs-tts';
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    service: isElevenLabs ? 'elevenlabs_tts' : 'piper_tts',
    chars,
    model: isElevenLabs ? 'eleven_multilingual_v2' : engine,
    cost_usd: isElevenLabs
      ? Math.round((chars * ELEVENLABS_TTS_COST_PER_MILLION_CHARS / 1_000_000) * 1_000_000) / 1_000_000
      : 0.0,
  };
  if (isElevenLabs) {
    entry.voice = ELEVENLABS_VOICE_ID;
  }
  try {
    fs.appendFileSync(TOKEN_USAGE_LOG, JSON.stringify(entry) + '\n');
  } catch { /* ignore */ }
}

async function getSonosVolume(): Promise<number> {
  try {
    const resp = await fetch(`${SONOS_API_URL}/${SONOS_ROOM}/state`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const state = await resp.json() as {
      playbackState?: string;
      volume?: number;
      currentTrack?: { type?: string };
    };
    const playbackState = state.playbackState ?? '';
    const currentVolume = typeof state.volume === 'number' ? state.volume : 25;
    const trackType = state.currentTrack?.type ?? '';

    let vol: number;
    const isPlaying = playbackState === 'PLAYING' || trackType === 'line_in' || trackType === 'line-in';
    if (isPlaying) {
      // /clip pauses music before playing, so TTS plays in silence — match ambient volume.
      // If volume is very low (< 5), use 15 minimum so TTS is audible.
      vol = currentVolume < 5 ? 15 : Math.min(currentVolume, TTS_VOLUME_CAP);
      const tag = trackType === 'line_in' || trackType === 'line-in' ? 'line-in' : 'PLAYING';
      log(`Sonos state: ${tag} at ${currentVolume} → TTS volume ${vol}`);
    } else {
      // Paused or stopped
      vol = 20;
      log(`Sonos state: ${playbackState || 'STOPPED'} → TTS volume ${vol}`);
    }
    return vol;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Could not fetch Sonos state (${msg}), defaulting to 20`);
    return 20;
  }
}

function log(msg: string): void {
  console.error(`[TTS] ${msg}`);
}

/** Get MP3 duration in milliseconds using ffprobe. Falls back to size estimate. */
function getMp3DurationMs(mp3Path: string): number {
  try {
    const result = spawnSync('ffprobe', [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      mp3Path,
    ], { timeout: 5000 });
    if (result.status === 0) {
      const secs = parseFloat(result.stdout.toString().trim());
      if (!isNaN(secs) && secs > 0) {
        log(`ffprobe duration: ${secs.toFixed(2)}s`);
        return Math.round(secs * 1000);
      }
    }
  } catch { /* fall through */ }
  // Fallback: 128kbps → 16000 bytes/s
  const fileStat = fs.statSync(mp3Path);
  const estimatedMs = Math.round((fileStat.size / 16000) * 1000);
  log(`ffprobe unavailable, size estimate: ${estimatedMs}ms`);
  return estimatedMs;
}


async function synthesizeWithElevenLabs(text: string, mp3Path: string): Promise<void> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      language_code: 'fi',
      output_format: 'mp3_44100_128',
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`ElevenLabs TTS HTTP ${resp.status}: ${body}`);
  }

  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(mp3Path, buffer);
}

function generatePiperTTS(text: string, mp3Path: string): void {
  const wavPath = mp3Path.replace(/\.mp3$/, '.wav');

  const piperResult = spawnSync(PIPER_BIN, [
    '--model', PIPER_MODEL,
    '--output_file', wavPath,
  ], {
    input: text,
    encoding: 'utf-8',
    timeout: 30000,
  });

  if (piperResult.status !== 0) {
    throw new Error(`Piper failed: ${piperResult.stderr || ''}`);
  }

  const lameResult = spawnSync('lame', [wavPath, mp3Path], { timeout: 15000 });
  try { fs.unlinkSync(wavPath); } catch { /* ignore */ }

  if (lameResult.status !== 0) {
    throw new Error(`lame failed: ${lameResult.stderr?.toString() || ''}`);
  }
}

function cleanup(): void {
  try {
    const now = Date.now();
    const files = fs.readdirSync(TTS_CACHE_DIR);
    for (const file of files) {
      const fp = path.join(TTS_CACHE_DIR, file);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > MAX_AGE_MS) {
          fs.unlinkSync(fp);
          log(`Deleted old file: ${file}`);
        }
      } catch { /* skip */ }
    }
  } catch { /* directory may not exist yet */ }
}

const server = new McpServer({ name: 'piper_tts', version: '1.0.0' });

server.tool(
  'tts_speak',
  'Convert text to a Finnish MP3 using ElevenLabs TTS (eleven_multilingual_v2) or Piper fallback. Returns file path and URL. Optionally plays on Sonos.',
  {
    text: z.string().describe('The text to convert to speech (Finnish)'),
    filename: z.string().optional().describe('Optional filename (without extension). Defaults to a UUID.'),
    play_on_sonos: z.boolean().optional().describe('If true, play the generated MP3 on Sonos (room: Olohuone) via node-sonos-http-api.'),
    volume: z.number().int().min(0).max(30).optional().describe('Optional fixed TTS volume (0–30). Bypasses auto-sensing. Hard cap of 30 always applies.'),
  },
  async ({ text, filename, play_on_sonos, volume }) => {
    cleanup();

    fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });

    const id = filename || crypto.randomUUID();
    const mp3Path = path.join(TTS_CACHE_DIR, `${id}.mp3`);

    log(`Generating TTS for: ${text.slice(0, 80)}...`);

    // Generate MP3: ElevenLabs TTS if key is set, otherwise Piper fallback
    if (ELEVENLABS_API_KEY) {
      log(`Using ElevenLabs TTS (voice: ${ELEVENLABS_VOICE_ID}, model: eleven_multilingual_v2, lang: fi)`);
      try {
        await synthesizeWithElevenLabs(text, mp3Path);
        logTtsUsage(text, 'elevenlabs-tts');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`ElevenLabs TTS failed: ${msg}`);
        return {
          content: [{ type: 'text' as const, text: `ElevenLabs TTS failed: ${msg}` }],
          isError: true,
        };
      }
    } else {
      log('ELEVENLABS_API_KEY not set, falling back to Piper (fi_FI-harri-medium)');
      try {
        generatePiperTTS(text, mp3Path);
        logTtsUsage(text, 'piper-tts');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`Piper TTS failed: ${msg}`);
        return {
          content: [{ type: 'text' as const, text: `Piper TTS failed: ${msg}` }],
          isError: true,
        };
      }
    }

    const url = `${TTS_BASE_URL}/${id}.mp3`;
    log(`Generated: ${mp3Path} → ${url}`);

    const result: Record<string, unknown> = { path: mp3Path, url };

    if (play_on_sonos) {
      // Determine TTS volume: fixed override (capped) or auto-sensed
      let ttsVolume: number;
      if (typeof volume === 'number') {
        ttsVolume = Math.min(volume, TTS_VOLUME_CAP);
        log(`Using fixed volume: ${volume} → capped to ${ttsVolume}`);
      } else {
        ttsVolume = await getSonosVolume();
      }

      const sonosClipsPath = process.env.SONOS_CLIPS_PATH;

      if (sonosClipsPath) {
        // Option A: Copy MP3 to node-sonos-http-api's static/clips dir,
        // then call /clip/{filename} — no URL needed, file served locally.
        const clipFilename = `${id}.mp3`;
        const clipDest = path.join(sonosClipsPath, clipFilename);
        try {
          fs.copyFileSync(mp3Path, clipDest);
          log(`Copied MP3 to clips dir: ${clipDest}`);

          const clipEndpoint = `${SONOS_API_URL}/${SONOS_ROOM}/clip/${encodeURIComponent(clipFilename)}/${ttsVolume}`;
          log(`Playing on Sonos (clip): GET ${clipEndpoint}`);
          const resp = await fetch(clipEndpoint);
          const body = await resp.text();
          log(`Sonos response: ${resp.status} ${body}`);

          if (resp.ok) {
            result.playing = true;
            result.room = SONOS_ROOM;

            // Wait for clip to finish playing, then restore Sonos audio.
            // Uses ffprobe for exact duration + 0.3s buffer; falls back to size estimate + 0.5s.
            try {
              const durationMs = getMp3DurationMs(mp3Path);
              const hasFfprobe = (() => { try { return spawnSync('ffprobe', ['-version'], { timeout: 2000 }).status === 0; } catch { return false; } })();
              const sleepMs = durationMs + (hasFfprobe ? 300 : 500);
              log(`Waiting ${sleepMs}ms for clip playback to finish...`);
              await new Promise<void>(resolve => setTimeout(resolve, sleepMs));
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              log(`Playback wait error: ${msg}`);
            }
          } else {
            result.playing = false;
            result.sonos_error = `HTTP ${resp.status}: ${body}`;
          }

          // Clean up the clip file after 60s (playback should be done by then)
          setTimeout(() => {
            try { fs.unlinkSync(clipDest); log(`Deleted clip: ${clipDest}`); } catch { /* ignore */ }
          }, 60_000);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`Sonos clip error: ${msg}`);
          result.playing = false;
          result.sonos_error = msg;
        }
      } else {
        // Fallback: /sayall endpoint (uses built-in TTS, not Piper, but audio still plays)
        try {
          const sayallUrl = `${SONOS_API_URL}/${SONOS_ROOM}/sayall/${encodeURIComponent(text)}/${ttsVolume}`;
          log(`Falling back to /sayall: GET ${sayallUrl}`);
          const resp = await fetch(sayallUrl);
          const body = await resp.text();
          log(`Sonos response: ${resp.status} ${body}`);
          if (resp.ok) {
            result.playing = true;
            result.room = SONOS_ROOM;
            result.sonos_note = 'Used /sayall fallback (SONOS_CLIPS_PATH not set)';

            // Estimate duration from text length (~5 chars/sec Finnish), add 0.3s buffer
            try {
              const sleepMs = Math.round((text.length / 5) * 1000) + 300;
              log(`Waiting ${sleepMs}ms for sayall playback to finish...`);
              await new Promise<void>(resolve => setTimeout(resolve, sleepMs));
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              log(`Playback wait error: ${msg}`);
            }
          } else {
            result.playing = false;
            result.sonos_error = `HTTP ${resp.status}: ${body}`;
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`Sonos sayall error: ${msg}`);
          result.playing = false;
          result.sonos_error = msg;
        }
      }
    }

    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result),
      }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
