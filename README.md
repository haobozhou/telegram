# pi-telegram

**Telegram Messaging Extension for [pi](https://github.com/earendil-works/pi-coding-agent)**

A pi coding-agent extension that enables AI-driven Telegram messaging — send, read, search, reply, and manage messages entirely through natural language.

---

## 📋 Features

| Feature | Description |
|---------|-------------|
| **Send Messages** | Send text and photos to any chat the bot is a member of |
| **Read Messages** | Read recent messages received by the bot |
| **Search Messages** | Search across recent messages by keyword |
| **Reply** | Reply to specific messages by ID |
| **Forward** | Forward messages between chats |
| **Contacts** | Save friendly aliases for chat IDs (e.g. `alice` → `-1001234567890`) |
| **Live Polling** | Start continuous message listening with `/telegram poll` |
| **Commands** | Quick access via `/telegram` commands from the pi CLI |

---

## 🚀 Quick Start

### 1. Install the Extension

Add `pi-telegram` to your pi workspace. The extension is loaded from `index.ts` via the `pi.extensions` config in `package.json`.

### 2. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts
3. **Copy the bot token** (looks like `123456789:ABCdef...`)

### 3. Configure the Token

Set the token in one of two ways:

**Environment variable (recommended):**
```bash
export TELEGRAM_BOT_TOKEN="your-token-here"
```

**Or in `~/.pi/agent/settings.json`:**
```json
{
  "telegram": {
    "token": "your-token-here"
  }
}
```

### 4. (Optional) Set a Default Chat

```bash
export TELEGRAM_CHAT_ID="-1001234567890"
```
When set, tools like `telegram_send` can omit the `chat` parameter.

### 5. Reload pi

```
/reload
```

You should see: `📱 Telegram extension loaded. Use /telegram for commands or call telegram_* tools.`

---

## 🛠️ Available Tools

These tools are callable by the LLM agent during conversations:

| Tool | Purpose |
|------|---------|
| `telegram_send` | Send a text message to a chat |
| `telegram_read` | Read recent messages the bot has received |
| `telegram_list_chats` | List all chats the bot has access to |
| `telegram_search` | Search messages by keyword |
| `telegram_reply` | Reply to a specific message by ID |
| `telegram_contacts` | Manage contact name aliases |
| `telegram_send_photo` | Send a photo file to a chat |
| `telegram_forward` | Forward a message from one chat to another |

### Usage Examples

```typescript
// Send a message
telegram_send(chat="@mygroup", message="Hello from pi!")

// Read recent messages
telegram_read(count=10)

// List all chats
telegram_list_chats()

// Search for a keyword
telegram_search(keyword="urgent", chat="@mygroup")

// Reply to a message
telegram_reply(chat="@mygroup", message_id=42, reply_text="Got it!")

// Save a contact alias
telegram_contacts(action="add work @work_group")

// Send a photo
telegram_send_photo(chat="@mygroup", photo_path="/path/to/image.png", caption="Check this out")

// Forward a message
telegram_forward(from_chat="@from_chat", message_id=10, to_chat="@to_chat")
```

---

## 💬 Commands

Access these directly from the pi CLI with `/telegram`:

| Command | Description |
|---------|-------------|
| `/telegram send <chat> <message>` | Send a message |
| `/telegram read [chat] [count]` | Read recent messages |
| `/telegram list` | List all chats |
| `/telegram search <keyword>` | Search messages |
| `/telegram reply <chat> <id> <text>` | Reply to a message |
| `/telegram contacts add <name> <chat>` | Save a contact alias |
| `/telegram contacts remove <name>` | Remove a contact alias |
| `/telegram contacts list` | List saved contacts |
| `/telegram poll start` | Start live message polling |
| `/telegram poll stop` | Stop live message polling |

---

## 📖 How It Works

### Sending Messages
The bot uses the Telegram Bot API [`sendMessage`](https://core.telegram.org/bots/api#sendmessage) method. Messages are sent with Markdown parse mode for formatting support.

### Reading Messages
The bot reads messages via long-polling using the [`getUpdates`](https://core.telegram.org/bots/api#getupdates) endpoint. **Important**: the bot can only see messages sent **to it** (or in groups/channels where it's a member), not arbitrary chat history.

### Live Polling
Run `/telegram poll` to start continuous message listening. Incoming messages:
1. Appear as notifications in the pi UI
2. Are injected into the active session as steer messages for the LLM to process

Polling uses HTTP long-polling (timeout ~55s) for efficient, low-latency delivery.

### Contacts
Save friendly names for chat IDs with `/telegram contacts add alice @alice_chat`. These aliases are stored in `settings.json` and persist across sessions. Use the `contactName` parameter in tools to reference them.

---

## 📁 Project Structure

```
telegram/
├── index.ts          # Main extension source (8 tools + commands + polling)
├── package.json      # Package manifest with pi extension config
├── SKILL.md          # pi skill definition for agent context
└── README.md         # This file
```

### `index.ts` Architecture

The extension is a single-file pi extension that:

1. **Config Loading** — Reads the bot token from `TELEGRAM_BOT_TOKEN` env var or `settings.json`
2. **Chat Cache** — Caches discovered chats for 5 minutes to avoid repeated API calls
3. **Tool Registration** — Registers 8 tools via `pi.registerTool()`
4. **Command Registration** — Registers `/telegram` subcommands via `pi.registerCommand()`
5. **Lifecycle Hooks** — Validates token on session start, stops polling on shutdown
6. **Polling Loop** — A long-polling background loop that detects incoming messages and injects them into the session

---

## ⚙️ Configuration Reference

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | No | Default target chat ID |

### Settings JSON (`~/.pi/agent/settings.json`)

```json
{
  "telegram": {
    "token": "your-token-here",
    "contacts": {
      "alice": "-123456789",
      "work": "-987654321"
    }
  }
}
```

---

## 🔒 Security Notes

- **Never commit your bot token** — always use environment variables or settings files
- The bot token grants full control over your bot — treat it like a password
- The extension stores contact aliases in `settings.json` (plain text) — not secrets
- All API calls use HTTPS to `api.telegram.org`

---

## 🤝 Contributing

1. Fork this repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit changes: `git commit -am 'Add my feature'`
4. Push to the branch: `git push origin feature/my-feature`
5. Open a Pull Request

---

## 📄 License

This project is open source under the terms of the [MIT License](LICENSE).

---

## 🔗 Related

- [Telegram Bot API Documentation](https://core.telegram.org/bots/api)
- [pi Coding Agent](https://github.com/earendil-works/pi-coding-agent)
