import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getHostAccountIdentityFromSession, readAccountSessionCookie } from "./contact-inbox.mjs";

const COOKIE_NAME = "gionny_admin_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

export function getAdminCredentials() {
  const pin = (process.env.GIONNY_ADMIN_PIN || "").trim().toUpperCase();
  const sessionSecret = process.env.GIONNY_ADMIN_SESSION_SECRET || "";
  return {
    pin,
    sessionSecret,
    configured: /^[A-Z0-9]{4}$/u.test(pin) && sessionSecret.length >= 32,
  };
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function signature(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function createSessionToken(secret) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      issuedAt,
      expiresAt: issuedAt + SESSION_TTL_SECONDS,
      nonce: randomBytes(16).toString("base64url"),
    })
  ).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

function readCookie(request, name) {
  const cookieHeader = request.headers?.cookie;
  if (typeof cookieHeader !== "string") return "";

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

function isValidSession(token, secret) {
  if (!token || token.length > 1024) return false;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return false;

  const payload = token.slice(0, separator);
  const receivedSignature = token.slice(separator + 1);
  const expectedSignature = signature(payload, secret);
  if (!safeEqual(receivedSignature, expectedSignature)) return false;

  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    return (
      Number.isInteger(claims.issuedAt) &&
      Number.isInteger(claims.expiresAt) &&
      typeof claims.nonce === "string" &&
      claims.nonce.length >= 16 &&
      claims.issuedAt <= now + 60 &&
      claims.expiresAt > now &&
      claims.expiresAt - claims.issuedAt === SESSION_TTL_SECONDS
    );
  } catch {
    return false;
  }
}

export async function isAdminRequest(request, store) {
  const { sessionSecret, configured } = getAdminCredentials();
  if (configured && isValidSession(readCookie(request, COOKIE_NAME), sessionSecret)) return true;

  // Hôte authorization is resolved against the signed account session and the
  // server-side Blob assignment. A role sent in JSON or rendered in the browser
  // is never sufficient to grant administrative access.
  const accountSession = readAccountSessionCookie(request);
  if (!accountSession) return false;
  try {
    return Boolean(await getHostAccountIdentityFromSession(accountSession, store));
  } catch {
    return false;
  }
}

function isSecureRequest(request) {
  const forwardedProtocol = request.headers?.["x-forwarded-proto"];
  const protocol = typeof forwardedProtocol === "string" ? forwardedProtocol.split(",")[0].trim() : "";
  if (protocol) return protocol === "https";
  return Boolean(request.socket?.encrypted);
}

export function setAdminSessionCookie(request, response) {
  const { sessionSecret } = getAdminCredentials();
  const token = createSessionToken(sessionSecret);
  const secure = isSecureRequest(request) ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}${secure}`
  );
}

export function clearAdminSessionCookie(request, response) {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  response.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
  );
}

export function isSameOriginRequest(request) {
  const headers = request.headers || {};
  const origin = headers.origin;
  const host = headers.host;
  if (typeof host !== "string" || !host) return false;

  if (typeof origin === "string" && origin) {
    try {
      const parsedOrigin = new URL(origin);
      return (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:") && parsedOrigin.host === host;
    } catch {
      return false;
    }
  }

  // Some same-origin fetches omit Origin. Fetch Metadata is browser-controlled and
  // lets us still reject cross-site form and script requests in that case.
  if (typeof headers["sec-fetch-site"] === "string") {
    return headers["sec-fetch-site"] === "same-origin";
  }

  const referer = headers.referer || headers.referrer;
  if (typeof referer !== "string") return false;
  try {
    return new URL(referer).host === host;
  } catch {
    return false;
  }
}

export function safePasswordMatch(providedPassword) {
  const { pin, configured } = getAdminCredentials();
  if (!configured || typeof providedPassword !== "string") return false;
  return safeEqual(providedPassword.trim().toUpperCase(), pin);
}
