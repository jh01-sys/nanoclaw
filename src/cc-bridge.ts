/**
 * CC Bridge — polls data/ipc/cc-events/ for Claude Code tool use events
 * and forwards them to the configured Dev group via Telegram.
 *
 * 🟡 events: forwarded as observation messages (no user action needed)
 * 🔴 events: forwarded as confirmation requests (user must reply YES/NO)
 *
 * Confirmation flow:
 *   1. Hook writes  data/ipc/cc-events/{id}.json  (picked up here, forwarded)
 *   2. Hook writes  data/ipc/cc-confirm/{id}.request
 *   3. User replies YES/NO in Dev group
 *   4. handleCcConfirmationReply() writes  data/ipc/cc-confirm/{id}.response
 *   5. Hook polls for .response, reads decision, approves or blocks the tool use
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const CC_EVENTS_DIR = path.join(DATA_DIR, 'ipc', 'cc-events');
const CC_CONFIRM_DIR = path.join(DATA_DIR, 'ipc', 'cc-confirm');
const CC_INBOX_DIR = path.join(DATA_DIR, 'ipc', 'cc-inbox');
const POLL_INTERVAL_MS = 1000;

export interface CcBridgeDeps {
  /** Send a message to a Telegram JID */
  sendMessage: (jid: string, text: string) => Promise<void>;
  /** Returns the configured Dev group JID, or null if not configured */
  devGroupJid: () => string | null;
  /** Store a CC response in the DB so Annie sees it as context in her next session */
  storeCcMessage: (chatJid: string, text: string) => void;
  /** Trigger Annie to process the CC message (so she can acknowledge it) */
  triggerChat: (chatJid: string) => void;
}

interface CcEvent {
  type: string;
  id: string;
  ts: string;
  risk: 'yellow' | 'red';
  toolName: string;
  summary: string;
  requiresConfirmation: boolean;
}

let bridgeRunning = false;

