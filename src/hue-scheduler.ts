/**
 * Hue light fade scheduler for NanoClaw host side.
 * Drives brightness from 0% → 100% over a configurable duration.
 * Communicates directly with the Hue Bridge via HTTPS (local network).
 *
 * State is persisted to data/hue-fade.json so scheduled fades survive restarts.
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const PROJECT_ROOT = process.cwd();
const STATE_FILE = path.join(PROJECT_ROOT, 'data', 'hue-fade.json');
const STEP_INTERVAL_MS = 3000; // brightness step every 3 seconds

// TLS agent for self-signed Hue Bridge cert (local network only)
const tlsAgent = new https.Agent({ rejectUnauthorized: false });

// ── Types ─────────────────────────────────────────────────────────────────────

interface FadeState {
  roomName: string;
  groupedLightId: string;
  durationMs: number;
  startAt: string; // ISO — when to begin the ramp
}

interface HueRoom {
  id: string;
  metadata?: { name?: string };
  services?: Array<{ rid: string; rtype: string }>;
}

// ── In-memory handle ──────────────────────────────────────────────────────────

let preStartTimer: ReturnType<typeof setTimeout> | null = null;
let stepInterval: ReturnType<typeof setInterval> | null = null;
let currentState: FadeState | null = null;

// ── Hue API ───────────────────────────────────────────────────────────────────

function getConfig(): { bridgeIp: string; apiKey: string } {
  const env = readEnvFile(['HUE_BRIDGE_IP', 'HUE_API_KEY']);
  return { bridgeIp: env.HUE_BRIDGE_IP || '', apiKey: env.HUE_API_KEY || '' };
}

function hueRequest(
  bridgeIp: string,
  apiKey: string,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      hostname: bridgeIp,
      path: `/clip/v2${endpoint}`,
      method,
      headers: {
        'hue-application-key': apiKey,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
      agent: tlsAgent,
    };

    const req = https.request(options, (res) => {
      res.resume(); // drain response
      res.on('end', () => {
        resolve({
          ok: (res.statusCode ?? 0) < 300,
          status: res.statusCode ?? 0,
        });
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function hueRequestJson(
  bridgeIp: string,
  apiKey: string,
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      hostname: bridgeIp,
      path: `/clip/v2${endpoint}`,
      method,
      headers: {
        'hue-application-key': apiKey,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
      agent: tlsAgent,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve({
            ok: (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            data: JSON.parse(data),
          });
        } catch {
          resolve({
            ok: (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            data,
          });
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/** Find the grouped_light_id for a room by name (case-insensitive). */
async function findRoomGroupedLightId(
  bridgeIp: string,
  apiKey: string,
  roomName: string,
): Promise<string | null> {
  const result = await hueRequestJson(
    bridgeIp,
    apiKey,
    'GET',
    '/resource/room',
  );
  const rooms = ((result.data as { data?: HueRoom[] }).data || []) as HueRoom[];
  const match = rooms.find(
    (r) => (r.metadata?.name || '').toLowerCase() === roomName.toLowerCase(),
  );
  if (!match) return null;
  return match.services?.find((s) => s.rtype === 'grouped_light')?.rid ?? null;
}

// ── State persistence ─────────────────────────────────────────────────────────

function saveState(state: FadeState): void {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    logger.warn({ err }, '[hue-fade] Failed to persist state');
  }
}

function clearState(): void {
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch {
    /* ignore */
  }
  currentState = null;
}

function loadState(): FadeState | null {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw) as FadeState;
  } catch {
    return null;
  }
}

// ── Fade execution ────────────────────────────────────────────────────────────

function stopRunningFade(): void {
  if (preStartTimer) {
    clearTimeout(preStartTimer);
    preStartTimer = null;
  }
  if (stepInterval) {
    clearInterval(stepInterval);
    stepInterval = null;
  }
}

