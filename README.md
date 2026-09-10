# pi-antigravity-auth

Google Antigravity OAuth provider for [pi](https://pi.dev) — authenticate against **Antigravity** (Google's IDE backend, a.k.a. Cloud Code Assist) so you can use your Google account's Antigravity quota to run models like `claude-opus-4-6-thinking`, `gemini-3.8-flash`, `gemini-3.1-pro` and the Gemini 3.x family.

Complete port of [`opencode-antigravity-auth-updated`](https://github.com/insign/opencode-antigravity-auth-updated) to pi's native extension, provider, and tool systems.

> [!CAUTION]
> Using this plugin violates Google's Terms of Service. Users have reported accounts being banned or shadow-banned.
> By using it you acknowledge this is unofficial, not endorsed by Google, and that you assume all risks.

## Features

- **Latest Models** — Claude Opus 4.6 (Thinking), Claude Sonnet 4.6, Gemini 3.8 Flash, Gemini 3.7 Flash, Gemini 3.6 Flash, Gemini 3.5 Flash, Gemini 3.1 Pro, Gemini 3 Flash, Gemini 2.5 Flash, Gemini 3.1 Flash Image.
- **Dynamic Antigravity Version Fetching** — Automatically resolves the latest Antigravity version at startup (via auto-updater API and changelog fallback) to prevent "version no longer supported" errors.
- **Device Fingerprinting** — Randomized per-account device identities (macOS/Windows platform emulation, unique IDs, version tracking) with automatic regeneration on capacity exhaustion.
- **Health Scoring & Token Bucket Rotation** — Advanced hybrid account selection combining wellness scores, token balances, and stickiness per model family (`claude`, `gemini-antigravity`, `gemini-cli`).
- **Storage V4 with File Locking** — Multi-process safe credentials storage using `proper-lockfile`, `0600` permissions, and automatic schema migrations.
- **Proactive Token Refresh Queue** — Background worker refreshes expiring tokens before requests are sent to prevent latency spikes.
- **Real-Time LaTeX to Unicode Math Formatting** — SSE stream chunk buffering (`MathStreamBuffer`) transforms LaTeX equations, arrows, relations, Greek letters, powers, subscripts, fractions, and complexity notations into clean Unicode/ASCII in the terminal.
- **Claude Thinking Block Hardening** — Injects tool parameter hardening (`CLAUDE_TOOL_SYSTEM_INSTRUCTION`), interleaved thinking hints, `VALIDATED` mode in toolConfig, and skips invalid signatures using the officially supported `skip_thought_signature_validator` sentinel.
- **Gemini Schema Cleaning** — Recursive OpenAPI/Gemini schema conversion (uppercase types, array items default, empty object placeholders, required property validation).
- **Google Search Grounding** — Built-in `antigravity_search` tool for web searches with citations and source URL extraction via Gemini grounding.
- **Quota & Rate Limit Inspection** — Check live 5-hour and weekly quotas across accounts via `/quota`, `/antigravity-quota`, or the `antigravity_quota` tool. Includes persistent TUI widget and footer status bar.
- **Interactive Account Management** — Command `/antigravity-accounts` to list, enable/disable, verify, or remove accounts, and `/antigravity-add-account` for OAuth logins.

## Installation

```bash
# Install package into pi
pi install /path/to/pi-antigravity-auth

# Or run directly with extension loaded
pi -e /path/to/pi-antigravity-auth
```

Then:

1. Run `pi` and execute `/login antigravity`
2. Complete Google sign-in in your browser
3. Select a model: `/model antigravity/claude-opus-4-6-thinking`

Or non-interactively:

```bash
pi --model antigravity/gemini-3.8-flash:high -p "Write a quicksort implementation."
```

## Models Catalog

| Model ID | Thinking levels | Backend Routing |
|----------|----------------|-----------------|
| `antigravity/claude-opus-4-6-thinking` | minimal → max | Numeric budget (2048 → 32768) |
| `antigravity/claude-sonnet-4-6` | — | Non-thinking |
| `antigravity/gemini-3.8-flash` | minimal → high | `gemini-3.8-flash-tiered` |
| `antigravity/gemini-3.7-flash` | minimal → high | `gemini-3.7-flash-tiered` |
| `antigravity/gemini-3.6-flash` | minimal → high | `gemini-3.6-flash-low/medium/high` |
| `antigravity/gemini-3.5-flash` | minimal → high | `gemini-3.5-flash-low` / `gemini-3-flash-agent` |
| `antigravity/gemini-3.1-pro` | low, high | `gemini-3.1-pro-low` / `gemini-pro-agent` |
| `antigravity/gemini-3-flash` | minimal → high | `gemini-3-flash` (thinkingLevel) |
| `antigravity/gemini-2.5-flash` | minimal → high | Numeric budget (512 → 24576) |
| `antigravity/gemini-3.1-flash-image` | — | Image generation (aspect ratio) |

Append a level with `:` to force it: `--model antigravity/gemini-3.8-flash:high`.

## Commands & Tools

### Slash Commands

- `/quota` or `/antigravity-quota` — Open detailed quota status in an editor modal.
  - `/quota widget` — Toggle persistent quota widget above the editor.
  - `/quota status` — Toggle compact quota status in the footer.
- `/antigravity-accounts` — Manage configured accounts (toggle enabled/disabled, probe verification, remove accounts, or add new accounts).
- `/antigravity-add-account` — Launch browser OAuth flow to add another account to the pool.

### Custom Tools

- `antigravity_quota` — Check remaining Antigravity model quotas and rate limit cooldowns.
- `antigravity_search` — Perform real-time Google web search and URL grounding via Gemini models.

## Multi-Account Setup

Each additional Google account multiplies your available quota. Accounts are stored in `~/.pi/agent/antigravity-accounts.json`, and the primary account is synced with `~/.pi/agent/auth.json`.

When rate limits or capacity issues occur, the plugin automatically rotates to the healthiest available account with exponential backoff and jitter.

## Files

| File | Purpose |
|------|---------|
| `~/.pi/agent/auth.json` | Primary OAuth credential (managed by pi `/login`) |
| `~/.pi/agent/antigravity-accounts.json` | Account pool (Storage V4 with fingerprints and rate-limit states) |
| `~/.pi/agent/antigravity-logs/` | Debug logs (when `PI_ANTIGRAVITY_DEBUG=1`) |

Set `PI_CODING_AGENT_DIR` to relocate all files.

## Credits

- [opencode-antigravity-auth-updated](https://github.com/insign/opencode-antigravity-auth-updated) by [@insign](https://github.com/insign) & [@noefabris](https://github.com/noefabris)
- [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth) by [@jenslys](https://github.com/jenslys)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)

## License

MIT
