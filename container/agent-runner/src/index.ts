/**
 * NanoClaw Agent Runner
 * Runs inside a container, receives config via stdin, outputs result to stdout
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF, like before)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Files: {type:"message", text:"..."}.json — polled and consumed
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 *   Multiple results may be emitted (one per agent teams result).
 *   Final marker after loop ends signals completion.
 */

import fs from 'fs';
import path from 'path';
import { query, HookCallback, PreCompactHookInput } from '@anthropic-ai/claude-agent-sdk';
import { fileURLToPath } from 'url';
import { classifyRisk, RiskLevel } from './risk-classifier.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

const IPC_INPUT_DIR = '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;
const RED_CONFIRM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const IPC_CONFIRM_DIR = '/workspace/ipc/confirm';

/**
 * Push-based async iterable for streaming user messages to the SDK.
 * Keeps the iterable alive until end() is called, preventing isSingleUserTurn.
 */
class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>(r => { this.waiting = r; });
      this.waiting = null;
    }
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function getSessionSummary(sessionId: string, transcriptPath: string): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    const entry = index.entries.find(e => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

/**
 * Archive the full transcript to conversations/ before compaction.
 */
function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary, assistantName);
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {};
  };
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
    }
  }

  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null, assistantName?: string): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * PreToolUse hook: classifies risk and gates dangerous operations.
 * - Green: allow silently
 * - Yellow: allow, log with explanation
 * - Red: block, request user confirmation via IPC, 5-min timeout
 */
// Dev group JID for forwarding 🟡 risk events (set by container-runner via env var)
const ANNIE_DEV_GROUP_JID = process.env.NANOCLAW_CC_BRIDGE_JID || '';

