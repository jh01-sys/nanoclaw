#!/usr/bin/env node
/**
 * cc-task-tracker.mjs
 *
 * Watches data/ipc/cc-inbox/ and auto-updates groups/telegram_main/tasks.json:
 *   *.task    → status: inProgress  (CC picked up a task)
 *   *.response → status: completed  (CC finished + wrote a response)
 *   *.blocked  → status: blocked    (CC hit a blocker, JSON: { reason })
 *
 * Run as a systemd user service (nanoclaw-cc-tracker.service) or via:
 *   node scripts/cc-task-tracker.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CC_INBOX = path.join(ROOT, 'data', 'ipc', 'cc-inbox');
const TASKS_JSON = path.join(ROOT, 'groups', 'telegram_main', 'tasks.json');
const ISSUES_MD = path.join(ROOT, 'groups', 'telegram_main', 'issues.md');
const POLL_MS = 5000;
const MAIN_CHAT_JID = 'tg:8734325292';

const FIX_KEYWORDS = /\b(fix|bug|repair|broken|broke)\b/i;

// Words too generic to count as meaningful overlap in fuzzy matching
const FUZZY_STOP_WORDS = new Set([
  'fix', 'add', 'task', 'the', 'and', 'for', 'with', 'from', 'into', 'that',
  'this', 'update', 'create', 'make', 'get', 'set', 'use', 'via', 'plus',
  'also', 'each', 'when', 'then', 'list', 'item', 'show', 'type', 'page',
  'view', 'send', 'read', 'write', 'find', 'open', 'move', 'call', 'need',
  'want', 'new', 'old', 'now', 'not', 'all', 'more', 'some', 'have', 'been',
  'will', 'can', 'does', 'done', 'like', 'just', 'back', 'auto',
]);

// ── helpers ──────────────────────────────────────────────────────────────────

function readTasksJson() {
  return JSON.parse(fs.readFileSync(TASKS_JSON, 'utf-8'));
}

function writeTasksJson(data) {
  data.last_updated = new Date().toISOString();
  updateStats(data);
  fs.writeFileSync(TASKS_JSON, JSON.stringify(data, null, 2) + '\n');
}

function updateStats(data) {
  const s = { total: 0, completed: 0, inProgress: 0, pendingTesting: 0, pending: 0, blocked: 0, failed: 0 };
  for (const t of data.tasks) {
    s.total++;
    if (t.status === 'completed') s.completed++;
    else if (t.status === 'inProgress') s.inProgress++;
    else if (t.status === 'pendingTesting') s.pendingTesting++;
    else if (t.status === 'blocked') s.blocked++;
    else if (t.status === 'failed') s.failed++;
    else s.pending++;
  }
  data.stats = s;
}

/**
 * Write a notification .response to cc-inbox so cc-bridge delivers it to Telegram.
 */
