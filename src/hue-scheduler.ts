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
import crypto from 'node:crypto';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const PROJECT_ROOT = process.cwd();
const STATE_FILE = path.join(PROJECT_ROOT, 'data', 'hue-fade.json');
const SCHEDULES_FILE = path.join(PROJECT_ROOT, 'data', 'hue-schedules.json');
const STEP_INTERVAL_MS = 3000; // brightness step every 3 seconds
const MAX_SCHEDULES = 5;

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

// ── Schedule types ─────────────────────────────────────────────────────────────

type ScheduleAction = 'dim' | 'on' | 'off';

interface HueSchedule {
  id: string;
  time: string; // HH:MM
  action: ScheduleAction;
  brightness?: number; // 1–100, only for 'dim'
  active: boolean;
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

// ── Hue Scene Scheduler ────────────────────────────────────────────────────────

let scheduleTickInterval: ReturnType<typeof setInterval> | null = null;

function loadSchedules(): HueSchedule[] {
  try {
    const raw = fs.readFileSync(SCHEDULES_FILE, 'utf-8');
    return JSON.parse(raw) as HueSchedule[];
  } catch {
    return [];
  }
}

function saveSchedules(schedules: HueSchedule[]): void {
  try {
    fs.mkdirSync(path.dirname(SCHEDULES_FILE), { recursive: true });
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
  } catch (err) {
    logger.warn({ err }, '[hue-schedule] Failed to persist schedules');
  }
}

/** Apply a schedule action to the default room (Olohuone) or all lights. */
async function applyScheduleAction(schedule: HueSchedule): Promise<void> {
  const { bridgeIp, apiKey } = getConfig();
  if (!bridgeIp || !apiKey) {
    logger.error('[hue-schedule] HUE_BRIDGE_IP or HUE_API_KEY not set');
    return;
  }

  const roomName = 'Olohuone';
  let groupedLightId: string | null;
  try {
    groupedLightId = await findRoomGroupedLightId(bridgeIp, apiKey, roomName);
  } catch (err) {
    logger.error({ err }, '[hue-schedule] Failed to reach Hue Bridge');
    return;
  }
  if (!groupedLightId) {
    logger.error({ roomName }, '[hue-schedule] Room not found');
    return;
  }

  const body: Record<string, unknown> = {};
  if (schedule.action === 'dim' && schedule.brightness !== undefined) {
    body.on = { on: true };
    body.dimming = { brightness: schedule.brightness };
  } else if (schedule.action === 'on') {
    body.on = { on: true };
  } else if (schedule.action === 'off') {
    body.on = { on: false };
  }

  try {
    await hueRequest(bridgeIp, apiKey, 'PUT', `/resource/grouped_light/${groupedLightId}`, body);
    logger.info({ schedule }, '[hue-schedule] Action applied');
  } catch (err) {
    logger.error({ err, schedule }, '[hue-schedule] Failed to apply action');
  }
}

function startScheduleTick(): void {
  if (scheduleTickInterval) return;
  scheduleTickInterval = setInterval(() => {
    const schedules = loadSchedules();
    const active = schedules.filter((s) => s.active);
    if (active.length === 0) return;

    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const currentTime = `${hh}:${mm}`;

    for (const schedule of active) {
      if (schedule.time === currentTime) {
        logger.info({ schedule }, '[hue-schedule] Firing scheduled action');
        void applyScheduleAction(schedule);
      }
    }
  }, 60_000); // check every minute
}

/** Call once at startup to restore schedules and start the tick loop. */
export function initHueScheduleRunner(): void {
  const schedules = loadSchedules();
  const active = schedules.filter((s) => s.active);
  if (active.length > 0) {
    logger.info({ count: active.length }, '[hue-schedule] Restored schedules');
  }
  startScheduleTick();
}

/** Add a new recurring schedule. Returns a status message. */
export function addHueSchedule(
  time: string,
  action: ScheduleAction,
  brightness?: number,
): string {
  const [hh, mm] = time.split(':').map(Number);
  if (isNaN(hh) || isNaN(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
    return `Invalid time "${time}". Use HH:MM format (e.g. 22:00).`;
  }
  if (action === 'dim' && (brightness === undefined || brightness < 1 || brightness > 100)) {
    return 'Brightness must be 1–100 for dim action.';
  }

  const schedules = loadSchedules();
  const active = schedules.filter((s) => s.active);
  if (active.length >= MAX_SCHEDULES) {
    return `Max ${MAX_SCHEDULES} active schedules reached. Cancel one first (/schedule hue cancel <id>).`;
  }

  const id = crypto.randomBytes(3).toString('hex');
  const schedule: HueSchedule = {
    id,
    time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
    action,
    ...(action === 'dim' ? { brightness } : {}),
    active: true,
  };
  schedules.push(schedule);
  saveSchedules(schedules);
  startScheduleTick();

  const desc = action === 'dim' ? `dim to ${brightness}%` : action;
  return `Schedule added [${id}]: ${desc} at ${schedule.time} daily.`;
}

/** List active schedules. */
export function listHueSchedules(): string {
  const schedules = loadSchedules().filter((s) => s.active);
  if (schedules.length === 0) return 'No active Hue schedules.';
  const lines = schedules.map((s) => {
    const desc = s.action === 'dim' ? `dim ${s.brightness}%` : s.action;
    return `• [${s.id}] ${s.time} — ${desc}`;
  });
  return `Active schedules:\n${lines.join('\n')}`;
}

/** Cancel a schedule by ID. */
export function cancelHueSchedule(id: string): string {
  const schedules = loadSchedules();
  const idx = schedules.findIndex((s) => s.id === id && s.active);
  if (idx === -1) return `No active schedule with id "${id}".`;
  schedules[idx].active = false;
  saveSchedules(schedules);
  return `Schedule [${id}] cancelled.`;
}
