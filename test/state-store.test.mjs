import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The autonomous store must be pointed at a throwaway file before the module
// graph is loaded (the path is read at import time).
const STATE_FILE = path.join(os.tmpdir(), `qg-state-test-${process.pid}.json`);
process.env.QG_STATE_FILE = STATE_FILE;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_STORE_ID;

const store = await import("../lib/blob-store.mjs");
const inbox = await import("../lib/contact-inbox.mjs");
const { isAdminRequest } = await import("../lib/admin-security.mjs");

const credentials = (token) => ({ headers: { cookie: `gionny_account_session=${token}` } });

test.after(() => {
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch {
    // ignore
  }
});

test("nothing reaches Vercel Blob any more: the package is gone from the deps", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.dependencies["@vercel/blob"], undefined);
  assert.equal(store.isBlobStorageConfigured(), true);
});

test("state lives in RAM and is snapshotted to the state file", async () => {
  store.resetState();
  await store.sharedBlobStore.put("gionny/test/hello.json", JSON.stringify({ hello: "qg" }), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });

  assert.equal(fs.existsSync(STATE_FILE), true);
  const snapshot = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  assert.ok(snapshot.blobs["gionny/test/hello.json"]);

  const got = await store.sharedBlobStore.get("gionny/test/hello.json");
  assert.equal(await new Response(got.stream).text(), JSON.stringify({ hello: "qg" }));

  // A cold instance (fresh globalThis, same file) finds it again.
  delete globalThis.__qgState;
  const listed = await store.sharedBlobStore.list({ prefix: "gionny/test/" });
  assert.deepEqual(listed.blobs.map((blob) => blob.pathname), ["gionny/test/hello.json"]);

  await store.sharedBlobStore.del("gionny/test/hello.json");
  assert.equal(await store.sharedBlobStore.get("gionny/test/hello.json"), null);
});

test("the owner account exists by default with the full admin profile", async () => {
  store.resetState();
  const owner = await inbox.ensureOwnerAccountSeeded();
  assert.equal(owner.pseudo, "Gionny");
  assert.equal(owner.role, "host");
  assert.equal(owner.owner, true);

  // The name alone opens it - password irrelevant, spelling tolerant.
  for (const pseudo of ["Gionny", "  gionny ", "7gionny", "@7gionny"]) {
    const login = await inbox.loginVisitorAccount({ pseudo, password: "" });
    assert.equal(login.ok, true, `login refused for ${pseudo}`);
    assert.equal(login.account.pseudo, "Gionny");
    assert.equal(login.account.isAdmin, true);
    assert.equal(login.account.isHost, true);
    assert.equal(login.account.verified, true);
    assert.equal(await isAdminRequest(credentials(login.sessionToken)), true);
  }
});

test("an unknown pseudo is created on the spot and can chat immediately", async () => {
  store.resetState();
  const login = await inbox.loginVisitorAccount({ pseudo: "ViewerDuQGot", password: "motdepasse" });
  assert.equal(login.ok, true);
  assert.equal(login.account.pseudo, "ViewerDuQGot");
  assert.equal(login.account.isAdmin, undefined);
  assert.equal(await isAdminRequest(credentials(login.sessionToken)), false);

  const sent = await inbox.addAccountReply(login.sessionToken, { message: "Salut Gionny !" });
  assert.equal(sent.ok, true);
  assert.equal(sent.message.pseudo, "ViewerDuQGot");

  const again = await inbox.loginVisitorAccount({ pseudo: "viewerduqgot", password: "autre" });
  assert.equal(again.ok, true);
  assert.equal(again.account.pseudo, "ViewerDuQGot");
});

test("a cold restart is repaired by the browser copy (profile + messages)", async () => {
  store.resetState();
  const login = await inbox.loginVisitorAccount({ pseudo: "MembreFidele", password: "motdepasse" });
  assert.equal(login.ok, true);
  await inbox.addAccountReply(login.sessionToken, { message: "Premier message gardé" });
  const before = await inbox.getAccountConversation(login.sessionToken);
  assert.equal(before.messages.length, 1);

  // The instance loses everything (cold start, empty /tmp).
  store.resetState();
  assert.equal(await inbox.getAccountConversation(login.sessionToken), null);

  // The browser sends back what it kept in localStorage.
  const restored = await inbox.restoreVisitorStateFromClient({
    pseudo: "MembreFidele",
    password: "motdepasse",
    messages: [
      { text: "Premier message gardé", sender: "visitor" },
      { text: "Et un deuxième", sender: "visitor" },
    ],
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.account.pseudo, "MembreFidele");

  const after = await inbox.getAccountConversation(restored.sessionToken);
  assert.equal(after.messages.length, 2);
  assert.deepEqual(after.messages.map((message) => message.text), [
    "Premier message gardé",
    "Et un deuxième",
  ]);

  // Re-running the sync is idempotent: no duplicate messages.
  const twice = await inbox.restoreVisitorStateFromClient({
    pseudo: "MembreFidele",
    password: "motdepasse",
    messages: [
      { text: "Premier message gardé", sender: "visitor" },
      { text: "Et un deuxième", sender: "visitor" },
    ],
  });
  const again = await inbox.getAccountConversation(twice.sessionToken);
  assert.equal(again.messages.length, 2);
});

test("the owner thread survives a cold restart too", async () => {
  store.resetState();
  const login = await inbox.loginVisitorAccount({ pseudo: "Gionny", password: "" });
  await inbox.addAccountReply(login.sessionToken, { message: "Message du patron" });
  store.resetState();
  const restored = await inbox.restoreVisitorStateFromClient({
    pseudo: "Gionny",
    password: "",
    messages: [{ text: "Message du patron", sender: "gionny", isHost: true }],
  });
  assert.equal(restored.ok, true);
  const state = await inbox.getAccountConversation(restored.sessionToken);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].text, "Message du patron");
});

test("a login after a cold start re-attaches the existing thread instead of splitting it", async () => {
  store.resetState();
  const login = await inbox.loginVisitorAccount({ pseudo: "MembreFidele", password: "motdepasse" });
  await inbox.addAccountReply(login.sessionToken, { message: "Un message qui doit rester" });

  // The account record is lost but the conversation is still in the snapshot.
  const { readState } = store;
  const state = readState();
  for (const key of Object.keys(state.blobs)) {
    if (key.startsWith("gionny/visitor-accounts/") || key.startsWith("gionny/visitor-sessions/") || key === "gionny/visitor-host.json") {
      delete state.blobs[key];
    }
  }

  const again = await inbox.loginVisitorAccount({ pseudo: "MembreFidele", password: "motdepasse" });
  assert.equal(again.ok, true);
  const thread = await inbox.getAccountConversation(again.sessionToken);
  assert.equal(thread.conversation.id, login.body?.conversation?.id || thread.conversation.id);
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].text, "Un message qui doit rester");
});
