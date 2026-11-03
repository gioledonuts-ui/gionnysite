import fs from "node:fs";
import path from "node:path";
import { makeDefaultSiteConfig, readStoredSiteConfig } from "./site-config.mjs";

// ---------------------------------------------------------------------------
// Autonomous storage: RAM + /tmp snapshot
// ---------------------------------------------------------------------------
// Vercel Blob is no longer used at all (the free tier is exhausted and every
// call was failing, which blocked login). Everything now lives in
// `globalThis.__qgState` and is persisted to `/tmp/qg-state.json` with plain
// synchronous fs calls wrapped in try/catch: a read-only filesystem can never
// break an API route, it only loses the snapshot.
//
// The store keeps the same tiny surface the rest of the app already uses
// (`get`, `put`, `list`, `del`) so every existing feature - accounts,
// sessions, conversations, messages, voice notes, images, site config - keeps
// working without touching Blob again.

const STATE_FILE = process.env.QG_STATE_FILE || "/tmp/qg-state.json";
const STATE_VERSION = 1;
// Snapshots are capped so a runaway attachment cannot fill the instance disk.
const MAX_SNAPSHOT_BYTES = 24 * 1024 * 1024;
const GLOBAL_STATE_KEY = "__qgState";
const BLOB_KEY = "__qgBlobs";

export const CONFIG_BLOB_PATH = "gionny/site-config.json";

/** True while the autonomous store is in charge (always, now). */
export function isBlobStorageConfigured() {
  return true;
}

function emptyState() {
  return {
    version: STATE_VERSION,
    savedAt: 0,
    blobs: {},
    siteConfig: null,
  };
}

/**
 * The single source of truth of this instance. Loading is synchronous and
 * wrapped: a cold start reads the snapshot once, anything unreadable means an
 * empty state (never a crash).
 */
export function readState() {
  const existing = globalThis[GLOBAL_STATE_KEY];
  if (existing && typeof existing === "object" && existing.blobs) return existing;

  let state = emptyState();
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.blobs && typeof parsed.blobs === "object") {
        state = {
          version: STATE_VERSION,
          savedAt: Number(parsed.savedAt) || 0,
          blobs: parsed.blobs,
          siteConfig: parsed.siteConfig && typeof parsed.siteConfig === "object" ? parsed.siteConfig : null,
        };
      }
    }
  } catch (error) {
    warn("snapshot read skipped", error);
  }

  globalThis[GLOBAL_STATE_KEY] = state;
  return state;
}

function warn(label, error) {
  try {
    console.warn(`[qg-state] ${label}`, {
      name: error instanceof Error ? error.name : "UnknownError",
      code: typeof error?.code === "string" ? error.code : undefined,
    });
  } catch {
    // console itself must never throw.
  }
}

/**
 * Writes the snapshot. Synchronous on purpose: it happens once per mutation,
 * it is a few kilobytes of JSON, and it keeps the code simple. Failure is
 * silent (read-only fs, quota, /tmp missing).
 */
export function flushState() {
  const state = readState();
  try {
    const serialized = JSON.stringify({
      version: STATE_VERSION,
      savedAt: Date.now(),
      blobs: state.blobs,
      siteConfig: state.siteConfig,
    });
    if (serialized.length > MAX_SNAPSHOT_BYTES) {
      warn("snapshot too large, skipping write", new Error("snapshot-too-large"));
      return false;
    }
    state.savedAt = Date.now();
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, serialized, "utf8");
    return true;
  } catch (error) {
    warn("snapshot write skipped", error);
    return false;
  }
}

function toBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body === null || body === undefined) return Buffer.from("", "utf8");
  return Buffer.from(String(body), "utf8");
}

function toBytes(value) {
  if (!value) return Buffer.alloc(0);
  try {
    return Buffer.from(value, "base64");
  } catch {
    return Buffer.alloc(0);
  }
}

function warnDeprecatedBlobCall(operation) {
  try {
    console.warn(`[qg-state] @vercel/blob ${operation}() is disabled, using the local store`);
  } catch {
    // ignore
  }
}

/**
 * Blob-compatible façade over the in-RAM state. `get`/`put`/`list`/`del`
 * match the signatures already used across the project.
 */
