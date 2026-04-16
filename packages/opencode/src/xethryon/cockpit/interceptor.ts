/**
 * Cockpit — Fetch Interceptor.
 *
 * Wraps the provider's fetch function to:
 * 1. Inject the active pool key's Authorization header
 * 2. Catch 429 responses → mark key exhausted → retry with next key
 * 3. Track token usage from response headers (if available)
 */

import { Log } from "@/util/log"
import {
  hasCockpitPool,
  getActiveKey,
  markExhausted,
  rotateToNext,
  recordUsage,
  shouldPreemptiveSwitch,
} from "./pool.js"

const log = Log.create({ service: "xethryon.cockpit.interceptor" })

/**
 * Create a cockpit-aware fetch function that wraps the original.
 * When a pool is active for this provider, the interceptor:
 *   - Overrides the Authorization / Bearer header with the pool's active key
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

    // Inject the active key
    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${activeKey.apiKey}`)
    const modifiedInit = { ...init, headers }

    log.info("cockpit request", {
      providerID,
      keyId: activeKey.id,
      keyIndex: activeKey._stateIndex,
    })

    const response = await originalFetch(input, modifiedInit)

    // Handle 429 — rate limit hit
    if (response.status === 429) {
      log.warn("429 rate limit hit", { providerID, keyId: activeKey.id })
      markExhausted(providerID, activeKey.id, "session_exhausted")

      // Try next key
      const nextKey = rotateToNext(providerID)
      if (nextKey) {
        log.info("retrying with rotated key", { providerID, keyId: nextKey.id })
        const retryHeaders = new Headers(init?.headers)
        retryHeaders.set("Authorization", `Bearer ${nextKey.apiKey}`)
        const retryResponse = await originalFetch(input, { ...init, headers: retryHeaders })

        if (retryResponse.status === 429) {
          // Next key also 429'd — could be a different limit
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
