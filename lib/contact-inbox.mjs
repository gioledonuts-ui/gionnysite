import { createHash, createHmac, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { sharedBlobStore as blob } from "./blob-store.mjs";

const LEGACY_PREFIX = "gionny/inbox/";
const CONVERSATION_PREFIX = "gionny/conversations/";
const CONVERSATION_MESSAGE_PREFIX = "gionny/conversation-messages/";
const ACCOUNT_PREFIX = "gionny/visitor-accounts/";
const ACCOUNT_SESSION_PREFIX = "gionny/visitor-sessions/";
const ACCOUNT_PATH_PATTERN = /^gionny\/visitor-accounts\/([0-9a-f]{64})\.json$/u;
const ACCOUNT_SESSION_PATH_PATTERN = /^gionny\/visitor-sessions\/[0-9a-f]{64}\.json$/u;
const MEMBER_PAGE_SIZE = 40;
const HOST_ASSIGNMENT_PATH = "gionny/visitor-host.json";
const USERNAME_CHANGE_INTERVAL_MS = 15 * 24 * 60 * 60 * 1000;
const CONVERSATION_AUDIO_PREFIX = "gionny/conversation-audio/";
const CONVERSATION_IMAGE_PREFIX = "gionny/conversation-images/";
const LEGACY_PATH_PATTERN = /^gionny\/inbox\/\d{13}-[0-9a-f-]{36}\.json$/u;
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CONVERSATION_PATH_PATTERN = /^gionny\/conversations\/[0-9a-f-]{36}\.json$/u;
const CONVERSATION_MESSAGE_PATH_PATTERN = /^gionny\/conversation-messages\/([0-9a-f-]{36})\/(?:\d{3}-)?\d{13}-[0-9a-f-]{36}\.json$/u;
const AUDIO_PATH_PATTERN = /^gionny\/conversation-audio\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(webm|m4a|ogg|aac|3gp)$/u;
const IMAGE_PATH_PATTERN = /^gionny\/conversation-images\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.webp$/u;
const ACCOUNT_COOKIE_NAME = "gionny_account_session";
const VISITOR_COOKIE_NAME = "gionny_visitor_thread";
const PAGE_SIZE = 40;
const MAX_CONVERSATION_MESSAGES = 400;
const MAX_AUDIO_BYTES = 200_000;
const MAX_IMAGE_BYTES = 40_000;
const MAX_AVATAR_DATA_URL_CHARS = 13_355;
const ACCOUNT_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const STATELESS_ACCOUNT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ACCOUNT_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const ACCOUNT_SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const STATELESS_ACCOUNT_SESSION_TOKEN_PATTERN = /^qg2\.([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})$/u;
const PASSWORD_HASH_BYTES = 64;
const PASSWORD_SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const VISITOR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const CONVERSATION_SUBJECTS = [
  "Passer en live",
  "Idée vidéo / React",
  "Histoire / Anecdote",
  "Question",
  "Discussion",
];
export const DEFAULT_CONVERSATION_SUBJECT = "Discussion";
export const ACCOUNT_BADGES = ["verified"];
const VOICE_WAVEFORM_BARS = 38;
const scrypt = promisify(scryptCallback);

export function isContactMessagePath(pathname) {
  return typeof pathname === "string" && LEGACY_PATH_PATTERN.test(pathname);
}

export function isConversationId(id) {
  return typeof id === "string" && CONVERSATION_ID_PATTERN.test(id);
}

function cleanConversationSubject(subject) {
  if (typeof subject !== "string") return "";
  return subject.normalize("NFKC").replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

export function isConversationSubject(subject) {
  return CONVERSATION_SUBJECTS.includes(cleanConversationSubject(subject));
}

function normalizedConversationSubject(subject) {
  const cleaned = cleanConversationSubject(subject);
  return CONVERSATION_SUBJECTS.includes(cleaned) ? cleaned : DEFAULT_CONVERSATION_SUBJECT;
}

function normalizeAccountBadges(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((badge) => ACCOUNT_BADGES.includes(badge)))];
}

function isValidAccountBadges(value) {
  return value === undefined || (
    Array.isArray(value) && value.length <= ACCOUNT_BADGES.length &&
    value.every((badge) => ACCOUNT_BADGES.includes(badge)) &&
    new Set(value).size === value.length
  );
}

function normalizeAudioPeaks(value) {
  if (!Array.isArray(value) || value.length !== VOICE_WAVEFORM_BARS) return [];
  return value.map((peak) => Number.isFinite(peak) ? Math.round(Math.max(0, Math.min(1, peak)) * 100) / 100 : 0);
}

function isValidAudioPeaks(value) {
  return value === undefined || (
    Array.isArray(value) && (value.length === 0 || value.length === VOICE_WAVEFORM_BARS) &&
    value.every((peak) => Number.isFinite(peak) && peak >= 0 && peak <= 1)
  );
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

async function readHostAssignment(store = blob) {
  const assignment = await readPrivateJson(HOST_ASSIGNMENT_PATH, store).catch(() => null);
  return assignment?.version === 1 && isConversationId(assignment.accountId)
    ? {
        accountId: assignment.accountId,
        ...(ACCOUNT_KEY_PATTERN.test(assignment.accountKeyHash || "") ? { accountKeyHash: assignment.accountKeyHash } : {}),
      }
    : null;
}

async function activeHostAccountId(store = blob) {
  return (await readHostAssignment(store))?.accountId || null;
}

async function hostIdentityFromAssignment(assignment, store = blob) {
  if (!assignment?.accountId) return null;
  const directAccount = assignment.accountKeyHash
    ? await readAccountRecord(assignment.accountKeyHash, store)
    : null;
  const record = directAccount?.id === assignment.accountId
    ? { account: directAccount, keyHash: assignment.accountKeyHash }
    : await findAccountRecordById(assignment.accountId, store);
  if (!record || record.account?.id !== assignment.accountId || record.account.status === "banned") return null;
  return {
    accountId: record.account.id,
    pseudo: record.account.pseudo,
    isHost: true,
    ...(record.account.avatarData ? { avatarData: record.account.avatarData } : {}),
  };
}

async function accountIsHost(account, store = blob) {
  return Boolean(account?.id && (await activeHostAccountId(store)) === account.id);
}

export async function getHostAccountIdentityFromSession(token, store = blob) {
  const resolved = await resolveAccountSession(token, store);
  if (!resolved || !(await accountIsHost(resolved.account, store))) return null;
  return {
    accountId: resolved.account.id,
    pseudo: resolved.account.pseudo,
    isHost: true,
    ...(resolved.account.avatarData ? { avatarData: resolved.account.avatarData } : {}),
  };
}

export async function getActiveHostAccountIdentity(store = blob) {
  return hostIdentityFromAssignment(await readHostAssignment(store), store);
}

export async function getAdminReplyIdentity(request, store = blob) {
  const sessionIdentity = await getHostAccountIdentityFromSession(readAccountSessionCookie(request), store);
  return sessionIdentity || await getActiveHostAccountIdentity(store) || { pseudo: "Gionny", isHost: true };
}

async function saveHostAccountId(accountId, store = blob, accountKeyHash = "") {
  if (accountId === null) {
    await store.del(HOST_ASSIGNMENT_PATH).catch(() => {});
    return;
  }
  await store.put(HOST_ASSIGNMENT_PATH, JSON.stringify({
    version: 1,
    accountId,
    ...(ACCOUNT_KEY_PATTERN.test(accountKeyHash) ? { accountKeyHash } : {}),
    updatedAt: new Date().toISOString(),
  }), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
  });
}

