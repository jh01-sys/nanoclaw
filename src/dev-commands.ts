/**
 * Dev commands — intercept /slash commands from Telegram before they reach the agent.
 * Only allowed from the main group. Sender allowlist is enforced by the caller.
 */
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { scheduleFade, cancelFade, getFadeStatus } from './hue-scheduler.js';

const PROJECT_ROOT = process.cwd();
const PLAN_PATHS = [
  path.join(PROJECT_ROOT, 'groups', 'telegram_main', 'DEVELOPMENT_PLAN.md'),
  path.join(PROJECT_ROOT, 'DEVELOPMENT_PLAN.md'),
];

/**
 * Check if a message is a dev command. Returns true if handled.
 */
export function isDevCommand(content: string): boolean {
  const cmd = content.trim().toLowerCase();
  return (
    cmd === '/restart' ||
    cmd === '/build' ||
    cmd.startsWith('/logs') ||
    cmd === '/status' ||
    cmd.startsWith('/git ') ||
    cmd === '/git' ||
    cmd === '/plan' ||
    cmd.startsWith('/plan ') ||
    cmd === '/todo' ||
    cmd === '/model' ||
    cmd.startsWith('/model ') ||
    cmd === '/review' ||
    cmd === '/merge' ||
    cmd === '/branch' ||
    cmd === '/fade' ||
    cmd.startsWith('/fade ')
  );
}

/**
 * Execute a dev command and return the response text.
 */
