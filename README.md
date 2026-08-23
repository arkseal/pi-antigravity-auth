# pi-antigravity-auth

Google Antigravity OAuth provider for [pi](https://pi.dev) — authenticate against **Antigravity** (Google's IDE backend, a.k.a. Cloud Code Assist) so you can use your Google account's Antigravity quota to run models like `claude-opus-4-6-thinking`, `gemini-3.1-pro` and the Gemini 3.x Flash family.

This is a port of [`opencode-antigravity-auth-updated`](https://github.com/insign/opencode-antigravity-auth-updated) to pi's extension/provider system.

> [!CAUTION]
> Using this plugin violates Google's Terms of Service. Users have reported accounts being banned or shadow-banned.
> By using it you acknowledge this is unofficial, not endorsed by Google, and that you assume all risks.

## What You Get

- **Claude Opus 4.6 (thinking), Sonnet 4.6** and **Gemini 3.x Pro/Flash** via Google OAuth
- **Multi-account support** — add multiple Google accounts; automatic rotation when rate-limited (429-aware, honors server-provided reset delays)
- **Thinking models** — maps pi's thinking levels (`minimal`…`max`) to each model's native thinking config
- **Thought-signature safety** — replays Gemini/Claude thought signatures across turns; falls back to the officially supported `skip_thought_signature_validator` sentinel when signatures are missing
- **Tool calling** — full function-calling support with Antigravity-compatible name sanitization (round-trips back to real tool names)
- **Images** — image inputs in user messages and tool results

## Installation

```bash
# From a local path
pi install /path/to/pi-antigravity-auth

# Or try it without installing
pi -e /path/to/pi-antigravity-auth
```

Then:

1. Run `pi` and execute `/login antigravity`
2. Complete Google sign-in in your browser
3. Pick a model: `/model antigravity/claude-opus-4-6-thinking`

Or non-interactively:

```bash
pi --model antigravity/gemini-3.1-pro:high -p "Hello!"
```

## Models

| Model ID | Thinking levels | Notes |
|----------|----------------|-------|
| `antigravity/claude-opus-4-6-thinking` | minimal → max | Claude Opus 4.6 with extended thinking |
| `antigravity/claude-sonnet-4-6` | — | Claude Sonnet 4.6 |
| `antigravity/gemini-3.1-pro` | low, high | Maps to `gemini-3.1-pro-low` / `gemini-pro-agent` |
| `antigravity/gemini-3-flash` | minimal → high | |
| `antigravity/gemini-3.5-flash` | low, high | Maps to `gemini-3.5-flash-low` / `gemini-3-flash-agent` |
| `antigravity/gemini-3.6-flash` | minimal → high | Distinct backend ids per tier |
| `antigravity/gemini-3.7-flash` | low → high | Backend: `gemini-3.7-flash-tiered` |
| `antigravity/gemini-2.5-flash` | minimal → high | Numeric thinking budgets |

Append a level with `:` to force it: `--model antigravity/gemini-3.1-pro:high`.

## Multi-Account Setup

Each additional Google account raises your combined quota. The plugin rotates accounts automatically when one is rate-limited (it parses the `RetryInfo` delay Google returns and skips blocked accounts until their quota resets).

Add accounts either by:
- Running `/login antigravity` again and choosing **"Add another account"**, or
- Answering "yes" in the prompt at the end of any login

Accounts are stored in `~/.pi/agent/antigravity-accounts.json`; your primary credential lives in pi's own `~/.pi/agent/auth.json`. Delete both files and re-login for a full reset.

## Files

| File | Purpose |
|------|---------|
| `~/.pi/agent/auth.json` | Primary OAuth credential (managed by pi `/login`) |
| `~/.pi/agent/antigravity-accounts.json` | Extra accounts for rotation |

Set `PI_CODING_AGENT_DIR` to relocate both.

## Troubleshooting

**OAuth callback issues**
The login flow listens on `http://localhost:51121/oauth-callback`. If that port is taken, kill the process using it (`lsof -i :51121`). On Safari, disable "HTTPS-Only Mode" or use another browser. In SSH/containers where localhost isn't reachable, the plugin falls back to manual URL pasting.

**403 Permission Denied (`rising-fact-p41fc`)**
The plugin falls back to a default project id when none can be resolved. For workspace accounts, create/select a Google Cloud project with the *Gemini for Google Cloud API* enabled, then set the project id manually in `antigravity-accounts.json`:

```json
{ "accounts": [{ "email": "you@example.com", "refreshToken": "...", "projectId": "your-project-id" }] }
```

**All accounts rate-limited**
Wait for the reset window reported in the error, or add more accounts.

**"Not authenticated"**
Run `/login antigravity` inside pi first.

## Differences from the OpenCode plugin

This port deliberately implements the core value — OAuth auth, request transformation, streaming, multi-account rotation — using pi's native provider APIs instead of intercepting HTTP traffic:

- No request interception or fetch patching; registers a proper custom provider via `pi.registerProvider()` with a custom `streamSimple`
- Login integrates with pi's `/login` UI rather than a custom CLI menu
- pi natively preserves thought signatures between turns, which eliminates most of the original's signature-repair machinery
- Not ported: legacy Gemini CLI quota path, Gemini API-key routing (`agy_sdk`) — use pi's built-in `google` provider with `GEMINI_API_KEY` alongside if you need those — session recovery hooks, Google Search grounding tool, quota-check CLI, auto-updater

## Credits

- [opencode-antigravity-auth-updated](https://github.com/insign/opencode-antigravity-auth-updated) by [@insign](https://github.com/insign), based on work by [@noefabris](https://github.com/noefabris)
- [opencode-gemini-auth](https://github.com/jenslys/opencode-gemini-auth) by [@jenslys](https://github.com/jenslys)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)

## License

MIT
