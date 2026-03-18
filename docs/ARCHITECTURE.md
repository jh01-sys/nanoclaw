# NanoClaw Architecture

Reference document for CC (Claude Code, host) and Annie (Telegram bot, container agent).
Both agents should read this when they need to understand the system.

---

## 1. System Overview

NanoClaw is Jake's personal AI assistant system running on a WSL2 Linux host (Windows machine on home LAN). It is a single Node.js process that connects messaging channels to AI agents running in isolated Docker containers.

### The Two Agents

| Agent | Identity | Where it runs | What it does |
|-------|----------|---------------|--------------|
| **Annie** | Telegram bot (`@Annie_botti_bot`) | Docker container, spawned per-session | Personal assistant — answers questions, controls smart home, schedules tasks, delegates complex work to CC |
| **CC** | Claude Code (this process) | Host (WSL2), invoked by Jake directly | Developer agent — implements features, debugs, builds, has full codebase and tooling access |

### How It Works

1. Jake sends a message on Telegram → NanoClaw host receives it
2. Host spawns a Docker container running the Claude Agent SDK (Annie)
3. Annie processes the message with access to her workspace and tools
4. Annie's response is sent back to Telegram
5. For complex implementation tasks, Annie writes a task to `data/ipc/cc-inbox/` and tells Jake — CC picks it up at the next session

### Key Constraint

**No direct Anthropic API.** Annie and CC both use Jake's Max subscription OAuth token, routed through the host credential proxy. Containers never see real credentials.

---

## 2. Communication Channels

```
Jake (Telegram phone)
  │
  ├── Main chat (tg:8734325292)
  │     Annie ←→ Jake: personal assistant conversations
  │
  └── NanoClaw Dev group (tg:-5138786292)
        CC → Jake: tool use events (🟡 logged, 🔴 confirmation required)
        Jake → CC: YES/NO approval replies

Annie ←→ CC (file-based IPC, no direct socket):
  Annie → CC:  data/ipc/cc-inbox/<id>.task       (task delegation)
  CC → Annie:  data/ipc/cc-inbox/<id>.response   (task result, auto-delivered to Telegram)
  CC → Dev:    data/ipc/cc-events/<id>.json       (tool use stream)
  CC ← Dev:    data/ipc/cc-confirm/<id>.response  (YES/NO from Jake)
```

### Annie → CC (Task Delegation)

Annie writes a JSON task file. The host (`cc-bridge.ts`) watches for response files and delivers CC's reply to the main chat automatically.

**Task file format** (`data/ipc/cc-inbox/<timestamp>.task`):
```json
{
  "id": "1711234567890",
  "ts": "2026-03-17T13:00:00Z",
  "chatJid": "tg:8734325292",
  "title": "Short description",
  "body": "Detailed description with file paths, error messages, expected behaviour."
}
```

**Response file format** (`data/ipc/cc-inbox/<id>.response`):
```json
{
  "id": "1711234567890",
  "chatJid": "tg:8734325292",
  "result": "What was done and the outcome. Concise, no markdown headings."
}
```

Annie writes `.task`, CC writes `.response`. Host delivers and cleans up both.

### CC → Annie (via NanoClaw Dev group)

The CC bridge (`src/cc-bridge.ts`) forwards Claude Code PreToolUse events to the Dev Telegram group:
- 🟡 Modifying actions: batched and forwarded as observation (`⚙️ CC 🟡 Edit src/...`)
- 🔴 Dangerous actions: forwarded as a block requiring YES/NO reply (5-min timeout)

---

## 3. Security Model

### Container Isolation

Annie runs in an ephemeral Docker container with only the mounts she needs:

| Mount | Container path | Access | Scope |
|-------|---------------|--------|-------|
| Group folder | `/workspace/group` | Read-write | Annie's own memory and files |
| Project root | `/workspace/project` | Read-write (main group only) | For git branch isolation and task file writing |
| `.env` | shadowed by `/dev/null` | — | Credentials never exposed to container |
| Claude sessions | `/home/node/.claude` | Read-write | Per-group, isolated |
| Group IPC | `/workspace/ipc` | Read-write | Per-group, isolated namespace |