export function startCcBridge(deps: CcBridgeDeps): void {
  if (bridgeRunning) return;
  bridgeRunning = true;

  fs.mkdirSync(CC_EVENTS_DIR, { recursive: true });
  fs.mkdirSync(CC_CONFIRM_DIR, { recursive: true });
  fs.mkdirSync(CC_INBOX_DIR, { recursive: true });

  const poll = async () => {
    // CC inbox delivery runs regardless of dev group config —
    // responses route to the chatJid embedded in the response file, not the dev group.
    await pollInboxResponses(deps);

    const devJid = deps.devGroupJid();
    if (!devJid) {
      setTimeout(poll, POLL_INTERVAL_MS);
      return;
    }

    let files: string[];
    try {
      files = fs
        .readdirSync(CC_EVENTS_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort(); // chronological order
    } catch {
      setTimeout(poll, POLL_INTERVAL_MS);
      return;
    }

    // Batch 🟡 events into a single message to avoid spam
    const yellowLines: string[] = [];

    for (const file of files) {
      const filePath = path.join(CC_EVENTS_DIR, file);
      let event: CcEvent;
      try {
        event = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
      } catch (err) {
        logger.warn({ file, err }, 'CC bridge: error reading event');
        try {
          fs.unlinkSync(filePath);
        } catch {}
        continue;
      }

      if (event.type !== 'cc_event') continue;

      if (!event.requiresConfirmation) {
        // Collect for batching
        const emoji = event.risk === 'red' ? '🔴' : '🟡';
        yellowLines.push(`${emoji} ${event.summary}`);
      } else {
        // 🔴 confirmation request — flush pending batch first, then send confirm
        if (yellowLines.length > 0) {
          await sendBatch(yellowLines, devJid, deps);
          yellowLines.length = 0;
        }
        await sendConfirmRequest(event, devJid, deps);
      }
    }

    // Flush remaining batch
    if (yellowLines.length > 0) {
      await sendBatch(yellowLines, devJid, deps);
    }

    setTimeout(poll, POLL_INTERVAL_MS);
  };

  poll();
  logger.info('CC bridge started');
}

async function sendBatch(
  lines: string[],
  devJid: string,
  deps: CcBridgeDeps,
): Promise<void> {
  const text = `⚙️ CC\n${lines.join('\n')}`;
  await deps
    .sendMessage(devJid, text)
    .catch((err) => logger.warn({ err }, 'CC bridge: failed to send batch'));
}

async function sendConfirmRequest(
  event: CcEvent,
  devJid: string,
  deps: CcBridgeDeps,
): Promise<void> {
  const text = [
    `⚙️ CC 🔴 *Confirmation required*`,
    ``,
    `\`${event.summary}\``,
    ``,
    `Reply *YES* to allow or *NO* to cancel`,
    `_(5 min timeout — no reply = blocked)_`,
  ].join('\n');

  await deps
    .sendMessage(devJid, text)
    .catch((err) =>
      logger.warn({ err }, 'CC bridge: failed to send confirmation request'),
    );
}

interface CcInboxResponse {
  id: string;
  chatJid: string;
  result: string;
}

/**
 * Poll data/ipc/cc-inbox/ for .response files written by Claude Code.
 * For each response, forward the result to the bot's chat and clean up.
 */
async function pollInboxResponses(deps: CcBridgeDeps): Promise<void> {
  let files: string[];
  try {
    files = fs
      .readdirSync(CC_INBOX_DIR)
      .filter((f) => f.endsWith('.response'))
      .sort();
  } catch {
    return;
  }

  for (const file of files) {
    const filePath = path.join(CC_INBOX_DIR, file);
    let response: CcInboxResponse;
    try {
      response = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.unlinkSync(filePath);
    } catch (err) {
      logger.warn({ file, err }, 'CC inbox: error reading response');
      try {
        fs.unlinkSync(filePath);
      } catch {}
      continue;
    }

    // Clean up the corresponding .task file
    const taskFile = path.join(
      CC_INBOX_DIR,
      file.replace('.response', '.task'),
    );
    try {
      fs.unlinkSync(taskFile);
    } catch {}

    if (!response.chatJid || !response.result) {
      logger.warn({ file }, 'CC inbox: malformed response, skipping');
      continue;
    }

    // Strip prefix if the subprocess already added it (avoids "⚙️ *CC:* ⚙️ *CC:*")
    const cleaned = response.result.replace(/^(⚙️\s*\*CC:\*\s*)+/u, '').trim();
    const text = `⚙️ *CC:* ${cleaned}`;
    await deps
      .sendMessage(response.chatJid, text)
      .catch((err) =>
        logger.warn(
          { err, chatJid: response.chatJid },
          'CC inbox: failed to deliver response',
        ),
      );
    // Store in DB so Annie sees CC's reply as context in her next session
    deps.storeCcMessage(response.chatJid, text);
    // Trigger Annie so she sees and can acknowledge this CC message immediately
    deps.triggerChat(response.chatJid);
    logger.info(
      { id: response.id, chatJid: response.chatJid },
      'CC inbox: response delivered',
    );
  }
}

/**
 * Auto-create a CC task from a direct chat message (e.g. "CC, can you...").
 * Called when Annie's output starts with "CC," or "CC:", or when Jake sends
 * a message starting with "CC:" / "CC, " directly in the main chat.
 *
 * @param text - The full message text
 * @param chatJid - The chat JID to reply to
 * @param msgId - Optional stable message ID for idempotent task creation
 * @param source - 'jake' for direct messages from Jake, 'annie' for delegated tasks
 */
export function createCcTaskFromMessage(
  text: string,
  chatJid: string,
  msgId?: string,
  source: 'jake' | 'annie' = 'annie',
): string {
  fs.mkdirSync(CC_INBOX_DIR, { recursive: true });

  const id = msgId
    ? `direct-${msgId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    : `direct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const finalPath = path.join(CC_INBOX_DIR, `${id}.task`);

  // Idempotent: skip if task already exists (prevents duplicates on cursor retry)
  if (msgId && fs.existsSync(finalPath)) {
    logger.debug({ id }, 'CC bridge: task already exists, skipping');
    return id;
  }

  const lines = text.trim().split('\n');
  // Strip the "CC, " / "CC: " prefix from the first line to use as title
  const title = lines[0].replace(/^cc[,:\s]+/i, '').trim() || 'Direct message';
  const body =
    lines.length > 1 ? lines.slice(1).join('\n').trim() : text.trim();

  const task = {
    id,
    ts: new Date().toISOString(),
    chatJid,
    title,
    body: body || text.trim(),
    source,
  };

  const tempPath = path.join(CC_INBOX_DIR, `${id}.task.tmp`);
  fs.writeFileSync(tempPath, JSON.stringify(task, null, 2));
  fs.renameSync(tempPath, finalPath);

  logger.info(
    { id, title, chatJid, source },
    'CC bridge: auto-created task from direct message',
  );
  return id;
}

/**
 * Handle a YES/NO/CANCEL reply from the Dev group.
 * Writes the confirmation response file that the hook is polling for.
 * Returns true if the message was consumed as a CC confirmation.
 */
export function handleCcConfirmationReply(
  content: string,
  sendAck: (text: string) => void,
): boolean {
  const trimmed = content.trim().toUpperCase();
  if (trimmed !== 'YES' && trimmed !== 'NO' && trimmed !== 'CANCEL')
    return false;

  let requestFiles: string[];
  try {
    requestFiles = fs
      .readdirSync(CC_CONFIRM_DIR)
      .filter((f) => f.endsWith('.request'));
  } catch {
    return false;
  }

  if (requestFiles.length === 0) return false;

  // Pick the oldest pending request (FIFO)
  const oldestRequest = requestFiles.sort()[0];
  const confirmId = oldestRequest.replace('.request', '');
  const confirmed = trimmed === 'YES';

  const responsePath = path.join(CC_CONFIRM_DIR, `${confirmId}.response`);
  try {
    fs.writeFileSync(responsePath, JSON.stringify({ confirmed }));
    logger.info(
      { confirmId, confirmed },
      `CC confirmation ${confirmed ? 'approved' : 'denied'}`,
    );
    sendAck(
      confirmed
        ? '✅ Approved — operation will proceed.'
        : '🚫 Blocked — operation cancelled.',
    );
    return true;
  } catch (err) {
    logger.warn(
      { confirmId, err },
      'CC bridge: failed to write confirm response',
    );
    return false;
  }
}
