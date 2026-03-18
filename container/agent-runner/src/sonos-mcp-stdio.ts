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

// ── Tool: sonos_state ─────────────────────────────────────────────────────────

server.tool(
  'sonos_state',
  'Return full state of a Sonos room: track title, artist, album, playbackState, volume, source type (music/line_in).',
  { room: z.string().describe('Room name exactly as shown in sonos_list_rooms') },
  async (args) => {
    if (!SONOS_API_URL) return notConfigured();
    const room = encodeURIComponent(args.room);
    try {
      const result = await sonosGet(`/${room}/state`);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Sonos API error ${result.status}` }], isError: true };
      }
      const state = result.data as {
        currentTrack?: { title?: string; artist?: string; album?: string; type?: string };
        playbackState?: string;
        volume?: number;
        mute?: boolean;
        shuffle?: boolean;
        repeat?: string;
      };
      const track = state.currentTrack;
      const sourceType = track?.type === 'line_in' ? 'TV/line-in' : 'music queue';
      const lines = [
        `Room: ${args.room}`,
        `State: ${state.playbackState || 'STOPPED'}`,
        `Source: ${sourceType}`,
        `Volume: ${state.volume ?? '?'}%${state.mute ? ' (muted)' : ''}`,
        `Shuffle: ${state.shuffle ? 'on' : 'off'}`,
        `Repeat: ${state.repeat || 'off'}`,
      ];
      if (track?.title) lines.push(`Track: ${track.title}${track.artist ? ` — ${track.artist}` : ''}${track.album ? ` (${track.album})` : ''}`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Tool: sonos_favorites ──────────────────────────────────────────────────────

server.tool(
  'sonos_favorites',
  'List all saved Sonos favorites.',
  {},
  async () => {
    if (!SONOS_API_URL) return notConfigured();
    try {
      // node-sonos-http-api: GET /Olohuone/favorites (any room works for listing)
      // Try /favorites first, fall back to first zone
      const zonesResult = await sonosGet('/zones');
      let room = 'Olohuone';
      if (zonesResult.ok) {
        const zones = zonesResult.data as SonosZone[];
        const firstRoom = zones?.[0]?.coordinator?.roomName;
        if (firstRoom) room = firstRoom;
      }
      const result = await sonosGet(`/${encodeURIComponent(room)}/favorites`);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Sonos API error ${result.status}` }], isError: true };
      }
      const favs = result.data as Array<{ title?: string; uri?: string }>;
      if (!Array.isArray(favs) || favs.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No favorites found.' }] };
      }
      const lines = favs.map((f, i) => `${i + 1}. ${f.title || f.uri || 'Unknown'}`);
      return { content: [{ type: 'text' as const, text: `Sonos favorites:\n${lines.join('\n')}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Tool: sonos_play_favorite ──────────────────────────────────────────────────

server.tool(
  'sonos_play_favorite',
  'Play a saved Sonos favorite by name.',
  {
    room: z.string().describe('Room name exactly as shown in sonos_list_rooms'),
    name: z.string().describe('Favorite name exactly as returned by sonos_favorites'),
  },
  async (args) => {
    if (!SONOS_API_URL) return notConfigured();
    const room = encodeURIComponent(args.room);
    const favName = encodeURIComponent(args.name);
    try {
      const result = await sonosGet(`/${room}/favorite/${favName}`);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Sonos API error ${result.status}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `${args.room}: playing favorite "${args.name}"` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Tool: sonos_source ────────────────────────────────────────────────────────

server.tool(
  'sonos_source',
  'Switch audio source: "linein" or "tv" switches to TV/SPDIF line-in; "queue" resumes the Sonos music queue.',
  {
    room: z.string().describe('Room name exactly as shown in sonos_list_rooms'),
    source: z.enum(['linein', 'tv', 'queue']).describe('"linein"/"tv" = TV/SPDIF input, "queue" = resume Sonos queue'),
  },
  async (args) => {
    if (!SONOS_API_URL) return notConfigured();
    const room = encodeURIComponent(args.room);
    try {
      const path = args.source === 'queue' ? `/${room}/play` : `/${room}/linein`;
      const result = await sonosGet(path);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Sonos API error ${result.status}` }], isError: true };
      }
      const label = args.source === 'queue' ? 'music queue' : 'TV/line-in';
      return { content: [{ type: 'text' as const, text: `${args.room}: switched to ${label}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Tool: sonos_shuffle ───────────────────────────────────────────────────────

server.tool(
  'sonos_shuffle',
  'Toggle shuffle on or off for a Sonos room.',
  {
    room: z.string().describe('Room name exactly as shown in sonos_list_rooms'),
    on: z.boolean().describe('true to enable shuffle, false to disable'),
  },
  async (args) => {
    if (!SONOS_API_URL) return notConfigured();
    const room = encodeURIComponent(args.room);
    const state = args.on ? 'on' : 'off';
    try {
      const result = await sonosGet(`/${room}/shuffle/${state}`);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Sonos API error ${result.status}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `${args.room}: shuffle ${state}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Tool: sonos_repeat ────────────────────────────────────────────────────────

server.tool(
  'sonos_repeat',
  'Toggle repeat on or off for a Sonos room.',
  {
    room: z.string().describe('Room name exactly as shown in sonos_list_rooms'),
    on: z.boolean().describe('true to enable repeat, false to disable'),
  },
  async (args) => {
    if (!SONOS_API_URL) return notConfigured();
    const room = encodeURIComponent(args.room);
    const state = args.on ? 'on' : 'off';
    try {
      const result = await sonosGet(`/${room}/repeat/${state}`);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Sonos API error ${result.status}` }], isError: true };
      }
      return { content: [{ type: 'text' as const, text: `${args.room}: repeat ${state}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Tool: sonos_sleep ─────────────────────────────────────────────────────────

server.tool(
  'sonos_sleep',
  'Set a sleep timer for a Sonos room. Use 0 to cancel.',
  {
    room: z.string().describe('Room name exactly as shown in sonos_list_rooms'),
    seconds: z.number().min(0).describe('Sleep timer in seconds (0 to cancel)'),
  },
  async (args) => {
    if (!SONOS_API_URL) return notConfigured();
    const room = encodeURIComponent(args.room);
    try {
      const result = await sonosGet(`/${room}/sleep/${args.seconds}`);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Sonos API error ${result.status}` }], isError: true };
      }
      const label = args.seconds === 0 ? 'cancelled' : `set to ${args.seconds}s`;
      return { content: [{ type: 'text' as const, text: `${args.room}: sleep timer ${label}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  },
);

// ── Tool: sonos_group ─────────────────────────────────────────────────────────

server.tool(
  'sonos_group',
  'Group or ungroup Sonos rooms. action="leave" makes the room standalone; action="join" joins it to another room.',
  {
    room: z.string().describe('Room name exactly as shown in sonos_list_rooms'),
    action: z.enum(['leave', 'join']).describe('"leave" = make standalone, "join" = join another room'),
    target: z.string().optional().describe('Room to join (required for action="join")'),
  },
  async (args) => {
    if (!SONOS_API_URL) return notConfigured();
    const room = encodeURIComponent(args.room);
    try {
      let path: string;
      if (args.action === 'leave') {
        path = `/${room}/leave`;
      } else {
        if (!args.target) {
          return { content: [{ type: 'text' as const, text: 'target room is required for action="join"' }], isError: true };
        }
        path = `/${encodeURIComponent(args.target)}/add/${room}`;
      }
      const result = await sonosGet(path);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: `Sonos API error ${result.status}` }], isError: true };
      }
      const label = args.action === 'leave' ? 'left group (standalone)' : `joined ${args.target}`;
      return { content: [{ type: 'text' as const, text: `${args.room}: ${label}` }] };
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