Containers run as the host user UID (not root), are ephemeral (`--rm`), and have no network access beyond what the credential proxy and MCP servers provide.

### Sender Allowlist

`~/.config/nanoclaw/sender-allowlist.json` restricts the main chat to Jake's Telegram ID (`8734325292`) only. No other sender can trigger Annie or execute dev commands. This is a hard prerequisite before any capability expansion.

### Risk Flagging (🟢 / 🟡 / 🔴)

A `PreToolUse` hook in the container agent classifies every tool call before it executes:

| Level | Examples | Behaviour |
|-------|----------|-----------|
| 🟢 Green | Read, Glob, Grep, Ollama queries | Silent, always allowed |
| 🟡 Yellow | Edit, Write, git commit, npm install | Logged, forwarded to Dev group, allowed |
| 🔴 Red | rm -rf, git push, .env access, sudo, kill, git checkout main | **Blocked.** Telegram confirmation required. 5-min timeout — no reply = cancelled. |

The classifier lives in `container/agent-runner/src/risk-classifier.ts` (39 unit tests).

### Hard Rules (never compromised)

- No credentials outside `.env` — not in code, CLAUDE.md, logs, or git
- No read-write mounts before risk flagging + sender allowlist are in place
- No external API without explicitly accepting the privacy tradeoff
- Every new filesystem mount must be documented in `DEVELOPMENT_PLAN.md`
- Local API always preferred over cloud (Hue local REST > SmartThings cloud)
- No personal data, conversation history, or credentials ever logged in plaintext

---

## 4. Current Capabilities

