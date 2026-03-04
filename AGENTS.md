# AGENTS.md

Project-level guidance for AI coding agents working in this repository.

## Project Overview

This repository contains OpenCode plugins that fix common issues with LLM providers.
The primary plugin is the **Gemini Thought Signature Fix** which prevents unrecoverable
`thought_signature` errors with Gemini 3.x models.

## Directory Map

- `src/index.ts` — canonical plugin implementation (global fetch interceptor)
- `src/index.test.ts` — unit tests (bun:test)
- `dist/index.js` — built ESM bundle (committed, used by shim downloads)
- `shim/gemini-thought-signature-fix.ts` — standalone shim for `~/.opencode/plugins/`;
  auto-downloads and caches the built plugin from GitHub
- `.opencode/plugins.disabled/gemini-thought-signature-fix.ts` — re-exports from `src/`
  for local dev, kept disabled because the global shim is used
- `docs/` — research documentation and design decisions
  - `research-gemini-thought-signatures.md` — detailed analysis of the problem
  - `solution-design.md` — evaluated approaches and chosen solution
  - `v0.3.0-plan.md` — implementation plan and tracking for v0.3.0
- `references/` — third-party OpenCode plugins and source code for analysis
  (research input, not first-party code)

## Plugin Architecture (v0.3.0)

The fix intercepts at the **global fetch level** by replacing `globalThis.fetch` at
plugin load time.

### Why global fetch, not auth hooks (v0.2.0 was broken)

v0.2.0 used `auth.loader` hooks returning `{ fetch: patchedFetch }` for both `google`
and `google-vertex`. This worked for `google` but **failed for `google-vertex`** because
OpenCode's `Provider.getSDK()` explicitly deletes `options.fetch` for the native Vertex
AI SDK:

```typescript
if (providerID === "google-vertex" && !model.api.npm.includes("@ai-sdk/openai-compatible")) {
  delete options.fetch
}
```

After deletion, the AI SDK falls through to `globalThis.fetch`. By patching
`globalThis.fetch`, we intercept requests regardless of whether OpenCode strips
`options.fetch`.

### Single plugin export

The plugin exports a single `GeminiThoughtSignatureFix` function. When OpenCode calls
it at load time, it:
1. Captures the current `globalThis.fetch` as `originalFetch`
2. Replaces `globalThis.fetch` with a wrapper that:
   - Checks the URL against Gemini `generateContent`/`streamGenerateContent` endpoints
   - For matching requests: parses the JSON body, runs `fixThoughtSignatures()`, re-serializes
   - For all other requests: passes through to `originalFetch` untouched
3. Returns empty hooks `{}` — all work is done at the fetch level

### Safety guarantees

- **URL-filtered**: Only `generativelanguage.googleapis.com` and
  `aiplatform.googleapis.com` + `generateContent`/`streamGenerateContent` are intercepted
- **GoogleAuth unaffected**: Vertex AI auth uses gaxios/node-fetch internally, not
  `globalThis.fetch`
- **MCP unaffected**: MCP transport URLs don't match the Gemini filter
- **Chain-safe**: Captures `originalFetch` at install time — if another plugin also
  patches fetch, both chains work
- **Idempotent**: Sentinel property `__thought_sig_patched` prevents double-install

### Why not message-level hooks

`experimental.chat.messages.transform` fires BEFORE `toModelMessages()` which has a
`differentModel` check that strips `callProviderMetadata` (including `thoughtSignature`)
for cross-model messages. Since the primary failure case is Claude/GPT tool calls
replayed to Gemini, the metadata would be stripped regardless.

`chat.params` does not expose the messages array at all — its output shape is
`{ temperature, topP, topK, options }`.

## Distribution

### For end users (shim)

Copy `shim/gemini-thought-signature-fix.ts` to `~/.opencode/plugins/`. It will:
1. Download `dist/index.js` from GitHub on first run
2. Cache at `~/.cache/opencode-quick-fixes/index.js`
3. Re-check for updates every 24 hours (using ETag for efficiency)
4. Fall back to cached version on network failure

### For this project

`.opencode/plugins.disabled/gemini-thought-signature-fix.ts` re-exports from
`src/index.ts` directly for local development and remains disabled to avoid
duplicate loading while the global shim is active.

## References Directory Rule

The `references` directory contains third-party OpenCode plugins for analysis.

Do not modify third-party reference internals unless explicitly requested.

When extracting patterns, translate them into project-specific architecture
rather than copy-pasting implementation.

## Key Design Decisions

- **Global fetch over auth hooks**: The `auth.loader` custom fetch approach is broken
  for `google-vertex` because OpenCode deletes `options.fetch`. The global fetch
  interceptor is the only interception point that survives this deletion.
- **Single plugin export**: No need for separate `google`/`google-vertex` exports since
  the global fetch interceptor covers both providers unconditionally.
- **Sentinel over disabling thinking**: We use `"skip_thought_signature_validator"`
  rather than turning off `includeThoughts`. This preserves reasoning output with only
  minor degradation in multi-step chain-of-thought continuity.
- **Preserve existing valid signatures**: The plugin only injects the sentinel when
  signatures are missing or too short (< 50 chars). Valid signatures are left untouched.
- **Parallel tool call handling**: First `functionCall` per content block gets the
  sentinel; subsequent parallel calls have their signatures removed entirely (the Gemini
  API rejects parallel calls that carry a signature).
- **GitHub-based distribution**: The shim downloads from GitHub raw because the primary
  forgejo instance requires auth for all API access.

## Build & Test

```bash
bun run test      # run unit tests
bun run typecheck # typecheck
bun run build     # build dist/index.js
```
