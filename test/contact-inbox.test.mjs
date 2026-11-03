import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { isAdminRequest } from "../lib/admin-security.mjs";
import {
  addAccountReply,
  addAdminReply,
  createConversation,
  deleteConversation,
  deleteVisitorAccount,
  getAccountConversation,
  getActiveHostAccountIdentity,
  getAdminReplyIdentity,
  getConversationAudio,
  getConversationImage,
  getConversationForAdmin,
  listConversations,
  loginVisitorAccount,
  countUnreadConversations,
  addAdminAudioReply,
  startAdminConversationForAccount,
  markAccountConversationRead,
  markConversationReadByAdmin,
  getHostAccountIdentityFromSession,
  getVisitorAccountFromSession,
  clearVisitorAccountSession,
  readAccountSessionCookie,
  saveAccountSessionCookie,
  listVisitorAccounts,
  registerVisitorAccount,
  setVisitorAccountRole,
  setVisitorAccountBadges,
  updateVisitorAccountProfile,
} from "../lib/contact-inbox.mjs";

class MemoryBlobStore {
  constructor() {
    this.objects = new Map();
    this.calls = { get: 0, list: 0, put: 0 };
  }

  async put(pathname, body, options = {}) {
    this.calls.put += 1;
    if (!options.allowOverwrite && this.objects.has(pathname)) {
      throw new Error(`Object already exists: ${pathname}`);
    }
    this.objects.set(pathname, Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body));
    return { pathname };
  }

  async get(pathname) {
    this.calls.get += 1;
    const body = this.objects.get(pathname);
    if (!body) return null;
    return { statusCode: 200, stream: new Response(body).body };
  }

  async list({ prefix = "", limit = 1000, cursor = "" } = {}) {
    this.calls.list += 1;
    const paths = [...this.objects.keys()].filter((path) => path.startsWith(prefix)).sort();
    const offset = cursor ? Number(cursor) : 0;
    const start = Number.isInteger(offset) && offset >= 0 ? offset : 0;
    const end = Math.min(paths.length, start + limit);
    const hasMore = end < paths.length;
    return {
      blobs: paths.slice(start, end).map((pathname) => ({ pathname })),
      hasMore,
      cursor: hasMore ? String(end) : null,
    };
  }

  async del(paths) {
    for (const pathname of Array.isArray(paths) ? paths : [paths]) this.objects.delete(pathname);
  }
}

class SessionWriteQuotaBlobStore extends MemoryBlobStore {
  async put(pathname, body, options = {}) {
    if (pathname.startsWith("gionny/visitor-sessions/")) {
      this.calls.put += 1;
      const error = new Error("Blob storage quota reached");
      error.code = "BLOB_STORE_FULL";
      throw error;
    }
    return super.put(pathname, body, options);
  }
}

// The real outage: every write is refused (accounts, sessions, host file).
class TotalQuotaBlobStore extends MemoryBlobStore {
  async put(pathname, body, options = {}) {
    if (/^gionny\/(visitor-accounts|visitor-sessions)\//u.test(pathname) || pathname.endsWith("visitor-host.json")) {
      this.calls.put += 1;
      const error = new Error("Blob storage quota reached");
      error.code = "BLOB_STORE_FULL";
      throw error;
    }
    return super.put(pathname, body, options);
  }
}

const credentials = (token) => ({
  headers: { cookie: `gionny_account_session=${token}` },
});

async function createAccount(store, pseudo) {
  const result = await registerVisitorAccount({ pseudo, password: "correct-horse-battery" }, store);
  assert.equal(result.ok, true);
  return result;
}

async function assignHost(store, accountResult) {
  const { members } = await listVisitorAccounts("", store);
  const member = members.find((item) => item.pseudo === accountResult.account.pseudo);
  assert.ok(member);
  const result = await setVisitorAccountRole(member.id, "host", store);
  assert.equal(result.ok, true);
  return { ...accountResult, member: result.member };
}