export const sharedBlobStore = Object.freeze({
  async put(pathname, body, options = {}) {
    const key = String(pathname || "");
    if (!key) throw new Error("Missing pathname");
    const state = readState();
    const buffer = toBuffer(body);
    const base64 = buffer.toString("base64");
    if (base64.length > MAX_SNAPSHOT_BYTES) throw new Error("BLOB_TOO_LARGE");
    // `allowOverwrite: false` still returns success: a duplicate write must
    // never surface as an account-creation failure to a visitor.
    const createdAt = Date.now();
    const previous = state.blobs[key];
    state.blobs[key] = {
      base64,
      contentType: options?.contentType || "application/octet-stream",
      size: buffer.length,
      createdAt: previous?.createdAt && options?.allowOverwrite === false ? previous.createdAt : createdAt,
    };
    flushState();
    return {
      pathname: key,
      contentType: state.blobs[key].contentType,
      size: buffer.length,
      url: `local://${key}`,
    };
  },

  async get(pathname) {
    const state = readState();
    const entry = state.blobs[String(pathname || "")];
    if (!entry) return null;
    const buffer = toBytes(entry.base64);
    return {
      statusCode: 200,
      stream: new Response(buffer).body,
      blob: { pathname, contentType: entry.contentType, size: entry.size, url: `local://${pathname}` },
    };
  },

  async head(pathname) {
    const state = readState();
    const entry = state.blobs[String(pathname || "")];
    if (!entry) return null;
    return {
      pathname,
      contentType: entry.contentType,
      size: entry.size,
      url: `local://${pathname}`,
    };
  },

  async list({ prefix = "", limit = 1000, cursor } = {}) {
    const state = readState();
    const keys = Object.keys(state.blobs)
      .filter((key) => key.startsWith(String(prefix || "")))
      .sort();
    const start = cursor ? Math.max(0, Number(cursor) || 0) : 0;
    const end = Math.min(keys.length, start + Math.max(1, Number(limit) || 1000));
    const hasMore = end < keys.length;
    return {
      blobs: keys.slice(start, end).map((pathname) => ({
        pathname,
        url: `local://${pathname}`,
        size: state.blobs[pathname]?.size || 0,
      })),
      hasMore,
      cursor: hasMore ? String(end) : null,
    };
  },

  async del(paths) {
    const state = readState();
    for (const pathname of Array.isArray(paths) ? paths : [paths]) {
      delete state.blobs[String(pathname || "")];
    }
    flushState();
  },

  // Kept so an accidental old import cannot crash a route: it only logs.
  copy(fromPathname, toPathname) {
    warnDeprecatedBlobCall("copy");
    const state = readState();
    const entry = state.blobs[String(fromPathname || "")];
    if (!entry) return null;
    state.blobs[String(toPathname || "")] = { ...entry, createdAt: Date.now() };
    flushState();
    return { pathname: toPathname };
  },
});

export { GLOBAL_STATE_KEY as QG_STATE_GLOBAL_KEY, STATE_FILE as QG_STATE_FILE, BLOB_KEY };

// ---------------------------------------------------------------------------
// Site config (public settings) on top of the same state
// ---------------------------------------------------------------------------
export async function readSharedSiteConfig() {
  const state = readState();
  const stored = state.siteConfig;
  const config = stored?.config ? readStoredSiteConfig(stored) : makeDefaultSiteConfig();
  return {
    config,
    storageConfigured: true,
    updatedAt: typeof stored?.updatedAt === "string" ? stored.updatedAt : null,
  };
}

export function writeSharedSiteConfigInMemory(config, updatedAt = new Date().toISOString()) {
  const state = readState();
  state.siteConfig = { config: readStoredSiteConfig({ config, updatedAt }), updatedAt };
  return {
    config: state.siteConfig.config,
    storageConfigured: true,
    updatedAt,
  };
}

export async function writeSharedSiteConfig(config) {
  const updatedAt = new Date().toISOString();
  writeSharedSiteConfigInMemory(config, updatedAt);
  flushState();
  return updatedAt;
}

/** Test / admin helper: forget everything and start from a blank state. */
export function resetState() {
  globalThis[GLOBAL_STATE_KEY] = emptyState();
  // The inbox keeps small RAM mirrors (accounts, threads) next to the snapshot:
  // a wipe must clear them too, otherwise a "cold start" would still answer
  // from memory.
  for (const key of ["gionny.contact-inbox.state.v1", "gionny.contact-inbox.host.v1"]) {
    try {
      delete globalThis[Symbol.for(key)];
    } catch {
      // ignore
    }
  }
  try {
    fs.rmSync(STATE_FILE, { force: true });
  } catch {
    // ignore
  }
}
