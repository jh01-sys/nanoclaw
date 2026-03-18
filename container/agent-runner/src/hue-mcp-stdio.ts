/**
 * Philips Hue MCP Server for NanoClaw
 * Exposes Hue Bridge local REST API v2 as tools for the container agent.
 * Uses HTTPS with self-signed cert (rejectUnauthorized disabled — local network only).
 *
 * Environment variables:
 *   HUE_BRIDGE_IP  — IP address of the Hue Bridge (e.g. 192.168.1.100)
 *   HUE_API_KEY    — Application key from the Hue Bridge (hue-application-key header)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import https from 'node:https';

const HUE_BRIDGE_IP = process.env.HUE_BRIDGE_IP || '';
const HUE_API_KEY = process.env.HUE_API_KEY || '';
const BASE_URL = HUE_BRIDGE_IP ? `https://${HUE_BRIDGE_IP}/clip/v2` : '';

// Self-signed cert agent for local Hue Bridge — never used outside local network
const tlsAgent = new https.Agent({ rejectUnauthorized: false });

function log(msg: string): void {
  console.error(`[HUE] ${msg}`);
}

function notConfigured(): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text' as const, text: 'Hue not configured. Set HUE_BRIDGE_IP and HUE_API_KEY in .env' }],
    isError: true,
  };
}

async function hueFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const url = `${BASE_URL}${endpoint}`;
  return fetch(url, {
    ...options,
    // @ts-expect-error — Node.js fetch accepts agent via dispatcher field in undici
    dispatcher: undefined,
    headers: {
      'hue-application-key': HUE_API_KEY,
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    },
  });
}

// Use https.request for actual calls since native fetch doesn't support custom TLS agents
async function hueRequest(
  method: string,
  endpoint: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      hostname: HUE_BRIDGE_IP,
      path: `/clip/v2${endpoint}`,
      method,
      headers: {
        'hue-application-key': HUE_API_KEY,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
      agent: tlsAgent,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0, data: JSON.parse(data) });
        } catch {
          resolve({ ok: (res.statusCode ?? 0) < 300, status: res.statusCode ?? 0, data });
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface HueLight {
  id: string;
  metadata?: { name?: string };
  on?: { on: boolean };
  dimming?: { brightness: number };
  color_temperature?: { mirek: number; mirek_valid: boolean };
}

interface HueRoom {
  id: string;
  metadata?: { name?: string };
  children?: Array<{ rid: string; rtype: string }>;
  services?: Array<{ rid: string; rtype: string }>;
}

interface HueGroupedLight {
  id: string;
  owner?: { rid: string; rtype: string };
  on?: { on: boolean };
  dimming?: { brightness: number };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Convert "warm" / "cool" / "neutral" to Hue mirek value */
function colorTempToMirek(temp: string): number {
  switch (temp.toLowerCase()) {
    case 'warm': return 500;
    case 'neutral': return 370;
    case 'cool': return 250;
    default: return 370;
  }
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: 'hue', version: '1.0.0' });

// ── Tool: hue_list_lights ─────────────────────────────────────────────────────