| # | Feature | Status |
|---|---------|--------|
| 1 | Finnish voice transcription (whisper.cpp medium, `WHISPER_LANG=fi`) | ✅ |
| 2 | Risk flagging system (🟢/🟡/🔴 PreToolUse hook, 5-min gate) | ✅ |
| 3 | Sender allowlist (Jake's Telegram ID only) | ✅ |
| 4 | Dev commands (`/restart`, `/build`, `/logs`, `/status`, `/git`, `/plan`, `/model`, `/review`, `/merge`, `/branch`) | ✅ |
| 5 | Model routing (auto Haiku/Sonnet/Ollama by complexity, `/model` override) | ✅ |
| 6 | Git branch isolation (`feat/phone-dev`, `/review`, `/merge`) | ✅ |
| 7 | CC → Telegram bridge (stream tool events to Dev group, block 🔴 for YES/NO) | ✅ |
| 8 | Philips Hue (local REST API v2, MCP server, 4 tools) | 🔧 in progress |
| — | Annie ↔ CC task bridge (cc-inbox IPC) | ✅ |
| — | Startup notification ("✅ NanoClaw back online" on restart) | ✅ |

### Model Routing Table

| Condition | Model |
|-----------|-------|
| Code tasks, debugging, multi-step reasoning | `claude-sonnet-4-6` |
| Short chat ≤ 80 chars | `claude-haiku-4-5` |
| Simple factual, translate, summarize | `qwen3:8b` (Ollama, local, free) |
| `/model` override | User-specified |

---

## 5. Pending Features (Priority Order)

| Priority | Feature | Notes |
|----------|---------|-------|
| 9 | Philips Hue | Local REST API v2 MCP server — in progress |
| 10 | Sonos | node-sonos-http-api, local only |
| 11 | Samsung TV | Local WebSocket preferred over SmartThings |
| 12 | qwen2.5-coder:7b | Second local model, route code tasks to it |
| 13 | CC as executor | Annie specifies, CC implements (bridge already built) |

**Someday/maybe:** Gmail/Calendar, agent swarm (each sub-agent gets own Telegram bot identity), local LLM as worker.

Full details with security notes for each feature: `DEVELOPMENT_PLAN.md`.

---

## 6. Key File Locations

### For CC (host paths)

| Path | Purpose |
|------|---------|
| `src/index.ts` | Main orchestrator: message loop, agent invocation, channel routing |
| `src/cc-bridge.ts` | CC bridge: forwards tool events to Dev group, delivers inbox responses |
| `src/container-runner.ts` | Spawns Docker containers, builds mount configs, injects env vars |
| `src/dev-commands.ts` | `/restart`, `/build`, `/logs` etc. — intercepted before agent routing |
| `src/model-router.ts` | Classifies prompts and selects model |
| `src/channels/` | Channel implementations (Telegram, etc.) |
| `src/config.ts` | All config constants — `ASSISTANT_NAME`, paths, timeouts |
| `container/agent-runner/src/index.ts` | Agent runner inside container — SDK wiring, MCP servers, risk hook |
| `container/agent-runner/src/risk-classifier.ts` | Pure risk classification function (🟢/🟡/🔴) |
| `container/agent-runner/src/hue-mcp-stdio.ts` | Philips Hue MCP server |
| `container/agent-runner/src/ollama-mcp-stdio.ts` | Ollama MCP server |
| `store/messages.db` | SQLite — messages, registered groups, sessions, tasks |
| `data/ipc/cc-inbox/` | Annie → CC task files; CC → host response files |
| `data/ipc/cc-events/` | CC tool use events → Dev Telegram group |
| `data/ipc/cc-confirm/` | 🔴 confirmation requests/responses |
| `data/ipc/<group>/` | Per-group IPC: model, chat_jid, confirm/, input/, tasks/ |
| `groups/<folder>/CLAUDE.md` | Per-group agent instructions and memory |
| `groups/global/CLAUDE.md` | Global facts shared across all groups |
| `~/.config/nanoclaw/sender-allowlist.json` | Sender allowlist (outside project, never mounted) |
| `~/.claude/hooks/nanoclaw-bridge.js` | CC PreToolUse hook — writes cc-events and cc-confirm files |
| `~/.claude/settings.json` | CC hook registration |
| `.env` | All secrets and config — never committed, never mounted into containers |
| `DEVELOPMENT_PLAN.md` | Full roadmap with security notes for each feature |
| `docs/ARCHITECTURE.md` | This file |

### For Annie (container paths)

| Path | Purpose |
|------|---------|
| `/workspace/group/` | Annie's own workspace — memory, files, logs |
| `/workspace/group/CLAUDE.md` | Annie's identity and instructions |
| `/workspace/group/DEVELOPMENT_PLAN.md` | Roadmap (symlinked or copied here by Annie) |
| `/workspace/project/` | Project root — read-write for main group only |
| `/workspace/project/data/ipc/cc-inbox/` | Write `.task` files here to delegate to CC |
| `/workspace/ipc/` | Annie's per-group IPC directory |
| `/workspace/ipc/chat_jid` | This session's Telegram JID (use when writing cc-inbox tasks) |
| `/workspace/ipc/model` | Selected model for this session |
| `/workspace/ipc/available_groups.json` | All registered Telegram groups |
| `/workspace/ipc/current_tasks.json` | Scheduled tasks visible to this group |
| `/home/node/.claude/` | Claude session state (isolated per group) |

---

## 7. Service Management

```bash
# Status
systemctl --user status nanoclaw
systemctl --user is-active nanoclaw

# Restart (or send /restart from Telegram)
systemctl --user restart nanoclaw

# Logs
journalctl --user -u nanoclaw -f
tail -f logs/nanoclaw.log

# Rebuild container (after changing agent-runner src)
./container/build.sh
# If build cache is stale: docker builder prune -f && ./container/build.sh
```

### WSL2-Specific Notes

- `host.docker.internal` → Windows host, NOT WSL2. Containers needing WSL2 services use the eth0 IP.
- Ollama runs on WSL2; its IP is resolved dynamically from `eth0` in `container-runner.ts`.
- Docker socket ACL: `sudo setfacl -m u:jake:rw /var/run/docker.sock` (needed after reboot).
- Ollama systemd override at `/etc/systemd/system/ollama.service.d/host.conf` sets `OLLAMA_HOST=0.0.0.0`.
