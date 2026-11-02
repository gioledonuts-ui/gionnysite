import {
  clearAdminSessionCookie,
  getAdminCredentials,
  isAdminRequest,
  isSameOriginRequest,
  safePasswordMatch,
  setAdminSessionCookie,
} from "../lib/admin-security.mjs";
import { getHostAccountIdentityFromSession, readAccountSessionCookie } from "../lib/contact-inbox.mjs";

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const failedAttempts = new Map();

function setNoStore(response) {
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Vary", "Cookie");
}

function clientKey(request) {
  const headers = request.headers || {};
  const realIp = headers["x-real-ip"];
  const forwarded = headers["x-vercel-forwarded-for"] || headers["x-forwarded-for"];
  const candidate =
    (typeof realIp === "string" && realIp.trim()) ||
    (typeof forwarded === "string" && forwarded.split(",")[0].trim()) ||
    "unknown";
  return candidate.slice(0, 100);
}

function currentAttemptState(key) {
  const now = Date.now();
  const state = failedAttempts.get(key);
  if (!state || state.windowEndsAt <= now) {
    failedAttempts.delete(key);
    return { attempts: 0, windowEndsAt: now + ATTEMPT_WINDOW_MS, lockedUntil: 0 };
  }
  return state;
}

function recordFailedAttempt(key) {
  const state = currentAttemptState(key);
  state.attempts += 1;
  if (state.attempts >= MAX_ATTEMPTS) state.lockedUntil = state.windowEndsAt;
  failedAttempts.set(key, state);

  if (failedAttempts.size > 1000) {
    const now = Date.now();
    for (const [storedKey, storedState] of failedAttempts) {
      if (storedState.windowEndsAt <= now) failedAttempts.delete(storedKey);
    }
  }
  return state;
}

function readJsonBody(request) {
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
    return request.body;
  }
  const body = Buffer.isBuffer(request.body)
    ? request.body.toString("utf8")
    : typeof request.body === "string"
      ? request.body
      : "";
  if (!body || Buffer.byteLength(body, "utf8") > 4096) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function methodNotAllowed(response) {
  response.setHeader("Allow", "GET, POST, DELETE");
  return response.status(405).json({ error: "Méthode non autorisée." });
}

export default async function handler(request, response) {
  setNoStore(response);

  if (request.method === "GET") {
    let hostAuthenticated = false;
    try {
      hostAuthenticated = Boolean(await getHostAccountIdentityFromSession(readAccountSessionCookie(request)));
    } catch {
      hostAuthenticated = false;
    }
    const authenticated = hostAuthenticated || await isAdminRequest(request);
    return response.status(200).json({ authenticated, hostAuthenticated });
  }

  if (request.method === "DELETE") {
    if (!isSameOriginRequest(request)) {
      return response.status(403).json({ error: "Requête refusée." });
    }
    let hostAuthenticated = false;
    try {
      hostAuthenticated = Boolean(await getHostAccountIdentityFromSession(readAccountSessionCookie(request)));
    } catch {
      hostAuthenticated = false;
    }
    clearAdminSessionCookie(request, response);
    return response.status(200).json({ authenticated: hostAuthenticated, hostAuthenticated });
  }

  if (request.method !== "POST") return methodNotAllowed(response);
  if (!isSameOriginRequest(request)) {
    return response.status(403).json({ error: "Requête refusée." });
  }

  if (!getAdminCredentials().configured) {
    return response.status(503).json({ error: "La connexion au panneau n’est pas encore configurée." });
  }

  const key = clientKey(request);
  const state = currentAttemptState(key);
  if (state.lockedUntil > Date.now()) {
    const retryAfter = Math.max(1, Math.ceil((state.lockedUntil - Date.now()) / 1000));
    response.setHeader("Retry-After", String(retryAfter));
    return response.status(429).json({ error: "Trop de tentatives. Réessaie dans quelques minutes." });
  }

  const body = readJsonBody(request);
  if (!body || typeof body.password !== "string" || body.password.length > 100) {
    return response.status(400).json({ error: "Saisis le code d’accès." });
  }

  if (!safePasswordMatch(body.password)) {
    const updated = recordFailedAttempt(key);
    if (updated.lockedUntil > Date.now()) {
      response.setHeader("Retry-After", String(Math.ceil((updated.lockedUntil - Date.now()) / 1000)));
      return response.status(429).json({ error: "Trop de tentatives. Réessaie dans quelques minutes." });
    }
    return response.status(401).json({ error: "Code d’accès incorrect." });
  }

  failedAttempts.delete(key);
  setAdminSessionCookie(request, response);
  return response.status(200).json({ authenticated: true });
}