server.tool(
  'hue_list_lights',
  'List all Philips Hue lights with their current state (on/off, brightness, name).',
  {},
  async () => {
    if (!HUE_BRIDGE_IP || !HUE_API_KEY) return notConfigured();
    log('Listing lights...');
    try {
      const result = await hueRequest('GET', '/resource/light');
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Hue API error ${result.status}` }],
          isError: true,
        };
      }
      const lights = ((result.data as { data?: HueLight[] }).data || []) as HueLight[];
      if (lights.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No lights found.' }] };
      }
      const lines = lights.map(l => {
        const name = l.metadata?.name || l.id;
        const on = l.on?.on ? 'on' : 'off';
        const brightness = l.dimming ? ` ${Math.round(l.dimming.brightness)}%` : '';
        return `• ${name} — ${on}${brightness} [id: ${l.id}]`;
      });
      log(`Found ${lights.length} lights`);
      return { content: [{ type: 'text' as const, text: `Lights (${lights.length}):\n${lines.join('\n')}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to connect to Hue Bridge: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Tool: hue_list_rooms ──────────────────────────────────────────────────────

server.tool(
  'hue_list_rooms',
  'List all Philips Hue rooms/zones with their grouped light IDs (needed for hue_control_room).',
  {},
  async () => {
    if (!HUE_BRIDGE_IP || !HUE_API_KEY) return notConfigured();
    log('Listing rooms...');
    try {
      const [roomsResult, groupedResult] = await Promise.all([
        hueRequest('GET', '/resource/room'),
        hueRequest('GET', '/resource/grouped_light'),
      ]);

      const rooms = ((roomsResult.data as { data?: HueRoom[] }).data || []) as HueRoom[];
      const groupedLights = ((groupedResult.data as { data?: HueGroupedLight[] }).data || []) as HueGroupedLight[];

      if (rooms.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No rooms found.' }] };
      }

      const lines = rooms.map(room => {
        const name = room.metadata?.name || room.id;
        const groupedId = room.services?.find(s => s.rtype === 'grouped_light')?.rid;
        const grouped = groupedLights.find(g => g.id === groupedId);
        const on = grouped?.on?.on ? 'on' : 'off';
        const brightness = grouped?.dimming ? ` ${Math.round(grouped.dimming.brightness)}%` : '';
        return `• ${name} — ${on}${brightness} [grouped_light_id: ${groupedId || 'unknown'}]`;
      });

      log(`Found ${rooms.length} rooms`);
      return { content: [{ type: 'text' as const, text: `Rooms (${rooms.length}):\n${lines.join('\n')}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to connect to Hue Bridge: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Tool: hue_control_light ───────────────────────────────────────────────────

server.tool(
  'hue_control_light',
  'Control an individual Philips Hue light by ID. Can turn on/off, set brightness (0-100), and set color temperature.',
  {
    light_id: z.string().describe('The light ID from hue_list_lights'),
    on: z.boolean().optional().describe('Turn light on (true) or off (false)'),
    brightness: z.number().min(0).max(100).optional().describe('Brightness level 0-100'),
    color_temp: z.enum(['warm', 'neutral', 'cool']).optional().describe('Color temperature: warm (cozy), neutral (white), cool (daylight)'),
  },
  async (args) => {
    if (!HUE_BRIDGE_IP || !HUE_API_KEY) return notConfigured();
    log(`Controlling light ${args.light_id}...`);

    const body: Record<string, unknown> = {};
    if (args.on !== undefined) body.on = { on: args.on };
    if (args.brightness !== undefined) body.dimming = { brightness: args.brightness };
    if (args.color_temp) body.color_temperature = { mirek: colorTempToMirek(args.color_temp) };

    if (Object.keys(body).length === 0) {
      return { content: [{ type: 'text' as const, text: 'No changes specified.' }] };
    }

    try {
      const result = await hueRequest('PUT', `/resource/light/${args.light_id}`, body);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Hue API error ${result.status}` }],
          isError: true,
        };
      }
      const parts: string[] = [];
      if (args.on !== undefined) parts.push(args.on ? 'turned on' : 'turned off');
      if (args.brightness !== undefined) parts.push(`brightness set to ${args.brightness}%`);
      if (args.color_temp) parts.push(`color temperature set to ${args.color_temp}`);
      log(`Light ${args.light_id}: ${parts.join(', ')}`);
      return { content: [{ type: 'text' as const, text: `Light ${args.light_id}: ${parts.join(', ')}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to control light: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Tool: hue_control_room ────────────────────────────────────────────────────

server.tool(
  'hue_control_room',
  'Control all lights in a Philips Hue room/zone by grouped_light_id. Use hue_list_rooms to find the grouped_light_id. Can turn on/off, set brightness, and color temperature for the entire room.',
  {
    grouped_light_id: z.string().describe('The grouped_light_id from hue_list_rooms'),
    room_name: z.string().optional().describe('Room name for display purposes only'),
    on: z.boolean().optional().describe('Turn room lights on (true) or off (false)'),
    brightness: z.number().min(0).max(100).optional().describe('Brightness level 0-100'),
    color_temp: z.enum(['warm', 'neutral', 'cool']).optional().describe('Color temperature: warm (cozy), neutral (white), cool (daylight)'),
  },
  async (args) => {
    if (!HUE_BRIDGE_IP || !HUE_API_KEY) return notConfigured();
    const displayName = args.room_name || args.grouped_light_id;
    log(`Controlling room ${displayName}...`);

    const body: Record<string, unknown> = {};
    if (args.on !== undefined) body.on = { on: args.on };
    if (args.brightness !== undefined) body.dimming = { brightness: args.brightness };
    if (args.color_temp) body.color_temperature = { mirek: colorTempToMirek(args.color_temp) };

    if (Object.keys(body).length === 0) {
      return { content: [{ type: 'text' as const, text: 'No changes specified.' }] };
    }

    try {
      const result = await hueRequest('PUT', `/resource/grouped_light/${args.grouped_light_id}`, body);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Hue API error ${result.status}` }],
          isError: true,
        };
      }
      const parts: string[] = [];
      if (args.on !== undefined) parts.push(args.on ? 'turned on' : 'turned off');
      if (args.brightness !== undefined) parts.push(`brightness set to ${args.brightness}%`);
      if (args.color_temp) parts.push(`color temperature set to ${args.color_temp}`);
      log(`Room ${displayName}: ${parts.join(', ')}`);
      return { content: [{ type: 'text' as const, text: `${displayName}: ${parts.join(', ')}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Failed to control room: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Start ──────────────────────────────────────────────────────────────────────

if (!HUE_BRIDGE_IP || !HUE_API_KEY) {
  log('Warning: HUE_BRIDGE_IP or HUE_API_KEY not set — tools will return configuration error');
}

const transport = new StdioServerTransport();
await server.connect(transport);