test("trimmed case-insensitive login reconnects to the server-assigned Hôte account", async () => {
  const store = new MemoryBlobStore();
  const created = await registerVisitorAccount({
    pseudo: "  Chef  ",
    password: "correct-horse-battery",
  }, store);
  assert.equal(created.ok, true);
  assert.equal(created.account.pseudo, "Chef");
  const host = await assignHost(store, created);

  const firstLogin = await loginVisitorAccount({
    pseudo: "  cHeF  ",
    password: "correct-horse-battery",
  }, store);
  assert.equal(firstLogin.ok, true);
  assert.equal(firstLogin.account.pseudo, "Chef");
  assert.equal(firstLogin.account.role, "host");
  assert.equal(await isAdminRequest(credentials(firstLogin.sessionToken), store), true);
  assert.deepEqual(await getHostAccountIdentityFromSession(firstLogin.sessionToken, store), {
    accountId: host.member.id,
    pseudo: "Chef",
    isHost: true,
  });

  const reconnect = await loginVisitorAccount({
    pseudo: "CHEF",
    password: "correct-horse-battery",
  }, store);
  assert.equal(reconnect.ok, true);
  assert.notEqual(reconnect.sessionToken, firstLogin.sessionToken);
  assert.equal((await getHostAccountIdentityFromSession(reconnect.sessionToken, store))?.pseudo, "Chef");

  // Strict authentication: a wrong password is refused, clearly.
  const reopened = await loginVisitorAccount({ pseudo: "Chef", password: "mauvais-mot-de-passe" }, store);
  assert.deepEqual(reopened, { ok: false, reason: "password" });
  // And the case-insensitive match still needs the exact password.
  assert.deepEqual(
    await loginVisitorAccount({ pseudo: "CHEF", password: "correct-horse-battery" }, store).then((value) => value.ok),
    true,
  );
});

test("a snapshot write failure never blocks the login (signed session fallback)", async () => {
  const store = new SessionWriteQuotaBlobStore();
  const created = await registerVisitorAccount({
    pseudo: "MembreQuota",
    password: "correct-horse-battery",
  }, store);
  assert.equal(created.ok, true);
  assert.match(created.sessionToken, /^qg2\./u);
  assert.equal((await getVisitorAccountFromSession(created.sessionToken, store))?.pseudo, "MembreQuota");

  const login = await loginVisitorAccount({
    pseudo: "  membrequota  ",
    password: "correct-horse-battery",
  }, store);
  assert.equal(login.ok, true);
  assert.match(login.sessionToken, /^qg2\./u);
  assert.notEqual(login.sessionToken, created.sessionToken);
  assert.equal(readAccountSessionCookie(credentials(login.sessionToken)), login.sessionToken);

  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; } };
  saveAccountSessionCookie({ headers: { "x-forwarded-proto": "https" } }, response, login.sessionToken);
  assert.match(response.headers["Set-Cookie"], /HttpOnly; SameSite=Strict; Max-Age=604800; Secure/u);

  const [prefix, payload, signature] = login.sessionToken.split(".");
  const tamperedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  assert.equal(await getVisitorAccountFromSession(`${prefix}.${payload}.${tamperedSignature}`, store), null);

  // A login never creates an account: the pseudo must exist first.
  const unknown = await loginVisitorAccount({ pseudo: "CompteInconnu", password: "correct-horse-battery" }, store);
  assert.deepEqual(unknown, { ok: false, reason: "not_found" });
  const created2 = await registerVisitorAccount({ pseudo: "CompteInconnu", password: "correct-horse-battery" }, store);
  assert.equal(created2.ok, true);
  assert.equal(created2.account.pseudo, "CompteInconnu");
  assert.equal(await clearVisitorAccountSession(login.sessionToken, store), true);

  const sent = await addAccountReply(login.sessionToken, {
    subject: "Discussion",
    message: "La session signée retrouve bien le compte.",
  }, store);
  assert.equal(sent.ok, true);
  assert.equal(sent.message.pseudo, "MembreQuota");
});

test("the owner pseudo is claimed once by registering it, then needs its password", async () => {
  const store = new MemoryBlobStore();
  // Nothing opens by name alone any more, whatever the spelling.
  for (const pseudo of ["Gionny", "  GIONNY  ", "7gionny", "@7gionny", "@7GIONNY"]) {
    const login = await loginVisitorAccount({ pseudo, password: "nimporte-quoi" }, store);
    assert.deepEqual(login, { ok: false, reason: "not_found" }, `login opened for ${pseudo}`);
  }

  // The first registration on the owner pseudo claims it and receives the crown.
  const claimed = await registerVisitorAccount({ pseudo: "Gionny", password: "correct-horse-battery" }, store);
  assert.equal(claimed.ok, true);
  assert.equal(claimed.account.pseudo, "Gionny");
  assert.equal(claimed.account.role, "host");
  assert.equal(claimed.account.isHost, true);
  assert.equal(claimed.account.isAdmin, true);
  assert.ok(claimed.account.badges.includes("verified"));
  assert.equal(await isAdminRequest(credentials(claimed.sessionToken), store), true);
  assert.equal((await getHostAccountIdentityFromSession(claimed.sessionToken, store))?.pseudo, "Gionny");

  // It cannot be claimed twice.
  const second = await registerVisitorAccount({ pseudo: "7gionny", password: "another-correct-passphrase" }, store);
  assert.deepEqual(second, { ok: false, reason: "exists" });

  // The exact password works (any spelling of the name), a wrong one is refused.
  for (const pseudo of ["Gionny", "  GIONNY  ", "7gionny", "@7gionny"]) {
    const login = await loginVisitorAccount({ pseudo, password: "correct-horse-battery" }, store);
    assert.equal(login.ok, true, `login refused for ${pseudo}`);
    assert.equal(login.account.role, "host");
  }
  assert.deepEqual(
    await loginVisitorAccount({ pseudo: "Gionny", password: "mauvais-mot-de-passe" }, store),
    { ok: false, reason: "password" },
  );
});

