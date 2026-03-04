# Solution Design: Gemini Thought Signature Fix Plugin

> **Update (v0.3.0):** The architecture now uses a global `fetch` interceptor.
> v0.2.0's `auth.loader` custom fetch approach was broken for `google-vertex` because
> OpenCode strips `options.fetch` before creating the native Vertex SDK client.

## Root Cause

Gemini expects `thoughtSignature` on certain replayed `functionCall` parts. In long
multi-model sessions (Claude/GPT tool calls replayed to Gemini), requests can contain
missing or too-short signatures and fail with HTTP 400.

v0.2.0 attempted to patch the request body via auth hook custom fetch:

```typescript
auth.loader -> return { fetch: patchedFetch }
```

But OpenCode's `getSDK()` has this guard for native Vertex models:

```typescript
if (providerID === "google-vertex" && !model.api.npm.includes("@ai-sdk/openai-compatible")) {
  delete options.fetch
}
```

So for `google-vertex`, the plugin fetch was never used.

## Evaluated Surfaces

### 1) `experimental.chat.messages.transform`

- Fires before `toModelMessages()`
- Input is internal `MessageV2.WithParts[]`
- `toModelMessages()` runs later and strips provider metadata for `differentModel`
- Primary failure case is cross-model replay, so this surface cannot guarantee signatures

**Verdict:** Not reliable.

### 2) `chat.params`

- Output shape is `{ temperature, topP, topK, options }`
- No message array is exposed
- Cannot patch per-part `providerOptions.google.thoughtSignature`

**Verdict:** Cannot solve the bug.

### 3) `auth.loader` custom fetch (v0.2.0)

- Works for `google`
- Broken for native `google-vertex` due to `delete options.fetch`

**Verdict:** Incomplete.

### 4) Global `globalThis.fetch` interceptor (chosen)

- Sits below OpenCode provider option mutation
- Survives `delete options.fetch`
- Intercepts final wire payload for both Google AI and Vertex AI

**Verdict:** Only robust interception point.

## Chosen Architecture (v0.3.0)

At plugin load, replace `globalThis.fetch` with a wrapper that:
1. URL-filters to Gemini generateContent endpoints only
2. Parses JSON body
3. Runs `fixThoughtSignatures()`
4. Re-serializes and forwards to captured `originalFetch`

```
OpenCode / AI SDK request
         ↓
globalThis.fetch wrapper
         ↓
URL matches Gemini generateContent?
  ├─ no  -> pass through untouched
  └─ yes -> parse body, patch thought signatures, forward
```

## Integration Points

### APIs and paths

- Intercepted hosts:
  - `generativelanguage.googleapis.com`
  - `aiplatform.googleapis.com`
- Intercepted methods by URL suffix:
  - `generateContent`
  - `streamGenerateContent`

### Core function behavior (`fixThoughtSignatures`)

Per content block:
- First `functionCall`:
  - keep valid signature (`>= 50 chars`)
  - otherwise set sentinel `skip_thought_signature_validator`
- Subsequent (parallel) `functionCall` parts:
  - remove `thoughtSignature` / `thought_signature`

### Plugin export surface

- Single export: `GeminiThoughtSignatureFix`
- `default` export points to the same function
- Returns `{}` hooks; logic runs at load time via interceptor install

## Safety Analysis

- **Bun compatibility:** `globalThis.fetch` is writable/configurable
- **Late binding:** AI SDK resolves fallback fetch from `globalThis.fetch` at call time
- **GoogleAuth unaffected:** Vertex token fetch uses gaxios/node-fetch (not global fetch)
- **MCP unaffected:** URL filter excludes MCP endpoints
- **Other providers unaffected:** non-Gemini URLs pass through untouched
- **Chain-safe:** captures current `originalFetch`; works with other wrappers
- **Idempotent:** sentinel `__thought_sig_patched` prevents double-install

## Verification Strategy

### Unit tests

- URL matcher coverage (Google AI + Vertex + negatives)
- Signature patching coverage (missing, short, valid, parallel, mixed content)
- Interceptor coverage:
  - patches Gemini requests
  - passes through non-Gemini
  - handles non-string bodies
  - handles malformed JSON
  - idempotent install
  - uninstall restores original fetch

### Build/Type checks

- `bun run test`
- `bun run typecheck`
- `bun run build`

### Dist artifact checks

- Dist includes `installFetchInterceptor`
- Dist includes sentinel `__thought_sig_patched`
- Dist no longer contains old auth hook factories

## Trade-offs

- Global interception is broader than provider-local hooks, but URL filtering keeps it narrow
- Small per-request overhead (string checks), JSON parse/stringify only on matching Gemini calls
- Preserves reasoning features (does not disable thinking)

This trade-off is preferred over unrecoverable session failures.
