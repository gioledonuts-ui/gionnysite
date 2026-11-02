import test from "node:test";
import assert from "node:assert/strict";

import { PRESENCE_PATH, PRESENCE_WINDOW_MS, recordPresence } from "../lib/presence.mjs";

class MemoryBlobStore {
  constructor() {
    this.objects = new Map();
  }

  async get(pathname) {
    const body = this.objects.get(pathname);
    if (!body) return null;
    return { statusCode: 200, stream: new Response(body).body };
  }

  async put(pathname, body) {
    this.objects.set(pathname, Buffer.from(body));
    return { pathname };
  }
}

test("presence counts unique sessions over the rolling three-minute window", async () => {
  const store = new MemoryBlobStore();
  const now = Date.now();
  const first = "A".repeat(32);
  const second = "B".repeat(32);
  const third = "C".repeat(32);

  assert.equal(await recordPresence(first, store, now), 1);
  assert.equal(await recordPresence(first, store, now + 1_000), 1);
  assert.equal(await recordPresence(second, store, now + 2_000), 2);
  assert.equal(await recordPresence(third, store, now + 3_000), 3);

  const stored = JSON.parse(store.objects.get(PRESENCE_PATH).toString("utf8"));
  assert.equal(stored.version, 1);
  assert.equal(Object.keys(stored.sessions).length, 3);

  const afterWindow = now + PRESENCE_WINDOW_MS + 5_000;
  assert.equal(await recordPresence(first, store, afterWindow), 1);
});

test("presence rejects arbitrary client-provided session identifiers", async () => {
  const store = new MemoryBlobStore();
  await assert.rejects(recordPresence("not-a-session", store), TypeError);
  assert.equal(store.objects.size, 0);
});
