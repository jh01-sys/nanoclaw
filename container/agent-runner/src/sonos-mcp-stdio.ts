/**
 * Sonos MCP Server for NanoClaw
 * Exposes node-sonos-http-api as tools for the container agent.
 *
 * Environment variables:
 *   SONOS_API_URL — Base URL for node-sonos-http-api (e.g. http://192.168.1.x:5005)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SONOS_API_URL = (process.env.SONOS_API_URL || '').replace(/\/$/, '');

function log(msg: string): void {
  console.error(`[SONOS] ${msg}`);
}

function notConfigured(): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text' as const, text: 'Sonos not configured. Set SONOS_API_URL in .env (e.g. http://192.168.1.x:5005)' }],
    isError: true,
  };
}

async function sonosGet(path: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = `${SONOS_API_URL}${path}`;
  log(`GET ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  let data: unknown;
  try { data = await res.json(); } catch { data = await res.text().catch(() => ''); }
  return { ok: res.ok, status: res.status, data };
}

interface SonosZone {
  coordinator?: { roomName?: string };
  members?: Array<{ roomName?: string; state?: { volume?: number; mute?: boolean; currentTrack?: { title?: string; artist?: string; album?: string; type?: string }; playbackState?: string } }>;
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'sonos', version: '1.0.0' });

// ── Tool: sonos_list_rooms ─────────────────────────────────────────────────────

server.tool(
  'sonos_list_rooms',
  'List all Sonos rooms/speakers with their current state (playing, volume, current track).',
  {},
  async () => {
    if (!SONOS_API_URL) return notConfigured();
    try {
      const result = await sonosGet('/zones');
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Sonos API error ${result.status}` }], isError: true };
      }
      const zones = result.data as SonosZone[];
      if (!zones || zones.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No Sonos zones found.' }] };
      }
      const lines: string[] = [];
      for (const zone of zones) {
        for (const member of (zone.members || [])) {
          const name = member.roomName || 'Unknown';
          const state = member.state;
          const volume = state?.volume ?? '?';
          const playing = state?.playbackState || 'STOPPED';
          const track = state?.currentTrack;
          const trackInfo = track?.title ? ` — "${track.title}"${track.artist ? ` by ${track.artist}` : ''}` : '';
          lines.push(`• ${name} [vol: ${volume}%, ${playing}]${trackInfo}`);
        }
      }
      return { content: [{ type: 'text' as const, text: `Sonos rooms:\n${lines.join('\n')}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed to connect to Sonos API: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Tool: sonos_playpause ──────────────────────────────────────────────────────

server.tool(
  'sonos_playpause',
  'Toggle play/pause for a Sonos room.',
  { room: z.string().describe('Room name exactly as shown in sonos_list_rooms (e.g. "Living Room")') },
  async (args) => {
    if (!SONOS_API_URL) return notConfigured();
    const room = encodeURIComponent(args.room);
    try {
      const result = await sonosGet(`/${room}/playpause`);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Sonos API error ${result.status}` }], isError: true };
      }
      log(`${args.room}: play/pause toggled`);
      return { content: [{ type: 'text' as const, text: `${args.room}: play/pause toggled` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Tool: sonos_play ──────────────────────────────────────────────────────────

server.tool(
  'sonos_play',
  'Start playback in a Sonos room.',
  { room: z.string().describe('Room name exactly as shown in sonos_list_rooms') },
  async (args) => {
    if (!SONOS_API_URL) return notConfigured();
    const room = encodeURIComponent(args.room);
    try {
      const result = await sonosGet(`/${room}/play`);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Sonos API error ${result.status}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `${args.room}: playback started` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Tool: sonos_pause ─────────────────────────────────────────────────────────

server.tool(
  'sonos_pause',
  'Pause playback in a Sonos room. If the room is playing TV audio (line-in/SPDIF), it will be muted instead — Sonos does not support pausing a line-in source.',
  { room: z.string().describe('Room name exactly as shown in sonos_list_rooms') },
  async (args) => {
    if (!SONOS_API_URL) return notConfigured();
    const room = encodeURIComponent(args.room);
    try {
      // Check if playing line-in (SPDIF/TV audio) — pause is not supported for line-in sources.
      const stateResult = await sonosGet(`/${room}/state`);
      if (stateResult.ok) {
        const state = stateResult.data as { currentTrack?: { type?: string } };
        if (state?.currentTrack?.type === 'line_in') {
          const muteResult = await sonosGet(`/${room}/mute`);
          if (!muteResult.ok) {
            return { content: [{ type: 'text' as const, text: `${args.room}: playing TV audio (line-in) — mute failed with status ${muteResult.status}` }], isError: true };
          }
          return { content: [{ type: 'text' as const, text: `${args.room}: playing TV audio (line-in) — muted instead of paused` }] };
        }
      }
      const result = await sonosGet(`/${room}/pause`);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Sonos API error ${result.status}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `${args.room}: paused` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Tool: sonos_volume ────────────────────────────────────────────────────────

server.tool(
  'sonos_volume',
  'Set volume for a Sonos room (0-100).',
  {
    room: z.string().describe('Room name exactly as shown in sonos_list_rooms'),
    volume: z.number().min(0).max(100).describe('Volume level 0-100'),
  },
  async (args) => {
    if (!SONOS_API_URL) return notConfigured();
    const room = encodeURIComponent(args.room);
    try {
      const result = await sonosGet(`/${room}/volume/${args.volume}`);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Sonos API error ${result.status}` }], isError: true };
      }
      log(`${args.room}: volume set to ${args.volume}%`);
      return { content: [{ type: 'text' as const, text: `${args.room}: volume set to ${args.volume}%` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Tool: sonos_next ──────────────────────────────────────────────────────────

server.tool(
  'sonos_next',
  'Skip to next track in a Sonos room.',
  { room: z.string().describe('Room name exactly as shown in sonos_list_rooms') },
  async (args) => {
    if (!SONOS_API_URL) return notConfigured();
    const room = encodeURIComponent(args.room);
    try {
      const result = await sonosGet(`/${room}/next`);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Sonos API error ${result.status}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `${args.room}: skipped to next track` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Tool: sonos_previous ──────────────────────────────────────────────────────

server.tool(
  'sonos_previous',
  'Go to previous track in a Sonos room.',
  { room: z.string().describe('Room name exactly as shown in sonos_list_rooms') },
  async (args) => {
    if (!SONOS_API_URL) return notConfigured();
    const room = encodeURIComponent(args.room);
    try {
      const result = await sonosGet(`/${room}/previous`);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Sonos API error ${result.status}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `${args.room}: went to previous track` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Start ──────────────────────────────────────────────────────────────────────

if (!SONOS_API_URL) {
  log('Warning: SONOS_API_URL not set — tools will return configuration error');
}

const transport = new StdioServerTransport();
await server.connect(transport);
