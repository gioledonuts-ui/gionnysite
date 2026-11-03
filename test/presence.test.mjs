import test from "node:test";
import assert from "node:assert/strict";

import { PRESENCE_WINDOW_MS, recordPresence } from "../lib/presence.mjs";

class MemoryBlobStore {
  constructor() {
    this.objects = new Map();
    this.calls = { get: 0, list: 0, put: 0 };
  }

  async get() {
    this.calls.get += 1;
    throw new Error("Presence must not read Blob storage");
  }

  async list() {
    this.calls.list += 1;
    throw new Error("Presence must not list Blob storage");
  }

  async put() {
    this.calls.put += 1;
    throw new Error("Presence must not write Blob storage");
  }
}

test("presence counts unique sessions in the rolling three-minute in-memory window", async () => {
  const store = new MemoryBlobStore();
  const now = Date.now();
  const first = "A".repeat(32);
  const second = "B".repeat(32);
  const third = "C".repeat(32);

  assert.equal(await recordPresence(first, store, now), 1);
  assert.equal(await recordPresence(first, store, now + 1_000), 1);
  assert.equal(await recordPresence(second, store, now + 2_000), 2);
  assert.equal(await recordPresence(third, store, now + 3_000), 3);

  const afterWindow = now + PRESENCE_WINDOW_MS + 5_000;
  assert.equal(await recordPresence(first, store, afterWindow), 1);
  assert.deepEqual(store.calls, { get: 0, list: 0, put: 0 });
  assert.equal(store.objects.size, 0);
});

test("presence rejects arbitrary client-provided session identifiers", async () => {
  const store = new MemoryBlobStore();
  await assert.rejects(recordPresence("not-a-session", store), TypeError);
  assert.equal(store.objects.size, 0);
  assert.deepEqual(store.calls, { get: 0, list: 0, put: 0 });
});
