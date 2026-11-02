import { isAdminRequest, isSameOriginRequest } from "../lib/admin-security.mjs";
import { isBlobStorageConfigured } from "../lib/blob-store.mjs";
import {
  addAccountReply,
  addAdminAudioReply,
  getAccountConversation,
  getAdminReplyIdentity,
  getConversationAudio,
  isConversationId,
  isConversationSubject,
  readAccountSessionCookie,
} from "../lib/contact-inbox.mjs";

const MAX_AUDIO_BYTES = 200_000;
const AUDIO_MIME_TYPES = new Set(["audio/webm", "audio/mp4", "audio/ogg", "audio/aac", "audio/3gpp"]);
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT = 12;
const rateLimits = new Map();

export const config = { api: { bodyParser: false } };

function setNoStore(response) {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Vary", "Origin, Cookie");
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

function firstHeader(value) {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" ? value.split(",")[0].trim() : "";
}

function fullHeader(value) {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" ? value.trim() : "";
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

function mimeTypeFor(request) {
  const contentType = firstHeader(request.headers?.["content-type"]);
  const mimeType = contentType.split(";")[0].trim().toLowerCase();
  return AUDIO_MIME_TYPES.has(mimeType) ? mimeType : "";
}

async function readAudioBody(request) {
  const contentLength = Number(firstHeader(request.headers?.["content-length"]));
  if (Number.isFinite(contentLength) && contentLength > MAX_AUDIO_BYTES) {
    request.resume?.();
    return null;
  }

  let chunks = [];
  let total = 0;
  let tooLarge = false;
  const append = (chunk) => {
    if (tooLarge) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_AUDIO_BYTES) {
      tooLarge = true;
      chunks = [];
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

function parseVoicePeaks(value) {
  if (!value) return [];
  const parts = value.split(",");
  if (parts.length !== 38) return null;
  const peaks = parts.map((part) => Number(part));
  return peaks.every((peak) => Number.isFinite(peak) && peak >= 0 && peak <= 1) ? peaks : null;
}

function sendJson(response, status, data) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  return response.status(status).json(data);
}

function conversationError(reason) {
  if (reason === "host_required") return { status: 409, error: "Aucun compte Hôte actif n’est associé à ce panneau." };
  if (reason === "blocked") return { status: 403, error: "Cette discussion a été bloquée." };
  if (reason === "closed") return { status: 409, error: "Cette discussion est fermée pour le moment." };
  if (reason === "limit") return { status: 409, error: "Cette discussion a atteint sa limite de messages." };
  if (reason === "already_open") return { status: 409, error: "Ta discussion est déjà ouverte. Continue dans ce fil." };
  if (reason === "unauthorized") return { status: 401, error: "Connecte-toi pour continuer la discussion." };
  if (reason === "invalid_message") return { status: 400, error: "Ce vocal dépasse la limite de 200 Ko ou utilise un format non pris en charge." };
  return { status: 404, error: "Cette discussion n’a pas été retrouvée." };
}

function parseRange(value, size) {
  if (typeof value !== "string" || !value.startsWith("bytes=")) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return { invalid: true };
  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}

export default async function handler(request, response) {
  setNoStore(response);
  if (!isSameOriginRequest(request)) return sendJson(response, 403, { error: "Requête refusée." });
  if (!isBlobStorageConfigured()) return sendJson(response, 503, { error: "Le stockage privé des vocaux n’est pas disponible." });

  if (request.method === "POST") {
    const adminReply = firstHeader(request.headers?.["x-admin-reply"]) === "true";
    const sessionToken = readAccountSessionCookie(request);
    if (adminReply) {
      if (!(await isAdminRequest(request))) return sendJson(response, 401, { error: "Reconnecte-toi au panneau d’administration." });
    } else if (!sessionToken) {
      return sendJson(response, 401, { error: "Connecte-toi pour envoyer un vocal." });
    }
    const retryAfter = isRateLimited(clientKey(request));
    if (retryAfter) {
      response.setHeader("Retry-After", String(retryAfter));
      return sendJson(response, 429, { error: "Tu as envoyé plusieurs messages récemment. Réessaie dans quelques minutes." });
    }

    const mimeType = mimeTypeFor(request);
    if (!mimeType) return sendJson(response, 415, { error: "Le format audio de cet appareil n’est pas pris en charge." });
    const encodedSubject = firstHeader(request.headers?.["x-conversation-subject"]);
    let requestedSubject = "";
    try {
      requestedSubject = decodeURIComponent(encodedSubject);
    } catch {
      requestedSubject = "";
    }
    if (!adminReply && !isConversationSubject(requestedSubject)) {
      return sendJson(response, 400, { error: "Choisis un sujet pour ta discussion." });
    }
    const audioPeaks = parseVoicePeaks(fullHeader(request.headers?.["x-voice-peaks"]));
    if (audioPeaks === null) return sendJson(response, 400, { error: "Le profil vocal est invalide." });
    const bytes = await readAudioBody(request);
    if (!bytes) return sendJson(response, 400, { error: "Le vocal est vide ou dépasse la limite de 200 Ko." });
    const subject = requestedSubject;

    try {
      if (adminReply) {
        const conversationId = firstHeader(request.headers?.["x-conversation-id"]);
        if (!isConversationId(conversationId)) return sendJson(response, 400, { error: "Choisis une discussion valide." });
        const identity = await getAdminReplyIdentity(request);
        const result = await addAdminAudioReply(conversationId, bytes, mimeType, identity, undefined, audioPeaks);
        if (!result.ok) {
          const failure = conversationError(result.reason);
          return sendJson(response, failure.status, { error: failure.error });
        }
        return sendJson(response, 201, { ok: true, conversation: result.conversation, message: result.message });
      }

      const result = await addAccountReply(sessionToken, {
        message: "",
        subject,
        audioBytes: bytes,
        audioMimeType: mimeType,
        audioPeaks,
        newConversation: firstHeader(request.headers?.["x-new-conversation"]) === "true",
      });
      if (!result.ok) {
        const failure = conversationError(result.reason);
        return sendJson(response, failure.status, { error: failure.error });
      }
      return sendJson(response, result.messages ? 201 : 200, {
        ok: true,
        account: result.account,
        conversation: result.conversation,
        ...(result.messages ? { messages: result.messages } : { message: result.message }),
      });
    } catch (error) {
      console.error("[contact-audio] private audio save failed", {
        name: error instanceof Error ? error.name : "UnknownError",
        code: typeof error?.code === "string" ? error.code : undefined,
      });
      return sendJson(response, 502, { error: "Le vocal n’a pas pu être envoyé. Réessaie dans un instant." });
    }
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD, POST");
    return sendJson(response, 405, { error: "Méthode non autorisée." });
  }

  const conversationId = queryValue(request, "conversationId");
  const messageId = queryValue(request, "messageId");
  if (!conversationId || !messageId) return sendJson(response, 400, { error: "Ce vocal est introuvable." });

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
  if (!authorized) return sendJson(response, 401, { error: "Tu n’as pas accès à ce vocal." });

  try {
    const audio = await getConversationAudio(conversationId, messageId);
    if (!audio) return sendJson(response, 404, { error: "Ce vocal n’existe plus." });
    response.setHeader("Content-Type", audio.mimeType);
    response.setHeader("Content-Length", String(audio.size));
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Disposition", "inline; filename=message-vocal");
    if (request.method === "HEAD") return response.status(200).end();

    const range = parseRange(request.headers?.range, audio.size);
    if (range?.invalid) {
      response.setHeader("Content-Range", `bytes */${audio.size}`);
      return response.status(416).end();
    }
    if (range) {
      const selected = audio.bytes.subarray(range.start, range.end + 1);
      response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${audio.size}`);
      response.setHeader("Content-Length", String(selected.length));
      return response.status(206).send(selected);
    }
    return response.status(200).send(audio.bytes);
  } catch (error) {
    console.error("[contact-audio] private audio read failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
    return sendJson(response, 502, { error: "Le vocal n’a pas pu être lu. Réessaie." });
  }
}
