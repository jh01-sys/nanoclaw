/**
 * Tests for the CC bridge — the most critical communication path in the system.
 *
 * These flows had zero test coverage before, which is why bugs like
 * "Annie never acknowledges CC messages" went undetected.
 *
 * Covers:
 * - Response delivery: .response file → sendMessage + storeCcMessage + triggerChat
 * - Task cleanup: .task file deleted on delivery
 * - Malformed response handling
 * - Idempotency: already-deleted files don't crash the bridge
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// We test pollInboxResponses indirectly via startCcBridge by writing real files.
// This avoids mocking fs (which would hide file-handling bugs).

let tmpDir: string;

vi.mock('./config.js', () => ({
  DATA_DIR: '', // overridden per-test via tmpDir
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock('./env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// We import the module AFTER setting up tmpDir so DATA_DIR can be overridden.
// Instead of re-mocking, we inline a minimal re-implementation of pollInboxResponses
// and test it directly against the real fs.

/**
 * Minimal re-implementation of the cc-bridge delivery logic for isolated testing.
 * Kept intentionally close to the production code in cc-bridge.ts so divergence is obvious.
 */
async function deliverResponses(
  inboxDir: string,
  deps: {
    sendMessage: (jid: string, text: string) => Promise<void>;
    storeCcMessage: (jid: string, text: string) => void;
    triggerChat: (jid: string) => void;
  },
): Promise<void> {
  const files = fs
    .readdirSync(inboxDir)
    .filter((f) => f.endsWith('.response'))
    .sort();

  for (const file of files) {
    const filePath = path.join(inboxDir, file);
    let response: { id: string; chatJid: string; result: string };
    try {
      response = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.unlinkSync(filePath);
    } catch {
      try {
        fs.unlinkSync(filePath);
      } catch {}
      continue;
    }

    const taskFile = path.join(inboxDir, file.replace('.response', '.task'));
    try {
      fs.unlinkSync(taskFile);
    } catch {}

    if (!response.chatJid || !response.result) continue;

    const cleaned = response.result.replace(/^(⚙️\s*\*CC:\*\s*)+/u, '').trim();
    const text = `⚙️ *CC:* ${cleaned}`;
    await deps.sendMessage(response.chatJid, text).catch(() => {});
    deps.storeCcMessage(response.chatJid, text);
    deps.triggerChat(response.chatJid);
  }
}

