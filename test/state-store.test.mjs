import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The autonomous store must be pointed at a throwaway file before the module
// graph is loaded (the path is read at import time).
const STATE_FILE = path.join(os.tmpdir(), `qg-state-test-${process.pid}.json`);
const ADMIN_STATE_FILE = path.join(os.tmpdir(), `qg-admin-state-test-${process.pid}.json`);
process.env.QG_STATE_FILE = STATE_FILE;
process.env.QG_ADMIN_STATE_FILE = ADMIN_STATE_FILE;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_STORE_ID;

const store = await import("../lib/blob-store.mjs");
const inbox = await import("../lib/contact-inbox.mjs");
const { isAdminRequest } = await import("../lib/admin-security.mjs");

const credentials = (token) => ({ headers: { cookie: `gionny_account_session=${token}` } });

test.after(() => {
  for (const file of [STATE_FILE, ADMIN_STATE_FILE]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
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

test("the owner account is seeded without a password and only opens once claimed", async () => {
  store.resetState();
  const owner = await inbox.ensureOwnerAccountSeeded();
  assert.equal(owner.pseudo, "Gionny");
  assert.equal(owner.role, "host");
  assert.equal(owner.passwordHash, "");

  // No bypass: the name alone never opens anything.
  for (const pseudo of ["Gionny", "  gionny ", "7gionny", "@7gionny"]) {
    const login = await inbox.loginVisitorAccount({ pseudo, password: "un-mot-de-passe" });
    assert.deepEqual(login, { ok: false, reason: "not_found" }, `login opened for ${pseudo}`);
  }

  // The first registration claims it, then the exact password is required.
  const claimed = await inbox.registerVisitorAccount({ pseudo: "Gionny", password: "un-mot-de-passe" });
  assert.equal(claimed.ok, true);
  assert.equal(claimed.account.isAdmin, true);
  assert.equal(claimed.account.isHost, true);
  assert.equal(await isAdminRequest(credentials(claimed.sessionToken)), true);

  for (const pseudo of ["Gionny", "  gionny ", "7gionny", "@7gionny"]) {
    const login = await inbox.loginVisitorAccount({ pseudo, password: "un-mot-de-passe" });
    assert.equal(login.ok, true, `login refused for ${pseudo}`);
    assert.equal(login.account.pseudo, "Gionny");
    assert.equal(login.account.isAdmin, true);
  }
  assert.deepEqual(
    await inbox.loginVisitorAccount({ pseudo: "Gionny", password: "mauvais-mot-de-passe" }),
    { ok: false, reason: "password" },
  );
});

test("registration creates the account and the exact password opens it", async () => {
  store.resetState();
  assert.deepEqual(
    await inbox.loginVisitorAccount({ pseudo: "ViewerDuQGot", password: "motdepasse" }),
    { ok: false, reason: "not_found" },
  );

  const login = await inbox.registerVisitorAccount({ pseudo: "ViewerDuQGot", password: "motdepasse" });
  assert.equal(login.ok, true);
  assert.equal(login.account.pseudo, "ViewerDuQGot");
  assert.equal(login.account.isAdmin, undefined);
  assert.equal(await isAdminRequest(credentials(login.sessionToken)), false);

  const sent = await inbox.addAccountReply(login.sessionToken, { message: "Salut Gionny !" });
  assert.equal(sent.ok, true);
  assert.equal(sent.message.pseudo, "ViewerDuQGot");

  assert.deepEqual(
    await inbox.loginVisitorAccount({ pseudo: "viewerduqgot", password: "autre-mot-de-passe" }),
    { ok: false, reason: "password" },
  );
  const again = await inbox.loginVisitorAccount({ pseudo: "viewerduqgot", password: "motdepasse" });
  assert.equal(again.ok, true);
  assert.equal(again.account.pseudo, "ViewerDuQGot");
});

test("a cold restart is repaired by the browser copy (profile + messages)", async () => {
  store.resetState();
  const login = await inbox.registerVisitorAccount({ pseudo: "MembreFidele", password: "motdepasse" });
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
  const login = await inbox.registerVisitorAccount({ pseudo: "Gionny", password: "motdepassedupatron" });
  assert.equal(login.ok, true);
  await inbox.addAccountReply(login.sessionToken, { message: "Message du patron" });
  store.resetState();
  // The browser replays the claimed owner credentials: same account, same crown.
  const restored = await inbox.restoreVisitorStateFromClient({
    pseudo: "Gionny",
    password: "motdepassedupatron",
    messages: [{ text: "Message du patron", sender: "gionny", isHost: true }],
  });
  assert.equal(restored.ok, true);
  const state = await inbox.getAccountConversation(restored.sessionToken);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].text, "Message du patron");
});

test("a login after a cold start re-attaches the existing thread instead of splitting it", async () => {
  store.resetState();
  const login = await inbox.registerVisitorAccount({ pseudo: "MembreFidele", password: "motdepasse" });
  await inbox.addAccountReply(login.sessionToken, { message: "Un message qui doit rester" });

  // The account record is lost but the conversation is still in the snapshot.
  const { readState } = store;
  const state = readState();
  for (const key of Object.keys(state.blobs)) {
    if (key.startsWith("gionny/visitor-accounts/") || key.startsWith("gionny/visitor-sessions/") || key === "gionny/visitor-host.json") {
      delete state.blobs[key];
    }
  }

  // The account record is gone, so the same credentials register it again and
  // the client sync re-attaches the thread that is still in the snapshot.
  const again = await inbox.restoreVisitorStateFromClient({
    pseudo: "MembreFidele",
    password: "motdepasse",
    messages: [{ text: "Un message qui doit rester", sender: "visitor" }],
  });
  assert.equal(again.ok, true);
  const thread = await inbox.getAccountConversation(again.sessionToken);
  assert.equal(thread.conversation.id, login.body?.conversation?.id || thread.conversation.id);
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].text, "Un message qui doit rester");
});