function sendNotification(chatJid, message) {
  const id = `notify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const notifPath = path.join(CC_INBOX, `${id}.response`);
  try {
    fs.writeFileSync(notifPath, JSON.stringify({ id, chatJid, result: message }));
    console.log(`[cc-task-tracker] notification queued → ${chatJid}: ${message.slice(0, 80)}`);
  } catch (e) {
    console.error('[cc-task-tracker] failed to queue notification:', e.message);
  }
}

function findTaskById(data, ccTaskId) {
  return data.tasks.find((t) => t.cc_task_id === ccTaskId);
}

function sigWords(title) {
  return title
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 3 && !FUZZY_STOP_WORDS.has(w) && !/^\d+$/.test(w));
}

function fuzzyMatch(titleA, titleB) {
  const wa = new Set(sigWords(titleA));
  const wb = sigWords(titleB);
  return wb.filter((w) => wa.has(w)).length >= 3;
}

/**
 * Find an open (pending/inProgress) task by fuzzy title match.
 * Used when a cc_task_id lookup fails — avoids creating duplicates of planned tasks.
 */
function findTaskByFuzzyTitle(data, title, allowedStatuses = ['pending', 'inProgress']) {
  if (!title) return null;
  return data.tasks.find(
    (t) => allowedStatuses.includes(t.status) && fuzzyMatch(t.title, title)
  ) || null;
}

function nextNumericId(data) {
  return Math.max(0, ...data.tasks.map((t) => Number(t.id) || 0)) + 1;
}

function ensureTask(data, ccTaskId, title) {
  let task = findTaskById(data, ccTaskId);
  if (!task && title) {
    // Exact title match first (tasks pre-dating the tracker with no cc_task_id)
    task = data.tasks.find((t) => t.title === title && !t.cc_task_id);
    // Fuzzy title match against open tasks — prevents duplicating planned tasks
    if (!task) task = findTaskByFuzzyTitle(data, title);
    if (task) {
      task.cc_task_id = ccTaskId;
    }
  }
  if (!task) {
    task = {
      id: nextNumericId(data),
      cc_task_id: ccTaskId,
      title: title || `CC Task ${ccTaskId}`,
      status: 'pending',
      owner: 'CC',
      priority: 'medium',
    };
    data.tasks.push(task);
  }
  return task;
}

function safeRead(filepath) {
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Fuzzy-check if an open issue heading in issues.md is similar to the task title.
 * Splits both strings into words (≥4 chars), checks if any 2+ words overlap.
 */
function issueAlreadyOpen(content, taskTitle) {
  const titleWords = new Set(
    taskTitle.toLowerCase().split(/\W+/).filter((w) => w.length >= 4)
  );
  // Find open issue headings (## lines not prefixed with ✅)
  const headings = content.match(/^## (?!✅)[^\n]+/gm) || [];
  return headings.some((h) => {
    const headWords = h.toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
    const overlap = headWords.filter((w) => titleWords.has(w));
    return overlap.length >= 2;
  });
}

function autoUpdateIssues(task, result) {
  if (!FIX_KEYWORDS.test(task.title)) return;
  try {
    const content = fs.existsSync(ISSUES_MD)
      ? fs.readFileSync(ISSUES_MD, 'utf-8')
      : '# Open Issues\n\n';

    // Check for existing open issue with similar title
    if (!issueAlreadyOpen(content, task.title)) return;

    const date = new Date().toISOString().slice(0, 10);
    const resultLine = result ? result.slice(0, 200).replace(/\n/g, ' ') : '';

    // Find the matching heading and update it
    const updated = content.replace(
      /^(## (?!✅)[^\n]*)/m,
      (match) => {
        // Only replace if this heading matches the task
        const headWords = match.toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
        const titleWords = task.title.toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
        const overlap = headWords.filter((w) => titleWords.includes(w));
        if (overlap.length < 2) return match;
        return `## ✅ ${match.slice(3)}\n**Fixed by CC:** ${task.title} on ${date}${resultLine ? '\n' + resultLine : ''}`;
      }
    );

    if (updated !== content) {
      fs.writeFileSync(ISSUES_MD, updated);
      console.log(`[cc-task-tracker] issues.md updated for fix task: "${task.title}"`);
    }
  } catch (e) {
    console.error('[cc-task-tracker] autoUpdateIssues error:', e.message);
  }
}

// ── per-file handlers ─────────────────────────────────────────────────────────

function handleTask(file, ccTaskId) {
  const payload = safeRead(file);
  if (!payload) return;

  const data = readTasksJson();
  const task = ensureTask(data, ccTaskId, payload.title);

  if (task.status === 'completed') return; // already done, don't regress

  task.status = 'inProgress';
  task.assigned_to = 'CC';
  task.startedDate = task.startedDate || new Date().toISOString();
  if (payload.body) task.description = payload.body.slice(0, 300);

  writeTasksJson(data);
  console.log(`[cc-task-tracker] ${ccTaskId} → inProgress ("${task.title}")`);
}

