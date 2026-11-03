import { isSameOriginRequest } from "../lib/admin-security.mjs";
import { isBlobStorageConfigured } from "../lib/blob-store.mjs";
import {
  addAccountReply,
  clearAccountSessionCookie,
  clearVisitorConversationCookie,
  clearVisitorAccountSession,
  CONVERSATION_SUBJECTS,
  getAccountConversation,
  isConversationSubject,
  loginVisitorAccount,
  markAccountConversationRead,
  readAccountSessionCookie,
  readVisitorConversationCookie,
  registerVisitorAccount,
  saveAccountSessionCookie,
  setAccountConversationSubject,
  updateVisitorAccountProfile,
} from "../lib/contact-inbox.mjs";

const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 12;
const MAX_BODY_BYTES = 14_000;
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
  if (!state || state.resetAt <= now) state = { count: 0, resetAt: now + RATE_WINDOW_MS };
  state.count += 1;
  rateLimits.set(key, state);

  if (rateLimits.size > 2000) {
    for (const [storedKey, storedState] of rateLimits) {
      if (storedState.resetAt <= now) rateLimits.delete(storedKey);
    }
  }

  return state.count > MAX_REQUESTS_PER_WINDOW
    ? Math.max(1, Math.ceil((state.resetAt - now) / 1000))
    : 0;
}

function readAfterSequence(request) {
  let value = request.query?.after;
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== "string") {
    try {
      value = new URL(request.url || "/", `https://${request.headers?.host || "localhost"}`).searchParams.get("after");
    } catch {
      return null;
    }
  }
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,2})$/u.test(value)) return null;
  const sequence = Number(value);
  return sequence <= 400 ? sequence : null;
}

function cleanMessage(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .trim();
}

function setRateLimitResponse(response, retryAfter) {
  if (!retryAfter) return false;
  response.setHeader("Retry-After", String(retryAfter));
  response.status(429).json({ error: "Tu as envoyé plusieurs demandes récemment. Réessaie dans quelques minutes." });
  return true;
}

function threadError(reason) {
  if (reason === "blocked") return { status: 403, error: "Cette discussion a été bloquée." };
  if (reason === "closed") return { status: 409, error: "Cette discussion est fermée pour le moment." };
  if (reason === "limit") return { status: 409, error: "Cette discussion a atteint sa limite de messages." };
  if (reason === "already_open") return { status: 409, error: "Ta discussion est déjà ouverte. Continue dans ce fil." };
  if (reason === "invalid_message") return { status: 400, error: "Le message vocal ne peut pas être enregistré. Réessaie." };
  if (reason === "unauthorized") return { status: 401, error: "Connecte-toi pour continuer la discussion." };
  return { status: 404, error: "Cette discussion n’a pas été retrouvée. Tu peux en démarrer une nouvelle." };
}

async function handleAuthentication(request, response, body, action) {
  const retryAfter = isRateLimited(`auth:${getClientKey(request)}`);
  if (setRateLimitResponse(response, retryAfter)) return;
  if (!isBlobStorageConfigured()) {
    response.status(503).json({ error: "La discussion est momentanément indisponible. Réessaie plus tard." });
    return;
  }

  const credentials = {
    pseudo: typeof body.pseudo === "string" ? body.pseudo.trim() : "",
    password: typeof body.password === "string" ? body.password : "",
    legacyCookieValue: readVisitorConversationCookie(request),
  };
  const result = action === "register"
    ? await registerVisitorAccount(credentials)
    : await loginVisitorAccount(credentials);

  if (!result.ok) {
    if (result.reason === "pseudo") {
      response.status(400).json({ error: "Le pseudo doit contenir entre 3 et 16 caractères, sans espace au début ni à la fin." });
      return;
    }
    if (result.reason === "password") {
      response.status(400).json({ error: "Le mot de passe doit contenir entre 8 et 128 caractères." });
      return;
    }
    if (result.reason === "exists") {
      response.status(409).json({ error: "Ce pseudo a déjà un compte. Essaie de te connecter." });
      return;
    }
    if (result.reason === "banned") {
      response.status(403).json({ error: "Ce compte a été désactivé par l’administration." });
      return;
    }
    response.status(401).json({ error: "Pseudo ou mot de passe incorrect." });
    return;
  }

  saveAccountSessionCookie(request, response, result.sessionToken);
  const state = await getAccountConversation(result.sessionToken);
  response.status(action === "register" ? 201 : 200).json({
    ok: true,
    account: state?.account || result.account,
    conversation: state?.conversation || null,
    messages: state?.messages || [],
    subjects: CONVERSATION_SUBJECTS,
  });
}

