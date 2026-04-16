/**
 * Cockpit — Fetch Interceptor.
 *
 * Wraps the provider's fetch function to:
 * 1. Track requests per key (no auth modification for normal requests)
 * 2. On 429 → mark key exhausted → rebuild request with next key → retry
 *
 * Design: The SDK manages auth internally via its constructor apiKey.
 * We DON'T touch auth headers for normal requests — just track them.
 * Only on 429 failover do we override the Authorization header to swap keys.
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
 * Only used for 429 retry with a different key.
 */
function overrideAuth(init: any, apiKey: string): any {
  const newInit = { ...init }
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
 *
 * Normal flow: just pass through and track the request.
 * On 429: mark key exhausted, rotate to next, retry with overridden auth.
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

    const activeKey = getActiveKey(providerID)
    if (!activeKey) {
      // No active keys — just pass through
      return originalFetch(input, init)
    }

    // Track the request (don't modify auth — let SDK handle it)
    recordUsage(providerID, activeKey.id, 0)

    log.info("cockpit tracking request", {
      providerID,
      keyId: activeKey.id,
      keyIndex: activeKey._stateIndex,
    })

    const response = await originalFetch(input, init)

    // Handle 429 — rate limit hit → rotate and retry
    if (response.status === 429) {
      log.warn("429 rate limit hit", { providerID, keyId: activeKey.id })
      markExhausted(providerID, activeKey.id, "session_exhausted")

      // Try next key — this time we DO override auth since we're switching keys
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
 */
export function recordCockpitUsage(providerID: string, tokens: number): void {
  if (!hasCockpitPool(providerID)) return
  const key = getActiveKey(providerID)
  if (!key) return
  recordUsage(providerID, key.id, tokens)
}
