/**
 * opencode-quick-fixes
 *
 * Patches Gemini API requests to fix the `thought_signature` 400 error.
 *
 * Background:
 *   When Gemini returns a `functionCall` part it attaches a `thoughtSignature`
 *   (or `thought_signature`) field.  On the next turn OpenCode may replay that
 *   content back to the API, but the signature can be missing or too short
 *   (< 50 chars).  The Gemini API then rejects the request with HTTP 400.
 *
 * Bug this fixes (v0.2.0):
 *   The original implementation only intercepted requests to the `google`
 *   provider and only matched `generativelanguage.googleapis.com` URLs.
 *   When using `google-vertex` (Vertex AI), requests go to
 *   `aiplatform.googleapis.com` instead — completely bypassing the fix.
 *   Additionally, when switching TO a Gemini model mid-session, historical
 *   tool-call parts from non-Gemini models (Claude, GPT) lack thought
 *   signatures entirely and were not being patched.
 *
 * Fix:
 *   - Intercepts BOTH `google` and `google-vertex` providers via separate
 *     auth hooks (OpenCode allows one auth.provider per plugin export).
 *   - Matches both `generativelanguage.googleapis.com` (Google AI) and
 *     `aiplatform.googleapis.com` (Vertex AI) endpoints.
 *   - Patches ALL `functionCall` parts regardless of origin model.
 *   - First `functionCall` per content block: inject sentinel if missing.
 *   - Subsequent (parallel) `functionCall` parts: remove signature entirely
 *     (the API rejects parallel calls that carry one).
 */

import type { Plugin } from "@opencode-ai/plugin"

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Sentinel value recognised by the Gemini API's thought-signature validator. */
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator"

/** Signatures shorter than this are treated as absent/invalid. */
export const MIN_SIGNATURE_LENGTH = 50

// ─────────────────────────────────────────────────────────────────────────────
// URL helpers
// ─────────────────────────────────────────────────────────────────────────────

export function toUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  return (input as Request).url
}

/**
 * Returns true when the request targets a Gemini generateContent endpoint.
 *
 * Matches:
 *   - Google AI:  generativelanguage.googleapis.com/…/generateContent
 *   - Vertex AI:  aiplatform.googleapis.com/…/streamGenerateContent
 */
export function isGeminiGenerateContentRequest(
  input: RequestInfo | URL,
): boolean {
  const url = toUrlString(input)

  // Must be a Google API endpoint
  const isGoogleApi =
    url.includes("generativelanguage.googleapis.com") ||
    url.includes("aiplatform.googleapis.com")

  if (!isGoogleApi) return false

  // Must be a generateContent call
  return (
    url.includes("generateContent") || url.includes("streamGenerateContent")
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Core fix: mutates the request body in-place
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk every content block's parts array and fix `functionCall` signatures.
 *
 * Rules (per content block):
 *   1. First `functionCall` encountered:
 *      - If `thoughtSignature` / `thought_signature` is valid
 *        (>= MIN_SIGNATURE_LENGTH) -> keep it.
 *      - Otherwise -> replace with SKIP_THOUGHT_SIGNATURE sentinel.
 *   2. Subsequent `functionCall` parts (parallel calls):
 *      - Remove any signature completely.
 */
export function fixThoughtSignatures(body: Record<string, unknown>): boolean {
  const contents = (body as { contents?: unknown[] }).contents
  if (!Array.isArray(contents)) return false

  let patched = false

  for (const content of contents) {
    if (!content || typeof content !== "object") continue

    const parts = (content as { parts?: unknown[] }).parts
    if (!Array.isArray(parts)) continue

    let foundFirstFunctionCall = false

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as Record<string, unknown> | null | undefined
      if (!part || typeof part !== "object") continue
      if (!part.functionCall) continue

      // Extract current signature (either camelCase or snake_case)
      const sig =
        (part.thoughtSignature as string | undefined) ||
        (part.thought_signature as string | undefined)

      if (!foundFirstFunctionCall) {
        // ── First functionCall in this content block ──────────────────────
        foundFirstFunctionCall = true

        if (sig && sig.length >= MIN_SIGNATURE_LENGTH) {
          // Valid signature — keep it, but ensure both keys are present
          if (!part.thought_signature || !part.thoughtSignature) {
            parts[i] = {
              ...part,
              thought_signature: sig,
              thoughtSignature: sig,
            }
            patched = true
          }
        } else {
          // Missing/invalid — inject sentinel
          parts[i] = {
            ...part,
            thought_signature: SKIP_THOUGHT_SIGNATURE,
            thoughtSignature: SKIP_THOUGHT_SIGNATURE,
          }
          patched = true
        }
      } else {
        // ── Parallel functionCall: no signature allowed ───────────────────
        if (part.thoughtSignature || part.thought_signature) {
          const fixed = { ...part }
          delete fixed.thoughtSignature
          delete fixed.thought_signature
          parts[i] = fixed
          patched = true
        }
      }
    }
  }

  return patched
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch interceptor factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a custom fetch function that intercepts Gemini API requests and
 * patches thought signatures on the wire.
 */
function createPatchedFetch() {
  return async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // Pass through any non-Gemini request untouched.
    if (!isGeminiGenerateContentRequest(input)) {
      return fetch(input, init)
    }

    // No body to fix -> forward as-is.
    if (!init?.body || typeof init.body !== "string") {
      return fetch(input, init)
    }

    let body: Record<string, unknown>
    try {
      body = JSON.parse(init.body) as Record<string, unknown>
    } catch {
      // Unparseable body — don't touch it.
      return fetch(input, init)
    }

    // Apply the thought_signature fix in-place.
    fixThoughtSignatures(body)

    return fetch(input, {
      ...init,
      body: JSON.stringify(body),
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth hook factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates an auth hook for a specific provider that injects the patched fetch.
 *
 * `methods: []` means no new login UI — we piggyback on existing auth and
 * only intercept the outbound fetch.
 */
function createAuthHook(providerID: string) {
  return {
    provider: providerID,
    methods: [] as never[],

    loader: async (
      getAuth: () => Promise<Record<string, unknown> | undefined>,
      _provider: unknown,
    ) => {
      const auth = await getAuth()

      const baseConfig: Record<string, unknown> = {}
      if (auth && typeof auth === "object" && "apiKey" in auth) {
        baseConfig.apiKey = (auth as { apiKey: string }).apiKey
      }

      return {
        ...baseConfig,
        fetch: createPatchedFetch(),
      }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin exports
//
// OpenCode allows one `auth.provider` per plugin export. To cover both
// `google` (Google AI) and `google-vertex` (Vertex AI) we export two
// separate Plugin instances. OpenCode deduplicates by function reference —
// since these are different functions, both will be initialized.
// ─────────────────────────────────────────────────────────────────────────────

/** Fixes thought signatures for the `google` (Google AI) provider. */
export const GoogleFixPlugin: Plugin = async (_ctx) => ({
  auth: createAuthHook("google"),
})

/** Fixes thought signatures for the `google-vertex` (Vertex AI) provider. */
export const GoogleVertexFixPlugin: Plugin = async (_ctx) => ({
  auth: createAuthHook("google-vertex"),
})

/**
 * Default export — covers the `google` provider.
 * Named exports `GoogleFixPlugin` and `GoogleVertexFixPlugin` cover both.
 */
export default GoogleFixPlugin