test("an unknown pseudo is refused on login and only created by registering", async () => {
  const store = new MemoryBlobStore();
  assert.deepEqual(
    await loginVisitorAccount({ pseudo: "NouveauVenu", password: "un-mot-de-passe" }, store),
    { ok: false, reason: "not_found" },
  );

  const created = await registerVisitorAccount({ pseudo: "NouveauVenu", password: "un-mot-de-passe" }, store);
  assert.equal(created.ok, true);
  assert.equal(created.account.pseudo, "NouveauVenu");
  assert.equal(created.account.role, "member");
  assert.equal(created.account.isAdmin, undefined);
  assert.equal(await isAdminRequest(credentials(created.sessionToken), store), false);

  // Registering the same name again is refused, logging in with the right
  // password works, and a wrong password says "Mot de passe incorrect".
  assert.deepEqual(
    await registerVisitorAccount({ pseudo: "nouveauvenu", password: "un-mot-de-passe" }, store),
    { ok: false, reason: "exists" },
  );
  assert.equal((await loginVisitorAccount({ pseudo: "  nouveauvenu  ", password: "un-mot-de-passe" }, store)).ok, true);
  assert.deepEqual(
    await loginVisitorAccount({ pseudo: "NouveauVenu", password: "un-autre-mot-de-passe" }, store),
    { ok: false, reason: "password" },
  );
  assert.equal((await listVisitorAccounts("", store)).members.some((member) => member.pseudo === "NouveauVenu"), true);
});

test("a promoted Hôte stays Hôte after a cold restart, and a member drops back", async () => {
  const store = new MemoryBlobStore();
  const created = await createAccount(store, "Patron");

  // Cold start: a brand-new instance, same persisted objects, empty RAM.
  const coldStore = new MemoryBlobStore();
  coldStore.objects = store.objects;

  // Promotion is what grants the crown - not the pseudo.
  const host = await assignHost(coldStore, created);
  const afterPromotion = await loginVisitorAccount({ pseudo: "Patron", password: "correct-horse-battery" }, coldStore);
  assert.equal(afterPromotion.account.role, "host");
  assert.equal(await isAdminRequest(credentials(afterPromotion.sessionToken), coldStore), true);

  // Demoting takes effect immediately: the role is read from the store.
  assert.equal((await setVisitorAccountRole(host.member.id, "member", coldStore)).ok, true);
  assert.equal(await isAdminRequest(credentials(afterPromotion.sessionToken), coldStore), false);
  assert.equal((await loginVisitorAccount({ pseudo: "Patron", password: "correct-horse-battery" }, coldStore)).account.role, "member");

  // The assigned Hôte account cannot be deleted while it holds the role.
  assert.equal((await setVisitorAccountRole(host.member.id, "host", coldStore)).ok, true);
  assert.deepEqual(await deleteVisitorAccount(host.member.id, coldStore), { ok: false, reason: "host" });
});

test("a promoted Hôte stays Hôte after a cold restart, and a member drops back", async () => {
  const store = new MemoryBlobStore();
  const created = await createAccount(store, "Patron");

  // Cold start: a brand-new instance, same persisted Blob objects, empty RAM.
  const coldStore = new MemoryBlobStore();
  coldStore.objects = store.objects;

  // Before promotion, the fresh instance refuses admin access.
  const beforePromotion = await loginVisitorAccount({ pseudo: "Patron", password: "correct-horse-battery" }, coldStore);
  assert.equal(beforePromotion.ok, true);
  assert.equal(beforePromotion.account.role, "member");
  assert.equal(await isAdminRequest(credentials(beforePromotion.sessionToken), coldStore), false);

  const host = await assignHost(coldStore, created);
  const afterPromotion = await loginVisitorAccount({ pseudo: "Patron", password: "correct-horse-battery" }, coldStore);
  assert.equal(afterPromotion.account.role, "host");
  assert.equal(await isAdminRequest(credentials(afterPromotion.sessionToken), coldStore), true);

  // Demoting takes effect immediately: the role is read from the Blob.
  assert.equal((await setVisitorAccountRole(host.member.id, "member", coldStore)).ok, true);
  assert.equal(await isAdminRequest(credentials(afterPromotion.sessionToken), coldStore), false);
  assert.equal((await loginVisitorAccount({ pseudo: "Patron", password: "correct-horse-battery" }, coldStore)).account.role, "member");

  // The assigned Hôte account cannot be deleted while it holds the role.
  assert.equal((await setVisitorAccountRole(host.member.id, "host", coldStore)).ok, true);
  assert.deepEqual(await deleteVisitorAccount(host.member.id, coldStore), { ok: false, reason: "host" });
});

