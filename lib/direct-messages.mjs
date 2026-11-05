import { randomUUID } from "node:crypto";

import { sharedBlobStore as blob } from "./blob-store.mjs";
import { listVisitorAccounts } from "./contact-inbox.mjs";

// ---------------------------------------------------------------------------
// Messagerie multi-DM du QG (style X)
// ---------------------------------------------------------------------------
// Un seul fichier par discussion, un fichier par message, un blob par pièce
// jointe. Rien n'est dupliqué : la discussion garde l'état (participants,
// demandes, non-lus) et les messages restent immuables une fois écrits.
//
//   gionny/dm-threads/<id>.json                       métadonnées
//   gionny/dm-messages/<id>/<000-seq>-<ts>-<uuid>.json un message
//   gionny/dm-media/<id>/<messageId>.<ext>             vocal / image
//
// Règles de la maison :
//   • Gionny (rôle Hôte) peut écrire à tout le monde ;
//   • un membre ne peut écrire qu'à un autre membre Validé ✓ (ou à Gionny) ;
//   • un premier message vers quelqu'un qui ne te suit pas part en « Demande »
//     et le destinataire doit Accepter ou Refuser ;
//   • un compte bloqué / banni n'apparaît plus et ne peut plus écrire.
// ---------------------------------------------------------------------------

const THREAD_PREFIX = "gionny/dm-threads/";
const MESSAGE_PREFIX = "gionny/dm-messages/";
const MEDIA_PREFIX = "gionny/dm-media/";
const THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MESSAGE_FILE_PATTERN = /^(\d{3})-\d{13}-([0-9a-f-]{36})\.json$/u;
const MEDIA_FILE_PATTERN = /^([0-9a-f-]{36})\.(webm|m4a|ogg|aac|3gp|webp|jpg|png)$/u;

const MAX_THREADS = 300;
const MAX_MESSAGES = 400;
const MAX_TEXT = 1500;
const MAX_AUDIO_BYTES = 200_000;
const MAX_IMAGE_BYTES = 400_000;
const MAX_GROUP_MEMBERS = 12;
const MAX_TITLE = 60;

const AUDIO_TYPES = new Map([
  ["audio/webm", "webm"],
  ["audio/mp4", "m4a"],
  ["audio/ogg", "ogg"],
  ["audio/aac", "aac"],
  ["audio/3gpp", "3gp"],
]);
const IMAGE_TYPES = new Map([
  ["image/webp", "webp"],
  ["image/jpeg", "jpg"],
  ["image/png", "png"],
]);

const DEFAULT_OFFICIAL_TITLE = "Gionny";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isDmThreadId(value) {
  return typeof value === "string" && THREAD_ID_PATTERN.test(value);
}

/** Clé d'identité : minuscules, sans @, sans espaces superflus. */
export function dmKey(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/^@+/u, "")
    .trim()
    .toLocaleLowerCase("fr-FR");
}

function cleanPseudo(value) {
  const raw = String(value ?? "")
    .normalize("NFKC")
    .replace(/^@+/u, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return raw.length >= 1 && raw.length <= 32 ? raw : "";
}

function cleanText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .trim()
    .slice(0, MAX_TEXT);
}

function threadPath(id) {
  return `${THREAD_PREFIX}${id}.json`;
}

function messagePrefix(id) {
  return `${MESSAGE_PREFIX}${id}/`;
}

function messagePath(id, sequence, messageId) {
  return `${messagePrefix(id)}${String(sequence).padStart(3, "0")}-${Date.now()}-${messageId}.json`;
}

function mediaPath(id, messageId, extension) {
  return `${MEDIA_PREFIX}${id}/${messageId}.${extension}`;
}

