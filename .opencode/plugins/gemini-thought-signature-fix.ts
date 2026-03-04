// Re-export the canonical implementation for local development/testing.
// In production, use the standalone shim at ~/.opencode/plugins/ instead.
export {
  GoogleFixPlugin,
  GoogleVertexFixPlugin,
  default,
} from "../../src/index.ts"
