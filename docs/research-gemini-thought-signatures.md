# Gemini Thought Signature Error: Research & Analysis

## Problem Statement

Gemini 3.x models (3 Pro, 3 Flash, 3.1 Pro, 3.1 Flash) enforce mandatory `thought_signature`
fields on `functionCall` parts in multi-turn conversations. When OpenCode replays conversation
history with tool calls, these signatures can be missing, causing an unrecoverable HTTP 400
error:

```
Unable to submit request because function call `default_api:read` in the 206. content block
is missing a `thought_signature`. Learn more:
https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures
```

This is **unrecoverable within the same session** — the corrupted conversation history persists
and every subsequent request fails with the same error.

---

## What Are Thought Signatures?

Thought signatures are **encrypted, opaque tokens** returned alongside `functionCall` parts
when a thinking-enabled Gemini model generates tool calls. They encapsulate the model's
internal reasoning state, acting as checkpoints that allow the model to resume its chain
of thought after receiving tool results.

### How They Work

1. **Model responds** with `functionCall` + `thoughtSignature` (encrypted string)
2. **Client must echo back** the `thoughtSignature` on the same `functionCall` part in the
   next request's conversation history
3. Model uses the signature to restore its reasoning context before processing the
   `functionResponse`

### Enforcement Timeline

| Model Family | Enforcement | Error on Missing |
|---|---|---|
| Gemini 2.5 Pro/Flash | Optional (warning) | No |
| Gemini 3 Pro/Flash | **Mandatory** | 400 INVALID_ARGUMENT |
| Gemini 3.1 Pro/Flash | **Mandatory** | 400 INVALID_ARGUMENT |
| Gemini 3 Pro Image | Optional | No |

---

## Root Cause Analysis in OpenCode

### How OpenCode Handles Thought Signatures

OpenCode **does not explicitly handle `thought_signature`** anywhere in its codebase
(confirmed by source grep — zero occurrences of the string). Instead, it delegates entirely
to the Vercel AI SDK (`@ai-sdk/google`, `@ai-sdk/openai-compatible`).

**The flow:**
```
Gemini API response
  → @ai-sdk/google decodes thoughtSignature into providerMetadata
  → SessionProcessor stores it as ReasoningPart.metadata or ToolPart.metadata
  → On next turn: message-v2.ts toModelMessages() re-attaches providerMetadata
  → @ai-sdk/google re-encodes thoughtSignature from providerMetadata
  → Gemini API request
```

### Where It Breaks

**1. `differentModel` check strips metadata** (`message-v2.ts:589-611,648,658,669,676`):

```ts
const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`
// ...
...(differentModel ? {} : { providerMetadata: part.metadata })
...(differentModel ? {} : { callProviderMetadata: part.metadata })
```

If you switch between model variants (e.g., `gemini-3.1-pro-preview` vs
`gemini-3.1-pro-latest`), or between `opencode/gemini-3.1-pro` and `google/gemini-3.1-pro`,
the model string doesn't match exactly, and **all providerMetadata (including thought
signatures) is silently dropped**.

**2. Metadata not stored properly**:
In some edge cases, the `providerMetadata` from the AI SDK stream events may not be
properly stored in the database, especially for tool call parts where the
`callProviderMetadata` field is used.

**3. OpenAI-compatible provider path** (issue #8321):
When using Gemini through OpenAI-compatible providers (OpenRouter, Poe, custom), the
`@ai-sdk/openai-compatible` package version pinned by OpenCode predates thought signature
support (added in v2.0.7 via vercel/ai#11745).

**4. Compaction clears tool outputs** but not metadata consistently:
When context is compacted, tool result text is replaced with
`"[Old tool result content cleared]"` but the metadata handling is inconsistent.

---

## Affected Configurations

| Provider Path | Status |
|---|---|
| `google/gemini-3*` (native `@ai-sdk/google`) | Mostly fixed in AI SDK, but `differentModel` check can still break it |
| `opencode/gemini-3*` (OpenCode Zen) | Affected — goes through proxy, model IDs may not match stored history |
| Custom `openai-compatible` to Gemini (OpenRouter, etc.) | Broken — issue #8321 open |
| Model switching within session | Always broken — `differentModel` strips metadata |

---

## Related GitHub Issues

| Issue | Repo | Status | Summary |
|---|---|---|---|
| [#4481](https://github.com/anomalyco/opencode/issues/4481) | opencode | Closed | First report, `default_api:grep` missing thought_signature |
| [#4832](https://github.com/anomalyco/opencode/issues/4832) | opencode | Closed | Detailed root cause with dummy signature workaround |
| [#8321](https://github.com/anomalyco/opencode/issues/8321) | opencode | **Open** | OpenAI-compatible provider needs upgrade |
| [#6244](https://github.com/anomalyco/opencode/issues/6244) | opencode | Open | Gemini 3 via LiteLLM thought_signature handling |
| [#10344](https://github.com/vercel/ai/issues/10344) | vercel/ai | Closed | Original AI SDK issue |
| [#10361](https://github.com/vercel/ai/pull/10361) | vercel/ai | Merged | Fix: preserve thoughtSignature through tool execution |
| [#10734](https://github.com/vercel/ai/pull/10734) | vercel/ai | Merged | Follow-up: edge cases (provider-executed, Zod failure) |
| [#11745](https://github.com/vercel/ai/pull/11745) | vercel/ai | Merged | OpenAI-compat: add thoughtSignature handling |
| [#397](https://github.com/NoeFabris/opencode-antigravity-auth/issues/397) | antigravity-auth | Closed | Antigravity plugin affected |

---

## Google's Documented Workarounds

### Dummy Signature Strings

For cases where thought signatures cannot be preserved, Google provides sentinel strings
that skip validation:

- `"skip_thought_signature_validator"` — documented in issue #4832
- `"context_engineering_is_the_way_to_go"` — alternate sentinel

**Trade-off**: Skipping validation allows the request to succeed, but may degrade reasoning
quality because the model cannot restore its chain-of-thought context.

### Official Documentation

- Gemini API: https://ai.google.dev/gemini-api/docs/thought-signatures
- Vertex AI: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures
- Medium article: https://medium.com/google-cloud/migrating-to-gemini-3-implementing-stateful-reasoning-with-thought-signatures-4f11b625a8c9

---

## Key Source Code References

| File | Line(s) | What |
|---|---|---|
| `packages/opencode/src/session/message-v2.ts` | 589 | `differentModel` check |
| `packages/opencode/src/session/message-v2.ts` | 611,648,658,669,676 | `providerMetadata` / `callProviderMetadata` conditional attach |
| `packages/opencode/src/session/prompt.ts` | 500-503 | Comment about thinking signatures + synthetic user messages |
| `packages/opencode/src/session/prompt.ts` | 648 | `experimental.chat.messages.transform` hook trigger |
| `packages/opencode/src/session/processor.ts` | 75,85,105,147,248,297 | `providerMetadata` storage from stream events |
| `packages/opencode/src/provider/transform.ts` | 724-731 | `thinkingConfig: { includeThoughts: true }` always set for Google |
| `packages/plugin/src/index.ts` | 200-208 | `experimental.chat.messages.transform` hook type definition |
