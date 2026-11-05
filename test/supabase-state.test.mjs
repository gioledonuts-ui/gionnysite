import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Une fausse API REST Supabase, en mémoire, branchée sur `fetch`.
// ---------------------------------------------------------------------------
// Les variables d'environnement doivent exister avant le chargement des
// modules (elles sont lues à l'import), et le cache local est pointé vers un
// fichier jetable pour qu'un `/tmp` réel ne masque pas le comportement.

const SUPABASE_URL = "https://qg-test.supabase.co";
const SERVICE_KEY = "service-role-test-key";
const STATE_FILE = path.join(os.tmpdir(), `qg-state-supabase-${process.pid}.json`);
const ADMIN_STATE_FILE = path.join(os.tmpdir(), `qg-admin-supabase-${process.pid}.json`);

process.env.QG_STATE_FILE = STATE_FILE;
process.env.QG_ADMIN_STATE_FILE = ADMIN_STATE_FILE;
process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;

const calls = [];
/** Contenu de `public.qg_app_state`, indexé par `id`. */
const table = new Map();
let failNextRequest = false;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = (init.method || "GET").toUpperCase();
  calls.push({ url: url.pathname + url.search, method, headers: init.headers || {}, body: init.body });

  if (failNextRequest) {
    failNextRequest = false;
    throw new TypeError("network down");
  }

  const expected = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` };
  for (const [key, value] of Object.entries(expected)) {
    if (init.headers?.[key] !== value) {
      return new Response(JSON.stringify({ message: `bad ${key}` }), { status: 401 });
    }
  }

  if (url.pathname !== "/rest/v1/qg_app_state") {
    return new Response("not found", { status: 404 });
  }

  if (method === "GET") {
    const id = url.searchParams.get("id")?.replace(/^eq\./u, "");
    const row = table.get(id);
    return new Response(JSON.stringify(row ? [row] : []), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (method === "POST") {
    const rows = JSON.parse(String(init.body));
    for (const row of rows) table.set(row.id, { data: row.data, updated_at: row.updated_at });
    return new Response(null, { status: 201 });
  }

  return new Response("method not allowed", { status: 405 });
};

const store = await import("../lib/blob-store.mjs");
const supabase = await import("../lib/supabase-state.mjs");
const inbox = await import("../lib/contact-inbox.mjs");

function forgetInstance({ keepSupabase = true } = {}) {
  // Un « redémarrage » : RAM et cache local disparaissent, Supabase reste.
  delete globalThis.__qgState;
  for (const key of ["gionny.contact-inbox.state.v1", "gionny.contact-inbox.host.v1"]) {
    delete globalThis[Symbol.for(key)];
  }
  for (const file of [STATE_FILE, ADMIN_STATE_FILE]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
  supabase.resetSupabaseStateFlags();
  if (!keepSupabase) table.clear();
  calls.length = 0;
}

test.after(() => {
  for (const file of [STATE_FILE, ADMIN_STATE_FILE]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
});

test("la lecture remplit globalThis.__qgState depuis la ligne « main »", async () => {
  forgetInstance({ keepSupabase: false });
  table.set("main", {
    data: {
      version: 1,
      savedAt: 1,
      blobs: {
        "gionny/visitor-accounts/demo.json": {
          base64: Buffer.from(JSON.stringify({ pseudo: "Demo" }), "utf8").toString("base64"),
          contentType: "application/json",
          size: 20,
        },
      },
      siteConfig: { config: { version: 1 }, updatedAt: "2026-01-01T00:00:00.000Z" },
    },
    updated_at: "2026-01-01T00:00:00.000Z",
  });

  assert.deepEqual(globalThis.__qgState, undefined);
  const result = await store.ensureStateLoaded();
  assert.equal(result.loaded, true);
  assert.equal(result.reason, "ok");

  const state = store.readState();
  assert.ok(state.blobs["gionny/visitor-accounts/demo.json"]);
  assert.equal(state.siteConfig.updatedAt, "2026-01-01T00:00:00.000Z");

  const getCall = calls.find((call) => call.method === "GET");
  assert.equal(getCall.url, "/rest/v1/qg_app_state?id=eq.main&select=data,updated_at");
  assert.equal(getCall.headers.apikey, SERVICE_KEY);
  assert.equal(getCall.headers.Authorization, `Bearer ${SERVICE_KEY}`);

  // Une seconde requête ne relit pas Supabase : tout vient de la RAM.
  calls.length = 0;
  await store.ensureStateLoaded();
  assert.equal(calls.length, 0);
});

test("une mutation est poussée en upsert (merge-duplicates) sur qg_app_state", async () => {
  forgetInstance();
  await store.ensureStateLoaded();
  calls.length = 0;

  await store.sharedBlobStore.put("gionny/test/motd.json", JSON.stringify({ motd: "salut" }), {
    contentType: "application/json",
    allowOverwrite: true,
  });
  const result = await store.syncStateToSupabase();

  assert.equal(result.saved, true);
  const post = calls.find((call) => call.method === "POST");
  assert.equal(post.url, "/rest/v1/qg_app_state?on_conflict=id");
  assert.equal(post.headers.Prefer, "resolution=merge-duplicates,return=minimal");
  const [row] = JSON.parse(String(post.body));
  assert.equal(row.id, "main");
  assert.ok(row.data.blobs["gionny/test/motd.json"]);
  assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T/u);

  // Rien de neuf → aucun envoi superflu.
  calls.length = 0;
  const idle = await store.syncStateToSupabase();
  assert.equal(idle.saved, false);
  assert.equal(calls.length, 0);
});

test("un compte et son message survivent à un redémarrage complet du serveur", async () => {
  forgetInstance({ keepSupabase: false });
  await store.ensureStateLoaded();

  const created = await inbox.registerVisitorAccount({ pseudo: "Survivant", password: "motdepasse" });
  assert.equal(created.ok, true);
  await inbox.addAccountReply(created.sessionToken, { message: "Message durable" });
  const pushed = await store.syncStateToSupabase();
  assert.equal(pushed.saved, true);
  assert.ok(table.get("main").data.blobs);

  // Redémarrage : plus de RAM, plus de /tmp, plus de cache — seulement Supabase.
  forgetInstance();
  const hydrated = await store.ensureStateLoaded();
  assert.equal(hydrated.loaded, true);

  const login = await inbox.loginVisitorAccount({ pseudo: "Survivant", password: "motdepasse" });
  assert.equal(login.ok, true);
  const conversation = await inbox.getAccountConversation(login.sessionToken);
  assert.equal(conversation.messages.length, 1);
  assert.equal(conversation.messages[0].text, "Message durable");
});

test("le planning survit aussi : la config et les rôles reviennent de Supabase", async () => {
  forgetInstance({ keepSupabase: false });
  await store.ensureStateLoaded();

  const config = {
    version: 1,
    socials: {
      twitch: "https://www.twitch.tv/7gionny",
      tiktok: "https://www.tiktok.com/@gio_nny",
      youtube: "https://www.youtube.com/@gionnyyy",
      x: "https://x.com/nny_gio",
      instagram: "https://www.instagram.com/nny_gio/",
      discord: "https://discord.gg/nPACfBTnPx",
    },
    socialInfo: { twitch: "Le direct", tiktok: "", youtube: "", x: "", instagram: "" },
    schedule: {
      monday: { enabled: false, time: "22:00" },
      tuesday: { enabled: true, time: "21:30" },
      wednesday: { enabled: true, time: "22:00" },
      thursday: { enabled: false, time: "22:00" },
      friday: { enabled: false, time: "22:00" },
      saturday: { enabled: true, time: "22:00" },
      sunday: { enabled: true, time: "22:00" },
    },
  };
  await store.writeSharedSiteConfig(config);
  assert.equal((await store.syncStateToSupabase()).saved, true);

  forgetInstance();
  await store.ensureStateLoaded();
  const read = await store.readSharedSiteConfig();
  assert.equal(read.config.schedule.tuesday.time, "21:30");
  assert.equal(read.config.schedule.tuesday.enabled, true);
  assert.equal(read.config.socialInfo.twitch, "Le direct");
});

test("Supabase injoignable : le site répond quand même, puis rattrape", async () => {
  forgetInstance({ keepSupabase: false });
  await store.ensureStateLoaded();
  await store.sharedBlobStore.put("gionny/test/resilience.json", "{}", { contentType: "application/json" });
  assert.equal((await store.syncStateToSupabase()).saved, true);

  // Panne réseau passagère pendant un envoi : on ne jette pas, on retentera.
  await store.sharedBlobStore.put("gionny/test/offline.json", "{}", { contentType: "application/json" });
  // La mutation précédente a déjà été poussée : on vérifie explicitement que
  // l'état est marqué « à envoyer » avant de simuler la panne.
  assert.equal(supabase.isRemoteDirty(), true);
  failNextRequest = true;
  const failed = await store.syncStateToSupabase();
  assert.equal(failed.saved, false);
  assert.equal(supabase.isRemoteDirty(), true);

  const retried = await store.syncStateToSupabase();
  assert.equal(retried.saved, true);
  assert.ok(table.get("main").data.blobs["gionny/test/offline.json"]);
});

test("sans variables d'environnement, rien n'appelle le réseau", async () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  supabase.resetSupabaseStateFlags();
  calls.length = 0;
  try {
    assert.equal(supabase.isSupabaseConfigured(), false);
    assert.deepEqual(await supabase.saveStateToSupabase({ blobs: {} }), {
      saved: false,
      reason: "not_configured",
    });
    assert.equal(calls.length, 0);
  } finally {
    process.env.NEXT_PUBLIC_SUPABASE_URL = url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = key;
    supabase.resetSupabaseStateFlags();
  }
});

test("on ne pousse jamais un état vide par-dessus la base", async () => {
  assert.deepEqual(await supabase.saveStateToSupabase({}), { saved: false, reason: "invalid_data" });
  assert.deepEqual(await supabase.saveStateToSupabase({ blobs: [] }), {
    saved: false,
    reason: "invalid_data",
  });
});