async function readJson(pathname, store) {
  const result = await store.get(pathname).catch(() => null);
  if (!result) return null;
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return null;
    }
  }
  const stream = result.stream || result.body || result;
  const chunks = [];
  if (stream && typeof stream[Symbol.asyncIterator] === "function") {
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  } else if (Buffer.isBuffer(stream)) {
    chunks.push(stream);
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

async function readBytes(pathname, store) {
  const result = await store.get(pathname).catch(() => null);
  if (!result) return null;
  const stream = result.stream || result.body || result;
  const chunks = [];
  if (stream && typeof stream[Symbol.asyncIterator] === "function") {
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  } else if (Buffer.isBuffer(stream)) {
    chunks.push(stream);
  }
  return chunks.length ? Buffer.concat(chunks) : null;
}

async function writeJson(pathname, value, store, { overwrite = true } = {}) {
  await store.put(pathname, JSON.stringify(value), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: overwrite,
    contentType: "application/json; charset=utf-8",
  });
  return value;
}

// ---------------------------------------------------------------------------
// Identités
// ---------------------------------------------------------------------------

/** Annuaire complet (paginé côté contact-inbox) : pseudo, rôle, badge, photo. */
export async function readDirectory(store = blob) {
  const directory = new Map();
  let cursor = "";
  let hasMore = true;
  let guard = 0;
  while (hasMore && guard < 12) {
    guard += 1;
    const page = await listVisitorAccounts(cursor, store).catch(() => ({ members: [], hasMore: false }));
    for (const member of Array.isArray(page.members) ? page.members : []) {
      const key = dmKey(member.pseudo);
      if (!key) continue;
      directory.set(key, {
        key,
        id: member.id,
        pseudo: member.pseudo,
        isHost: member.role === "host",
        isVerified: Array.isArray(member.badges) && member.badges.includes("verified"),
        banned: member.status === "banned",
        avatarData: typeof member.avatarData === "string" ? member.avatarData : "",
        discordUsername: member.discordUsername || "",
      });
    }
    hasMore = page.hasMore === true && typeof page.cursor === "string";
    cursor = hasMore ? page.cursor : "";
  }
  return directory;
}

function canStartConversation(member, target) {
  if (!member || !target) return false;
  if (member.banned || target.banned) return false;
  if (target.isHost) return true;
  // Gionny peut tout, un membre doit être Validé ✓ des deux côtés.
  return (member.isHost || member.isVerified) && target.isVerified;
}

function publicParticipant(entry) {
  return {
    pseudo: entry.pseudo,
    key: entry.key,
    isHost: entry.isHost === true,
    isVerified: entry.isVerified === true,
    ...(entry.avatarData ? { avatarData: entry.avatarData } : {}),
  };
}

// ---------------------------------------------------------------------------
// Lectures
// ---------------------------------------------------------------------------

function isValidThread(thread, id) {
  return Boolean(
    thread &&
    thread.version === 1 &&
    thread.id === id &&
    Array.isArray(thread.participants) &&
    thread.participants.length >= 1 &&
    thread.participants.every((entry) => entry && typeof entry.pseudo === "string" && typeof entry.key === "string") &&
    ["direct", "group"].includes(thread.kind) &&
    ["accepted", "pending"].includes(thread.status) &&
    typeof thread.createdAt === "string" &&
    Number.isFinite(Date.parse(thread.createdAt)) &&
    Number.isInteger(thread.messageCount)
  );
}

export async function readThread(id, store = blob) {
  if (!isDmThreadId(id)) return null;
  const stored = await readJson(threadPath(id), store);
  return isValidThread(stored, id) ? stored : null;
}

async function listThreadIds(store = blob, limit = 200) {
  const page = await store.list({ prefix: THREAD_PREFIX, limit }).catch(() => ({ blobs: [] }));
  return (Array.isArray(page.blobs) ? page.blobs : [])
    .map(({ pathname }) => pathname.slice(THREAD_PREFIX.length, -5))
    .filter((id) => isDmThreadId(id));
}

