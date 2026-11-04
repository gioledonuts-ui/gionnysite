import { isSameOriginRequest } from "./admin-security.mjs";
import {
  getAccountRecordFromSession,
  readAccountSessionCookie,
} from "./contact-inbox.mjs";
import { ensureStateLoaded, syncStateToSupabase } from "./blob-store.mjs";
import { getProfileRecord } from "./social-graph.mjs";
import {
  acceptRequest,
  createDirectThread,
  createGroupThread,
  DM_LIMITS,
  getDmMedia,
  getThreadForMember,
  listInbox,
  markThreadRead,
  publicThread,
  readDirectory,
  readThread,
  refuseRequest,
  sendDmMessage,
} from "./direct-messages.mjs";

// ---------------------------------------------------------------------------
// API de la messagerie multi-DM (une seule fonction : la limite Hobby de
// Vercel plafonne le déploiement à 12 fonctions).
// ---------------------------------------------------------------------------
// GET  /api/messages                    → boîte de réception + demandes
// GET  /api/messages?thread=<id>&after= → une discussion (messages)
// GET  /api/messages?media=1&thread=&message=  → vocal / image
// POST /api/messages {action:…}         → direct | group | send | accept |
//                                         refuse | read
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1_200_000;
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 120;
const rateLimits = new Map();

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
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
    return request.body;
  }
  const raw = Buffer.isBuffer(request.body)
    ? request.body.toString("utf8")
    : typeof request.body === "string"
      ? request.body
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
  return state.count > RATE_LIMIT;
}

function dmError(reason) {
  switch (reason) {
    case "unauthorized":
      return { status: 401, error: "Connecte-toi pour ouvrir tes messages." };
    case "not_found":
      return { status: 404, error: "Cette discussion n’existe plus." };
    case "forbidden":
      return { status: 403, error: "Cette discussion ne t’appartient pas." };
    case "banned":
      return { status: 403, error: "Ce compte est suspendu : contacte Gionny." };
    case "not_allowed":
      return { status: 403, error: "Les messages privés sont réservés aux membres Validés ✓ (et à Gionny)." };
    case "self":
      return { status: 400, error: "Tu ne peux pas t’écrire à toi-même." };
    case "request":
      return { status: 409, error: "Cette personne doit d’abord accepter ta demande." };
    case "blocked":
      return { status: 403, error: "Cette discussion est bloquée." };
    case "limit":
      return { status: 409, error: "Cette discussion a atteint sa limite de messages." };
    case "members":
      return { status: 400, error: "Choisis au moins une personne pour le groupe." };
    case "group":
      return { status: 400, error: "Une demande ne concerne jamais un groupe." };
    case "audio":
      return { status: 400, error: "La note vocale dépasse 200 Ko. Essaie un enregistrement plus court." };
    case "image":
      return { status: 400, error: "Cette image est trop lourde (400 Ko maximum)." };
    case "media":
      return { status: 400, error: "Ce fichier n’est pas accepté." };
    case "invalid":
      return { status: 400, error: "Écris un message de 1 à 1 500 caractères." };
    default:
      return { status: 400, error: "Cette action n’a pas pu être effectuée." };
  }
}

/** Personnes suivies par l'expéditeur : sert à décider demande ou boîte. */
async function readFollowing(pseudo) {
  const profile = await getProfileRecord(pseudo).catch(() => null);
  return Array.isArray(profile?.following) ? profile.following : [];
}

export function isDmRequest(request) {
  return queryValue(request, "messages") === "1";
}

