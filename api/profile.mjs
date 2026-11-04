import { isSameOriginRequest } from "../lib/admin-security.mjs";
import {
  clearAccountSessionCookie,
  getVisitorAccountFromSession,
  listVisitorAccounts,
  readAccountSessionCookie,
} from "../lib/contact-inbox.mjs";
import { ensureStateLoaded, syncStateToSupabase } from "../lib/blob-store.mjs";
import {
  MEDIA_KINDS,
  REPORT_REASONS,
  attachPostMedia,
  countUnreadNotifications,
  createPost,
  createReport,
  deletePost,
  ensureHostFollowFor,
  getProfileRecord,
  getPublicProfile,
  listFeed,
  listNotifications,
  markNotificationsRead,
  readPostMedia,
  setPinned,
  setBlock,
  setFollow,
  toggleLike,
  toggleRepost,
  updateProfileDetails,
} from "../lib/social-graph.mjs";

// ---------------------------------------------------------------------------
// API publique des profils du QG
// ---------------------------------------------------------------------------
// GET  /api/profile?pseudo=…        → profil public + compteurs + relations
// GET  /api/profile?directory=1     → annuaire léger (pseudo, rôle, badge, photo)
// POST /api/profile {action:…}      → follow | unfollow | block | unblock |
//                                     report | details | media
// GET  /api/profile?media=1&post=…&kind=…  → binaire du média d'un post
//
// Aucune donnée privée ne sort d'ici : ni conversation, ni mot de passe, ni
// adresse. Seuls le pseudo, la bio, le pseudo Discord, le rôle, le badge et la
// photo (déjà publique dans le fil) sont renvoyés.

const MAX_BODY_BYTES = 4000;
// Un média de post arrive dans le même JSON (base64) : 4 Mo couvrent une vidéo
// de 2 Mo + son enveloppe base64, sans laisser passer un fichier arbitraire.
const MAX_MEDIA_BODY_BYTES = 4 * 1024 * 1024;
const MEDIA_LIMITS = { image: 60 * 1024, vocal: 200 * 1024, video: 2 * 1024 * 1024 };
const RATE_WINDOW_MS = 10 * 60 * 1000;
const MAX_REPORTS_PER_WINDOW = 10;
const MAX_DIRECTORY = 120;
// Les médias sont servis par cette même route (`?media=1`), pas par une fonction
// dédiée : la limite Hobby de Vercel plafonne un déploiement à 12 fonctions.
const MEDIA_TYPES = { image: "image/webp", vocal: "audio/webm", video: "video/mp4" };
const rateLimits = new Map();

function setNoStore(response) {
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Vary", "Origin, Cookie");
}

function readJsonBody(request, limit = MAX_BODY_BYTES) {
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
    try {
      return Buffer.byteLength(JSON.stringify(request.body), "utf8") <= limit ? request.body : null;
    } catch {
      return null;
    }
  }
  const raw = Buffer.isBuffer(request.body)
    ? request.body.toString("utf8")
    : typeof request.body === "string"
      ? request.body
      : "";
  if (!raw || Buffer.byteLength(raw, "utf8") > limit) return null;
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