test("stateless sessions are renewed after pseudo or password changes", async () => {
  const store = new SessionWriteQuotaBlobStore();
  const member = await createAccount(store, "ProfilQuota");
  const oldToken = member.sessionToken;

  const renamed = await updateVisitorAccountProfile(oldToken, { pseudo: "ProfilRenomme" }, store);
  assert.equal(renamed.ok, true);
  assert.match(renamed.sessionToken, /^qg2\./u);
  assert.equal(await getVisitorAccountFromSession(oldToken, store), null);
  assert.equal((await getVisitorAccountFromSession(renamed.sessionToken, store))?.pseudo, "ProfilRenomme");

  const passwordChanged = await updateVisitorAccountProfile(renamed.sessionToken, {
    currentPassword: "correct-horse-battery",
    newPassword: "another-correct-passphrase",
  }, store);
  assert.equal(passwordChanged.ok, true);
  assert.match(passwordChanged.sessionToken, /^qg2\./u);
  assert.equal(await getVisitorAccountFromSession(renamed.sessionToken, store), null);
  assert.equal((await getVisitorAccountFromSession(passwordChanged.sessionToken, store))?.pseudo, "ProfilRenomme");
  // Only the new password opens the account: the old one is refused.
  assert.deepEqual(
    await loginVisitorAccount({ pseudo: "ProfilRenomme", password: "correct-horse-battery" }, store),
    { ok: false, reason: "password" },
  );
  assert.equal((await loginVisitorAccount({ pseudo: "ProfilRenomme", password: "another-correct-passphrase" }, store)).ok, true);
});

test("registration trims the pseudo and refuses names that cannot work", async () => {
  const store = new MemoryBlobStore();
  assert.deepEqual(await registerVisitorAccount({ pseudo: "  ab  ", password: "correct-horse-battery" }, store), {
    ok: false,
    reason: "pseudo",
  });
  assert.deepEqual(await registerVisitorAccount({ pseudo: "abcdefghijklmnopq", password: "correct-horse-battery" }, store), {
    ok: false,
    reason: "pseudo",
  });
  // The password rule is enforced at registration: 8 characters minimum.
  assert.deepEqual(await registerVisitorAccount({ pseudo: "  MembreValide  ", password: "short" }, store), {
    ok: false,
    reason: "password_invalid",
  });
  const trimmed = await registerVisitorAccount({ pseudo: "  MembreValide  ", password: "un-mot-de-passe" }, store);
  assert.equal(trimmed.ok, true);
  assert.equal(trimmed.account.pseudo, "MembreValide");
});

test("account messages persist and return the exact account pseudo", async () => {
  const store = new MemoryBlobStore();
  const member = await createAccount(store, "MembreTest");
  const sent = await addAccountReply(member.sessionToken, {
    subject: "💬 Discussion",
    message: "Bonjour depuis mon compte.",
  }, store);

  assert.equal(sent.ok, true);
  assert.equal(sent.message.sender, "visitor");
  assert.equal(sent.message.pseudo, "MembreTest");
  assert.equal(sent.message.isHost, false);

  const conversation = await getAccountConversation(member.sessionToken, store);
  assert.equal(conversation.conversation.pseudo, "MembreTest");
  assert.equal(conversation.messages[0].pseudo, "MembreTest");

  const storedPath = [...store.objects.keys()].find((path) => path.startsWith(`gionny/conversation-messages/${sent.conversation.id}/`));
  const storedMessage = JSON.parse(store.objects.get(storedPath).toString("utf8"));
  assert.equal(storedMessage.pseudo, "MembreTest");
});

