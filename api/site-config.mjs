import { isAdminRequest, isSameOriginRequest } from "../lib/admin-security.mjs";
import { isBlobStorageConfigured, readSharedSiteConfig, writeSharedSiteConfig } from "../lib/blob-store.mjs";
import { validateSiteConfig } from "../lib/site-config.mjs";

function setNoStore(response) {
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
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
  if (!body || Buffer.byteLength(body, "utf8") > 32_768) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export default async function handler(request, response) {
  setNoStore(response);

  if (request.method === "GET") {
    try {
      const result = await readSharedSiteConfig();
      return response.status(200).json(result);
    } catch {
      return response.status(503).json({
        error: "shared_storage_unavailable",
        message: "Le stockage en ligne est temporairement indisponible.",
      });
    }
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ error: "Méthode non autorisée." });
  }

  if (!isSameOriginRequest(request)) {
    return response.status(403).json({ error: "Requête refusée." });
  }
  if (!isAdminRequest(request)) {
    return response.status(401).json({ error: "Reconnecte-toi au panneau d’administration." });
  }
  if (!isBlobStorageConfigured()) {
    return response.status(503).json({
      error: "blob_storage_not_configured",
      message: "Vercel Blob doit être activé avant de pouvoir enregistrer les changements en ligne.",
    });
  }

  const body = readJsonBody(request);
  const validation = validateSiteConfig(body);
  if (!validation.ok) {
    return response.status(400).json({ error: validation.error });
  }

  try {
    const updatedAt = await writeSharedSiteConfig(validation.config);
    return response.status(200).json({
      config: validation.config,
      storageConfigured: true,
      updatedAt,
    });
  } catch {
    return response.status(502).json({
      error: "shared_storage_write_failed",
      message: "La sauvegarde en ligne a échoué. Réessaie dans un instant.",
    });
  }
}
