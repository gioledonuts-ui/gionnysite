import fs from "node:fs";
import path from "node:path";
import { makeDefaultSiteConfig, readStoredSiteConfig } from "./site-config.mjs";
import {
  flushStateToSupabase,
  isSupabaseConfigured,
  loadStateFromSupabase,
  markRemoteDirty,
} from "./supabase-state.mjs";

// ---------------------------------------------------------------------------
// Autonomous storage: RAM + /tmp snapshot
// ---------------------------------------------------------------------------
// Vercel Blob is no longer used at all (the free tier is exhausted and every
// call was failing, which blocked login).
//
// Source de vérité durable : Supabase `public.qg_app_state` (ligne `main`).
// Chaque instance lit la ligne une fois au démarrage, sert ensuite toutes ses
// requêtes depuis `globalThis.__qgState` (RAM, donc instantané), puis renvoie
// l'état complet à Supabase après chaque mutation. Le fichier `/tmp` reste un
// simple cache local, utile en développement et quand Supabase est configuré
// plus tard : rien ne dépend de lui pour la durabilité.
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
// Marqueur d'instance : la ligne Supabase a déjà été lue et appliquée.
const HYDRATED_KEY = Symbol.for("qg.state.hydrated.v1");

export const CONFIG_BLOB_PATH = "gionny/site-config.json";
// Small, dedicated snapshot of the admin configuration (planning, social
// links, member roles). `/tmp` dies on a cold start, so this file is the safety
// net that keeps Gionny's settings alive - together with the browser copy.
const ADMIN_STATE_FILE = process.env.QG_ADMIN_STATE_FILE || "/tmp/qg-admin-state.json";
const ADMIN_REPLICA_PREFIXES = [
  "gionny/visitor-accounts/",
  "gionny/visitor-host.json",
  "gionny/visitor-sessions/",
  "gionny/profiles/",
  "gionny/followers/",
  "gionny/posts/",
  "gionny/reports/",
  "gionny/notifications/",
  "gionny/site-config.json",
];

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

/** Vrai quand l'état RAM ne contient encore rien du tout. */
function isEmptyState(state) {
  return (
    !state ||
    typeof state !== "object" ||
    !state.blobs ||
    (Object.keys(state.blobs).length === 0 && !state.siteConfig)
  );
}

/**
 * Installe un état venu de Supabase dans `globalThis.__qgState`. Ne fait rien
 * si l'instance a déjà reçu des mutations entre-temps : une réponse HTTP lente
 * ne doit jamais écraser une création de compte qui vient d'avoir lieu.
 */
function hydrateState(data) {
  if (!data || typeof data !== "object" || !data.blobs || typeof data.blobs !== "object") return false;
  const current = globalThis[GLOBAL_STATE_KEY];
  if (current && !isEmptyState(current)) return false;
  globalThis[GLOBAL_STATE_KEY] = {
    version: STATE_VERSION,
    savedAt: Number(data.savedAt) || 0,
    blobs: { ...data.blobs },
    siteConfig: data.siteConfig && typeof data.siteConfig === "object" ? data.siteConfig : null,
  };
  try {
    flushLocalSnapshot();
  } catch {
    // Le cache local est optionnel.
  }
  return true;
}

/** Sérialise l'état courant pour Supabase (`blobs` + `siteConfig`). */
export function serializeState() {
  const state = readState();
  return {
    version: STATE_VERSION,
    savedAt: Date.now(),
    blobs: state.blobs,
    siteConfig: state.siteConfig,
  };
}

/** Envoie l'état courant vers Supabase (no-op s'il n'y a rien de neuf). */
export function syncStateToSupabase() {
  return flushStateToSupabase(serializeState);
}

let hydratePromise = null;

/**
 * Charge la ligne Supabase une seule fois par instance, et seulement si l'état
 * RAM est encore vide. Toute route `/api/*` appelle ceci en tout premier : la
 * requête du visiteur déclenche le chargement et attend son résultat.
 */
export function ensureStateLoaded() {
  if (!isEmptyState(globalThis[GLOBAL_STATE_KEY]) && globalThis[HYDRATED_KEY] === true) {
    return Promise.resolve({ loaded: false, reason: "fresh_state" });
  }
  if (!isSupabaseConfigured()) {
    // Sans Supabase, on garde le comportement local (fichier /tmp + RAM).
    return Promise.resolve({ loaded: false, reason: "not_configured" });
  }
  if (hydratePromise) return hydratePromise;
  hydratePromise = loadStateFromSupabase(hydrateState)
    .then((result) => {
      if (result.loaded) globalThis[HYDRATED_KEY] = true;
      return result;
    })
    .catch(() => ({ loaded: false, reason: "error" }))
    .finally(() => {
      hydratePromise = null;
    });
  return hydratePromise;
}

/**
 * The single source of truth of this instance. Loading is synchronous and
 * wrapped: a cold start reads the snapshot once, anything unreadable means an
 * empty state (never a crash).
 */
/**
 * Read-only merge of the dedicated admin snapshot. It only ever fills what is
 * missing, so a live configuration is never overwritten.
 */
