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
 * v0.2.0 approach (auth.loader custom fetch — BROKEN for google-vertex):
 *   Used `auth.loader` hooks returning `{ fetch: patchedFetch }` for both
 *   `google` and `google-vertex` providers.  OpenCode's `getSDK()` explicitly
 *   deletes `options.fetch` for the native Vertex AI SDK:
 *     `if (providerID === "google-vertex" && ...) { delete options.fetch }`
 *   This meant the patched fetch never reached the AI SDK for Vertex AI.
 *
 * v0.3.0 approach (globalThis.fetch interceptor):
 *   Replaces `globalThis.fetch` at plugin load time with a thin wrapper.
 *   This is the ONLY interception point that survives OpenCode's fetch
 *   deletion for google-vertex.
 *
 *   Safety:
 *   - Bun's globalThis.fetch is writable and configurable
 *   - AI SDK resolves fetch via lazy thunk `() => globalThis.fetch` at call time
 *   - GoogleAuth uses gaxios → node-fetch, not globalThis.fetch (unaffected)
 *   - URL filter ensures only Gemini generateContent requests are intercepted
 *   - Chain-safe: captures originalFetch at install time
 *   - Idempotent: sentinel property prevents double-install
 */

import type { Plugin } from "@opencode-ai/plugin"

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Sentinel value recognised by the Gemini API's thought-signature validator. */
export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator"

/** Signatures shorter than this are treated as absent/invalid. */
export const MIN_SIGNATURE_LENGTH = 50

/**
 * Property name set on the wrapper function to prevent double-install.
 * @internal
 */
export const PATCH_SENTINEL = "__thought_sig_patched"

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
// Global fetch interceptor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Replaces `globalThis.fetch` with a wrapper that intercepts Gemini API
 * requests and patches thought signatures in the JSON request body.
 *
 * - Only intercepts URLs matching Gemini generateContent/streamGenerateContent
 * - Chain-safe: captures the current globalThis.fetch at install time
 * - Idempotent: re-calling is a no-op (uses PATCH_SENTINEL)
 *
 * @returns An uninstall function that restores the original fetch.
 */
export function installFetchInterceptor(): () => void {
  const originalFetch = globalThis.fetch

  // Guard: already patched — don't double-wrap
  if ((originalFetch as any)[PATCH_SENTINEL]) {
    return () => {}
  }

  async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // Pass through any non-Gemini request untouched.
    if (!isGeminiGenerateContentRequest(input)) {
      return originalFetch(input, init)
    }

    // No body to fix -> forward as-is.
    if (!init?.body || typeof init.body !== "string") {
      return originalFetch(input, init)
    }

    let body: Record<string, unknown>
    try {
      body = JSON.parse(init.body) as Record<string, unknown>
    } catch {
      // Unparseable body — don't touch it.
      return originalFetch(input, init)
    }

    // Apply the thought_signature fix in-place.
    fixThoughtSignatures(body)

    return originalFetch(input, {
      ...init,
      body: JSON.stringify(body),
    })
  }

  // Mark as patched so double-install is a no-op
  ;(patchedFetch as any)[PATCH_SENTINEL] = true

  // Bun's typeof fetch includes a static `preconnect` method — carry it over
  // so the type signature stays compatible.
  if ("preconnect" in originalFetch) {
    ;(patchedFetch as any).preconnect = (originalFetch as any).preconnect
  }

  globalThis.fetch = patchedFetch as typeof fetch

  // Return uninstall function (useful for tests)
  return () => {
    globalThis.fetch = originalFetch
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * OpenCode plugin that fixes Gemini thought_signature errors.
 *
 * Installs a global fetch interceptor at load time. Returns empty hooks —
 * all work is done at the fetch level, below the plugin hook system.
 */
export const GeminiThoughtSignatureFix: Plugin = async (_ctx) => {
  installFetchInterceptor()
  return {}
}

export default GeminiThoughtSignatureFix
