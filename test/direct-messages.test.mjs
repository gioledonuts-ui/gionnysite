import test from "node:test";
import assert from "node:assert/strict";

import {
  listVisitorAccounts,
  registerVisitorAccount,
  setVisitorAccountBadges,
  setVisitorAccountRole,
} from "../lib/contact-inbox.mjs";
import {
  acceptRequest,
  createDirectThread,
  createGroupThread,
  getThreadForMember,
  listInbox,
  pruneRefusedThreads,
  readDirectory,
  refuseRequest,
  sendDmMessage,
  toPublicMessage,
} from "../lib/direct-messages.mjs";

// Même surface que le store utilisé par le reste du projet.
class MemoryBlobStore {
  constructor() {
    this.objects = new Map();
  }

  async put(pathname, body, options = {}) {
    if (!options.allowOverwrite && this.objects.has(pathname)) throw new Error(`exists: ${pathname}`);
    this.objects.set(pathname, Buffer.from(body));
    return { pathname };
  }

  async get(pathname) {
    const body = this.objects.get(pathname);
    if (!body) return null;
    return { statusCode: 200, stream: new Response(body).body };
  }

  async list({ prefix = "", limit = 1000, cursor = "" } = {}) {
    const paths = [...this.objects.keys()].filter((path) => path.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) || 0 : 0;
    const end = Math.min(paths.length, start + limit);
    return {
      blobs: paths.slice(start, end).map((pathname) => ({ pathname })),
      hasMore: end < paths.length,
      cursor: end < paths.length ? String(end) : null,
    };
  }

  async del(paths) {
    for (const pathname of Array.isArray(paths) ? paths : [paths]) this.objects.delete(pathname);
  }
}

const register = async (store, pseudo) => {
  const created = await registerVisitorAccount({ pseudo, password: "correct-horse-battery" }, store);
  assert.equal(created.ok, true, `inscription impossible pour ${pseudo}`);
  return created;
};

const promote = async (store, pseudo, { host = false, verified = false } = {}) => {
  const { members } = await listVisitorAccounts("", store);
  const member = members.find((entry) => entry.pseudo === pseudo);
  assert.ok(member, `compte ${pseudo} introuvable`);
  if (host) assert.equal((await setVisitorAccountRole(member.id, "host", store)).ok, true);
  if (verified) assert.equal((await setVisitorAccountBadges(member.id, ["verified"], store)).ok, true);
};

const seed = async () => {
  const store = new MemoryBlobStore();
  await register(store, "Gionny");
  await promote(store, "Gionny", { host: true, verified: true });
  await register(store, "Alice");
  await promote(store, "Alice", { verified: true });
  await register(store, "Bob");
  await promote(store, "Bob", { verified: true });
  await register(store, "Simple");
  return store;
};

// ---------------------------------------------------------------------------
// Annuaire et droits
// ---------------------------------------------------------------------------

test("l'annuaire expose le rôle et le badge de chaque compte", async () => {
  const store = await seed();
  const directory = await readDirectory(store);
  assert.equal(directory.get("gionny").isHost, true);
  assert.equal(directory.get("alice").isVerified, true);
  assert.equal(directory.get("simple").isVerified, false);
});

test("un membre non Validé ne peut pas écrire en privé", async () => {
  const store = await seed();
  const result = await createDirectThread({ from: "Simple", target: "Alice", store });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not_allowed");
});

test("deux Validés ✓ ouvrent une discussion acceptée", async () => {
  const store = await seed();
  const result = await createDirectThread({ from: "Alice", target: "Bob", following: ["Bob"], store });
  assert.equal(result.ok, true);
  assert.equal(result.thread.status === undefined, true);
  assert.equal(result.thread.requestState, "accepted");
  assert.equal(result.thread.title, "Bob");
});

test("écrire à Gionny passe toujours, sans demande", async () => {
  const store = await seed();
  const result = await createDirectThread({ from: "Alice", target: "Gionny", following: [], store });
  assert.equal(result.ok, true);
  assert.equal(result.thread.requestState, "accepted");
});

test("on ne peut pas s'écrire à soi-même", async () => {
  const store = await seed();
  const result = await createDirectThread({ from: "Alice", target: "alice", store });
  assert.equal(result.reason, "self");
});

// ---------------------------------------------------------------------------
// Demandes de messages
// ---------------------------------------------------------------------------

test("une première discussion sans abonnement part en Demande", async () => {
  const store = await seed();
  const created = await createDirectThread({ from: "Alice", target: "Bob", following: [], store });
  assert.equal(created.ok, true);
  assert.equal(created.thread.requestState, "outgoing");

  const bobInbox = await listInbox({ pseudo: "Bob", store });
  assert.equal(bobInbox.requests.length, 1);
  assert.equal(bobInbox.requests[0].requestState, "incoming");
  // La boîte contient toujours la discussion officielle avec Gionny.
  assert.equal(bobInbox.inbox.filter((thread) => !thread.official).length, 0);

  // Le destinataire accepte : la discussion rejoint sa boîte de réception.
  const accepted = await acceptRequest({ pseudo: "Bob", threadId: created.thread.id, store });
  assert.equal(accepted.ok, true);
  const after = await listInbox({ pseudo: "Bob", store });
  assert.equal(after.requests.length, 0);
  assert.equal(after.inbox.filter((thread) => !thread.official).length, 1);
});

