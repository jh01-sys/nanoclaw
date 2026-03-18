import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  IDLE_TIMEOUT,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
} from './config.js';
import { startCredentialProxy } from './credential-proxy.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  PROXY_BIND_HOST,
} from './container-runtime.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getNewMessages,
  getRegisteredGroup,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import {
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
} from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import {
  startCcBridge,
  handleCcConfirmationReply,
  handleCcConfirmationCallback,
  createCcTaskFromMessage,
} from './cc-bridge.js';
import { startCcWorker } from './cc-worker.js';
import { readEnvFile } from './env.js';
import { isDevCommand, handleDevCommand } from './dev-commands.js';
import { initHueScheduler, initHueScheduleRunner } from './hue-scheduler.js';
import { resolveModel } from './model-router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

/**
 * Check if a message is a reply to a pending 🔴 confirmation request.
 * Scans the group's IPC confirm directory for pending .request files.
 * If found and the message is YES/NO, writes the .response file.
 * Returns true if the message was consumed as a confirmation reply.
 */
function handleConfirmationReply(chatJid: string, content: string): boolean {
  const group = registeredGroups[chatJid];
  if (!group) return false;

  const confirmDir = path.join(resolveGroupIpcPath(group.folder), 'confirm');
  if (!fs.existsSync(confirmDir)) return false;

  // Find pending confirmation requests
  let requestFiles: string[];
  try {
    requestFiles = fs
      .readdirSync(confirmDir)
      .filter((f) => f.endsWith('.request'));
  } catch {
    return false;
  }

  if (requestFiles.length === 0) return false;

  // Use the most recent pending request
  const latestRequest = requestFiles.sort().pop()!;
  const confirmId = latestRequest.replace('.request', '');
  const trimmed = content.trim().toUpperCase();
  const confirmed = trimmed === 'YES';

  // Only consume if it's a clear YES or NO/cancel
  if (trimmed !== 'YES' && trimmed !== 'NO' && trimmed !== 'CANCEL')
    return false;

  const responsePath = path.join(confirmDir, `${confirmId}.response`);
  fs.writeFileSync(responsePath, JSON.stringify({ confirmed }));
  logger.info(
    { confirmId, confirmed, chatJid },
    `Risk confirmation ${confirmed ? 'approved' : 'denied'}`,
  );
  return true;
}

const ANNIE_ACTIVITY_FILE = path.join(DATA_DIR, 'ipc', 'cc-inbox', 'annie-activity.json');

function writeAnnieActivity(active: boolean, task?: string): void {
  try {
    fs.writeFileSync(
      ANNIE_ACTIVITY_FILE,
      JSON.stringify({ active, task: task ?? '', startedAt: active ? new Date().toISOString() : null }),
    );
  } catch {}
}

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

/** Matches messages Jake directs to CC: "CC: ..." or "CC, ..." */
const CC_DIRECTED_RE = /^cc[,:\s]/i;
function isCcDirected(msg: NewMessage): boolean {
  return (
    !msg.is_from_me &&
    !msg.is_bot_message &&
    CC_DIRECTED_RE.test(msg.content.trim())
  );
}