function runFade(state: FadeState): void {
  const { bridgeIp, apiKey } = getConfig();
  if (!bridgeIp || !apiKey) {
    logger.error(
      '[hue-fade] HUE_BRIDGE_IP or HUE_API_KEY not set — cannot run fade',
    );
    clearState();
    return;
  }

  const totalSteps = Math.max(
    2,
    Math.round(state.durationMs / STEP_INTERVAL_MS),
  );
  let step = 0;

  logger.info(
    { room: state.roomName, durationMs: state.durationMs, totalSteps },
    '[hue-fade] Starting fade',
  );

  async function applyStep(): Promise<void> {
    const brightness =
      step === 0
        ? 1
        : Math.min(100, Math.round(1 + (99 * step) / (totalSteps - 1)));
    const body: Record<string, unknown> = { dimming: { brightness } };
    if (step === 0) body.on = { on: true };

    try {
      await hueRequest(
        bridgeIp,
        apiKey,
        'PUT',
        `/resource/grouped_light/${state.groupedLightId}`,
        body,
      );
      logger.debug({ brightness, step, totalSteps }, '[hue-fade] Step applied');
    } catch (err) {
      logger.warn({ err }, '[hue-fade] Step failed — will retry next tick');
    }

    step++;
    if (step >= totalSteps) {
      logger.info({ room: state.roomName }, '[hue-fade] Fade complete');
      stopRunningFade();
      clearState();
    }
  }

  // Apply first step immediately, then on interval
  void applyStep();
  stepInterval = setInterval(() => {
    void applyStep();
  }, STEP_INTERVAL_MS);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Schedule a fade.
 * @param roomName   Room name as configured in Hue app (e.g. "Olohuone")
 * @param durationMinutes  Ramp duration in minutes
 * @param startTime  Optional HH:MM — if absent, starts immediately
 * @returns Status message for display to user
 */
export async function scheduleFade(
  roomName: string,
  durationMinutes: number,
  startTime?: string,
): Promise<string> {
  const { bridgeIp, apiKey } = getConfig();
  if (!bridgeIp || !apiKey) {
    return 'Hue not configured. Set HUE_BRIDGE_IP and HUE_API_KEY in .env';
  }

  // Look up room
  let groupedLightId: string | null;
  try {
    groupedLightId = await findRoomGroupedLightId(bridgeIp, apiKey, roomName);
  } catch (err) {
    return `Failed to reach Hue Bridge: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!groupedLightId) {
    return `Room "${roomName}" not found. Check the room name in your Hue app.`;
  }

  // Cancel any existing fade
  stopRunningFade();
  clearState();

  // Compute start time
  let startAt: Date;
  if (startTime) {
    const [hh, mm] = startTime.split(':').map(Number);
    if (isNaN(hh) || isNaN(mm))
      return `Invalid time "${startTime}". Use HH:MM format.`;
    const now = new Date();
    startAt = new Date(now);
    startAt.setHours(hh, mm, 0, 0);
    if (startAt <= now) {
      // Schedule for tomorrow
      startAt.setDate(startAt.getDate() + 1);
    }
  } else {
    startAt = new Date();
  }

  const state: FadeState = {
    roomName,
    groupedLightId,
    durationMs: durationMinutes * 60 * 1000,
    startAt: startAt.toISOString(),
  };

  currentState = state;
  saveState(state);

  const delayMs = startAt.getTime() - Date.now();

  if (delayMs <= 0) {
    runFade(state);
    return `Fading "${roomName}" to 100% over ${durationMinutes} min — starting now.`;
  } else {
    preStartTimer = setTimeout(() => {
      preStartTimer = null;
      runFade(state);
    }, delayMs);

    const timeStr = startAt.toLocaleTimeString('fi-FI', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `Fade for "${roomName}" scheduled at ${timeStr} (${durationMinutes} min duration).`;
  }
}

/** Cancel any active or scheduled fade. */
export function cancelFade(): string {
  if (!currentState && !loadState()) {
    return 'No active fade to cancel.';
  }
  const room =
    currentState?.roomName ?? loadState()?.roomName ?? 'unknown room';
  stopRunningFade();
  clearState();
  return `Fade cancelled for "${room}".`;
}

/** Call once at startup to restore a scheduled fade from disk. */
export function initHueScheduler(): void {
  const state = loadState();
  if (!state) return;

  const startAt = new Date(state.startAt);
  const now = new Date();

  if (startAt <= now) {
    // Scheduled time passed — check if fade would still be in-progress
    const elapsed = now.getTime() - startAt.getTime();
    if (elapsed >= state.durationMs) {
      logger.info('[hue-fade] Stale scheduled fade found — discarding');
      clearState();
      return;
    }
    // Resume mid-fade: adjust state to account for time already elapsed
    const remaining = state.durationMs - elapsed;
    const resumedState: FadeState = {
      ...state,
      durationMs: remaining,
      startAt: now.toISOString(),
    };
    currentState = resumedState;
    saveState(resumedState);
    logger.info(
      { room: state.roomName, remaining },
      '[hue-fade] Resuming in-progress fade after restart',
    );
    runFade(resumedState);
    return;
  }

  // Still in pre-start wait
  currentState = state;
  const delayMs = startAt.getTime() - now.getTime();
  const timeStr = startAt.toLocaleTimeString('fi-FI', {
    hour: '2-digit',
    minute: '2-digit',
  });
  logger.info(
    { room: state.roomName, startAt: timeStr },
    '[hue-fade] Restored scheduled fade',
  );

  preStartTimer = setTimeout(() => {
    preStartTimer = null;
    runFade(state);
  }, delayMs);
}

/** Get a human-readable status of any active/pending fade. */
export function getFadeStatus(): string {
  const state = currentState ?? loadState();
  if (!state) return 'No fade scheduled.';

  const startAt = new Date(state.startAt);
  const now = new Date();

  if (stepInterval) {
    return `Fade in progress: "${state.roomName}", ${Math.round(state.durationMs / 60000)} min duration.`;
  }
  if (startAt > now) {
    const timeStr = startAt.toLocaleTimeString('fi-FI', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `Fade scheduled at ${timeStr}: "${state.roomName}", ${Math.round(state.durationMs / 60000)} min.`;
  }
  return 'No active fade.';
}