async function handleProfile(request, response, body, sessionToken) {
  if (!sessionToken) return response.status(401).json({ error: "Connecte-toi pour modifier ton profil." });
  const retryAfter = isRateLimited(`profile:${getClientKey(request)}`);
  if (setRateLimitResponse(response, retryAfter)) return;
  if (!isBlobStorageConfigured()) {
    return response.status(503).json({ error: "La discussion est momentanément indisponible. Réessaie plus tard." });
  }

  const result = await updateVisitorAccountProfile(sessionToken, {
    pseudo: Object.hasOwn(body, "pseudo") ? body.pseudo : undefined,
    currentPassword: typeof body.currentPassword === "string" ? body.currentPassword : "",
    newPassword: Object.hasOwn(body, "newPassword") ? body.newPassword : "",
    avatarData: Object.hasOwn(body, "avatarData") ? body.avatarData : undefined,
  });
  if (!result.ok) {
    if (result.reason === "unauthorized") return response.status(401).json({ error: "Reconnecte-toi pour modifier ton profil." });
    if (result.reason === "cooldown") {
      return response.status(409).json({
        error: `Prochain changement possible dans ${result.daysRemaining} jours.`,
        daysRemaining: result.daysRemaining,
        nextUsernameChangeAt: result.nextUsernameChangeAt,
      });
    }
    if (result.reason === "exists") return response.status(409).json({ error: "Ce pseudo est déjà utilisé." });
    if (result.reason === "pseudo") return response.status(400).json({ error: "Le pseudo doit contenir entre 3 et 16 caractères, sans espace au début ni à la fin." });
    if (result.reason === "password") return response.status(400).json({ error: "Le nouveau mot de passe doit contenir entre 8 et 128 caractères." });
    if (result.reason === "current_password") return response.status(400).json({ error: "Le mot de passe actuel est incorrect." });
    if (result.reason === "no_changes") return response.status(400).json({ error: "Aucune modification à enregistrer." });
    if (result.reason === "avatar") return response.status(400).json({ error: "L’image doit être un WebP carré de moins de 10 Ko." });
    return response.status(400).json({ error: "Le profil n’a pas pu être modifié." });
  }

  const state = await getAccountConversation(sessionToken);
  if (!state) {
    clearAccountSessionCookie(request, response);
    return response.status(401).json({ error: "Reconnecte-toi pour modifier ton profil." });
  }
  return response.status(200).json({ ok: true, ...state, subjects: CONVERSATION_SUBJECTS });
}

