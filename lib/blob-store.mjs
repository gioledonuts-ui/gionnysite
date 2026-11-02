import { del, get, list, put } from "@vercel/blob";
import { makeDefaultSiteConfig, readStoredSiteConfig } from "./site-config.mjs";

// One shared Vercel Blob client is used by site settings, member accounts,
// conversations, messages, and private voice attachments in every function.
export const sharedBlobStore = Object.freeze({ del, get, list, put });
export const CONFIG_BLOB_PATH = "gionny/site-config.json";

export function isBlobStorageConfigured() {
  const hasReadWriteToken = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
  // Vercel can pass the OIDC token in request context, not just process.env.
  const hasVercelOidcAccess = Boolean(
    process.env.BLOB_STORE_ID && (process.env.VERCEL === "1" || process.env.VERCEL_OIDC_TOKEN),
  );
  return hasReadWriteToken || hasVercelOidcAccess;
}

export async function readSharedSiteConfig() {
  if (!isBlobStorageConfigured()) {
    return {
      config: makeDefaultSiteConfig(),
      storageConfigured: false,
      updatedAt: null,
    };
  }

  const blob = await sharedBlobStore.get(CONFIG_BLOB_PATH, {
    access: "public",
    useCache: false,
  });

  if (!blob) {
    return {
      config: makeDefaultSiteConfig(),
      storageConfigured: true,
      updatedAt: null,
    };
  }

  const stored = JSON.parse(await new Response(blob.stream).text());
  const updatedAt =
    typeof stored?.updatedAt === "string" && Number.isFinite(Date.parse(stored.updatedAt))
      ? stored.updatedAt
      : null;

  return {
    config: readStoredSiteConfig(stored),
    storageConfigured: true,
    updatedAt,
  };
}

export async function writeSharedSiteConfig(config) {
  if (!isBlobStorageConfigured()) {
    const error = new Error("Vercel Blob storage is not configured");
    error.code = "BLOB_STORAGE_NOT_CONFIGURED";
    throw error;
  }

  const updatedAt = new Date().toISOString();
  const body = JSON.stringify({ version: 1, updatedAt, config });
  await sharedBlobStore.put(CONFIG_BLOB_PATH, body, {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: 60,
    contentType: "application/json; charset=utf-8",
  });

  return updatedAt;
}