async function listThreadsFor(key, store = blob) {
  const ids = await listThreadIds(store);
  const threads = [];
  for (const id of ids) {
    const thread = await readThread(id, store);
    if (!thread) continue;
    const participant = thread.participants.find((entry) => entry.key === key);
    if (!participant) continue;
    // Un refus avec blocage retire la discussion des deux côtés.
    if ((thread.blockedBy || []).length) continue;
    threads.push(thread);
  }
  return threads.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

async function readMessageList(id, store = blob, { limit = MAX_MESSAGES, after = 0 } = {}) {
  const page = await store.list({ prefix: messagePrefix(id), limit: 200 }).catch(() => ({ blobs: [] }));
  const files = (Array.isArray(page.blobs) ? page.blobs : [])
    .map(({ pathname }) => pathname)
    .filter((pathname) => MESSAGE_FILE_PATTERN.test(pathname.slice(pathname.lastIndexOf("/") + 1)))
    .sort();
  const messages = [];
  for (const pathname of files.slice(-limit)) {
    const stored = await readJson(pathname, store);
    if (!stored || typeof stored.text !== "string") continue;
    if (Number.isInteger(after) && after > 0 && stored.sequence <= after) continue;
    messages.push(stored);
  }
  return messages.sort((left, right) => left.sequence - right.sequence);
}

function requestStateFor(thread, key) {
  // La discussion officielle avec Gionny est toujours ouverte : elle ne passe
  // jamais par « Demandes ».
  if (thread.official === true) return "accepted";
  if (thread.status === "accepted") return "accepted";
  const decision = thread.requests?.[key] || "pending";
  if (decision === "accepted") return "accepted";
  if (thread.requestOwnerKey === key) return "outgoing";
  return decision === "refused" ? "refused" : "incoming";
}

function unreadFor(thread, key) {
  const readUpTo = Number(thread.readUpTo?.[key] || 0);
  return (thread.unread?.[key] ?? Math.max(0, thread.messageCount - readUpTo));
}

/** Discussion telle que la voit un participant donné. */
export function publicThread(thread, viewerKey, directory = new Map()) {
  const others = thread.participants.filter((entry) => entry.key !== viewerKey);
  const enrich = (entry) => {
    const account = directory.get(entry.key);
    return publicParticipant({
      ...entry,
      isHost: entry.isHost === true || account?.isHost === true,
      isVerified: entry.isVerified === true || account?.isVerified === true,
      avatarData: entry.avatarData || account?.avatarData || "",
    });
  };
  const participants = thread.participants.map(enrich);
  const title = thread.kind === "group"
    ? thread.title || "Groupe"
    : others[0]?.pseudo || thread.title || DEFAULT_OFFICIAL_TITLE;
  const officialThread = thread.official === true;
  const requestState = requestStateFor(thread, viewerKey);
  return {
    id: thread.id,
    kind: thread.kind,
    official: officialThread,
    title,
    subtitle: thread.kind === "group"
      ? `${thread.participants.length} membres${others[0] ? ` · ${others.map((entry) => entry.pseudo).slice(0, 3).join(", ")}` : ""}`
      : `@${others[0]?.pseudo || title}`,
    participants,
    avatarData: thread.kind === "group" ? "" : others[0]?.avatarData || "",
    lastMessage: thread.lastMessage || null,
    messageCount: thread.messageCount,
    unread: unreadFor(thread, viewerKey),
    requestState,
    canSend: requestState === "accepted" || requestState === "outgoing",
    updatedAt: thread.updatedAt,
    createdAt: thread.createdAt,
  };
}

export function toPublicMessage(stored) {
  return {
    id: stored.id,
    sequence: stored.sequence,
    senderKey: stored.senderKey,
    senderPseudo: stored.senderPseudo,
    text: stored.text,
    kind: stored.kind || "text",
    createdAt: stored.createdAt,
    ...(stored.kind === "audio" ? { audioMimeType: stored.mediaMimeType, audioPeaks: stored.audioPeaks || [] } : {}),
    ...(stored.kind === "image" ? { imageMimeType: stored.mediaMimeType } : {}),
    ...(stored.mediaPath ? { mediaUrl: `/api/messages?media=1&thread=${stored.threadId}&message=${stored.id}` } : {}),
  };
}

// ---------------------------------------------------------------------------
// Boîte de réception
// ---------------------------------------------------------------------------

/**
 * Crée (une seule fois) la discussion officielle entre ce membre et l'hôte.
 * Sans cela, un membre n'aurait aucun fil tant qu'il n'écrit pas le premier.
 */
async function ensureOfficialThread(me, directory, store) {
  if (me.isHost) return;
  const host = [...directory.values()].find((entry) => entry.isHost && !entry.banned);
  if (!host) return;
  const threads = await listThreadsFor(me.key, store);
  const existing = threads.find(
    (thread) => thread.kind === "direct" && thread.participants.some((entry) => entry.key === host.key)
  );
  if (existing) {
    if (existing.official !== true) {
      existing.official = true;
      await writeJson(threadPath(existing.id), existing, store);
    }
    return;
  }
  await createDirectThread({ from: me.pseudo, target: host.pseudo, following: [host.pseudo], store });
}

/**
 * Boîte d'un membre : la discussion officielle avec Gionny reste toujours en
 * tête, puis les discussions acceptées, puis les demandes reçues.
 */
export async function listInbox({ pseudo, store = blob } = {}) {
  const key = dmKey(pseudo);
  if (!key) return { ok: false, reason: "unauthorized" };
  const directory = await readDirectory(store);
  const me = directory.get(key);
  if (!me) return { ok: false, reason: "not_found" };
  if (me.banned) return { ok: false, reason: "banned" };

  // Chaque membre connecté a la discussion officielle avec Gionny en tête.
  await ensureOfficialThread(me, directory, store).catch(() => {});
  const threads = await listThreadsFor(key, store);
  const inbox = [];
  const requests = [];
  const outgoing = [];
  for (const thread of threads) {
    const view = publicThread(thread, key, directory);
    if (view.requestState === "incoming") requests.push(view);
    else if (view.requestState === "outgoing") outgoing.push(view);
    else if (view.requestState === "refused") continue;
    else inbox.push(view);
  }
  inbox.sort((left, right) => {
    if (left.official !== right.official) return left.official ? -1 : 1;
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
  return {
    ok: true,
    inbox,
    requests,
    outgoing,
    // Annuaire des personnes à qui JE peux écrire (Validés ✓ + Gionny).
    contacts: [...directory.values()]
      .filter((entry) => entry.key !== key && !entry.banned && canStartConversation(me, entry))
      .map((entry) => publicParticipant(entry))
      .sort((left, right) => left.pseudo.localeCompare(right.pseudo, "fr")),
    canStartConversation: me.isHost || me.isVerified,
    unread: inbox.concat(requests).reduce((total, thread) => total + (thread.unread || 0), 0),
  };
}

// ---------------------------------------------------------------------------
// Création
// ---------------------------------------------------------------------------

function buildParticipants(entries) {
  return entries.map((entry) => ({
    key: entry.key,
    pseudo: entry.pseudo,
    ...(entry.isHost ? { isHost: true } : {}),
    ...(entry.isVerified ? { isVerified: true } : {}),
    ...(entry.avatarData ? { avatarData: entry.avatarData } : {}),
  }));
}

function follows(directory, fromKey, toKey, following) {
  if (!Array.isArray(following)) return false;
  // `following` arrive avec la casse d'affichage : on compare des clés.
  return following.some((entry) => dmKey(entry) === toKey);
}

/**
 * Ouvre (ou retrouve) une discussion directe.
 * `following` = pseudos que l'expéditeur suit déjà : s'il ne suit pas le
 * destinataire et que celui-ci ne le suit pas non plus, la discussion part en
 * demande.
 */
export async function createDirectThread({ from, target, following = [], store = blob } = {}) {
  const fromKey = dmKey(from);
  const targetKey = dmKey(target);
  if (!fromKey || !targetKey) return { ok: false, reason: "invalid" };
  if (fromKey === targetKey) return { ok: false, reason: "self" };

  const directory = await readDirectory(store);
  const me = directory.get(fromKey);
  const other = directory.get(targetKey);
  if (!me || !other) return { ok: false, reason: "not_found" };
  if (me.banned || other.banned) return { ok: false, reason: "banned" };
  if (!canStartConversation(me, other)) return { ok: false, reason: "not_allowed" };

  const existing = (await listThreadsFor(fromKey, store)).find(
    (thread) => thread.kind === "direct" && thread.participants.some((entry) => entry.key === targetKey)
  );
  if (existing) return { ok: true, thread: publicThread(existing, fromKey, directory), existing: true };

  const officialThread = me.isHost === true || other.isHost === true;
  const thread = {
    version: 1,
    id: randomUUID(),
    kind: "direct",
    title: "",
    // La discussion directe avec Gionny est « officielle » : elle reste épinglée
    // en tête de la boîte de réception.
    official: officialThread,
    status: officialThread || follows(directory, fromKey, targetKey, following) ? "accepted" : "pending",
    requestOwnerKey: fromKey,
    requests: {},
    participants: buildParticipants([me, other]),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messageCount: 0,
    readUpTo: {},
    unread: {},
    blockedBy: [],
    lastMessage: null,
  };
  if (thread.status === "pending") thread.requests[other.key] = "pending";
  await writeJson(threadPath(thread.id), thread, store);
  return { ok: true, thread: publicThread(thread, fromKey, directory), created: true };
}

export async function createGroupThread({ from, members = [], title = "", store = blob } = {}) {
  const fromKey = dmKey(from);
  if (!fromKey) return { ok: false, reason: "invalid" };
  const directory = await readDirectory(store);
  const me = directory.get(fromKey);
  if (!me) return { ok: false, reason: "not_found" };
  if (!(me.isHost || me.isVerified)) return { ok: false, reason: "not_allowed" };

  const wanted = [...new Set((Array.isArray(members) ? members : []).map(dmKey).filter(Boolean))]
    .filter((key) => key !== fromKey);
  if (wanted.length < 1) return { ok: false, reason: "members" };
  const selected = [];
  for (const key of wanted.slice(0, MAX_GROUP_MEMBERS - 1)) {
    const member = directory.get(key);
    if (!member || member.banned) return { ok: false, reason: "not_found" };
    if (!member.isHost && !member.isVerified) return { ok: false, reason: "not_allowed" };
    selected.push(member);
  }
  const groupTitle = cleanText(title).replace(/\n+/gu, " ").slice(0, MAX_TITLE) || "Groupe du QG";

  const now = new Date().toISOString();
  const thread = {
    version: 1,
    id: randomUUID(),
    kind: "group",
    title: groupTitle,
    official: false,
    status: "accepted",
    requestOwnerKey: fromKey,
    requests: {},
    participants: buildParticipants([me, ...selected]),
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    readUpTo: {},
    unread: {},
    blockedBy: [],
    lastMessage: null,
  };
  await writeJson(threadPath(thread.id), thread, store);
  return { ok: true, thread: publicThread(thread, fromKey, directory), created: true };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function getThreadForMember({ pseudo, threadId, after = 0, store = blob } = {}) {
  const key = dmKey(pseudo);
  if (!key) return { ok: false, reason: "unauthorized" };
  const thread = await readThread(threadId, store);
  if (!thread) return { ok: false, reason: "not_found" };
  if (!thread.participants.some((entry) => entry.key === key)) return { ok: false, reason: "forbidden" };
  const directory = await readDirectory(store);
  const state = requestStateFor(thread, key);
  const canRead = state === "accepted" || state === "outgoing" || state === "incoming";
  const messages = canRead ? await readMessageList(thread.id, store, { after }) : [];
  // Ouvrir la discussion vaut lecture : le compteur retombe à zéro.
  if (canRead && thread.messageCount > (thread.readUpTo?.[key] || 0)) {
    thread.readUpTo = { ...(thread.readUpTo || {}), [key]: thread.messageCount };
    thread.unread = { ...(thread.unread || {}), [key]: 0 };
    await writeJson(threadPath(thread.id), thread, store);
  }
  return {
    ok: true,
    thread: publicThread(thread, key, directory),
    messages: messages.map(toPublicMessage),
  };
}

export async function acceptRequest({ pseudo, threadId, store = blob } = {}) {
  const key = dmKey(pseudo);
  const thread = await readThread(threadId, store);
  if (!key || !thread) return { ok: false, reason: "not_found" };
  if (!thread.participants.some((entry) => entry.key === key)) return { ok: false, reason: "forbidden" };
  if (thread.kind === "group") return { ok: false, reason: "group" };
  thread.status = "accepted";
  thread.requests = { ...(thread.requests || {}), [key]: "accepted" };
  thread.updatedAt = new Date().toISOString();
  await writeJson(threadPath(thread.id), thread, store);
  const directory = await readDirectory(store);
  return { ok: true, thread: publicThread(thread, key, directory) };
}

export async function refuseRequest({ pseudo, threadId, block = false, store = blob } = {}) {
  const key = dmKey(pseudo);
  const thread = await readThread(threadId, store);
  if (!key || !thread) return { ok: false, reason: "not_found" };
  if (!thread.participants.some((entry) => entry.key === key)) return { ok: false, reason: "forbidden" };
  thread.requests = { ...(thread.requests || {}), [key]: "refused" };
  if (block) thread.blockedBy = [...new Set([...(thread.blockedBy || []), key])];
  thread.updatedAt = new Date().toISOString();
  await writeJson(threadPath(thread.id), thread, store);
  return { ok: true, refused: true, blocked: block };
}

/** Envoi d'un message (texte, image ou note vocale). */
export async function sendDmMessage(
  { pseudo, threadId, text = "", data = "", mimeType = "", audioPeaks = [], store = blob } = {}
) {
  const key = dmKey(pseudo);
  if (!key) return { ok: false, reason: "unauthorized" };
  const thread = await readThread(threadId, store);
  if (!thread) return { ok: false, reason: "not_found" };
  const sender = thread.participants.find((entry) => entry.key === key);
  if (!sender) return { ok: false, reason: "forbidden" };
  if ((thread.blockedBy || []).includes(key)) return { ok: false, reason: "blocked" };

  const state = requestStateFor(thread, key);
  if (state === "incoming") return { ok: false, reason: "request" };
  if (thread.messageCount >= MAX_MESSAGES) return { ok: false, reason: "limit" };

  const body = cleanText(text);
  let kind = "text";
  let bytes = null;
  let extension = "";
  if (typeof data === "string" && data) {
    const baseType = String(mimeType || "").split(";")[0].trim().toLowerCase();
    const base64 = data.includes(",") ? data.slice(data.indexOf(",") + 1) : data;
    bytes = Buffer.from(base64, "base64");
    if (AUDIO_TYPES.has(baseType)) {
      kind = "audio";
      extension = AUDIO_TYPES.get(baseType);
      if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) return { ok: false, reason: "audio" };
      if (body) return { ok: false, reason: "invalid" };
    } else if (IMAGE_TYPES.has(baseType)) {
      kind = "image";
      extension = IMAGE_TYPES.get(baseType);
      if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return { ok: false, reason: "image" };
    } else {
      return { ok: false, reason: "media" };
    }
  }
  if (kind === "text" && !body) return { ok: false, reason: "invalid" };

  const messageId = randomUUID();
  const now = new Date().toISOString();
  let storedMediaPath = "";
  if (bytes) {
    storedMediaPath = mediaPath(thread.id, messageId, extension);
    await store.put(storedMediaPath, bytes, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: `${kind === "audio" ? "audio" : "image"}/${extension}`,
    });
  }

  const stored = {
    version: 1,
    id: messageId,
    threadId: thread.id,
    sequence: thread.messageCount + 1,
    senderKey: key,
    senderPseudo: sender.pseudo,
    text: body,
    kind,
    createdAt: now,
    ...(storedMediaPath
      ? {
        mediaPath: storedMediaPath,
        mediaMimeType: String(mimeType).split(";")[0].trim().toLowerCase(),
        ...(kind === "audio" ? { audioPeaks: Array.isArray(audioPeaks) ? audioPeaks.slice(0, 64).map(Number).filter(Number.isFinite) : [] } : {}),
      }
      : {}),
  };
  const pathname = messagePath(thread.id, stored.sequence, messageId);
  await writeJson(pathname, stored, store);

  // Un premier message accepte implicitement l'expéditeur s'il était en attente
  // côté destinataire : « j'ai écrit et on m'a répondu ».
  const updated = {
    ...thread,
    messageCount: thread.messageCount + 1,
    updatedAt: now,
    lastMessage: {
      text: kind === "audio" ? "Note vocale" : kind === "image" ? body || "Photo" : body.slice(0, 180),
      kind,
      senderPseudo: sender.pseudo,
      senderKey: key,
      createdAt: now,
    },
    readUpTo: { ...(thread.readUpTo || {}), [key]: thread.messageCount + 1 },
  };
  updated.unread = {};
  for (const participant of thread.participants) {
    if (participant.key === key) continue;
    updated.unread[participant.key] = unreadFor(thread, participant.key) + 1;
  }
  await writeJson(threadPath(thread.id), updated, store);

  return { ok: true, message: toPublicMessage(stored), threadId: thread.id };
}

export async function getDmMedia({ threadId, messageId, store = blob } = {}) {
  if (!isDmThreadId(threadId)) return null;
  const thread = await readThread(threadId, store);
  if (!thread) return null;
  const page = await store.list({ prefix: messagePrefix(threadId), limit: 200 }).catch(() => ({ blobs: [] }));
  const pathname = (Array.isArray(page.blobs) ? page.blobs : [])
    .map((entry) => entry.pathname)
    .find((path) => path.includes(messageId));
  if (!pathname) return null;
  const stored = await readJson(pathname, store);
  if (!stored?.mediaPath || !stored.mediaPath.startsWith(`${MEDIA_PREFIX}${threadId}/`)) return null;
  const bytes = await readBytes(stored.mediaPath, store);
  if (!bytes) return null;
  return { bytes, mimeType: stored.mediaMimeType || "application/octet-stream" };
}

export async function markThreadRead({ pseudo, threadId, sequence, store = blob } = {}) {
  const key = dmKey(pseudo);
  const thread = await readThread(threadId, store);
  if (!key || !thread) return { ok: false, reason: "not_found" };
  if (!thread.participants.some((entry) => entry.key === key)) return { ok: false, reason: "forbidden" };
  const target = Number.isInteger(sequence) ? Math.min(sequence, thread.messageCount) : thread.messageCount;
  thread.readUpTo = { ...(thread.readUpTo || {}), [key]: Math.max(target, thread.readUpTo?.[key] || 0) };
  const unread = Math.max(0, thread.messageCount - thread.readUpTo[key]);
  thread.unread = { ...(thread.unread || {}), [key]: unread };
  await writeJson(threadPath(thread.id), thread, store);
  return { ok: true, unread };
}

export async function countUnreadDms({ pseudo, store = blob } = {}) {
  const inbox = await listInbox({ pseudo, store });
  if (!inbox.ok) return 0;
  return inbox.unread;
}

/** Nettoyage : une discussion dont tous les participants ont refusé disparaît. */
export async function pruneRefusedThreads({ store = blob } = {}) {
  const ids = await listThreadIds(store);
  let removed = 0;
  for (const id of ids) {
    const thread = await readThread(id, store);
    if (!thread || thread.messageCount > 0 || thread.kind === "group") continue;
    const decisions = Object.values(thread.requests || {});
    if (!decisions.length || decisions.every((value) => value === "refused")) {
      const page = await store.list({ prefix: messagePrefix(id), limit: 50 }).catch(() => ({ blobs: [] }));
      const paths = (Array.isArray(page.blobs) ? page.blobs : []).map((entry) => entry.pathname);
      if (paths.length) await store.del(paths).catch(() => {});
      await store.del(threadPath(id)).catch(() => {});
      removed += 1;
    }
  }
  return { removed, scanned: ids.length };
}

export const DM_LIMITS = {
  MAX_THREADS,
  MAX_MESSAGES,
  MAX_TEXT,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  MAX_GROUP_MEMBERS,
  MAX_TITLE,
};
