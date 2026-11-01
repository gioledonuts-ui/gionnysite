import { isAdminRequest, isSameOriginRequest } from "../lib/admin-security.mjs";
import { isBlobStorageConfigured } from "../lib/blob-store.mjs";
import {
  deleteContactMessage,
  isContactMessagePath,
  listContactMessages,
} from "../lib/contact-inbox.mjs";

const MAX_BODY_BYTES = 4096;

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

function readCursor(request) {
  const queryValue = request.query?.cursor;
  if (typeof queryValue === "string") return queryValue;
  if (Array.isArray(queryValue) && typeof queryValue[0] === "string") return queryValue[0];
  try {
    return new URL(request.url || "/", `https://${request.headers?.host || "localhost"}`)
      .searchParams.get("cursor") || "";
  } catch {
    return "";
  }
}

export default async function handler(request, response) {
  setNoStore(response);

  if (request.method !== "GET" && request.method !== "DELETE") {
    response.setHeader("Allow", "GET, DELETE");
    return response.status(405).json({ error: "Méthode non autorisée." });
  }
  if (!isSameOriginRequest(request)) {
    return response.status(403).json({ error: "Requête refusée." });
  }
  if (!isAdminRequest(request)) {
    return response.status(401).json({ error: "Reconnecte-toi au panneau d’administration." });
  }
  if (!isBlobStorageConfigured()) {
    return response.status(503).json({ error: "Le stockage privé des messages n’est pas disponible." });
  }

  try {
    if (request.method === "GET") {
      const cursor = readCursor(request);
      if (cursor.length > 2048) {
        return response.status(400).json({ error: "La demande de messages est invalide." });
      }
      return response.status(200).json(await listContactMessages(cursor));
    }

    const body = readJsonBody(request);
    if (!body || !isContactMessagePath(body.id)) {
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
