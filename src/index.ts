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
 * Fix (matches the pattern used by opencode-antigravity-auth):
 *   - First `functionCall` part in each content block: if its signature is
 *     absent or shorter than MIN_SIGNATURE_LENGTH, inject the sentinel value
 *     `"skip_thought_signature_validator"` so Gemini skips the validator.
 *   - Subsequent (parallel) `functionCall` parts in the same block: remove
 *     any signature entirely — the API rejects parallel calls that carry one.
 *
 * The fix is applied via `auth.loader` → custom `fetch()` so it intercepts at
 * the HTTP wire level, exactly where `thought_signature` lives.
 */

import type { Plugin } from "@opencode-ai/plugin";

// Sentinel value recognised by the Gemini API's thought-signature validator.
// When present it suppresses the signature check rather than requiring a real one.
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

// Signatures shorter than this threshold are treated as absent/invalid.
const MIN_SIGNATURE_LENGTH = 50;

// ─────────────────────────────────────────────────────────────────────────────
// URL helpers
// ─────────────────────────────────────────────────────────────────────────────

function toUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  // RequestInfo that is a Request object
  return (input as Request).url;
}

/**
 * Returns true when the request targets a Gemini generateContent endpoint.
 * We scope the fix narrowly so non-Gemini providers are completely untouched.
 */
function isGeminiGenerateContentRequest(input: RequestInfo | URL): boolean {
  const url = toUrlString(input);
  return (
    url.includes("generativelanguage.googleapis.com") &&
    (url.includes("generateContent") || url.includes("streamGenerateContent"))
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Core fix: mutates the request body in-place
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk every content block's parts array and fix `functionCall` signatures.
 *
 * Rules (per content block):
 *   1. First `functionCall` encountered:
 *      - If `thoughtSignature` / `thought_signature` is valid (≥ MIN_SIGNATURE_LENGTH) → keep it.
 *      - Otherwise → replace with SKIP_THOUGHT_SIGNATURE sentinel.
 *   2. Subsequent `functionCall` parts (parallel calls):
 *      - Remove any signature completely.
 */
function fixThoughtSignatures(body: Record<string, unknown>): void {
  const contents = (body as { contents?: unknown[] }).contents;
  if (!Array.isArray(contents)) return;

  for (const content of contents) {
    if (!content || typeof content !== "object") continue;

    const parts = (content as { parts?: unknown[] }).parts;
    if (!Array.isArray(parts)) continue;

    let foundFirstFunctionCall = false;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] as Record<string, unknown> | null | undefined;
      if (!part || typeof part !== "object") continue;
      if (!part.functionCall) continue;

      // Extract current signature (either camelCase or snake_case)
      const sig =
        (part.thoughtSignature as string | undefined) ||
        (part.thought_signature as string | undefined);

      if (!foundFirstFunctionCall) {
        // ── First functionCall in this content block ──────────────────────
        foundFirstFunctionCall = true;

        const validSig =
          sig && sig.length >= MIN_SIGNATURE_LENGTH
            ? sig
            : SKIP_THOUGHT_SIGNATURE;

        parts[i] = {
          ...part,
          thought_signature: validSig,
          thoughtSignature: validSig,
        };
      } else {
        // ── Parallel functionCall: no signature allowed ───────────────────
        const fixed = { ...part };
        delete fixed.thoughtSignature;
        delete fixed.thought_signature;
        parts[i] = fixed;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin definition
// ─────────────────────────────────────────────────────────────────────────────

export const QuickFixesPlugin: Plugin = async (_ctx) => {
  return {
    auth: {
      /**
       * Target the built-in Google / Gemini provider.
       * The `loader` function returns a custom `fetch` that intercepts every
       * HTTP request OpenCode makes to the Gemini API.
       *
       * `methods: []` means this plugin adds no new login UI — it piggybacks
       * on the existing Google auth and only intercepts the outbound fetch.
       */
      provider: "google",
      methods: [],

      loader: async (getAuth, _provider) => {
        // Fetch the current auth credentials (may be API-key or OAuth).
        // We don't need to inspect them — we just need to forward them as-is.
        const auth = await getAuth();

        // Determine the base config to return.
        // If OpenCode stored an API key, pass it through unchanged.
        const baseConfig: Record<string, unknown> = {};
        if (auth && typeof auth === "object" && "apiKey" in auth) {
          baseConfig.apiKey = (auth as { apiKey: string }).apiKey;
        }

        return {
          ...baseConfig,

          /**
           * Custom fetch — called for every HTTP request to the provider.
           * We only mutate Gemini generateContent payloads; everything else
           * is forwarded verbatim.
           */
          async fetch(
            input: RequestInfo | URL,
            init?: RequestInit,
          ): Promise<Response> {
            // Pass through any non-Gemini request untouched.
            if (!isGeminiGenerateContentRequest(input)) {
              return fetch(input, init);
            }

            // No body to fix → forward as-is.
            if (!init?.body || typeof init.body !== "string") {
              return fetch(input, init);
            }

            let body: Record<string, unknown>;
            try {
              body = JSON.parse(init.body) as Record<string, unknown>;
            } catch {
              // Unparseable body — don't touch it.
              return fetch(input, init);
            }

            // Apply the thought_signature fix in-place.
            fixThoughtSignatures(body);

            return fetch(input, {
              ...init,
              body: JSON.stringify(body),
            });
          },
        };
      },
    },
  };
};

export default QuickFixesPlugin;
