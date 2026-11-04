import { isAdminRequest, isSameOriginRequest } from "../lib/admin-security.mjs";
import {
  ensureStateLoaded,
  readSharedSiteConfig,
  restoreAdminStateReplica,
  restoreSharedSiteConfig,
  syncStateToSupabase,
  writeSharedSiteConfig,
} from "../lib/blob-store.mjs";
import { SOCIAL_INFO_FIELDS, validateSiteConfig } from "../lib/site-config.mjs";

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
  await ensureStateLoaded().catch(() => {});

  if (request.method === "GET") {
    try {
      // Cold start: the config is gone but a replica may still hold Gionny's
      // planning, so the very first read brings it back.
      const replica = await restoreAdminStateReplica().catch(() => null);
      const result = await readSharedSiteConfig();
      return response.status(200).json({ ...result, restoredFromReplica: replica?.restored === true });
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

  let body = readJsonBody(request);
  // A browser that still holds Gionny's saved settings can push them back after
  // a server restart (`{ restore: true, config: {...} }`). It only ever reaches
  // this point when the server has no custom config left, and it never touches
  // the member records, so it cannot be used to overwrite live settings.
  const browserRestore = body?.restore === true && body?.config && typeof body.config === "object";
  if (browserRestore) {
    const current = await readSharedSiteConfig().catch(() => null);
    if (current?.updatedAt) {
      return response.status(409).json({
        error: "Les réglages en ligne sont déjà à jour.",
        config: current.config,
        updatedAt: current.updatedAt,
      });
    }
    body = body.config;
  } else if (!(await isAdminRequest(request))) {
    return response.status(401).json({ error: "Reconnecte-toi au panneau d’administration." });
  }
  const incomingSocialInfo = body?.socialInfo;
  const socialInfoIsPartial =
    incomingSocialInfo === undefined ||
    (incomingSocialInfo &&
      typeof incomingSocialInfo === "object" &&
      !Array.isArray(incomingSocialInfo) &&
      SOCIAL_INFO_FIELDS.some((field) => incomingSocialInfo[field] === undefined));

  if (body && typeof body === "object" && !Array.isArray(body) && socialInfoIsPartial) {
    try {
      const current = await readSharedSiteConfig();
      body = {
        ...body,
        socialInfo: { ...current.config.socialInfo, ...(incomingSocialInfo || {}) },
      };
    } catch {
      return response.status(503).json({
        error: "shared_storage_unavailable",
        message: "Les sous-titres enregistrés n’ont pas pu être conservés. Réessaie sans écraser les réglages actuels.",
      });
    }
  }
  const validation = validateSiteConfig(body);
  if (!validation.ok) {
    return response.status(400).json({ error: validation.error });
  }

  try {
    const updatedAt = browserRestore
      ? await restoreSharedSiteConfig(validation.config)
      : await writeSharedSiteConfig(validation.config);
    const persisted = await syncStateToSupabase();
    return response.status(200).json({
      persisted: persisted.saved,
      restoredFromBrowser: browserRestore,
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
