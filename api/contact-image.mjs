import { isAdminRequest, isSameOriginRequest } from "../lib/admin-security.mjs";
import { isBlobStorageConfigured } from "../lib/blob-store.mjs";
import {
  addAccountReply,
  addAdminImageReply,
  getAccountConversation,
  getAdminReplyIdentity,
  getConversationImage,
  isConversationId,
  isConversationSubject,
  readAccountSessionCookie,
} from "../lib/contact-inbox.mjs";

const MAX_IMAGE_BYTES = 40_000;
const MAX_CAPTION_LENGTH = 1_500;
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT = 12;
const rateLimits = new Map();

export const config = { api: { bodyParser: false } };

function setNoStore(response) {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Vary", "Origin, Cookie");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function firstHeader(value) {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" ? value.split(",")[0].trim() : "";
}

function queryValue(request, key) {
  const value = request.query?.[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  try {
    return new URL(request.url || "/", `https://${request.headers?.host || "localhost"}`).searchParams.get(key) || "";
  } catch {
    return "";
  }
}

function clientKey(request) {
  const headers = request.headers || {};
  return (firstHeader(headers["x-vercel-forwarded-for"]) || firstHeader(headers["x-real-ip"]) || firstHeader(headers["x-forwarded-for"]) || "unknown").slice(0, 100);
}

function isRateLimited(key) {
  const now = Date.now();
  let state = rateLimits.get(key);
  if (!state || state.resetAt <= now) state = { count: 0, resetAt: now + RATE_WINDOW_MS };
  state.count += 1;
  rateLimits.set(key, state);
  if (rateLimits.size > 2000) {
    for (const [storedKey, storedState] of rateLimits) {
      if (storedState.resetAt <= now) rateLimits.delete(storedKey);
    }
  }
  return state.count > RATE_LIMIT ? Math.max(1, Math.ceil((state.resetAt - now) / 1000)) : 0;
}

function cleanMessage(value) {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .trim();
}

function readHeaderText(value, limit = MAX_CAPTION_LENGTH) {
  const encoded = firstHeader(value);
  if (!encoded || encoded.length > limit * 12) return "";
  try {
    return cleanMessage(decodeURIComponent(encoded));
  } catch {
    return "";
  }
}

function isWebp(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 12 && bytes.length <= MAX_IMAGE_BYTES &&
    bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
}

async function readImageBody(request) {
  const contentLength = Number(firstHeader(request.headers?.["content-length"]));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
    request.resume?.();
    return null;
  }
  const chunks = [];
  let total = 0;
  let tooLarge = false;
  const append = (chunk) => {
    if (tooLarge) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_IMAGE_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      return;
    }
    chunks.push(buffer);
  };
  if (Buffer.isBuffer(request.body) || request.body instanceof Uint8Array) {
    append(request.body);
  } else if (typeof request.body === "string") {
    append(Buffer.from(request.body, "binary"));
  } else if (request.body !== undefined && request.body !== null) {
    return null;
  } else {
    try {
      for await (const chunk of request) append(chunk);
    } catch {
      return null;
    }
  }
  return !tooLarge && total > 0 ? Buffer.concat(chunks, total) : null;
}

function sendJson(response, status, data) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  return response.status(status).json(data);
}

function imageError(reason) {
  if (reason === "blocked") return { status: 403, error: "Cette discussion a été bloquée." };
  if (reason === "closed") return { status: 409, error: "Cette discussion est fermée pour le moment." };
  if (reason === "limit") return { status: 409, error: "Cette discussion a atteint sa limite de messages." };
  if (reason === "already_open") return { status: 409, error: "Ta discussion est déjà ouverte. Continue dans ce fil." };
  if (reason === "invalid_message") return { status: 400, error: "L’image doit être un WebP compressé de moins de 40 Ko." };
  if (reason === "host_required") return { status: 409, error: "Aucun compte Hôte actif n’est associé à ce panneau." };
  if (reason === "unauthorized") return { status: 401, error: "Connecte-toi pour envoyer une image." };
  return { status: 404, error: "Cette discussion est introuvable." };
}

