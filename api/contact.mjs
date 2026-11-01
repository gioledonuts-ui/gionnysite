import { isSameOriginRequest } from "../lib/admin-security.mjs";
import { isBlobStorageConfigured } from "../lib/blob-store.mjs";
import {
  addVisitorReply,
  clearVisitorConversationCookie,
  createConversation,
  getVisitorConversation,
  readVisitorConversationCookie,
  saveVisitorConversationCookie,
} from "../lib/contact-inbox.mjs";

const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_MESSAGES_PER_WINDOW = 12;
const MAX_BODY_BYTES = 12_000;
const rateLimits = new Map();

function setNoStore(response) {
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Vary", "Origin, Cookie");
}

function readJsonBody(request) {
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
    try {
      return Buffer.byteLength(JSON.stringify(request.body), "utf8") <= MAX_BODY_BYTES
        ? request.body
        : null;
    } catch {
      return null;
    }
  }

  const raw = Buffer.isBuffer(request.body)
    ? request.body.toString("utf8")
    : typeof request.body === "string"
      ? request.body
      : "";
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function firstHeader(value) {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" ? value.split(",")[0].trim() : "";
}

function getClientKey(request) {
  const headers = request.headers || {};
  return (
    firstHeader(headers["x-vercel-forwarded-for"]) ||
    firstHeader(headers["x-real-ip"]) ||
    firstHeader(headers["x-forwarded-for"]) ||
    "unknown"
  ).slice(0, 100);
}

function isRateLimited(key) {
  const now = Date.now();
  let state = rateLimits.get(key);
  if (!state || state.resetAt <= now) {
    state = { count: 0, resetAt: now + RATE_WINDOW_MS };
  }
  state.count += 1;
  rateLimits.set(key, state);

  if (rateLimits.size > 2000) {
    for (const [storedKey, storedState] of rateLimits) {
      if (storedState.resetAt <= now) rateLimits.delete(storedKey);
    }
  }

  return state.count > MAX_MESSAGES_PER_WINDOW
    ? Math.max(1, Math.ceil((state.resetAt - now) / 1000))
    : 0;
}

function cleanPseudo(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function cleanMessage(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .trim();
}

function conversationError(reason) {
  if (reason === "blocked") {
    return { status: 403, error: "Cette discussion a été bloquée." };
  }
  if (reason === "closed") {
    return { status: 409, error: "Cette discussion est fermée pour le moment." };
  }
  if (reason === "limit") {
    return { status: 409, error: "Cette discussion a atteint sa limite de messages." };
  }
  return { status: 404, error: "Cette discussion n’a pas été retrouvée. Tu peux en démarrer une nouvelle." };
}

async function createVisitorThread(request, response, { pseudo, message }) {
  const thread = await createConversation({ pseudo, message });
  saveVisitorConversationCookie(request, response, thread.cookieValue);
  return response.status(201).json({
    ok: true,
    conversation: thread.conversation,
    messages: thread.messages,
  });
}

export default async function handler(request, response) {
  setNoStore(response);

  if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
    response.setHeader("Allow", "GET, POST, DELETE");
    return response.status(405).json({ error: "Méthode non autorisée." });
  }
  if (!isSameOriginRequest(request)) {
    return response.status(403).json({ error: "Requête refusée." });
  }

  const cookieValue = readVisitorConversationCookie(request);

  if (request.method === "GET") {
    if (!cookieValue || !isBlobStorageConfigured()) {
      return response.status(200).json({ conversation: null, messages: [] });
    }

    try {
      const thread = await getVisitorConversation(cookieValue);
      if (!thread) clearVisitorConversationCookie(request, response);
      return response.status(200).json(thread || { conversation: null, messages: [] });
    } catch (error) {
      console.error("[contact] private conversation read failed", {
        name: error instanceof Error ? error.name : "UnknownError",
        code: typeof error?.code === "string" ? error.code : undefined,
      });
      return response.status(502).json({ error: "La discussion n’a pas pu être chargée. Réessaie." });
    }
  }

  if (request.method === "DELETE") {
    if (cookieValue && isBlobStorageConfigured()) {
      try {
        const thread = await getVisitorConversation(cookieValue);
        if (thread?.conversation.status === "blocked") {
          return response.status(403).json({ error: "Cette discussion a été bloquée." });
        }
      } catch {
        // Clearing an unreadable visitor cookie is safe; no conversation data is changed.
      }
    }
    clearVisitorConversationCookie(request, response);
    return response.status(200).json({ cleared: true });
  }

  const body = readJsonBody(request);
  if (!body || typeof body !== "object") {
    return response.status(400).json({ error: "Le formulaire est incomplet. Réessaie." });
  }

  // Silent honeypot response: automated submissions are not stored.
  if (typeof body.website === "string" && body.website.trim()) {
    return response.status(201).json({ ok: true });
  }

  const message = cleanMessage(body.message);
  if (message.length < 1 || message.length > 1500) {
    return response.status(400).json({
      error: "Écris un message de 1 à 1 500 caractères.",
    });
  }

  const pseudo = cleanPseudo(body.pseudo);
  const isNewConversation = body.newConversation === true;
  if (!cookieValue || isNewConversation) {
    if (pseudo.length < 2 || pseudo.length > 32) {
      return response.status(400).json({
        error: "Ajoute un pseudo de 2 à 32 caractères pour démarrer la discussion.",
      });
    }
  }

  const retryAfter = isRateLimited(getClientKey(request));
  if (retryAfter) {
    response.setHeader("Retry-After", String(retryAfter));
    return response.status(429).json({
      error: "Tu as envoyé plusieurs messages récemment. Réessaie dans quelques minutes.",
    });
  }

  if (!isBlobStorageConfigured()) {
    return response.status(503).json({
      error: "La discussion est momentanément indisponible. Réessaie plus tard.",
    });
  }

  try {
    if (cookieValue && isNewConversation) {
      const previous = await getVisitorConversation(cookieValue);
      if (previous?.conversation.status === "blocked") {
        return response.status(403).json({ error: "Cette discussion a été bloquée." });
      }
      if (previous?.conversation.status === "open") {
        return response.status(409).json({ error: "Ta discussion est déjà ouverte. Continue dans ce fil." });
      }
      // A closed discussion can be replaced by a new one in this browser.
      return await createVisitorThread(request, response, { pseudo, message });
    }

    if (cookieValue) {
      const result = await addVisitorReply(cookieValue, message);
      if (!result.ok) {
        const failure = conversationError(result.reason);
        return response.status(failure.status).json({ error: failure.error });
      }
      return response.status(200).json({
        ok: true,
        conversation: result.conversation,
        message: result.message,
      });
    }

    return await createVisitorThread(request, response, { pseudo, message });
  } catch (error) {
    console.error("[contact] private conversation save failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
    return response.status(502).json({
      error: "Ton message n’a pas pu être envoyé. Réessaie dans un instant.",
    });
  }
}