function applyAdminSnapshot(state) {
  if (!state || typeof state !== "object" || !state.blobs) return state;
  const mirrored = readAdminSnapshotFile();
  if (!mirrored) return state;
  if (!state.siteConfig && mirrored.siteConfig && typeof mirrored.siteConfig === "object") {
    state.siteConfig = mirrored.siteConfig;
  }
  for (const [key, value] of Object.entries(mirrored.members || {})) {
    if (!state.blobs[key] && value && typeof value === "object") state.blobs[key] = value;
  }
  return state;
}

/**
 * À appeler après CHAQUE mutation : écrit le cache local puis marque l'état
 * comme « à pousser » vers Supabase. La route appelante déclenche ensuite
 * `syncStateToSupabase()` (await) pour être certaine que la donnée est durable
 * avant de répondre au navigateur.
 */
export function flushState() {
  markRemoteDirty();
  return flushLocalSnapshot();
}

export function readState() {
  const existing = globalThis[GLOBAL_STATE_KEY];
  if (existing && typeof existing === "object" && existing.blobs) return applyAdminSnapshot(existing);

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
    // The admin configuration also lives in its own small snapshot: the main
    // one can be missing or oversized, and a restart must never reset the
    // planning.
    applyAdminSnapshot(state);
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
/**
 * Cache local (`/tmp`) uniquement : jamais bloquant, jamais autoritaire.
 */
export function flushLocalSnapshot() {
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
  const replica = snapshotAdminState();
  if (replica) await writeAdminStateReplica(replica).catch(() => {});
  return updatedAt;
}

// ---------------------------------------------------------------------------
// Point 5 - the admin configuration survives a restart
// ---------------------------------------------------------------------------
// `/tmp/qg-state.json` can be lost (cold start, oversized snapshot, corrupted
// write). The admin configuration - planning, social links, member roles - is
// therefore mirrored in its own small file, and the browser keeps a copy too
// (see `gestion-qg/admin.js` and `script.js`).

export function snapshotAdminState() {
  const state = readState();
  const members = {};
  for (const [key, value] of Object.entries(state.blobs || {})) {
    if (!value || typeof value !== "object") continue;
    if (!ADMIN_REPLICA_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    members[key] = value;
  }
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    siteConfig: state.siteConfig,
    members,
  };
}

export async function writeAdminStateReplica(replica) {
  if (!replica || typeof replica !== "object") return false;
  try {
    const serialized = JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      siteConfig: replica.siteConfig || null,
      members: replica.members && typeof replica.members === "object" ? replica.members : {},
    });
    if (serialized.length > MAX_SNAPSHOT_BYTES) return false;
    fs.mkdirSync(path.dirname(ADMIN_STATE_FILE), { recursive: true });
    fs.writeFileSync(ADMIN_STATE_FILE, serialized, "utf8");
    return true;
  } catch (error) {
    warn("admin replica write skipped", error);
    return false;
  }
}

function readAdminSnapshotFile() {
  try {
    if (!fs.existsSync(ADMIN_STATE_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(ADMIN_STATE_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    warn("admin replica read skipped", error);
    return null;
  }
}

/**
 * Restores the mirrored admin state, but never overwrites something that is
 * already there: an empty state gets the mirror, a live one keeps its data.
 */
export async function restoreAdminStateReplica() {
  const state = readState();
  const emptyConfig = !state.siteConfig;
  if (!emptyConfig) return { restored: false, reason: "fresh_state" };

  const replica = readAdminSnapshotFile();
  if (!replica) return { restored: false, reason: "no_replica" };

  let restoredMembers = 0;
  const members = replica.members && typeof replica.members === "object" ? replica.members : {};
  for (const [key, value] of Object.entries(members)) {
    if (state.blobs[key] || !value || typeof value !== "object") continue;
    state.blobs[key] = value;
    restoredMembers += 1;
  }
  if (replica.siteConfig && typeof replica.siteConfig === "object") {
    state.siteConfig = replica.siteConfig;
  }
  if (restoredMembers > 0 || state.siteConfig) flushState();
  return {
    restored: true,
    restoredMembers,
    updatedAt: typeof replica.siteConfig?.updatedAt === "string" ? replica.siteConfig.updatedAt : null,
  };
}

/**
 * Accepts a config coming from a browser (`localStorage`) and writes it back.
 * The payload is validated by the caller before reaching this point.
 */
export async function restoreSharedSiteConfig(config) {
  const updatedAt = new Date().toISOString();
  writeSharedSiteConfigInMemory(config, updatedAt);
  flushState();
  await writeAdminStateReplica(snapshotAdminState()).catch(() => {});
  return updatedAt;
}

/** Test / admin helper: forget everything and start from a blank state. */
export function resetState({ keepAdminSnapshot = true } = {}) {
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
  if (!keepAdminSnapshot) resetAdminStateReplica();
}

/**
 * Test helper: forget the admin mirror too, as a brand new instance would.
 * `resetState()` keeps it on purpose, because that is exactly what must survive
 * a restart (planning, social links, member roles).
 */
export function resetAdminStateReplica() {
  try {
    fs.rmSync(ADMIN_STATE_FILE, { force: true });
  } catch {
    // ignore
  }
}
