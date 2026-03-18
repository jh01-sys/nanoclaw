import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    // Include id only for numeric Telegram message_ids (user messages).
    // Bot message ids like "bot-..." are omitted to avoid confusion.
    const idAttr = /^\d+$/.test(m.id) ? ` id="${m.id}"` : '';
    return `<message${idAttr} sender="${escapeXml(m.sender_name)}" time="${escapeXml(displayTime)}">${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  let text = stripInternalTags(rawText);
  if (!text) return '';
  // Strip the SDK's hardcoded model signature line (e.g. "🤖 Claude Sonnet 4.6 (Anthropic)")
  // Our own model tag from modelUsage (e.g. "🤖 claude-haiku-4-5") is kept.
  text = text.replace(/\n?🤖 Claude [^\n]+\(Anthropic\)\s*/g, '');
  return text.trim();
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
