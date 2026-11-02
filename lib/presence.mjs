import { createHash } from "node:crypto";
import { sharedBlobStore as blob } from "./blob-store.mjs";

export const PRESENCE_PATH = "gionny/presence/active-sessions.json";
export const PRESENCE_WINDOW_MS = 3 * 60 * 1000;

async function readPresence(store) {
  const result = await store.get(PRESENCE_PATH, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) return {};
  try {
    const stored = JSON.parse(await new Response(result.stream).text());
    return stored?.version === 1 && stored.sessions && typeof stored.sessions === "object" && !Array.isArray(stored.sessions)
      ? stored.sessions
      : {};
  } catch {
    return {};
  }
}

export async function recordPresence(sessionId, store = blob, now = Date.now()) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{32,64}$/u.test(sessionId)) {
    throw new TypeError("Invalid presence session id");
  }
  const sessions = await readPresence(store);
  const cutoff = now - PRESENCE_WINDOW_MS;
  const active = {};
  for (const [hash, timestamp] of Object.entries(sessions)) {
    if (/^[0-9a-f]{64}$/u.test(hash) && Number.isFinite(timestamp) && timestamp >= cutoff && timestamp <= now + 60_000) {
      active[hash] = timestamp;
    }
  }
  const sessionHash = createHash("sha256").update(sessionId).digest("hex");
  active[sessionHash] = now;
  await store.put(PRESENCE_PATH, JSON.stringify({ version: 1, updatedAt: new Date(now).toISOString(), sessions: active }), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
  });
  return Object.keys(active).length;
}
