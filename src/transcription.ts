import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const env = readEnvFile(['WHISPER_BIN', 'WHISPER_MODEL', 'WHISPER_LANG']);
const WHISPER_BIN = env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL =
  env.WHISPER_MODEL ||
  path.join(process.cwd(), 'data', 'models', 'ggml-base.bin');
const WHISPER_LANG = env.WHISPER_LANG || '';

/**
 * Transcribe an audio buffer using local whisper.cpp.
 * Converts to 16kHz WAV via ffmpeg, then runs whisper-cli.
 * Returns the transcript text or null on failure.
 */
export async function transcribeAudio(
  audio: Buffer,
  ext: string = 'ogg',
): Promise<string | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-voice-'));
  const inputPath = path.join(tmpDir, `input.${ext}`);
  const wavPath = path.join(tmpDir, 'audio.wav');

  try {
    await fs.writeFile(inputPath, audio);

    // Convert to 16kHz mono WAV (required by whisper.cpp)
    await exec('ffmpeg', [
      '-i',
      inputPath,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-f',
      'wav',
      wavPath,
      '-y',
    ]);

    // Run whisper-cli
    const whisperArgs = [
      '-m',
      WHISPER_MODEL,
      '-f',
      wavPath,
      '--no-timestamps',
      '-nt', // no_prints — suppress everything except the transcript
    ];
    if (WHISPER_LANG) {
      whisperArgs.push('-l', WHISPER_LANG);
    }
    const transcript = await exec(WHISPER_BIN, whisperArgs);

    const text = transcript.trim();
    if (!text) return null;

    logger.info({ chars: text.length, ext }, 'Transcribed voice message');
    return text;
  } catch (err) {
    logger.error({ err }, 'whisper.cpp transcription failed');
    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${cmd} failed: ${err.message}\nstderr: ${stderr}`));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}