const channels: Channel[] = [];
const queue = new GroupQueue();

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }

  const isMainGroup = group.isMain === true;

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(
    chatJid,
    sinceTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        TRIGGER_PATTERN.test(m.content.trim()) &&
        (m.is_from_me || isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // For main groups, intercept CC-directed messages and route to CC instead of Annie
  let messagesToProcess = missedMessages;
  if (isMainGroup) {
    const ccMessages = missedMessages.filter(isCcDirected);
    const regularMessages = missedMessages.filter((m) => !isCcDirected(m));
    for (const m of ccMessages) {
      createCcTaskFromMessage(m.content, chatJid, m.id, 'jake');
    }
    if (regularMessages.length === 0) {
      // Only CC-directed messages — advance cursor and return without invoking Annie
      lastAgentTimestamp[chatJid] =
        missedMessages[missedMessages.length - 1].timestamp;
      saveState();
      return true;
    }
    messagesToProcess = regularMessages;
  }

  const basePrompt = formatMessages(messagesToProcess, TIMEZONE);

  // Inject mandatory CC communication rules into every prompt — code-enforced,
  // not relying on CLAUDE.md rule-following alone.
  const hasCcMessage = missedMessages.some((m) => m.sender === 'CC');
  const ccReminder = hasCcMessage
    ? `[SYSTEM REMINDER: A message from CC is in this context.\n` +
      `(1) Your FIRST action MUST be mcp__nanoclaw__send_message with a brief acknowledgement like "On it." — before ANY other tool call.\n` +
      `(2) To reach CC: call cc_send_task. Writing "CC, ..." or "CC should ..." in your reply goes nowhere — CC cannot read the chat.]\n\n`
    : `[REMINDER: To send any work to CC, you MUST call cc_send_task. ` +
      `Writing "CC should ..." or "CC, ..." in your reply is silently lost — CC never sees it.]\n\n`;
  const prompt = ccReminder + basePrompt;

  // Advance cursor past ALL messages (incl. CC-directed ones).
  // Save old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  // Start typing indicator and keep it alive every 4s (Telegram expires after ~5s)
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  if (channel.setTyping) {
    logger.info({ chatJid }, '[typing] sending typing indicator to');
    channel.setTyping(chatJid, true).catch((err) => logger.warn({ chatJid, err }, '[typing] setTyping initial call failed'));
    typingInterval = setInterval(() => {
      logger.debug({ chatJid }, '[typing] refreshing typing indicator');
      channel.setTyping!(chatJid, true).catch((err) => logger.warn({ chatJid, err }, '[typing] setTyping interval call failed'));
    }, 4000);
  } else {
    logger.warn({ chatJid }, '[typing] channel has no setTyping method');
  }

  // Write Annie activity for dashboard visibility
  const truncate = (text: string, max: number) => {
    const t = text.trim().replace(/\n+/g, ' ');
    return t.length > max ? t.slice(0, max) + '…' : t;
  };
  let taskDesc: string;
  if (hasCcMessage) {
    const ccMsg = missedMessages.find((m) => m.sender === 'CC');
    taskDesc = 'Reviewing CC: ' + truncate(ccMsg?.content ?? '', 60);
  } else {
    const lastUserMsg = messagesToProcess[messagesToProcess.length - 1];
    taskDesc = 'Replying to: ' + truncate(lastUserMsg?.content ?? '', 80);
  }
  writeAnnieActivity(true, taskDesc);

  let hadError = false;
  let outputSentToUser = false;
  let hadSuccess = false; // true if any result with status=success was received

  let output = '';
  try {
    output = await runAgent(group, prompt, chatJid, async (result) => {
      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = formatOutbound(raw);
        logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);

        if (text) {
          const outbound = `🤖 *${ASSISTANT_NAME}:* ${text}`;
          await channel.sendMessage(chatJid, outbound);
          storeMessageDirect({
            id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            chat_jid: chatJid,
            sender: ASSISTANT_NAME,
            sender_name: ASSISTANT_NAME,
            content: outbound,
            timestamp: new Date().toISOString(),
            is_from_me: true,
            is_bot_message: true,
          });
          outputSentToUser = true;
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
        hadSuccess = true;
      }

      if (result.status === 'error') {
        hadError = true;
      }
    });
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    channel.setTyping?.(chatJid, false).catch(() => {});
    writeAnnieActivity(false);
    if (idleTimer) clearTimeout(idleTimer);
  }

  if (output === 'error' || hadError) {
    // If we already sent output to the user, or the agent completed successfully
    // (even with result: null), don't roll back the cursor — the messages were
    // processed and rolling back would cause duplicate processing.
    if (outputSentToUser || hadSuccess) {
      logger.warn(
        { group: group.name, outputSentToUser, hadSuccess },
        'Agent error after successful processing, skipping cursor rollback to prevent duplicates',
      );
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn(
      { group: group.name },
      'Agent error, rolled back message cursor for retry',
    );
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`NanoClaw running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                TRIGGER_PATTERN.test(m.content.trim()) &&
                (m.is_from_me ||
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const pendingMessages =
            allPending.length > 0 ? allPending : groupMessages;

          // For main groups, intercept CC-directed messages and route to CC instead of Annie
          let messagesToSend = pendingMessages;
          if (isMainGroup) {
            const ccMessages = pendingMessages.filter(isCcDirected);
            const regularMessages = pendingMessages.filter(
              (m) => !isCcDirected(m),
            );
            for (const m of ccMessages) {
              createCcTaskFromMessage(m.content, chatJid, m.id, 'jake');
            }
            if (regularMessages.length === 0 && ccMessages.length > 0) {
              // All messages were CC-directed — advance cursor and skip Annie
              lastAgentTimestamp[chatJid] =
                pendingMessages[pendingMessages.length - 1].timestamp;
              saveState();
              continue;
            }
            if (regularMessages.length < pendingMessages.length) {
              messagesToSend = regularMessages;
            }
          }

          const formatted = formatMessages(messagesToSend, TIMEZONE);

          // Classify model for the follow-up message
          const userContent = messagesToSend.map((m) => m.content).join(' ');
          const followUpModel = resolveModel(userContent);
          if (queue.sendMessage(chatJid, formatted, followUpModel)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            // Advance cursor past ALL pending messages (including CC-directed ones)
            lastAgentTimestamp[chatJid] =
              pendingMessages[pendingMessages.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  restoreRemoteControl();

  // Start credential proxy (containers route API calls through this)
  const proxyServer = await startCredentialProxy(
    CREDENTIAL_PROXY_PORT,
    PROXY_BIND_HOST,
  );

  // Reset Annie activity on startup (clears any stale active=true from previous run)
  writeAnnieActivity(false);

  // Safety watchdog: if annie-activity.json stays active for >3 min, auto-reset
  setInterval(() => {
    try {
      const raw = fs.readFileSync(ANNIE_ACTIVITY_FILE, 'utf8');
      const data = JSON.parse(raw) as { active: boolean; startedAt: string | null };
      if (data.active && data.startedAt) {
        const age = Date.now() - new Date(data.startedAt).getTime();
        if (age > 3 * 60 * 1000) {
          logger.warn({ ageMs: age }, 'Annie activity watchdog: resetting stale active=true');
          writeAnnieActivity(false);
        }
      }
    } catch {}
  }, 30_000);

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    writeAnnieActivity(false);
    proxyServer.close();
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Handle /remote-control and /remote-control-end commands
  async function handleRemoteControl(
    command: string,
    chatJid: string,
    msg: NewMessage,
  ): Promise<void> {
    const group = registeredGroups[chatJid];
    if (!group?.isMain) {
      logger.warn(
        { chatJid, sender: msg.sender },
        'Remote control rejected: not main group',
      );
      return;
    }

    const channel = findChannel(channels, chatJid);
    if (!channel) return;

    if (command === '/remote-control') {
      const result = await startRemoteControl(
        msg.sender,
        chatJid,
        process.cwd(),
      );
      if (result.ok) {
        await channel.sendMessage(chatJid, result.url);
      } else {
        await channel.sendMessage(
          chatJid,
          `Remote Control failed: ${result.error}`,
        );
      }
    } else {
      const result = stopRemoteControl();
      if (result.ok) {
        await channel.sendMessage(chatJid, 'Remote Control session ended.');
      } else {
        await channel.sendMessage(chatJid, result.error);
      }
    }
  }

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      // Remote control commands — intercept before storage
      const trimmed = msg.content.trim();
      if (trimmed === '/remote-control' || trimmed === '/remote-control-end') {
        handleRemoteControl(trimmed, chatJid, msg).catch((err) =>
          logger.error({ err, chatJid }, 'Remote control command error'),
        );
        return;
      }

      // Dev commands — intercept before agent, main group + allowed senders only
      if (isDevCommand(trimmed) && registeredGroups[chatJid]?.isMain) {
        const cfg = loadSenderAllowlist();
        if (msg.is_from_me || isSenderAllowed(chatJid, msg.sender, cfg)) {
          const channel = findChannel(channels, chatJid);
          if (channel) {
            handleDevCommand(trimmed)
              .then((reply) => channel.sendMessage(chatJid, `⚙️ ${reply}`))
              .catch((err) =>
                logger.error({ err, chatJid }, 'Dev command error'),
              );
          }
          return;
        }
      }

      // Check if this is a CC bridge confirmation reply (from Dev group)
      const devGroupJid = readEnvFile(['CC_BRIDGE_JID']).CC_BRIDGE_JID;
      if (devGroupJid && chatJid === devGroupJid) {
        const channel = findChannel(channels, chatJid);
        if (
          handleCcConfirmationReply(msg.content, (text) => {
            channel?.sendMessage(chatJid, text).catch(() => {});
          })
        ) {
          return; // Consumed as CC confirmation, don't process further
        }
      }

      // Check if this is a reply to a pending 🔴 confirmation request
      if (handleConfirmationReply(chatJid, msg.content)) {
        return; // Consumed as confirmation reply, don't store or process further
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    onCallbackQuery: (chatJid: string, data: string, answer: (text?: string) => Promise<void>) => {
      // Parse confirm_yes_<id> / confirm_no_<id> button payloads
      const match = data.match(/^confirm_(yes|no)_(.+)$/);
      if (!match) {
        answer().catch(() => {});
        return;
      }
      const approved = match[1] === 'yes';
      const confirmId = match[2];

      // Try CC confirmation first (data/ipc/cc-confirm/)
      if (handleCcConfirmationCallback(confirmId, approved)) {
        answer(approved ? '✅ Approved' : '🚫 Blocked').catch(() => {});
        return;
      }

      // Try Annie confirmation (group ipc/confirm/ dir)
      const group = registeredGroups[chatJid];
      if (group) {
        const confirmDir = path.join(resolveGroupIpcPath(group.folder), 'confirm');
        const requestPath = path.join(confirmDir, `${confirmId}.request`);
        if (fs.existsSync(requestPath)) {
          const responsePath = path.join(confirmDir, `${confirmId}.response`);
          fs.writeFileSync(responsePath, JSON.stringify({ confirmed: approved }));
          logger.info({ confirmId, approved, chatJid }, `Annie confirmation ${approved ? 'approved' : 'denied'} via button`);
          answer(approved ? '✅ Approved' : '🚫 Blocked').catch(() => {});
          return;
        }
      }

      answer('No pending confirmation found').catch(() => {});
    },
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // Start CC bridge (forwards Claude Code tool events to Dev group via Telegram)
  startCcBridge({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'CC bridge: no channel for Dev group JID');
        return;
      }
      await channel.sendMessage(jid, text);
    },
    sendMessageWithButtons: async (jid, text, buttons) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'CC bridge: no channel for Dev group JID');
        return;
      }
      if (channel.sendMessageWithButtons) {
        await channel.sendMessageWithButtons(jid, text, buttons);
      } else {
        await channel.sendMessage(jid, text);
      }
    },
    devGroupJid: () => readEnvFile(['CC_BRIDGE_JID']).CC_BRIDGE_JID || null,
    storeCcMessage: (chatJid, text) => {
      storeMessageDirect({
        id: `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: chatJid,
        sender: 'CC',
        sender_name: 'CC',
        content: text,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
      });
    },
    triggerChat: (chatJid) => queue.enqueueMessageCheck(chatJid),
  });

  // Start CC worker — auto-spawns Claude sessions when Annie sends tasks
  startCcWorker({
    devGroupJid: () => readEnvFile(['CC_BRIDGE_JID']).CC_BRIDGE_JID || null,
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      await channel?.sendMessage(jid, text);
    },
    storeCcMessage: (chatJid, text) => {
      storeMessageDirect({
        id: `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        chat_jid: chatJid,
        sender: 'CC',
        sender_name: 'CC',
        content: text,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
      });
    },
    sendReaction: async (jid, messageId, emoji) => {
      const channel = findChannel(channels, jid);
      if (channel && 'sendReaction' in channel) {
        await (channel as any).sendReaction(jid, messageId, emoji);
      }
    },
    setTyping: async (jid, isTyping) => {
      const channel = findChannel(channels, jid);
      await channel?.setTyping?.(jid, isTyping);
    },
  });

  // Start subsystems (independently of connection handler)
  initHueScheduler();
  initHueScheduleRunner();
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return;
      }
      const text = formatOutbound(rawText);
      if (text)
        await channel.sendMessage(jid, `🤖 *${ASSISTANT_NAME}:* ${text}`);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      return channel.sendMessage(jid, text);
    },
    sendMessageWithButtons: (jid, text, buttons) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      if (channel.sendMessageWithButtons) {
        return channel.sendMessageWithButtons(jid, text, buttons);
      }
      return channel.sendMessage(jid, text);
    },
    sendReaction: async (jid, messageId, emoji) => {
      const channel = findChannel(channels, jid);
      if (channel && 'sendReaction' in channel) {
        await (channel as any).sendReaction(jid, messageId, emoji);
      }
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Startup notification — lets the user know the service is back after a restart
  const mainEntry = Object.entries(registeredGroups).find(([, g]) => g.isMain);
  if (mainEntry) {
    const [mainJid] = mainEntry;
    const mainChannel = findChannel(channels, mainJid);
    mainChannel
      ?.sendMessage(mainJid, `⚙️ *NanoClaw:* ✅ Back online`)
      .catch((err) =>
        logger.warn({ err }, 'Failed to send startup notification'),
      );
  }

  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
