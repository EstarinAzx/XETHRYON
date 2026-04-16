/**
 * Cockpit — Fetch Interceptor.
 *
 * Wraps the provider's fetch function to:
 * 1. Override the Authorization header the SDK already set with the active pool key
 * 2. Catch 429 responses → mark key exhausted → retry with next key
 * 3. Track requests per key
 *
 * Key insight: the AI SDK sets Authorization internally from `apiKey` in the
 * constructor. Our fetch wrapper runs AFTER the SDK has built the request,
 * so we can safely override the Authorization header the SDK already set.
 */

import { Log } from "@/util/log"
import {
  hasCockpitPool,
  getActiveKey,
  markExhausted,
  rotateToNext,
  recordUsage,
  shouldPreemptiveSwitch,
  ensureInit,
} from "./pool.js"

const log = Log.create({ service: "xethryon.cockpit.interceptor" })

/**
 * Replace the Authorization header in a fetch init object.
 * Handles both Headers objects and plain objects.
 */
function overrideAuth(init: any, apiKey: string): any {
  const newInit = { ...init }
  // The SDK may pass headers as a plain object or Headers instance
  if (newInit.headers instanceof Headers) {
    newInit.headers = new Headers(newInit.headers)
    newInit.headers.set("Authorization", `Bearer ${apiKey}`)
  } else if (newInit.headers && typeof newInit.headers === "object") {
    newInit.headers = {
      ...newInit.headers,
      Authorization: `Bearer ${apiKey}`,
    }
  } else {
    newInit.headers = { Authorization: `Bearer ${apiKey}` }
  }
  return newInit
}

/**
 * Create a cockpit-aware fetch function that wraps the original.
 * When a pool is active for this provider, the interceptor:
 *   - Overrides the Authorization header the SDK already set
 *   - On 429, marks the key exhausted, rotates, and retries once
 */
export function cockpitFetch(
  providerID: string,
  originalFetch: typeof fetch,
): typeof fetch {
  return (async (input: any, init?: any): Promise<Response> => {
    if (!hasCockpitPool(providerID)) {
      return originalFetch(input, init)
    }

    // Ensure pool state is fully loaded before first use
    await ensureInit()

    // Pre-emptive rotation check
    if (shouldPreemptiveSwitch(providerID)) {
      log.info("pre-emptive key rotation triggered", { providerID })
      rotateToNext(providerID)
    }

    const activeKey = getActiveKey(providerID)
    if (!activeKey) {
      log.warn("no active cockpit keys available, falling through", { providerID })
      return originalFetch(input, init)
    }

    // Override the Authorization header the SDK already set
    const modifiedInit = overrideAuth(init ?? {}, activeKey.apiKey)

    log.info("cockpit request", {
      providerID,
      keyId: activeKey.id,
      keyIndex: activeKey._stateIndex,
    })

    // Track that we made a request with this key
    recordUsage(providerID, activeKey.id, 0)

    const response = await originalFetch(input, modifiedInit)

    // Handle 429 — rate limit hit
    if (response.status === 429) {
      log.warn("429 rate limit hit", { providerID, keyId: activeKey.id })
      markExhausted(providerID, activeKey.id, "session_exhausted")

      // Try next key
      const nextKey = rotateToNext(providerID)
      if (nextKey) {
        log.info("retrying with rotated key", { providerID, keyId: nextKey.id })
        const retryInit = overrideAuth(init ?? {}, nextKey.apiKey)
        const retryResponse = await originalFetch(input, retryInit)

        if (retryResponse.status === 429) {
          log.warn("retry key also hit 429", { providerID, keyId: nextKey.id })
          markExhausted(providerID, nextKey.id, "session_exhausted")
        }

        return retryResponse
      }

      // All keys exhausted — return the 429 as-is
      log.error("all cockpit keys exhausted, returning 429", { providerID })
    }

    return response
  }) as typeof fetch
}

/**
 * After an LLM response completes, record token usage for the active key.
 * Call this from the prompt loop after tokens are known.
 */
export function recordCockpitUsage(providerID: string, tokens: number): void {
  if (!hasCockpitPool(providerID)) return
  const key = getActiveKey(providerID)
  if (!key) return
  recordUsage(providerID, key.id, tokens)
}