test("the planning and the member roles survive a restart through their own mirror", async () => {
  const { makeDefaultSiteConfig } = await import("../lib/site-config.mjs");
  store.resetState({ keepAdminSnapshot: false });

  const host = await inbox.registerVisitorAccount({ pseudo: "Gionny", password: "couronne123" });
  assert.equal(host.ok, true);
  assert.equal(host.account.role, "host");

  const config = makeDefaultSiteConfig();
  config.schedule.tuesday = { enabled: true, time: "20:30" };
  config.schedule.friday = { enabled: true, time: "21:00" };
  config.socialInfo.twitch = "Live tous les mardis";
  await store.writeSharedSiteConfig(config);

  // The admin mirror exists next to the main snapshot.
  assert.equal(fs.existsSync(ADMIN_STATE_FILE), true);

  // Cold start: RAM and the main snapshot are gone, the mirror is not.
  store.resetState();
  assert.equal(fs.existsSync(ADMIN_STATE_FILE), true);
  fs.rmSync(STATE_FILE, { force: true });
  delete globalThis[Symbol.for("__qgState")];

  const restored = await store.readSharedSiteConfig();
  assert.equal(restored.config.schedule.tuesday.time, "20:30");
  assert.equal(restored.config.schedule.friday.enabled, true);
  assert.equal(restored.config.socialInfo.twitch, "Live tous les mardis");
  assert.equal(typeof restored.updatedAt, "string");

  const members = await inbox.listVisitorAccounts("");
  assert.deepEqual(members.members.map((member) => `${member.pseudo}:${member.role}`), ["Gionny:host"]);
});

test("a newer online config always wins over the mirror", async () => {
  const { makeDefaultSiteConfig } = await import("../lib/site-config.mjs");
  store.resetState({ keepAdminSnapshot: false });

  const older = makeDefaultSiteConfig();
  older.schedule.tuesday = { enabled: true, time: "20:30" };
  await store.writeSharedSiteConfig(older);

  const newer = makeDefaultSiteConfig();
  newer.schedule.saturday = { enabled: true, time: "19:45" };
  await store.writeSharedSiteConfig(newer);

  const current = await store.readSharedSiteConfig();
  assert.equal(current.config.schedule.saturday.time, "19:45");
  assert.equal(current.config.schedule.tuesday.time, "22:00");
});
