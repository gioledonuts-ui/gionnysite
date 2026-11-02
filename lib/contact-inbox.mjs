import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { del, get, list, put } from "@vercel/blob";

const LEGACY_PREFIX = "gionny/inbox/";
const CONVERSATION_PREFIX = "gionny/conversations/";
const CONVERSATION_MESSAGE_PREFIX = "gionny/conversation-messages/";
const ACCOUNT_PREFIX = "gionny/visitor-accounts/";
const ACCOUNT_SESSION_PREFIX = "gionny/visitor-sessions/";
const CONVERSATION_AUDIO_PREFIX = "gionny/conversation-audio/";
const LEGACY_PATH_PATTERN = /^gionny\/inbox\/\d{13}-[0-9a-f-]{36}\.json$/u;
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONVERSATION_PATH_PATTERN = /^gionny\/conversations\/[0-9a-f-]{36}\.json$/u;
const CONVERSATION_MESSAGE_PATH_PATTERN = /^gionny\/conversation-messages\/([0-9a-f-]{36})\/\d{13}-[0-9a-f-]{36}\.json$/u;
const AUDIO_PATH_PATTERN = /^gionny\/conversation-audio\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(webm|m4a|ogg|aac|3gp)$/u;
const ACCOUNT_COOKIE_NAME = "gionny_account_session";
const VISITOR_COOKIE_NAME = "gionny_visitor_thread";
const PAGE_SIZE = 40;
const MAX_CONVERSATION_MESSAGES = 400;
const MAX_AUDIO_BYTES = 200_000;
const ACCOUNT_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const ACCOUNT_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const ACCOUNT_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const PASSWORD_HASH_BYTES = 64;
const PASSWORD_SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const VISITOR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const CONVERSATION_SUBJECTS = [
  "🎤 Passer en live",
  "💡 Idée vidéo / React",
  "📖 Histoire / Anecdote",
  "❓ Question",
  "💬 Discussion",
];
export const DEFAULT_CONVERSATION_SUBJECT = "💬 Discussion";
const scrypt = promisify(scryptCallback);
const blob = { del, get, list, put };

export function isContactMessagePath(pathname) {
  return typeof pathname === "string" && LEGACY_PATH_PATTERN.test(pathname);
}

export function isConversationId(id) {
  return typeof id === "string" && CONVERSATION_ID_PATTERN.test(id);
}

export function isConversationSubject(subject) {
  return typeof subject === "string" && CONVERSATION_SUBJECTS.includes(subject);
}

function accountPath(keyHash) {
  return `${ACCOUNT_PREFIX}${keyHash}.json`;
}

function accountSessionPath(sessionHash) {
  return `${ACCOUNT_SESSION_PREFIX}${sessionHash}.json`;
}

function accountKeyHash(pseudo) {
  return createHash("sha256").update(pseudo.normalize("NFKC").trim().toLowerCase()).digest("hex");
}

function publicAccount(account) {
  return { pseudo: account.pseudo };
}

function cookieValue(request, name) {
  const cookieHeader = request.headers?.cookie;
  if (typeof cookieHeader !== "string") return "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return "";
}

