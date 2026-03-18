/**
 * Samsung TV MCP Server for NanoClaw
 * Controls Samsung Smart TV via local WebSocket API (no cloud).
 * Supports 2018+ Samsung TVs with Tizen OS.
 *
 * Environment variables:
 *   SAMSUNG_TV_IP           — IP address of the Samsung TV (e.g. 192.168.1.207)
 *   SAMSUNG_TV_MAC          — MAC address for Wake-on-LAN (e.g. AA:BB:CC:DD:EE:FF)
 *                             Required for wake from deep standby (samsung_tv_power on).
 *                             Find it: TV Settings → General → Network → Network Status → IP Settings
 *   SAMSUNG_TV_TOKEN_FILE   — Path to persist the pairing token
 *                             (default: /data/samsung-tv-token.json)
 *
 * Pairing flow (2019+ models):
 *   1. Run samsung_tv_pair — TV shows an approval prompt on screen.
 *   2. Press OK on the TV remote to allow the connection.
 *   3. The token is saved to TOKEN_FILE and reused on future connections.
 *
 *   If no prompt appears: Settings → General → External Device Manager →
 *   Device Connection Manager → Access Notification → "First Time Only"
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import WebSocket from 'ws';
import fs from 'fs';
import dgram from 'dgram';

const SAMSUNG_TV_IP = process.env.SAMSUNG_TV_IP || '';
const SAMSUNG_TV_MAC = process.env.SAMSUNG_TV_MAC || '';
const TOKEN_FILE = process.env.SAMSUNG_TV_TOKEN_FILE || '/data/samsung-tv-token.json';
const APP_NAME = Buffer.from('NanoClaw').toString('base64');
// Persistent random device ID — avoids TV-side blocks from previous failed pairing attempts.
function getDeviceId(): string {
  const idFile = TOKEN_FILE.replace(/\.json$/, '-device-id.txt');
  try { const id = fs.readFileSync(idFile, 'utf8').trim(); if (id) return id; } catch { /* generate */ }
  const id = `nanoclaw-${Math.random().toString(36).slice(2, 10)}`;
  try { fs.writeFileSync(idFile, id); } catch { /* ignore */ }
  return id;
}
const DEVICE_ID = getDeviceId();
const CONNECT_TIMEOUT_MS = 5000;
const CMD_TIMEOUT_MS = 3000;
const PAIR_TIMEOUT_MS = 30000;

function log(msg: string): void {
  console.error(`[SAMSUNG] ${msg}`);
}

function notConfigured(): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text' as const, text: 'Samsung TV not configured. Set SAMSUNG_TV_IP in .env' }],
    isError: true,
  };
}

// ── Wake-on-LAN ────────────────────────────────────────────────────────────────

/**
 * Send a WOL magic packet to the given MAC address via UDP broadcast.
 * Magic packet: 0xFF×6 followed by the 6-byte MAC repeated 16 times = 102 bytes.
 */
