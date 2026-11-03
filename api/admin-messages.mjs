import { isAdminRequest, isSameOriginRequest } from "../lib/admin-security.mjs";
import {
  addAdminImageReply,
  addAdminReply,
  countUnreadConversations,
  deleteContactMessage,
  deleteConversation,
  getAdminReplyIdentity,
  getConversationForAdmin,
  isContactMessagePath,
  isConversationId,
  isConversationSubject,
  listContactMessages,
  listConversations,
  setConversationFavorite,
  setConversationStatus,
  setConversationSubject,
  setConversationUnread,
  startAdminConversationForAccount,
  ensureOwnerAccountSeeded,
} from "../lib/contact-inbox.mjs";

const MAX_BODY_BYTES = 6000;

function setNoStore(response) {
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Vary", "Cookie");
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

function queryValue(request, key) {
  const value = request.query?.[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  try {
    return new URL(request.url || "/", `https://${request.headers?.host || "localhost"}`)
      .searchParams.get(key) || "";
  } catch {
    return "";
  }
}

function readCursor(request) {
  return queryValue(request, "cursor");
}

function readAfterSequence(request) {
  const value = queryValue(request, "after");
  if (!/^(0|[1-9]\d{0,2})$/u.test(value)) return null;
  const sequence = Number(value);
  return sequence <= 400 ? sequence : null;
}

function cleanAdminMessage(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .trim();
}

function conversationError(reason) {
  if (reason === "host_required") return { status: 409, error: "Aucun compte Hôte actif n’est associé à ce panneau. Définis le compte Hôte avant de répondre." };
  if (reason === "banned") return { status: 403, error: "Ce compte est désactivé et ne peut pas recevoir de nouvelle discussion." };
  if (reason === "blocked") return { status: 409, error: "Cette discussion est bloquée. Débloque-la pour répondre." };
  if (reason === "closed") return { status: 409, error: "Cette discussion est fermée. Rouvre-la pour répondre." };
  if (reason === "limit") return { status: 409, error: "Cette discussion a atteint sa limite de messages." };
  return { status: 404, error: "Cette discussion est introuvable." };
}

export default async function handler(request, response) {
  setNoStore(response);
  await ensureOwnerAccountSeeded().catch(() => {});

  if (!["GET", "POST", "PATCH", "DELETE"].includes(request.method)) {
    response.setHeader("Allow", "GET, POST, PATCH, DELETE");
    return response.status(405).json({ error: "Méthode non autorisée." });
  }
  if (!isSameOriginRequest(request)) {
    return response.status(403).json({ error: "Requête refusée." });
  }
  if (!(await isAdminRequest(request))) {
    return response.status(401).json({ error: "Reconnecte-toi au panneau d’administration." });
  }

  try {
    if (request.method === "GET") {
      const view = queryValue(request, "view");
      const cursor = readCursor(request);
      if (cursor.length > 2048) {
        return response.status(400).json({ error: "La demande de messages est invalide." });
      }

      if (view === "conversations") {
        const filter = queryValue(request, "filter") || "all";
        const subject = queryValue(request, "subject");
        if (!["all", "unread", "favorites", "audio"].includes(filter) || (subject && !isConversationSubject(subject))) {
          return response.status(400).json({ error: "Les filtres de conversations sont invalides." });
        }
        const result = await listConversations(cursor, undefined, { filter, subject });
        const unreadCount = queryValue(request, "summary") === "0"
          ? null
          : await countUnreadConversations().catch(() => null);
        return response.status(200).json({
          ...result,
          ...(Number.isInteger(unreadCount) ? { unreadCount } : {}),
        });
      }
      if (view === "conversation") {
        const id = queryValue(request, "id");
        if (!isConversationId(id)) {
          return response.status(400).json({ error: "Cette discussion est introuvable." });
        }
        const afterSequence = readAfterSequence(request);
        const conversation = await getConversationForAdmin(id, undefined, {
          ...(afterSequence === null ? {} : { afterSequence }),
          markRead: true,
        });
        if (!conversation) return response.status(404).json({ error: "Cette discussion n’existe plus." });
        return response.status(200).json(conversation);
      }

      return response.status(200).json(await listContactMessages(cursor));
    }

    const body = readJsonBody(request);
    if (!body || typeof body !== "object") {
      return response.status(400).json({ error: "La demande est incomplète." });
    }

    if (request.method === "POST") {
      if (body.action === "start-conversation") {
        if (!isConversationId(body.accountId)) return response.status(400).json({ error: "Choisis un membre valide." });
        const identity = await getAdminReplyIdentity(request);
        const result = await startAdminConversationForAccount(body.accountId, identity);
        if (!result.ok) {
          const failure = conversationError(result.reason);
          return response.status(failure.status).json({ error: failure.error });
        }
        return response.status(result.created ? 201 : 200).json({
          ok: true,
          conversation: result.conversation,
          messages: result.messages,
          created: result.created === true,
        });
      }
      if (!isConversationId(body.conversationId)) {
        return response.status(400).json({ error: "Choisis une discussion valide." });
      }
      const message = cleanAdminMessage(body.message);
      if (!message || message.length > 1500) {
        return response.status(400).json({ error: "Écris une réponse de 1 à 1 500 caractères." });
      }

      const identity = await getAdminReplyIdentity(request);
      if (!identity) {
        const failure = conversationError("host_required");
        return response.status(failure.status).json({ error: failure.error });
      }
      const result = await addAdminReply(body.conversationId, message, identity);
      if (!result.ok) {
        const failure = conversationError(result.reason);
        return response.status(failure.status).json({ error: failure.error });
      }
      return response.status(201).json({ ok: true, conversation: result.conversation, message: result.message });
    }

    if (request.method === "PATCH") {
      const operations = [
        typeof body.favorite === "boolean",
        typeof body.unread === "boolean",
        typeof body.status === "string",
        typeof body.subject === "string",
      ].filter(Boolean).length;
      if (operations !== 1) return response.status(400).json({ error: "L’action de boîte mail est invalide." });

      const operationIsValid =
        (typeof body.favorite === "boolean") ||
        (typeof body.unread === "boolean") ||
        ["open", "closed", "blocked"].includes(body.status) ||
        isConversationSubject(body.subject);
      if (!operationIsValid) return response.status(400).json({ error: "L’action de boîte mail est invalide." });

      const isBulk = Array.isArray(body.conversationIds);
      if (isBulk && typeof body.subject === "string") return response.status(400).json({ error: "Le sujet se modifie sur une seule discussion." });
      const ids = isBulk ? [...new Set(body.conversationIds)] : [body.conversationId];
      if (ids.length < 1 || ids.length > 100 || !ids.every(isConversationId)) {
        return response.status(400).json({ error: "Choisis entre 1 et 100 discussions valides." });
      }

      const updated = [];
      const skipped = [];
      for (let index = 0; index < ids.length; index += 10) {
        const batch = await Promise.all(ids.slice(index, index + 10).map(async (id) => {
          const conversation = typeof body.favorite === "boolean"
            ? await setConversationFavorite(id, body.favorite)
            : typeof body.unread === "boolean"
              ? await setConversationUnread(id, body.unread)
              : typeof body.subject === "string"
                ? await setConversationSubject(id, body.subject)
                : await setConversationStatus(id, body.status);
          return { id, conversation };
        }));
        for (const result of batch) {
          if (result.conversation) updated.push(result.conversation);
          else skipped.push(result.id);
        }
      }
      return response.status(200).json(isBulk ? { updated, skipped } : { conversation: updated[0] || null });
    }

    if (Array.isArray(body.conversationIds)) {
      const ids = [...new Set(body.conversationIds)];
      if (ids.length < 1 || ids.length > 100 || !ids.every(isConversationId)) {
        return response.status(400).json({ error: "Choisis entre 1 et 100 discussions valides." });
      }
      const deletedIds = [];
      const skippedIds = [];
      const failedIds = [];
      for (let index = 0; index < ids.length; index += 10) {
        const batch = await Promise.all(ids.slice(index, index + 10).map(async (id) => {
          try {
            return { id, deleted: await deleteConversation(id), failed: false };
          } catch {
            return { id, deleted: false, failed: true };
          }
        }));
        for (const result of batch) {
          if (result.deleted) deletedIds.push(result.id);
          else if (result.failed) failedIds.push(result.id);
          else skippedIds.push(result.id);
        }
      }
      return response.status(200).json({ deletedIds, skippedIds, failedIds });
    }

    if (typeof body.conversationId === "string") {
      if (!isConversationId(body.conversationId)) {
        return response.status(400).json({ error: "Cette discussion est introuvable." });
      }
      const deleted = await deleteConversation(body.conversationId);
      return response.status(200).json({ deleted });
    }

    if (!isContactMessagePath(body.id)) {
      return response.status(400).json({ error: "Ce message est introuvable." });
    }
    await deleteContactMessage(body.id);
    return response.status(200).json({ deleted: true });
  } catch (error) {
    console.error("[admin-messages] private inbox request failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
    return response.status(502).json({
      error: "La boîte de réception ne peut pas être chargée pour le moment. Réessaie.",
    });
  }
}
