/**
 * gemini-thought-signature-fix.ts — self-updating OpenCode plugin shim
 *
 * Drop this single file into ~/.opencode/plugins/ (or .opencode/plugins/)
 * and it will:
 *   1. On first run: download the latest built plugin from GitHub
 *   2. Cache it locally at ~/.cache/opencode-quick-fixes/index.js
 *   3. On subsequent runs: use the cached version (checks for updates every 24h)
 *   4. Validate the downloaded bundle is the expected v0.3+ shape
 *   5. Re-export the plugin so OpenCode loads the global fetch interceptor
 *
 * No npm install required. No private registry. Just this one file.
 *
 * Source: https://github.com/furbyhaxx/opencode-quick-fixes
 */

import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { homedir } from "os"

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const GITHUB_RAW_URL =
  "https://raw.githubusercontent.com/furbyhaxx/opencode-quick-fixes/dev/dist/index.js"

const CACHE_DIR = join(homedir(), ".cache", "opencode-quick-fixes")
const CACHE_FILE = join(CACHE_DIR, "index.js")
const META_FILE = join(CACHE_DIR, "meta.json")

/** Re-check for updates every 24 hours. */
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000

// ─────────────────────────────────────────────────────────────────────────────
// Download + cache
// ─────────────────────────────────────────────────────────────────────────────

interface CacheMeta {
  lastCheck: number
  etag?: string
}

function readMeta(): CacheMeta | null {
  try {
    return JSON.parse(readFileSync(META_FILE, "utf-8")) as CacheMeta
  } catch {
    return null
  }
}

function writeMeta(meta: CacheMeta): void {
  writeFileSync(META_FILE, JSON.stringify(meta, null, 2))
}

function readCachedBundleSource(): string | null {
  try {
    return readFileSync(CACHE_FILE, "utf-8")
  } catch {
    return null
  }
}

/**
 * Validate that a downloaded bundle has the expected v0.3+ architecture.
 *
 * We intentionally reject legacy v0.2 bundles that export GoogleFixPlugin /
 * GoogleVertexFixPlugin because those use auth.loader fetch hooks and do not
 * reliably fix google-vertex requests.
 */
function isCompatibleBundleSource(source: string): boolean {
  const hasV3Export = source.includes("GeminiThoughtSignatureFix")
  const hasGlobalFetchInterceptor = source.includes("globalThis.fetch")

  const hasLegacyV2Exports =
    source.includes("GoogleFixPlugin") ||
    source.includes("GoogleVertexFixPlugin")

  return hasV3Export && hasGlobalFetchInterceptor && !hasLegacyV2Exports
}

async function ensureCached(): Promise<string | null> {
  const meta = readMeta()
  const hasCacheFile = existsSync(CACHE_FILE)
  const cachedSource = readCachedBundleSource()
  const hasCompatibleCache =
    typeof cachedSource === "string" && isCompatibleBundleSource(cachedSource)

  // If we have a cache and checked recently, skip the network call
  if (
    meta &&
    hasCompatibleCache &&
    Date.now() - meta.lastCheck < UPDATE_INTERVAL_MS
  ) {
    return CACHE_FILE
  }

  if (hasCacheFile && !hasCompatibleCache) {
    console.warn(
      "[opencode-quick-fixes] Cached plugin is incompatible (likely v0.2). Attempting refresh.",
    )
  }

  // Ensure cache dir exists
  mkdirSync(CACHE_DIR, { recursive: true })

  try {
    const headers: Record<string, string> = {}
    if (meta?.etag && hasCacheFile) {
      headers["If-None-Match"] = meta.etag
    }

    const resp = await fetch(GITHUB_RAW_URL, { headers })

    if (resp.status === 304) {
      // Not modified — update check timestamp only
      writeMeta({ lastCheck: Date.now(), etag: meta?.etag })
      if (hasCompatibleCache) return CACHE_FILE

      console.error(
        "[opencode-quick-fixes] Remote bundle unchanged, but local cache is incompatible. Fix is not active.",
      )
      return null
    }

    if (!resp.ok) {
      console.error(
        `[opencode-quick-fixes] Failed to download plugin: HTTP ${resp.status}`,
      )
      return hasCompatibleCache ? CACHE_FILE : null
    }

    const body = await resp.text()

    if (!isCompatibleBundleSource(body)) {
      console.error(
        "[opencode-quick-fixes] Downloaded plugin failed compatibility checks (expected GeminiThoughtSignatureFix + global fetch interceptor).",
      )

      // Record this check so we still respect the update interval.
      writeMeta({
        lastCheck: Date.now(),
        etag: resp.headers.get("etag") ?? meta?.etag ?? undefined,
      })

      return hasCompatibleCache ? CACHE_FILE : null
    }

    writeFileSync(CACHE_FILE, body)
    writeMeta({
      lastCheck: Date.now(),
      etag: resp.headers.get("etag") ?? undefined,
    })

    return CACHE_FILE
  } catch (err) {
    console.error(
      `[opencode-quick-fixes] Network error downloading plugin:`,
      err,
    )
    return hasCompatibleCache ? CACHE_FILE : null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Load the real plugin module
// ─────────────────────────────────────────────────────────────────────────────

async function loadPlugin(): Promise<{
  GeminiThoughtSignatureFix: Plugin
}> {
  const cachedPath = await ensureCached()

  if (!cachedPath) {
    console.error(
      "[opencode-quick-fixes] No cached plugin available and download failed. " +
        "Gemini thought signature fix will NOT be active.",
    )
    const noop: Plugin = async () => ({})
    return { GeminiThoughtSignatureFix: noop }
  }

  const mod = (await import(`file://${cachedPath}`)) as {
    GeminiThoughtSignatureFix?: unknown
    GoogleFixPlugin?: unknown
    GoogleVertexFixPlugin?: unknown
  }

  const hasLegacyExports =
    typeof mod.GoogleFixPlugin === "function" ||
    typeof mod.GoogleVertexFixPlugin === "function"

  if (typeof mod.GeminiThoughtSignatureFix !== "function" || hasLegacyExports) {
    console.error(
      "[opencode-quick-fixes] Cached plugin exports are incompatible (legacy v0.2 shape). Gemini fix will NOT be active.",
    )
    const noop: Plugin = async () => ({})
    return { GeminiThoughtSignatureFix: noop }
  }

  return {
    GeminiThoughtSignatureFix: mod.GeminiThoughtSignatureFix as Plugin,
  }
}

const { GeminiThoughtSignatureFix } = await loadPlugin()

export { GeminiThoughtSignatureFix }
export default GeminiThoughtSignatureFix
