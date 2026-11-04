import { isSameOriginRequest } from "../lib/admin-security.mjs";
import {
  clearAccountSessionCookie,
  getVisitorAccountFromSession,
  listVisitorAccounts,
  readAccountSessionCookie,
} from "../lib/contact-inbox.mjs";
import { ensureStateLoaded, syncStateToSupabase } from "../lib/blob-store.mjs";
import {
  REPORT_REASONS,
  createPost,
  createReport,
  deletePost,
  ensureHostFollowFor,
  getProfileRecord,
  getPublicProfile,
  listFeed,
  setBlock,
  setFollow,
  toggleLike,
  updateProfileDetails,
} from "../lib/social-graph.mjs";

// ---------------------------------------------------------------------------
// API publique des profils du QG
// ---------------------------------------------------------------------------
// GET  /api/profile?pseudo=…        → profil public + compteurs + relations
// GET  /api/profile?directory=1     → annuaire léger (pseudo, rôle, badge, photo)
// POST /api/profile {action:…}      → follow | unfollow | block | unblock |
//                                     report | details
//
// Aucune donnée privée ne sort d'ici : ni conversation, ni mot de passe, ni
// adresse. Seuls le pseudo, la bio, le pseudo Discord, le rôle, le badge et la
// photo (déjà publique dans le fil) sont renvoyés.

const MAX_BODY_BYTES = 4000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_REPORTS_PER_WINDOW = 10;
const MAX_DIRECTORY = 120;
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
      return Buffer.byteLength(JSON.stringify(request.body), "utf8") <= MAX_BODY_BYTES ? request.body : null;
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
  const raw = headers["x-vercel-forwarded-for"] || headers["x-real-ip"] || headers["x-forwarded-for"] || "unknown";
  return String(Array.isArray(raw) ? raw[0] : raw).split(",")[0].trim().slice(0, 100);
}

function rateLimited(key) {
  const now = Date.now();
  let state = rateLimits.get(key);
  if (!state || state.resetAt <= now) state = { count: 0, resetAt: now + RATE_WINDOW_MS };
  state.count += 1;
  rateLimits.set(key, state);
  if (rateLimits.size > 2000) {
    for (const [storedKey, stored] of rateLimits) if (stored.resetAt <= now) rateLimits.delete(storedKey);
  }
  return state.count > MAX_REPORTS_PER_WINDOW;
}

function isVerified(account) {
  return Array.isArray(account?.badges) && account.badges.includes("verified");
}

function publicIdentity(account, isHost) {
  return {
    pseudo: account.pseudo,
    role: isHost || account.role === "host" ? "host" : "member",
    badges: Array.isArray(account.badges) ? account.badges.filter((badge) => badge === "verified") : [],
    ...(typeof account.avatarData === "string" && account.avatarData ? { avatarData: account.avatarData } : {}),
  };
}

/** Retrouve l'identité d'un compte dans l'annuaire (pseudo, rôle, badge). */
function findIdentity(accounts, pseudo) {
  const wanted = String(pseudo || "").replace(/^@+/u, "").trim().toLowerCase();
  if (!wanted) return null;
  const alias = ["gionny", "7gionny"].includes(wanted) ? ["gionny", "7gionny"] : [wanted];
  return accounts.find((account) => alias.includes(account.pseudo.trim().toLowerCase())) || null;
}

async function readDirectory() {
  const page = await listVisitorAccounts("").catch(() => ({ members: [] }));
  const members = (Array.isArray(page.members) ? page.members : [])
    .filter((member) => member.status !== "banned")
    .slice(0, MAX_DIRECTORY)
    .map((member) => publicIdentity(member, member.role === "host"));
  return members;
}