export async function handleDevCommand(content: string): Promise<string> {
  const trimmed = content.trim();
  const cmd = trimmed.toLowerCase();

  try {
    if (cmd === '/restart') return await cmdRestart();
    if (cmd === '/build') return await cmdBuild();
    if (cmd.startsWith('/logs')) return await cmdLogs(trimmed);
    if (cmd === '/status') return await cmdStatus();
    if (cmd.startsWith('/git')) return await cmdGit(trimmed);
    if (cmd === '/plan') return cmdPlan();
    if (cmd.startsWith('/plan ')) return cmdPlanAction(trimmed);
    if (cmd === '/todo') return cmdTodo();
    if (cmd.startsWith('/model')) return cmdModel(trimmed);
    if (cmd === '/review') return await cmdReview();
    if (cmd === '/merge') return await cmdMerge();
    if (cmd === '/branch') return await cmdBranch();
    if (cmd === '/fade' || cmd.startsWith('/fade '))
      return await cmdFade(trimmed);
    return `Unknown command: ${trimmed}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, cmd: trimmed }, 'Dev command failed');
    return `Error: ${msg}`;
  }
}

// --- Command implementations ---

async function cmdRestart(): Promise<string> {
  // Restart via systemd after a short delay so the reply gets sent first
  setTimeout(() => {
    run('systemctl --user restart nanoclaw').catch(() => {});
  }, 1000);
  return '🔄 Restarting NanoClaw...';
}

async function cmdBuild(): Promise<string> {
  const result = await run('npm run build 2>&1', 30000);
  if (result.exitCode === 0) {
    return '✅ Build succeeded';
  }
  const tail = result.output.split('\n').slice(-10).join('\n');
  return `❌ Build failed (exit ${result.exitCode}):\n\`\`\`\n${tail}\n\`\`\``;
}

async function cmdLogs(input: string): Promise<string> {
  const parts = input.split(/\s+/);
  const n = parseInt(parts[1], 10) || 20;
  const clamped = Math.min(Math.max(n, 1), 100);
  const result = await run(`tail -${clamped} logs/nanoclaw.log 2>&1`);
  // Strip ANSI color codes for readability in Telegram
  const clean = result.output.replace(/\x1b\[[0-9;]*m/g, '');
  return `\`\`\`\n${clean.slice(-3500)}\n\`\`\``;
}

async function cmdStatus(): Promise<string> {
  const [uptime, service, whisper, containers] = await Promise.all([
    run('uptime -p 2>/dev/null || uptime'),
    run('systemctl --user status nanoclaw 2>&1 | head -4'),
    getWhisperConfig(),
    run(
      'docker ps --filter name=nanoclaw- --format "{{.Names}} ({{.Status}})" 2>/dev/null',
    ),
  ]);

  const activeContainers = containers.output.trim() || 'none';

  let modelMode = 'auto (haiku/sonnet)';
  try {
    const override = fs
      .readFileSync(
        path.join(PROJECT_ROOT, 'data', 'model-override.txt'),
        'utf-8',
      )
      .trim();
    if (override) modelMode = `override: ${override}`;
  } catch {
    /* auto */
  }

  return [
    `*Status*`,
    `Uptime: ${uptime.output.trim()}`,
    `Service: ${service.output.includes('active (running)') ? '✅ running' : '⚠️ ' + service.output.trim()}`,
    `Model: ${modelMode}`,
    `Whisper: ${whisper}`,
    `Containers: ${activeContainers}`,
  ].join('\n');
}

function getWhisperConfig(): string {
  try {
    const envContent = fs.readFileSync(
      path.join(PROJECT_ROOT, '.env'),
      'utf-8',
    );
    const model =
      envContent.match(/WHISPER_MODEL=(.+)/)?.[1] || 'default (base)';
    const lang = envContent.match(/WHISPER_LANG=(.+)/)?.[1] || 'auto';
    return `model=${model}, lang=${lang}`;
  } catch {
    return 'not configured';
  }
}

async function cmdGit(input: string): Promise<string> {
  const sub = input.replace(/^\/git\s*/i, '').trim();

  if (!sub || sub === 'status') {
    const result = await run('git status --short 2>&1');
    const output = result.output.trim() || 'Working tree clean';
    return `\`\`\`\n${output}\n\`\`\``;
  }

  if (sub.startsWith('commit ')) {
    const msgMatch = sub.match(/commit\s+["'](.+?)["']/);
    if (!msgMatch) return 'Usage: /git commit "message"';
    const msg = msgMatch[1];
    const result = await run(
      `git add -A && git commit -m "${msg.replace(/"/g, '\\"')}" 2>&1`,
    );
    return result.exitCode === 0
      ? `✅ Committed: ${msg}`
      : `❌ Commit failed:\n\`\`\`\n${result.output.slice(-500)}\n\`\`\``;
  }

  if (sub === 'log') {
    const result = await run('git log --oneline -10 2>&1');
    return `\`\`\`\n${result.output.trim()}\n\`\`\``;
  }

  if (sub === 'diff') {
    const result = await run('git diff --stat 2>&1');
    const output = result.output.trim() || 'No changes';
    return `\`\`\`\n${output}\n\`\`\``;
  }

  return `Unknown git subcommand. Available: status, commit "msg", log, diff`;
}

function cmdPlan(): string {
  for (const p of PLAN_PATHS) {
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, 'utf-8');
      // Extract just the priority list
      const match = content.match(
        /## Priority Order\s*\n([\s\S]*?)(?=\n---|\n## )/,
      );
      if (match) return match[1].trim();
      return content.slice(0, 2000);
    }
  }
  return 'No development plan found.';
}

function cmdPlanAction(input: string): string {
  const sub = input.replace(/^\/plan\s+/i, '').trim();

  if (sub.startsWith('done ')) {
    const feature = sub.replace(/^done\s+/i, '').trim();
    for (const p of PLAN_PATHS) {
      if (!fs.existsSync(p)) continue;
      let content = fs.readFileSync(p, 'utf-8');
      // Find a line in the priority list that contains the feature text and mark it done
      const lines = content.split('\n');
      let found = false;
      for (let i = 0; i < lines.length; i++) {
        if (
          lines[i].match(/^\d+\./) &&
          !lines[i].includes('✅') &&
          lines[i].toLowerCase().includes(feature.toLowerCase())
        ) {
          lines[i] = lines[i].replace(/\*\*(.+?)\*\*/, '✅ **$1**');
          found = true;
          break;
        }
      }
      if (found) {
        fs.writeFileSync(p, lines.join('\n'));
        return `✅ Marked "${feature}" as done.`;
      }
      return `Could not find pending feature matching "${feature}".`;
    }
    return 'No development plan found.';
  }

  return 'Usage: /plan (show plan) or /plan done <feature>';
}

function cmdTodo(): string {
  for (const p of PLAN_PATHS) {
    if (!fs.existsSync(p)) continue;
    const content = fs.readFileSync(p, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      if (line.match(/^\d+\./) && !line.includes('✅')) {
        return `Next: ${line.trim()}`;
      }
    }
    return 'All items done! 🎉';
  }
  return 'No development plan found.';
}

const MODEL_OVERRIDE_PATH = path.join(
  PROJECT_ROOT,
  'data',
  'model-override.txt',
);
const FEATURE_BRANCH = 'feat/phone-dev';

function cmdModel(input: string): string {
  const sub = input
    .replace(/^\/model\s*/i, '')
    .trim()
    .toLowerCase();

  if (!sub) {
    // Show current setting
    let override = '';
    try {
      override = fs.readFileSync(MODEL_OVERRIDE_PATH, 'utf-8').trim();
    } catch {
      /* no override */
    }
    return override
      ? `Model override: *${override}*\nAuto-routing is disabled. Use \`/model auto\` to re-enable.`
      : `Model routing: *auto*\n(haiku for short messages, sonnet for complex ones)`;
  }

  const aliasMap: Record<string, string> = {
    haiku: 'claude-haiku-4-5',
    sonnet: 'claude-sonnet-4-6',
    opus: 'claude-opus-4-6',
  };

  if (sub === 'auto') {
    try {
      fs.unlinkSync(MODEL_OVERRIDE_PATH);
    } catch {
      /* ignore */
    }
    return '✅ Model routing set to *auto* (haiku/sonnet based on complexity)';
  }

  const modelId = aliasMap[sub];
  if (!modelId) {
    return `Invalid model. Options: auto, haiku, sonnet, opus`;
  }

  fs.mkdirSync(path.dirname(MODEL_OVERRIDE_PATH), { recursive: true });
  fs.writeFileSync(MODEL_OVERRIDE_PATH, modelId);
  return `✅ Model override set to *${sub}* (${modelId}). Use \`/model auto\` to re-enable routing.`;
}

async function cmdBranch(): Promise<string> {
  const current = await run('git branch --show-current 2>&1');
  const status = await run('git status --short 2>&1');
  const branch = current.output.trim();
  const changes = status.output.trim() || 'Clean';
  return `Branch: *${branch}*\n\`\`\`\n${changes}\n\`\`\``;
}

async function cmdReview(): Promise<string> {
  // Check if feature branch exists
  const branchCheck = await run(
    `git rev-parse --verify ${FEATURE_BRANCH} 2>&1`,
  );
  if (branchCheck.exitCode !== 0) {
    return `No feature branch \`${FEATURE_BRANCH}\` found. The bot creates it automatically when making changes.`;
  }

  const diff = await run(`git diff main..${FEATURE_BRANCH} --stat 2>&1`);
  const diffOutput = diff.output.trim();
  if (!diffOutput) {
    return `Branch \`${FEATURE_BRANCH}\` has no changes vs main.`;
  }

  // Also get a compact diff for context
  const patch = await run(`git diff main..${FEATURE_BRANCH} 2>&1`, 30000);
  const patchTrimmed = patch.output.trim();

  // Telegram has a 4096 char limit — show stat summary + truncated patch
  let result = `*Review: ${FEATURE_BRANCH} vs main*\n\n\`\`\`\n${diffOutput}\n\`\`\``;
  if (patchTrimmed.length > 0) {
    const maxPatch = 3000 - result.length;
    if (maxPatch > 100) {
      const truncated = patchTrimmed.slice(0, maxPatch);
      result += `\n\n\`\`\`diff\n${truncated}${patchTrimmed.length > maxPatch ? '\n... (truncated)' : ''}\n\`\`\``;
    }
  }
  return result;
}

async function cmdMerge(): Promise<string> {
  // Check if feature branch exists
  const branchCheck = await run(
    `git rev-parse --verify ${FEATURE_BRANCH} 2>&1`,
  );
  if (branchCheck.exitCode !== 0) {
    return `No feature branch \`${FEATURE_BRANCH}\` found.`;
  }

  // Check for changes
  const diff = await run(`git diff main..${FEATURE_BRANCH} --stat 2>&1`);
  if (!diff.output.trim()) {
    return `Branch \`${FEATURE_BRANCH}\` has no changes to merge.`;
  }

  // Ensure we're on main
  const checkout = await run('git checkout main 2>&1');
  if (checkout.exitCode !== 0) {
    return `Failed to switch to main:\n\`\`\`\n${checkout.output.slice(-500)}\n\`\`\``;
  }

  // Merge
  const merge = await run(`git merge ${FEATURE_BRANCH} --no-edit 2>&1`);
  if (merge.exitCode !== 0) {
    await run('git merge --abort 2>&1');
    return `❌ Merge failed (aborted):\n\`\`\`\n${merge.output.slice(-500)}\n\`\`\``;
  }

  // Delete the feature branch
  await run(`git branch -d ${FEATURE_BRANCH} 2>&1`);

  // Rebuild
  const build = await run('npm run build 2>&1', 30000);
  if (build.exitCode !== 0) {
    return `✅ Merged to main, but build failed:\n\`\`\`\n${build.output.slice(-500)}\n\`\`\``;
  }

  return `✅ Merged \`${FEATURE_BRANCH}\` → main and rebuilt successfully.`;
}

async function cmdFade(input: string): Promise<string> {
  const args = input.replace(/^\/fade\s*/i, '').trim();

  if (!args || args === 'status') {
    return getFadeStatus();
  }

  if (args.toLowerCase() === 'cancel') {
    return cancelFade();
  }

  // Parse key:value params: room:Name duration:15 time:07:00
  const params: Record<string, string> = {};
  for (const token of args.split(/\s+/)) {
    const idx = token.indexOf(':');
    if (idx > 0) {
      params[token.slice(0, idx).toLowerCase()] = token.slice(idx + 1);
    }
  }

  const room = params.room;
  if (!room) {
    return [
      'Usage:',
      '  `/fade room:Olohuone duration:15` — start immediately',
      '  `/fade room:Olohuone duration:15 time:07:00` — schedule for 07:00',
      '  `/fade cancel` — cancel scheduled/active fade',
      '  `/fade status` — show current fade state',
    ].join('\n');
  }

  const duration = parseInt(params.duration || '15', 10);
  if (isNaN(duration) || duration <= 0 || duration > 120) {
    return 'Invalid duration. Use 1–120 minutes.';
  }

  return await scheduleFade(room, duration, params.time);
}

// --- Helpers ---

interface RunResult {
  output: string;
  exitCode: number;
}

function run(command: string, timeout = 15000): Promise<RunResult> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd: PROJECT_ROOT, timeout, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        resolve({
          output,
          exitCode: err?.code ?? (err ? 1 : 0),
        });
      },
    );
  });
}
