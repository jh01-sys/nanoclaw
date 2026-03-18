/**
 * CC Worker — watches data/ipc/cc-inbox/ for new .task files from Annie
 * and dispatches them intelligently.
 *
 * Routing:
 *   Simple questions (no code/file context needed) → Ollama (local, instant, free)
 *   Code/implementation tasks                      → claude --print (full codebase access)
 *
 * Parallelism:
 *   Ollama tasks: unlimited concurrency (local, no rate limits)
 *   Claude tasks: up to CC_MAX_WORKERS concurrent sessions (default 2)
 *
 * Resilience:
 *   - Session timeout: kills hung Claude sessions after CC_TIMEOUT_MS (default 8 min)
 *   - Ollama failure: falls back to Claude automatically
 *   - Dispatched set persisted across restarts (.dispatched.json)
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const CC_INBOX_DIR = path.join(DATA_DIR, 'ipc', 'cc-inbox');
const DISPATCHED_FILE = path.join(CC_INBOX_DIR, '.dispatched.json');
const RUNNING_FILE = path.join(CC_INBOX_DIR, '.running.json');
const STATUS_FILE = path.join(CC_INBOX_DIR, 'cc_status.json');
const MAX_RECENT_COMPLETIONS = 10;

// Rolling log of recently completed tasks — persisted across writeCcStatus() calls
const recentCompletions: {
  id: string;
  title: string;
  completedAt: string;
  durationMs: number;
  outcome: 'ok' | 'error';
}[] = [];
const CLAUDE_BIN = '/home/jake/.npm-global/bin/claude';
const POLL_INTERVAL_MS = 2000;

const MAX_CLAUDE_WORKERS = parseInt(process.env.CC_MAX_WORKERS || '2', 10);
const SESSION_TIMEOUT_MS = parseInt(
  process.env.CC_TIMEOUT_MS || String(8 * 60 * 1000),
  10,
);

// Ollama: read OLLAMA_HOST from env (same var used by container), fallback to localhost
const _ollamaHost = (process.env.OLLAMA_HOST || 'localhost:11434').replace(
  /^https?:\/\//,
  '',
);
const OLLAMA_URL = `http://${_ollamaHost}`;
const OLLAMA_MODEL = process.env.CC_OLLAMA_MODEL || 'qwen2.5-coder:7b';

// ── State ────────────────────────────────────────────────────────────────────

const dispatchedTaskIds = new Set<string>(loadDispatched());

interface RunningSession {
  proc: ReturnType<typeof spawn>;
  timer: ReturnType<typeof setTimeout>;
  chatJid: string;
  title: string;
  startedAt: number;
  type: 'claude' | 'ollama';
}
const runningSessions = new Map<string, RunningSession>();

// ── Persistence ──────────────────────────────────────────────────────────────

function loadDispatched(): string[] {
  try {
    return JSON.parse(fs.readFileSync(DISPATCHED_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveDispatched(): void {
  try {
    const existingIds = new Set(
      fs
        .readdirSync(CC_INBOX_DIR)
        .filter((f) => f.endsWith('.task'))
        .map((f) => {
          try {
            return JSON.parse(
              fs.readFileSync(path.join(CC_INBOX_DIR, f), 'utf-8'),
            ).id;
          } catch {
            return null;
          }
        })
        .filter(Boolean),
    );
    const pruned = [...dispatchedTaskIds].filter((id) => existingIds.has(id));
    fs.writeFileSync(DISPATCHED_FILE, JSON.stringify(pruned));
  } catch {}
}

function saveRunning(): void {
  try {
    const running = [...runningSessions.entries()].map(([id, s]) => ({
      id,
      title: s.title,
      chatJid: s.chatJid,
      type: s.type,
      startedAt: s.startedAt,
    }));
    fs.writeFileSync(RUNNING_FILE, JSON.stringify(running));
  } catch {}
}

/**
 * Write cc_status.json — read by Annie's container at session start.
 * Gives Annie a live view of what CC is working on and what's queued.
 */
export function writeCcStatus(): void {
  try {
    const running = [...runningSessions.entries()].map(([id, s]) => ({
      id,
      title: s.title,
      type: s.type,
      startedAt: s.startedAt,
      elapsedMs: Date.now() - s.startedAt,
    }));

    const allTaskFiles = fs
      .readdirSync(CC_INBOX_DIR)
      .filter((f) => f.endsWith('.task'))
      .sort();
    const queued: { id: string; title: string; ts: string }[] = [];
    for (const f of allTaskFiles) {
      try {
        const t = JSON.parse(
          fs.readFileSync(path.join(CC_INBOX_DIR, f), 'utf-8'),
        );
        if (t.id && !dispatchedTaskIds.has(t.id)) {
          queued.push({ id: t.id, title: t.title, ts: t.ts });
        }
      } catch {}
    }

    const status = {
      updated: new Date().toISOString(),
      idle: running.length === 0 && queued.length === 0,
      running,
      queued,
      recent_completions: recentCompletions.slice(),
    };

    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  } catch {}
}

