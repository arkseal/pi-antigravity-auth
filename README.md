# pi-antigravity-auth

Google Antigravity OAuth provider for the [pi coding agent harness](https://github.com/earendil-works/pi) — authenticate against **Antigravity** (Google's Cloud Code Assist IDE backend) to use your Google account's free Antigravity quota to run frontier models like `claude-opus-5-5-thinking`, `claude-sonnet-5-5`, `gemini-3.8-flash`, and `gpt-oss-120b`.

Ported and redesigned for pi from the [`arkseal/opencode-antigravity-auth-updated`](https://github.com/arkseal/opencode-antigravity-auth-updated) fork (upstream by [insign](https://github.com/insign/opencode-antigravity-auth-updated)), adapting the provider, token storage, and session hooks to pi's native extension architecture.

> [!CAUTION]
> Using this plugin interacts with Google internal endpoints and may violate Google's Terms of Service.
> By using it you acknowledge this is unofficial, not endorsed by Google, and that you assume all risks.

## Features

- **Updated Frontier Models** — Claude Opus 5.5 (Thinking), Claude Sonnet 5.5, Gemini 3.8 Flash, Gemini 3 Flash, GPT-OSS 120B, and Gemini 3.1 Flash Image.
- **Automatic Legacy Model Routing** — Older references to `claude-opus-4-6-thinking` and `claude-sonnet-4-6` are automatically upgraded and routed to the corresponding Claude 5.5 tiers so saved sessions continue to work seamlessly.
- **Dynamic Antigravity Version Fetching** — Automatically resolves the active Antigravity client version at startup to prevent "version no longer supported" errors.
- **Device Fingerprinting** — Randomized per-account device identities (macOS/Windows platform emulation, unique IDs, version tracking) with automatic regeneration on capacity exhaustion.
- **Health Scoring & Token Bucket Rotation** — Multi-account selection combining health scores, token balances, and stickiness per model family (`claude`, `gemini-antigravity`, `gemini-cli`).
- **Storage V4 with File Locking** — Multi-process safe credentials storage in `~/.pi/agent/antigravity-accounts.json` using `proper-lockfile`, `0600` permissions, and schema migrations.
- **Proactive Token Refresh Queue** — Background worker refreshes expiring tokens before requests are sent to prevent blocking or latency spikes.
- **Real-Time LaTeX to Unicode Math Formatting** — SSE stream chunk buffering (`MathStreamBuffer`) transforms LaTeX equations, arrows, relations, Greek letters, powers, subscripts, fractions, and complexity notations into clean Unicode/ASCII in the terminal.
- **Claude Thinking Block Hardening** — Injects tool parameter hardening (`CLAUDE_TOOL_SYSTEM_INSTRUCTION`), interleaved thinking hints, `VALIDATED` mode in toolConfig, and skips invalid signatures using the officially supported `skip_thought_signature_validator` sentinel.
- **Gemini Schema Cleaning** — Recursive OpenAPI/Gemini schema conversion (uppercase types, array items default, empty object placeholders, required property validation).
- **Google Search Grounding** — Built-in `antigravity_search` tool for web searches with citations and source URL extraction via Gemini grounding.
- **Quota & Rate Limit Inspection** — Check live 5-hour and weekly quotas across accounts via `/quota`, `/antigravity-quota`, or the `antigravity_quota` tool. Native integration with `pi-sidebar-tui`.
- **Interactive Account Management** — Slash command `/antigravity-accounts` to list, enable/disable, verify, or remove accounts, and `/antigravity-add-account` for OAuth logins.

## Installation

```bash
# Install package into pi
pi install /path/to/pi-antigravity-auth

# Or test directly with extension loaded
pi -e /path/to/pi-antigravity-auth
```

### Initial Setup

1. Launch `pi` and run the login command:
   ```text
   /login antigravity
   ```
2. Complete Google sign-in in your browser window.
3. Select an Antigravity model:
   ```text
   /model antigravity/claude-opus-5-5-thinking
   ```

Or run non-interactively from your shell:

```bash
pi --model antigravity/gemini-3.8-flash:high -p "Write a quicksort implementation."
```

## Available Models Catalog

| Model ID | Thinking levels | Backend Routing | Description |
|----------|----------------|-----------------|-------------|
| `antigravity/claude-opus-5-5-thinking` | minimal → high | `claude-opus-5-5-low/medium/high` | Anthropic Claude Opus 5.5 with reasoning |
| `antigravity/claude-sonnet-5-5` | minimal → high | `claude-sonnet-5-5-low/medium/high` | Anthropic Claude Sonnet 5.5 |
| `antigravity/gemini-3.8-flash` | minimal → high | `gemini-3.8-flash-tiered` | Google Gemini 3.8 Flash (tiered thinking) |
| `antigravity/gemini-3-flash` | minimal → high | `gemini-3-flash` | Google Gemini 3 Flash with thinking levels |
| `antigravity/gpt-oss-120b` | — | `gpt-oss-120b-medium` | GPT-OSS 120B model |
| `antigravity/gemini-3.1-flash-image` | — | `gemini-3.1-flash-image` | Multimodal image generation model |

*Note: You can append a thinking tier with `:` in CLI calls: e.g. `--model antigravity/claude-opus-5-5-thinking:high`.*

## Commands & Tools

### Slash Commands

- `/quota` or `/antigravity-quota` — Refresh and inspect Antigravity quotas in the sidebar.
  - `/quota report` — Display full quota breakdown table across accounts in the editor.
  - `/quota status` — Toggle compact quota status in the TUI footer.
- `/antigravity-accounts` — Interactive menu to manage accounts (enable/disable, probe verification, remove accounts, or add accounts).
- `/antigravity-add-account` — Launch browser OAuth flow to add another account to the rotation pool.

### Tools

- `antigravity_quota` — Inspect remaining 5-hour and weekly quotas and local cooldown times across all accounts.
- `antigravity_search` — Perform real-time Google Search grounding with URL citations via Gemini.

## Utility Scripts

The plugin includes standalone diagnostic and audit scripts located in `scripts/`. They dynamically read credentials from `~/.pi/agent/antigravity-accounts.json` (zero secrets are stored in files):

```bash
# Fetch live available models catalog directly from Antigravity endpoints
npm run fetch-models

# Audit all model endpoints to test status (200 OK vs 404/deprecated)
npm run audit-models

# Check live quota breakdown across accounts from CLI
npm run check-quota

# Probe endpoints for experimental models (e.g. Gemini 4 / Argon)
npm run probe-argon

# Probe Gemini-3 thought-signature continuity during tool calls
npx tsx scripts/signature-continuity-probe.ts

# Probe thought-signature portability across GCP projects
npx tsx scripts/ab-signature-scope.ts

# Verify cross-model sanitization (Gemini -> Claude)
npx tsx scripts/test-cross-model.ts
```

## Multi-Account Setup

Each additional Google account multiplies your available quota. Accounts are stored in `~/.pi/agent/antigravity-accounts.json`.

When rate limits (HTTP 429) occur, the plugin automatically rotates requests to the healthiest available account with exponential backoff and jitter.

## Files

| File | Purpose |
|------|---------|
| `~/.pi/agent/auth.json` | Primary OAuth credential (managed by pi `/login`) |
| `~/.pi/agent/antigravity-accounts.json` | Account pool (Storage V4 with device fingerprints and rate-limit states) |
| `~/.pi/agent/antigravity-logs/` | Debug logs (when `PI_ANTIGRAVITY_DEBUG=1`) |

Set `PI_CODING_AGENT_DIR` in your environment to relocate these files if desired.

## Credits & Upstream Reference

- Ported from the [arkseal/opencode-antigravity-auth-updated](https://github.com/arkseal/opencode-antigravity-auth-updated) repository fork by [@arkseal](https://github.com/arkseal) (originally created by [@insign](https://github.com/insign) & [@noefabris](https://github.com/noefabris)).
- Based on earlier Google OAuth reverse engineering work in [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth) and [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).

## License

MIT