async function withDetails(pseudo, member, viewer) {
  const result = await getPublicProfile(pseudo, { viewer });
  if (!result.ok) return null;
  const details = await getProfileRecord(result.profile.pseudo).catch(() => null);
  const identity = member || { pseudo: result.profile.pseudo, role: result.profile.isHost ? "host" : "member", badges: [] };
  return {
    ...result.profile,
    ...publicIdentity(identity, result.profile.isHost),
    pseudo: result.profile.pseudo,
    bio: details?.bio || "",
    discordUsername: details?.discordUsername || "",
    reasons: REPORT_REASONS,
  };
}

export default async function handler(request, response) {
  setNoStore(response);
  await ensureStateLoaded().catch(() => {});

  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ error: "Méthode non autorisée." });
  }
  if (!isSameOriginRequest(request)) return response.status(403).json({ error: "Requête refusée." });

  const sessionToken = readAccountSessionCookie(request);
  const viewer = sessionToken
    ? await getVisitorAccountFromSession(sessionToken).catch(() => null)
    : null;

  if (request.method === "GET") {
    const directory = queryValue(request, "directory");
    if (directory) return response.status(200).json({ members: await readDirectory() });

    const mode = queryValue(request, "mode") === "verified" ? "verified" : "all";
    const author = queryValue(request, "author");
    if (queryValue(request, "feed") || author) {
      try {
        const posts = await listFeed({ viewer: viewer?.pseudo || "", mode, author }, undefined);
        return response.status(200).json({ posts, viewer: viewer ? viewer.pseudo : null });
      } catch (error) {
        console.error("[profile] feed read failed", {
          name: error instanceof Error ? error.name : "UnknownError",
        });
        return response.status(502).json({ error: "Le fil ne peut pas être chargé pour le moment." });
      }
    }

    const pseudo = queryValue(request, "pseudo");
    if (!pseudo) return response.status(400).json({ error: "Choisis un profil à ouvrir." });
    try {
      const accounts = await readDirectory();
      const member = findIdentity(accounts, pseudo);
      const profile = await withDetails(pseudo, member, viewer?.pseudo || "");
      if (!profile) return response.status(404).json({ error: "Ce profil est introuvable." });
      return response.status(200).json({ profile, viewer: viewer ? viewer.pseudo : null, reasons: REPORT_REASONS });
    } catch (error) {
      console.error("[profile] public profile read failed", {
        name: error instanceof Error ? error.name : "UnknownError",
      });
      return response.status(502).json({ error: "Ce profil ne peut pas être affiché pour le moment." });
    }
  }

  const body = readJsonBody(request);
  if (!body || typeof body !== "object") return response.status(400).json({ error: "La demande est incomplète." });
  const action = typeof body.action === "string" ? body.action : "";
  const target = typeof body.target === "string" ? body.target : "";

  if (!viewer) {
    return response.status(401).json({ error: "Connecte-toi pour faire ça dans le QG." });
  }

  try {
    if (action === "follow" || action === "unfollow") {
      const result = await setFollow({ pseudo: viewer.pseudo, target, follow: action === "follow" });
      if (!result.ok) {
        if (result.reason === "not_found") return response.status(404).json({ error: "Ce membre n’existe plus." });
        if (result.reason === "blocked") return response.status(403).json({ error: "Ce membre t’a bloqué." });
        if (result.reason === "self") return response.status(400).json({ error: "Tu ne peux pas te suivre toi-même." });
        return response.status(400).json({ error: "Cet abonnement n’a pas pu être enregistré." });
      }
      const profile = await withDetails(target, findIdentity(await readDirectory(), target), viewer.pseudo);
      await syncStateToSupabase().catch(() => {});
      return response.status(200).json({ ok: true, following: result.following !== false, profile });
    }

    if (action === "block" || action === "unblock") {
      const result = await setBlock({ pseudo: viewer.pseudo, target, blocked: action === "block" });
      if (!result.ok) {
        if (result.reason === "host") return response.status(403).json({ error: "L’Hôte du QG ne peut pas être bloqué." });
        if (result.reason === "self") return response.status(400).json({ error: "Tu ne peux pas te bloquer toi-même." });
        return response.status(400).json({ error: "Ce blocage n’a pas pu être enregistré." });
      }
      await syncStateToSupabase().catch(() => {});
      return response.status(200).json({ ok: true, blocked: action === "block" });
    }

    if (action === "report") {
      if (rateLimited(`report:${clientKey(request)}`)) {
        return response.status(429).json({ error: "Trop de signalements récents. Réessaie plus tard." });
      }
      const result = await createReport({
        reporterPseudo: viewer.pseudo,
        targetPseudo: target,
        targetMessageId: typeof body.messageId === "string" ? body.messageId : "",
        reason: body.reason,
        details: body.details,
      });
      if (!result.ok) {
        if (result.reason === "reason") return response.status(400).json({ error: "Choisis un motif de signalement." });
        if (result.reason === "self") return response.status(400).json({ error: "Tu ne peux pas te signaler toi-même." });
        return response.status(400).json({ error: "Le signalement n’a pas pu être envoyé." });
      }
      await syncStateToSupabase().catch(() => {});
      return response.status(201).json({ ok: true, report: result.report });
    }

    if (action === "details") {
      const result = await updateProfileDetails({
        pseudo: viewer.pseudo,
        bio: Object.hasOwn(body, "bio") ? body.bio : undefined,
        discordUsername: Object.hasOwn(body, "discordUsername") ? body.discordUsername : undefined,
      });
      if (!result.ok) {
        if (result.reason === "discord") {
          return response.status(400).json({ error: "Le pseudo Discord doit contenir 2 à 40 lettres, chiffres, points, tirets ou underscores." });
        }
        return response.status(400).json({ error: "La bio n’a pas pu être enregistrée." });
      }
      await syncStateToSupabase().catch(() => {});
      return response.status(200).json({ ok: true, profile: result.profile });
    }

    if (action === "post") {
      if (rateLimited(`post:${clientKey(request)}`)) {
        return response.status(429).json({ error: "Doucement : tu publies trop vite. Réessaie dans quelques minutes." });
      }
      const result = await createPost({ pseudo: viewer.pseudo, text: body.text }, undefined);
      if (!result.ok) {
        if (result.reason === "not_allowed") {
          return response.status(403).json({ error: "Seuls Gionny et les membres Validés publient des posts publics." });
        }
        if (result.reason === "empty") return response.status(400).json({ error: "Écris quelque chose avant de poster." });
        if (result.reason === "banned") return response.status(403).json({ error: "Ce compte est suspendu." });
        return response.status(400).json({ error: "Le post n’a pas pu être publié." });
      }
      await syncStateToSupabase().catch(() => {});
      return response.status(201).json({
        ok: true,
        post: { ...result.post, isHost: viewer.role === "host", badges: viewer.badges || [], likes: 0, liked: false, canDelete: true },
      });
    }

    if (action === "like" || action === "unlike") {
      const result = await toggleLike({ pseudo: viewer.pseudo, postId: body.postId }, undefined);
      if (!result.ok) return response.status(404).json({ error: "Ce post n’existe plus." });
      await syncStateToSupabase().catch(() => {});
      return response.status(200).json({ ok: true, liked: result.liked, likes: result.likes });
    }

    if (action === "delete-post") {
      const result = await deletePost({ pseudo: viewer.pseudo, postId: body.postId }, undefined);
      if (!result.ok) {
        if (result.reason === "forbidden") return response.status(403).json({ error: "Tu ne peux supprimer que tes posts." });
        return response.status(404).json({ error: "Ce post n’existe plus." });
      }
      await syncStateToSupabase().catch(() => {});
      return response.status(200).json({ ok: true, deleted: true });
    }

    if (action === "logout") {
      clearAccountSessionCookie(request, response);
      return response.status(200).json({ ok: true });
    }

    return response.status(400).json({ error: "Cette action n’est pas reconnue." });
  } catch (error) {
    console.error("[profile] public profile action failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return response.status(502).json({ error: "Le QG n’a pas pu enregistrer cette action. Réessaie." });
  }
}

export { ensureHostFollowFor };
