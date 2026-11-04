import { isSameOriginRequest } from "../lib/admin-security.mjs";
import {
  addAccountReply,
  clearAccountSessionCookie,
  clearVisitorConversationCookie,
  clearVisitorAccountSession,
  CONVERSATION_SUBJECTS,
  getAccountConversation,
  ensureOwnerAccountSeeded,
  isConversationSubject,
  loginVisitorAccount,
  restoreMembersFromClient,
  restoreVisitorStateFromClient,
  markAccountConversationRead,
  readAccountSessionCookie,
  readVisitorConversationCookie,
  registerVisitorAccount,
  saveAccountSessionCookie,
  setAccountConversationSubject,
  updateVisitorAccountProfile,
} from "../lib/contact-inbox.mjs";
import { ensureStateLoaded, syncStateToSupabase } from "../lib/blob-store.mjs";

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

// Why the failure happened, said plainly and in the user's words.
function authenticationFailure(response, reason) {
  if (reason === "password") {
    return response.status(401).json({ error: "Mot de passe incorrect.", reason });
  }
  if (reason === "not_found") {
    return response.status(404).json({ error: "Compte introuvable. Crée-le avec « S’inscrire ».", reason });
  }
  if (reason === "exists") {
    return response.status(409).json({ error: "Ce pseudo est déjà pris. Choisis-en un autre ou connecte-toi.", reason });
  }
  if (reason === "password_invalid") {
    return response.status(400).json({ error: "Le mot de passe doit contenir entre 8 et 128 caractères.", reason });
  }
  if (reason === "pseudo") {
    return response.status(400).json({
      error: "Le pseudo doit contenir entre 3 et 16 caractères, sans espace au début ni à la fin.",
      reason,
    });
  }
  if (reason === "banned") {
    return response.status(403).json({ error: "Ce compte a été désactivé par l’administration.", reason });
  }
  if (reason === "owner_claim") {
    return response.status(409).json({ error: "Ce pseudo est déjà pris. Choisis-en un autre.", reason });
  }
  return response.status(400).json({ error: "La connexion n’a pas abouti. Réessaie.", reason });
}

