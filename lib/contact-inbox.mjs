import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { del, get, list, put } from "@vercel/blob";

const LEGACY_PREFIX = "gionny/inbox/";
const CONVERSATION_PREFIX = "gionny/conversations/";
const CONVERSATION_MESSAGE_PREFIX = "gionny/conversation-messages/";
const LEGACY_PATH_PATTERN = /^gionny\/inbox\/\d{13}-[0-9a-f-]{36}\.json$/u;
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONVERSATION_PATH_PATTERN = /^gionny\/conversations\/[0-9a-f-]{36}\.json$/u;
const CONVERSATION_MESSAGE_PATH_PATTERN = /^gionny\/conversation-messages\/[0-9a-f-]{36}\/\d{13}-[0-9a-f-]{36}\.json$/u;
const VISITOR_COOKIE_NAME = "gionny_visitor_thread";
const PAGE_SIZE = 40;
const MAX_CONVERSATION_MESSAGES = 400;
const VISITOR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const blob = { del, get, list, put };

export function isContactMessagePath(pathname) {
  return typeof pathname === "string" && LEGACY_PATH_PATTERN.test(pathname);
}

export function isConversationId(id) {
  return typeof id === "string" && CONVERSATION_ID_PATTERN.test(id);
}

export function saveVisitorConversationCookie(request, response, value) {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${VISITOR_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`
  );
}

export function clearVisitorConversationCookie(request, response) {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${VISITOR_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
  );
}

export function readVisitorConversationCookie(request) {
  const cookieHeader = request.headers?.cookie;
  if (typeof cookieHeader !== "string") return "";

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== VISITOR_COOKIE_NAME) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

function isSecureRequest(request) {
  const forwardedProtocol = request.headers?.["x-forwarded-proto"];
  const protocol = typeof forwardedProtocol === "string" ? forwardedProtocol.split(",")[0].trim() : "";
  if (protocol) return protocol === "https";
  return Boolean(request.socket?.encrypted);
}

function parseVisitorCookie(value) {
  if (typeof value !== "string" || value.length > 100) return null;
  const separator = value.indexOf(".");
  if (separator !== 36) return null;
  const id = value.slice(0, separator);
  const token = value.slice(separator + 1);
  if (!isConversationId(id) || !VISITOR_TOKEN_PATTERN.test(token)) return null;
  return { id, token };
}

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function tokenMatches(token, expectedHash) {
  if (typeof token !== "string" || !VISITOR_TOKEN_PATTERN.test(token)) return false;
  if (typeof expectedHash !== "string" || !/^[0-9a-f]{64}$/u.test(expectedHash)) return false;
  const received = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function conversationPath(id) {
  return `${CONVERSATION_PREFIX}${id}.json`;
}

function conversationMessagesPrefix(id) {
  return `${CONVERSATION_MESSAGE_PREFIX}${id}/`;
}

function publicConversation(metadata) {
  return {
    id: metadata.id,
    pseudo: metadata.pseudo,
    status: metadata.status,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    messageCount: metadata.messageCount,
    lastMessagePreview: metadata.lastMessagePreview,
    lastMessageSender: metadata.lastMessageSender,
  };
}

function isValidMetadata(stored, id) {
  return (
    stored?.version === 1 &&
    stored.id === id &&
    typeof stored.pseudo === "string" &&
    ["open", "closed", "blocked"].includes(stored.status) &&
    typeof stored.createdAt === "string" &&
    Number.isFinite(Date.parse(stored.createdAt)) &&
    typeof stored.updatedAt === "string" &&
    Number.isFinite(Date.parse(stored.updatedAt)) &&
    Number.isInteger(stored.messageCount) &&
    stored.messageCount >= 1 &&
    stored.messageCount <= MAX_CONVERSATION_MESSAGES &&
    typeof stored.lastMessagePreview === "string" &&
    ["visitor", "gionny"].includes(stored.lastMessageSender) &&
    typeof stored.tokenHash === "string" &&
    /^[0-9a-f]{64}$/u.test(stored.tokenHash)
  );
}

async function readPrivateJson(pathname, store = blob) {
  const result = await store.get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  return JSON.parse(await new Response(result.stream).text());
}

async function readConversationMetadata(id, store = blob) {
  if (!isConversationId(id)) return null;
  const stored = await readPrivateJson(conversationPath(id), store);
  return isValidMetadata(stored, id) ? stored : null;
}

function isValidConversationMessage(stored) {
  return (
    stored?.version === 1 &&
    Number.isInteger(stored.sequence) &&
    stored.sequence >= 1 &&
    stored.sequence <= MAX_CONVERSATION_MESSAGES &&
    typeof stored.id === "string" &&
    ["visitor", "gionny"].includes(stored.sender) &&
    typeof stored.text === "string" &&
    stored.text.length > 0 &&
    stored.text.length <= 1500 &&
    typeof stored.createdAt === "string" &&
    Number.isFinite(Date.parse(stored.createdAt))
  );
}

async function readConversationMessage(pathname, store = blob) {
  if (!CONVERSATION_MESSAGE_PATH_PATTERN.test(pathname)) return null;
  const stored = await readPrivateJson(pathname, store);
  if (!isValidConversationMessage(stored)) return null;
  return {
    id: stored.id,
    sequence: stored.sequence,
    sender: stored.sender,
    text: stored.text,
    createdAt: stored.createdAt,
  };
}

async function listMessagesForConversation(id, store = blob) {
  const page = await store.list({
    prefix: conversationMessagesPrefix(id),
    limit: MAX_CONVERSATION_MESSAGES,
  });
  const messages = (await Promise.all(
    page.blobs
      .filter(({ pathname }) => CONVERSATION_MESSAGE_PATH_PATTERN.test(pathname))
      .map(({ pathname }) => readConversationMessage(pathname, store))
  ))
    .filter(Boolean)
    .sort((left, right) => left.sequence - right.sequence || Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
  return messages;
}

async function writeConversationMessage(id, sequence, sender, text, store = blob) {
  const createdAt = new Date().toISOString();
  const message = { version: 1, id: randomUUID(), sequence, sender, text, createdAt };
  const pathname = `${conversationMessagesPrefix(id)}${Date.now()}-${randomUUID()}.json`;
  await store.put(pathname, JSON.stringify(message), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: "application/json; charset=utf-8",
  });
  return { id: message.id, sequence, sender, text, createdAt };
}

async function writeMetadata(metadata, store = blob) {
  await store.put(conversationPath(metadata.id), JSON.stringify(metadata), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
  });
}

export async function saveContactMessage({ pseudo, message }) {
  const createdAt = new Date().toISOString();
  const pathname = `${LEGACY_PREFIX}${Date.now()}-${randomUUID()}.json`;
  const body = JSON.stringify({ version: 1, createdAt, pseudo, message });

  await put(pathname, body, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: "application/json; charset=utf-8",
  });

  return { createdAt };
}

export async function createConversation({ pseudo, message }, store = blob) {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const createdAt = new Date().toISOString();
  const initialMessage = {
    version: 1,
    id: randomUUID(),
    sequence: 1,
    sender: "visitor",
    text: message,
    createdAt,
  };
  const messagePath = `${conversationMessagesPrefix(id)}${Date.now()}-${randomUUID()}.json`;
  const metadata = {
    version: 1,
    id,
    pseudo,
    status: "open",
    createdAt,
    updatedAt: createdAt,
    messageCount: 1,
    lastMessagePreview: message.slice(0, 180),
    lastMessageSender: "visitor",
    tokenHash: hashToken(token),
  };

  await store.put(messagePath, JSON.stringify(initialMessage), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: "application/json; charset=utf-8",
  });
  try {
    await writeMetadata(metadata, store);
  } catch (error) {
    await store.del(messagePath).catch(() => {});
    throw error;
  }

  return {
    conversation: publicConversation(metadata),
    messages: [{ id: initialMessage.id, sequence: 1, sender: "visitor", text: message, createdAt }],
    cookieValue: `${id}.${token}`,
  };
}

export async function getVisitorConversation(cookieValue, store = blob) {
  const session = parseVisitorCookie(cookieValue);
  if (!session) return null;
  const metadata = await readConversationMetadata(session.id, store);
  if (!metadata || !tokenMatches(session.token, metadata.tokenHash)) return null;
  return {
    conversation: publicConversation(metadata),
    messages: await listMessagesForConversation(session.id, store),
  };
}

export async function addVisitorReply(cookieValue, text, store = blob) {
  const session = parseVisitorCookie(cookieValue);
  if (!session) return { ok: false, reason: "not_found" };
  const metadata = await readConversationMetadata(session.id, store);
  if (!metadata || !tokenMatches(session.token, metadata.tokenHash)) {
    return { ok: false, reason: "not_found" };
  }
  if (metadata.status === "blocked") return { ok: false, reason: "blocked" };
  if (metadata.status === "closed") return { ok: false, reason: "closed" };
  if (metadata.messageCount >= MAX_CONVERSATION_MESSAGES) return { ok: false, reason: "limit" };

  const message = await writeConversationMessage(session.id, metadata.messageCount + 1, "visitor", text, store);
  const updated = {
    ...metadata,
    updatedAt: message.createdAt,
    messageCount: metadata.messageCount + 1,
    lastMessagePreview: text.slice(0, 180),
    lastMessageSender: "visitor",
  };
  await writeMetadata(updated, store);
  return { ok: true, conversation: publicConversation(updated), message };
}

export async function listContactMessages(cursor = "") {
  const page = await list({
    prefix: LEGACY_PREFIX,
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
  });

  const messages = (await Promise.all(page.blobs.map(({ pathname }) => readLegacyMessage(pathname))))
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

  const hasMore = page.hasMore === true && typeof page.cursor === "string";
  return {
    messages,
    hasMore,
    cursor: hasMore ? page.cursor : null,
  };
}

async function readLegacyMessage(pathname) {
  try {
    const result = await get(pathname, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;

    const stored = JSON.parse(await new Response(result.stream).text());
    if (
      stored?.version !== 1 ||
      typeof stored.pseudo !== "string" ||
      typeof stored.message !== "string" ||
      typeof stored.createdAt !== "string" ||
      !Number.isFinite(Date.parse(stored.createdAt))
    ) {
      return null;
    }

    return {
      id: pathname,
      pseudo: stored.pseudo,
      message: stored.message,
      createdAt: stored.createdAt,
    };
  } catch {
    // Ignore a damaged message without blocking the rest of the inbox.
    return null;
  }
}

export async function listConversations(cursor = "", store = blob) {
  const page = await store.list({
    prefix: CONVERSATION_PREFIX,
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
  });

  const conversations = (await Promise.all(
    page.blobs
      .filter(({ pathname }) => CONVERSATION_PATH_PATTERN.test(pathname))
      .map(async ({ pathname }) => {
        const stored = await readPrivateJson(pathname, store);
        const id = pathname.slice(CONVERSATION_PREFIX.length, -5);
        return isValidMetadata(stored, id) ? publicConversation(stored) : null;
      })
  ))
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));

  const hasMore = page.hasMore === true && typeof page.cursor === "string";
  return { conversations, hasMore, cursor: hasMore ? page.cursor : null };
}

export async function getConversationForAdmin(id, store = blob) {
  const metadata = await readConversationMetadata(id, store);
  if (!metadata) return null;
  return {
    conversation: publicConversation(metadata),
    messages: await listMessagesForConversation(id, store),
  };
}

export async function addAdminReply(id, text, store = blob) {
  const metadata = await readConversationMetadata(id, store);
  if (!metadata) return { ok: false, reason: "not_found" };
  if (metadata.status === "blocked") return { ok: false, reason: "blocked" };
  if (metadata.status === "closed") return { ok: false, reason: "closed" };
  if (metadata.messageCount >= MAX_CONVERSATION_MESSAGES) return { ok: false, reason: "limit" };

  const message = await writeConversationMessage(id, metadata.messageCount + 1, "gionny", text, store);
  const updated = {
    ...metadata,
    updatedAt: message.createdAt,
    messageCount: metadata.messageCount + 1,
    lastMessagePreview: text.slice(0, 180),
    lastMessageSender: "gionny",
  };
  await writeMetadata(updated, store);
  return { ok: true, conversation: publicConversation(updated), message };
}

export async function setConversationStatus(id, status, store = blob) {
  if (!["open", "closed", "blocked"].includes(status)) return false;
  const metadata = await readConversationMetadata(id, store);
  if (!metadata) return false;
  const updated = { ...metadata, status, updatedAt: new Date().toISOString() };
  await writeMetadata(updated, store);
  return publicConversation(updated);
}

export async function deleteConversation(id, store = blob) {
  if (!isConversationId(id)) return false;
  const metadata = await readConversationMetadata(id, store);
  if (!metadata) return false;

  let cursor = "";
  do {
    const page = await store.list({
      prefix: conversationMessagesPrefix(id),
      limit: MAX_CONVERSATION_MESSAGES,
      ...(cursor ? { cursor } : {}),
    });
    const paths = page.blobs
      .map(({ pathname }) => pathname)
      .filter((pathname) => CONVERSATION_MESSAGE_PATH_PATTERN.test(pathname));
    if (paths.length) await store.del(paths);
    cursor = page.hasMore === true && typeof page.cursor === "string" ? page.cursor : "";
  } while (cursor);

  await store.del(conversationPath(id));
  return true;
}

export async function deleteContactMessage(pathname) {
  if (!isContactMessagePath(pathname)) return false;
  await del(pathname);
  return true;
}