test("unchanged member polls skip Blob message lists and incremental polls read only new sequenced messages", async () => {
  const store = new MemoryBlobStore();
  const member = await createAccount(store, "MembreIncrem");
  const sent = await addAccountReply(member.sessionToken, {
    subject: "Discussion",
    message: "Premier message.",
  }, store);
  const initial = await getAccountConversation(member.sessionToken, store);
  assert.equal(initial.messages.length, 1);

  store.calls = { get: 0, list: 0, put: 0 };
  const unchanged = await getAccountConversation(member.sessionToken, store, {
    afterSequence: initial.conversation.messageCount,
  });
  assert.equal(unchanged.messagesComplete, false);
  assert.deepEqual(unchanged.messages, []);
  assert.equal(store.calls.list, 0);
  // The conversation metadata is now served from the RAM mirror, so an
  // unchanged poll costs at most the 4 account/thread reads it used to.
  assert.ok(store.calls.get <= 4, `expected at most 4 Blob reads, got ${store.calls.get}`);

  await addAdminReply(sent.conversation.id, "Nouvelle réponse.", { pseudo: "HoteExact", isHost: true }, store);
  store.calls = { get: 0, list: 0, put: 0 };
  const incremental = await getAccountConversation(member.sessionToken, store, {
    afterSequence: initial.conversation.messageCount,
  });
  assert.equal(incremental.messagesComplete, false);
  assert.equal(incremental.messages.length, 1);
  assert.equal(incremental.messages[0].sequence, 2);
  assert.equal(incremental.messages[0].pseudo, "HoteExact");
  assert.equal(store.calls.list, 1);
  // Fewer Blob reads than before: cached metadata is not fetched again.
  assert.ok(store.calls.get <= 6, `expected at most 6 Blob reads, got ${store.calls.get}`);
});

test("conversation rows resolve owner records directly without rescanning the account directory", async () => {
  const store = new MemoryBlobStore();
  for (const pseudo of ["MembreListeA", "MembreListeB"]) {
    const member = await createAccount(store, pseudo);
    await addAccountReply(member.sessionToken, { subject: "Discussion", message: `Message de ${pseudo}.` }, store);
  }

  store.calls = { get: 0, list: 0, put: 0 };
  const page = await listConversations("", store);
  assert.equal(page.conversations.length, 2);
  assert.equal(store.calls.list, 1);
});

test("unchanged Admin thread polls skip the Blob message list after receipts are recorded", async () => {
  const store = new MemoryBlobStore();
  const member = await createAccount(store, "MembreAdminPoll");
  const sent = await addAccountReply(member.sessionToken, {
    subject: "Discussion",
    message: "À lire une fois.",
  }, store);
  const initial = await getConversationForAdmin(sent.conversation.id, store, { markRead: true });
  assert.equal(initial.messages[0].read, true);

  store.calls = { get: 0, list: 0, put: 0 };
  const unchanged = await getConversationForAdmin(sent.conversation.id, store, {
    afterSequence: initial.conversation.messageCount,
    markRead: true,
  });
  assert.equal(unchanged.messagesComplete, false);
  assert.deepEqual(unchanged.messages, []);
  assert.equal(store.calls.list, 0);
});

test("verified badges and 38-bar voice peaks persist across member and Admin views", async () => {
  const store = new MemoryBlobStore();
  const member = await createAccount(store, "MembreVerifie");
  const memberId = (await listVisitorAccounts("", store)).members[0].id;
  const given = await setVisitorAccountBadges(memberId, ["verified"], store);
  assert.equal(given.ok, true);
  assert.deepEqual(given.member.badges, ["verified"]);

  const first = await addAccountReply(member.sessionToken, {
    subject: "💬 Discussion",
    message: "Mon badge est visible.",
  }, store);
  assert.equal(first.ok, true);
  assert.equal(first.conversation.subject, "Discussion");
  assert.deepEqual(first.message.badges, ["verified"]);

  const peaks = Array.from({ length: 38 }, (_, index) => (index % 10) / 10);
  const audioBytes = Buffer.from("private-member-voice");
  const voice = await addAccountReply(member.sessionToken, {
    subject: "Discussion",
    message: "",
    audioBytes,
    audioMimeType: "audio/webm",
    audioPeaks: peaks,
  }, store);
  assert.equal(voice.ok, true);
  assert.equal(voice.message.kind, "audio");
  assert.deepEqual(voice.message.audioPeaks, peaks);
  assert.deepEqual(voice.message.badges, ["verified"]);

  const memberThread = await getAccountConversation(member.sessionToken, store);
  assert.deepEqual(memberThread.conversation.memberBadges, ["verified"]);
  assert.deepEqual(memberThread.messages[1].audioPeaks, peaks);
  assert.deepEqual(memberThread.messages[1].badges, ["verified"]);
  const adminThread = await getConversationForAdmin(voice.conversation.id, store);
  assert.deepEqual(adminThread.conversation.memberBadges, ["verified"]);
  assert.deepEqual(adminThread.messages[1].audioPeaks, peaks);
  assert.deepEqual(adminThread.messages[1].badges, ["verified"]);

  const removed = await setVisitorAccountBadges(memberId, [], store);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.member.badges, []);
  const refreshed = await getConversationForAdmin(voice.conversation.id, store);
  assert.deepEqual(refreshed.conversation.memberBadges, []);
  assert.deepEqual(refreshed.messages[0].badges, []);
});

