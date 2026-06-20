---
name: telegram
description: Telegram messaging extension — send, read, search, and manage messages via Telegram Bot API.
---

# Telegram Messaging Extension

## Setup

1. **Create a bot** via [@BotFather](https://t.me/BotFather) on Telegram
2. **Get your bot token** (e.g., `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)
3. **Set the token** in your environment:
   ```bash
   export TELEGRAM_BOT_TOKEN="your-token-here"
   ```
   Or configure in `~/.pi/agent/settings.json`:
   ```json
   {
     "telegram": {
       "token": "your-token-here"
     }
   }
   ```
4. **Reload pi** with `/reload`

## Available Tools (callable by the LLM)

| Tool | Description |
|------|-------------|
| `telegram_send` | Send a text message to a chat |
| `telegram_read` | Read recent messages the bot has received |
| `telegram_list_chats` | List all chats the bot has access to |
| `telegram_search` | Search for messages matching a keyword |
| `telegram_reply` | Reply to a specific message by ID |
| `telegram_contacts` | Manage contact name aliases |
| `telegram_send_photo` | Send a photo file to a chat |
| `telegram_forward` | Forward a message between chats |

## Available Commands

| Command | Description |
|---------|-------------|
| `/telegram send <chat> <message>` | Send a message |
| `/telegram read [chat] [count]` | Read recent messages |
| `/telegram list` | List all chats |
| `/telegram search <keyword>` | Search messages |
| `/telegram reply <chat> <id> <text>` | Reply to a message |
| `/telegram contacts [add\|remove\|list]` | Manage contacts |
| `/telegram poll [start\|stop]` | Start/stop message polling |

## How It Works

- **Sending**: The bot sends messages via the Telegram Bot API `sendMessage` method
- **Reading**: The bot reads messages via long-polling (`getUpdates`) — it can only see messages sent to it
- **Polling**: Run `/telegram poll` to start continuous message listening; incoming messages appear as notifications and are injected into the session
- **Contacts**: Save friendly names for chat IDs with `/telegram contacts add alice @alice_chat`

## Usage Examples

```
# Send a message
telegram_send(chat="@mygroup", message="Hello from pi!")

# Read recent messages
telegram_read(count=10)

# Search for a keyword
telegram_search(keyword="urgent", chat="@mygroup")

# Reply to a message
telegram_reply(chat="@mygroup", message_id=42, reply_text="Got it!")

# Save a contact
telegram_contacts(action="add work @work_group")

# Send a photo
telegram_send_photo(chat="@mygroup", photo_path="/path/to/image.png", caption="Check this out")
```

## Notes

- The bot can only read messages it receives (via `getUpdates`), not arbitrary chat history
- For groups/channels, the bot must be a member (and admin for some operations)
- Contact names are persistent across sessions (stored in settings)
- Polling uses long-polling (HTTP keep-alive) for efficient message delivery