function writeResponse(taskId: string, chatJid: string, result: string): void {
  const tempPath = path.join(CC_INBOX_DIR, `${taskId}.response.tmp`);
  const finalPath = path.join(CC_INBOX_DIR, `${taskId}.response`);
  fs.writeFileSync(
    tempPath,
    JSON.stringify({ id: taskId, chatJid, result }, null, 2),
  );
  fs.renameSync(tempPath, finalPath);
}

// ── Task classification ───────────────────────────────────────────────────────

/**
 * Classify whether a task needs Claude (file edits, bash, build ops) or
 * can be handled by Ollama (questions, status, lookups, explanations).
 *
 * Key principle: only route to Claude if the task requires ACTIONS —
 * modifying files, running commands, building, installing, etc.
 * Questions and status checks go to Ollama even if they mention code terms.
 */
function classifyTask(title: string, body: string): 'claude' | 'ollama' {
  const text = (title + ' ' + body).toLowerCase();

  // Explicit action verbs that require file/bash tools → Claude
  const requiresAction =
    /\b(fix|implement|add|create|build|refactor|install|deploy|wire|rewrite|migrate|rename|delete|remove|edit|write|push|commit|restart|run|execute|apply|configure|set up|set up)\b/.test(
      text,
    ) || /\.(ts|js|py|json|md|sh|yaml|yml)\b/.test(text); // specific file references

  if (requiresAction) return 'claude';

  // Everything else (questions, status checks, lookups, explanations) → Ollama
  return 'ollama';
}

// ── Ollama dispatch ───────────────────────────────────────────────────────────

