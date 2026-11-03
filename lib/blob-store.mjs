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

// Blob quota guard: each serverless instance keeps the public settings in RAM
// (globalThis.__qgState) and only reads the Blob once, at first use. Every GET
// is then answered from memory (0 Blob operations), and a write updates RAM
// first so a Blob quota error can never block the site.
const STATE_KEY = Symbol.for("gionny.site-config.state.v1");
const LOAD_TIMEOUT_MS = 4_000;

function currentState() {
  const shared = globalThis[STATE_KEY];
  if (shared && typeof shared === "object") return shared;
  const state = { loaded: false, loading: null, config: null, updatedAt: null, storageConfigured: false };
  globalThis[STATE_KEY] = state;
  return state;
}

function snapshot(state) {
  return {
    config: state.config ? JSON.parse(JSON.stringify(state.config)) : makeDefaultSiteConfig(),
    storageConfigured: state.storageConfigured || isBlobStorageConfigured(),
    updatedAt: state.updatedAt,
  };
}

async function loadStateFromBlob(state) {
  if (!isBlobStorageConfigured()) {
    state.loaded = true;
    state.storageConfigured = false;
    state.config = makeDefaultSiteConfig();
    state.updatedAt = null;
    return;
  }

  state.storageConfigured = true;
  try {
    const blob = await sharedBlobStore.get(CONFIG_BLOB_PATH, { access: "public", useCache: false });
    if (!blob) {
      state.config = makeDefaultSiteConfig();
      state.updatedAt = null;
    } else {
      const text = await new Response(blob.stream).text();
      const stored = JSON.parse(text);
      state.config = readStoredSiteConfig(stored);
      state.updatedAt =
        typeof stored?.updatedAt === "string" && Number.isFinite(Date.parse(stored.updatedAt))
          ? stored.updatedAt
          : null;
    }
  } catch (error) {
    // Quota, network, or cold-store hiccup: fall back to the defaults, in RAM only.
    console.warn("[site-config] initial Blob read skipped", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
    state.config = state.config || makeDefaultSiteConfig();
  } finally {
    state.loaded = true;
  }
}

export async function readSharedSiteConfig() {
  const state = currentState();
  if (!state.loaded) {
    if (!state.loading) {
      state.loading = loadStateFromBlob(state).finally(() => {
        state.loading = null;
      });
    }
    await Promise.race([
      state.loading,
      new Promise((resolve) => setTimeout(resolve, LOAD_TIMEOUT_MS).unref?.()),
    ]);
  }
  if (!state.config) state.config = makeDefaultSiteConfig();
  return snapshot(state);
}

export function writeSharedSiteConfigInMemory(config, updatedAt = new Date().toISOString()) {
  const state = currentState();
  state.loaded = true;
  state.config = readStoredSiteConfig({ config, updatedAt });
  state.updatedAt = updatedAt;
  state.storageConfigured = isBlobStorageConfigured() || state.storageConfigured;
  return snapshot(state);
}

export async function writeSharedSiteConfig(config) {
  // RAM first: the public site must reflect the change immediately, even when
  // the Blob store is over quota or temporarily unavailable.
  const updatedAt = new Date().toISOString();
  writeSharedSiteConfigInMemory(config, updatedAt);
  if (!isBlobStorageConfigured()) return updatedAt;

  const body = JSON.stringify({ version: 1, updatedAt, config });
  try {
    await sharedBlobStore.put(CONFIG_BLOB_PATH, body, {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      contentType: "application/json; charset=utf-8",
    });
  } catch (error) {
    console.warn("[site-config] Blob write skipped (quota or network)", {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
  }

  return updatedAt;
}
