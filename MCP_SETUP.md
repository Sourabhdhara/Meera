# MEERA MCP Setup Guide

Configuration file:

```text
config/mcp-servers.json
```

MEERA reads MCP servers from the `servers` array. Each server uses:

- `id`: unique identifier
- `name`: name shown in the MCP Hub
- `enabled`: `true` starts it automatically; `false` disables/stops it
- `transport`: normally `stdio` for local `npx`/Node servers
- `command` and `args`: process to start
- `environment`: credentials and runtime settings
- `features`: descriptive UI metadata

After changing the configuration, restart MEERA or refresh the MCP Hub. Gemini receives newly discovered tools when its Live session reconnects.

## 1. WhatsApp

WhatsApp uses a local WhatsApp Web session and QR linking.

```json
{
  "id": "whatsapp",
  "name": "WhatsApp",
  "enabled": true,
  "transport": "stdio",
  "command": "node",
  "args": ["WhatsApp_MCP_New/server.mjs"],
  "workingDirectory": ".",
  "features": ["status", "messages", "contacts", "groups", "files", "locations"]
}
```

Setup:

1. Set `enabled` to `true`.
2. Press Start in the MCP Hub.
3. Scan the QR code with WhatsApp.
4. Wait for `READY`.
5. Use Delink only from the manual UI when changing the WhatsApp account.

Gemini can use WhatsApp functional tools, but Start, Stop, Restart, and Delink are manual-only controls.

## 2. GitHub

```json
{
  "id": "github",
  "name": "GitHub",
  "enabled": true,
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "environment": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "YOUR_NEW_GITHUB_TOKEN"
  },
  "features": ["repositories", "issues", "commits", "pull_requests"]
}
```

Create a least-privilege GitHub token and never commit it to source control.

## 3. YouTube

```json
{
  "id": "youtube",
  "name": "YouTube",
  "enabled": true,
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@kirbah/mcp-youtube"],
  "environment": {
    "YOUTUBE_API_KEY": "YOUR_NEW_YOUTUBE_API_KEY"
  },
  "features": ["video_search", "transcripts", "channel_metadata"]
}
```

Enable YouTube Data API in Google Cloud and create an API key.

## 4. Telegram

```json
{
  "id": "telegram",
  "name": "Telegram",
  "enabled": true,
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "telegram-bot-mcp-server"],
  "environment": {
    "TELEGRAM_BOT_API_TOKEN": "YOUR_NEW_TELEGRAM_BOT_TOKEN"
  },
  "features": ["messages", "channels", "notifications"]
}
```

Setup:

1. Open `@BotFather` in Telegram.
2. Send `/newbot` and create the bot.
3. Put the new token in `TELEGRAM_BOT_API_TOKEN`.
4. Open the new bot and send `/start`.
5. Ask Meera to fetch Telegram updates and return the numeric `chat_id`.
6. Send messages using that `chat_id`, not a phone number.

A Telegram bot cannot start a private conversation with a person who has never messaged the bot.

## 5. Gmail

```json
{
  "id": "gmail",
  "name": "Gmail",
  "enabled": true,
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@mcp-z/mcp-gmail"],
  "environment": {
    "GOOGLE_CLIENT_ID": "YOUR_GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET": "YOUR_GOOGLE_CLIENT_SECRET",
    "TOKEN_STORE_URI": "file:///C:/Users/Sourabh%20Dhara/AppData/Roaming/MEERA/gmail-token-store"
  },
  "features": ["email_search", "unread_messages", "drafting"]
}
```

Setup:

1. In the Google Cloud project, enable Gmail API.
2. Configure the OAuth consent screen.
3. Add your Gmail address as a Test User.
4. Use a Desktop OAuth client ID and secret.
5. Authorize once in the browser.
6. The token is stored in the configured token store.

## 6. Google Drive

```json
{
  "id": "google-drive",
  "name": "Google Drive",
  "enabled": true,
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@mcp-z/mcp-drive"],
  "environment": {
    "GOOGLE_CLIENT_ID": "YOUR_GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET": "YOUR_GOOGLE_CLIENT_SECRET",
    "TOKEN_STORE_URI": "file:///C:/Users/Sourabh%20Dhara/AppData/Roaming/MEERA/drive-token-store"
  },
  "features": ["file_search", "file_read", "file_list", "upload", "download", "folders"]
}
```

Setup:

1. Enable Google Drive API in the same Google Cloud project.
2. Use the same Desktop OAuth client as Gmail if desired.
3. Add your Gmail account as a Test User.
4. Set the Drive entry to `enabled: true`.
5. Restart MEERA and complete Drive OAuth once.

Google Search does not require a Google MCP; MEERA already has native search tools. Google Drive MCP is only for Drive files and folders.

## Security

- Never paste real tokens into chat, source control, screenshots, or documentation.
- Rotate any credential that has already been exposed.
- Use least-privilege scopes and tokens.
- Keep `mcp-servers.json` local and private.
- Set `enabled: false` for a server you are not using.

## Troubleshooting

- `ECONNREFUSED 127.0.0.1:3000`: MEERA backend is still starting or has stopped; wait or restart MEERA.
- `spawn npx ENOENT`/`EINVAL`: restart MEERA after the Windows `npx.cmd` fix is loaded.
- Gmail repeatedly opens login: check Test User/OAuth consent and `TOKEN_STORE_URI`.
- Telegram cannot send to a phone number: obtain the numeric `chat_id` after the user sends `/start`.
- WhatsApp QR/auth problems: use the manual Delink button, then Start and scan a fresh QR.
