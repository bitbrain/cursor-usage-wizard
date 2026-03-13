# Cursor Usage Wizard

A Cursor extension that monitors usage per conversation with status bar display, per-conversation limits, and light-weight cost estimation.

## Features

- **Status bar**: Total premium requests and optional cost display
- **Per-conversation tracking**: Event counts and estimated cost via Cursor hooks
- **Per-conversation limits**: Set cost or event limits; prompts are blocked when exceeded
- **Agent + Tab**: Tracks both Agent (Cmd+K) and Tab (inline) usage

## Installation

1. Install from the extension marketplace (Open VSX / Cursor)
2. Or: `code --install-extension cursor-usage-wizard-0.1.0.vsix`

On first activation, the extension installs hooks into `~/.cursor/hooks.json` and copies scripts to `~/.cursor/usage-wizard/`.

**Authentication:** Run **Cursor Usage Wizard: Set Session Token** and paste your `WorkosCursorSessionToken` cookie from [cursor.com](https://cursor.com) (DevTools → Application → Cookies). The token is stored securely in VS Code's secret storage.

## Commands

- **Cursor Usage Wizard: Set Session Token** – Paste session cookie to enable usage fetching
- **Cursor Usage Wizard: Clear Session Token** – Remove stored token
- **Cursor Usage Wizard: Show Usage** – Refresh and show usage
- **Cursor Usage Wizard: Show Conversations** – List conversations with usage, set limits
- **Cursor Usage Wizard: Set Conversation Limit** – Set limit for a conversation
- **Cursor Usage Wizard: Refresh Stats** – Manual refresh

## Configuration

- `cursorUsageWizard.refreshInterval` – Refresh interval in seconds (default: 30)
- `cursorUsageWizard.showPerConversationInStatusBar` – Show conversation count in status bar
- `cursorUsageWizard.usageStorePath` – Override `~/.cursor/usage-wizard/` path
- `cursorUsageWizard.planOverride` – Plan tier if API doesn't expose it: `auto` | `free` | `pro` | `pro_plus` | `ultra`

## Troubleshooting

**"Unable to fetch"** – Open **View → Output**, choose **Cursor Usage Wizard**. The log shows each request (URL, status, content-type, body length and preview), so you can see whether the dashboard returns 200, a redirect, or HTML and why parsing might fail.

## How It Works

1. **Extension** uses your session token (from the Set Session Token command) to fetch usage from Cursor's API.
2. **Hooks** (installed to `~/.cursor/hooks.json`) append events to `~/.cursor/usage-wizard/usage.jsonl`.
3. **Cost estimation** uses a simple model lookup table (no token parsing).
4. **Limits** are stored in `~/.cursor/usage-wizard/limits.json` and enforced by the `beforeSubmitPrompt` hook.

## License

MIT