test("refuser une demande (et bloquer) la retire pour de bon", async () => {
  const store = await seed();
  const created = await createDirectThread({ from: "Alice", target: "Bob", following: [], store });
  const refused = await refuseRequest({ pseudo: "Bob", threadId: created.thread.id, block: true, store });
  assert.equal(refused.ok, true);
  const inbox = await listInbox({ pseudo: "Bob", store });
  assert.equal(inbox.requests.length, 0);
  const senderInbox = await listInbox({ pseudo: "Alice", store });
  const visible = [...senderInbox.inbox, ...senderInbox.requests, ...senderInbox.outgoing]
    .filter((thread) => !thread.official);
  assert.equal(visible.length, 0);
});

test("un message ne part pas avant l'acceptation de la demande", async () => {
  const store = await seed();
  const created = await createDirectThread({ from: "Alice", target: "Bob", following: [], store });
  const sent = await sendDmMessage({ pseudo: "Alice", threadId: created.thread.id, text: "Salut", store });
  assert.equal(sent.ok, true, "l'expéditeur peut écrire dans sa propre demande");
  const blocked = await sendDmMessage({ pseudo: "Bob", threadId: created.thread.id, text: "Non merci", store });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "request");
});

// ---------------------------------------------------------------------------
// Boîte de réception
// ---------------------------------------------------------------------------

test("la discussion officielle avec Gionny reste en tête", async () => {
  const store = await seed();
  const alice = await createDirectThread({ from: "Alice", target: "Gionny", following: [], store });
  await sendDmMessage({ pseudo: "Gionny", threadId: alice.thread.id, text: "Bienvenue chez moi", store });
  const bob = await createDirectThread({ from: "Alice", target: "Bob", following: ["Bob"], store });
  const inbox = await listInbox({ pseudo: "Alice", store });
  assert.equal(inbox.ok, true);
  assert.equal(inbox.inbox[0].title, "Gionny");
  assert.equal(inbox.inbox.some((thread) => thread.id === bob.thread.id), true);
});

test("les contacts proposés sont les Validés ✓ et Gionny uniquement", async () => {
  const store = await seed();
  const inbox = await listInbox({ pseudo: "Alice", store });
  const pseudos = inbox.contacts.map((entry) => entry.pseudo).sort();
  assert.deepEqual(pseudos, ["Bob", "Gionny"]);
  assert.equal(inbox.canStartConversation, true);

  // Un membre non Validé ne peut écrire qu'à Gionny (discussion officielle).
  const simple = await listInbox({ pseudo: "Simple", store });
  assert.equal(simple.canStartConversation, false);
  assert.deepEqual(simple.contacts.map((entry) => entry.pseudo), ["Gionny"]);
});

// ---------------------------------------------------------------------------
// Groupes
// ---------------------------------------------------------------------------

test("un groupe exige un nom et au moins deux participants", async () => {
  const store = await seed();
  const empty = await createGroupThread({ from: "Alice", members: [], store });
  assert.equal(empty.reason, "members");

  const group = await createGroupThread({ from: "Alice", members: ["Bob", "Gionny"], title: "  Team QG  ", store });
  assert.equal(group.ok, true);
  assert.equal(group.thread.kind, "group");
  assert.equal(group.thread.title, "Team QG");
  assert.equal(group.thread.participants.length, 3);
  assert.equal(group.thread.requestState, "accepted");

  // Chaque participant voit le groupe dans sa boîte.
  const bobInbox = await listInbox({ pseudo: "Bob", store });
  assert.equal(bobInbox.inbox.some((thread) => thread.kind === "group"), true);
});

test("seul un Validé ✓ peut créer un groupe", async () => {
  const store = await seed();
  const result = await createGroupThread({ from: "Simple", members: ["Alice"], store });
  assert.equal(result.reason, "not_allowed");
});

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

test("texte, compteur de non-lus et lecture", async () => {
  const store = await seed();
  const created = await createDirectThread({ from: "Alice", target: "Bob", following: ["Bob"], store });
  await sendDmMessage({ pseudo: "Alice", threadId: created.thread.id, text: "Premier", store });
  await sendDmMessage({ pseudo: "Alice", threadId: created.thread.id, text: "Deuxième", store });

  const bobInbox = await listInbox({ pseudo: "Bob", store });
  // L'officielle (Gionny) est épinglée devant : on cible notre fil.
  const bobThread = bobInbox.inbox.find((thread) => thread.id === created.thread.id);
  assert.equal(bobThread.unread, 2);

  const opened = await getThreadForMember({ pseudo: "Bob", threadId: created.thread.id, store });
  assert.equal(opened.messages.length, 2);
  assert.equal(opened.messages[1].text, "Deuxième");
  assert.equal(opened.thread.unread, 0);

  const afterRead = await listInbox({ pseudo: "Bob", store });
  assert.equal(afterRead.inbox.find((thread) => thread.id === created.thread.id).unread, 0);
});

