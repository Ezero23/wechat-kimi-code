# WeChat Kimi Code Bridge

<p align="center">
  <strong>Chat with Kimi Code in WeChat, just like texting a friend</strong>
</p>

<p align="center">
  <a href="https://github.com/Ezero23/wechat-kimi-code/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License: MIT"></a>
  <a href="README.md"><img src="https://img.shields.io/badge/Lang-中文-lightgrey?style=flat-square" alt="中文"></a>
</p>

Scan a QR code to bind your WeChat, and a new "friend" appears in your contacts. Send it a message — it gets forwarded to Kimi Code running on your computer, and the reply streams back to WeChat in real time. Supports text, images, voice, and files.

---

## Highlights

| | |
|---|---|
| **Scan and go** | No account signup, no server deployment. Scan a QR code and you're done in a minute. All data stays on your machine. |
| **Clean messages** | Only key info gets pushed — progress, results, key decisions. Tool calls and intermediate noise are batched automatically. |
| **"Typing..." indicator** | WeChat shows a typing indicator while Kimi is working, so you always know it's on it. |
| **Consistent experience** | Mobile and desktop Kimi Code behave identically — same orchestration, same output. Not two disconnected AIs. |
| **Two-way files** | Send images, Word docs, PDFs for Kimi to analyze. Generated files get pushed directly to WeChat — no need to go back to your computer. |
| **Timeout reassurance** | Task taking a while? You'll get automatic progress messages letting you know it's still working. |

## Smart Router

Built-in zero-dependency, zero-training local routing engine (~5ms decision) that automatically picks the right model for each message — no manual switching needed:

| Mode | Behavior | Best for |
|------|----------|----------|
| **Intelligence** | Always use the strongest model | Complex architecture, critical code review |
| **Balance** (default) | Rule + semantic matching, upgrade on demand | Daily development, quality and cost balanced |
| **Cost** | Strong model only on very strong signals (images/long context) | Budget-sensitive, high volume of simple queries |

Three core mechanisms:

- **Cache-Aware Routing** — On borderline signals, stays on the previous turn's model to maximize prompt cache hit rate
- **Dynamic Upgrade** — Tracks conversation complexity trend; auto-upgrades to strong model when consecutive messages show increasing complexity above threshold
- **Sticky + Auto-Downgrade** — Locks to strong model after upgrade; drops back to fast model after 3 consecutive casual messages

Configuration (`~/.wechat-kimi-code/routing.json`):

```json
{
  "mode": "balance",
  "cacheAware": true,
  "sticky": true,
  "models": { "fast": "your-provider/fast", "strong": "your-provider/strong" }
}
```

---

## Install

```bash
git clone https://github.com/Ezero23/wechat-kimi-code.git
cd wechat-kimi-code && npm install
```

## Quick Start

### 1. Bind WeChat

```bash
npm run setup
```

A QR code will pop up — scan it with WeChat.

### 2. Start the service

```bash
npm run daemon -- start
```

On macOS, this registers a launchd agent for auto-start on boot and auto-restart on crash.

### 3. Start chatting

Open WeChat and send a message to your new "friend".

### Manage the service

```bash
npm run daemon -- status   # Check if running
npm run daemon -- stop     # Stop the service
npm run daemon -- restart  # Restart (after code updates)
npm run daemon -- logs     # View recent logs
```

---

## WeChat Commands

Send these directly in the WeChat chat:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear current session, start fresh |
| `/stop` | Stop current task |
| `/model <name>` | Switch model |
| `/prompt <text>` | Set a system prompt (e.g. "reply in Chinese") |
| `/cwd <path>` | Switch working directory |
| `/status` | View current session state |
| `/history [n]` | View recent chat history |
| `/compact` | Compact context, start a new session |
| `/reset` | Full reset including working directory |
| `/undo [n]` | Remove last N messages from history |

---

## How It Works

```
WeChat (phone) ←→ iLink Bot API ←→ Node.js daemon ←→ Kimi CLI (local)
```

The daemon long-polls WeChat for new messages, forwards them to the local `kimi` CLI, and streams replies back to WeChat. Everything runs on your own machine.

---

## Prerequisites

- Node.js >= 18
- macOS or Linux
- A personal WeChat account
- [Kimi Code](https://www.kimi.com/) CLI installed and authenticated

## Data Directory

All data is stored in `~/.wechat-kimi-code/`:

```
~/.wechat-kimi-code/
├── accounts/       # WeChat account credentials
├── config.json     # Global config
├── routing.json    # Routing config
├── sessions/       # Session data
└── logs/           # Rotating logs (daily, 30-day retention)
```

## License

[MIT](LICENSE)