export function saveAccountSessionCookie(request, response, value) {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${ACCOUNT_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`
  );
}

export function clearAccountSessionCookie(request, response) {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${ACCOUNT_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
  );
}

export function readAccountSessionCookie(request) {
  const token = cookieValue(request, ACCOUNT_COOKIE_NAME);
  return ACCOUNT_SESSION_TOKEN_PATTERN.test(token) ? token : "";
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
    subject: isConversationSubject(metadata.subject) ? metadata.subject : DEFAULT_CONVERSATION_SUBJECT,
    status: metadata.status,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    messageCount: metadata.messageCount,
    lastMessagePreview: metadata.lastMessagePreview,
    lastMessageSender: metadata.lastMessageSender,
    adminUnread: typeof metadata.adminUnread === "boolean" ? metadata.adminUnread : metadata.lastMessageSender === "visitor",
    favorite: metadata.favorite === true,
    hasAudio: metadata.hasAudio === true,
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
    (stored.subject === undefined || isConversationSubject(stored.subject)) &&
    (stored.adminUnread === undefined || typeof stored.adminUnread === "boolean") &&
    (stored.favorite === undefined || typeof stored.favorite === "boolean") &&
    (stored.hasAudio === undefined || typeof stored.hasAudio === "boolean") &&
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

function normalizeAccountPseudo(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isValidAccountRecord(stored, keyHash) {
  return (
    stored?.version === 1 &&
    stored.keyHash === keyHash &&
    typeof stored.id === "string" &&
    isConversationId(stored.id) &&
    typeof stored.pseudo === "string" &&
    stored.pseudo.length >= 2 &&
    stored.pseudo.length <= 32 &&
    typeof stored.passwordSalt === "string" &&
    /^[A-Za-z0-9_-]{22}$/u.test(stored.passwordSalt) &&
    typeof stored.passwordHash === "string" &&
    /^[A-Za-z0-9_-]{86}$/u.test(stored.passwordHash) &&
    (stored.conversationId === null || isConversationId(stored.conversationId)) &&
    typeof stored.createdAt === "string" &&
    Number.isFinite(Date.parse(stored.createdAt))
  );
}

function isValidAccountSession(stored) {
  return (
    stored?.version === 1 &&
    ACCOUNT_KEY_PATTERN.test(stored.accountKeyHash) &&
    typeof stored.expiresAt === "string" &&
    Number.isFinite(Date.parse(stored.expiresAt))
  );
}

async function readAccountRecord(keyHash, store = blob) {
  if (!ACCOUNT_KEY_PATTERN.test(keyHash)) return null;
  const stored = await readPrivateJson(accountPath(keyHash), store);
  return isValidAccountRecord(stored, keyHash) ? stored : null;
}

async function writeAccountRecord(account, store = blob, allowOverwrite = true) {
  await store.put(accountPath(account.keyHash), JSON.stringify(account), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite,
    contentType: "application/json; charset=utf-8",
  });
}

async function derivePasswordHash(password, salt) {
  return scrypt(password, salt, PASSWORD_HASH_BYTES, PASSWORD_SCRYPT_OPTIONS);
}

async function createAccountSession(accountHash, store = blob) {
  const token = randomBytes(32).toString("base64url");
  const record = {
    version: 1,
    accountKeyHash: accountHash,
    expiresAt: new Date(Date.now() + ACCOUNT_SESSION_TTL_MS).toISOString(),
  };
  await store.put(accountSessionPath(hashToken(token)), JSON.stringify(record), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: "application/json; charset=utf-8",
  });
  return token;
}

async function resolveAccountSession(token, store = blob) {
  if (typeof token !== "string" || !ACCOUNT_SESSION_TOKEN_PATTERN.test(token)) return null;
  const sessionPath = accountSessionPath(hashToken(token));
  const session = await readPrivateJson(sessionPath, store);
  if (!isValidAccountSession(session)) return null;
  if (Date.parse(session.expiresAt) <= Date.now()) {
    await store.del(sessionPath).catch(() => {});
    return null;
  }
  const account = await readAccountRecord(session.accountKeyHash, store);
  return account ? { account, sessionPath } : null;
}

async function linkLegacyConversation(account, legacyCookieValue, store = blob) {
  if (account.conversationId || !legacyCookieValue) return account;
  const previous = await getVisitorConversation(legacyCookieValue, store);
  if (!previous || accountKeyHash(previous.conversation.pseudo) !== account.keyHash) return account;
  const linked = { ...account, conversationId: previous.conversation.id, updatedAt: new Date().toISOString() };
  await writeAccountRecord(linked, store);
  return linked;
}

export async function registerVisitorAccount({ pseudo, password, legacyCookieValue = "" }, store = blob) {
  const cleanedPseudo = normalizeAccountPseudo(pseudo);
  if (cleanedPseudo.length < 2 || cleanedPseudo.length > 32) return { ok: false, reason: "pseudo" };
  if (typeof password !== "string" || password.length < 8 || password.length > 128) {
    return { ok: false, reason: "password" };
  }

  const keyHash = accountKeyHash(cleanedPseudo);
  if (await readAccountRecord(keyHash, store)) return { ok: false, reason: "exists" };

  const salt = randomBytes(16);
  const passwordHash = await derivePasswordHash(password, salt);
  const now = new Date().toISOString();
  let account = {
    version: 1,
    id: randomUUID(),
    keyHash,
    pseudo: cleanedPseudo,
    passwordSalt: salt.toString("base64url"),
    passwordHash: passwordHash.toString("base64url"),
    conversationId: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await writeAccountRecord(account, store, false);
  } catch (error) {
    if (await readAccountRecord(keyHash, store)) return { ok: false, reason: "exists" };
    throw error;
  }

  account = await linkLegacyConversation(account, legacyCookieValue, store);
  return { ok: true, account: publicAccount(account), sessionToken: await createAccountSession(keyHash, store) };
}

export async function loginVisitorAccount({ pseudo, password, legacyCookieValue = "" }, store = blob) {
  const cleanedPseudo = normalizeAccountPseudo(pseudo);
  if (cleanedPseudo.length < 2 || cleanedPseudo.length > 32 || typeof password !== "string" || password.length > 128) {
    return { ok: false, reason: "invalid_credentials" };
  }

  const keyHash = accountKeyHash(cleanedPseudo);
  let account = await readAccountRecord(keyHash, store);
  if (!account) return { ok: false, reason: "invalid_credentials" };

  const salt = Buffer.from(account.passwordSalt, "base64url");
  const expected = Buffer.from(account.passwordHash, "base64url");
  const received = await derivePasswordHash(password, salt);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: "invalid_credentials" };
  }

  account = await linkLegacyConversation(account, legacyCookieValue, store);
  return { ok: true, account: publicAccount(account), sessionToken: await createAccountSession(keyHash, store) };
}

export async function getVisitorAccountFromSession(token, store = blob) {
  const resolved = await resolveAccountSession(token, store);
  return resolved ? publicAccount(resolved.account) : null;
}

export async function clearVisitorAccountSession(token, store = blob) {
  if (!ACCOUNT_SESSION_TOKEN_PATTERN.test(token || "")) return false;
  await store.del(accountSessionPath(hashToken(token))).catch(() => {});
  return true;
}

async function readConversationMetadata(id, store = blob) {
  if (!isConversationId(id)) return null;
  const stored = await readPrivateJson(conversationPath(id), store);
  return isValidMetadata(stored, id) ? stored : null;
}

function isValidConversationMessage(stored, conversationId) {
  if (
    stored?.version !== 1 ||
    !Number.isInteger(stored.sequence) ||
    stored.sequence < 1 ||
    stored.sequence > MAX_CONVERSATION_MESSAGES ||
    typeof stored.id !== "string" ||
    !["visitor", "gionny"].includes(stored.sender) ||
    typeof stored.text !== "string" ||
    stored.text.length > 1500 ||
    typeof stored.createdAt !== "string" ||
    !Number.isFinite(Date.parse(stored.createdAt))
  ) {
    return false;
  }

  const kind = stored.kind || (stored.audioPath ? "audio" : "text");
  if (kind === "text") return stored.text.length > 0 && !stored.audioPath;
  if (kind !== "audio" || stored.text.length !== 0) return false;

  const audioPathMatch = typeof stored.audioPath === "string" ? AUDIO_PATH_PATTERN.exec(stored.audioPath) : null;
  const mimeType = typeof stored.audioMimeType === "string" ? stored.audioMimeType.split(";")[0].trim().toLowerCase() : "";
  return Boolean(
    audioPathMatch &&
    audioPathMatch[1] === conversationId &&
    audioPathMatch[2] === stored.id &&
    ["audio/webm", "audio/mp4", "audio/ogg", "audio/aac", "audio/3gpp"].includes(mimeType) &&
    Number.isInteger(stored.audioSize) &&
    stored.audioSize > 0 &&
    stored.audioSize <= MAX_AUDIO_BYTES
  );
}

async function readConversationMessage(pathname, store = blob) {
  const pathMatch = CONVERSATION_MESSAGE_PATH_PATTERN.exec(pathname);
  if (!pathMatch) return null;
  const stored = await readPrivateJson(pathname, store);
  const conversationId = pathMatch[1];
  if (!isValidConversationMessage(stored, conversationId)) return null;
  const kind = stored.kind || (stored.audioPath ? "audio" : "text");
  return {
    id: stored.id,
    sequence: stored.sequence,
    sender: stored.sender,
    text: stored.text,
    createdAt: stored.createdAt,
    kind,
    ...(kind === "audio"
      ? { hasAudio: true, audioMimeType: stored.audioMimeType, audioSize: stored.audioSize }
      : {}),
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
  return {
    message: { id: message.id, sequence, sender, text, createdAt, kind: "text" },
    messagePath: pathname,
  };
}

function audioFormat(mimeType) {
  if (typeof mimeType !== "string" || mimeType.length > 120) return null;
  const baseType = mimeType.split(";")[0].trim().toLowerCase();
  const extensionByType = {
    "audio/webm": "webm",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
    "audio/aac": "aac",
    "audio/3gpp": "3gp",
  };
  const extension = extensionByType[baseType];
  return extension ? { mimeType: baseType, extension } : null;
}

async function writeAudioConversationMessage(id, sequence, sender, audioBytes, mimeType, store = blob) {
  const bytes = Buffer.isBuffer(audioBytes) ? audioBytes : Buffer.from(audioBytes || []);
  const format = audioFormat(mimeType);
  if (!format || bytes.length < 1 || bytes.length > MAX_AUDIO_BYTES) {
    throw new Error("Invalid audio attachment");
  }

  const createdAt = new Date().toISOString();
  const messageId = randomUUID();
  const audioPath = `${CONVERSATION_AUDIO_PREFIX}${id}/${messageId}.${format.extension}`;
  const pathname = `${conversationMessagesPrefix(id)}${Date.now()}-${randomUUID()}.json`;
  const stored = {
    version: 1,
    id: messageId,
    sequence,
    sender,
    text: "",
    kind: "audio",
    audioPath,
    audioMimeType: format.mimeType,
    audioSize: bytes.length,
    createdAt,
  };

  await store.put(audioPath, bytes, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: format.mimeType,
  });
  try {
    await store.put(pathname, JSON.stringify(stored), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/json; charset=utf-8",
    });
  } catch (error) {
    await store.del(audioPath).catch(() => {});
    throw error;
  }

  return {
    message: {
      id: messageId,
      sequence,
      sender,
      text: "",
      createdAt,
      kind: "audio",
      hasAudio: true,
      audioMimeType: format.mimeType,
      audioSize: bytes.length,
    },
    messagePath: pathname,
    audioPath,
  };
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

export async function createConversation(
  { pseudo, message = "", subject = DEFAULT_CONVERSATION_SUBJECT, audioBytes = null, audioMimeType = "" },
  store = blob
) {
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const createdAt = new Date().toISOString();
  const hasAudio = audioBytes !== null && audioBytes !== undefined;
  let initialMessage;
  let messagePath = "";
  let audioPath = "";

  if (hasAudio) {
    const audioMessage = await writeAudioConversationMessage(id, 1, "visitor", audioBytes, audioMimeType, store);
    initialMessage = audioMessage.message;
    messagePath = audioMessage.messagePath;
    audioPath = audioMessage.audioPath;
  } else {
    const storedMessage = {
      version: 1,
      id: randomUUID(),
      sequence: 1,
      sender: "visitor",
      text: message,
      createdAt,
    };
    messagePath = `${conversationMessagesPrefix(id)}${Date.now()}-${randomUUID()}.json`;
    await store.put(messagePath, JSON.stringify(storedMessage), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/json; charset=utf-8",
    });
    initialMessage = { id: storedMessage.id, sequence: 1, sender: "visitor", text: message, createdAt, kind: "text" };
  }

  const metadata = {
    version: 1,
    id,
    pseudo,
    subject: isConversationSubject(subject) ? subject : DEFAULT_CONVERSATION_SUBJECT,
    status: "open",
    createdAt,
    updatedAt: createdAt,
    messageCount: 1,
    lastMessagePreview: hasAudio ? "🎤 Message vocal" : message.slice(0, 180),
    lastMessageSender: "visitor",
    adminUnread: true,
    favorite: false,
    hasAudio,
    tokenHash: hashToken(token),
  };

  try {
    await writeMetadata(metadata, store);
  } catch (error) {
    await store.del([messagePath, ...(audioPath ? [audioPath] : [])]).catch(() => {});
    throw error;
  }

  return {
    conversation: publicConversation(metadata),
    messages: [initialMessage],
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

export async function getAccountConversation(sessionToken, store = blob) {
  const resolved = await resolveAccountSession(sessionToken, store);
  if (!resolved) return null;
  const { account } = resolved;
  if (!account.conversationId) {
    return { account: publicAccount(account), conversation: null, messages: [] };
  }
  const metadata = await readConversationMetadata(account.conversationId, store);
  if (!metadata) return { account: publicAccount(account), conversation: null, messages: [] };
  return {
    account: publicAccount(account),
    conversation: publicConversation(metadata),
    messages: await listMessagesForConversation(metadata.id, store),
  };
}

async function createAccountThread(account, { subject, message, audioBytes, audioMimeType }, store = blob) {
  const created = await createConversation({
    pseudo: account.pseudo,
    subject,
    message,
    audioBytes,
    audioMimeType,
  }, store);
  const linkedAccount = { ...account, conversationId: created.conversation.id, updatedAt: new Date().toISOString() };
  try {
    await writeAccountRecord(linkedAccount, store);
  } catch (error) {
    await deleteConversation(created.conversation.id, store).catch(() => {});
    throw error;
  }
  return {
    ok: true,
    account: publicAccount(linkedAccount),
    conversation: created.conversation,
    message: created.messages[0],
    messages: created.messages,
  };
}

export async function addAccountReply(
  sessionToken,
  { message = "", subject = DEFAULT_CONVERSATION_SUBJECT, audioBytes = null, audioMimeType = "", newConversation = false },
  store = blob
) {
  const resolved = await resolveAccountSession(sessionToken, store);
  if (!resolved) return { ok: false, reason: "unauthorized" };
  const { account } = resolved;
  const hasAudio = audioBytes !== null && audioBytes !== undefined;
  if ((!hasAudio && (typeof message !== "string" || !message.length)) ||
      (hasAudio && (!audioFormat(audioMimeType) || !Buffer.isBuffer(audioBytes) || audioBytes.length < 1 || audioBytes.length > MAX_AUDIO_BYTES))) {
    return { ok: false, reason: "invalid_message" };
  }

  const metadata = account.conversationId
    ? await readConversationMetadata(account.conversationId, store)
    : null;
  if (!metadata) return createAccountThread(account, { subject, message, audioBytes, audioMimeType }, store);

  if (newConversation) {
    if (metadata.status === "blocked") return { ok: false, reason: "blocked" };
    if (metadata.status === "open") return { ok: false, reason: "already_open" };
    return createAccountThread(account, { subject, message, audioBytes, audioMimeType }, store);
  }
  if (metadata.status === "blocked") return { ok: false, reason: "blocked" };
  if (metadata.status === "closed") return { ok: false, reason: "closed" };
  if (metadata.messageCount >= MAX_CONVERSATION_MESSAGES) return { ok: false, reason: "limit" };

  let messageResult;
  let cleanupPaths = [];
  if (hasAudio) {
    const audioResult = await writeAudioConversationMessage(
      metadata.id,
      metadata.messageCount + 1,
      "visitor",
      audioBytes,
      audioMimeType,
      store
    );
    messageResult = audioResult.message;
    cleanupPaths = [audioResult.messagePath, audioResult.audioPath];
  } else {
    const textResult = await writeConversationMessage(metadata.id, metadata.messageCount + 1, "visitor", message, store);
    messageResult = textResult.message;
    cleanupPaths = [textResult.messagePath];
  }

  const updated = {
    ...metadata,
    updatedAt: messageResult.createdAt,
    messageCount: metadata.messageCount + 1,
    lastMessagePreview: hasAudio ? "🎤 Message vocal" : message.slice(0, 180),
    lastMessageSender: "visitor",
    adminUnread: true,
    hasAudio: metadata.hasAudio === true || hasAudio,
  };
  try {
    await writeMetadata(updated, store);
  } catch (error) {
    if (cleanupPaths.length) await store.del(cleanupPaths).catch(() => {});
    throw error;
  }
  return { ok: true, account: publicAccount(account), conversation: publicConversation(updated), message: messageResult };
}

export async function getConversationAudio(conversationId, messageId, store = blob) {
  if (!isConversationId(conversationId) || typeof messageId !== "string" || !isConversationId(messageId)) return null;
  const metadata = await readConversationMetadata(conversationId, store);
  if (!metadata) return null;
  const page = await store.list({ prefix: conversationMessagesPrefix(conversationId), limit: MAX_CONVERSATION_MESSAGES });
  for (const { pathname } of page.blobs) {
    if (!CONVERSATION_MESSAGE_PATH_PATTERN.test(pathname)) continue;
    const stored = await readPrivateJson(pathname, store);
    if (stored?.id !== messageId || !isValidConversationMessage(stored, conversationId) || (stored.kind || "text") !== "audio") continue;
    const audio = await store.get(stored.audioPath, { access: "private", useCache: false });
    if (!audio || audio.statusCode !== 200 || !audio.stream) return null;
    const bytes = Buffer.from(await new Response(audio.stream).arrayBuffer());
    if (bytes.length !== stored.audioSize) return null;
    return { bytes, mimeType: stored.audioMimeType, size: stored.audioSize };
  }
  return null;
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

  const written = await writeConversationMessage(session.id, metadata.messageCount + 1, "visitor", text, store);
  const message = written.message;
  const updated = {
    ...metadata,
    updatedAt: message.createdAt,
    messageCount: metadata.messageCount + 1,
    lastMessagePreview: text.slice(0, 180),
    lastMessageSender: "visitor",
    adminUnread: true,
  };
  try {
    await writeMetadata(updated, store);
  } catch (error) {
    await store.del(written.messagePath).catch(() => {});
    throw error;
  }
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

async function conversationHasAudio(id, store = blob) {
  const page = await store.list({ prefix: `${CONVERSATION_AUDIO_PREFIX}${id}/`, limit: 1 });
  return page.blobs.some(({ pathname }) => AUDIO_PATH_PATTERN.test(pathname));
}

export async function listConversations(cursor = "", store = blob, filters = {}) {
  const filter = ["all", "unread", "favorites", "audio"].includes(filters.filter) ? filters.filter : "all";
  const subjectFilter = isConversationSubject(filters.subject) ? filters.subject : "";
  const conversations = [];
  let nextCursor = cursor;
  let hasMore = false;

  do {
    const page = await store.list({
      prefix: CONVERSATION_PREFIX,
      limit: PAGE_SIZE,
      ...(nextCursor ? { cursor: nextCursor } : {}),
    });
    const candidates = (await Promise.all(
      page.blobs
        .filter(({ pathname }) => CONVERSATION_PATH_PATTERN.test(pathname))
        .map(async ({ pathname }) => {
          const stored = await readPrivateJson(pathname, store);
          const id = pathname.slice(CONVERSATION_PREFIX.length, -5);
          return isValidMetadata(stored, id) ? publicConversation(stored) : null;
        })
    )).filter(Boolean);

    const matches = await Promise.all(candidates.map(async (conversation) => {
      if (subjectFilter && conversation.subject !== subjectFilter) return null;
      if (filter === "unread" && !conversation.adminUnread) return null;
      if (filter === "favorites" && !conversation.favorite) return null;
      if (filter === "audio") {
        const hasAudio = conversation.hasAudio || await conversationHasAudio(conversation.id, store);
        if (!hasAudio) return null;
        conversation.hasAudio = true;
      }
      return conversation;
    }));
    conversations.push(...matches.filter(Boolean));

    hasMore = page.hasMore === true && typeof page.cursor === "string";
    nextCursor = hasMore ? page.cursor : "";
  } while (conversations.length < PAGE_SIZE && hasMore);

  conversations.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  return { conversations, hasMore, cursor: hasMore ? nextCursor : null };
}

export async function getConversationForAdmin(id, store = blob) {
  const metadata = await readConversationMetadata(id, store);
  if (!metadata) return null;
  const conversation = publicConversation(metadata);
  if (typeof metadata.hasAudio !== "boolean") {
    try {
      conversation.hasAudio = await conversationHasAudio(id, store);
    } catch {
      // A legacy audio scan should never prevent the private text thread from opening.
    }
  }
  return {
    conversation,
    messages: await listMessagesForConversation(id, store),
  };
}

export async function addAdminReply(id, text, store = blob) {
  const metadata = await readConversationMetadata(id, store);
  if (!metadata) return { ok: false, reason: "not_found" };
  if (metadata.status === "blocked") return { ok: false, reason: "blocked" };
  if (metadata.status === "closed") return { ok: false, reason: "closed" };
  if (metadata.messageCount >= MAX_CONVERSATION_MESSAGES) return { ok: false, reason: "limit" };

  const written = await writeConversationMessage(id, metadata.messageCount + 1, "gionny", text, store);
  const message = written.message;
  const updated = {
    ...metadata,
    updatedAt: message.createdAt,
    messageCount: metadata.messageCount + 1,
    lastMessagePreview: text.slice(0, 180),
    lastMessageSender: "gionny",
    adminUnread: false,
  };
  try {
    await writeMetadata(updated, store);
  } catch (error) {
    await store.del(written.messagePath).catch(() => {});
    throw error;
  }
  return { ok: true, conversation: publicConversation(updated), message };
}

export async function setConversationStatus(id, status, store = blob) {
  if (!["open", "closed", "blocked"].includes(status)) return false;
  const metadata = await readConversationMetadata(id, store);
  if (!metadata || (metadata.status === "blocked" && status === "closed")) return false;
  const updated = { ...metadata, status, adminUnread: false, updatedAt: new Date().toISOString() };
  await writeMetadata(updated, store);
  return publicConversation(updated);
}

export async function setConversationFavorite(id, favorite, store = blob) {
  if (!isConversationId(id) || typeof favorite !== "boolean") return null;
  const metadata = await readConversationMetadata(id, store);
  if (!metadata) return null;
  const updated = { ...metadata, favorite };
  await writeMetadata(updated, store);
  return publicConversation(updated);
}

export async function setConversationUnread(id, unread, store = blob) {
  if (!isConversationId(id) || typeof unread !== "boolean") return null;
  const metadata = await readConversationMetadata(id, store);
  if (!metadata) return null;
  const updated = { ...metadata, adminUnread: unread };
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

  cursor = "";
  do {
    const page = await store.list({
      prefix: `${CONVERSATION_AUDIO_PREFIX}${id}/`,
      limit: MAX_CONVERSATION_MESSAGES,
      ...(cursor ? { cursor } : {}),
    });
    const paths = page.blobs
      .map(({ pathname }) => pathname)
      .filter((pathname) => AUDIO_PATH_PATTERN.test(pathname));
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