test("un vocal et une image sont stockés et servis", async () => {
  const store = await seed();
  const created = await createDirectThread({ from: "Alice", target: "Bob", following: ["Bob"], store });
  const audio = Buffer.from("OggS-fake-audio");
  const sent = await sendDmMessage({
    pseudo: "Alice",
    threadId: created.thread.id,
    data: audio.toString("base64"),
    mimeType: "audio/ogg",
    audioPeaks: [0.2, 0.8],
    store,
  });
  assert.equal(sent.ok, true);
  assert.equal(sent.message.kind, "audio");
  assert.equal(sent.message.audioPeaks.length, 2);
  assert.ok(sent.message.mediaUrl.includes("/api/messages?media=1"));

  const image = Buffer.from("RIFF-fake-webp");
  const photo = await sendDmMessage({
    pseudo: "Bob",
    threadId: created.thread.id,
    data: image.toString("base64"),
    mimeType: "image/webp",
    text: "Regarde",
    store,
  });
  assert.equal(photo.ok, true);
  assert.equal(photo.message.kind, "image");
  assert.equal(photo.message.text, "Regarde");
});

test("un message vide ou trop lourd est refusé", async () => {
  const store = await seed();
  const created = await createDirectThread({ from: "Alice", target: "Bob", following: ["Bob"], store });
  const empty = await sendDmMessage({ pseudo: "Alice", threadId: created.thread.id, text: "   ", store });
  assert.equal(empty.reason, "invalid");
  const huge = await sendDmMessage({
    pseudo: "Alice",
    threadId: created.thread.id,
    data: Buffer.alloc(250_000).toString("base64"),
    mimeType: "audio/webm",
    store,
  });
  assert.equal(huge.reason, "audio");
});

test("un étranger ne peut pas lire une discussion", async () => {
  const store = await seed();
  const created = await createDirectThread({ from: "Alice", target: "Bob", following: ["Bob"], store });
  const foreign = await getThreadForMember({ pseudo: "Gionny", threadId: created.thread.id, store });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, "forbidden");
});

test("le format public d'un message est stable", () => {
  const message = toPublicMessage({
    version: 1,
    id: "0f0f0f0f-1111-4111-8111-111111111111",
    threadId: "0f0f0f0f-2222-4222-8222-222222222222",
    sequence: 3,
    senderKey: "alice",
    senderPseudo: "Alice",
    text: "Coucou",
    kind: "text",
    createdAt: new Date().toISOString(),
  });
  assert.deepEqual(Object.keys(message).sort(), [
    "createdAt", "id", "kind", "senderKey", "senderPseudo", "sequence", "text",
  ]);
  assert.equal(message.mediaUrl, undefined);
});

test("le nettoyage supprime les demandes restées sans message", async () => {
  const store = await seed();
  const created = await createDirectThread({ from: "Alice", target: "Bob", following: [], store });
  await refuseRequest({ pseudo: "Bob", threadId: created.thread.id, store });
  const pruned = await pruneRefusedThreads({ store });
  assert.equal(pruned.removed, 1);
});

test("chaque membre retrouve la discussion officielle de Gionny en tête", async () => {
  const store = await seed();
  // Aucun fil créé : la boîte doit tout de même proposer Gionny.
  const first = await listInbox({ pseudo: "Alice", store });
  assert.equal(first.ok, true);
  assert.equal(first.inbox.length, 1);
  assert.equal(first.inbox[0].official, true);
  assert.equal(first.inbox[0].title, "Gionny");
  assert.equal(first.inbox[0].requestState, "accepted");
  assert.equal(first.inbox[0].canSend, true);

  // Deux lectures ne créent pas de doublon.
  const second = await listInbox({ pseudo: "Alice", store });
  assert.equal(second.inbox.filter((thread) => thread.official).length, 1);

  // On peut écrire directement dans cette discussion officielle.
  const sent = await sendDmMessage({
    pseudo: "Alice", threadId: second.inbox[0].id, text: "Salut Gionny", store,
  });
  assert.equal(sent.ok, true);
});

test("un Validé ✓ non abonné passe par Demandes sauf s'il écrit à l'hôte", async () => {
  const store = await seed();
  const alice = await listInbox({ pseudo: "Alice", store });
  const official = alice.inbox[0];
  // Alice ne suit pas Gionny dans ce scénario, mais l'officielle passe toujours.
  assert.equal(official.requestState, "accepted");
  const toSimple = await createDirectThread({ from: "Alice", target: "Simple", store });
  assert.equal(toSimple.ok, false, "un compte non validé n'est pas joignable");
});