// Batch accumulator — collects yellow lines and flushes after 3s of inactivity
const yellowEventBatch: string[] = [];
let yellowFlushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleYellowFlush(): void {
  if (yellowFlushTimer) {
    clearTimeout(yellowFlushTimer);
  }
  yellowFlushTimer = setTimeout(() => {
    yellowFlushTimer = null;
    if (!ANNIE_DEV_GROUP_JID || yellowEventBatch.length === 0) {
      yellowEventBatch.length = 0;
      return;
    }
    const text = `🟡 *Annie:*\n${yellowEventBatch.join('\n')}`;
    yellowEventBatch.length = 0;
    try {
      const ipcMsgDir = '/workspace/ipc/messages';
      fs.mkdirSync(ipcMsgDir, { recursive: true });
      const id = `annie-yellow-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const tmp = path.join(ipcMsgDir, `${id}.tmp`);
      const final = path.join(ipcMsgDir, `${id}.json`);
      fs.writeFileSync(tmp, JSON.stringify({ type: 'message', chatJid: ANNIE_DEV_GROUP_JID, text }));
      fs.renameSync(tmp, final);
    } catch { /* ignore IPC write failures */ }
  }, 3000);
}

function createPreToolUseHook(mcpServerPath: string, chatJid: string): HookCallback {
  return async (input, _toolUseId) => {
    const preToolUse = input as { hook_event_name: string; tool_name: string; tool_input: unknown };
    const { tool_name, tool_input } = preToolUse;
    const risk = classifyRisk(tool_name, tool_input);

    if (risk.level === 'green') {
      return { decision: 'approve' as const };
    }

    if (risk.level === 'yellow') {
      log(`[RISK 🟡] ${tool_name}: ${risk.reason}`);
      // Batch and forward to dev group so Jake can see what Annie is doing
      if (ANNIE_DEV_GROUP_JID) {
        yellowEventBatch.push(`🟡 ${tool_name}: ${risk.reason}`);
        scheduleYellowFlush();
      }
      return { decision: 'approve' as const };
    }

    // Red: request confirmation
    log(`[RISK 🔴] ${tool_name}: ${risk.reason} — requesting confirmation`);

    // Build a human-readable command summary (not raw JSON)
    const inputObj = tool_input as Record<string, unknown> | null;
    let commandSummary: string;
    if (tool_name === 'Bash') {
      commandSummary = String(inputObj?.command || '');
    } else if (tool_name === 'Write' || tool_name === 'Edit') {
      commandSummary = String(inputObj?.file_path || '');
    } else {
      commandSummary = JSON.stringify(tool_input ?? {}).slice(0, 400);
    }

    const confirmId = `confirm-${Date.now()}`;
    const confirmMsg = `🔴 *Dangerous action requires confirmation*\n\n` +
      `Tool: \`${tool_name}\`\n` +
      `Risk: ${risk.reason}\n\n` +
      `\`\`\`\n${commandSummary.slice(0, 600)}\n\`\`\`\n\n` +
      `Reply *YES* to allow or *NO* to cancel _(5 min timeout)_`;

    // Send confirmation request to user via IPC messages directory
    const ipcMsgDir = '/workspace/ipc/messages';
    fs.mkdirSync(ipcMsgDir, { recursive: true });
    fs.writeFileSync(
      path.join(ipcMsgDir, `${confirmId}.json`),
      JSON.stringify({ type: 'message', chatJid, text: confirmMsg }),
    );

    // Write confirm request metadata so the host routes the reply back
    fs.mkdirSync(IPC_CONFIRM_DIR, { recursive: true });
    const confirmRequestPath = path.join(IPC_CONFIRM_DIR, `${confirmId}.request`);
    fs.writeFileSync(confirmRequestPath, JSON.stringify({
      id: confirmId,
      tool_name,
      reason: risk.reason,
      command: commandSummary.slice(0, 1000),
      timestamp: Date.now(),
    }));

    // Poll for confirmation response
    const confirmResponsePath = path.join(IPC_CONFIRM_DIR, `${confirmId}.response`);
    const deadline = Date.now() + RED_CONFIRM_TIMEOUT_MS;
    let confirmed = false;

    while (Date.now() < deadline) {
      if (fs.existsSync(confirmResponsePath)) {
        try {
          const response = JSON.parse(fs.readFileSync(confirmResponsePath, 'utf-8'));
          confirmed = response.confirmed === true;
          fs.unlinkSync(confirmResponsePath);
        } catch { /* ignore parse errors */ }
        break;
      }
      await new Promise(r => setTimeout(r, IPC_POLL_MS));
    }

    // Clean up request file
    try { fs.unlinkSync(confirmRequestPath); } catch { /* ignore */ }

    if (confirmed) {
      log(`[RISK 🔴] ${tool_name}: CONFIRMED by user`);
      return { decision: 'approve' as const };
    }

    // Timed out or denied
    const denyReason = Date.now() >= deadline
      ? 'Timed out waiting for confirmation (5 minutes)'
      : 'User denied the action';
    log(`[RISK 🔴] ${tool_name}: DENIED — ${denyReason}`);

    // Notify user of cancellation
    fs.writeFileSync(
      path.join(ipcMsgDir, `${confirmId}-cancelled.json`),
      JSON.stringify({ type: 'message', chatJid, text: `🔴 Action cancelled: ${denyReason}` }),
    );

    return {
      decision: 'block' as const,
      reason: denyReason,
    };
  };
}

/**
 * Check for _close sentinel.
 */
function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

/**
 * Drain all pending IPC input messages.
 * Returns messages found, or empty array.
 */
function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/**
 * Wait for a new IPC message or _close sentinel.
 * Returns the messages as a single string, or null if _close.
 */
function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Run a single query and stream results via writeOutput.
 * Uses MessageStream (AsyncIterable) to keep isSingleUserTurn=false,
 * allowing agent teams subagents to run to completion.
 * Also pipes IPC messages into the stream during the query.
 */
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt?: string,
): Promise<{ newSessionId?: string; lastAssistantUuid?: string; closedDuringQuery: boolean }> {
  const stream = new MessageStream();
  stream.push(prompt);

  // Poll IPC for follow-up messages and _close sentinel during the query
  let ipcPolling = true;
  let closedDuringQuery = false;
  const pollIpcDuringQuery = () => {
    if (!ipcPolling) return;
    if (shouldClose()) {
      log('Close sentinel detected during query, ending stream');
      closedDuringQuery = true;
      stream.end();
      ipcPolling = false;
      return;
    }
    const messages = drainIpcInput();
    for (const text of messages) {
      log(`Piping IPC message into active query (${text.length} chars)`);
      stream.push(text);
    }
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
  };
  setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

  let newSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;
  let messageCount = 0;
  let resultCount = 0;

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Discover additional directories mounted at /workspace/extra/*
  // These are passed to the SDK so their CLAUDE.md files are loaded automatically
  const extraDirs: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }
  if (extraDirs.length > 0) {
    log(`Additional directories: ${extraDirs.join(', ')}`);
  }

  for await (const message of query({
    prompt: stream,
    options: {
      model: (() => {
        // Read model from IPC file (updated per-message by host), fall back to env var
        try {
          const m = fs.readFileSync('/workspace/ipc/model', 'utf-8').trim();
          if (m) { log(`Using model: ${m}`); return m; }
        } catch { /* ignore */ }
        return process.env.CLAUDE_MODEL || undefined;
      })(),
      cwd: '/workspace/group',
      additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: (() => {
        // Read current model for system prompt injection
        let currentModel = process.env.CLAUDE_MODEL || 'unknown';
        try {
          const m = fs.readFileSync('/workspace/ipc/model', 'utf-8').trim();
          if (m) currentModel = m;
        } catch { /* ignore */ }
        const modelNote = `\n\nYou are currently running on model: ${currentModel}. When asked what model you are, report this value.`;
        const extra = (globalClaudeMd || '') + modelNote;
        return { type: 'preset' as const, preset: 'claude_code' as const, append: extra };
      })(),
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        'mcp__ollama__*',
        'mcp__hue__*',
        'mcp__sonos__*',
        'mcp__samsung_tv__*',
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'],
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        ollama: {
          command: 'node',
          args: [path.join(path.dirname(mcpServerPath), 'ollama-mcp-stdio.js')],
          env: {
            ...(process.env.OLLAMA_HOST ? { OLLAMA_HOST: process.env.OLLAMA_HOST } : {}),
          },
        },
        hue: {
          command: 'node',
          args: [path.join(path.dirname(mcpServerPath), 'hue-mcp-stdio.js')],
          env: {
            ...(process.env.HUE_BRIDGE_IP ? { HUE_BRIDGE_IP: process.env.HUE_BRIDGE_IP } : {}),
            ...(process.env.HUE_API_KEY ? { HUE_API_KEY: process.env.HUE_API_KEY } : {}),
          },
        },
        sonos: {
          command: 'node',
          args: [path.join(path.dirname(mcpServerPath), 'sonos-mcp-stdio.js')],
          env: {
            ...(process.env.SONOS_API_URL ? { SONOS_API_URL: process.env.SONOS_API_URL } : {}),
          },
        },
        samsung_tv: {
          command: 'node',
          args: [path.join(path.dirname(mcpServerPath), 'samsung-tv-mcp-stdio.js')],
          env: {
            ...(process.env.SAMSUNG_TV_IP ? { SAMSUNG_TV_IP: process.env.SAMSUNG_TV_IP } : {}),
            // Store token in mounted group dir so it persists across container restarts
            SAMSUNG_TV_TOKEN_FILE: '/workspace/group/samsung-tv-token.json',
          },
        },
      },
      hooks: {
        PreToolUse: [{ hooks: [createPreToolUseHook(mcpServerPath, containerInput.chatJid)] }],
        PreCompact: [{ hooks: [createPreCompactHook(containerInput.assistantName)] }],
      },
    }
  })) {
    messageCount++;
    const msgType = message.type === 'system' ? `system/${(message as { subtype?: string }).subtype}` : message.type;
    log(`[msg #${messageCount}] type=${msgType}`);

    if (message.type === 'assistant' && 'uuid' in message) {
      lastAssistantUuid = (message as { uuid: string }).uuid;
    }

    if (message.type === 'system' && message.subtype === 'init') {
      newSessionId = message.session_id;
      log(`Session initialized: ${newSessionId}`);
    }

    if (message.type === 'system' && (message as { subtype?: string }).subtype === 'task_notification') {
      const tn = message as { task_id: string; status: string; summary: string };
      log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
    }

    if (message.type === 'result') {
      resultCount++;
      const textResult = 'result' in message ? (message as { result?: string }).result : null;

      // Extract actual model(s) used from modelUsage
      const modelUsage = (message as { modelUsage?: Record<string, unknown> }).modelUsage;
      const modelsUsed = modelUsage ? Object.keys(modelUsage) : [];
      const modelTag = modelsUsed.length > 0 ? `\n\n🤖 ${modelsUsed.join(', ')}` : '';
      log(`Result #${resultCount}: subtype=${message.subtype} models=${modelsUsed.join(',') || 'unknown'}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`);

      writeOutput({
        status: 'success',
        result: textResult ? textResult + modelTag : null,
        newSessionId
      });
    }
  }

  ipcPolling = false;
  log(`Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`);
  return { newSessionId, lastAssistantUuid, closedDuringQuery };
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}, model: ${process.env.CLAUDE_MODEL || 'default'}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  // Credentials are injected by the host's credential proxy via ANTHROPIC_BASE_URL.
  // No real secrets exist in the container environment.
  const sdkEnv: Record<string, string | undefined> = { ...process.env };

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

  let sessionId = containerInput.sessionId;
  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });

  // Clean up stale _close sentinel from previous container runs
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt (drain any pending IPC messages too)
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Query loop: run query → wait for IPC message → run new query → repeat
  let resumeAt: string | undefined;
  try {
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);

      const queryResult = await runQuery(prompt, sessionId, mcpServerPath, containerInput, sdkEnv, resumeAt);
      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      // If _close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Wait for the next message or _close sentinel
      const nextMessage = await waitForIpcMessage();
      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage
    });
    process.exit(1);
  }
}

main();
