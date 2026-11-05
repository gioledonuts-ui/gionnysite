// ---------------------------------------------------------------------------
// Persistance définitive : Supabase `public.qg_app_state`
// ---------------------------------------------------------------------------
// Une seule ligne (`id = 'main'`) contient tout l'état du site :
//   { id: 'main', data: { version, savedAt, blobs, siteConfig }, updated_at }
// où `blobs` porte les comptes, rôles, conversations, messages, vocaux et
// images, et `siteConfig` le planning / les liens / « À la une ».
//
// Rien à installer : on parle directement à l'API REST PostgREST de Supabase
// avec `fetch`. La clé `service_role` reste côté serveur (jamais envoyée au
// navigateur).
//
// Cycle de vie :
//  • au premier accès d'une instance, `loadStateFromSupabase()` lit la ligne
//    `main` et l'installe dans `globalThis.__qgState` ;
//  • toutes les lectures se font ensuite en RAM (instantané) ;
//  • chaque mutation déclenche un `upsert` (`Prefer: resolution=merge-duplicates`).
// Un redémarrage du serveur ne perd donc plus aucun compte, rôle, planning ni
// message.

const TABLE = "/rest/v1/qg_app_state";
const ROW_ID = "main";
const LOADED_FLAG = Symbol.for("qg.supabase.loaded.v1");
const LOADING_PROMISE = Symbol.for("qg.supabase.loading.v1");
const SAVE_PROMISE = Symbol.for("qg.supabase.saving.v1");
const DIRTY_FLAG = Symbol.for("qg.supabase.dirty.v1");
const MAX_TIMEOUT_MS = 8_000;

function readEnv() {
  const rawUrl = typeof process?.env?.NEXT_PUBLIC_SUPABASE_URL === "string"
    ? process.env.NEXT_PUBLIC_SUPABASE_URL.trim()
    : "";
  const url = rawUrl.replace(/\/+$/u, "");
  const key = (
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    ""
  ).trim();
  return { url, key };
}

/** Vrai dès que l'URL et une clé sont présentes : sinon on reste en local. */
export function isSupabaseConfigured() {
  const { url, key } = readEnv();
  return Boolean(url && key && /^https:\/\//u.test(url));
}

function headers(extra = {}) {
  const { key } = readEnv();
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function request(path, options = {}) {
  const { url } = readEnv();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_TIMEOUT_MS);
  try {
    const response = await fetch(`${url}${TABLE}${path}`, {
      ...options,
      headers: headers(options.headers),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: error instanceof Error ? error.name : "UnknownError",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Garde-fou : on ne pousse jamais un état vide par-dessus un état vivant. */
function isUsableData(data) {
  return Boolean(
    data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      data.blobs &&
      typeof data.blobs === "object" &&
      !Array.isArray(data.blobs)
  );
}

function markLoaded() {
  globalThis[LOADED_FLAG] = true;
}

export function isStateLoadedFromSupabase() {
  return globalThis[LOADED_FLAG] === true;
}

/**
 * Lit la ligne `main`. `apply(data)` installe les données dans l'état RAM.
 * Renvoie `{ loaded, reason, updatedAt }` et ne jette jamais : si Supabase est
 * injoignable, on continue avec l'état local (le site reste debout).
 */
async function loadStateInto(apply) {
  if (!isSupabaseConfigured()) {
    markLoaded();
    return { loaded: false, reason: "not_configured", updatedAt: null };
  }

  const result = await request(`?id=eq.${ROW_ID}&select=data,updated_at`, { method: "GET" });
  if (!result.ok) {
    // On ne marque pas comme chargé : la prochaine requête retentera plutôt que
    // de figer une instance sur un état vide.
    return { loaded: false, reason: `http_${result.status}`, updatedAt: null };
  }

  const row = Array.isArray(result.body) ? result.body[0] : result.body;
  if (!row || !isUsableData(row.data)) {
    markLoaded();
    return { loaded: false, reason: "empty_row", updatedAt: null };
  }

  apply(row.data);
  markLoaded();
  return {
    loaded: true,
    reason: "ok",
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
  };
}

/**
 * Charge une seule fois par instance. Un échec réseau n'est pas mémorisé : la
 * requête suivante retentera, sans jamais bloquer la réponse.
 */
export function loadStateFromSupabase(apply) {
  if (globalThis[LOADED_FLAG] === true) {
    return Promise.resolve({ loaded: false, reason: "already_loaded", updatedAt: null });
  }
  const pending = globalThis[LOADING_PROMISE];
  if (pending) return pending;
  const promise = loadStateInto(apply)
    .catch(() => ({ loaded: false, reason: "error", updatedAt: null }))
    .finally(() => {
      globalThis[LOADING_PROMISE] = null;
    });
  globalThis[LOADING_PROMISE] = promise;
  return promise;
}

/**
 * Upsert de la ligne `main`. `resolution=merge-duplicates` met à jour la ligne
 * existante au lieu d'échouer sur la contrainte de clé primaire.
 */
export async function saveStateToSupabase(data) {
  if (!isSupabaseConfigured()) return { saved: false, reason: "not_configured" };
  if (!isUsableData(data)) return { saved: false, reason: "invalid_data" };

  const result = await request("?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([
      {
        id: ROW_ID,
        data,
        updated_at: new Date().toISOString(),
      },
    ]),
  });

  if (!result.ok) {
    return { saved: false, reason: `http_${result.status}`, status: result.status };
  }
  return { saved: true };
}

export function markRemoteDirty() {
  globalThis[DIRTY_FLAG] = true;
}

export function isRemoteDirty() {
  return globalThis[DIRTY_FLAG] === true;
}

/**
 * Envoie l'état courant si quelque chose a changé. Les appels concurrents
 * partagent la même promesse : une rafale de messages ne produit qu'un envoi.
 * Après un envoi, si une mutation est arrivée entre-temps, on renvoie une fois
 * de plus : la dernière version gagne toujours.
 */
export function flushStateToSupabase(readData) {
  if (!isRemoteDirty()) return Promise.resolve({ saved: false, reason: "clean" });
  const pending = globalThis[SAVE_PROMISE];
  if (pending) return pending;

  const promise = (async () => {
    // Deux passes maximum : la seconde rattrape ce qui est arrivé pendant le POST.
    let last = { saved: false, reason: "clean" };
    for (let pass = 0; pass < 2; pass += 1) {
      globalThis[DIRTY_FLAG] = false;
      let data;
      try {
        data = readData();
      } catch {
        return { saved: false, reason: "read_failed" };
      }
      last = await saveStateToSupabase(data);
      // Un envoi qui échoue laisse l'état « à pousser » : la prochaine requête
      // (ou la prochaine mutation) retentera, sans jamais perdre la donnée.
      if (!last.saved) globalThis[DIRTY_FLAG] = true;
      if (!last.saved || !isRemoteDirty()) break;
    }
    return last;
  })()
    .catch(() => ({ saved: false, reason: "error" }))
    .finally(() => {
      globalThis[SAVE_PROMISE] = null;
    });

  globalThis[SAVE_PROMISE] = promise;
  return promise;
}

/** Tests : remet les drapeaux à zéro comme sur une instance fraîche. */
export function resetSupabaseStateFlags() {
  globalThis[LOADED_FLAG] = false;
  globalThis[LOADING_PROMISE] = null;
  globalThis[SAVE_PROMISE] = null;
  globalThis[DIRTY_FLAG] = false;
}