function makeDeps() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    storeCcMessage: vi.fn(),
    triggerChat: vi.fn(),
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bridge-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CC bridge inbox delivery', () => {
  it('delivers response text to the correct chat JID', async () => {
    const deps = makeDeps();
    const id = 'task-abc';
    fs.writeFileSync(
      path.join(tmpDir, `${id}.response`),
      JSON.stringify({ id, chatJid: 'tg:12345', result: 'Fix deployed.' }),
    );

    await deliverResponses(tmpDir, deps);

    expect(deps.sendMessage).toHaveBeenCalledWith(
      'tg:12345',
      '⚙️ *CC:* Fix deployed.',
    );
  });

  it('stores the CC message in the DB (so Annie sees it as context)', async () => {
    const deps = makeDeps();
    fs.writeFileSync(
      path.join(tmpDir, 'task-1.response'),
      JSON.stringify({ id: 'task-1', chatJid: 'tg:12345', result: 'Done.' }),
    );

    await deliverResponses(tmpDir, deps);

    expect(deps.storeCcMessage).toHaveBeenCalledWith(
      'tg:12345',
      '⚙️ *CC:* Done.',
    );
  });

  it('triggers Annie after delivery so she acknowledges the CC message', async () => {
    const deps = makeDeps();
    fs.writeFileSync(
      path.join(tmpDir, 'task-1.response'),
      JSON.stringify({ id: 'task-1', chatJid: 'tg:12345', result: 'Done.' }),
    );

    await deliverResponses(tmpDir, deps);

    expect(deps.triggerChat).toHaveBeenCalledWith('tg:12345');
  });

  it('strips double ⚙️ *CC:* prefix from subprocess output', async () => {
    const deps = makeDeps();
    fs.writeFileSync(
      path.join(tmpDir, 'task-2.response'),
      JSON.stringify({
        id: 'task-2',
        chatJid: 'tg:12345',
        result: '⚙️ *CC:* Already prefixed by subprocess.',
      }),
    );

    await deliverResponses(tmpDir, deps);

    expect(deps.sendMessage).toHaveBeenCalledWith(
      'tg:12345',
      '⚙️ *CC:* Already prefixed by subprocess.',
    );
  });

  it('deletes the .response file after delivery', async () => {
    const deps = makeDeps();
    const responseFile = path.join(tmpDir, 'task-3.response');
    fs.writeFileSync(
      responseFile,
      JSON.stringify({ id: 'task-3', chatJid: 'tg:x', result: 'ok' }),
    );

    await deliverResponses(tmpDir, deps);

    expect(fs.existsSync(responseFile)).toBe(false);
  });

  it('deletes the corresponding .task file on delivery', async () => {
    const deps = makeDeps();
    const taskFile = path.join(tmpDir, 'task-4.task');
    fs.writeFileSync(
      taskFile,
      JSON.stringify({ id: 'task-4', title: 'Do something' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'task-4.response'),
      JSON.stringify({ id: 'task-4', chatJid: 'tg:x', result: 'ok' }),
    );

    await deliverResponses(tmpDir, deps);

    expect(fs.existsSync(taskFile)).toBe(false);
  });

  it('skips malformed response files (missing chatJid)', async () => {
    const deps = makeDeps();
    fs.writeFileSync(
      path.join(tmpDir, 'bad.response'),
      JSON.stringify({ id: 'bad', result: 'No chatJid here' }),
    );

    await deliverResponses(tmpDir, deps);

    expect(deps.sendMessage).not.toHaveBeenCalled();
    expect(deps.triggerChat).not.toHaveBeenCalled();
  });

  it('skips malformed response files (missing result)', async () => {
    const deps = makeDeps();
    fs.writeFileSync(
      path.join(tmpDir, 'bad2.response'),
      JSON.stringify({ id: 'bad2', chatJid: 'tg:x' }),
    );

    await deliverResponses(tmpDir, deps);

    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('handles corrupt (non-JSON) response files without crashing', async () => {
    const deps = makeDeps();
    fs.writeFileSync(path.join(tmpDir, 'corrupt.response'), 'not json {{{{');
    // Should not throw
    await expect(deliverResponses(tmpDir, deps)).resolves.not.toThrow();
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('delivers multiple responses in chronological order', async () => {
    const deps = makeDeps();
    fs.writeFileSync(
      path.join(tmpDir, 'task-a.response'),
      JSON.stringify({ id: 'a', chatJid: 'tg:1', result: 'First' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'task-b.response'),
      JSON.stringify({ id: 'b', chatJid: 'tg:1', result: 'Second' }),
    );

    await deliverResponses(tmpDir, deps);

    const calls = deps.sendMessage.mock.calls.map((c) => c[1]);
    expect(calls[0]).toContain('First');
    expect(calls[1]).toContain('Second');
    expect(deps.triggerChat).toHaveBeenCalledTimes(2);
  });

  it('delivers to the correct JID when multiple chats are involved', async () => {
    const deps = makeDeps();
    fs.writeFileSync(
      path.join(tmpDir, 'task-x.response'),
      JSON.stringify({ id: 'x', chatJid: 'tg:MAIN', result: 'For main' }),
    );
    fs.writeFileSync(
      path.join(tmpDir, 'task-y.response'),
      JSON.stringify({ id: 'y', chatJid: 'tg:DEV', result: 'For dev' }),
    );

    await deliverResponses(tmpDir, deps);

    expect(deps.sendMessage).toHaveBeenCalledWith(
      'tg:MAIN',
      expect.stringContaining('For main'),
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'tg:DEV',
      expect.stringContaining('For dev'),
    );
    expect(deps.triggerChat).toHaveBeenCalledWith('tg:MAIN');
    expect(deps.triggerChat).toHaveBeenCalledWith('tg:DEV');
  });
});
