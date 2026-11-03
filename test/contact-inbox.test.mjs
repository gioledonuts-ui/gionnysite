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

test("trimmed case-insensitive login reconnects to the server-assigned Gionny Hôte account", async () => {
  const store = new MemoryBlobStore();
  const created = await registerVisitorAccount({
    pseudo: "  Gionny  ",
    password: "correct-horse-battery",
  }, store);
  assert.equal(created.ok, true);
  assert.equal(created.account.pseudo, "Gionny");
  const host = await assignHost(store, created);

  const firstLogin = await loginVisitorAccount({
    pseudo: "  gIoNnY  ",
    password: "correct-horse-battery",
  }, store);
  assert.equal(firstLogin.ok, true);
  assert.equal(firstLogin.account.pseudo, "Gionny");
  assert.equal(firstLogin.account.role, "host");
  assert.equal(await isAdminRequest(credentials(firstLogin.sessionToken), store), true);
  assert.deepEqual(await getHostAccountIdentityFromSession(firstLogin.sessionToken, store), {
    accountId: host.member.id,
    pseudo: "Gionny",
    isHost: true,
  });

  const reconnect = await loginVisitorAccount({
    pseudo: "GIONNY",
    password: "correct-horse-battery",
  }, store);
  assert.equal(reconnect.ok, true);
  assert.notEqual(reconnect.sessionToken, firstLogin.sessionToken);
  assert.equal((await getHostAccountIdentityFromSession(reconnect.sessionToken, store))?.pseudo, "Gionny");
});

test("registration still enforces pseudo and password rules after trimming outer spaces", async () => {
  const store = new MemoryBlobStore();
  const tooShort = await registerVisitorAccount({ pseudo: "  ab  ", password: "correct-horse-battery" }, store);
  assert.deepEqual(tooShort, { ok: false, reason: "pseudo" });
  const tooLong = await registerVisitorAccount({ pseudo: "abcdefghijklmnopq", password: "correct-horse-battery" }, store);
  assert.deepEqual(tooLong, { ok: false, reason: "pseudo" });
  const tooShortPassword = await registerVisitorAccount({ pseudo: "MembreValide", password: "short" }, store);
  assert.deepEqual(tooShortPassword, { ok: false, reason: "password" });
  const trimmed = await registerVisitorAccount({ pseudo: "  MembreValide  ", password: "correct-horse-battery" }, store);
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
  assert.equal(store.calls.get, 4);

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
  assert.equal(store.calls.get, 6);
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
