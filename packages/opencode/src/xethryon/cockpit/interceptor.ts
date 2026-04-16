/**
 * Cockpit — Fetch Interceptor.
 *
 * Wraps the provider's fetch function to:
 * 1. Track requests per key
 * 2. On 429 → mark key exhausted → rotate (SDK cache will bust on next request)
 *
 * Design: The SDK is created with the cockpit's active key via resolveSDK.
 * The cockpit activeIndex is part of the SDK cache key, so when we rotate,
 * the next request will create a fresh SDK with the new key automatically.
 * We DON'T retry in the interceptor — the SDK's built-in retry handles it.
 */

import { Log } from "@/util/log"
import {
  hasCockpitPool,
  getActiveKey,
  markExhausted,
  rotateToNext,
  recordUsage,
  ensureInit,
} from "./pool.js"

const log = Log.create({ service: "xethryon.cockpit.interceptor" })

/**
 * Create a cockpit-aware fetch function that wraps the original.
 *
 * Normal flow: just pass through and track the request.
 * On 429: mark key exhausted, rotate to next. The SDK's retry mechanism
 * will create a new SDK (cache busted by activeIndex change) with the new key.
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
      return originalFetch(input, init)
    }

    // Track the request
    recordUsage(providerID, activeKey.id, 0)

    log.info("cockpit tracking request", {
      providerID,
      keyId: activeKey.id,
      keyIndex: activeKey._stateIndex,
    })

    const response = await originalFetch(input, init)

    // Handle 429 — rate limit hit → rotate for next request
    if (response.status === 429) {
      log.warn("429 rate limit hit — rotating cockpit key", { providerID, keyId: activeKey.id })

      // Determine exhaustion type from response body
      const bodyText = await response.clone().text().catch(() => "")
      const isWeekly = bodyText.includes("weekly")
      markExhausted(providerID, activeKey.id, isWeekly ? "weekly_exhausted" : "session_exhausted")

      // Rotate to next key — the SDK cache will bust on the next request
      // because cockpitIndex is part of the cache key
      const nextKey = rotateToNext(providerID)
      if (nextKey) {
        log.info("rotated to next key for retry", { providerID, keyId: nextKey.id })
      } else {
        log.error("all cockpit keys exhausted", { providerID })
      }
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
