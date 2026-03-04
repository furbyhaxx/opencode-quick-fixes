# AGENTS.md

Project-level guidance for AI coding agents working in this repository.

## Project Overview

This repository contains OpenCode plugins that fix common issues with LLM providers.
The primary plugin is the **Gemini Thought Signature Fix** which prevents unrecoverable
`thought_signature` errors with Gemini 3.x models.

## Directory Map

- `src/index.ts` — canonical plugin implementation (wire-level HTTP fetch interceptor)
- `src/index.test.ts` — unit tests (bun:test)
- `dist/index.js` — built ESM bundle (committed, used by shim downloads)
- `shim/gemini-thought-signature-fix.ts` — standalone shim for `~/.opencode/plugins/`;
  auto-downloads and caches the built plugin from GitHub
- `.opencode/plugins/gemini-thought-signature-fix.ts` — re-exports from `src/` for local dev
- `docs/` — research documentation and design decisions
  - `research-gemini-thought-signatures.md` — detailed analysis of the problem
  - `solution-design.md` — evaluated approaches and chosen solution
- `references/` — third-party OpenCode plugins and source code for analysis
  (research input, not first-party code)

## Plugin Architecture (v0.2.0)

The fix intercepts at the **HTTP wire level** using auth hooks with custom `fetch()`:

1. **`auth` hook (provider: `google`)** — intercepts all HTTP requests to `generativelanguage.googleapis.com`
2. **`auth` hook (provider: `google-vertex`)** — intercepts all HTTP requests to `aiplatform.googleapis.com`

Both hooks use the same `fixThoughtSignatures()` function that patches the raw JSON
request body before it reaches the Gemini API.

### Two plugin exports for two providers

OpenCode allows one `auth.provider` per plugin export. To cover both Google AI and
Vertex AI, the plugin exports two separate `Plugin` functions:
- `GoogleFixPlugin` — targets `google`
- `GoogleVertexFixPlugin` — targets `google-vertex`

These are different function references so OpenCode's deduplication won't collapse them.

### Why wire-level, not message-level

The previous approach (v0.1.0) used `experimental.chat.messages.transform` which had two bugs:
1. The `isGeminiMessage()` guard only patched messages originally from Gemini models,
   missing tool calls from Claude/GPT when switching TO Gemini mid-session.
2. Message-level hooks can't intercept the `differentModel` stripping in `toModelMessages()`.

The wire-level approach patches the final HTTP request body, so it catches ALL
`functionCall` parts regardless of origin model.

## Distribution

### For end users (shim)

Copy `shim/gemini-thought-signature-fix.ts` to `~/.opencode/plugins/`. It will:
1. Download `dist/index.js` from GitHub on first run
2. Cache at `~/.cache/opencode-quick-fixes/index.js`
3. Re-check for updates every 24 hours (using ETag for efficiency)
4. Fall back to cached version on network failure

### For this project

`.opencode/plugins/gemini-thought-signature-fix.ts` re-exports from `src/index.ts`
directly for local development.

## References Directory Rule

The `references` directory contains third-party OpenCode plugins for analysis.

Do not modify third-party reference internals unless explicitly requested.

When extracting patterns, translate them into project-specific architecture
rather than copy-pasting implementation.

## Key Design Decisions

- **Wire-level over message-level**: The `auth.loader` custom `fetch()` approach
  intercepts at the HTTP boundary, guaranteeing all `functionCall` parts are patched
  regardless of which model originally generated them.
- **Dual auth hooks**: Separate exports for `google` and `google-vertex` providers
  because OpenCode only allows one `auth.provider` per plugin export.
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