test("a client-provided Hôte flag cannot turn an unassigned account into the Hôte", async () => {
  const store = new MemoryBlobStore();
  const member = await createAccount(store, "MembreTest");
  const memberId = (await listVisitorAccounts("", store)).members[0].id;
  const conversation = await createConversation({
    pseudo: member.account.pseudo,
    accountId: memberId,
    isHost: true,
    message: "Message côté membre.",
  }, store);

  assert.equal(conversation.conversation.isHost, false);
  assert.equal(conversation.messages[0].sender, "visitor");
  assert.equal(conversation.messages[0].pseudo, "MembreTest");
  assert.equal(conversation.messages[0].isHost, false);
});

test("historical messages inherit the linked pseudo and never expose the legacy Visiteur identity", async () => {
  const store = new MemoryBlobStore();
  const id = randomUUID();
  const accountId = randomUUID();
  const createdAt = new Date().toISOString();
  const metadata = {
    version: 1,
    id,
    pseudo: "MembreRéel",
    subject: "💬 Discussion",
    status: "open",
    createdAt,
    updatedAt: createdAt,
    messageCount: 1,
    lastMessagePreview: "Ancien message",
    lastMessageSender: "visitor",
    adminUnread: true,
    favorite: false,
    hasAudio: false,
    accountId,
    isHost: false,
    tokenHash: "a".repeat(64),
  };
  const oldMessage = {
    version: 1,
    id: randomUUID(),
    sequence: 1,
    sender: "visitor",
    text: "Ancien message",
    createdAt,
  };
  await store.put(`gionny/conversations/${id}.json`, JSON.stringify(metadata));
  await store.put(`gionny/conversation-messages/${id}/${String(Date.now()).padStart(13, "0")}-${randomUUID()}.json`, JSON.stringify(oldMessage));

  const result = await getConversationForAdmin(id, store);
  assert.equal(result.conversation.pseudo, "MembreRéel");
  assert.equal(result.conversation.subject, "Discussion");
  assert.equal(result.messages[0].pseudo, "MembreRéel");
  const filteredByLegacySubject = await listConversations("", store, { subject: "💬 Discussion" });
  assert.ok(filteredByLegacySubject.conversations.some((conversation) => conversation.id === id));
  assert.equal(result.messages[0].sender, "visitor");
  assert.equal(result.messages[0].isHost, false);

  const legacyId = randomUUID();
  await store.put(`gionny/conversations/${legacyId}.json`, JSON.stringify({
    ...metadata,
    id: legacyId,
    pseudo: "Visiteur",
    accountId: undefined,
  }));
  const legacyView = await getConversationForAdmin(legacyId, store);
  assert.equal(legacyView.conversation.pseudo, "Membre inconnu");
});

test("Admin can start an empty member thread and send a private vocal without a fake opening message", async () => {
  const store = new MemoryBlobStore();
  const member = await createAccount(store, "MembreVocal");
  const memberId = (await listVisitorAccounts("", store)).members.find((item) => item.pseudo === "MembreVocal").id;
  const adminIdentity = { pseudo: "Gionny", isHost: true };

  const started = await startAdminConversationForAccount(memberId, adminIdentity, store);
  assert.equal(started.ok, true);
  assert.equal(started.created, true);
  assert.equal(started.conversation.messageCount, 0);
  assert.equal(started.messages.length, 0);
  assert.equal(await countUnreadConversations(store), 0);
  assert.equal([...store.objects.keys()].some((path) => path.startsWith(`gionny/conversation-messages/${started.conversation.id}/`)), false);

  const memberView = await getAccountConversation(member.sessionToken, store);
  assert.equal(memberView.conversation.id, started.conversation.id);
  assert.equal(memberView.messages.length, 0);

  const openedAgain = await startAdminConversationForAccount(memberId, adminIdentity, store);
  assert.equal(openedAgain.created, false);
  assert.equal(openedAgain.conversation.id, started.conversation.id);

  const audioBytes = Buffer.from("private-admin-voice");
  const audioReply = await addAdminAudioReply(started.conversation.id, audioBytes, "audio/webm;codecs=opus", adminIdentity, store);
  assert.equal(audioReply.ok, true);
  assert.equal(audioReply.message.sequence, 1);
  assert.equal(audioReply.message.sender, "gionny");
  assert.equal(audioReply.message.pseudo, "Gionny");
  assert.equal(audioReply.message.kind, "audio");
  assert.deepEqual((await getConversationAudio(started.conversation.id, audioReply.message.id, store)).bytes, audioBytes);

  const memberReply = await addAccountReply(member.sessionToken, {
    subject: "💬 Discussion",
    message: "Merci pour le vocal.",
  }, store);
  assert.equal(memberReply.ok, true);
  assert.equal(await countUnreadConversations(store), 1);
  assert.equal(await markConversationReadByAdmin(started.conversation.id, store), true);
  assert.equal(await countUnreadConversations(store), 0);
});