function handleResponse(file, ccTaskId) {
  const payload = safeRead(file);
  if (!payload) return;

  // Skip notification files written by this tracker — they have no matching task
  if (ccTaskId.startsWith('notify-')) return;

  const data = readTasksJson();
  // Try exact cc_task_id first, then fuzzy title match (handles tracker restarts
  // where the .task was already processed but cc_task_id was set on a planned task)
  let task = findTaskById(data, ccTaskId);
  if (!task && payload.title) task = findTaskByFuzzyTitle(data, payload.title, ['pending', 'inProgress', 'blocked']);
  if (!task) return; // no matching task to update

  if (!task.cc_task_id) task.cc_task_id = ccTaskId;

  if (payload.outcome === 'error') {
    task.status = 'failed';
    task.failedReason = payload.result ? payload.result.slice(0, 200) : 'Task errored';
    task.failedDate = new Date().toISOString();
    delete task.blockers;

    writeTasksJson(data);
    console.log(`[cc-task-tracker] ${ccTaskId} → failed (outcome: error, "${task.title}")`);

    const chatJid = payload.chatJid || MAIN_CHAT_JID;
    sendNotification(chatJid, `❌ CC task failed: ${task.title}`);
    return;
  }

  task.status = 'completed';
  task.completedDate = task.completedDate || new Date().toISOString();
  if (payload.result) task.notes = payload.result.slice(0, 400);
  delete task.blockers;

  writeTasksJson(data);
  console.log(`[cc-task-tracker] ${ccTaskId} → completed ("${task.title}")`);

  autoUpdateIssues(task, payload.result);
}

function handleBlocked(file, ccTaskId) {
  const payload = safeRead(file);
  if (!payload) return;

  const data = readTasksJson();
  const task = findTaskById(data, ccTaskId);
  if (!task) return;

  task.status = 'blocked';
  task.blockers = payload.reason ? [payload.reason] : ['Unknown blocker'];
  task.notes = payload.notes || task.notes;

  writeTasksJson(data);
  console.log(`[cc-task-tracker] ${ccTaskId} → blocked ("${task.title}")`);
}

// ── main poll loop ────────────────────────────────────────────────────────────

// Track which files we've already processed so we don't re-process on restart
// We use the tasks.json state itself as the source of truth instead of an in-memory set,
// so restarts are safe.

function getProcessedState(data) {
  const inProgress = new Set();
  const completed = new Set();
  const blocked = new Set();
  for (const t of data.tasks) {
    if (!t.cc_task_id) continue;
    if (t.status === 'inProgress') inProgress.add(t.cc_task_id);
    if (t.status === 'completed') completed.add(t.cc_task_id);
    if (t.status === 'blocked') blocked.add(t.cc_task_id);
  }
  return { inProgress, completed, blocked };
}