function isValidOptionalDate(value) {
  return value === undefined || value === null ||
    (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function publicAccount(account, isHost = account.role === "host") {
  return {
    pseudo: account.pseudo,
    createdAt: isValidOptionalDate(account.createdAt) ? account.createdAt || null : null,
    lastUsernameChange: isValidOptionalDate(account.lastUsernameChange)
      ? account.lastUsernameChange || null
      : null,
    role: isHost ? "host" : "member",
    badges: normalizeAccountBadges(account.badges),
    ...(typeof account.avatarData === "string" ? { avatarData: account.avatarData } : {}),
  };
}

function publicAdminMember(account, isHost = account.role === "host") {
  return {
    id: account.id,
    pseudo: account.pseudo,
    createdAt: isValidOptionalDate(account.createdAt) ? account.createdAt || null : null,
    lastUsernameChange: isValidOptionalDate(account.lastUsernameChange)
      ? account.lastUsernameChange || null
      : null,
    role: isHost ? "host" : "member",
    status: account.status === "banned" ? "banned" : "active",
    conversationId: isConversationId(account.conversationId) ? account.conversationId : null,
    badges: normalizeAccountBadges(account.badges),
    ...(typeof account.avatarData === "string" ? { avatarData: account.avatarData } : {}),
  };
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
  const maxAge = STATELESS_ACCOUNT_SESSION_TOKEN_PATTERN.test(value || "")
    ? Math.floor(STATELESS_ACCOUNT_SESSION_TTL_MS / 1000)
    : Math.floor(ACCOUNT_SESSION_TTL_MS / 1000);
  response.setHeader(
    "Set-Cookie",
    `${ACCOUNT_COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`
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
  return ACCOUNT_SESSION_TOKEN_PATTERN.test(token) || STATELESS_ACCOUNT_SESSION_TOKEN_PATTERN.test(token)
    ? token
    : "";
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

function messageSequenceFromPath(pathname) {
  const filename = pathname.slice(pathname.lastIndexOf("/") + 1);
  const match = /^(\d{3})-\d{13}-/u.exec(filename);
  return match ? Number(match[1]) : null;
}

function conversationMessagePath(id, sequence) {
  return `${conversationMessagesPrefix(id)}${String(sequence).padStart(3, "0")}-${Date.now()}-${randomUUID()}.json`;
}

// ---------------------------------------------------------------------------
// RAM conversation mirror (Vercel Blob quota guard)
// ---------------------------------------------------------------------------
// Each serverless instance keeps the conversations it touched in RAM
// (globalThis.__qgState). Reads are served from memory after the first Blob
// read, so the admin screen and the visitor polling no longer consume Blob
// "Advanced operations" on every refresh. Writes touch RAM first, then the
// Blob in a silent try/catch: a quota error can slow persistence down but can
// never block the chat again.
const CONVERSATION_STATE_KEY = Symbol.for("gionny.contact-inbox.state.v1");

// One mirror per Blob store: in production every function shares the same
// `sharedBlobStore` (hence one globalThis state), while tests and injected
// stores stay perfectly isolated.
const isolatedStates = new WeakMap();

function conversationState(store = blob) {
  const isIsolated = store && store !== blob && (typeof store === "object" || typeof store === "function");
  let state;
  if (isIsolated) {
    state = isolatedStates.get(store);
  } else {
    state = globalThis[CONVERSATION_STATE_KEY];
  }
  if (state && state.conversations instanceof Map) return state;
  state = {
    conversations: new Map(), // id -> { metadata, messages: Map<pathname, stored>, audio: Map<pathname, Buffer> }
    maxConversations: 300,
  };
  if (isIsolated) isolatedStates.set(store, state);
  else globalThis[CONVERSATION_STATE_KEY] = state;
  return state;
}

function memoryBucket(conversationId, store = blob) {
  const state = conversationState(store);
  let bucket = state.conversations.get(conversationId);
  if (!bucket) {
    bucket = { metadata: null, messages: new Map(), audio: new Map(), images: new Map(), updatedAt: Date.now() };
    state.conversations.set(conversationId, bucket);
    while (state.conversations.size > state.maxConversations) {
      const oldest = state.conversations.keys().next();
      if (oldest.done) break;
      state.conversations.delete(oldest.value);
    }
  }
  return bucket;
}

function rememberConversationMetadata(metadata, store = blob) {
  if (!metadata?.id) return;
  const bucket = memoryBucket(metadata.id, store);
  bucket.metadata = metadata;
  bucket.updatedAt = Date.now();
}

// A deleted thread must also disappear from RAM, otherwise a cached instance
// would keep serving it to its owner.
function forgetConversation(conversationId, store = blob) {
  if (!conversationId) return;
  conversationState(store).conversations.delete(conversationId);
}

function rememberConversationMessage(conversationId, pathname, stored, store = blob) {
  if (!conversationId || !pathname || !stored) return;
  const bucket = memoryBucket(conversationId, store);
  bucket.messages.set(pathname, stored);
  bucket.updatedAt = Date.now();
}

function conversationPseudo(metadata) {
  const storedPseudo = typeof metadata?.pseudo === "string" ? metadata.pseudo.trim() : "";
  return storedPseudo && (metadata.accountId || storedPseudo.toLocaleLowerCase("fr-FR") !== "visiteur")
    ? storedPseudo
    : "Membre inconnu";
}

function publicConversation(metadata) {
  const pseudo = conversationPseudo(metadata);
  const lastMessagePseudo = typeof metadata.lastMessagePseudo === "string" && metadata.lastMessagePseudo.trim()
    ? metadata.lastMessagePseudo
    : metadata.lastMessageSender === "gionny" ? metadata.hostPseudo || "Gionny" : pseudo;
  return {
    id: metadata.id,
    pseudo,
    subject: normalizedConversationSubject(metadata.subject),
    status: metadata.status,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    messageCount: metadata.messageCount,
    lastMessagePreview: typeof metadata.lastMessagePreview === "string"
      ? metadata.lastMessagePreview.normalize("NFKC").replace(/^[^\p{L}\p{N}]+/u, "").trim().slice(0, 180)
      : "",
    lastMessageSender: metadata.lastMessageSender,
    lastMessagePseudo,
    lastMessageIsHost: typeof metadata.lastMessageIsHost === "boolean"
      ? metadata.lastMessageIsHost
      : metadata.lastMessageSender === "gionny" ||
        (metadata.isHost === true && metadata.lastMessageSender === "visitor"),
    adminUnread: typeof metadata.adminUnread === "boolean" ? metadata.adminUnread : metadata.lastMessageSender === "visitor",
    favorite: metadata.favorite === true,
    hasAudio: metadata.hasAudio === true,
    isHost: metadata.isHost === true,
    ...(typeof metadata.memberAvatarData === "string" && metadata.memberAvatarData ? { avatarData: metadata.memberAvatarData } : {}),
    memberBadges: normalizeAccountBadges(metadata.memberBadges),
    hasImage: metadata.hasImage === true,
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
    stored.messageCount >= 0 &&
    stored.messageCount <= MAX_CONVERSATION_MESSAGES &&
    (stored.lastVisitorSequence === undefined || (Number.isInteger(stored.lastVisitorSequence) && stored.lastVisitorSequence >= 0 && stored.lastVisitorSequence <= stored.messageCount)) &&
    (stored.adminReadSequence === undefined || (Number.isInteger(stored.adminReadSequence) && stored.adminReadSequence >= 0 && stored.adminReadSequence <= stored.messageCount)) &&
    typeof stored.lastMessagePreview === "string" &&
    (stored.subject === undefined || isConversationSubject(stored.subject)) &&
    (stored.adminUnread === undefined || typeof stored.adminUnread === "boolean") &&
    (stored.favorite === undefined || typeof stored.favorite === "boolean") &&
    (stored.hasAudio === undefined || typeof stored.hasAudio === "boolean") &&
    (stored.hasImage === undefined || typeof stored.hasImage === "boolean") &&
    (stored.accountId === undefined || isConversationId(stored.accountId)) &&
    (stored.accountKeyHash === undefined || ACCOUNT_KEY_PATTERN.test(stored.accountKeyHash)) &&
    (stored.lastMessagePseudo === undefined || (typeof stored.lastMessagePseudo === "string" && stored.lastMessagePseudo.trim().length > 0 && stored.lastMessagePseudo.length <= 32)) &&
    (stored.lastMessageIsHost === undefined || typeof stored.lastMessageIsHost === "boolean") &&
    (stored.isHost === undefined || typeof stored.isHost === "boolean") &&
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

function isValidNewAccountPseudo(value) {
  if (typeof value !== "string") return false;
  const normalizedInput = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
  if (normalizedInput !== normalizedInput.trim()) return false;
  const pseudo = normalizeAccountPseudo(value);
  return pseudo.length >= 3 && pseudo.length <= 16;
}

function normalizeAvatarData(value) {
  if (value === null || value === "") return "";
  if (typeof value !== "string" || value.length > MAX_AVATAR_DATA_URL_CHARS) return null;
  const match = /^data:image\/webp;base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (!match) return null;
  const encoded = match[1];
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.length < 12 ||
    bytes.length >= 10_000 ||
    bytes.toString("base64") !== encoded ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP"
  ) return null;
  return value;
}

function isValidAvatarData(value) {
  return value === undefined || (typeof value === "string" && value.length > 0 && normalizeAvatarData(value) === value);
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
    isValidOptionalDate(stored.createdAt) &&
    isValidOptionalDate(stored.lastUsernameChange) &&
    (stored.role === undefined || ["member", "host"].includes(stored.role)) &&
    (stored.status === undefined || ["active", "banned"].includes(stored.status)) &&
    (stored.avatarData === undefined || isValidAvatarData(stored.avatarData)) &&
    isValidAccountBadges(stored.badges)
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

async function findAccountRecordForConversation(metadata, store = blob) {
  if (!isConversationId(metadata?.accountId)) return null;
  if (ACCOUNT_KEY_PATTERN.test(metadata.accountKeyHash || "")) {
    const account = await readAccountRecord(metadata.accountKeyHash, store);
    return account?.id === metadata.accountId ? { account, keyHash: metadata.accountKeyHash } : null;
  }
  // Older conversation records did not retain the account's hashed storage key.
  return findAccountRecordById(metadata.accountId, store);
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

function statelessAccountSessionSignature(encodedPayload, account) {
  const signingKey = Buffer.from(account.passwordHash, "base64url");
  return createHmac("sha256", signingKey).update(`qg2.${encodedPayload}`).digest("base64url");
}

function createStatelessAccountSession(account) {
  const issuedAt = Date.now();
  const claims = {
    version: 2,
    accountId: account.id,
    accountKeyHash: account.keyHash,
    issuedAt,
    expiresAt: issuedAt + STATELESS_ACCOUNT_SESSION_TTL_MS,
    nonce: randomBytes(16).toString("base64url"),
  };
  const encodedPayload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = statelessAccountSessionSignature(encodedPayload, account);
  return `qg2.${encodedPayload}.${signature}`;
}

async function resolveStatelessAccountSession(token, store = blob) {
  const match = typeof token === "string" ? STATELESS_ACCOUNT_SESSION_TOKEN_PATTERN.exec(token) : null;
  if (!match) return null;

  const [, encodedPayload, receivedSignature] = match;
  const payloadBytes = Buffer.from(encodedPayload, "base64url");
  if (payloadBytes.toString("base64url") !== encodedPayload) return null;

  let claims;
  try {
    claims = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return null;
  }

  const now = Date.now();
  if (
    claims?.version !== 2 ||
    !isConversationId(claims.accountId) ||
    !ACCOUNT_KEY_PATTERN.test(claims.accountKeyHash || "") ||
    !Number.isSafeInteger(claims.issuedAt) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.issuedAt > now + 60_000 ||
    claims.expiresAt <= now ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > STATELESS_ACCOUNT_SESSION_TTL_MS ||
    !/^[A-Za-z0-9_-]{22}$/u.test(claims.nonce || "")
  ) return null;

  const account = await readAccountRecord(claims.accountKeyHash, store);
  if (!account || account.id !== claims.accountId || account.status === "banned") return null;

  const expectedSignature = Buffer.from(statelessAccountSessionSignature(encodedPayload, account), "base64url");
  const receivedSignatureBytes = Buffer.from(receivedSignature, "base64url");
  if (
    expectedSignature.length !== receivedSignatureBytes.length ||
    !timingSafeEqual(expectedSignature, receivedSignatureBytes)
  ) return null;

  return {
    account,
    sessionPath: null,
    session: claims,
    stateless: true,
  };
}

async function createAccountSession(account, store = blob) {
  const token = randomBytes(32).toString("base64url");
  const record = {
    version: 1,
    accountKeyHash: account.keyHash,
    expiresAt: new Date(Date.now() + ACCOUNT_SESSION_TTL_MS).toISOString(),
  };

  try {
    if (typeof store.put !== "function") throw new Error("No writable Blob store");
    await store.put(accountSessionPath(hashToken(token)), JSON.stringify(record), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/json; charset=utf-8",
    });
    return token;
  } catch (error) {
    // A fallback is safe only when the verified account itself is verifiable.
    // That is the case for the in-memory Blob cache used during Blob quota
    // outages, and for accounts already persisted in the Blob store.
    const persistedAccount = await readAccountRecord(account.keyHash, store).catch(() => null);
    if (
      persistedAccount &&
      (persistedAccount.id !== account.id ||
        persistedAccount.keyHash !== account.keyHash ||
        persistedAccount.passwordHash !== account.passwordHash ||
        persistedAccount.status === "banned")
    ) {
      throw error;
    }

    console.warn("[contact] persistent session write failed; issuing a short-lived signed session", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
    return createStatelessAccountSession(persistedAccount);
  }
}

async function resolveAccountSession(token, store = blob) {
  if (typeof token !== "string") return null;
  if (STATELESS_ACCOUNT_SESSION_TOKEN_PATTERN.test(token)) {
    return resolveStatelessAccountSession(token, store);
  }
  if (!ACCOUNT_SESSION_TOKEN_PATTERN.test(token)) return null;

  const sessionPath = accountSessionPath(hashToken(token));
  const session = await readPrivateJson(sessionPath, store);
  if (!isValidAccountSession(session)) return null;
  if (Date.parse(session.expiresAt) <= Date.now()) {
    await store.del(sessionPath).catch(() => {});
    return null;
  }
  const account = await readAccountRecord(session.accountKeyHash, store);
  return account && account.status !== "banned" ? { account, sessionPath, session, stateless: false } : null;
}

async function linkLegacyConversation(account, legacyCookieValue, store = blob) {
  if (account.conversationId || !legacyCookieValue) return account;
  const previous = await getVisitorConversation(legacyCookieValue, store);
  if (!previous || accountKeyHash(previous.conversation.pseudo) !== account.keyHash) return account;
  const linked = {
    ...account,
    conversationId: previous.conversation.id,
    role: await accountIsHost(account, store) ? "host" : "member",
    updatedAt: new Date().toISOString(),
  };
  await writeAccountRecord(linked, store);
  const metadata = await readConversationMetadata(previous.conversation.id, store);
  if (metadata) {
    await writeMetadata({
      ...metadata,
      pseudo: account.pseudo,
      accountId: account.id,
      accountKeyHash: account.keyHash,
      isHost: await accountIsHost(account, store),
    }, store);
  }
  return linked;
}

export async function registerVisitorAccount({ pseudo, password, legacyCookieValue = "" }, store = blob) {
  const trimmedPseudo = typeof pseudo === "string" ? pseudo.trim() : "";
  if (!isValidNewAccountPseudo(trimmedPseudo)) return { ok: false, reason: "pseudo" };
  const cleanedPseudo = normalizeAccountPseudo(trimmedPseudo);
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
    lastUsernameChange: null,
    role: "member",
    status: "active",
    updatedAt: now,
  };

  try {
    await writeAccountRecord(account, store, false);
  } catch (error) {
    if (await readAccountRecord(keyHash, store)) return { ok: false, reason: "exists" };
    throw error;
  }

  account = await linkLegacyConversation(account, legacyCookieValue, store);
  return {
    ok: true,
    account: publicAccount(account, await accountIsHost(account, store)),
    sessionToken: await createAccountSession(account, store),
  };
}

export async function loginVisitorAccount({ pseudo, password, legacyCookieValue = "" }, store = blob) {
  if (typeof pseudo !== "string" || typeof password !== "string" || password.length > 128) {
    return { ok: false, reason: "invalid_credentials" };
  }
  const cleanedPseudo = normalizeAccountPseudo(pseudo.trim());

  const keyHash = accountKeyHash(cleanedPseudo);
  let account = await readAccountRecord(keyHash, store);
  if (!account) return { ok: false, reason: "invalid_credentials" };
  if (account.status === "banned") return { ok: false, reason: "banned" };

  const salt = Buffer.from(account.passwordSalt, "base64url");
  const expected = Buffer.from(account.passwordHash, "base64url");
  const received = await derivePasswordHash(password, salt);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: "invalid_credentials" };
  }

  account = await linkLegacyConversation(account, legacyCookieValue, store);
  return {
    ok: true,
    account: publicAccount(account, await accountIsHost(account, store)),
    sessionToken: await createAccountSession(account, store),
  };
}

export async function getVisitorAccountFromSession(token, store = blob) {
  const resolved = await resolveAccountSession(token, store);
  return resolved ? publicAccount(resolved.account, await accountIsHost(resolved.account, store)) : null;
}

export async function clearVisitorAccountSession(token, store = blob) {
  if (STATELESS_ACCOUNT_SESSION_TOKEN_PATTERN.test(token || "")) return true;
  if (!ACCOUNT_SESSION_TOKEN_PATTERN.test(token || "")) return false;
  await store.del(accountSessionPath(hashToken(token))).catch(() => {});
  return true;
}

export async function updateVisitorAccountProfile(
  sessionToken,
  { pseudo, currentPassword = "", newPassword = "", avatarData } = {},
  store = blob
) {
  const resolved = await resolveAccountSession(sessionToken, store);
  if (!resolved) return { ok: false, reason: "unauthorized" };

  const { account } = resolved;
  const isHost = await accountIsHost(account, store);
  if (pseudo !== undefined && !isValidNewAccountPseudo(pseudo)) {
    return { ok: false, reason: "pseudo" };
  }
  const cleanedPseudo = pseudo === undefined ? account.pseudo : normalizeAccountPseudo(pseudo);
  const pseudoChanged = cleanedPseudo !== account.pseudo;
  const passwordRequested = newPassword !== undefined && newPassword !== null && newPassword !== "";
  const avatarRequested = avatarData !== undefined;
  const cleanedAvatarData = avatarRequested ? normalizeAvatarData(avatarData) : account.avatarData || "";
  if (avatarRequested && cleanedAvatarData === null) return { ok: false, reason: "avatar" };
  const avatarChanged = avatarRequested && cleanedAvatarData !== (account.avatarData || "");
  if (passwordRequested && (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 128)) {
    return { ok: false, reason: "password" };
  }
  if (!pseudoChanged && !passwordRequested && !avatarChanged) return { ok: false, reason: "no_changes" };

  const now = new Date();
  const nowIso = now.toISOString();
  if (pseudoChanged && !isHost && typeof account.lastUsernameChange === "string") {
    const lastChange = Date.parse(account.lastUsernameChange);
    if (Number.isFinite(lastChange)) {
      const nextAllowedAt = lastChange + USERNAME_CHANGE_INTERVAL_MS;
      if (now.getTime() < nextAllowedAt) {
        return {
          ok: false,
          reason: "cooldown",
          daysRemaining: Math.max(1, Math.ceil((nextAllowedAt - now.getTime()) / (24 * 60 * 60 * 1000))),
          nextUsernameChangeAt: new Date(nextAllowedAt).toISOString(),
        };
      }
    }
  }

  let passwordSalt = account.passwordSalt;
  let passwordHash = account.passwordHash;
  if (passwordRequested) {
    if (typeof currentPassword !== "string" || currentPassword.length > 128) {
      return { ok: false, reason: "current_password" };
    }
    const salt = Buffer.from(account.passwordSalt, "base64url");
    const expected = Buffer.from(account.passwordHash, "base64url");
    const received = await derivePasswordHash(currentPassword, salt);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      return { ok: false, reason: "current_password" };
    }
    const nextSalt = randomBytes(16);
    const nextHash = await derivePasswordHash(newPassword, nextSalt);
    passwordSalt = nextSalt.toString("base64url");
    passwordHash = nextHash.toString("base64url");
  }

  const previousKeyHash = account.keyHash;
  const nextKeyHash = pseudoChanged ? accountKeyHash(cleanedPseudo) : previousKeyHash;
  const keyChanged = nextKeyHash !== previousKeyHash;
  if (keyChanged && await readAccountRecord(nextKeyHash, store)) {
    return { ok: false, reason: "exists" };
  }

  const updatedAccount = {
    ...account,
    keyHash: nextKeyHash,
    pseudo: cleanedPseudo,
    role: isHost ? "host" : "member",
    passwordSalt,
    passwordHash,
    ...(avatarRequested ? (cleanedAvatarData ? { avatarData: cleanedAvatarData } : { avatarData: undefined }) : {}),
    ...(pseudoChanged ? { lastUsernameChange: nowIso } : {}),
    updatedAt: nowIso,
  };
  const previousMetadata = pseudoChanged && account.conversationId
    ? await readConversationMetadata(account.conversationId, store)
    : null;
  const updatedMetadata = previousMetadata
    ? {
        ...previousMetadata,
        pseudo: cleanedPseudo,
        accountId: account.id,
        accountKeyHash: nextKeyHash,
        isHost,
      }
    : null;

  let accountWritten = false;
  let metadataWritten = false;
  let hostAssignmentWritten = false;
  let rekeyedSessions = [];
  try {
    try {
      await writeAccountRecord(updatedAccount, store, !keyChanged);
      accountWritten = true;
    } catch (error) {
      if (keyChanged && await readAccountRecord(nextKeyHash, store)) return { ok: false, reason: "exists" };
      throw error;
    }

    if (updatedMetadata) {
      await writeMetadata(updatedMetadata, store);
      metadataWritten = true;
    }

    if (keyChanged) {
      rekeyedSessions = await rekeyAccountSessions(previousKeyHash, nextKeyHash, store);
      if (isHost) {
        await saveHostAccountId(account.id, store, nextKeyHash);
        hostAssignmentWritten = true;
      }
      await store.del(accountPath(previousKeyHash));
    }

    const sessionToken = resolved.stateless && (keyChanged || passwordRequested)
      ? await createAccountSession(updatedAccount, store)
      : undefined;
    return {
      ok: true,
      account: publicAccount(updatedAccount, isHost),
      ...(sessionToken ? { sessionToken } : {}),
    };
  } catch (error) {
    if (hostAssignmentWritten) await saveHostAccountId(account.id, store, previousKeyHash).catch(() => {});
    if (keyChanged) {
      for (const { pathname, session } of rekeyedSessions) {
        await store.put(pathname, JSON.stringify(session), {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: "application/json; charset=utf-8",
        }).catch(() => {});
      }
      if (metadataWritten && previousMetadata) await writeMetadata(previousMetadata, store).catch(() => {});
      if (accountWritten) await store.del(accountPath(nextKeyHash)).catch(() => {});
    } else {
      if (metadataWritten && previousMetadata) await writeMetadata(previousMetadata, store).catch(() => {});
      if (accountWritten) await writeAccountRecord(account, store, true).catch(() => {});
    }
    throw error;
  }
}

/**
 * A Blob write must never break a chat request: when the free Blob quota is
 * exhausted, the RAM mirror above still serves the data for this instance.
 */
async function safePut(store, pathname, body, options = {}) {
  if (!store || typeof store.put !== "function") return false;
  try {
    await store.put(pathname, body, options);
    return true;
  } catch (error) {
    console.warn("[contact] Blob write skipped (quota or network)", {
      path: typeof pathname === "string" ? pathname.replace(/[0-9a-f-]{8,}/giu, "…") : "",
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
    return false;
  }
}

async function readConversationMetadata(id, store = blob) {
  if (!isConversationId(id)) return null;
  const cached = conversationState(store).conversations.get(id)?.metadata;
  if (cached && isValidMetadata(cached, id)) return cached;
  const stored = await readPrivateJson(conversationPath(id), store).catch(() => null);
  if (!isValidMetadata(stored, id)) return null;
  rememberConversationMetadata(stored, store);
  return stored;
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
    !Number.isFinite(Date.parse(stored.createdAt)) ||
    (stored.pseudo !== undefined && (typeof stored.pseudo !== "string" || !stored.pseudo.trim() || stored.pseudo.length > 32)) ||
    (stored.isHost !== undefined && typeof stored.isHost !== "boolean") ||
    (stored.read !== undefined && typeof stored.read !== "boolean") ||
    !isValidAudioPeaks(stored.audioPeaks)
  ) {
    return false;
  }

  const kind = stored.kind || (stored.audioPath ? "audio" : stored.imagePath ? "image" : "text");
  if (kind === "text") return stored.text.length > 0 && !stored.audioPath && !stored.imagePath;
  if (kind === "audio") {
    if (stored.text.length !== 0 || stored.imagePath) return false;
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
  if (kind !== "image" || stored.audioPath) return false;
  const imagePathMatch = typeof stored.imagePath === "string" ? IMAGE_PATH_PATTERN.exec(stored.imagePath) : null;
  return Boolean(
    imagePathMatch &&
    imagePathMatch[1] === conversationId &&
    imagePathMatch[2] === stored.id &&
    stored.imageMimeType === "image/webp" &&
    Number.isInteger(stored.imageSize) &&
    stored.imageSize > 0 &&
    stored.imageSize <= MAX_IMAGE_BYTES
  );
}

async function readConversationMessage(pathname, store = blob, context = {}) {
  const pathMatch = CONVERSATION_MESSAGE_PATH_PATTERN.exec(pathname);
  if (!pathMatch) return null;
  const mirror = conversationState(store).conversations.get(pathMatch[1])?.messages.get(pathname);
  let stored = mirror || await readPrivateJson(pathname, store).catch(() => null);
  const conversationId = pathMatch[1];
  if (!isValidConversationMessage(stored, conversationId)) return null;
  const pathSequence = messageSequenceFromPath(pathname);
  if (pathSequence !== null && pathSequence !== stored.sequence) return null;
  if (context.markReadSender === stored.sender && stored.read !== true) {
    await safePut(store, pathname, JSON.stringify({ ...stored, read: true }), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json; charset=utf-8",
    });
    stored = { ...stored, read: true };
  }
  const kind = stored.kind || (stored.audioPath ? "audio" : stored.imagePath ? "image" : "text");
  const metadata = context.metadata || null;
  const hostIdentity = context.hostIdentity || null;
  const legacyIdentity = stored.isHost === undefined;
  const ownerIsHost = Boolean(
    legacyIdentity && metadata && hostIdentity?.accountId && metadata.accountId === hostIdentity.accountId
  );
  const ownerWasHost = Boolean(legacyIdentity && metadata?.isHost && stored.sender === "visitor");
  const sender = (ownerIsHost || ownerWasHost) && stored.sender === "visitor" ? "gionny" : stored.sender;
  const isHost = stored.isHost === true || sender === "gionny" || ownerIsHost || ownerWasHost;
  const recordedPseudo = typeof stored.pseudo === "string" ? stored.pseudo.trim() : "";
  const pseudo = recordedPseudo || (sender === "gionny"
    ? hostIdentity?.pseudo || "Gionny"
    : ownerIsHost
      ? hostIdentity.pseudo
      : conversationPseudo(metadata));
  return {
    id: stored.id,
    sequence: stored.sequence,
    sender,
    pseudo,
    isHost,
    text: stored.text,
    createdAt: stored.createdAt,
    kind,
    read: stored.read === true,
    ...(sender === "visitor"
      ? {
        badges: normalizeAccountBadges(context.memberBadges ?? metadata?.memberBadges),
        // The thread metadata already carries the member avatar, so the avatar
        // survives even when the account record cannot be read (Blob quota).
        ...(typeof (context.memberAvatarData ?? metadata?.memberAvatarData) === "string" &&
        (context.memberAvatarData ?? metadata?.memberAvatarData)
          ? { avatarData: context.memberAvatarData ?? metadata.memberAvatarData }
          : {}),
      }
      : typeof hostIdentity?.avatarData === "string" && hostIdentity.avatarData
        ? { avatarData: hostIdentity.avatarData }
        : {}),
    ...(kind === "audio"
      ? { hasAudio: true, audioMimeType: stored.audioMimeType, audioSize: stored.audioSize, audioPeaks: normalizeAudioPeaks(stored.audioPeaks) }
      : kind === "image"
        ? { hasImage: true, imageMimeType: stored.imageMimeType, imageSize: stored.imageSize }
        : {}),
  };
}

async function listMessagesForConversation(id, store = blob, context = {}) {
  const metadata = context.metadata || await readConversationMetadata(id, store);
  let hostIdentity = context.hostIdentity || null;
  if (!hostIdentity) {
    hostIdentity = await getActiveHostAccountIdentity(store).catch(() => null);
  }
  let memberAvatarData = context.memberAvatarData;
  let memberBadges = context.memberBadges;
  if ((memberAvatarData === undefined || memberBadges === undefined) && metadata?.accountId) {
    const owner = await findAccountRecordForConversation(metadata, store).catch(() => null);
    if (memberAvatarData === undefined) memberAvatarData = owner?.account?.avatarData || "";
    if (memberBadges === undefined) memberBadges = normalizeAccountBadges(owner?.account?.badges);
  }
  const bucket = conversationState(store).conversations.get(id);
  const mirroredPaths = bucket && bucket.messages.size > 0
    ? [...bucket.messages.keys()]
    : null;
  const page = mirroredPaths
    ? { blobs: mirroredPaths.map((pathname) => ({ pathname })) }
    : await store.list({
      prefix: conversationMessagesPrefix(id),
      limit: MAX_CONVERSATION_MESSAGES,
    });
  const afterSequence = Number.isInteger(context.afterSequence) && context.afterSequence >= 0
    ? context.afterSequence
    : null;
  const markReadSender = ["visitor", "gionny"].includes(context.markReadSender) ? context.markReadSender : "";
  const messagePaths = (Array.isArray(page.blobs) ? page.blobs : [])
    .filter(({ pathname }) => CONVERSATION_MESSAGE_PATH_PATTERN.test(pathname))
    .filter(({ pathname }) => {
      if (afterSequence === null || afterSequence === 0 || markReadSender) return true;
      const sequence = messageSequenceFromPath(pathname);
      return sequence !== null && sequence > afterSequence;
    });
  const messages = (await Promise.all(
    messagePaths.map(({ pathname }) => readConversationMessage(pathname, store, {
      metadata,
      hostIdentity,
      memberAvatarData,
      memberBadges,
      ...(markReadSender ? { markReadSender } : {}),
    }))
  ))
    .filter(Boolean)
    .sort((left, right) => left.sequence - right.sequence || Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
  return messages;
}

async function writeConversationMessage(id, sequence, sender, text, identity, store = blob) {
  const createdAt = new Date().toISOString();
  const pseudo = normalizeAccountPseudo(identity?.pseudo);
  if (!pseudo) throw new Error("Conversation messages require an account pseudo");
  const isHost = identity?.isHost === true;
  const message = { version: 1, id: randomUUID(), sequence, sender, pseudo, isHost, text, read: false, createdAt };
  const pathname = conversationMessagePath(id, sequence);
  await safePut(store, pathname, JSON.stringify(message), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: "application/json; charset=utf-8",
  });
  return {
    message: { id: message.id, sequence, sender, pseudo, isHost, text, createdAt, kind: "text", read: false },
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

async function writeAudioConversationMessage(id, sequence, sender, audioBytes, mimeType, identity, store = blob, audioPeaks = []) {
  const bytes = Buffer.isBuffer(audioBytes) ? audioBytes : Buffer.from(audioBytes || []);
  const format = audioFormat(mimeType);
  if (!format || bytes.length < 1 || bytes.length > MAX_AUDIO_BYTES) {
    throw new Error("Invalid audio attachment");
  }

  const createdAt = new Date().toISOString();
  const pseudo = normalizeAccountPseudo(identity?.pseudo);
  if (!pseudo) throw new Error("Conversation messages require an account pseudo");
  const isHost = identity?.isHost === true;
  const messageId = randomUUID();
  const audioPath = `${CONVERSATION_AUDIO_PREFIX}${id}/${messageId}.${format.extension}`;
  const pathname = conversationMessagePath(id, sequence);
  const stored = {
    version: 1,
    id: messageId,
    sequence,
    sender,
    pseudo,
    isHost,
    text: "",
    read: false,
    kind: "audio",
    audioPath,
    audioMimeType: format.mimeType,
    audioSize: bytes.length,
    audioPeaks: normalizeAudioPeaks(audioPeaks),
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
      pseudo,
      isHost,
      text: "",
      createdAt,
      kind: "audio",
      read: false,
      hasAudio: true,
      audioMimeType: format.mimeType,
      audioSize: bytes.length,
      audioPeaks: normalizeAudioPeaks(audioPeaks),
    },
    messagePath: pathname,
    audioPath,
  };
}

function isWebpBytes(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 12 && bytes.length <= MAX_IMAGE_BYTES &&
    bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}

async function writeImageConversationMessage(id, sequence, sender, imageBytes, text, identity, store = blob) {
  const bytes = Buffer.isBuffer(imageBytes) ? imageBytes : Buffer.from(imageBytes || []);
  if (!isWebpBytes(bytes)) throw new Error("Invalid WebP attachment");
  const createdAt = new Date().toISOString();
  const pseudo = normalizeAccountPseudo(identity?.pseudo);
  if (!pseudo) throw new Error("Conversation messages require an account pseudo");
  const isHost = identity?.isHost === true;
  const messageId = randomUUID();
  const imagePath = `${CONVERSATION_IMAGE_PREFIX}${id}/${messageId}.webp`;
  const pathname = conversationMessagePath(id, sequence);
  const stored = {
    version: 1,
    id: messageId,
    sequence,
    sender,
    pseudo,
    isHost,
    text: typeof text === "string" ? text : "",
    read: false,
    kind: "image",
    imagePath,
    imageMimeType: "image/webp",
    imageSize: bytes.length,
    createdAt,
  };
  await store.put(imagePath, bytes, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: "image/webp",
  });
  try {
    await store.put(pathname, JSON.stringify(stored), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/json; charset=utf-8",
    });
  } catch (error) {
    await store.del(imagePath).catch(() => {});
    throw error;
  }
  return {
    message: {
      id: messageId,
      sequence,
      sender,
      pseudo,
      isHost,
      text: stored.text,
      createdAt,
      kind: "image",
      read: false,
      hasImage: true,
      imageMimeType: "image/webp",
      imageSize: bytes.length,
    },
    messagePath: pathname,
    imagePath,
  };
}

async function writeMetadata(metadata, store = blob) {
  if (!metadata?.id) return;
  rememberConversationMetadata(metadata, store);
  await safePut(store, conversationPath(metadata.id), JSON.stringify(metadata), {
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

  await blob.put(pathname, body, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: "application/json; charset=utf-8",
  });

  return { createdAt };
}

export async function createConversation(
  {
    pseudo,
    message = "",
    subject = DEFAULT_CONVERSATION_SUBJECT,
    audioBytes = null,
    audioMimeType = "",
    audioPeaks = [],
    imageBytes = null,
    accountId = null,
    accountKeyHash = "",
  },
  store = blob
) {
  const accountPseudo = normalizeAccountPseudo(pseudo);
  if (!accountPseudo) throw new Error("A signed-in account pseudo is required to create a conversation");
  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const hostId = await activeHostAccountId(store);
  const hostAuthor = isConversationId(accountId) && hostId === accountId;
  const sender = hostAuthor ? "gionny" : "visitor";
  const identity = { pseudo: accountPseudo, isHost: hostAuthor };
  const hasAudio = audioBytes !== null && audioBytes !== undefined;
  const hasImage = imageBytes !== null && imageBytes !== undefined;
  if (hasAudio && hasImage) throw new Error("A conversation message can only contain one attachment");
  let initialMessage;
  let messagePath = "";
  let attachmentPath = "";

  if (hasAudio) {
    const audioMessage = await writeAudioConversationMessage(id, 1, sender, audioBytes, audioMimeType, identity, store, audioPeaks);
    initialMessage = audioMessage.message;
    messagePath = audioMessage.messagePath;
    attachmentPath = audioMessage.audioPath;
  } else if (hasImage) {
    const imageMessage = await writeImageConversationMessage(id, 1, sender, imageBytes, message, identity, store);
    initialMessage = imageMessage.message;
    messagePath = imageMessage.messagePath;
    attachmentPath = imageMessage.imagePath;
  } else {
    if (typeof message !== "string" || !message.length) throw new Error("A conversation message is required");
    const storedMessage = await writeConversationMessage(id, 1, sender, message, identity, store);
    initialMessage = storedMessage.message;
    messagePath = storedMessage.messagePath;
  }

  const metadata = {
    version: 1,
    id,
    pseudo: accountPseudo,
    subject: normalizedConversationSubject(subject),
    status: "open",
    createdAt: initialMessage.createdAt,
    updatedAt: initialMessage.createdAt,
    messageCount: 1,
    lastVisitorSequence: hostAuthor ? 0 : 1,
    adminReadSequence: 0,
    lastMessagePreview: hasAudio ? "Message vocal" : hasImage ? (message || "Image").slice(0, 180) : message.slice(0, 180),
    lastMessageSender: sender,
    lastMessagePseudo: accountPseudo,
    lastMessageIsHost: hostAuthor,
    adminUnread: !hostAuthor,
    favorite: false,
    hasAudio,
    hasImage,
    ...(isConversationId(accountId) ? { accountId } : {}),
    ...(ACCOUNT_KEY_PATTERN.test(accountKeyHash) ? { accountKeyHash } : {}),
    isHost: hostAuthor,
    tokenHash: hashToken(token),
  };

  try {
    await writeMetadata(metadata, store);
  } catch (error) {
    await store.del([messagePath, ...(attachmentPath ? [attachmentPath] : [])]).catch(() => {});
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
    messages: await listMessagesForConversation(session.id, store, { metadata }),
  };
}

export async function getAccountConversation(sessionToken, store = blob, { afterSequence: requestedAfterSequence } = {}) {
  const resolved = await resolveAccountSession(sessionToken, store);
  if (!resolved) return null;
  const { account } = resolved;
  const [hostAssignment, metadata] = await Promise.all([
    readHostAssignment(store),
    isConversationId(account.conversationId)
      ? readConversationMetadata(account.conversationId, store)
      : Promise.resolve(null),
  ]);
  const isHost = hostAssignment?.accountId === account.id;
  if (!account.conversationId || !metadata) {
    return { account: publicAccount(account, isHost), conversation: null, messages: [], messagesComplete: true };
  }
  const hostIdentity = isHost
    ? { accountId: account.id, pseudo: account.pseudo, isHost: true, ...(account.avatarData ? { avatarData: account.avatarData } : {}) }
    : await hostIdentityFromAssignment(hostAssignment, store);
  const conversationMetadata = {
    ...metadata,
    hostPseudo: hostIdentity?.pseudo || "",
    memberAvatarData: account.avatarData || "",
    memberBadges: account.badges || [],
    isHost,
  };
  const afterSequence = Number.isInteger(requestedAfterSequence) &&
      requestedAfterSequence >= 0 && requestedAfterSequence <= MAX_CONVERSATION_MESSAGES &&
      requestedAfterSequence <= metadata.messageCount
    ? requestedAfterSequence
    : null;
  const hasMessagesToLoad = afterSequence === null || metadata.messageCount > afterSequence;
  return {
    account: publicAccount(account, isHost),
    conversation: publicConversation(conversationMetadata),
    messages: hasMessagesToLoad
      ? await listMessagesForConversation(metadata.id, store, {
          metadata: conversationMetadata,
          hostIdentity,
          memberAvatarData: account.avatarData || "",
          memberBadges: account.badges || [],
          ...(afterSequence !== null ? { afterSequence } : {}),
        })
      : [],
    messagesComplete: afterSequence === null,
  };
}

async function createAccountThread(account, { subject, message, audioBytes, audioMimeType, audioPeaks = [], imageBytes }, store = blob) {
  const created = await createConversation({
    pseudo: account.pseudo,
    subject,
    message,
    audioBytes,
    audioMimeType,
    audioPeaks,
    imageBytes,
    accountId: account.id,
    accountKeyHash: account.keyHash,
  }, store);
  const isHost = created.conversation.isHost;
  const linkedAccount = {
    ...account,
    conversationId: created.conversation.id,
    role: isHost ? "host" : "member",
    updatedAt: new Date().toISOString(),
  };
  try {
    await writeAccountRecord(linkedAccount, store);
  } catch (error) {
    await deleteConversation(created.conversation.id, store).catch(() => {});
    throw error;
  }
  return {
    ok: true,
    account: publicAccount(linkedAccount, isHost),
    conversation: { ...created.conversation, ...(account.avatarData ? { avatarData: account.avatarData } : {}), memberBadges: normalizeAccountBadges(account.badges) },
    message: { ...created.messages[0], ...(account.avatarData ? { avatarData: account.avatarData } : {}), badges: normalizeAccountBadges(account.badges) },
    messages: created.messages.map((message) => ({ ...message, ...(account.avatarData ? { avatarData: account.avatarData } : {}), badges: normalizeAccountBadges(account.badges) })),
  };
}

export async function addAccountReply(
  sessionToken,
  { message = "", subject = DEFAULT_CONVERSATION_SUBJECT, audioBytes = null, audioMimeType = "", audioPeaks = [], imageBytes = null, newConversation = false },
  store = blob
) {
  const resolved = await resolveAccountSession(sessionToken, store);
  if (!resolved) return { ok: false, reason: "unauthorized" };
  const { account } = resolved;
  const isHost = await accountIsHost(account, store);
  const sender = isHost ? "gionny" : "visitor";
  const identity = { pseudo: account.pseudo, isHost };
  const hasAudio = audioBytes !== null && audioBytes !== undefined;
  const hasImage = imageBytes !== null && imageBytes !== undefined;
  const hasAttachment = hasAudio || hasImage;
  if (
    (hasAudio && hasImage) ||
    (!hasAttachment && (typeof message !== "string" || !message.length)) ||
    (hasAudio && (!audioFormat(audioMimeType) || !Buffer.isBuffer(audioBytes) || audioBytes.length < 1 || audioBytes.length > MAX_AUDIO_BYTES)) ||
    (hasImage && !isWebpBytes(imageBytes)) ||
    (hasImage && (typeof message !== "string" || message.length > 1500))
  ) return { ok: false, reason: "invalid_message" };

  const metadata = account.conversationId ? await readConversationMetadata(account.conversationId, store) : null;
  if (!metadata) return createAccountThread(account, { subject, message, audioBytes, audioMimeType, audioPeaks, imageBytes }, store);
  if (newConversation) {
    if (metadata.status === "blocked") return { ok: false, reason: "blocked" };
    if (metadata.status === "open") return { ok: false, reason: "already_open" };
    return createAccountThread(account, { subject, message, audioBytes, audioMimeType, audioPeaks, imageBytes }, store);
  }
  if (metadata.status === "blocked") return { ok: false, reason: "blocked" };
  if (metadata.status === "closed") return { ok: false, reason: "closed" };
  if (metadata.messageCount >= MAX_CONVERSATION_MESSAGES) return { ok: false, reason: "limit" };

  let messageResult;
  let cleanupPaths = [];
  if (hasAudio) {
    const written = await writeAudioConversationMessage(metadata.id, metadata.messageCount + 1, sender, audioBytes, audioMimeType, identity, store, audioPeaks);
    messageResult = written.message;
    cleanupPaths = [written.messagePath, written.audioPath];
  } else if (hasImage) {
    const written = await writeImageConversationMessage(metadata.id, metadata.messageCount + 1, sender, imageBytes, message, identity, store);
    messageResult = written.message;
    cleanupPaths = [written.messagePath, written.imagePath];
  } else {
    const written = await writeConversationMessage(metadata.id, metadata.messageCount + 1, sender, message, identity, store);
    messageResult = written.message;
    cleanupPaths = [written.messagePath];
  }

  const updated = {
    ...metadata,
    updatedAt: messageResult.createdAt,
    messageCount: metadata.messageCount + 1,
    ...(sender === "visitor" ? { lastVisitorSequence: metadata.messageCount + 1 } : {}),
    lastMessagePreview: hasAudio ? "Message vocal" : hasImage ? (message || "Image").slice(0, 180) : message.slice(0, 180),
    lastMessageSender: sender,
    lastMessagePseudo: account.pseudo,
    lastMessageIsHost: isHost,
    adminUnread: !isHost,
    hasAudio: metadata.hasAudio === true || hasAudio,
    hasImage: metadata.hasImage === true || hasImage,
    pseudo: account.pseudo,
    accountId: account.id,
    accountKeyHash: account.keyHash,
    isHost,
  };
  try {
    await writeMetadata(updated, store);
  } catch (error) {
    if (cleanupPaths.length) await store.del(cleanupPaths).catch(() => {});
    throw error;
  }
  return {
    ok: true,
    account: publicAccount(account, isHost),
    conversation: publicConversation({ ...updated, memberAvatarData: account.avatarData || "", memberBadges: account.badges || [] }),
    message: { ...messageResult, ...(account.avatarData ? { avatarData: account.avatarData } : {}), ...(sender === "visitor" ? { badges: normalizeAccountBadges(account.badges) } : {}) },
  };
}

export async function getConversationAudio(conversationId, messageId, store = blob) {
  if (!isConversationId(conversationId) || typeof messageId !== "string" || !isConversationId(messageId)) return null;
  const metadata = await readConversationMetadata(conversationId, store);
  if (!metadata) return null;
  const bucket = conversationState(store).conversations.get(conversationId);
  const page = bucket && bucket.messages.size > 0
    ? { blobs: [...bucket.messages.keys()].map((pathname) => ({ pathname })) }
    : await store.list({ prefix: conversationMessagesPrefix(conversationId), limit: MAX_CONVERSATION_MESSAGES });
  for (const { pathname } of page.blobs) {
    if (!CONVERSATION_MESSAGE_PATH_PATTERN.test(pathname)) continue;
    const mirrored = bucket?.messages.get(pathname);
    const stored = mirrored || await readPrivateJson(pathname, store).catch(() => null);
    if (stored && !mirrored) rememberConversationMessage(conversationId, pathname, stored, store);
    if (stored?.id !== messageId || !isValidConversationMessage(stored, conversationId) || (stored.kind || "text") !== "audio") continue;
    const cachedAudio = bucket?.audio.get(stored.audioPath);
    if (cachedAudio && cachedAudio.length === stored.audioSize) {
      return { bytes: cachedAudio, mimeType: stored.audioMimeType, size: stored.audioSize };
    }
    const audio = await store.get(stored.audioPath, { access: "private", useCache: false });
    if (!audio || audio.statusCode !== 200 || !audio.stream) return null;
    const bytes = Buffer.from(await new Response(audio.stream).arrayBuffer());
    if (bytes.length !== stored.audioSize) return null;
    memoryBucket(conversationId, store).audio.set(stored.audioPath, bytes);
    return { bytes, mimeType: stored.audioMimeType, size: stored.audioSize };
  }
  return null;
}

export async function getConversationImage(conversationId, messageId, store = blob) {
  if (!isConversationId(conversationId) || typeof messageId !== "string" || !isConversationId(messageId)) return null;
  const metadata = await readConversationMetadata(conversationId, store);
  if (!metadata) return null;
  const bucket = conversationState(store).conversations.get(conversationId);
  const page = bucket && bucket.messages.size > 0
    ? { blobs: [...bucket.messages.keys()].map((pathname) => ({ pathname })) }
    : await store.list({ prefix: conversationMessagesPrefix(conversationId), limit: MAX_CONVERSATION_MESSAGES });
  for (const { pathname } of page.blobs || []) {
    if (!CONVERSATION_MESSAGE_PATH_PATTERN.test(pathname)) continue;
    const mirrored = bucket?.messages.get(pathname);
    const stored = mirrored || await readPrivateJson(pathname, store).catch(() => null);
    if (stored && !mirrored) rememberConversationMessage(conversationId, pathname, stored, store);
    if (stored?.id !== messageId || !isValidConversationMessage(stored, conversationId) || (stored.kind || "text") !== "image") continue;
    const cachedImage = bucket?.images?.get(stored.imagePath);
    if (cachedImage && cachedImage.length === stored.imageSize) {
      return { bytes: cachedImage, mimeType: "image/webp", size: stored.imageSize };
    }
    const image = await store.get(stored.imagePath, { access: "private", useCache: false });
    if (!image || image.statusCode !== 200 || !image.stream) return null;
    const bytes = Buffer.from(await new Response(image.stream).arrayBuffer());
    if (bytes.length !== stored.imageSize || !isWebpBytes(bytes)) return null;
    memoryBucket(conversationId, store).images?.set(stored.imagePath, bytes);
    return { bytes, mimeType: "image/webp", size: stored.imageSize };
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

  const isHost = metadata.isHost === true;
  const sender = isHost ? "gionny" : "visitor";
  const identity = { pseudo: metadata.pseudo, isHost };
  const written = await writeConversationMessage(session.id, metadata.messageCount + 1, sender, text, identity, store);
  const message = written.message;
  const updated = {
    ...metadata,
    updatedAt: message.createdAt,
    messageCount: metadata.messageCount + 1,
    lastMessagePreview: text.slice(0, 180),
    lastMessageSender: sender,
    lastMessagePseudo: identity.pseudo,
    lastMessageIsHost: isHost,
    adminUnread: !isHost,
  };
  try {
    await writeMetadata(updated, store);
  } catch (error) {
    await store.del(written.messagePath).catch(() => {});
    throw error;
  }
  return { ok: true, conversation: publicConversation(updated), message };
}

export async function listContactMessages(cursor = "", store = blob) {
  const page = await store.list({
    prefix: LEGACY_PREFIX,
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
  });

  const messages = (await Promise.all(page.blobs.map(({ pathname }) => readLegacyMessage(pathname, store))))
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

  const hasMore = page.hasMore === true && typeof page.cursor === "string";
  return {
    messages,
    hasMore,
    cursor: hasMore ? page.cursor : null,
  };
}

async function readLegacyMessage(pathname, store = blob) {
  try {
    const result = await store.get(pathname, { access: "private", useCache: false });
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
  const hostAssignment = await readHostAssignment(store);
  const hostIdentity = await hostIdentityFromAssignment(hostAssignment, store);
  const activeHostId = hostAssignment?.accountId || null;
  const filter = ["all", "unread", "favorites", "audio"].includes(filters.filter) ? filters.filter : "all";
  const subjectFilter = isConversationSubject(filters.subject) ? normalizedConversationSubject(filters.subject) : "";
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
          if (!isValidMetadata(stored, id)) return null;
          const owner = stored.accountId
            ? await findAccountRecordForConversation(stored, store).catch(() => null)
            : null;
          return publicConversation({
            ...stored,
            hostPseudo: hostIdentity?.pseudo || "",
            memberAvatarData: owner?.account?.avatarData || "",
            memberBadges: normalizeAccountBadges(owner?.account?.badges),
            isHost: Boolean(activeHostId && stored.accountId === activeHostId),
          });
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

export async function countUnreadConversations(store = blob) {
  let cursor = "";
  let unreadCount = 0;
  let hasMore = true;
  while (hasMore) {
    const page = await store.list({
      prefix: CONVERSATION_PREFIX,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const unread = await Promise.all(
      (Array.isArray(page.blobs) ? page.blobs : [])
        .filter(({ pathname }) => CONVERSATION_PATH_PATTERN.test(pathname))
        .map(async ({ pathname }) => {
          const id = pathname.slice(CONVERSATION_PREFIX.length, -5);
          const metadata = await readPrivateJson(pathname, store).catch(() => null);
          return isValidMetadata(metadata, id) && metadata.adminUnread === true;
        })
    );
    unreadCount += unread.filter(Boolean).length;
    hasMore = page.hasMore === true && typeof page.cursor === "string";
    cursor = hasMore ? page.cursor : "";
  }
  return unreadCount;
}

export async function listVisitorAccounts(cursor = "", store = blob) {
  const page = await store.list({
    prefix: ACCOUNT_PREFIX,
    limit: MEMBER_PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
  });
  const activeHostId = await activeHostAccountId(store);
  const members = (await Promise.all(
    (Array.isArray(page.blobs) ? page.blobs : [])
      .filter(({ pathname }) => ACCOUNT_PATH_PATTERN.test(pathname))
      .map(async ({ pathname }) => {
        const match = ACCOUNT_PATH_PATTERN.exec(pathname);
        const account = match ? await readAccountRecord(match[1], store) : null;
        return account ? publicAdminMember(account, account.id === activeHostId) : null;
      })
  )).filter(Boolean);
  members.sort((left, right) => {
    const leftDate = left.createdAt ? Date.parse(left.createdAt) : 0;
    const rightDate = right.createdAt ? Date.parse(right.createdAt) : 0;
    return rightDate - leftDate || left.pseudo.localeCompare(right.pseudo);
  });
  const hasMore = page.hasMore === true && typeof page.cursor === "string";
  return { members, hasMore, cursor: hasMore ? page.cursor : null };
}

async function findAccountRecordById(id, store = blob) {
  if (!isConversationId(id)) return null;
  let cursor = "";
  let hasMore = true;
  while (hasMore) {
    const page = await store.list({
      prefix: ACCOUNT_PREFIX,
      limit: MEMBER_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    for (const { pathname } of Array.isArray(page.blobs) ? page.blobs : []) {
      const match = ACCOUNT_PATH_PATTERN.exec(pathname);
      if (!match) continue;
      const account = await readAccountRecord(match[1], store);
      if (account?.id === id) return { account, keyHash: match[1] };
    }
    hasMore = page.hasMore === true && typeof page.cursor === "string";
    cursor = hasMore ? page.cursor : "";
  }
  return null;
}

async function updateAccountRole(account, role, store = blob) {
  const updatedAccount = { ...account, role, updatedAt: new Date().toISOString() };
  if (account.role !== role) await writeAccountRecord(updatedAccount, store, true);
  if (account.conversationId) {
    const metadata = await readConversationMetadata(account.conversationId, store);
    if (metadata && (
      metadata.pseudo !== account.pseudo ||
      metadata.accountId !== account.id ||
      metadata.accountKeyHash !== account.keyHash ||
      metadata.isHost !== (role === "host")
    )) {
      await writeMetadata({
        ...metadata,
        pseudo: account.pseudo,
        accountId: account.id,
        accountKeyHash: account.keyHash,
        lastMessageIsHost: typeof metadata.lastMessageIsHost === "boolean"
          ? metadata.lastMessageIsHost
          : metadata.lastMessageSender === "gionny" ||
            (metadata.isHost === true && metadata.lastMessageSender === "visitor"),
        isHost: role === "host",
      }, store);
    }
  }
  return updatedAccount;
}

export async function setVisitorAccountBadges(id, badges, store = blob) {
  if (!isConversationId(id) || !Array.isArray(badges) || badges.length > ACCOUNT_BADGES.length ||
      badges.some((badge) => !ACCOUNT_BADGES.includes(badge)) || new Set(badges).size !== badges.length) {
    return { ok: false, reason: "invalid_badges" };
  }
  const targetRecord = await findAccountRecordById(id, store);
  if (!targetRecord) return { ok: false, reason: "not_found" };
  const updatedAccount = { ...targetRecord.account, badges: normalizeAccountBadges(badges), updatedAt: new Date().toISOString() };
  await writeAccountRecord(updatedAccount, store, true);
  const activeHostId = await activeHostAccountId(store);
  return { ok: true, member: publicAdminMember(updatedAccount, updatedAccount.id === activeHostId) };
}

export async function setVisitorAccountRole(id, role, store = blob) {
  if (!["host", "member"].includes(role)) return { ok: false, reason: "invalid_role" };
  const targetRecord = await findAccountRecordById(id, store);
  if (!targetRecord) return { ok: false, reason: "not_found" };
  if (role === "host" && targetRecord.account.status === "banned") return { ok: false, reason: "banned" };

  const previousAssignment = await readHostAssignment(store);
  const previousHostId = previousAssignment?.accountId || null;
  const previousHost = previousHostId && previousHostId !== id
    ? await findAccountRecordById(previousHostId, store)
    : null;
  const assignmentChanged = role === "host" || previousHostId === id;
  if (role === "host") await saveHostAccountId(id, store, targetRecord.keyHash);
  else if (previousHostId === id) await saveHostAccountId(null, store);

  try {
    if (previousHost) await updateAccountRole(previousHost.account, "member", store);
    const updatedAccount = await updateAccountRole(targetRecord.account, role, store);
    return {
      ok: true,
      member: publicAdminMember(updatedAccount, role === "host"),
    };
  } catch (error) {
    if (assignmentChanged) {
      await saveHostAccountId(previousHostId, store, previousAssignment?.accountKeyHash || previousHost?.keyHash || "").catch(() => {});
    }
    throw error;
  }
}

async function deleteAccountSessions(account, store = blob) {
  let cursor = "";
  let hasMore = true;
  while (hasMore) {
    const page = await store.list({
      prefix: ACCOUNT_SESSION_PREFIX,
      limit: MEMBER_PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    const matching = [];
    for (const { pathname } of Array.isArray(page.blobs) ? page.blobs : []) {
      if (!ACCOUNT_SESSION_PATH_PATTERN.test(pathname)) continue;
      const session = await readPrivateJson(pathname, store).catch(() => null);
      if (session?.accountKeyHash === account.keyHash) matching.push(pathname);
    }
    if (matching.length) await store.del(matching);
    hasMore = page.hasMore === true && typeof page.cursor === "string";
    cursor = hasMore ? page.cursor : "";
  }
}

async function rekeyAccountSessions(previousKeyHash, nextKeyHash, store = blob) {
  let cursor = "";
  let hasMore = true;
  const changed = [];
  try {
    while (hasMore) {
      const page = await store.list({
        prefix: ACCOUNT_SESSION_PREFIX,
        limit: MEMBER_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      for (const { pathname } of Array.isArray(page.blobs) ? page.blobs : []) {
        if (!ACCOUNT_SESSION_PATH_PATTERN.test(pathname)) continue;
        const session = await readPrivateJson(pathname, store).catch(() => null);
        if (session?.accountKeyHash !== previousKeyHash) continue;
        await store.put(pathname, JSON.stringify({ ...session, accountKeyHash: nextKeyHash }), {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: "application/json; charset=utf-8",
        });
        changed.push({ pathname, session });
      }
      hasMore = page.hasMore === true && typeof page.cursor === "string";
      cursor = hasMore ? page.cursor : "";
    }
  } catch (error) {
    for (const { pathname, session } of changed) {
      await store.put(pathname, JSON.stringify(session), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json; charset=utf-8",
      }).catch(() => {});
    }
    throw error;
  }
  return changed;
}

export async function setVisitorAccountBanned(id, banned, store = blob) {
  if (typeof banned !== "boolean") return { ok: false, reason: "invalid_status" };
  const record = await findAccountRecordById(id, store);
  if (!record) return { ok: false, reason: "not_found" };
  if (await accountIsHost(record.account, store)) return { ok: false, reason: "host" };
  const updated = {
    ...record.account,
    status: banned ? "banned" : "active",
    updatedAt: new Date().toISOString(),
  };
  await writeAccountRecord(updated, store, true);
  if (banned) await deleteAccountSessions(updated, store);
  return { ok: true, member: publicAdminMember(updated, false) };
}

export async function deleteVisitorAccount(id, store = blob) {
  const record = await findAccountRecordById(id, store);
  if (!record) return { ok: false, reason: "not_found" };
  if (await accountIsHost(record.account, store)) return { ok: false, reason: "host" };
  await store.del(accountPath(record.keyHash));
  await deleteAccountSessions(record.account, store);
  return { ok: true };
}

async function markConversationSenderRead(id, sender, store = blob) {
  if (!isConversationId(id) || !["visitor", "gionny"].includes(sender)) return 0;
  let cursor = "";
  let changed = 0;
  do {
    const page = await store.list({
      prefix: conversationMessagesPrefix(id),
      limit: MAX_CONVERSATION_MESSAGES,
      ...(cursor ? { cursor } : {}),
    });
    for (const { pathname } of (Array.isArray(page.blobs) ? page.blobs : [])) {
      if (!CONVERSATION_MESSAGE_PATH_PATTERN.test(pathname)) continue;
      const stored = await readPrivateJson(pathname, store);
      if (!isValidConversationMessage(stored, id) || stored.sender !== sender || stored.read === true) continue;
      await store.put(pathname, JSON.stringify({ ...stored, read: true }), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json; charset=utf-8",
      });
      changed += 1;
    }
    cursor = page.hasMore === true && typeof page.cursor === "string" ? page.cursor : "";
  } while (cursor);
  return changed;
}

function hasPendingVisitorReadReceipts(metadata) {
  return !Number.isInteger(metadata?.lastVisitorSequence) ||
    !Number.isInteger(metadata?.adminReadSequence) ||
    metadata.adminReadSequence < metadata.lastVisitorSequence;
}

export async function markConversationReadByAdmin(id, store = blob) {
  const metadata = await readConversationMetadata(id, store);
  if (!metadata) return false;
  const markReceipts = hasPendingVisitorReadReceipts(metadata);
  if (!markReceipts && metadata.adminUnread !== true) return true;
  if (markReceipts) await markConversationSenderRead(id, "visitor", store);
  const readThrough = Number.isInteger(metadata.lastVisitorSequence)
    ? metadata.lastVisitorSequence
    : metadata.messageCount;
  await writeMetadata({
    ...metadata,
    adminUnread: false,
    lastVisitorSequence: readThrough,
    adminReadSequence: readThrough,
  }, store);
  return true;
}

export async function markAccountConversationRead(sessionToken, store = blob) {
  const resolved = await resolveAccountSession(sessionToken, store);
  if (!resolved) return { ok: false, reason: "unauthorized" };
  if (await accountIsHost(resolved.account, store)) return { ok: true, changed: 0 };
  const id = resolved.account.conversationId;
  if (!isConversationId(id)) return { ok: true, changed: 0 };
  const metadata = await readConversationMetadata(id, store);
  if (!metadata || metadata.accountId !== resolved.account.id) return { ok: true, changed: 0 };
  const changed = await markConversationSenderRead(id, "gionny", store);
  return { ok: true, changed };
}

export async function getConversationForAdmin(id, store = blob, { afterSequence: requestedAfterSequence, markRead = false } = {}) {
  const metadata = await readConversationMetadata(id, store);
  if (!metadata) return null;
  const hostAssignment = await readHostAssignment(store);
  const hostIdentity = await hostIdentityFromAssignment(hostAssignment, store);
  const owner = metadata.accountId
    ? await findAccountRecordForConversation(metadata, store).catch(() => null)
    : null;
  const memberAvatarData = owner?.account?.avatarData || "";
  const memberBadges = normalizeAccountBadges(owner?.account?.badges);
  const clearAdminUnread = markRead && metadata.adminUnread === true;
  const markUnreadMessagesRead = markRead && hasPendingVisitorReadReceipts(metadata);
  const conversationMetadata = {
    ...metadata,
    hostPseudo: hostIdentity?.pseudo || "",
    memberAvatarData,
    memberBadges,
    isHost: Boolean(hostIdentity && metadata.accountId === hostIdentity.accountId),
    ...(clearAdminUnread ? { adminUnread: false } : {}),
  };
  const afterSequence = Number.isInteger(requestedAfterSequence) &&
      requestedAfterSequence >= 0 && requestedAfterSequence <= MAX_CONVERSATION_MESSAGES &&
      requestedAfterSequence <= metadata.messageCount
    ? requestedAfterSequence
    : null;
  const messagesComplete = afterSequence === null || markUnreadMessagesRead;
  const hasMessagesToLoad = messagesComplete || metadata.messageCount > afterSequence;
  const messages = hasMessagesToLoad
    ? await listMessagesForConversation(id, store, {
        metadata: conversationMetadata,
        hostIdentity,
        memberAvatarData,
        memberBadges,
        ...(afterSequence !== null && !messagesComplete ? { afterSequence } : {}),
        ...(markUnreadMessagesRead ? { markReadSender: "visitor" } : {}),
      })
    : [];
  if (markUnreadMessagesRead || clearAdminUnread) {
    const readThrough = Number.isInteger(metadata.lastVisitorSequence)
      ? metadata.lastVisitorSequence
      : metadata.messageCount;
    await writeMetadata({
      ...metadata,
      adminUnread: false,
      lastVisitorSequence: readThrough,
      adminReadSequence: readThrough,
    }, store);
  }

  const conversation = publicConversation(conversationMetadata);
  if (typeof metadata.hasAudio !== "boolean") {
    try {
      conversation.hasAudio = await conversationHasAudio(id, store);
    } catch {
      // A legacy audio scan should never prevent the private text thread from opening.
    }
  }
  return { conversation, messages, messagesComplete };
}

export async function addAdminReply(id, text, identity, store = blob) {
  const pseudo = normalizeAccountPseudo(identity?.pseudo);
  if (!pseudo || identity?.isHost !== true) return { ok: false, reason: "host_required" };
  const adminIdentity = { pseudo, isHost: true, ...(typeof identity?.avatarData === "string" ? { avatarData: identity.avatarData } : {}) };
  const metadata = await readConversationMetadata(id, store);
  if (!metadata) return { ok: false, reason: "not_found" };
  if (metadata.status === "blocked") return { ok: false, reason: "blocked" };
  if (metadata.status === "closed") return { ok: false, reason: "closed" };
  if (metadata.messageCount >= MAX_CONVERSATION_MESSAGES) return { ok: false, reason: "limit" };

  const written = await writeConversationMessage(
    id,
    metadata.messageCount + 1,
    "gionny",
    text,
    adminIdentity,
    store
  );
  const message = written.message;
  const updated = {
    ...metadata,
    updatedAt: message.createdAt,
    messageCount: metadata.messageCount + 1,
    lastMessagePreview: text.slice(0, 180),
    lastMessageSender: "gionny",
    lastMessagePseudo: adminIdentity.pseudo,
    lastMessageIsHost: true,
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

export async function addAdminImageReply(id, imageBytes, text, identity, store = blob) {
  const pseudo = normalizeAccountPseudo(identity?.pseudo);
  if (!pseudo || identity?.isHost !== true) return { ok: false, reason: "host_required" };
  if (!isWebpBytes(imageBytes) || typeof text !== "string" || text.length > 1500) return { ok: false, reason: "invalid_message" };
  const adminIdentity = { pseudo, isHost: true, ...(typeof identity?.avatarData === "string" ? { avatarData: identity.avatarData } : {}) };
  const metadata = await readConversationMetadata(id, store);
  if (!metadata) return { ok: false, reason: "not_found" };
  if (metadata.status === "blocked") return { ok: false, reason: "blocked" };
  if (metadata.status === "closed") return { ok: false, reason: "closed" };
  if (metadata.messageCount >= MAX_CONVERSATION_MESSAGES) return { ok: false, reason: "limit" };
  const written = await writeImageConversationMessage(id, metadata.messageCount + 1, "gionny", imageBytes, text, adminIdentity, store);
  const message = written.message;
  const updated = {
    ...metadata,
    updatedAt: message.createdAt,
    messageCount: metadata.messageCount + 1,
    lastMessagePreview: (text || "Image").slice(0, 180),
    lastMessageSender: "gionny",
    lastMessagePseudo: adminIdentity.pseudo,
    lastMessageIsHost: true,
    adminUnread: false,
    hasImage: true,
  };
  try {
    await writeMetadata(updated, store);
  } catch (error) {
    await store.del([written.messagePath, written.imagePath]).catch(() => {});
    throw error;
  }
  return {
    ok: true,
    conversation: publicConversation(updated),
    message: { ...message, ...(adminIdentity.avatarData ? { avatarData: adminIdentity.avatarData } : {}) },
  };
}

export async function addAdminAudioReply(id, audioBytes, audioMimeType, identity, store = blob, audioPeaks = []) {
  const pseudo = normalizeAccountPseudo(identity?.pseudo);
  const format = audioFormat(audioMimeType);
  if (!pseudo || identity?.isHost !== true) return { ok: false, reason: "host_required" };
  if (!format || !Buffer.isBuffer(audioBytes) || audioBytes.length < 1 || audioBytes.length > MAX_AUDIO_BYTES) {
    return { ok: false, reason: "invalid_message" };
  }

  const adminIdentity = { pseudo, isHost: true, ...(typeof identity?.avatarData === "string" ? { avatarData: identity.avatarData } : {}) };
  const metadata = await readConversationMetadata(id, store);
  if (!metadata) return { ok: false, reason: "not_found" };
  if (metadata.status === "blocked") return { ok: false, reason: "blocked" };
  if (metadata.status === "closed") return { ok: false, reason: "closed" };
  if (metadata.messageCount >= MAX_CONVERSATION_MESSAGES) return { ok: false, reason: "limit" };

  const written = await writeAudioConversationMessage(
    id,
    metadata.messageCount + 1,
    "gionny",
    audioBytes,
    format.mimeType,
    adminIdentity,
    store,
    audioPeaks
  );
  const message = written.message;
  const updated = {
    ...metadata,
    updatedAt: message.createdAt,
    messageCount: metadata.messageCount + 1,
    lastMessagePreview: "Message vocal",
    lastMessageSender: "gionny",
    lastMessagePseudo: adminIdentity.pseudo,
    lastMessageIsHost: true,
    adminUnread: false,
    hasAudio: true,
  };
  try {
    await writeMetadata(updated, store);
  } catch (error) {
    await store.del([written.messagePath, written.audioPath]).catch(() => {});
    throw error;
  }
  return {
    ok: true,
    conversation: publicConversation(updated),
    message: { ...message, ...(adminIdentity.avatarData ? { avatarData: adminIdentity.avatarData } : {}) },
  };
}

export async function startAdminConversationForAccount(accountId, identity, store = blob) {
  const hostPseudo = normalizeAccountPseudo(identity?.pseudo);
  if (!hostPseudo || identity?.isHost !== true) return { ok: false, reason: "host_required" };
  if (!isConversationId(accountId)) return { ok: false, reason: "not_found" };
  const record = await findAccountRecordById(accountId, store);
  if (!record || record.account.status === "banned") return { ok: false, reason: record ? "banned" : "not_found" };

  const account = record.account;
  const isHost = await accountIsHost(account, store);
  if (isConversationId(account.conversationId)) {
    const existing = await readConversationMetadata(account.conversationId, store);
    if (existing?.accountId === account.id) {
      const state = await getConversationForAdmin(existing.id, store);
      if (state) return { ok: true, ...state, created: false };
    }
  }

  const id = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const now = new Date().toISOString();
  const metadata = {
    version: 1,
    id,
    pseudo: account.pseudo,
    subject: DEFAULT_CONVERSATION_SUBJECT,
    status: "open",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    lastVisitorSequence: 0,
    adminReadSequence: 0,
    lastMessagePreview: "Discussion prête",
    lastMessageSender: "gionny",
    lastMessagePseudo: hostPseudo,
    lastMessageIsHost: true,
    adminUnread: false,
    favorite: false,
    hasAudio: false,
    hasImage: false,
    accountId: account.id,
    accountKeyHash: record.keyHash,
    isHost,
    tokenHash: hashToken(token),
  };
  await writeMetadata(metadata, store);
  const linkedAccount = {
    ...account,
    conversationId: id,
    role: isHost ? "host" : "member",
    updatedAt: now,
  };
  try {
    await writeAccountRecord(linkedAccount, store);
  } catch (error) {
    await store.del(conversationPath(id)).catch(() => {});
    throw error;
  }
  return {
    ok: true,
    conversation: publicConversation({ ...metadata, memberAvatarData: account.avatarData || "", memberBadges: account.badges || [], isHost }),
    messages: [],
    created: true,
  };
}

export async function setAccountConversationSubject(sessionToken, subject, store = blob) {
  const resolved = await resolveAccountSession(sessionToken, store);
  if (!resolved) return { ok: false, reason: "unauthorized" };
  if (!isConversationSubject(subject)) return { ok: false, reason: "subject" };
  const normalizedSubject = normalizedConversationSubject(subject);
  const id = resolved.account.conversationId;
  if (!isConversationId(id)) return { ok: false, reason: "not_found" };
  const metadata = await readConversationMetadata(id, store);
  if (!metadata || metadata.accountId !== resolved.account.id) return { ok: false, reason: "not_found" };
  if (metadata.subject !== normalizedSubject) {
    await writeMetadata({ ...metadata, subject: normalizedSubject, updatedAt: new Date().toISOString() }, store);
  }
  const state = await getAccountConversation(sessionToken, store);
  return state ? { ok: true, ...state } : { ok: false, reason: "unauthorized" };
}

export async function setConversationSubject(id, subject, store = blob) {
  if (!isConversationId(id) || !isConversationSubject(subject)) return null;
  const normalizedSubject = normalizedConversationSubject(subject);
  const metadata = await readConversationMetadata(id, store);
  if (!metadata) return null;
  if (metadata.subject === normalizedSubject) return publicConversation(metadata);
  const updated = { ...metadata, subject: normalizedSubject, updatedAt: new Date().toISOString() };
  await writeMetadata(updated, store);
  return publicConversation(updated);
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

  cursor = "";
  do {
    const page = await store.list({
      prefix: `${CONVERSATION_IMAGE_PREFIX}${id}/`,
      limit: MAX_CONVERSATION_MESSAGES,
      ...(cursor ? { cursor } : {}),
    });
    const paths = page.blobs
      .map(({ pathname }) => pathname)
      .filter((pathname) => IMAGE_PATH_PATTERN.test(pathname));
    if (paths.length) await store.del(paths);
    cursor = page.hasMore === true && typeof page.cursor === "string" ? page.cursor : "";
  } while (cursor);

  await store.del(conversationPath(id));
  forgetConversation(id, store);
  return true;
}

export async function deleteContactMessage(pathname, store = blob) {
  if (!isContactMessagePath(pathname)) return false;
  await store.del(pathname);
  return true;
}