/** Entonnoir unique : /api/messages → /api/profile?messages=1 (rewrite). */
export async function handleMessagesRequest(request, response) {
  setNoStore(response);
  await ensureStateLoaded().catch(() => {});

  // Média (vocal / image) : binaire, lecture seule.
  if (queryValue(request, "media") === "1") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      return sendJson(response, 405, { error: "Méthode non autorisée." });
    }
    const media = await getDmMedia({
      threadId: queryValue(request, "thread"),
      messageId: queryValue(request, "message"),
    }).catch(() => null);
    if (!media) return sendJson(response, 404, { error: "Ce média n’existe plus." });
    response.setHeader("Content-Type", media.mimeType);
    response.setHeader("Content-Length", String(media.bytes.length));
    response.setHeader("Cache-Control", "private, max-age=86400");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (request.method === "HEAD") return response.status(200).end();
    return response.status(200).send(media.bytes);
  }

  if (request.method !== "GET" && request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return sendJson(response, 405, { error: "Méthode non autorisée." });
  }
  if (!isSameOriginRequest(request)) return sendJson(response, 403, { error: "Requête refusée." });

  const sessionToken = readAccountSessionCookie(request);
  const resolved = sessionToken ? await getAccountRecordFromSession(sessionToken).catch(() => null) : null;
  if (!resolved?.account) return sendJson(response, 401, { error: dmError("unauthorized").error });
  const pseudo = resolved.account.pseudo;

  if (request.method === "GET") {
    const threadId = queryValue(request, "thread");
    if (threadId) {
      const after = Number(queryValue(request, "after"));
      const result = await getThreadForMember({
        pseudo,
        threadId,
        after: Number.isInteger(after) && after > 0 ? after : 0,
      }).catch(() => ({ ok: false, reason: "error" }));
      if (!result.ok) {
        const failure = dmError(result.reason);
        return sendJson(response, failure.status, { error: failure.error });
      }
      return sendJson(response, 200, { ok: true, ...result, limits: DM_LIMITS });
    }
    const inbox = await listInbox({ pseudo }).catch(() => ({ ok: false, reason: "error" }));
    if (!inbox.ok) {
      const failure = dmError(inbox.reason);
      return sendJson(response, failure.status, { error: failure.error });
    }
    return sendJson(response, 200, { ok: true, viewer: pseudo, ...inbox, limits: DM_LIMITS });
  }

  const body = readJsonBody(request);
  if (!body) return sendJson(response, 400, { error: "La demande est incomplète." });
  if (rateLimited(`dm:${clientKey(request)}`)) {
    return sendJson(response, 429, { error: "Beaucoup de messages d’un coup : réessaie dans quelques minutes." });
  }
  const action = typeof body.action === "string" ? body.action : "";

  try {
    if (action === "direct") {
      const result = await createDirectThread({
        from: pseudo,
        target: body.pseudo,
        following: await readFollowing(pseudo),
      });
      if (!result.ok) {
        const failure = dmError(result.reason);
        return sendJson(response, failure.status, { error: failure.error });
      }
      const opened = await getThreadForMember({ pseudo, threadId: result.thread.id });
      await syncStateToSupabase().catch(() => {});
      return sendJson(response, 200, { ok: true, ...opened, existing: result.existing === true });
    }

    if (action === "group") {
      const result = await createGroupThread({ from: pseudo, members: body.members, title: body.title });
      if (!result.ok) {
        const failure = dmError(result.reason);
        return sendJson(response, failure.status, { error: failure.error });
      }
      const opened = await getThreadForMember({ pseudo, threadId: result.thread.id });
      await syncStateToSupabase().catch(() => {});
      return sendJson(response, 201, { ok: true, ...opened });
    }

    if (action === "send") {
      const result = await sendDmMessage({
        pseudo,
        threadId: body.threadId,
        text: body.text,
        data: body.data,
        mimeType: body.mimeType,
        audioPeaks: body.audioPeaks,
      });
      if (!result.ok) {
        const failure = dmError(result.reason);
        return sendJson(response, failure.status, { error: failure.error });
      }
      await syncStateToSupabase().catch(() => {});
      return sendJson(response, 201, { ok: true, ...result });
    }

    if (action === "accept" || action === "refuse") {
      const result = action === "accept"
        ? await acceptRequest({ pseudo, threadId: body.threadId })
        : await refuseRequest({ pseudo, threadId: body.threadId, block: body.block === true });
      if (!result.ok) {
        const failure = dmError(result.reason);
        return sendJson(response, failure.status, { error: failure.error });
      }
      const inbox = await listInbox({ pseudo });
      await syncStateToSupabase().catch(() => {});
      return sendJson(response, 200, { ok: true, ...inbox, viewer: pseudo });
    }

    if (action === "read") {
      const result = await markThreadRead({ pseudo, threadId: body.threadId, sequence: body.sequence });
      if (!result.ok) {
        const failure = dmError(result.reason);
        return sendJson(response, failure.status, { error: failure.error });
      }
      return sendJson(response, 200, { ok: true, unread: result.unread });
    }

    if (action === "inbox") {
      const inbox = await listInbox({ pseudo });
      if (!inbox.ok) {
        const failure = dmError(inbox.reason);
        return sendJson(response, failure.status, { error: failure.error });
      }
      return sendJson(response, 200, { ok: true, viewer: pseudo, ...inbox });
    }

    return sendJson(response, 400, { error: "Cette action n’est pas reconnue." });
  } catch (error) {
    console.error("[messages] request failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
    return sendJson(response, 502, { error: "La messagerie n’est pas disponible pour le moment." });
  }
}

export { publicThread, readDirectory, readThread };
