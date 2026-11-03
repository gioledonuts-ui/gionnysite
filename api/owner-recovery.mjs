import { isAdminRequest, isSameOriginRequest } from "../lib/admin-security.mjs";
import { isBlobStorageConfigured } from "../lib/blob-store.mjs";
import {
  isOwnerRecoveryAvailable,
  issueOwnerRecoveryCode,
  loginHostAccount,
  recoverOwnerAccount,
  saveAccountSessionCookie,
} from "../lib/contact-inbox.mjs";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const attempts = new Map();

function setNoStore(response) {
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Vary", "Cookie");
}

function clientKey(request) {
  const headers = request.headers || {};
  const forwarded = headers["x-vercel-forwarded-for"] || headers["x-forwarded-for"];
  const address =
    (typeof headers["x-real-ip"] === "string" && headers["x-real-ip"].trim()) ||
    (typeof forwarded === "string" && forwarded.split(",")[0].trim()) ||
    "unknown";
  return address.slice(0, 100);
}

function currentAttempts(key) {
  const now = Date.now();
  const state = attempts.get(key);
  if (!state || state.resetAt <= now) return { count: 0, resetAt: now + WINDOW_MS };
  return state;
}

function readJsonBody(request) {
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) return request.body;
  const raw = Buffer.isBuffer(request.body)
    ? request.body.toString("utf8")
    : typeof request.body === "string"
      ? request.body
      : "";
  if (!raw || Buffer.byteLength(raw, "utf8") > 4096) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Owner-only recovery endpoint.
 *
 *   POST { action: "recover", pseudo, password, recoveryCode }
 *        Sets a new owner password, but only with the long random recovery code
 *        stored server-side (Blob) and handed to the owner once.
 *
 *   POST { action: "issue-code", password }
 *        First-time setup: after a successful password login (or when the owner
 *        account was just provisioned), returns the recovery code once.
 *        Requires an authenticated admin session or the owner password.
 */
export default async function handler(request, response) {
  setNoStore(response);
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Méthode non autorisée." });
  }
  if (!isSameOriginRequest(request)) return response.status(403).json({ error: "Requête refusée." });
  if (!isBlobStorageConfigured()) {
    return response.status(503).json({ error: "La récupération nécessite le stockage privé, temporairement indisponible." });
  }

  const key = clientKey(request);
  const state = currentAttempts(key);
  if (state.count >= MAX_ATTEMPTS) {
    response.setHeader("Retry-After", String(Math.max(1, Math.ceil((state.resetAt - Date.now()) / 1000))));
    return response.status(429).json({ error: "Trop de tentatives. Réessaie dans quelques minutes." });
  }

  const body = readJsonBody(request);
  if (!body) return response.status(400).json({ error: "La demande est incomplète." });
  const action = typeof body.action === "string" ? body.action : "";

  if (!isOwnerRecoveryAvailable()) {
    return response.status(503).json({ error: "La récupération du compte n’est pas configurée sur ce déploiement." });
  }

  if (action === "issue-code") {
    const adminSession = await isAdminRequest(request).catch(() => false);
    const password = typeof body.password === "string" ? body.password : "";
    const passwordLogin = password
      ? await loginHostAccount({ password }).catch(() => ({ ok: false }))
      : { ok: false };
    if (!adminSession && !passwordLogin.ok) {
      state.count += 1;
      attempts.set(key, state);
      return response.status(401).json({ error: "Mot de passe du propriétaire incorrect." });
    }
    const code = await issueOwnerRecoveryCode();
    return response.status(200).json({
      ok: true,
      recoveryCode: code,
      notice: "Note ce code en lieu sûr : il est le seul moyen de réinitialiser le mot de passe du compte Gionny.",
    });
  }

  if (action === "recover") {
    const result = await recoverOwnerAccount({
      pseudo: typeof body.pseudo === "string" ? body.pseudo : "",
      password: typeof body.password === "string" ? body.password : "",
      recoveryCode: typeof body.recoveryCode === "string" ? body.recoveryCode : "",
    }).catch(() => null);

    if (!result?.ok) {
      if (result?.reason === "not_owner") {
        return response.status(400).json({ error: "Cette récupération ne concerne que le compte propriétaire." });
      }
      if (result?.reason === "password") {
        return response.status(400).json({ error: "Le nouveau mot de passe doit contenir entre 8 et 128 caractères." });
      }
      state.count += 1;
      attempts.set(key, state);
      return response.status(401).json({ error: "Code de récupération incorrect." });
    }

    attempts.delete(key);
    saveAccountSessionCookie(request, response, result.sessionToken);
    return response.status(200).json({
      ok: true,
      account: result.account,
      notice: "Mot de passe du compte Gionny mis à jour. Tu es connecté.",
    });
  }

  return response.status(400).json({ error: "Action inconnue." });
}
