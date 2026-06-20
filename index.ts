/**
 * Telegram Messaging Extension for pi
 *
 * Provides tools to send, read, and manage Telegram messages
 * via the Telegram Bot API (long-polling mode).
 *
 * ## Setup
 * 1. Create a bot via @BotFather on Telegram
 * 2. Get your bot token (e.g., `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)
 * 3. Set `TELEGRAM_BOT_TOKEN` environment variable
 *    or configure in `~/.pi/agent/settings.json` under `telegram.token`
 * 4. (Optional) Set `TELEGRAM_CHAT_ID` env var for a default target chat.
 *    When set, tools like `telegram_send` can omit the `chat` parameter.
 *
 * ## Tools
 * * `telegram_send` — Send a text message to a chat
 * * `telegram_read` — Read recent messages the bot has received
 * * `telegram_list_chats` — List all chats the bot has access to
 * * `telegram_search` — Search for messages matching a keyword in chats the bot can see
 * * `telegram_reply` — Reply to a specific message by message ID
 * * `telegram_contacts` — Manage contact name aliases for chat IDs
 * * `telegram_send_photo` — Send a photo to a chat
 * * `telegram_forward` — Forward a message from one chat to another
 *
 * ## Commands
 * * `/telegram send <chat> <message>` — Send a message
 * * `/telegram read [chat] [count]` — Read recent bot messages
 * * `/telegram list` — List all chats
 * * `/telegram search <keyword>` — Search messages across chats
 * * `/telegram contacts [add|remove|list]` — Manage contacts
 * * `/telegram poll [start|stop]` — Start/stop message polling
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// ─── Types ────────────────────────────────────────────────────────────

interface TelegramConfig {
  token: string;
  baseUrl: string;
}

interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string; title?: string; username?: string };
  date: number;
  text?: string;
  caption?: string;
  from?: { id: number; is_bot?: boolean; username?: string; first_name?: string };
  reply_to_message?: { message_id: number; text?: string };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  callback_query?: { message_id?: number; data?: string; from?: { username?: string } };
}

interface TelegramSendResult {
  ok: boolean;
  result?: { message_id: number; chat: { id: number } };
  description?: string;
}

interface GetUpdatesEntry {
  message?: { chat: { id: number; type: string; title?: string; username?: string } };
  channel_post?: { chat: { id: number; type: string; title?: string; username?: string } };
}

interface GetUpdatesResult {
  ok: boolean;
  result: Array<GetUpdatesEntry>;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function getConfig(ctx: ExtensionContext): TelegramConfig {
  const token =
    process.env.TELEGRAM_BOT_TOKEN ||
    (ctx as any).settings?.telegram?.token ||
    "";

  if (!token) {
    throw new Error(
      "Telegram bot token not found. Set TELEGRAM_BOT_TOKEN env var or configure in settings.json."
    );
  }

  return {
    token,
    baseUrl: "https://api.telegram.org",
  };
}

function getDefaultChatId(): number | null {
  const raw = process.env.TELEGRAM_CHAT_ID;
  if (!raw) return null;
  const num = parseInt(raw, 10);
  return isNaN(num) ? null : num;
}

async function tgApi(
  config: TelegramConfig,
  method: string,
  body: Record<string, unknown> = {}
): Promise<unknown> {
  const url = `${config.baseUrl}/bot${config.token}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram API error (${response.status}): ${text}`);
  }

  return response.json();
}

async function tgGet(
  config: TelegramConfig,
  method: string,
  queryParams?: Record<string, string>
): Promise<unknown> {
  const url = `${config.baseUrl}/bot${config.token}/${method}`;
  const sep = queryParams ? "?" : "";
  const qs = new URLSearchParams(queryParams).toString();
  const fullUrl = `${url}${sep}${qs}`;

  const response = await fetch(fullUrl, { method: "GET" });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Telegram API error (${response.status}): ${text}`);
  }
  return response.json();
}

// ── resolveChatId: resolve a chat string to {id, name} using cached chats ──

function resolveChatId(
  chatInput: string,
  chats: TelegramChat[]
): { id: number; name: string } | null {
  // Direct numeric ID
  const numeric = parseInt(chatInput, 10);
  if (!isNaN(numeric)) {
    const chat = chats.find((c) => c.id === numeric);
    if (chat) return { id: chat.id, name: chat.title || chat.username || `Chat ${chat.id}` };
    return { id: numeric, name: `Chat ${numeric}` };
  }

  // Username (with or without @)
  const username = chatInput.replace(/^@/, "").toLowerCase();
  const chat = chats.find(
    (c) => (c.username?.toLowerCase() === username || c.title?.toLowerCase() === username)
  );
  if (chat) return { id: chat.id, name: chat.title || chat.username! };

  // Partial match on title
  const partial = chats.find(
    (c) =>
      c.title?.toLowerCase().includes(username) ||
      c.username?.toLowerCase().includes(username)
  );
  if (partial) return { id: partial.id, name: partial.title || partial.username! };

  return null;
}

// ── resolveChat: resolve chat param → {id, name}, with env default fallback ──

function resolveChat(
  chatInput: string | undefined,
  defaultChatId: number | null,
  chats: TelegramChat[]
): { id: number; name: string } {
  // 1. Direct numeric ID from env default
  if (!chatInput && defaultChatId !== null) {
    return { id: defaultChatId, name: `Chat ${defaultChatId}` };
  }

  // 2. Use provided input
  if (chatInput) {
    const resolved = resolveChatId(chatInput, chats);
    if (resolved) return resolved;
    // Try as raw numeric if string lookup failed
    const numeric = parseInt(chatInput, 10);
    if (!isNaN(numeric)) return { id: numeric, name: `Chat ${numeric}` };
    throw new Error(`Chat "${chatInput}" not found.`);
  }

  // 3. No input and no default
  throw new Error(
    "Chat not specified and TELEGRAM_CHAT_ID env var is not set. " +
    "Provide a chat ID, @username, or contact name, or set TELEGRAM_CHAT_ID."
  );
}

function formatMessage(msg: TelegramMessage): string {
  const from = msg.from
    ? `${msg.from.first_name || msg.from.username || "Unknown"}${msg.from.is_bot ? " (bot)" : ""}`
    : "Unknown";
  const reply = msg.reply_to_message
    ? `\n↳ Reply to #${msg.reply_to_message.message_id}`
    : "";
  const text = msg.text || msg.caption || "(no text)";
  const date = new Date(msg.date * 1000).toLocaleString();
  return `[${date}] ${from}: ${text}${reply}`;
}

function truncate(str: string, max = 500): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n… (${str.length - max} more chars)`;
}

// ─── Extension ────────────────────────────────────────────────────────

export default function telegramExtension(pi: ExtensionAPI) {
  let lastUpdateId = 0;
  let chatCache: TelegramChat[] | null = null;
  let chatCacheTimestamp = 0;
  const CHAT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // ── Utility: ensure cached chats ──

  async function ensureChatCache(ctx: ExtensionContext): Promise<TelegramChat[]> {
    const now = Date.now();
    if (chatCache && now - chatCacheTimestamp < CHAT_CACHE_TTL) {
      return chatCache;
    }

    const config = getConfig(ctx);

    // Fetch recent updates to discover chats
    try {
      const result = (await tgGet(config, "getUpdates", {
        offset: "0",
        limit: 50,
        timeout: "0",
      })) as GetUpdatesResult;

      const seen = new Map<number, TelegramChat>();
      for (const update of result.result ?? []) {
        const chat = update.message?.chat ?? update.channel_post?.chat;
        if (chat) {
          seen.set(chat.id, {
            id: chat.id,
            type: chat.type as TelegramChat["type"],
            title: chat.title,
            username: chat.username,
          });
        }
      }

      // Also fetch getMe for bot identity
      const me = (await tgGet(config, "getMe")) as { ok: boolean; result: { id: number; username: string } };
      if (me.ok) {
        seen.set(-me.result.id, {
          id: -me.result.id,
          type: "private",
          title: me.result.username,
          username: me.result.username,
        });
      }

      chatCache = [...seen.values()];
      chatCacheTimestamp = now;
      return chatCache;
    } catch {
      if (!chatCache) {
        chatCache = [];
        chatCacheTimestamp = now;
      }
      return chatCache;
    }
  }

  // ── Polling: long-poll for new messages ──

  function makePoller(ctx: ExtensionContext) {
    let running = false;
    let abortCtrl: AbortController | null = null;

    async function pollLoop(): Promise<void> {
      const config = getConfig(ctx);
      while (running) {
        try {
          const result = (await tgGet(config, "getUpdates", {
            offset: String(lastUpdateId + 1),
            limit: "10",
            timeout: String(config.maxPollingTimeout ?? 55),
          })) as { ok: boolean; result: TelegramUpdate[] };

          if (result.ok && result.result.length > 0) {
            for (const update of result.result) {
              lastUpdateId = Math.max(lastUpdateId, update.update_id);

              // Process incoming messages
              const msg = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
              if (msg) {
                const fromUser = msg.from?.username || "Unknown";
                const chatId = msg.chat.id;
                const text = msg.text || msg.caption || "";
                const formatted = formatMessage(msg);

                ctx.ui.notify(
                  `📨 New Telegram message from @${fromUser} in chat ${chatId}: ${truncate(text, 100)}`,
                  "info"
                );

                // Inject into session as user message for the LLM to process
                pi.sendMessage({
                  customType: "telegram-incoming",
                  content: formatted,
                  display: true,
                  details: {
                    chatId,
                    messageId: msg.message_id,
                    from: fromUser,
                  },
                }, {
                  deliverAs: "steer",
                  triggerTurn: true,
                });
              }

              // Process callback queries (inline button presses)
              if (update.callback_query) {
                const cb = update.callback_query;
                ctx.ui.notify(
                  `🔘 Callback from @${cb.from?.username || "unknown"}: ${cb.data || "(no data)"}`,
                  "info"
                );
              }
            }
          }
        } catch (err: unknown) {
          if (running) {
            ctx.ui.notify(`⚠️ Telegram polling error: ${(err as Error).message}`, "warning");
            await new Promise((r) => setTimeout(r, 5000));
          }
        }
      }
    }

    function start() {
      if (running) return;
      running = true;
      abortCtrl = new AbortController();
      pollLoop().catch(() => {});
      ctx.ui.setStatus("telegram", "🟢 Polling active");
      ctx.ui.notify("🟢 Telegram polling started — listening for incoming messages", "info");
    }

    function stop() {
      running = false;
      abortCtrl?.abort();
      abortCtrl = null;
      ctx.ui.setStatus("telegram", "⚪ Polling stopped");
      ctx.ui.notify("⚪ Telegram polling stopped", "info");
    }

    return { start, stop };
  }

  const pollers = new Map<string, ReturnType<typeof makePoller>>();

  function getOrCreatePoller(ctx: ExtensionContext) {
    const key = "default";
    if (!pollers.has(key)) {
      pollers.set(key, makePoller(ctx));
    }
    return pollers.get(key)!;
  }

  // ── Tools ──

  // 1. telegram_send
  pi.registerTool({
    name: "telegram_send",
    label: "Send Telegram",
    description:
      "Send a text message to a Telegram chat. Accepts chat ID (numeric), username (@handle), or contact name. " +
      "The bot must already be a member of the target chat.",
    promptSnippet: "Send messages to Telegram chats by ID, username, or contact name",
    promptGuidelines: [
      "Use telegram_send to send messages to Telegram — specify the chat by numeric ID, @username, or a contact name.",
      "If TELEGRAM_CHAT_ID env var is set, the chat parameter is optional and will default to that value.",
    ],
    parameters: Type.Object({
      chat: Type.Optional(
        Type.String({ description: "Chat ID (e.g. -1001234567890), @username, or contact name. Defaults to TELEGRAM_CHAT_ID env var." })
      ),
      message: Type.String({ description: "Message text to send" }),
      contactName: Type.Optional(
        Type.String({ description: "Optional contact name alias (if previously saved)" })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = getConfig(ctx);
      const chats = await ensureChatCache(ctx);
      const defaultChatId = getDefaultChatId();

      let chatId: number;
      let chatName: string;

      if (params.contactName) {
        const resolved = resolveChatId(params.contactName, chats);
        if (!resolved) throw new Error(`Contact "${params.contactName}" not found. Run /telegram contacts to see available contacts.`);
        chatId = resolved.id;
        chatName = resolved.name;
      } else {
        const resolved = resolveChat(params.chat, defaultChatId, chats);
        chatId = resolved.id;
        chatName = resolved.name;
      }

      const result = (await tgApi(config, "sendMessage", {
        chat_id: chatId,
        text: params.message,
        parse_mode: "Markdown",
      })) as TelegramSendResult;

      if (!result.ok) {
        throw new Error(`Failed to send: ${result.description || "Unknown error"}`);
      }

      const msgId = result.result?.message_id ?? "unknown";
      return {
        content: [
          {
            type: "text",
            text: `✅ Sent message to ${chatName} (chat: ${chatId}, message ID: ${msgId})`,
          },
        ],
        details: { chatId, chatName, messageId: msgId },
      };
    },
  });

  // 2. telegram_read
  pi.registerTool({
    name: "telegram_read",
    label: "Read Telegram",
    description:
      "Read recent messages the bot has received via Telegram. " +
      "Returns the last N messages the bot was sent (default 20).",
    promptSnippet: "Read recent messages the bot has received on Telegram",
    promptGuidelines: [
      "Use telegram_read to check recent messages the bot has received.",
    ],
    parameters: Type.Object({
      chat: Type.Optional(Type.String({ description: "Filter by chat ID, @username, or contact name (optional)" })),
      count: Type.Optional(
        Type.Number({ description: "Number of messages to read (default 20, max 50)" })
      ),
      contactName: Type.Optional(Type.String({ description: "Contact name alias" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = getConfig(ctx);
      const chats = await ensureChatCache(ctx);

      // Resolve filter chat
      let filterChatId: number | null = null;
      if (params.chat || params.contactName) {
        const chatInput = params.contactName || params.chat;
        const resolved = resolveChatId(chatInput!, chats);
        if (resolved) filterChatId = resolved.id;
      }

      // Fetch recent updates (the only way for a bot to read messages)
      const limit = Math.min(params.count ?? 20, 50);
      const result = (await tgGet(config, "getUpdates", {
        offset: String(lastUpdateId - limit),
        limit: String(limit),
        timeout: "0",
      })) as { ok: boolean; result: TelegramUpdate[] };

      if (!result.ok) {
        throw new Error(`Failed to read messages: ${result.description || "Unknown error"}`);
      }

      // Filter by chat if specified
      const messages = (result.result ?? [])
        .map((u) => u.message ?? u.edited_message ?? u.channel_post ?? u.edited_channel_post)
        .filter(Boolean) as TelegramMessage[];

      const filtered = filterChatId
        ? messages.filter((m) => m.chat.id === filterChatId)
        : messages;

      const formatted = filtered.map(formatMessage);
      const chatLabel = filterChatId
        ? chats.find((c) => c.id === filterChatId)?.title || chats.find((c) => c.id === filterChatId)?.username || `chat ${filterChatId}`
        : "all chats";
      const summary = `📬 ${chatLabel} — last ${formatted.length} messages:\n\n${formatted.join("\n---\n")}`;

      return {
        content: [{ type: "text", text: truncate(summary, 5000) }],
        details: { chatFilter: filterChatId, messageCount: formatted.length },
      };
    },
  });

  // 3. telegram_list_chats
  pi.registerTool({
    name: "telegram_list_chats",
    label: "List Telegram Chats",
    description:
      "List all chats the bot has access to (private chats, groups, channels). " +
      "Useful for discovering chat IDs to use with other tools.",
    promptSnippet: "List all Telegram chats the bot can access",
    promptGuidelines: [
      "Use telegram_list_chats to discover available chat IDs before sending messages.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const config = getConfig(ctx);
      const chats = await ensureChatCache(ctx);

      const lines: string[] = [];
      for (const chat of chats) {
        const identifier = chat.username ? `@${chat.username}` : String(chat.id);
        const typeLabel =
          chat.type === "private" ? "👤" : chat.type === "group" ? "👥" : chat.type === "supergroup" ? "👥+" : "📢";
        const title = chat.title ? ` — ${chat.title}` : "";
        lines.push(`${typeLabel} ${identifier}${title} (${chat.type})`);
      }

      const summary = lines.length > 0 ? lines.join("\n") : "No chats found. Add the bot to a chat first.";
      const fullSummary = `📋 Available Telegram chats (${chats.length}):\n\n${summary}`;

      return {
        content: [{ type: "text", text: fullSummary }],
        details: { chatCount: chats.length },
      };
    },
  });

  // 4. telegram_search
  pi.registerTool({
    name: "telegram_search",
    label: "Search Telegram",
    description:
      "Search for messages matching a keyword in recent messages the bot has received. " +
      "Returns up to 20 matching messages.",
    promptSnippet: "Search for messages in Telegram by keyword",
    promptGuidelines: [
      "Use telegram_search to find messages containing a keyword in chats the bot can see.",
    ],
    parameters: Type.Object({
      keyword: Type.String({ description: "Keyword to search for in messages" }),
      chat: Type.Optional(Type.String({ description: "Filter by chat ID, @username, or contact name" })),
      contactName: Type.Optional(Type.String({ description: "Contact name alias" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = getConfig(ctx);
      const chats = await ensureChatCache(ctx);

      // Resolve filter chat
      let filterChatId: number | null = null;
      if (params.chat || params.contactName) {
        const chatInput = params.contactName || params.chat;
        const resolved = resolveChatId(chatInput!, chats);
        if (resolved) filterChatId = resolved.id;
      }

      // Fetch recent updates to search through
      const limit = 50;
      const result = (await tgGet(config, "getUpdates", {
        offset: String(lastUpdateId - limit),
        limit: String(limit),
        timeout: "0",
      })) as { ok: boolean; result: TelegramUpdate[] };

      if (!result.ok) {
        throw new Error(`Failed to search: ${result.description || "Unknown error"}`);
      }

      // Filter by chat if specified
      let messages = (result.result ?? [])
        .map((u) => u.message ?? u.edited_message ?? u.channel_post ?? u.edited_channel_post)
        .filter(Boolean) as TelegramMessage[];

      if (filterChatId) {
        messages = messages.filter((m) => m.chat.id === filterChatId);
      }

      const keyword = params.keyword.toLowerCase();
      const matches = messages
        .filter((m) => (m.text || m.caption || "").toLowerCase().includes(keyword))
        .map((m) => formatMessage(m));

      const chatLabel = filterChatId
        ? chats.find((c) => c.id === filterChatId)?.title || chats.find((c) => c.id === filterChatId)?.username || `chat ${filterChatId}`
        : "all chats";

      const summary = matches.length > 0
        ? `🔍 Found ${matches.length} matches for "${params.keyword}" in ${chatLabel}:\n\n${matches.slice(0, 10).join("\n---\n")}`
        : `🔍 No messages matching "${params.keyword}" found in ${chatLabel}.`;

      return {
        content: [{ type: "text", text: truncate(summary, 5000) }],
        details: { chatFilter: filterChatId, keyword, matchCount: matches.length },
      };
    },
  });

  // 5. telegram_reply
  pi.registerTool({
    name: "telegram_reply",
    label: "Reply Telegram",
    description:
      "Reply to a specific message in a Telegram chat by message ID. " +
      "Useful for continuing a conversation thread.",
    promptSnippet: "Reply to a specific Telegram message by ID",
    promptGuidelines: [
      "Use telegram_reply to respond to a specific message by its message ID in a chat.",
      "If TELEGRAM_CHAT_ID env var is set, the chat parameter is optional and will default to that value.",
    ],
    parameters: Type.Object({
      chat: Type.Optional(
        Type.String({ description: "Chat ID, @username, or contact name. Defaults to TELEGRAM_CHAT_ID env var." })
      ),
      message_id: Type.Number({ description: "Message ID to reply to" }),
      reply_text: Type.String({ description: "Reply text" }),
      contactName: Type.Optional(Type.String({ description: "Contact name alias" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = getConfig(ctx);
      const chats = await ensureChatCache(ctx);
      const defaultChatId = getDefaultChatId();

      let chatId: number;
      let chatName: string;

      if (params.contactName) {
        const resolved = resolveChatId(params.contactName, chats);
        if (!resolved) throw new Error(`Contact "${params.contactName}" not found.`);
        chatId = resolved.id;
        chatName = resolved.name;
      } else {
        const resolved = resolveChat(params.chat, defaultChatId, chats);
        chatId = resolved.id;
        chatName = resolved.name;
      }

      const result = (await tgApi(config, "sendMessage", {
        chat_id: chatId,
        text: params.reply_text,
        reply_to_message_id: params.message_id,
        parse_mode: "Markdown",
      })) as TelegramSendResult;

      if (!result.ok) {
        throw new Error(`Failed to reply: ${result.description || "Unknown error"}`);
      }

      const msgId = result.result?.message_id ?? "unknown";
      return {
        content: [
          {
            type: "text",
            text: `✅ Replied to #${params.message_id} in ${chatName} (new message ID: ${msgId})`,
          },
        ],
        details: { chatId, chatName, repliedTo: params.message_id, messageId: msgId },
      };
    },
  });

  // 6. telegram_contacts
  pi.registerTool({
    name: "telegram_contacts",
    label: "Telegram Contacts",
    description:
      "Save or list contact name aliases for Telegram chats. " +
      "Allows using friendly names (e.g., 'work', 'alice') instead of raw chat IDs.",
    promptSnippet: "Manage contact aliases for Telegram chats",
    promptGuidelines: [
      "Use telegram_contacts to save a contact alias for use with the contactName parameter.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        Type.String({
          description: "Action: 'list' (default), 'add <name> <chat_id>', or 'remove <name>'",
        })
      ),
    }),
    async execute(_toolCallId, params, _signal, ctx) {
      const config = getConfig(ctx);
      const chats = await ensureChatCache(ctx);

      // Read contacts from settings
      const settings = (ctx as any).settings as Record<string, any> | undefined;
      const contacts: Record<string, string> = settings?.telegram?.contacts ?? {};

      if (params.action) {
        const action = params.action.trim();

        if (action.startsWith("add ") || action.startsWith("add\t")) {
          const parts = action.slice(4).split(/\s+/);
          if (parts.length < 2) {
            throw new Error("Usage: telegram_contacts add <name> <chat_id_or_username>");
          }
          const name = parts[0];
          const chatInput = parts.slice(1).join(" ");
          const resolved = resolveChatId(chatInput, chats);
          if (!resolved) throw new Error(`Chat "${chatInput}" not found.`);
          contacts[name] = String(resolved.id);
          (ctx as any).settings = { ...settings, telegram: { ...settings?.telegram, contacts } };
          return {
            content: [{ type: "text", text: `✅ Saved contact "${name}" → chat ${resolved.id}` }],
            details: { name, chatId: resolved.id },
          };
        }

        if (action.startsWith("remove ") || action.startsWith("remove\t")) {
          const name = action.slice(7).trim();
          if (!contacts[name]) throw new Error(`Contact "${name}" not found.`);
          delete contacts[name];
          (ctx as any).settings = { ...settings, telegram: { ...settings?.telegram, contacts } };
          return {
            content: [{ type: "text", text: `✅ Removed contact "${name}"` }],
            details: { name },
          };
        }

        throw new Error(`Unknown action: "${action}". Use 'list', 'add <name> <chat>', or 'remove <name>'`);
      }

      // List contacts
      const lines = Object.entries(contacts).map(
        ([name, chatId]) => `📌 ${name} → chat ${chatId}`
      );
      const summary = lines.length > 0
        ? `📇 Saved contacts (${lines.length}):\n\n${lines.join("\n")}\n\nUse the 'contactName' parameter in telegram_send to use these aliases.`
        : "📇 No saved contacts. Use: telegram_contacts add <name> <chat_id_or_username>";

      return {
        content: [{ type: "text", text: summary }],
        details: { contactCount: Object.keys(contacts).length },
      };
    },
  });

  // 7. telegram_send_photo
  pi.registerTool({
    name: "telegram_send_photo",
    label: "Send Telegram Photo",
    description:
      "Send a photo to a Telegram chat via file upload. " +
      "The bot must already be a member of the target chat.",
    promptSnippet: "Send photos to Telegram chats",
    promptGuidelines: [
      "Use telegram_send_photo to send an image file to a Telegram chat by specifying the file path.",
      "If TELEGRAM_CHAT_ID env var is set, the chat parameter is optional and will default to that value.",
    ],
    parameters: Type.Object({
      chat: Type.Optional(
        Type.String({ description: "Chat ID, @username, or contact name. Defaults to TELEGRAM_CHAT_ID env var." })
      ),
      photo_path: Type.String({ description: "Local file path to the photo (jpg, png, gif, webp)" }),
      caption: Type.Optional(Type.String({ description: "Optional caption text" })),
      contactName: Type.Optional(Type.String({ description: "Contact name alias" })),
    }),
    async execute(_toolCallId, params, _signal, ctx) {
      const config = getConfig(ctx);
      const chats = await ensureChatCache(ctx);
      const defaultChatId = getDefaultChatId();

      if (!existsSync(params.photo_path)) {
        throw new Error(`Photo file not found: ${params.photo_path}`);
      }

      let chatId: number;
      let chatName: string;

      if (params.contactName) {
        const resolved = resolveChatId(params.contactName, chats);
        if (!resolved) throw new Error(`Contact "${params.contactName}" not found.`);
        chatId = resolved.id;
        chatName = resolved.name;
      } else {
        const resolved = resolveChat(params.chat, defaultChatId, chats);
        chatId = resolved.id;
        chatName = resolved.name;
      }

      // Upload via multipart form (Telegram Bot API standard)
      const boundary = `----PiTelegramBoundary${Date.now()}`;
      const fileBuffer = readFileSync(params.photo_path);
      const mimeType = params.photo_path.endsWith(".jpg") || params.photo_path.endsWith(".jpeg")
        ? "image/jpeg"
        : params.photo_path.endsWith(".png")
        ? "image/png"
        : params.photo_path.endsWith(".gif")
        ? "image/gif"
        : "image/webp";

      const body = `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="photo"\r\nContent-Type: ${mimeType}\r\n\r\n`;
      const bodyEnd = `\r\n--${boundary}--\r\n`;

      const url = `${config.baseUrl}/bot${config.token}/sendPhoto`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat([
          Buffer.from(body),
          fileBuffer,
          Buffer.from(bodyEnd),
        ]),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to send photo (${response.status}): ${text}`);
      }

      const result = (await response.json()) as TelegramSendResult;
      if (!result.ok) {
        throw new Error(`Failed to send photo: ${result.description || "Unknown error"}`);
      }

      const msgId = result.result?.message_id ?? "unknown";
      return {
        content: [
          {
            type: "text",
            text: `✅ Sent photo to ${chatName} (chat: ${chatId}, message ID: ${msgId})`,
          },
        ],
        details: { chatId, chatName, messageId: msgId, filePath: params.photo_path },
      };
    },
  });

  // 8. telegram_forward
  pi.registerTool({
    name: "telegram_forward",
    label: "Forward Telegram",
    description:
      "Forward a message from one Telegram chat to another. " +
      "The bot must be a member of both chats.",
    promptSnippet: "Forward Telegram messages between chats",
    promptGuidelines: [
      "Use telegram_forward to forward a message from one chat to another.",
    ],
    parameters: Type.Object({
      from_chat: Type.String({ description: "Source chat ID, @username, or contact name" }),
      message_id: Type.Number({ description: "Message ID to forward" }),
      to_chat: Type.String({ description: "Target chat ID, @username, or contact name" }),
      contactNameFrom: Type.Optional(Type.String({ description: "Source contact name alias" })),
      contactNameTo: Type.Optional(Type.String({ description: "Target contact name alias" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const config = getConfig(ctx);
      const chats = await ensureChatCache(ctx);

      // Resolve source
      const fromInput = params.contactNameFrom || params.from_chat;
      const fromResolved = resolveChatId(fromInput, chats);
      if (!fromResolved) throw new Error(`Source chat "${fromInput}" not found.`);

      // Resolve target
      const toInput = params.contactNameTo || params.to_chat;
      const toResolved = resolveChatId(toInput, chats);
      if (!toResolved) throw new Error(`Target chat "${toInput}" not found.`);

      const result = (await tgApi(config, "forwardMessage", {
        chat_id: toResolved.id,
        from_chat_id: fromResolved.id,
        message_id: params.message_id,
      })) as TelegramSendResult;

      if (!result.ok) {
        throw new Error(`Failed to forward: ${result.description || "Unknown error"}`);
      }

      return {
        content: [
          {
            type: "text",
            text: `✅ Forwarded message #${params.message_id} from ${fromResolved.name} to ${toResolved.name}`,
          },
        ],
        details: { fromChatId: fromResolved.id, toChatId: toResolved.id, messageId: params.message_id },
      };
    },
  });

  // ── Commands ──

  pi.registerCommand("telegram", {
    description: "Telegram messaging — send, read, search, and manage messages",
    handler: async (args, ctx) => {
      if (!args || args.trim() === "") {
        ctx.ui.notify(
          "📱 Telegram commands:\n" +
            "  /telegram send <chat> <message>\n" +
            "  /telegram read [chat] [count]\n" +
            "  /telegram list\n" +
            "  /telegram search <keyword>\n" +
            "  /telegram reply <chat> <message_id> <reply_text>\n" +
            "  /telegram contacts [add|remove|list]\n" +
            "  /telegram poll [start|stop]\n",
          "info"
        );
        return;
      }

      const parts = args.trim().split(/\s+/);
      const cmd = parts[0].toLowerCase();

      switch (cmd) {
        case "send": {
          if (parts.length < 3) {
            ctx.ui.notify("Usage: /telegram send <chat> <message>", "warning");
            return;
          }
          const chat = parts[1];
          const message = parts.slice(2).join(" ");
          try {
            await tgApi(getConfig(ctx), "sendMessage", { chat_id: chat, text: message, parse_mode: "Markdown" });
            ctx.ui.notify(`✅ Sent to ${chat}: ${truncate(message, 100)}`, "info");
          } catch (err: unknown) {
            ctx.ui.notify(`❌ Failed: ${(err as Error).message}`, "error");
          }
          break;
        }

        case "read": {
          try {
            const config = getConfig(ctx);
            const filterChat = parts[1] || null;
            const count = parseInt(parts[2] ?? "10", 10);

            const result = (await tgGet(config, "getUpdates", {
              offset: String(lastUpdateId - Math.min(count, 50)),
              limit: String(Math.min(count, 50)),
              timeout: "0",
            })) as { ok: boolean; result: TelegramUpdate[] };

            if (result.ok) {
              const messages = (result.result ?? [])
                .map((u) => u.message ?? u.edited_message ?? u.channel_post ?? u.edited_channel_post)
                .filter(Boolean) as TelegramMessage[];

              const chats = await ensureChatCache(ctx);
              const filtered = filterChat
                ? messages.filter((m) => {
                    const resolved = resolveChatId(filterChat, chats);
                    return resolved && m.chat.id === resolved.id;
                  })
                : messages;

              const formatted = filtered.map(formatMessage);
              ctx.ui.notify(
                filtered.length > 0
                  ? `📬 ${filterChat || "all chats"} — ${formatted.length} messages:\n\n${formatted.join("\n---\n")}`
                  : `📬 No recent messages${filterChat ? ` in ${filterChat}` : ""}`,
                "info"
              );
            } else {
              ctx.ui.notify(`❌ Failed: ${result.description}`, "error");
            }
          } catch (err: unknown) {
            ctx.ui.notify(`❌ Failed: ${(err as Error).message}`, "error");
          }
          break;
        }

        case "list":
        case "chats": {
          try {
            const chats = await ensureChatCache(ctx);
            const lines = chats.map(
              (c) =>
                `${c.username ? `@${c.username}` : String(c.id)} (${c.type})${c.title ? ` — ${c.title}` : ""}`
            );
            ctx.ui.notify(`📋 ${chats.length} chats:\n${lines.join("\n")}`, "info");
          } catch (err: unknown) {
            ctx.ui.notify(`❌ Failed: ${(err as Error).message}`, "error");
          }
          break;
        }

        case "search": {
          if (parts.length < 2) {
            ctx.ui.notify("Usage: /telegram search <keyword>", "warning");
            return;
          }
          const keyword = parts.slice(1).join(" ");
          try {
            const config = getConfig(ctx);
            const result = (await tgGet(config, "getUpdates", {
              offset: String(lastUpdateId - 50),
              limit: "50",
              timeout: "0",
            })) as { ok: boolean; result: TelegramUpdate[] };

            if (result.ok) {
              const messages = (result.result ?? [])
                .map((u) => u.message ?? u.edited_message ?? u.channel_post ?? u.edited_channel_post)
                .filter(Boolean) as TelegramMessage[];

              const matches = messages
                .filter((m) => (m.text || m.caption || "").toLowerCase().includes(keyword.toLowerCase()))
                .map((m) => formatMessage(m));

              ctx.ui.notify(
                matches.length > 0
                  ? `🔍 ${matches.length} matches for "${keyword}":\n\n${matches.join("\n---\n")}`
                  : `🔍 No matches for "${keyword}"`,
                "info"
              );
            }
          } catch (err: unknown) {
            ctx.ui.notify(`❌ Failed: ${(err as Error).message}`, "error");
          }
          break;
        }

        case "reply": {
          if (parts.length < 4) {
            ctx.ui.notify("Usage: /telegram reply <chat> <message_id> <reply_text>", "warning");
            return;
          }
          const chat = parts[1];
          const messageId = parseInt(parts[2], 10);
          const replyText = parts.slice(3).join(" ");
          try {
            await tgApi(getConfig(ctx), "sendMessage", {
              chat_id: chat,
              text: replyText,
              reply_to_message_id: messageId,
              parse_mode: "Markdown",
            });
            ctx.ui.notify(`✅ Replied to #${messageId} in ${chat}`, "info");
          } catch (err: unknown) {
            ctx.ui.notify(`❌ Failed: ${(err as Error).message}`, "error");
          }
          break;
        }

        case "contacts": {
          const subCmd = parts[1];
          if (subCmd === "add" && parts.length >= 4) {
            const name = parts[2];
            const chatInput = parts.slice(3).join(" ");
            const chats = await ensureChatCache(ctx);
            const resolved = resolveChatId(chatInput, chats);
            if (!resolved) throw new Error(`Chat "${chatInput}" not found.`);
            const settings = (ctx as any).settings as Record<string, any> | undefined;
            const contacts = { ...(settings?.telegram?.contacts ?? {}), [name]: String(resolved.id) };
            (ctx as any).settings = { ...settings, telegram: { ...settings?.telegram, contacts } };
            ctx.ui.notify(`✅ Saved contact "${name}" → chat ${resolved.id}`, "info");
          } else if (subCmd === "remove" && parts.length >= 3) {
            const name = parts[2];
            const settings = (ctx as any).settings as Record<string, any> | undefined;
            const contacts = { ...(settings?.telegram?.contacts ?? {}) };
            if (!contacts[name]) throw new Error(`Contact "${name}" not found.`);
            delete contacts[name];
            (ctx as any).settings = { ...settings, telegram: { ...settings?.telegram, contacts } };
            ctx.ui.notify(`✅ Removed contact "${name}"`, "info");
          } else {
            const settings = (ctx as any).settings as Record<string, any> | undefined;
            const contacts = settings?.telegram?.contacts ?? {};
            const lines = Object.entries(contacts).map(([n, id]) => `📌 ${n} → ${id}`);
            ctx.ui.notify(lines.length > 0 ? `📇 Contacts:\n${lines.join("\n")}` : "📇 No contacts saved", "info");
          }
          break;
        }

        case "poll": {
          const poller = getOrCreatePoller(ctx);
          const subCmd = parts[1];
          if (subCmd === "stop") {
            poller.stop();
          } else {
            poller.start();
          }
          break;
        }

        default:
          ctx.ui.notify(`Unknown command: ${cmd}`, "warning");
          break;
      }
    },
  });

  // ── Lifecycle ──

  pi.on("session_start", async (_event, ctx) => {
    try {
      getConfig(ctx); // Validate token exists
      ctx.ui.setStatus("telegram", "⚪ Ready");
      ctx.ui.notify("📱 Telegram extension loaded. Use /telegram for commands or call telegram_* tools.", "info");
    } catch (err: unknown) {
      ctx.ui.setStatus("telegram", "❌ No token");
      ctx.ui.notify(`❌ Telegram token not configured: ${(err as Error).message}`, "error");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const poller = getOrCreatePoller(ctx);
    poller.stop();
  });
}
