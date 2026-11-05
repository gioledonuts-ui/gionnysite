import { createHash } from "node:crypto";
import { sharedBlobStore } from "./blob-store.mjs";

export const PRESENCE_WINDOW_MS = 3 * 60 * 1000;
const MAX_PRESENCE_SESSIONS = 10_000;
const PRESENCE_STATE_KEY = Symbol.for("gionny.presence.sessions.v1");
const isolatedStates = new WeakMap();

function stateFor(store) {
  if (store !== sharedBlobStore && store && (typeof store === "object" || typeof store === "function")) {
    let state = isolatedStates.get(store);
    if (!state) {
      state = new Map();
      isolatedStates.set(store, state);
    }
    return state;
  }

  if (!(globalThis[PRESENCE_STATE_KEY] instanceof Map)) {
    globalThis[PRESENCE_STATE_KEY] = new Map();
  }
  return globalThis[PRESENCE_STATE_KEY];
}

/**
 * Presence is intentionally ephemeral and instance-local: it is a display hint,
 * not durable account state. Vercel instances and cold starts do not share RAM,
 * so the returned count is approximate across the deployment.
 */
export async function recordPresence(sessionId, store = sharedBlobStore, now = Date.now()) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{32,64}$/u.test(sessionId)) {
    throw new TypeError("Invalid presence session id");
  }
  if (!Number.isFinite(now)) throw new TypeError("Invalid presence timestamp");

  const sessions = stateFor(store);
  const cutoff = now - PRESENCE_WINDOW_MS;
  for (const [hash, timestamp] of sessions) {
    if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > now + 60_000) {
      sessions.delete(hash);
    }
  }

  const sessionHash = createHash("sha256").update(sessionId).digest("hex");
  if (sessions.size >= MAX_PRESENCE_SESSIONS && !sessions.has(sessionHash)) {
    let oldestHash = "";
    let oldestTimestamp = Number.POSITIVE_INFINITY;
    for (const [hash, timestamp] of sessions) {
      if (timestamp < oldestTimestamp) {
        oldestTimestamp = timestamp;
        oldestHash = hash;
      }
    }
    if (oldestHash) sessions.delete(oldestHash);
  }
  sessions.set(sessionHash, now);
  return sessions.size;
}
