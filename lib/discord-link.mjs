import { randomBytes, createHmac } from "node:crypto";
import { isSameOriginRequest } from "./admin-security.mjs";
import {
  getAccountRecordFromSession,
  linkDiscordAccount,
  normalizeDiscordId,
  normalizeDiscordUsername,
  readAccountSessionCookie,
  unlinkDiscordAccount,
} from "./contact-inbox.mjs";
import { ensureStateLoaded, syncStateToSupabase } from "./blob-store.mjs";
import {
  getProfileRecord,
  linkProfileDiscord,
  listBlockedUsers,
  setProfilePrivacy,
  unlinkProfileDiscord,
} from "./social-graph.mjs";

// ---------------------------------------------------------------------------
// ÉTAPE 4 · Paramètres du compte, confidentialité et liaison Discord
// ---------------------------------------------------------------------------
// Les routes publiques sont exposées par des rewrites Vercel (une seule
// fonction serverless, la limite Hobby est de 12) :
// GET    /api/settings                    → réglages du compte connecté
// POST   /api/settings {action:…}         → privacy | discord-link |
//                                           discord-unlink | password | blocks
//
// Routes OAuth2 Discord (mêmes clés que le reste du site) :
// GET    /api/auth/discord                → redirige vers Discord (identify)
// GET    /api/auth/discord/callback       → échange le code, lie le compte
//
// Deux modes de liaison, pour que la fonctionnalité marche AVANT que les clés
// OAuth ne soient renseignées :
//   • « oauth » : le vrai aller-retour Discord (identify → /users/@me) ;
//   • « code »  : le membre colle son ID Discord, vérifié contre l'API publique
//                 de Discord quand le serveur peut la joindre (sinon accepté
//                 comme déclaratif), avec unicité et contrôle des bannis.
// Dans les deux cas, seuls `discordId`, `discordUsername` et `discordLinkedAt`
// sont conservés : jamais la photo, jamais l'e-mail, jamais le token.

const MAX_BODY_BYTES = 8 * 1024;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 20;
const rateLimits = new Map();
const STATE_COOKIE = "gionny_discord_state";
const STATE_TTL_MS = 10 * 60 * 1000;

export const config = { api: { bodyParser: false } };

function setNoStore(response) {
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Vary", "Origin, Cookie");
}

function sendJson(response, status, data) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  return response.status(status).json(data);
}

