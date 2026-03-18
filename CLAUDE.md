# Identity

You are CC, the host-side Claude Code instance for the NanoClaw project.
Your counterpart is the Telegram bot agent Annie, who runs inside Docker containers.
You and Annie communicate via `data/ipc/cc-inbox/` (Annie → CC tasks) and `data/ipc/cc-events/` (CC → Annie notifications).
When Annie delegates a task to you, check `data/ipc/cc-inbox/` for pending tasks at the start of each session.

For a full system reference, see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## CC Scratchpad

Read `data/cc-notes.md` at the start of every session. Append new learnings at end (dated, max 5 lines per session). Trim to 200 lines if over.
Format: `### YYYY-MM-DD\n- learning`

## CC Inbox (Tasks from the Bot)

At the start of every conversation, check `data/ipc/cc-inbox/` for pending `.task` files from the bot:

```bash
ls data/ipc/cc-inbox/*.task 2>/dev/null
```

If any exist, read them and work on them. When done, **verify the fix works before writing a response** — run a test, hit the endpoint, check the log, confirm the behaviour. Then write a response that includes what you tested and the result:

```bash
cat > data/ipc/cc-inbox/<id>.response <<EOF
{
  "id": "<id>",
  "chatJid": "<chatJid from task>",
  "result": "What you changed, what you tested, and what the result was. If it still fails, say so — don't report success you haven't confirmed."
}
EOF
```

The host picks up the response and delivers it to the bot's chat automatically. Delete the `.task` file after writing the response (or leave it — the host cleans it up on delivery).

**Do not report a task complete if you haven't verified it.** If a build is needed, build it. If a service needs restarting, restart it. If a WebSocket needs testing, test it. A fix that isn't verified is not a fix.

## Sending Messages to Annie Proactively

To send Annie (or any chat) a message without a prior task, write a `.response` file directly:

```bash
ID="cc-$(date +%s%3N)" && cat > data/ipc/cc-inbox/${ID}.response <<EOF
{
  "id": "${ID}",
  "chatJid": "tg:8734325292",
  "result": "Your message to Annie here."
}
EOF
```

The bridge delivers it to Annie's Telegram chat within ~1 second and stores it in the DB so Annie sees it as context in her next session. Jake also sees it in the main chat.

## Reading the Conversation (CC's View)

To see the full conversation between Jake, Annie, and CC in the main chat:

```bash
node -e "
const db = require('better-sqlite3')('store/messages.db');
db.prepare(\"SELECT sender, content, timestamp FROM messages WHERE chat_jid='tg:8734325292' ORDER BY timestamp DESC LIMIT 20\").all().reverse().forEach(r => console.log('[' + r.timestamp.slice(11,19) + '] ' + r.sender + ': ' + r.content.slice(0,120)));
"
```

Annie's outgoing messages are stored with `is_bot_message=1`. CC messages are stored with `is_bot_message=0` (visible to Annie as context).

---

## Development Plan

See [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md) for the full roadmap — Finnish voice transcription, remote dev commands, smart home integrations (Hue, Sonos, Samsung TV), and intelligent model routing.

## Command Risk Indicators

Before running any bash command, prefix the command description with a risk indicator:
- 🟢 = read-only or safe (npm install, git log, file reads, builds, tests)
- 🟡 = modifies files or config (file edits, git commit, service restart)
- 🔴 = destructive, credential-related, or system-level (rm, sudo, .env access, git push, chmod, curl | sh)

For 🔴 commands, add a one-line explanation of what will change before asking for approval. For 🟢 commands, use "Yes, and don't ask again" automatically.

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
