import { randomBytes, createHash } from "node:crypto";
import { isAdminRequest, isSameOriginRequest } from "../lib/admin-security.mjs";
import { isBlobStorageConfigured } from "../lib/blob-store.mjs";
import { PRESENCE_WINDOW_MS, recordPresence } from "../lib/presence.mjs";

const COOKIE_NAME = "qg_presence";
const SESSION_PATTERN = /^[A-Za-z0-9_-]{32}$/u;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 30;
const rateLimits = new Map();

function firstHeader(value) {
  if (Array.isArray(value)) value = value[0];
  return typeof value === "string" ? value.split(",")[0].trim() : "";
}

function getCookie(request) {
  const cookieHeader = request.headers?.cookie;
  if (typeof cookieHeader !== "string") return "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator >= 0 && part.slice(0, separator).trim() === COOKIE_NAME) return part.slice(separator + 1).trim();
  }
  return "";
}

function getClientKey(request) {
  const headers = request.headers || {};
  const address = firstHeader(headers["x-vercel-forwarded-for"]) || firstHeader(headers["x-real-ip"]) || firstHeader(headers["x-forwarded-for"]) || "unknown";
  return createHash("sha256").update(address.slice(0, 100)).digest("hex");
}

function isRateLimited(key) {
  const now = Date.now();
  let state = rateLimits.get(key);
  if (!state || state.resetAt <= now) state = { count: 0, resetAt: now + RATE_WINDOW_MS };
  state.count += 1;
  rateLimits.set(key, state);
  if (rateLimits.size > 2000) {
    for (const [storedKey, storedState] of rateLimits) if (storedState.resetAt <= now) rateLimits.delete(storedKey);
  }
  return state.count > RATE_LIMIT ? Math.max(1, Math.ceil((state.resetAt - now) / 1000)) : 0;
}

function isSecureRequest(request) {
  const proto = firstHeader(request.headers?.["x-forwarded-proto"]);
  return proto ? proto === "https" : Boolean(request.socket?.encrypted);
}

function setNoStore(response) {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Vary", "Origin, Cookie");
}

export default async function handler(request, response) {
  setNoStore(response);
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Méthode non autorisée." });
  }
  if (!isSameOriginRequest(request)) return response.status(403).json({ error: "Requête refusée." });
  if (!isBlobStorageConfigured()) return response.status(503).json({ error: "Le compteur de présence est momentanément indisponible." });
  const retryAfter = isRateLimited(getClientKey(request));
  if (retryAfter) {
    response.setHeader("Retry-After", String(retryAfter));
    return response.status(429).json({ error: "Actualisations trop fréquentes." });
  }

  const suppliedSession = getCookie(request);
  const sessionId = SESSION_PATTERN.test(suppliedSession) ? suppliedSession : randomBytes(24).toString("base64url");
  try {
    const activeSessions = await recordPresence(sessionId);
    if (sessionId !== suppliedSession) {
      const secure = isSecureRequest(request) ? "; Secure" : "";
      response.setHeader("Set-Cookie", `${COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.ceil(PRESENCE_WINDOW_MS / 1000) + 120}${secure}`);
    }
    const privileged = await isAdminRequest(request);
    return response.status(200).json({ activeSessions: privileged || activeSessions >= 3 ? activeSessions : null });
  } catch (error) {
    console.error("[presence] heartbeat failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
    return response.status(502).json({ error: "Le compteur de présence n’a pas pu être actualisé." });
  }
}