function readJsonBody(request, limit = MAX_BODY_BYTES) {
  const raw = Buffer.isBuffer(request.body)
    ? request.body.toString("utf8")
    : typeof request.body === "string"
      ? request.body
      : request.body && typeof request.body === "object"
        ? JSON.stringify(request.body)
        : "";
  if (!raw || Buffer.byteLength(raw, "utf8") > limit) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
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

function clientKey(request) {
  const headers = request.headers || {};
  return (
    firstHeader(headers["x-vercel-forwarded-for"]) ||
    firstHeader(headers["x-real-ip"]) ||
    firstHeader(headers["x-forwarded-for"]) ||
    "unknown"
  ).slice(0, 100);
}

function rateLimited(key, limit = RATE_LIMIT, windowMs = RATE_WINDOW_MS) {
  const now = Date.now();
  let state = rateLimits.get(key);
  if (!state || state.resetAt <= now) state = { count: 0, resetAt: now + windowMs };
  state.count += 1;
  rateLimits.set(key, state);
  if (rateLimits.size > 2000) {
    for (const [storedKey, stored] of rateLimits) if (stored.resetAt <= now) rateLimits.delete(storedKey);
  }
  return state.count > limit;
}

// ---------------------------------------------------------------------------
// Configuration Discord
// ---------------------------------------------------------------------------

function discordConfig() {
  const clientId = (process.env.DISCORD_CLIENT_ID || "").trim();
  const clientSecret = (process.env.DISCORD_CLIENT_SECRET || "").trim();
  const secret = (process.env.GIONNY_ADMIN_SESSION_SECRET || "qg2gionny-discord-state").trim();
  return {
    clientId,
    clientSecret,
    secret,
    configured: /^\d{15,25}$/u.test(clientId) && clientSecret.length >= 10,
  };
}

/** Origine publique de la requête (derrière le proxy Vercel). */
function requestOrigin(request) {
  const host = firstHeader(request.headers?.["x-forwarded-host"]) || firstHeader(request.headers?.host) || "qg2gionny.vercel.app";
  const proto = firstHeader(request.headers?.["x-forwarded-proto"]) || "https";
  return `${proto === "http" ? "http" : "https"}://${host}`;
}

function redirectUri(request) {
  return (process.env.DISCORD_REDIRECT_URI || "").trim() || `${requestOrigin(request)}/api/auth/discord/callback`;
}

/** State OAuth signé (aucun stockage serveur nécessaire). */
function signState(payload, secret) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function createOauthState(secret) {
  const payload = Buffer.from(
    JSON.stringify({ issuedAt: Date.now(), nonce: randomBytes(12).toString("base64url") })
  ).toString("base64url");
  return `${payload}.${signState(payload, secret)}`;
}

function readOauthState(value, secret) {
  if (typeof value !== "string" || value.length > 512) return null;
  const separator = value.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = signState(payload, secret);
  if (signature.length !== expected.length) return null;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  if (mismatch !== 0) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!Number.isFinite(parsed?.issuedAt) || Date.now() - parsed.issuedAt > STATE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readCookie(request, name) {
  const header = request.headers?.cookie;
  if (typeof header !== "string") return "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

function stateCookie(value, maxAgeSeconds = 600) {
  return `${STATE_COOKIE}=${value}; Path=/api/auth/discord; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

// ---------------------------------------------------------------------------
// Discord API (identify) — jamais de token conservé côté serveur
// ---------------------------------------------------------------------------

async function exchangeDiscordCode({ code, config: discord, request }) {
  const body = new URLSearchParams({
    client_id: discord.clientId,
    client_secret: discord.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(request),
  });
  const tokenResponse = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  if (!tokenResponse.ok) return null;
  const token = await tokenResponse.json().catch(() => null);
  if (!token?.access_token) return null;
  const meResponse = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
  });
  if (!meResponse.ok) return null;
  const me = await meResponse.json().catch(() => null);
  const discordId = normalizeDiscordId(me?.id);
  const discordUsername = normalizeDiscordUsername(me?.username);
  if (!discordId || !discordUsername) return null;
  return { discordId, discordUsername };
}

/**
 * Vérifie un ID Discord saisi à la main contre l'API publique de Discord.
 * Si le serveur ne peut pas joindre Discord (réseau, rate limit), on renvoie
 * `null` : la liaison reste possible en mode déclaratif, l'unicité et le
 * contrôle des bannis étant assurés de notre côté.
 */
async function inspectDiscordUser(discordId) {
  try {
    const response = await fetch(`https://discord.com/api/v10/users/${encodeURIComponent(discordId)}`, {
      headers: { Accept: "application/json", "User-Agent": "QG2GIONNY (https://qg2gionny.vercel.app)" },
      signal: AbortSignal.timeout(3500),
    });
    if (response.status === 404) return { found: false, reachable: true };
    if (!response.ok) return null;
    const body = await response.json().catch(() => null);
    const username = normalizeDiscordUsername(body?.username);
    if (!username) return null;
    return { found: true, reachable: true, discordUsername: username };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Réponses
// ---------------------------------------------------------------------------

function settingsError(reason) {
  switch (reason) {
    case "unauthorized":
      return { status: 401, error: "Connecte-toi pour modifier tes paramètres." };
    case "discord_id":
      return { status: 400, error: "L’identifiant Discord doit être un nombre de 17 à 20 chiffres." };
    case "discord_username":
      return { status: 400, error: "Ce pseudo Discord n’est pas valide." };
    case "discord_taken":
      return { status: 409, error: "Ce Discord est déjà lié à un autre compte du QG." };
    case "discord_username_taken":
      return { status: 409, error: "Ce pseudo Discord est déjà utilisé par un autre membre." };
    case "discord_banned":
      return { status: 403, error: "Ce compte Discord a été banni du QG." };
    case "banned":
      return { status: 403, error: "Ton compte est suspendu : contacte Gionny." };
    case "host_public":
      return { status: 409, error: "Le compte de Gionny reste public pour tout le QG." };
    case "invalid":
      return { status: 400, error: "Cette demande n’est pas valide." };
    default:
      return { status: 400, error: "Cette action n’a pas pu être enregistrée." };
  }
}

async function withState(request, extra = {}) {
  const sessionToken = readAccountSessionCookie(request);
  const resolved = sessionToken ? await getAccountRecordFromSession(sessionToken) : null;
  const account = resolved?.account || null;
  const profile = account?.pseudo ? await getProfileRecord(account.pseudo).catch(() => null) : null;
  const discord = discordConfig();
  return {
    ok: true,
    mode: discord.configured ? "oauth" : "code",
    oauth: discord.configured,
    ...(discord.configured ? { authorizeUrl: "/api/auth/discord" } : {}),
    viewer: account ? account.pseudo : null,
    ...extra,
    settings: {
      isPrivate: profile?.isPrivate === true,
      hideUnverifiedContent: true,
      discord: {
        linked: Boolean(account?.discordId),
        discordId: account?.discordId || "",
        discordUsername: account?.discordUsername || "",
        discordLinkedAt: account?.discordLinkedAt || "",
      },
      blockedUsers: profile?.blockedUsers || [],
    },
  };
}

async function persist(extra) {
  await ensureStateLoaded().catch(() => {});
  await syncStateToSupabase().catch(() => {});
  return extra;
}

async function handleCallback(request, response) {
  const discord = discordConfig();
  const code = queryValue(request, "code");
  const state = queryValue(request, "state");
  const origin = requestOrigin(request);
  const target = new URL("/", origin);

  if (!discord.configured) {
    target.searchParams.set("discord", "unconfigured");
    response.setHeader("Location", target.href);
    return response.status(302).end();
  }
  const cookieState = readCookie(request, STATE_COOKIE);
  if (!code || !readOauthState(state, discord.secret) || (cookieState && cookieState !== state)) {
    target.searchParams.set("discord", "invalid_state");
    response.setHeader("Location", target.href);
    return response.status(302).end();
  }
  const sessionToken = readAccountSessionCookie(request);
  if (!sessionToken) {
    target.searchParams.set("discord", "login");
    response.setHeader("Location", target.href);
    return response.status(302).end();
  }
  const identity = await exchangeDiscordCode({ code, config: discord, request }).catch(() => null);
  if (!identity) {
    target.searchParams.set("discord", "failed");
    response.setHeader("Location", target.href);
    return response.status(302).end();
  }
  const result = await linkDiscordAccount(sessionToken, identity).catch(() => null);
  if (!result?.ok) {
    target.searchParams.set("discord", result?.reason === "discord_taken" ? "taken" : "refused");
    response.setHeader("Location", target.href);
    return response.status(302).end();
  }
  await linkProfileDiscord({
    pseudo: result.account.pseudo,
    discordId: identity.discordId,
    discordUsername: identity.discordUsername,
  }).catch(() => {});
  await persist({});
  target.searchParams.set("discord", "linked");
  target.searchParams.set("discord_username", identity.discordUsername);
  response.setHeader("Location", target.href);
  response.setHeader("Set-Cookie", stateCookie("", 0));
  return response.status(302).end();
}

/**
 * Entonnoir unique des routes Étape 4. Vercel réécrit
 *   /api/settings                → /api/profile?qg=settings
 *   /api/auth/discord            → /api/profile?qg=discord&oauth=start
 *   /api/auth/discord/callback   → /api/profile?qg=discord&callback=1
 */
export async function handleSettingsRequest(request, response) {
  setNoStore(response);
  await ensureStateLoaded().catch(() => {});

  // --- OAuth2 Discord : démarrage -----------------------------------------
  if (queryValue(request, "oauth") === "start") {
    const discord = discordConfig();
    const origin = requestOrigin(request);
    if (!discord.configured) {
      // Pas de clés OAuth : on revient à l'accueil, le mode « ID + pseudo »
      // prend le relais (la page Paramètres affiche le bon formulaire).
      response.setHeader("Location", `${origin}/?discord=unconfigured`);
      return response.status(302).end();
    }
    const state = createOauthState(discord.secret);
    const authorize = new URL("https://discord.com/api/oauth2/authorize");
    authorize.searchParams.set("client_id", discord.clientId);
    authorize.searchParams.set("redirect_uri", redirectUri(request));
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "identify");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("prompt", "consent");
    response.setHeader("Set-Cookie", stateCookie(state));
    response.setHeader("Location", authorize.href);
    return response.status(302).end();
  }

  // --- Fin du parcours OAuth2 ----------------------------------------------
  if (queryValue(request, "callback") === "1") {
    return handleCallback(request, response);
  }

  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return sendJson(response, 405, { error: "Méthode non autorisée." });
  }
  if (!isSameOriginRequest(request)) return sendJson(response, 403, { error: "Requête refusée." });

  if (request.method === "GET") {
    return sendJson(response, 200, await withState(request));
  }

  const body = readJsonBody(request);
  if (!body) return sendJson(response, 400, { error: "La demande est incomplète." });
  const action = typeof body.action === "string" ? body.action : "";
  const sessionToken = readAccountSessionCookie(request);
  if (!sessionToken) return sendJson(response, 401, { error: "Connecte-toi pour modifier tes paramètres." });
  const resolved = await getAccountRecordFromSession(sessionToken);
  if (!resolved) return sendJson(response, 401, { error: "Reconnecte-toi pour modifier tes paramètres." });
  const pseudo = resolved.account.pseudo;

  try {
    if (action === "privacy") {
      const result = await setProfilePrivacy({ pseudo, isPrivate: body.isPrivate === true });
      if (!result.ok) {
        const failure = settingsError(result.reason);
        return sendJson(response, failure.status, { error: failure.error });
      }
      await persist({});
      return sendJson(response, 200, { ok: true, isPrivate: result.isPrivate });
    }

    if (action === "discord-link") {
      if (rateLimited(`discord:${clientKey(request)}`, 10)) {
        return sendJson(response, 429, { error: "Beaucoup de tentatives : réessaie dans quelques minutes." });
      }
      const discordId = normalizeDiscordId(body.discordId || body.code);
      if (!discordId) {
        const failure = settingsError("discord_id");
        return sendJson(response, failure.status, { error: failure.error });
      }
      const declared = normalizeDiscordUsername(body.discordUsername);
      // Vérification optionnelle auprès de Discord (mode « code »).
      const inspected = await inspectDiscordUser(discordId);
      if (inspected && inspected.found === false) {
        return sendJson(response, 404, { error: "Cet identifiant Discord n’existe pas." });
      }
      const discordUsername = inspected?.discordUsername || declared;
      if (!discordUsername) {
        const failure = settingsError("discord_username");
        return sendJson(response, failure.status, { error: "Indique aussi ton pseudo Discord (ex. @gionny)." });
      }
      const result = await linkDiscordAccount(sessionToken, { discordId, discordUsername });
      if (!result.ok) {
        const failure = settingsError(result.reason);
        return sendJson(response, failure.status, { error: failure.error, reason: result.reason });
      }
      await linkProfileDiscord({ pseudo, discordId, discordUsername }).catch(() => {});
      await persist({});
      return sendJson(response, 200, {
        ok: true,
        verified: Boolean(inspected?.found),
        discord: result.discord,
      });
    }

    if (action === "discord-unlink") {
      await unlinkDiscordAccount(sessionToken);
      await unlinkProfileDiscord({ pseudo }).catch(() => {});
      await persist({});
      return sendJson(response, 200, { ok: true, linked: false });
    }

    if (action === "blocks") {
      return sendJson(response, 200, { ok: true, blockedUsers: await listBlockedUsers({ pseudo }) });
    }

    return sendJson(response, 400, { error: "Cette action n’est pas reconnue." });
  } catch (error) {
    console.error("[settings] action failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
    return sendJson(response, 502, { error: "Les paramètres n’ont pas pu être enregistrés. Réessaie." });
  }
}
