import { describe, expect, it } from "bun:test"
import {
  fixThoughtSignatures,
  isGeminiGenerateContentRequest,
  toUrlString,
  SKIP_THOUGHT_SIGNATURE,
  MIN_SIGNATURE_LENGTH,
  GoogleFixPlugin,
  GoogleVertexFixPlugin,
} from "./index"

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Create a valid-looking signature (>= MIN_SIGNATURE_LENGTH chars). */
function validSig(): string {
  return "a".repeat(MIN_SIGNATURE_LENGTH + 10)
}

/** Create a short/invalid signature. */
function shortSig(): string {
  return "abc"
}

/** Build a minimal Gemini API request body with contents. */
function makeBody(
  contents: Array<{
    role?: string
    parts: Array<Record<string, unknown>>
  }>,
): Record<string, unknown> {
  return { contents }
}

// ─────────────────────────────────────────────────────────────────────────────
// toUrlString
// ─────────────────────────────────────────────────────────────────────────────

describe("toUrlString", () => {
  it("handles plain strings", () => {
    expect(toUrlString("https://example.com/foo")).toBe(
      "https://example.com/foo",
    )
  })

  it("handles URL objects", () => {
    expect(toUrlString(new URL("https://example.com/bar"))).toBe(
      "https://example.com/bar",
    )
  })

  it("handles Request objects", () => {
    const req = new Request("https://example.com/baz")
    expect(toUrlString(req)).toBe("https://example.com/baz")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// isGeminiGenerateContentRequest
// ─────────────────────────────────────────────────────────────────────────────

describe("isGeminiGenerateContentRequest", () => {
  describe("Google AI (generativelanguage.googleapis.com)", () => {
    it("matches generateContent", () => {
      expect(
        isGeminiGenerateContentRequest(
          "https://generativelanguage.googleapis.com/v1/models/gemini-3-pro:generateContent",
        ),
      ).toBe(true)
    })

    it("matches streamGenerateContent", () => {
      expect(
        isGeminiGenerateContentRequest(
          "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash:streamGenerateContent?alt=sse",
        ),
      ).toBe(true)
    })
  })

  describe("Vertex AI (aiplatform.googleapis.com)", () => {
    it("matches streamGenerateContent", () => {
      expect(
        isGeminiGenerateContentRequest(
          "https://aiplatform.googleapis.com/v1beta1/projects/viitrium-ai/locations/global/publishers/google/models/gemini-3.1-pro-preview-customtools:streamGenerateContent?alt=sse",
        ),
      ).toBe(true)
    })

    it("matches generateContent", () => {
      expect(
        isGeminiGenerateContentRequest(
          "https://aiplatform.googleapis.com/v1/projects/my-project/locations/us-central1/publishers/google/models/gemini-3-pro:generateContent",
        ),
      ).toBe(true)
    })

    it("matches the exact URL from the failing session", () => {
      // This is the actual URL from session ses_34a549617ffelTr4DljOnQkjtJ
      expect(
        isGeminiGenerateContentRequest(
          "https://aiplatform.googleapis.com/v1beta1/projects/viitrium-ai/locations/global/publishers/google/models/gemini-3.1-pro-preview-customtools:streamGenerateContent?alt=sse",
        ),
      ).toBe(true)
    })
  })

  describe("non-Gemini URLs", () => {
    it("rejects OpenAI endpoints", () => {
      expect(
        isGeminiGenerateContentRequest("https://api.openai.com/v1/completions"),
      ).toBe(false)
    })

    it("rejects Anthropic endpoints", () => {
      expect(
        isGeminiGenerateContentRequest(
          "https://api.anthropic.com/v1/messages",
        ),
      ).toBe(false)
    })

    it("rejects Google APIs that are not generateContent", () => {
      expect(
        isGeminiGenerateContentRequest(
          "https://generativelanguage.googleapis.com/v1/models/gemini-3-pro:countTokens",
        ),
      ).toBe(false)
    })

    it("rejects Vertex AI non-generateContent endpoints", () => {
      expect(
        isGeminiGenerateContentRequest(
          "https://aiplatform.googleapis.com/v1/projects/foo/locations/us/endpoints/123:predict",
        ),
      ).toBe(false)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fixThoughtSignatures
// ─────────────────────────────────────────────────────────────────────────────

describe("fixThoughtSignatures", () => {
  describe("single functionCall per content block", () => {
    it("injects sentinel when signature is missing", () => {
      const body = makeBody([
        {
          role: "model",
          parts: [{ functionCall: { name: "read", args: {} } }],
        },
      ])

      const patched = fixThoughtSignatures(body)

      expect(patched).toBe(true)
      const part = (body.contents as any[])[0].parts[0]
      expect(part.thought_signature).toBe(SKIP_THOUGHT_SIGNATURE)
      expect(part.thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE)
    })

    it("injects sentinel when signature is too short", () => {
      const body = makeBody([
        {
          role: "model",
          parts: [
            {
              functionCall: { name: "read", args: {} },
              thoughtSignature: shortSig(),
            },
          ],
        },
      ])

      const patched = fixThoughtSignatures(body)

      expect(patched).toBe(true)
      const part = (body.contents as any[])[0].parts[0]
      expect(part.thought_signature).toBe(SKIP_THOUGHT_SIGNATURE)
      expect(part.thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE)
    })

    it("preserves valid signatures", () => {
      const sig = validSig()
      const body = makeBody([
        {
          role: "model",
          parts: [
            {
              functionCall: { name: "read", args: {} },
              thoughtSignature: sig,
              thought_signature: sig,
            },
          ],
        },
      ])

      const patched = fixThoughtSignatures(body)

      // Both keys already present with valid sig — no patching needed
      expect(patched).toBe(false)
      const part = (body.contents as any[])[0].parts[0]
      expect(part.thoughtSignature).toBe(sig)
      expect(part.thought_signature).toBe(sig)
    })

    it("normalizes when only camelCase key is present with valid sig", () => {
      const sig = validSig()
      const body = makeBody([
        {
          role: "model",
          parts: [
            {
              functionCall: { name: "read", args: {} },
              thoughtSignature: sig,
            },
          ],
        },
      ])

      const patched = fixThoughtSignatures(body)

      expect(patched).toBe(true)
      const part = (body.contents as any[])[0].parts[0]
      expect(part.thoughtSignature).toBe(sig)
      expect(part.thought_signature).toBe(sig)
    })

    it("handles snake_case key too", () => {
      const sig = validSig()
      const body = makeBody([
        {
          role: "model",
          parts: [
            {
              functionCall: { name: "read", args: {} },
              thought_signature: sig,
            },
          ],
        },
      ])

      const patched = fixThoughtSignatures(body)

      expect(patched).toBe(true)
      const part = (body.contents as any[])[0].parts[0]
      expect(part.thoughtSignature).toBe(sig)
      expect(part.thought_signature).toBe(sig)
    })
  })

  describe("parallel functionCalls per content block", () => {
    it("injects sentinel on first, strips from subsequent", () => {
      const body = makeBody([
        {
          role: "model",
          parts: [
            { functionCall: { name: "read", args: {} } },
            {
              functionCall: { name: "write", args: {} },
              thoughtSignature: "should-be-removed",
            },
            { functionCall: { name: "edit", args: {} } },
          ],
        },
      ])

      const patched = fixThoughtSignatures(body)

      expect(patched).toBe(true)
      const parts = (body.contents as any[])[0].parts

      // First: sentinel
      expect(parts[0].thought_signature).toBe(SKIP_THOUGHT_SIGNATURE)
      expect(parts[0].thoughtSignature).toBe(SKIP_THOUGHT_SIGNATURE)

      // Second: stripped
      expect(parts[1].thoughtSignature).toBeUndefined()
      expect(parts[1].thought_signature).toBeUndefined()

      // Third: also stripped (no signature existed, but no signature should exist)
      expect(parts[2].thoughtSignature).toBeUndefined()
      expect(parts[2].thought_signature).toBeUndefined()
    })

    it("preserves valid sig on first, strips subsequent", () => {
      const sig = validSig()
      const body = makeBody([
        {
          role: "model",
          parts: [
            {
              functionCall: { name: "read", args: {} },
              thoughtSignature: sig,
              thought_signature: sig,
            },
            {
              functionCall: { name: "write", args: {} },
              thoughtSignature: "invalid-parallel",
            },
          ],
        },
      ])

      const patched = fixThoughtSignatures(body)

      expect(patched).toBe(true) // second part was stripped
      const parts = (body.contents as any[])[0].parts

      // First preserved
      expect(parts[0].thoughtSignature).toBe(sig)

      // Second stripped
      expect(parts[1].thoughtSignature).toBeUndefined()
    })
  })

  describe("multi-model session (the actual failing scenario)", () => {
    it("patches tool calls from non-Gemini models in history", () => {
      // Simulate the exact scenario: history has Claude + GPT tool calls,
      // now sending to Gemini. None have thought signatures.
      const body = makeBody([
        // User message
        { role: "user", parts: [{ text: "Help me with X" }] },
        // Claude assistant message with tool call (no thought sig)
        {
          role: "model",
          parts: [
            { text: "Let me read that file" },
            {
              functionCall: { name: "default_api:read", args: { path: "." } },
            },
          ],
        },
        // Tool result
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "default_api:read",
                response: { content: "file contents" },
              },
            },
          ],
        },
        // GPT assistant message with multiple tool calls (no thought sig)
        {
          role: "model",
          parts: [
            { text: "I'll fetch that URL" },
            {
              functionCall: {
                name: "default_api:webfetch",
                args: { url: "https://example.com" },
              },
            },
            {
              functionCall: {
                name: "default_api:read",
                args: { path: "src/" },
              },
            },
          ],
        },
        // Tool results
        {
          role: "user",
          parts: [
            {
              functionResponse: {
                name: "default_api:webfetch",
                response: { content: "page" },
              },
            },
            {
              functionResponse: {
                name: "default_api:read",
                response: { content: "dir listing" },
              },
            },
          ],
        },
        // New user message (now going to Gemini)
        {
          role: "user",
          parts: [{ text: "Continue with Gemini" }],
        },
      ])

      const patched = fixThoughtSignatures(body)

      expect(patched).toBe(true)

      const contents = body.contents as any[]

      // Content block 1 (user) — no functionCall, untouched
      expect(contents[0].parts[0].text).toBe("Help me with X")

      // Content block 2 (model with single tool call from Claude)
      expect(contents[1].parts[0].text).toBe("Let me read that file")
      expect(contents[1].parts[1].thought_signature).toBe(
        SKIP_THOUGHT_SIGNATURE,
      )
      expect(contents[1].parts[1].thoughtSignature).toBe(
        SKIP_THOUGHT_SIGNATURE,
      )

      // Content block 3 (tool result) — no functionCall, untouched

      // Content block 4 (model with parallel tool calls from GPT)
      // First tool call: sentinel
      expect(contents[3].parts[1].thought_signature).toBe(
        SKIP_THOUGHT_SIGNATURE,
      )
      expect(contents[3].parts[1].thoughtSignature).toBe(
        SKIP_THOUGHT_SIGNATURE,
      )
      // Second (parallel) tool call: stripped
      expect(contents[3].parts[2].thoughtSignature).toBeUndefined()
      expect(contents[3].parts[2].thought_signature).toBeUndefined()
      // The functionCall itself still exists
      expect(contents[3].parts[2].functionCall).toBeTruthy()
    })
  })

  describe("edge cases", () => {
    it("returns false when body has no contents", () => {
      expect(fixThoughtSignatures({})).toBe(false)
      expect(fixThoughtSignatures({ contents: "not-array" } as any)).toBe(false)
    })

    it("handles empty contents array", () => {
      expect(fixThoughtSignatures({ contents: [] })).toBe(false)
    })

    it("handles content blocks with no parts", () => {
      expect(
        fixThoughtSignatures({ contents: [{ role: "user" }] }),
      ).toBe(false)
    })

    it("handles null/undefined parts in array", () => {
      const body = makeBody([
        {
          role: "model",
          parts: [
            null as any,
            undefined as any,
            { functionCall: { name: "test", args: {} } },
          ],
        },
      ])

      const patched = fixThoughtSignatures(body)

      expect(patched).toBe(true)
      const parts = (body.contents as any[])[0].parts
      expect(parts[2].thought_signature).toBe(SKIP_THOUGHT_SIGNATURE)
    })

    it("ignores non-functionCall parts", () => {
      const body = makeBody([
        {
          role: "model",
          parts: [
            { text: "hello" },
            { inlineData: { data: "base64" } },
          ],
        },
      ])

      const patched = fixThoughtSignatures(body)
      expect(patched).toBe(false)
    })

    it("handles mixed text + functionCall parts correctly", () => {
      const body = makeBody([
        {
          role: "model",
          parts: [
            { text: "Let me think..." },
            { functionCall: { name: "read", args: {} } },
            { text: "More reasoning" },
          ],
        },
      ])

      const patched = fixThoughtSignatures(body)

      expect(patched).toBe(true)
      const parts = (body.contents as any[])[0].parts
      // text parts untouched
      expect(parts[0].text).toBe("Let me think...")
      expect(parts[0].thought_signature).toBeUndefined()
      // functionCall patched
      expect(parts[1].thought_signature).toBe(SKIP_THOUGHT_SIGNATURE)
      // text parts untouched
      expect(parts[2].text).toBe("More reasoning")
    })
  })

  describe("multiple content blocks", () => {
    it("resets first-functionCall tracking per content block", () => {
      const body = makeBody([
        {
          role: "model",
          parts: [
            { functionCall: { name: "tool1", args: {} } },
            { functionCall: { name: "tool2", args: {} } },
          ],
        },
        {
          role: "model",
          parts: [
            { functionCall: { name: "tool3", args: {} } },
            { functionCall: { name: "tool4", args: {} } },
          ],
        },
      ])

      fixThoughtSignatures(body)

      const contents = body.contents as any[]

      // Block 0: tool1 gets sentinel, tool2 stripped
      expect(contents[0].parts[0].thought_signature).toBe(
        SKIP_THOUGHT_SIGNATURE,
      )
      expect(contents[0].parts[1].thoughtSignature).toBeUndefined()

      // Block 1: tool3 gets sentinel (first in its block), tool4 stripped
      expect(contents[1].parts[0].thought_signature).toBe(
        SKIP_THOUGHT_SIGNATURE,
      )
      expect(contents[1].parts[1].thoughtSignature).toBeUndefined()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Plugin structure
// ─────────────────────────────────────────────────────────────────────────────

describe("Plugin exports", () => {
  it("GoogleFixPlugin targets 'google' provider", async () => {
    const hooks = await GoogleFixPlugin({} as any)
    expect(hooks.auth).toBeDefined()
    expect(hooks.auth!.provider).toBe("google")
    expect(hooks.auth!.methods).toEqual([])
  })

  it("GoogleVertexFixPlugin targets 'google-vertex' provider", async () => {
    const hooks = await GoogleVertexFixPlugin({} as any)
    expect(hooks.auth).toBeDefined()
    expect(hooks.auth!.provider).toBe("google-vertex")
    expect(hooks.auth!.methods).toEqual([])
  })

  it("default export is GoogleFixPlugin (not GoogleVertexFixPlugin)", async () => {
    const { default: defaultExport } = await import("./index")
    expect(defaultExport).toBe(GoogleFixPlugin)
  })

  it("GoogleFixPlugin and GoogleVertexFixPlugin are different functions", () => {
    // Important: OpenCode deduplicates by reference, so these must be different
    expect(GoogleFixPlugin).not.toBe(GoogleVertexFixPlugin)
  })
})