function rateLimited(key, limit = MAX_REPORTS_PER_WINDOW, windowMs = RATE_WINDOW_MS) {
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

// L'Hôte est reconnu par son rôle (source de vérité : le compte), avec le
// pseudo comme filet de sécurité pour les installations historiques.
function isHostAccount(account) {
  return account?.role === "host" || ["gionny", "7gionny"].includes(String(account?.pseudo || "").trim().toLowerCase());
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

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Sert le binaire d'un post (`GET /api/profile?media=1&post=…&kind=…`).
 * Lecture seule, type MIME strict, cache privé court : le média n'est jamais
 * exposé en data-URL dans le JSON du fil.
 */
async function servePostMedia(request, response) {
  const postId = queryValue(request, "post");
  const kind = queryValue(request, "kind");
  if (!postId || !MEDIA_TYPES[kind]) {
    return response.status(400).json({ error: "Ce média n’est pas valide." });
  }
  try {
    const media = await readPostMedia({ postId, kind });
    if (!media) return response.status(404).json({ error: "Ce média n’existe plus." });
    const buffer = await streamToBuffer(media.stream);
    response.setHeader("Content-Type", MEDIA_TYPES[kind]);
    response.setHeader("Content-Length", String(buffer.length));
    if (request.method === "HEAD") return response.status(200).end();
    return response.status(200).send(buffer);
  } catch {
    return response.status(502).json({ error: "Ce média ne peut pas être chargé pour le moment." });
  }
}

export default async function handler(request, response) {
  if (queryValue(request, "media")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      return response.status(405).json({ error: "Méthode non autorisée." });
    }
    response.setHeader("Cache-Control", "private, max-age=120");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Vary", "Cookie");
    await ensureStateLoaded().catch(() => {});
    return servePostMedia(request, response);
  }

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

    // Quatre lectures possibles : tout, les suivis, les Validés, les reposts.
    const requestedMode = queryValue(request, "mode");
    const mode = ["follows", "verified", "reposts", "likes"].includes(requestedMode)
      ? requestedMode
      : "all";
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

    if (queryValue(request, "notifications")) {
      if (!viewer) return response.status(200).json({ notifications: [], unread: 0, viewer: null });
      try {
        const notifications = await listNotifications({ viewer: viewer.pseudo }, undefined);
        const unread = await countUnreadNotifications({ viewer: viewer.pseudo }, undefined);
        return response.status(200).json({ notifications, unread, viewer: viewer.pseudo });
      } catch (error) {
        console.error("[profile] notifications read failed", {
          name: error instanceof Error ? error.name : "UnknownError",
        });
        return response.status(502).json({ error: "Les notifications ne peuvent pas être chargées." });
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

  // Seul un dépôt de média a le droit à une enveloppe plus large : on regarde
  // la requête brute avant de parser, sans jamais faire confiance au client.
  const rawBody = Buffer.isBuffer(request.body)
    ? request.body.toString("utf8")
    : typeof request.body === "string"
      ? request.body
      : request.body && typeof request.body === "object"
        ? JSON.stringify(request.body)
        : "";
  const wantsMediaSlot = rawBody.length > MAX_BODY_BYTES && rawBody.includes('"mediaData"');
  const body = readJsonBody(request, wantsMediaSlot ? MAX_MEDIA_BODY_BYTES : MAX_BODY_BYTES);
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
      const descriptor = body.media && typeof body.media === "object"
        ? { kind: body.media.kind, alt: body.media.alt, duration: body.media.duration }
        : null;
      if (descriptor && !MEDIA_LIMITS[descriptor.kind]) {
        return response.status(400).json({ error: "Ce type de média n’est pas accepté." });
      }
      const result = await createPost({
        pseudo: viewer.pseudo,
        text: body.text,
        media: descriptor,
        quoteOf: body.quoteOf,
      }, undefined);
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
        post: {
          ...result.post,
          isHost: isHostAccount(viewer),
          badges: Array.isArray(viewer.badges) ? viewer.badges : [],
          likes: 0,
          liked: false,
          reposts: 0,
          reposted: false,
          canDelete: true,
          media: result.post.media
            ? { ...result.post.media, url: `/api/profile?media=1&post=${encodeURIComponent(result.post.id)}&kind=${result.post.media.kind}` }
            : null,
        },
      });
    }

    // Dépôt du binaire d'un média, juste après la création du post.
    if (action === "media") {
      const kind = typeof body.kind === "string" ? body.kind : "";
      const limit = MEDIA_LIMITS[kind];
      if (!limit || !MEDIA_KINDS.includes(kind)) {
        return response.status(400).json({ error: "Ce type de média n’est pas accepté." });
      }
      if (rateLimited(`media:${clientKey(request)}`, 40, RATE_WINDOW_MS)) {
        return response.status(429).json({ error: "Trop d’envois d’un coup. Réessaie dans une minute." });
      }
      const encoded = typeof body.mediaData === "string" ? body.mediaData : "";
      if (!encoded) return response.status(400).json({ error: "Le média est vide." });
      const bytes = Buffer.from(encoded, "base64");
      if (!bytes.length || bytes.length > limit) {
        return response.status(413).json({
          error: kind === "video"
            ? "Cette vidéo dépasse 2 Mo après compression (30 s maximum)."
            : kind === "vocal"
              ? "Ce vocal dépasse 200 Ko."
              : "Cette image dépasse 60 Ko après compression.",
        });
      }
      const stored = await attachPostMedia({
        pseudo: viewer.pseudo,
        postId: body.postId,
        kind,
        bytes,
        contentType: body.contentType,
      }, undefined);
      if (!stored.ok) {
        if (stored.reason === "forbidden") return response.status(403).json({ error: "Tu ne peux pas modifier ce post." });
        return response.status(404).json({ error: "Ce post n’existe plus." });
      }
      await syncStateToSupabase().catch(() => {});
      return response.status(201).json({ ok: true });
    }

    if (action === "pin" || action === "unpin") {
      const result = await setPinned({ pseudo: viewer.pseudo, postId: body.postId, pinned: action === "pin" }, undefined);
      if (!result.ok) {
        if (result.reason === "forbidden") return response.status(403).json({ error: "Seul Gionny épingle un post dans le QG." });
        return response.status(404).json({ error: "Ce post n’existe plus." });
      }
      await syncStateToSupabase().catch(() => {});
      return response.status(200).json({ ok: true, pinned: result.pinned });
    }

    if (action === "repost" || action === "unrepost") {
      const result = await toggleRepost({ pseudo: viewer.pseudo, postId: body.postId }, undefined);
      if (!result.ok) {
        if (result.reason === "blocked") return response.status(403).json({ error: "Ce post vient d’un compte bloqué." });
        return response.status(404).json({ error: "Ce post n’existe plus." });
      }
      await syncStateToSupabase().catch(() => {});
      return response.status(200).json({ ok: true, reposted: result.reposted, reposts: result.reposts });
    }

    if (action === "notifications-read") {
      const result = await markNotificationsRead({ viewer: viewer.pseudo }, undefined);
      await syncStateToSupabase().catch(() => {});
      return response.status(200).json({ ok: true, unread: result.unread || 0 });
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