function sendWOL(mac: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Normalise MAC: strip separators, validate, split into bytes
    const hex = mac.replace(/[:\-]/g, '').toLowerCase();
    if (!/^[0-9a-f]{12}$/.test(hex)) {
      reject(new Error(`Invalid MAC address: ${mac}`));
      return;
    }
    const macBytes = Buffer.from(hex, 'hex');

    const magic = Buffer.alloc(102);
    magic.fill(0xff, 0, 6);
    for (let i = 0; i < 16; i++) macBytes.copy(magic, 6 + i * 6);

    const broadcast = SAMSUNG_TV_IP.replace(/\.\d+$/, '.255'); // e.g. 192.168.1.255
    const sock = dgram.createSocket('udp4');
    sock.once('error', (err) => { sock.close(); reject(err); });
    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(magic, 0, magic.length, 9, broadcast, (err) => {
        sock.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

/**
 * Quick reachability check — tries port 8001 then 8002 with a short timeout.
 * Returns true if the TV accepts a WebSocket connection, false if both time out.
 */
async function isTVReachable(): Promise<boolean> {
  const QUICK_TIMEOUT = 2000;
  const r8001 = await connectTVPort(QUICK_TIMEOUT, false, 8001);
  if (!('error' in r8001)) { try { r8001.ws.close(); } catch { /* ignore */ } return true; }
  const r8002 = await connectTVPort(QUICK_TIMEOUT, false, 8002);
  if (!('error' in r8002)) { try { r8002.ws.close(); } catch { /* ignore */ } return true; }
  // Reachable if error is unauthorized (TV responded, just rejected us)
  return r8001.unauthorized === true || r8002.unauthorized === true;
}

// ── Token Persistence ──────────────────────────────────────────────────────────

let cachedToken: string | null | undefined = undefined; // undefined = not yet loaded

function loadToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as { token?: string };
    cachedToken = data.token ?? null;
    if (cachedToken) log(`Loaded saved token: ${cachedToken}`);
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

function saveToken(token: string): void {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token }), 'utf8');
    cachedToken = token;
    log(`Saved pairing token: ${token}`);
  } catch (err) {
    log(`Failed to save token: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function clearToken(): void {
  try { fs.unlinkSync(TOKEN_FILE); } catch { /* ignore */ }
  cachedToken = null;
  log('Cleared saved token (will re-pair on next connection)');
}

// ── URL Builder ────────────────────────────────────────────────────────────────

function tvUrl(overrideToken?: string | null, port: 8001 | 8002 = 8001): string {
  const token = overrideToken !== undefined ? overrideToken : loadToken();
  const scheme = port === 8002 ? 'wss' : 'ws';
  const base = `${scheme}://${SAMSUNG_TV_IP}:${port}/api/v2/channels/samsung.remote.control`
    + `?name=${APP_NAME}&uniqueId=${DEVICE_ID}`;
  return token ? `${base}&token=${token}` : base;
}

// ── Token extraction from ms.channel.connect ──────────────────────────────────

function extractToken(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  // Some TVs put token directly in data
  if (typeof d['token'] === 'string' && d['token']) return d['token'];
  // Others embed it in clients[0].attributes.token or clients[0].token
  const clients = d['clients'];
  if (Array.isArray(clients) && clients.length > 0) {
    const client = clients[0] as Record<string, unknown>;
    if (typeof client['token'] === 'string' && client['token']) return client['token'];
    const attrs = client['attributes'] as Record<string, unknown> | undefined;
    if (attrs && typeof attrs['token'] === 'string' && attrs['token']) return attrs['token'];
  }
  return null;
}

// ── WebSocket connect helper ───────────────────────────────────────────────────

interface ConnectedWS {
  ws: WebSocket;
  token: string | null;
}

/**
 * Open a WebSocket connection to the TV on a specific port and wait for connect/ready.
 * Returns an open WebSocket on success, or {error, unauthorized} on failure.
 */
async function connectTVPort(
  timeoutMs: number,
  noToken: boolean,
  port: 8001 | 8002,
): Promise<ConnectedWS | { error: string; unauthorized?: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket | null = null;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws?.close(); } catch { /* ignore */ }
      if (timeoutMs >= PAIR_TIMEOUT_MS) {
        resolve({ error: 'Timed out waiting for pairing approval (30s). Press OK on the TV remote when the approval prompt appears.' });
      } else {
        resolve({ error: `Connection timeout on port ${port} — TV may be off or IP incorrect` });
      }
    }, timeoutMs);

    function fail(msg: string, unauthorized = false): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* ignore */ }
      resolve({ error: msg, ...(unauthorized ? { unauthorized: true } : {}) });
    }

    try {
      ws = new WebSocket(tvUrl(noToken ? null : undefined, port), {
        handshakeTimeout: Math.min(timeoutMs, CONNECT_TIMEOUT_MS),
        rejectUnauthorized: false,
      });
    } catch (err) {
      fail(`WebSocket init error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString()) as { event?: string; data?: unknown };
        log(`TV event on port ${port}: ${msg.event ?? 'unknown'}`);

        if (msg.event === 'ms.channel.connect' || msg.event === 'ms.channel.ready') {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const token = extractToken(msg.data);
          if (token) saveToken(token);
          resolve({ ws: ws as WebSocket, token });
        } else if (msg.event === 'ms.channel.unauthorized') {
          // Don't clear token here — we may fall back to port 8002 and still need it.
          // Token is only cleared if both ports fail (handled in connectTV).
          fail(`ms.channel.unauthorized on port ${port}`, true);
        }
      } catch { /* non-JSON message, ignore */ }
    });

    ws.on('error', (err: Error) => fail(`Connection error on port ${port}: ${err.message}`));
    ws.on('close', () => { if (!settled) fail(`Connection closed unexpectedly on port ${port}`); });
  });
}

/**
 * Open a WebSocket connection to the TV. Tries port 8001 first, then port 8002 (SSL).
 * 2019 RU-series Samsung TVs often require port 8002.
 *
 * @param timeoutMs  How long to wait per port attempt (use PAIR_TIMEOUT_MS for pairing).
 * @param noToken    If true, connect without a saved token (forces new pairing prompt).
 */
async function connectTV(
  timeoutMs: number,
  noToken = false,
): Promise<ConnectedWS | { error: string }> {
  const portTimeout = timeoutMs >= PAIR_TIMEOUT_MS ? timeoutMs : Math.min(timeoutMs, CONNECT_TIMEOUT_MS + 1000);

  // Try port 8001 first
  const result8001 = await connectTVPort(portTimeout, noToken, 8001);
  if (!('error' in result8001)) return result8001;

  // On any error (including unauthorized), fall back to port 8002 (WSS)
  log(`Port 8001 failed (${result8001.error}), trying port 8002 (WSS)...`);
  const result8002 = await connectTVPort(portTimeout, noToken, 8002);
  if (!('error' in result8002)) return result8002;

  // Only clear a saved token when the TV explicitly rejected it (ms.channel.unauthorized
  // on both ports). Timeouts and connection errors mean the TV is unreachable — the token
  // is still valid and should be kept so it works again when the TV comes back online.
  const unauthorizedOnBoth = result8001.unauthorized && result8002.unauthorized;
  if (unauthorizedOnBoth) {
    return {
      error:
        'TV rejected connection with ms.channel.unauthorized on both port 8001 and 8002.\n\n'
        + 'Most likely cause: the TV has this device in its BLOCKED list from a previous\n'
        + 'rejected attempt. Even with Access Notification = First Time Only, blocked devices\n'
        + 'never get a prompt again.\n\n'
        + 'Fix:\n'
        + '1. On the TV: Settings → General → External Device Manager → Device List\n'
        + '   Find "nanoclaw" (or similar) and DELETE it.\n'
        + '2. Then run samsung_tv_pair — the approval prompt should now appear.\n\n'
        + 'If Device List is empty or nanoclaw is not there, try:\n'
        + '   Settings → General → External Device Manager → Device Connection Manager\n'
        + '   → Set Access Notification to "Always" temporarily, pair, then set back.',
    };
  }
  return {
    error: `Port 8001: ${result8001.error}\nPort 8002: ${result8002.error}`,
  };
}

// ── Send a key ─────────────────────────────────────────────────────────────────

async function sendKey(key: string): Promise<{ ok: boolean; message: string }> {
  const result = await connectTV(CONNECT_TIMEOUT_MS);
  if ('error' in result) return { ok: false, message: result.error };

  const { ws } = result;
  return new Promise((resolve) => {
    let settled = false;

    function settle(ok: boolean, message: string): void {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch { /* ignore */ }
      resolve({ ok, message });
    }

    const cmd = JSON.stringify({
      method: 'ms.remote.control',
      params: {
        Cmd: 'Click',
        DataOfCmd: key,
        Option: 'false',
        TypeOfRemote: 'SendRemoteKey',
      },
    });

    try {
      ws.send(cmd);
      log(`Sent key: ${key}`);
    } catch (err) {
      settle(false, `Failed to send key: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Give the TV CMD_TIMEOUT_MS to ack, then consider it sent.
    // A close event after a successful send is also success — the TV may close the
    // connection immediately on power-off commands (KEY_POWER, KEY_POWEROFF).
    setTimeout(() => settle(true, `Key ${key} sent`), CMD_TIMEOUT_MS);
    ws.on('error', (err: Error) => settle(false, `Error after send: ${err.message}`));
    ws.on('close', () => { if (!settled) settle(true, `Key ${key} sent`); });
  });
}