test("only the server-assigned Hôte session gets Admin access and replies as that Hôte", async () => {
  const store = new MemoryBlobStore();
  const member = await createAccount(store, "MembreTest");
  const host = await assignHost(store, await createAccount(store, "GionnyHost"));
  const conversation = await addAccountReply(member.sessionToken, {
    subject: "💬 Discussion",
    message: "Une question privée.",
  }, store);

  assert.equal(await isAdminRequest({ ...credentials(member.sessionToken), body: { role: "host" } }, store), false);
  assert.equal(await isAdminRequest({ ...credentials(host.sessionToken), body: { role: "member" } }, store), true);
  assert.deepEqual(await getHostAccountIdentityFromSession(host.sessionToken, store), {
    accountId: host.member.id,
    pseudo: "GionnyHost",
    isHost: true,
  });
  assert.deepEqual(await getAdminReplyIdentity(credentials(host.sessionToken), store), {
    accountId: host.member.id,
    pseudo: "GionnyHost",
    isHost: true,
  });

  const reply = await addAdminReply(conversation.conversation.id, "Réponse du panneau.", await getAdminReplyIdentity(credentials(host.sessionToken), store), store);
  assert.equal(reply.ok, true);
  assert.equal(reply.message.sender, "gionny");
  assert.equal(reply.message.pseudo, "GionnyHost");
  assert.equal(reply.message.isHost, true);

  const refreshed = await getAccountConversation(member.sessionToken, store);
  assert.equal(refreshed.messages.at(-1).pseudo, "GionnyHost");
  assert.equal(refreshed.messages.at(-1).isHost, true);
  const adminView = await getConversationForAdmin(conversation.conversation.id, store);
  assert.equal(adminView.messages.at(-1).pseudo, "GionnyHost");
  assert.equal(adminView.messages.at(-1).isHost, true);
});

test("Admin replies retain the Gionny identity when no Hôte account is assigned", async () => {
  const store = new MemoryBlobStore();
  const member = await createAccount(store, "MembreTest");
  const sent = await addAccountReply(member.sessionToken, {
    subject: "💬 Discussion",
    message: "Question pour Gionny.",
  }, store);
  const identity = await getAdminReplyIdentity({ headers: {} }, store);
  assert.deepEqual(identity, { pseudo: "Gionny", isHost: true });

  const reply = await addAdminReply(sent.conversation.id, "Réponse de Gionny.", identity, store);
  assert.equal(reply.ok, true);
  assert.equal(reply.message.pseudo, "Gionny");
  assert.equal(reply.message.isHost, true);
});

test("promoting a member does not rewrite explicitly recorded member messages as Hôte", async () => {
  const store = new MemoryBlobStore();
  const member = await createAccount(store, "MembreAvantRole");
  const sent = await addAccountReply(member.sessionToken, {
    subject: "💬 Discussion",
    message: "Envoyé avant le rôle Hôte.",
  }, store);
  await assignHost(store, member);

  const refreshed = await getAccountConversation(member.sessionToken, store);
  assert.equal(refreshed.account.role, "host");
  assert.equal(refreshed.messages[0].sender, "visitor");
  assert.equal(refreshed.messages[0].pseudo, "MembreAvantRole");
  assert.equal(refreshed.messages[0].isHost, false);
  assert.equal(refreshed.conversation.isHost, true);
  assert.equal(sent.message.isHost, false);
});

test("Hôte messages sent from the member account are identified as Hôte", async () => {
  const store = new MemoryBlobStore();
  const host = await assignHost(store, await createAccount(store, "GionnyHost"));
  const sent = await addAccountReply(host.sessionToken, {
    subject: "💬 Discussion",
    message: "Message envoyé depuis le compte Hôte.",
  }, store);

  assert.equal(sent.ok, true);
  assert.equal(sent.account.role, "host");
  assert.equal(sent.conversation.isHost, true);
  assert.equal(sent.conversation.adminUnread, false);
  assert.equal(sent.message.sender, "gionny");
  assert.equal(sent.message.pseudo, "GionnyHost");
  assert.equal(sent.message.isHost, true);
  const markedAsRead = await markAccountConversationRead(host.sessionToken, store);
  assert.equal(markedAsRead.changed, 0);
  const refreshed = await getAccountConversation(host.sessionToken, store);
  assert.equal(refreshed.messages[0].sender, "gionny");
  assert.equal(refreshed.messages[0].read, false);
  assert.equal(refreshed.messages[0].pseudo, "GionnyHost");
});

