import { isAdminRequest, isSameOriginRequest } from "../lib/admin-security.mjs";
import { isBlobStorageConfigured } from "../lib/blob-store.mjs";
import {
  deleteVisitorAccount,
  isConversationId,
  listVisitorAccounts,
  setVisitorAccountBanned,
  setVisitorAccountRole,
} from "../lib/contact-inbox.mjs";

const MAX_BODY_BYTES = 4000;

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

function memberError(reason) {
  if (reason === "not_found") return { status: 404, error: "Ce membre n’existe plus." };
  if (reason === "host") return { status: 409, error: "Retire d’abord le rôle Hôte avant de bannir ou supprimer ce compte." };
  if (reason === "banned") return { status: 409, error: "Un compte banni ne peut pas devenir Hôte." };
  if (reason === "invalid_role" || reason === "invalid_status") return { status: 400, error: "Cette action sur le membre n’est pas valide." };
  return { status: 409, error: "Cette action sur le membre n’a pas pu être effectuée." };
}

export default async function handler(request, response) {
  setNoStore(response);
  if (!["GET", "PATCH", "DELETE"].includes(request.method)) {
    response.setHeader("Allow", "GET, PATCH, DELETE");
    return response.status(405).json({ error: "Méthode non autorisée." });
  }
  if (!isSameOriginRequest(request)) return response.status(403).json({ error: "Requête refusée." });
  if (!isAdminRequest(request)) return response.status(401).json({ error: "Reconnecte-toi au panneau d’administration." });
  if (!isBlobStorageConfigured()) return response.status(503).json({ error: "Le stockage privé des comptes n’est pas disponible." });

  try {
    if (request.method === "GET") {
      const cursor = queryValue(request, "cursor");
      if (cursor.length > 2048) return response.status(400).json({ error: "La demande de membres est invalide." });
      return response.status(200).json(await listVisitorAccounts(cursor));
    }

    const body = readJsonBody(request);
    if (!body || typeof body !== "object" || !isConversationId(body.id)) {
      return response.status(400).json({ error: "Choisis un membre valide." });
    }

    if (request.method === "PATCH") {
      const hasRole = Object.hasOwn(body, "role");
      const hasBanned = Object.hasOwn(body, "banned");
      if (hasRole === hasBanned) return response.status(400).json({ error: "Choisis une seule action pour ce membre." });
      const result = hasRole
        ? await setVisitorAccountRole(body.id, body.role)
        : await setVisitorAccountBanned(body.id, body.banned);
      if (!result.ok) {
        const failure = memberError(result.reason);
        return response.status(failure.status).json({ error: failure.error });
      }
      return response.status(200).json(result);
    }

    const result = await deleteVisitorAccount(body.id);
    if (!result.ok) {
      const failure = memberError(result.reason);
      return response.status(failure.status).json({ error: failure.error });
    }
    return response.status(200).json({ deleted: true, conversationPreserved: true });
  } catch (error) {
    console.error("[admin-members] private member request failed", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
    return response.status(502).json({ error: "La liste des membres ne peut pas être chargée pour le moment." });
  }
}