export default async function handler(request, response) {
  setNoStore(response);

  if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
    response.setHeader("Allow", "GET, POST, DELETE");
    return response.status(405).json({ error: "Méthode non autorisée." });
  }
  if (!isSameOriginRequest(request)) return response.status(403).json({ error: "Requête refusée." });

  const sessionToken = readAccountSessionCookie(request);

  if (request.method === "GET") {
    if (!sessionToken) {
      return response.status(200).json({ account: null, conversation: null, messages: [], subjects: CONVERSATION_SUBJECTS });
    }
    if (!isBlobStorageConfigured()) {
      return response.status(503).json({ error: "La discussion est momentanément indisponible. Réessaie plus tard." });
    }
    try {
      const afterSequence = readAfterSequence(request);
      const state = await getAccountConversation(sessionToken, undefined, afterSequence === null ? {} : { afterSequence });
      if (!state) {
        clearAccountSessionCookie(request, response);
        return response.status(200).json({ account: null, conversation: null, messages: [], subjects: CONVERSATION_SUBJECTS });
      }
      return response.status(200).json({ ...state, subjects: CONVERSATION_SUBJECTS });
    } catch (error) {
      console.error("[contact] private conversation read failed", {
        name: error instanceof Error ? error.name : "UnknownError",
        code: typeof error?.code === "string" ? error.code : undefined,
      });
      return response.status(502).json({ error: "La discussion n’a pas pu être chargée. Réessaie." });
    }
  }

  if (request.method === "DELETE") {
    clearVisitorConversationCookie(request, response);
    return response.status(200).json({ cleared: true });
  }

  const body = readJsonBody(request);
  if (!body || typeof body !== "object") {
    return response.status(400).json({ error: "Le formulaire est incomplet. Réessaie." });
  }
  if (typeof body.website === "string" && body.website.trim()) return response.status(201).json({ ok: true });

  const action = typeof body.action === "string" ? body.action : "send";
  if (action === "register" || action === "login") {
    try {
      return await handleAuthentication(request, response, body, action);
    } catch (error) {
      console.error("[contact] account authentication failed", {
        name: error instanceof Error ? error.name : "UnknownError",
        code: typeof error?.code === "string" ? error.code : undefined,
      });
      return response.status(502).json({ error: "La connexion n’a pas pu aboutir. Réessaie dans un instant." });
    }
  }

  if (action === "logout") {
    if (sessionToken && isBlobStorageConfigured()) {
      try {
        await clearVisitorAccountSession(sessionToken);
      } catch {
        // Clearing the browser cookie still prevents further use of this session.
      }
    }
    clearAccountSessionCookie(request, response);
    return response.status(200).json({ ok: true });
  }

  if (action === "mark-read") {
    if (!sessionToken) return response.status(401).json({ error: "Connecte-toi pour ouvrir ta discussion." });
    if (!isBlobStorageConfigured()) {
      return response.status(503).json({ error: "La discussion est momentanément indisponible. Réessaie plus tard." });
    }
    try {
      const result = await markAccountConversationRead(sessionToken);
      if (!result.ok) return response.status(401).json({ error: "Reconnecte-toi pour ouvrir ta discussion." });
      return response.status(200).json({ ok: true, changed: result.changed });
    } catch (error) {
      console.error("[contact] read receipt update failed", {
        name: error instanceof Error ? error.name : "UnknownError",
        code: typeof error?.code === "string" ? error.code : undefined,
      });
      return response.status(502).json({ error: "La lecture n’a pas pu être enregistrée." });
    }
  }

  if (action === "subject") {
    if (!sessionToken) return response.status(401).json({ error: "Connecte-toi pour modifier le sujet." });
    if (!isBlobStorageConfigured()) {
      return response.status(503).json({ error: "La discussion est momentanément indisponible. Réessaie plus tard." });
    }
    try {
      const result = await setAccountConversationSubject(sessionToken, body.subject);
      if (!result.ok) {
        if (result.reason === "subject") return response.status(400).json({ error: "Choisis un sujet valide." });
        if (result.reason === "unauthorized") return response.status(401).json({ error: "Reconnecte-toi pour modifier le sujet." });
        return response.status(404).json({ error: "Cette discussion est introuvable." });
      }
      return response.status(200).json({ ok: true, account: result.account, conversation: result.conversation, messages: result.messages, subjects: CONVERSATION_SUBJECTS });
    } catch (error) {
      console.error("[contact] subject update failed", {
        name: error instanceof Error ? error.name : "UnknownError",
        code: typeof error?.code === "string" ? error.code : undefined,
      });
      return response.status(502).json({ error: "Le sujet n’a pas pu être modifié." });
    }
  }

  if (action === "profile") {
    try {
      return await handleProfile(request, response, body, sessionToken);
    } catch (error) {
      console.error("[contact] account profile update failed", {
        name: error instanceof Error ? error.name : "UnknownError",
        code: typeof error?.code === "string" ? error.code : undefined,
      });
      return response.status(502).json({ error: "Le profil n’a pas pu être enregistré. Réessaie dans un instant." });
    }
  }

  if (action !== "send") return response.status(400).json({ error: "Cette action n’est pas reconnue." });
  if (!sessionToken) return response.status(401).json({ error: "Crée un compte ou connecte-toi pour écrire." });

  const message = cleanMessage(body.message);
  if (message.length < 1 || message.length > 1500) {
    return response.status(400).json({ error: "Écris un message de 1 à 1 500 caractères." });
  }
  const subject = typeof body.subject === "string" ? body.subject : "";
  if (!isConversationSubject(subject)) return response.status(400).json({ error: "Choisis un sujet pour ta discussion." });

  const retryAfter = isRateLimited(`message:${getClientKey(request)}`);
  if (setRateLimitResponse(response, retryAfter)) return;
  if (!isBlobStorageConfigured()) {
    return response.status(503).json({ error: "La discussion est momentanément indisponible. Réessaie plus tard." });
  }

  try {
    const result = await addAccountReply(sessionToken, { message, subject, newConversation: body.newConversation === true });
    if (!result.ok) {
      const failure = threadError(result.reason);
      return response.status(failure.status).json({ error: failure.error });
    }
    return response.status(result.messages ? 201 : 200).json({
      ok: true,
      account: result.account,
      conversation: result.conversation,
      ...(result.messages ? { messages: result.messages } : { message: result.message }),
    });
  } catch (error) {
    console.error("[contact] private conversation save failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
    return response.status(502).json({ error: "Ton message n’a pas pu être envoyé. Réessaie dans un instant." });
  }
}
