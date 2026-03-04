// @bun
// src/index.ts
var SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
var MIN_SIGNATURE_LENGTH = 50;
function toUrlString(input) {
  if (typeof input === "string")
    return input;
  if (input instanceof URL)
    return input.toString();
  return input.url;
}
function isGeminiGenerateContentRequest(input) {
  const url = toUrlString(input);
  const isGoogleApi = url.includes("generativelanguage.googleapis.com") || url.includes("aiplatform.googleapis.com");
  if (!isGoogleApi)
    return false;
  return url.includes("generateContent") || url.includes("streamGenerateContent");
}
function fixThoughtSignatures(body) {
  const contents = body.contents;
  if (!Array.isArray(contents))
    return false;
  let patched = false;
  for (const content of contents) {
    if (!content || typeof content !== "object")
      continue;
    const parts = content.parts;
    if (!Array.isArray(parts))
      continue;
    let foundFirstFunctionCall = false;
    for (let i = 0;i < parts.length; i++) {
      const part = parts[i];
      if (!part || typeof part !== "object")
        continue;
      if (!part.functionCall)
        continue;
      const sig = part.thoughtSignature || part.thought_signature;
      if (!foundFirstFunctionCall) {
        foundFirstFunctionCall = true;
        if (sig && sig.length >= MIN_SIGNATURE_LENGTH) {
          if (!part.thought_signature || !part.thoughtSignature) {
            parts[i] = {
              ...part,
              thought_signature: sig,
              thoughtSignature: sig
            };
            patched = true;
          }
        } else {
          parts[i] = {
            ...part,
            thought_signature: SKIP_THOUGHT_SIGNATURE,
            thoughtSignature: SKIP_THOUGHT_SIGNATURE
          };
          patched = true;
        }
      } else {
        if (part.thoughtSignature || part.thought_signature) {
          const fixed = { ...part };
          delete fixed.thoughtSignature;
          delete fixed.thought_signature;
          parts[i] = fixed;
          patched = true;
        }
      }
    }
  }
  return patched;
}
function createPatchedFetch() {
  return async function patchedFetch(input, init) {
    if (!isGeminiGenerateContentRequest(input)) {
      return fetch(input, init);
    }
    if (!init?.body || typeof init.body !== "string") {
      return fetch(input, init);
    }
    let body;
    try {
      body = JSON.parse(init.body);
    } catch {
      return fetch(input, init);
    }
    fixThoughtSignatures(body);
    return fetch(input, {
      ...init,
      body: JSON.stringify(body)
    });
  };
}
function createAuthHook(providerID) {
  return {
    provider: providerID,
    methods: [],
    loader: async (getAuth, _provider) => {
      const auth = await getAuth();
      const baseConfig = {};
      if (auth && typeof auth === "object" && "apiKey" in auth) {
        baseConfig.apiKey = auth.apiKey;
      }
      return {
        ...baseConfig,
        fetch: createPatchedFetch()
      };
    }
  };
}
var GoogleFixPlugin = async (_ctx) => ({
  auth: createAuthHook("google")
});
var GoogleVertexFixPlugin = async (_ctx) => ({
  auth: createAuthHook("google-vertex")
});
var src_default = GoogleFixPlugin;
export {
  toUrlString,
  isGeminiGenerateContentRequest,
  fixThoughtSignatures,
  src_default as default,
  SKIP_THOUGHT_SIGNATURE,
  MIN_SIGNATURE_LENGTH,
  GoogleVertexFixPlugin,
  GoogleFixPlugin
};