async function handleAuthentication(request, response, body, action) {
  // Login and registration are never rate limited: the password check is the
  // only gate, and a flood would also block a legitimate member.
  void request;

  const credentials = {
    pseudo: typeof body.pseudo === "string" ? body.pseudo.trim() : "",
    password: typeof body.password === "string" ? body.password : "",
    legacyCookieValue: readVisitorConversationCookie(request),
  };

  // Strict split: register creates the account (free pseudo only), login
  // requires the exact stored password. Nothing is created on a login.
  const result = action === "register"
    ? await registerVisitorAccount(credentials)
    : await loginVisitorAccount(credentials);

  if (!result.ok) return authenticationFailure(response, result.reason);

  saveAccountSessionCookie(request, response, result.sessionToken);
  let state = null;
  try {
    state = await getAccountConversation(result.sessionToken);
  } catch {
    state = null;
  }
  return sendPersisted(response, 200, {
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

  const result = await updateVisitorAccountProfile(sessionToken, {
    pseudo: Object.hasOwn(body, "pseudo") ? body.pseudo : undefined,
    // The current password is always required, the owner included.
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

  const activeSessionToken = result.sessionToken || sessionToken;
  if (result.sessionToken) saveAccountSessionCookie(request, response, result.sessionToken);
  const state = await getAccountConversation(activeSessionToken);
  if (!state) {
    clearAccountSessionCookie(request, response);
    return response.status(401).json({ error: "Reconnecte-toi pour modifier ton profil." });
  }
  return sendPersisted(response, 200, { ok: true, ...state, subjects: CONVERSATION_SUBJECTS });
}

// The owner account must exist before anything else: it is seeded once per
// instance, on the very first request, and lives in RAM + /tmp with the rest.
let ownerSeeded = null;
async function ensureOwnerSeeded() {
  if (!ownerSeeded) {
    ownerSeeded = ensureOwnerAccountSeeded().catch((error) => {
      ownerSeeded = null;
      console.warn("[contact] owner seed skipped", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
      return null;
    });
  }
  return ownerSeeded;
}

/**
 * Répond au navigateur puis pousse l'état vers Supabase avant de rendre la
 * main : un compte créé, un rôle changé ou un message envoyé est durable avant
 * l'accusé de réception. Si Supabase est momentanément injoignable on répond
 * quand même : la donnée reste en RAM et le prochain envoi la rattrape.
 */
function sendPersisted(response, status, payload) {
  return syncStateToSupabase()
    .catch(() => ({ saved: false, reason: "error" }))
    .then(() => response.status(status).json(payload));
}

export default async function handler(request, response) {
  setNoStore(response);
  await ensureStateLoaded().catch(() => {});

  if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
    response.setHeader("Allow", "GET, POST, DELETE");
    return response.status(405).json({ error: "Méthode non autorisée." });
  }
  if (!isSameOriginRequest(request)) return response.status(403).json({ error: "Requête refusée." });

  await ensureOwnerSeeded();

  const sessionToken = readAccountSessionCookie(request);

  if (request.method === "GET") {
    if (!sessionToken) {
      return response.status(200).json({ account: null, conversation: null, messages: [], subjects: CONVERSATION_SUBJECTS });
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
  if (action === "sync") {
    // Cold start: the browser pushes back the profile and the thread it kept
    // in localStorage, so nothing the members wrote is ever lost.
    try {
      const restored = await restoreVisitorStateFromClient({
        pseudo: typeof body.pseudo === "string" ? body.pseudo : "",
        password: typeof body.password === "string" ? body.password : "",
        messages: Array.isArray(body.messages) ? body.messages : [],
      });
      if (restored.ok) saveAccountSessionCookie(request, response, restored.sessionToken);
      const state = restored.ok ? await getAccountConversation(restored.sessionToken).catch(() => null) : null;
      return await sendPersisted(response, 200, {
        ok: restored.ok === true,
        account: state?.account || restored.account || null,
        conversation: state?.conversation || null,
        messages: state?.messages || [],
        subjects: CONVERSATION_SUBJECTS,
      });
    } catch (error) {
      console.error("[contact] client sync failed", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
      return response.status(200).json({ ok: false, account: null, conversation: null, messages: [] });
    }
  }

  if (action === "members-sync") {
    // Same idea for the admin list: a member the panel knows about is restored.
    try {
      await restoreMembersFromClient({
        pseudo: typeof body.pseudo === "string" ? body.pseudo : "",
        password: typeof body.password === "string" ? body.password : "",
      });
      return response.status(200).json({ ok: true });
    } catch {
      return response.status(200).json({ ok: false });
    }
  }

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
    if (sessionToken) {
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
    try {
      const result = await markAccountConversationRead(sessionToken);
      if (!result.ok) return response.status(401).json({ error: "Reconnecte-toi pour ouvrir ta discussion." });
      return sendPersisted(response, 200, { ok: true, changed: result.changed });
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
    try {
      const result = await setAccountConversationSubject(sessionToken, body.subject);
      if (!result.ok) {
        if (result.reason === "subject") return response.status(400).json({ error: "Choisis un sujet valide." });
        if (result.reason === "unauthorized") return response.status(401).json({ error: "Reconnecte-toi pour modifier le sujet." });
        return response.status(404).json({ error: "Cette discussion est introuvable." });
      }
      return sendPersisted(response, 200, { ok: true, account: result.account, conversation: result.conversation, messages: result.messages, subjects: CONVERSATION_SUBJECTS });
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

  try {
    const result = await addAccountReply(sessionToken, { message, subject, newConversation: body.newConversation === true });
    if (!result.ok) {
      const failure = threadError(result.reason);
      return response.status(failure.status).json({ error: failure.error });
    }
    // The very first message opens the thread: return it whole so the client
    // can paint it immediately (no empty bubble, no second round-trip).
    const firstMessage = result.message || result.messages?.[0] || null;
    return await sendPersisted(response, result.messages ? 201 : 200, {
      ok: true,
      account: result.account,
      conversation: result.conversation,
      ...(result.messages ? { messages: result.messages } : { message: firstMessage }),
    });
  } catch (error) {
    console.error("[contact] private conversation save failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
    return response.status(502).json({ error: "Ton message n’a pas pu être envoyé. Réessaie dans un instant." });
  }
}