async function dispatchOllama(
  task: { id: string; title: string; body: string; chatJid: string },
  deps: CcWorkerDeps,
  fallbackToClaude: () => Promise<void>,
): Promise<void> {
  logger.info(
    { id: task.id, title: task.title },
    'CC worker: dispatching to Ollama',
  );

  const prompt = [
    `You are CC, a developer assistant. Answer the following question concisely.`,
    `Do not use markdown headings. Keep the answer short and direct.`,
    ``,
    `Question: ${task.title}`,
    task.body && task.body !== task.title ? `\nContext: ${task.body}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!resp.ok) throw new Error(`Ollama HTTP ${resp.status}`);

    const data = (await resp.json()) as { response?: string };
    const result = (data.response || '').trim();

    if (!result) throw new Error('Ollama returned empty response');

    writeResponse(task.id, task.chatJid, result);
    logger.info({ id: task.id }, 'CC worker: Ollama task complete');
  } catch (err) {
    logger.warn(
      { id: task.id, err },
      'CC worker: Ollama failed, falling back to Claude',
    );
    await fallbackToClaude();
  }
}

// ── Claude dispatch ───────────────────────────────────────────────────────────

function dispatchClaude(
  task: {
    id: string;
    title: string;
    body: string;
    chatJid: string;
    source?: 'jake' | 'annie';
  },
  deps: CcWorkerDeps,
): void {
  logger.info(
    { id: task.id, title: task.title },
    'CC worker: dispatching Claude session',
  );

  const intro =
    task.source === 'jake'
      ? `Jake sent you a direct message from the main chat. Handle it now.`
      : `Annie sent you a task via cc_send_task. Handle it now.`;

  const prompt = [
    intro,
    `Task ID: ${task.id} | Chat JID: ${task.chatJid}`,
    `Title: ${task.title}`,
    task.body && task.body !== task.title ? `\n${task.body}` : '',
    `\nWrite response to data/ipc/cc-inbox/${task.id}.response (see CLAUDE.md).`,
  ]
    .filter(Boolean)
    .join('\n');

  const proc = spawn(CLAUDE_BIN, ['--print', prompt], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: `/home/jake/.npm-global/bin:${process.env.PATH ?? ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const timer = setTimeout(() => {
    logger.warn(
      { id: task.id, title: task.title },
      'CC worker: session timed out, killing',
    );
    proc.kill('SIGTERM');
    const errMsg = `⚙️ *CC:* ⏱️ Task timed out — _${task.title}_`;
    deps.sendMessage(task.chatJid, errMsg).catch(() => {});
    deps.storeCcMessage(task.chatJid, errMsg);
  }, SESSION_TIMEOUT_MS);

  const session: RunningSession = {
    proc,
    timer,
    chatJid: task.chatJid,
    title: task.title,
    startedAt: Date.now(),
    type: 'claude',
  };
  runningSessions.set(task.id, session);
  saveRunning();
  writeCcStatus();

  proc.stderr.on('data', (d: Buffer) => {
    const line = d.toString().trim();
    if (line) logger.debug({ taskId: task.id, line }, 'CC worker stderr');
  });

  proc.on('error', async (err) => {
    clearTimeout(timer);
    const startedAt = runningSessions.get(task.id)?.startedAt ?? Date.now();
    runningSessions.delete(task.id);
    saveRunning();
    saveDispatched();
    recentCompletions.unshift({
      id: task.id,
      title: task.title,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      outcome: 'error',
    });
    if (recentCompletions.length > MAX_RECENT_COMPLETIONS)
      recentCompletions.length = MAX_RECENT_COMPLETIONS;
    writeCcStatus();
    logger.error({ err }, 'CC worker: failed to spawn claude');
    const errMsg = `⚙️ *CC:* ❌ Failed to start: ${err.message}`;
    await deps.sendMessage(task.chatJid, errMsg).catch(() => {});
    deps.storeCcMessage(task.chatJid, errMsg);
  });

  proc.on('close', (code) => {
    clearTimeout(timer);
    const startedAt = runningSessions.get(task.id)?.startedAt ?? Date.now();
    runningSessions.delete(task.id);
    saveRunning();
    saveDispatched();
    recentCompletions.unshift({
      id: task.id,
      title: task.title,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      outcome: code === 0 ? 'ok' : 'error',
    });
    if (recentCompletions.length > MAX_RECENT_COMPLETIONS)
      recentCompletions.length = MAX_RECENT_COMPLETIONS;
    writeCcStatus();
    logger.info(
      { taskId: task.id, title: task.title, code },
      'CC worker: session complete',
    );
  });
}

// ── Main dispatch loop ────────────────────────────────────────────────────────

export interface CcWorkerDeps {
  devGroupJid: () => string | null;
  sendMessage: (jid: string, text: string) => Promise<void>;
  storeCcMessage: (chatJid: string, text: string) => void;
  sendReaction?: (
    jid: string,
    messageId: number,
    emoji: string,
  ) => Promise<void>;
}

async function checkAndDispatch(deps: CcWorkerDeps): Promise<void> {
  let files: string[];
  try {
    files = fs
      .readdirSync(CC_INBOX_DIR)
      .filter((f) => f.endsWith('.task'))
      .sort();
  } catch {
    return;
  }

  for (const f of files) {
    // Check Claude slot availability before each dispatch attempt
    if (runningSessions.size >= MAX_CLAUDE_WORKERS) break;

    let task: {
      id: string;
      title: string;
      body: string;
      chatJid: string;
      triggerMessageId?: number;
      source?: 'jake' | 'annie';
    };
    try {
      task = JSON.parse(fs.readFileSync(path.join(CC_INBOX_DIR, f), 'utf-8'));
    } catch {
      continue;
    }

    if (!task.id || dispatchedTaskIds.has(task.id)) continue;

    dispatchedTaskIds.add(task.id);
    saveDispatched();

    // Acknowledge: 👍 reaction if we have the trigger message ID, else minimal text
    if (task.triggerMessageId && deps.sendReaction) {
      await deps
        .sendReaction(task.chatJid, task.triggerMessageId, '👍')
        .catch(async () => {
          await deps
            .sendMessage(task.chatJid, `⚙️ *CC:* 👍 _${task.title}_`)
            .catch(() => {});
        });
    } else {
      // No triggerMessageId — send minimal text ack so user knows task was received
      await deps
        .sendMessage(task.chatJid, `⚙️ *CC:* 👍 _${task.title}_`)
        .catch((err) => {
          logger.warn(
            { err, chatJid: task.chatJid },
            'CC worker: failed to send ack',
          );
        });
      deps.storeCcMessage(task.chatJid, `⚙️ *CC:* 👍 _${task.title}_`);
    }

    const type = classifyTask(task.title, task.body);

    if (type === 'ollama') {
      // Ollama runs outside the Claude slot limit — dispatch async, don't block
      dispatchOllama(task, deps, async () => {
        // Fallback: route to Claude if Ollama fails
        if (runningSessions.size < MAX_CLAUDE_WORKERS) {
          dispatchClaude(task, deps);
        } else {
          // No Claude slot available — write an error response
          writeResponse(
            task.id,
            task.chatJid,
            `⚠️ Ollama unavailable and no Claude slots free. Please retry.`,
          );
        }
      }).catch(() => {});
    } else {
      dispatchClaude(task, deps);
    }
  }
}

export function startCcWorker(deps: CcWorkerDeps): void {
  const poll = async () => {
    try {
      await checkAndDispatch(deps);
    } catch (err) {
      logger.warn({ err }, 'CC worker: poll error');
    }
    setTimeout(poll, POLL_INTERVAL_MS);
  };
  poll();
  logger.info(
    { maxWorkers: MAX_CLAUDE_WORKERS, ollamaModel: OLLAMA_MODEL },
    'CC worker started',
  );
}