async function poll() {
  let files;
  try {
    files = fs.readdirSync(CC_INBOX);
  } catch {
    setTimeout(poll, POLL_MS);
    return;
  }

  let data;
  try {
    data = readTasksJson();
  } catch (err) {
    console.error('[cc-task-tracker] Cannot read tasks.json:', err.message);
    setTimeout(poll, POLL_MS);
    return;
  }

  const state = getProcessedState(data);

  for (const file of files) {
    const filepath = path.join(CC_INBOX, file);

    if (file.endsWith('.task')) {
      const id = file.slice(0, -5);
      // Only mark inProgress if not already completed/blocked
      if (!state.completed.has(id) && !state.blocked.has(id) && !state.inProgress.has(id)) {
        try { handleTask(filepath, id); } catch (e) { console.error(e); }
        // Reload state after write
        try { data = readTasksJson(); } catch {}
      }
    } else if (file.endsWith('.response')) {
      const id = file.slice(0, -9);
      if (!state.completed.has(id)) {
        try { handleResponse(filepath, id); } catch (e) { console.error(e); }
        try { data = readTasksJson(); } catch {}
      }
    } else if (file.endsWith('.done')) {
      // Durable completion marker — written by CC alongside .response so the
      // tracker catches it even if the host deletes .response first.
      const id = file.slice(0, -5);
      if (!state.completed.has(id)) {
        const donePayload = safeRead(filepath) || {};
        try {
          const d2 = readTasksJson();
          let t = findTaskById(d2, id);
          if (!t && donePayload.title) t = findTaskByFuzzyTitle(d2, donePayload.title, ['pending', 'inProgress', 'blocked']);
          if (t) {
            if (!t.cc_task_id) t.cc_task_id = id;
            t.status = 'completed';
            t.completedDate = t.completedDate || new Date().toISOString();
            if (donePayload.result) t.notes = donePayload.result.slice(0, 400);
            delete t.blockers;
            writeTasksJson(d2);
            console.log(`[cc-task-tracker] ${id} → completed (via .done, task: "${t.title}")`);
          }
        } catch (e) { console.error(e); }
        try { data = readTasksJson(); } catch {}
        // Keep .done files — they're durable markers (don't delete)
      }
    } else if (file.endsWith('.blocked')) {
      const id = file.slice(0, -8);
      if (!state.blocked.has(id)) {
        try { handleBlocked(filepath, id); } catch (e) { console.error(e); }
        try { data = readTasksJson(); } catch {}
      }
    }
  }

  // ── Timeout sweep ───────────────────────────────────────────────────────────
  // Any inProgress task whose .task file is older than 30 minutes with no
  // .response or .done file → mark as timed_out and remove the stale .task file.
  try {
    const TIMEOUT_MS = 30 * 60 * 1000;
    const now = Date.now();
    const taskFiles = fs.readdirSync(CC_INBOX).filter((f) => f.endsWith('.task'));

    for (const f of taskFiles) {
      const id = f.slice(0, -5);
      const taskPath = path.join(CC_INBOX, f);
      let mtime;
      try {
        mtime = fs.statSync(taskPath).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtime < TIMEOUT_MS) continue;

      // Stale: check if a .response or .done already exists
      const hasResponse = fs.existsSync(path.join(CC_INBOX, `${id}.response`));
      const hasDone = fs.existsSync(path.join(CC_INBOX, `${id}.done`));
      if (hasResponse || hasDone) continue;

      // Mark as failed in tasks.json and notify
      try {
        const d = readTasksJson();
        const task = findTaskById(d, id);
        if (task && task.status === 'inProgress') {
          task.status = 'failed';
          task.failedReason = 'timed_out_after_30m';
          task.failedDate = new Date().toISOString();
          task.notes = (task.notes ? task.notes + ' | ' : '') + `Timed out at ${task.failedDate}`;
          writeTasksJson(d);
          console.log(`[cc-task-tracker] ${id} → failed/timed_out (stale .task file, no response)`);

          // Read chatJid from the stale .task file if possible, fall back to main chat
          let chatJid = MAIN_CHAT_JID;
          try {
            const taskPayload = safeRead(path.join(CC_INBOX, `${id}.task`));
            if (taskPayload?.chatJid) chatJid = taskPayload.chatJid;
          } catch {}

          sendNotification(chatJid, `⚠️ CC task dropped: ${task.title} — timed out after 30m. Re-queuing needed.`);
        }
      } catch (e) {
        console.error('[cc-task-tracker] timeout sweep error:', e);
      }

      // Remove the stale .task file so cc-worker won't re-dispatch
      try {
        fs.unlinkSync(taskPath);
        console.log(`[cc-task-tracker] removed stale .task: ${f}`);
      } catch {}
    }
  } catch (e) {
    console.error('[cc-task-tracker] timeout sweep failed:', e);
  }

  setTimeout(poll, POLL_MS);
}

console.log('[cc-task-tracker] Started. Watching', CC_INBOX);
poll();
