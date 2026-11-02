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
  markAccountConversationRead,
  markConversationReadByAdmin,
  getHostAccountIdentityFromSession,
  listVisitorAccounts,
  registerVisitorAccount,
  setVisitorAccountRole,
  updateVisitorAccountProfile,
} from "../lib/contact-inbox.mjs";

class MemoryBlobStore {
  constructor() {
    this.objects = new Map();
  }

  async put(pathname, body, options = {}) {
    if (!options.allowOverwrite && this.objects.has(pathname)) {
      throw new Error(`Object already exists: ${pathname}`);
    }
    this.objects.set(pathname, Buffer.isBuffer(body) ? Buffer.from(body) : Buffer.from(body));
    return { pathname };
  }

  async get(pathname) {
    const body = this.objects.get(pathname);
    if (!body) return null;
    return { statusCode: 200, stream: new Response(body).body };
  }

  async list({ prefix = "", limit = 1000, cursor = "" } = {}) {
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
  assert.equal(result.messages[0].pseudo, "MembreRéel");
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
