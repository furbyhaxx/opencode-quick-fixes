# Solution Design: Gemini Thought Signature Fix Plugin

## Approach Evaluation

### Option A: `experimental.chat.messages.transform` Hook (Message-Level Fix)

**Concept**: Intercept messages before they're converted to model messages. Ensure
reasoning parts have proper `metadata` with thought signatures.

**Pros**:
- Runs early in the pipeline (before `toModelMessages()`)
- Can fix missing metadata on reasoning/tool parts
- Works at the OpenCode internal message level

**Cons**:
- The `experimental.chat.messages.transform` hook receives `MessageV2.WithParts[]` which
  are OpenCode's internal format — the `metadata` field is an opaque blob stored in the DB
- We cannot easily inject a valid `thoughtSignature` into this blob without knowing the
  exact schema `@ai-sdk/google` expects
- The `differentModel` check in `toModelMessages()` runs AFTER this hook, so metadata we
  fix could still be stripped
- **Verdict**: Insufficient — the stripping happens downstream

### Option B: `chat.params` Hook (Provider Options Fix)

**Concept**: Modify provider options to disable thinking, preventing thought signatures
from being needed.

**Pros**:
- Simple one-liner: `output.options.thinkingConfig = { includeThoughts: false }`
- Eliminates the root cause entirely

**Cons**:
- **Disables thinking entirely** — major quality degradation for reasoning tasks
- Gemini 3 models are designed to use thinking; disabling it removes their key advantage
- **Verdict**: Too aggressive — unacceptable quality loss

### Option C: `experimental.chat.messages.transform` + Metadata Injection (Hybrid)

**Concept**: In the messages transform hook, detect Gemini models and ensure all reasoning
parts and tool parts have metadata containing the `skip_thought_signature_validator` sentinel.

**Pros**:
- Uses Google's official validator-skip mechanism
- Preserves thinking/reasoning output
- Minimal quality degradation (model still thinks, just can't restore from checkpoint)
- Works regardless of `differentModel` check — we inject metadata on ALL parts

**Cons**:
- Some reasoning quality degradation in multi-step tool chains
- Relies on undocumented Google sentinel string
- Need to match the exact metadata schema `@ai-sdk/google` expects

**Verdict**: Best balance — chosen approach.

### Option D: Custom Middleware (Not Available via Plugin API)

**Concept**: Inject AI SDK middleware to transform messages at the wire level.

**Cons**: Not exposed through plugin hooks.

---

## Chosen Approach: Option C — Metadata Injection with Validator Skip

### Architecture

```
Plugin Load
  ↓
Detect Gemini model in chat.params (cache model info)
  ↓
experimental.chat.messages.transform fires
  ↓
For each assistant message:
  - For each reasoning part: ensure metadata has google.thoughtSignature
  - For each tool part: ensure metadata has google.thoughtSignature  
  ↓
toModelMessages() runs — metadata is now present
  ↓
@ai-sdk/google serializes thoughtSignature into wire format
  ↓
Gemini API accepts the request
```

### Model Detection

Must work with any Gemini model naming pattern:

```ts
function isGeminiModel(model: { providerID: string; modelID: string } | undefined): boolean {
  if (!model) return false
  const id = `${model.providerID}/${model.modelID}`.toLowerCase()
  return id.includes("gemini")
}
```

This matches:
- `google/gemini-3.1-pro-preview`
- `opencode/gemini-3.1-pro`
- `google-vertex/gemini-3-flash`
- `custom-provider/gemini-3-pro-latest`
- `openrouter/google/gemini-3.1-pro`

### Metadata Schema

The `@ai-sdk/google` package expects `providerMetadata` on reasoning parts to contain:

```ts
{
  google: {
    thought: true,
    thoughtSignature: "<string>"
  }
}
```

And `callProviderMetadata` on tool parts:

```ts
{
  google: {
    thoughtSignature: "<string>"
  }
}
```

### Sentinel Value

We use `"skip_thought_signature_validator"` as documented in OpenCode issue #4832 and
confirmed in Google's Gemini API documentation for cases where signatures cannot be preserved.

### Hook Implementation

The plugin uses `experimental.chat.messages.transform` to walk all messages and inject
the sentinel signature where metadata is missing or incomplete.

Additionally, it uses `chat.params` to detect the current model and store it for the
messages transform hook (which doesn't receive model info directly).

### Edge Cases Handled

1. **Model switching**: Always injects metadata regardless of whether model matches
2. **Missing metadata entirely**: Creates the full metadata structure
3. **Partial metadata**: Preserves existing metadata, only fills in missing signatures
4. **Non-Gemini models**: No-op — skips entirely
5. **Compacted messages**: Still injects metadata even if tool output was cleared
6. **Already valid signatures**: Preserves existing valid signatures (only injects if missing)

---

## Quality Impact Assessment

| Aspect | Impact |
|---|---|
| Thinking/reasoning output | **Preserved** — model still thinks, output visible |
| Tool calling | **Fixed** — no more 400 errors |
| Reasoning continuity | **Minor degradation** — model can't fully restore chain-of-thought across tool calls |
| Simple tasks | **No impact** — most tasks don't depend on thought continuity |
| Complex multi-step chains | **Slight degradation** — model may repeat some reasoning steps |

The trade-off is acceptable: a slight degradation in multi-step reasoning continuity
is vastly preferable to unrecoverable session crashes.