// ── MCP Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'samsung_tv', version: '1.0.0' });

// ── Tool: samsung_tv_pair ─────────────────────────────────────────────────────

server.tool(
  'samsung_tv_pair',
  'Pair with the Samsung TV. Triggers the on-screen approval prompt — the user must press OK on the TV remote within 30 seconds. Run this once before using other TV tools. Tries port 8001 (WS) then port 8002 (WSS) automatically. If ms.channel.unauthorized persists: go to Settings → General → External Device Manager → Device List and delete the nanoclaw entry, then try again.',
  {},
  async () => {
    if (!SAMSUNG_TV_IP) return notConfigured();
    log('Starting pairing — waiting up to 30s for TV approval...');
    const result = await connectTV(PAIR_TIMEOUT_MS, true);
    if ('error' in result) {
      return {
        content: [{ type: 'text' as const, text: result.error }],
        isError: true,
      };
    }
    try { result.ws.close(); } catch { /* ignore */ }
    const msg = result.token
      ? `Pairing successful. Token saved to ${TOKEN_FILE}. Future connections will not require re-pairing.`
      : 'Pairing approved by TV. No token returned (normal for some 2019 models) — connection is valid for this session.';
    log(msg);
    return { content: [{ type: 'text' as const, text: msg }] };
  },
);