export default async function handler(request, response) {
  setNoStore(response);
  if (!isSameOriginRequest(request)) return sendJson(response, 403, { error: "Requête refusée." });
  if (!isBlobStorageConfigured()) return sendJson(response, 503, { error: "Le stockage privé des pièces jointes n’est pas disponible." });

  if (request.method === "POST") {
    const retryAfter = isRateLimited(clientKey(request));
    if (retryAfter) {
      response.setHeader("Retry-After", String(retryAfter));
      return sendJson(response, 429, { error: "Tu as envoyé plusieurs messages récemment. Réessaie dans quelques minutes." });
    }
    const contentType = firstHeader(request.headers?.["content-type"]).split(";")[0].trim().toLowerCase();
    if (contentType !== "image/webp") return sendJson(response, 415, { error: "Choisis une image WebP compressée." });
    const bytes = await readImageBody(request);
    if (!isWebp(bytes)) return sendJson(response, 400, { error: "L’image est vide, invalide ou dépasse 40 Ko." });
    const message = readHeaderText(request.headers?.["x-message-text"]);
    if (message.length > MAX_CAPTION_LENGTH) return sendJson(response, 400, { error: "Le texte dépasse 1 500 caractères." });

    const adminReply = firstHeader(request.headers?.["x-admin-reply"]) === "true";
    if (adminReply) {
      if (!(await isAdminRequest(request))) return sendJson(response, 401, { error: "Reconnecte-toi au panneau d’administration." });
      const conversationId = firstHeader(request.headers?.["x-conversation-id"]);
      if (!isConversationId(conversationId)) return sendJson(response, 400, { error: "Choisis une discussion valide." });
      try {
        const identity = await getAdminReplyIdentity(request);
        const result = await addAdminImageReply(conversationId, bytes, message, identity);
        if (!result.ok) {
          const failure = imageError(result.reason);
          return sendJson(response, failure.status, { error: failure.error });
        }
        return sendJson(response, 201, { ok: true, conversation: result.conversation, message: result.message });
      } catch (error) {
        console.error("[contact-image] Admin image save failed", {
          name: error instanceof Error ? error.name : "UnknownError",
          code: typeof error?.code === "string" ? error.code : undefined,
        });
        return sendJson(response, 502, { error: "L’image n’a pas pu être envoyée. Réessaie." });
      }
    }

    if (readHeaderText(request.headers?.["x-website"], 256)) return sendJson(response, 201, { ok: true });
    const sessionToken = readAccountSessionCookie(request);
    if (!sessionToken) return sendJson(response, 401, { error: "Connecte-toi pour envoyer une image." });
    const encodedSubject = firstHeader(request.headers?.["x-conversation-subject"]);
    let subject = "";
    try { subject = decodeURIComponent(encodedSubject); } catch { /* invalid subject below */ }
    if (!isConversationSubject(subject)) return sendJson(response, 400, { error: "Choisis un sujet pour ta discussion." });
    try {
      const result = await addAccountReply(sessionToken, {
        message,
        subject,
        imageBytes: bytes,
        newConversation: firstHeader(request.headers?.["x-new-conversation"]) === "true",
      });
      if (!result.ok) {
        const failure = imageError(result.reason);
        return sendJson(response, failure.status, { error: failure.error });
      }
      return sendJson(response, result.messages ? 201 : 200, {
        ok: true,
        account: result.account,
        conversation: result.conversation,
        ...(result.messages ? { messages: result.messages } : { message: result.message }),
      });
    } catch (error) {
      console.error("[contact-image] private image save failed", {
        name: error instanceof Error ? error.name : "UnknownError",
        code: typeof error?.code === "string" ? error.code : undefined,
      });
      return sendJson(response, 502, { error: "L’image n’a pas pu être envoyée. Réessaie." });
    }
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD, POST");
    return sendJson(response, 405, { error: "Méthode non autorisée." });
  }
  const conversationId = queryValue(request, "conversationId");
  const messageId = queryValue(request, "messageId");
  if (!isConversationId(conversationId) || !isConversationId(messageId)) return sendJson(response, 400, { error: "Cette image est introuvable." });

  const sessionToken = readAccountSessionCookie(request);
  let authorized = await isAdminRequest(request);
  if (!authorized && sessionToken) {
    try {
      const state = await getAccountConversation(sessionToken);
      authorized = state?.conversation?.id === conversationId;
    } catch {
      authorized = false;
    }
  }
  if (!authorized) return sendJson(response, 401, { error: "Tu n’as pas accès à cette image." });

  try {
    const image = await getConversationImage(conversationId, messageId);
    if (!image) return sendJson(response, 404, { error: "Cette image n’existe plus." });
    response.setHeader("Content-Type", "image/webp");
    response.setHeader("Content-Length", String(image.size));
    response.setHeader("Content-Disposition", "inline; filename=piece-jointe.webp");
    if (request.method === "HEAD") return response.status(200).end();
    return response.status(200).send(image.bytes);
  } catch (error) {
    console.error("[contact-image] private image read failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
    return sendJson(response, 502, { error: "L’image n’a pas pu être chargée. Réessaie." });
  }
}