test("removing a member account preserves its private conversation and Blob audio", async () => {
  const store = new MemoryBlobStore();
  const member = await createAccount(store, "MembreTest");
  const audioBytes = Buffer.from("fake-private-audio-bytes");
  const sent = await addAccountReply(member.sessionToken, {
    subject: "💬 Discussion",
    message: "",
    audioBytes,
    audioMimeType: "audio/webm",
  }, store);
  assert.equal(sent.ok, true);

  const audio = await getConversationAudio(sent.conversation.id, sent.message.id, store);
  assert.deepEqual(audio.bytes, audioBytes);
  const memberId = (await listVisitorAccounts("", store)).members[0].id;
  const deleted = await deleteVisitorAccount(memberId, store);
  assert.equal(deleted.ok, true);

  const adminConversation = await getConversationForAdmin(sent.conversation.id, store);
  assert.equal(adminConversation.conversation.id, sent.conversation.id);
  assert.equal(adminConversation.messages[0].pseudo, "MembreTest");
  assert.equal(adminConversation.messages[0].kind, "audio");
  const retainedAudio = await getConversationAudio(sent.conversation.id, sent.message.id, store);
  assert.deepEqual(retainedAudio.bytes, audioBytes);
  assert.equal(await getActiveHostAccountIdentity(store), null);
});

test("WebP attachments stay private, are returned to both clients, and are purged with explicit conversation deletion", async () => {
  const store = new MemoryBlobStore();
  const member = await createAccount(store, "MembreImage");
  const imageBytes = Buffer.from("RIFF0000WEBP", "ascii");
  const sent = await addAccountReply(member.sessionToken, {
    subject: "❓ Question",
    message: "Capture jointe.",
    imageBytes,
  }, store);

  assert.equal(sent.ok, true);
  assert.equal(sent.message.kind, "image");
  assert.equal(sent.message.hasImage, true);
  assert.equal(sent.message.text, "Capture jointe.");
  const image = await getConversationImage(sent.conversation.id, sent.message.id, store);
  assert.deepEqual(image.bytes, imageBytes);
  assert.equal(image.mimeType, "image/webp");

  const adminView = await getConversationForAdmin(sent.conversation.id, store);
  assert.equal(adminView.messages[0].kind, "image");
  assert.equal(adminView.messages[0].pseudo, "MembreImage");
  assert.equal(adminView.messages[0].hasImage, true);

  assert.equal(await deleteConversation(sent.conversation.id, store), true);
  assert.equal(await getConversationImage(sent.conversation.id, sent.message.id, store), null);
  assert.equal([...store.objects.keys()].some((path) => path.startsWith(`gionny/conversation-images/${sent.conversation.id}/`)), false);
});

test("profile WebP avatars are reflected in private threads, all historical messages, and Admin conversation rows", async () => {
  const store = new MemoryBlobStore();
  const member = await createAccount(store, "AvatarMembre");
  const sent = await addAccountReply(member.sessionToken, {
    subject: "💬 Discussion",
    message: "Mon avatar doit être visible.",
  }, store);
  const avatarBytes = Buffer.from("RIFF0000WEBP", "ascii");
  const avatarData = `data:image/webp;base64,${avatarBytes.toString("base64")}`;

  const updated = await updateVisitorAccountProfile(member.sessionToken, { avatarData }, store);
  assert.equal(updated.ok, true);
  assert.equal(updated.account.avatarData, avatarData);

  const thread = await getAccountConversation(member.sessionToken, store);
  assert.equal(thread.conversation.avatarData, avatarData);
  assert.equal(thread.messages[0].avatarData, avatarData);
  const listed = await listConversations("", store);
  assert.equal(listed.conversations.find((item) => item.id === sent.conversation.id).avatarData, avatarData);
  const adminThread = await getConversationForAdmin(sent.conversation.id, store);
  assert.equal(adminThread.conversation.avatarData, avatarData);
  assert.equal(adminThread.messages[0].avatarData, avatarData);
});

test("read receipts persist in both directions for member and Hôte messages", async () => {
  const store = new MemoryBlobStore();
  const member = await createAccount(store, "MembreRecu");
  const sent = await addAccountReply(member.sessionToken, {
    subject: "💬 Discussion",
    message: "Message membre.",
  }, store);
  const hostReply = await addAdminReply(sent.conversation.id, "Réponse Hôte.", { pseudo: "HoteExact", isHost: true }, store);

  assert.equal(hostReply.message.read, false);
  const memberRead = await markAccountConversationRead(member.sessionToken, store);
  assert.equal(memberRead.ok, true);
  let memberThread = await getAccountConversation(member.sessionToken, store);
  assert.equal(memberThread.messages.at(-1).read, true);

  assert.equal(await markConversationReadByAdmin(sent.conversation.id, store), true);
  const adminThread = await getConversationForAdmin(sent.conversation.id, store);
  assert.equal(adminThread.messages[0].read, true);
  memberThread = await getAccountConversation(member.sessionToken, store);
  assert.equal(memberThread.messages[0].read, true);
});