// ── Tool: samsung_tv_power ────────────────────────────────────────────────────

server.tool(
  'samsung_tv_power',
  'Toggle Samsung TV power on or off. On 2016+ models KEY_POWERON/KEY_POWEROFF are not supported — all actions send KEY_POWER (toggle). For action=on: if the TV is in deep standby and unreachable, a Wake-on-LAN magic packet is sent first (requires SAMSUNG_TV_MAC env var), then KEY_POWER after a 3-second wake delay.',
  {
    action: z.enum(['toggle', 'on', 'off']).describe('Power action: toggle, on, or off (all send KEY_POWER on 2016+ models)'),
  },
  async (args) => {
    if (!SAMSUNG_TV_IP) return notConfigured();
    // 2016+ Samsung TVs (including 2019 RU-series) only support KEY_POWER (toggle).
    // KEY_POWERON and KEY_POWEROFF do not work on newer firmware.
    const key = 'KEY_POWER';
    log(`Power action: ${args.action} → KEY_POWER (2016+ toggle-only)`);

    // For 'on': check reachability, then decide WOL strategy.
    // Samsung TVs in "network standby" keep WebSocket port open (isTVReachable → true)
    // but still need WOL to wake the display. Always send WOL when MAC is set and
    // action is 'on', regardless of reachability — WOL is harmless if TV is already on.
    if (args.action === 'on') {
      const reachable = await isTVReachable();
      log(`TV reachable check: ${reachable}`);

      if (!reachable && !SAMSUNG_TV_MAC) {
        return {
          content: [{ type: 'text' as const, text: 'TV is unreachable (deep standby) and SAMSUNG_TV_MAC is not set — cannot send Wake-on-LAN. Set SAMSUNG_TV_MAC in .env and restart the container.' }],
          isError: true,
        };
      }

      if (SAMSUNG_TV_MAC) {
        const broadcast = SAMSUNG_TV_IP.replace(/\.\d+$/, '.255');
        log(`Sending WOL magic packet to MAC ${SAMSUNG_TV_MAC} via broadcast ${broadcast}:9 (reachable=${reachable})`);
        try {
          await sendWOL(SAMSUNG_TV_MAC);
          log('WOL magic packet sent successfully');
        } catch (err) {
          log(`WOL send error: ${err instanceof Error ? err.message : String(err)}`);
          // Only hard-fail if TV is also unreachable — if reachable, fall through to KEY_POWER
          if (!reachable) {
            return {
              content: [{ type: 'text' as const, text: `WOL failed: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            };
          }
        }

        if (!reachable) {
          // TV was fully off — poll every 2s up to 20s for it to become reachable
          log('TV was unreachable — polling every 2s (up to 20s) for WebSocket...');
          const POLL_INTERVAL_MS = 2000;
          const POLL_TIMEOUT_MS = 20000;
          const pollStart = Date.now();
          let woke = false;
          while (Date.now() - pollStart < POLL_TIMEOUT_MS) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            const nowReachable = await isTVReachable();
            log(`WOL poll: reachable=${nowReachable} (elapsed=${Date.now()-pollStart}ms)`);
            if (nowReachable) { woke = true; break; }
          }
          const elapsed = Math.round((Date.now() - pollStart) / 1000);
          log(woke ? `TV responded after ${elapsed}s — sending KEY_POWER` : `TV still unreachable after ${elapsed}s — sending KEY_POWER anyway`);
          const result = await sendKey(key);
          const wolNote = result.ok
            ? `WOL sent to ${SAMSUNG_TV_MAC} (broadcast ${broadcast}) → TV ${woke ? `responded in ${elapsed}s` : `polled for ${elapsed}s (no response)`} → KEY_POWER sent`
            : `WOL sent but KEY_POWER failed after ${elapsed}s wake wait: ${result.message}`;
          return {
            content: [{ type: 'text' as const, text: wolNote }],
            ...(result.ok ? {} : { isError: true as const }),
          };
        }
        // TV was in network standby (WebSocket reachable but display off) —
        // WOL sent above, fall through to KEY_POWER immediately
        log('TV in network standby — WOL sent, proceeding to KEY_POWER');
      }
    }

    const result = await sendKey(key);
    return {
      content: [{ type: 'text' as const, text: result.message }],
      ...(result.ok ? {} : { isError: true as const }),
    };
  },
);

// ── Tool: samsung_tv_volume ───────────────────────────────────────────────────

server.tool(
  'samsung_tv_volume',
  'Adjust Samsung TV volume. Can increase/decrease by a number of steps or mute.',
  {
    action: z.enum(['up', 'down', 'mute']).describe('Volume action: up, down, or mute'),
    steps: z.number().int().min(1).max(30).optional().describe('Number of volume steps (default: 1, max: 30)'),
  },
  async (args) => {
    if (!SAMSUNG_TV_IP) return notConfigured();
    if (args.action === 'mute') {
      const result = await sendKey('KEY_MUTE');
      return {
        content: [{ type: 'text' as const, text: result.message }],
        ...(result.ok ? {} : { isError: true as const }),
      };
    }
    const key = args.action === 'up' ? 'KEY_VOLUP' : 'KEY_VOLDOWN';
    const steps = args.steps ?? 1;
    log(`Volume ${args.action} × ${steps}`);
    for (let i = 0; i < steps; i++) {
      const result = await sendKey(key);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Failed at step ${i + 1}: ${result.message}` }],
          isError: true,
        };
      }
      if (steps > 1 && i < steps - 1) await new Promise(r => setTimeout(r, 200));
    }
    return { content: [{ type: 'text' as const, text: `Volume ${args.action} × ${steps} sent` }] };
  },
);

// ── Tool: samsung_tv_source ───────────────────────────────────────────────────

server.tool(
  'samsung_tv_source',
  'Switch Samsung TV input source (HDMI1, HDMI2, etc.).',
  {
    source: z.enum(['HDMI1', 'HDMI2', 'HDMI3', 'HDMI4', 'TV', 'HOME']).describe('Input source to switch to'),
  },
  async (args) => {
    if (!SAMSUNG_TV_IP) return notConfigured();
    const keyMap: Record<string, string> = {
      HDMI1: 'KEY_HDMI1', HDMI2: 'KEY_HDMI2', HDMI3: 'KEY_HDMI3', HDMI4: 'KEY_HDMI4',
      TV: 'KEY_TV', HOME: 'KEY_HOME',
    };
    const key = keyMap[args.source];
    log(`Source: ${args.source} → ${key}`);
    const result = await sendKey(key);
    return {
      content: [{ type: 'text' as const, text: result.message }],
      ...(result.ok ? {} : { isError: true as const }),
    };
  },
);

// ── Tool: samsung_tv_key ──────────────────────────────────────────────────────

server.tool(
  'samsung_tv_key',
  'Send any raw remote key to the Samsung TV. Use for navigation, app launch, or any key not covered by other tools.',
  {
    key: z.string().describe(
      'Samsung remote key code, e.g. KEY_ENTER, KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT, '
      + 'KEY_BACK, KEY_MENU, KEY_NETFLIX, KEY_EXIT, KEY_PLAY, KEY_PAUSE, KEY_STOP',
    ),
  },
  async (args) => {
    if (!SAMSUNG_TV_IP) return notConfigured();
    log(`Raw key: ${args.key}`);
    const result = await sendKey(args.key);
    return {
      content: [{ type: 'text' as const, text: result.message }],
      ...(result.ok ? {} : { isError: true as const }),
    };
  },
);

// ── Start ──────────────────────────────────────────────────────────────────────

if (!SAMSUNG_TV_IP) {
  log('Warning: SAMSUNG_TV_IP not set — tools will return configuration error');
}

const transport = new StdioServerTransport();
await server.connect(transport);
