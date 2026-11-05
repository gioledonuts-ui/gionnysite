import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Le store autonome doit pointer sur un fichier jetable AVANT le chargement du
// graphe de modules (le chemin est lu à l'import).
const STATE_FILE = path.join(os.tmpdir(), `qg-settings-state-${process.pid}.json`);
const ADMIN_STATE_FILE = path.join(os.tmpdir(), `qg-settings-admin-${process.pid}.json`);
process.env.QG_STATE_FILE = STATE_FILE;
process.env.QG_ADMIN_STATE_FILE = ADMIN_STATE_FILE;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_STORE_ID;
// Aucune clé OAuth : on doit rester en mode « ID + pseudo » fonctionnel.
delete process.env.DISCORD_CLIENT_ID;
delete process.env.DISCORD_CLIENT_SECRET;

const store = await import("../lib/blob-store.mjs");
const inbox = await import("../lib/contact-inbox.mjs");
const graph = await import("../lib/social-graph.mjs");
const settings = await import("../lib/discord-link.mjs");

const ORIGIN = "https://qg.test";
const headers = { host: "qg.test", origin: ORIGIN };
const accountCookie = (token) => `gionny_account_session=${token}`;

const makeResponse = () => {
  const state = { status: 200, body: undefined, headers: {}, redirect: "" };
  const response = {
    setHeader(name, value) {
      const key = String(name).toLowerCase();
      state.headers[key] = value;
      if (key === "location") state.redirect = String(value);
    },
    status(code) {
      state.status = code;
      return response;
    },
    json(value) {
      state.body = value;
      return { status: state.status, body: state.body, headers: state.headers, redirect: state.redirect };
    },
    send(value) {
      state.body = value;
      return { status: state.status, body: state.body, headers: state.headers, redirect: state.redirect };
    },
    end() {
      return { status: state.status, body: state.body, headers: state.headers, redirect: state.redirect };
    },
    get result() {
      return state;
    },
  };
  return response;
};

const callSettings = async ({ method = "GET", query = {}, body, cookie, extraHeaders = {} } = {}) => {
  const request = {
    method,
    query,
    headers: { ...headers, ...(cookie ? { cookie } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body }),
  };
  const response = makeResponse();
  await settings.handleSettingsRequest(request, response);
  return response.result;
};

let host = null;
let member = null;
let memberCookie = "";
let otherCookie = "";

test.before(async () => {
  store.resetState();
  host = await inbox.registerVisitorAccount({ pseudo: "Gionny", password: "host-password-2026" });
  assert.equal(host.ok, true);
  // Rôle Hôte attribué en base (panneau /admin), jamais d'après le pseudo.
  const hostRecord = (await inbox.listVisitorAccounts("", undefined)).members
    .find((entry) => entry.pseudo === host.account.pseudo);
  assert.equal((await inbox.setVisitorAccountRole(hostRecord.id, "host", undefined)).ok, true);
  const fan = await inbox.registerVisitorAccount({ pseudo: "FanLie", password: "fan-password-2026" });
  assert.equal(fan.ok, true);
  member = fan;
  memberCookie = accountCookie(fan.sessionToken);
  const other = await inbox.registerVisitorAccount({ pseudo: "AutreFan", password: "autre-password-2026" });
  assert.equal(other.ok, true);
  otherCookie = accountCookie(other.sessionToken);
});

test.after(() => {
  for (const file of [STATE_FILE, ADMIN_STATE_FILE]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // ignore
    }
  }
});

test("un visiteur ne peut pas lire ni modifier les paramètres d'un compte", async () => {
  const read = await callSettings({});
  assert.equal(read.status, 200);
  assert.equal(read.body.viewer, null);
  assert.equal(read.body.oauth, false);
  assert.equal(read.body.mode, "code");

  const write = await callSettings({ method: "POST", body: { action: "privacy", isPrivate: true } });
  assert.equal(write.status, 401);
});

test("la liaison Discord enregistre l'ID traçable, le pseudo et la date", async () => {
  const linked = await callSettings({
    method: "POST",
    cookie: memberCookie,
    body: { action: "discord-link", discordId: "284759123456789012", discordUsername: "gionny_fan" },
  });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.ok, true);
  assert.equal(linked.body.discord.discordId, "284759123456789012");
  assert.equal(linked.body.discord.discordUsername, "gionny_fan");
  assert.ok(Number.isFinite(Date.parse(linked.body.discord.discordLinkedAt)));

  const read = await callSettings({ cookie: memberCookie });
  assert.equal(read.body.settings.discord.linked, true);
  assert.equal(read.body.settings.discord.discordId, "284759123456789012");

  // Le profil social porte aussi la liaison (pour le badge public).
  const profile = await graph.getPublicProfile("FanLie", { viewer: "FanLie" });
  assert.equal(profile.profile.discordUsername, "gionny_fan");
  assert.ok(Number.isFinite(Date.parse(profile.profile.discordLinkedAt)));
});

test("un discordId ne peut pas être lié à deux comptes du QG", async () => {
  const conflict = await callSettings({
    method: "POST",
    cookie: otherCookie,
    body: { action: "discord-link", discordId: "284759123456789012", discordUsername: "autre_pseudo" },
  });
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.error, /déjà lié/u);

  // Un ID invalide est refusé avant tout écriture.
  const invalid = await callSettings({
    method: "POST",
    cookie: otherCookie,
    body: { action: "discord-link", discordId: "12", discordUsername: "autre_pseudo" },
  });
  assert.equal(invalid.status, 400);
});

test("un compte banni ne peut pas lier de Discord", async () => {
  const rejected = await inbox.registerVisitorAccount({ pseudo: "BanniFan", password: "banni-password-2026" });
  assert.equal(rejected.ok, true);
  const { members } = await inbox.listVisitorAccounts("", undefined);
  const record = members.find((entry) => entry.pseudo === "BanniFan");
  await inbox.setVisitorAccountBanned(record.id, true);
  const cookie = accountCookie(rejected.sessionToken);
  const attempt = await callSettings({
    method: "POST",
    cookie,
    body: { action: "discord-link", discordId: "355555555555555555", discordUsername: "banni" },
  });
  // Un compte banni ne peut plus ouvrir de session : la liaison est refusée
  // avant toute écriture (401 côté route, 403 côté moteur de liaison).
  assert.equal([401, 403].includes(attempt.status), true);
  const direct = await inbox.linkDiscordAccount(rejected.sessionToken, {
    discordId: "355555555555555555",
    discordUsername: "banni",
  });
  assert.equal(direct.ok, false);
  assert.equal(direct.reason, "unauthorized");
});

test("la déliaison Discord retire l'ID et le pseudo du compte", async () => {
  const unlinked = await callSettings({ method: "POST", cookie: memberCookie, body: { action: "discord-unlink" } });
  assert.equal(unlinked.status, 200);
  const read = await callSettings({ cookie: memberCookie });
  assert.equal(read.body.settings.discord.linked, false);
  assert.equal(read.body.settings.discord.discordId, "");
});

test("confidentialité : un compte privé masque son activité aux non-abonnés", async () => {
  const hidden = await callSettings({ method: "POST", cookie: otherCookie, body: { action: "privacy", isPrivate: true } });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.body.isPrivate, true);

  // Un visiteur quelconque ne voit pas l'activité.
  const stranger = await graph.getPublicProfile("AutreFan", { viewer: "FanLie" });
  assert.equal(stranger.profile.isPrivate, true);
  assert.equal(stranger.profile.canSeeActivity, false);
  assert.match(stranger.profile.privateMessage, /Ce compte est privé/u);

  // FanLie suit AutreFan : l'activité redevient visible.
  await graph.setFollow({ pseudo: "FanLie", target: "AutreFan", follow: true });
  const follower = await graph.getPublicProfile("AutreFan", { viewer: "FanLie" });
  assert.equal(follower.profile.canSeeActivity, true);

  // L'Hôte voit toujours tout, et son propre compte reste public.
  const hostView = await graph.getPublicProfile("AutreFan", { viewer: "Gionny" });
  assert.equal(hostView.profile.canSeeActivity, true);
  const hostPrivate = await callSettings({
    method: "POST",
    cookie: accountCookie(host.sessionToken),
    body: { action: "privacy", isPrivate: true },
  });
  assert.equal(hostPrivate.status, 409);
});

test("le fil masque les comptes non-validés quand le filtre est actif", async () => {
  const simple = await inbox.registerVisitorAccount({ pseudo: "SimpleSansBadge", password: "simple-password-2026" });
  assert.equal(simple.ok, true);
  const { members } = await inbox.listVisitorAccounts("", undefined);
  const fan = members.find((entry) => entry.pseudo === "FanLie");
  await inbox.setVisitorAccountBadges(fan.id, ["verified"]);
  await inbox.setVisitorAccountBadges(members.find((entry) => entry.pseudo === "SimpleSansBadge").id, []);

  const hostPost = await graph.createPost({ pseudo: "Gionny", text: "Post officiel du QG" });
  assert.equal(hostPost.ok, true);
  const fanPost = await graph.createPost({ pseudo: "FanLie", text: "Post d'un membre Validé" });
  assert.equal(fanPost.ok, true);
  // Un membre publie tant qu'il est Validé, puis perd son badge : son post
  // reste dans le fil complet, mais disparaît du fil filtré.
  const simpleRecord = members.find((entry) => entry.pseudo === "SimpleSansBadge");
  await inbox.setVisitorAccountBadges(simpleRecord.id, ["verified"]);
  const simplePost = await graph.createPost({ pseudo: "SimpleSansBadge", text: "Post d'un membre simple" });
  assert.equal(simplePost.ok, true);
  await inbox.setVisitorAccountBadges(simpleRecord.id, []);

  const filtered = await graph.listFeed({ viewer: "", mode: "all", hideUnverified: true });
  const authors = filtered.map((post) => post.pseudo);
  assert.ok(authors.includes("Gionny"));
  assert.ok(authors.includes("FanLie"));
  assert.equal(authors.includes("SimpleSansBadge"), false);

  const everything = await graph.listFeed({ viewer: "", mode: "all", hideUnverified: false });
  assert.ok(everything.some((post) => post.pseudo === "SimpleSansBadge"));
});

test("les comptes bloqués sont listés puis débloqués", async () => {
  await graph.setBlock({ pseudo: "FanLie", target: "SimpleSansBadge", blocked: true });
  const blocked = await callSettings({ method: "POST", cookie: memberCookie, body: { action: "blocks" } });
  assert.equal(blocked.status, 200);
  assert.deepEqual(blocked.body.blockedUsers, ["SimpleSansBadge"]);

  await graph.setBlock({ pseudo: "FanLie", target: "SimpleSansBadge", blocked: false });
  const after = await callSettings({ cookie: memberCookie });
  assert.deepEqual(after.body.settings.blockedUsers, []);
});

test("le mot de passe se change depuis les paramètres et sert à se reconnecter", async () => {
  const changed = await inbox.updateVisitorAccountProfile(member.sessionToken, {
    currentPassword: "fan-password-2026",
    newPassword: "nouveau-password-2026",
  });
  assert.equal(changed.ok, true);

  const old = await inbox.loginVisitorAccount({ pseudo: "FanLie", password: "fan-password-2026" });
  assert.equal(old.ok, false);
  const fresh = await inbox.loginVisitorAccount({ pseudo: "FanLie", password: "nouveau-password-2026" });
  assert.equal(fresh.ok, true);
});

test("les routes OAuth2 Discord existent et échouent proprement sans clés", async () => {
  // Démarrage OAuth sans client_id : on ne casse rien, on signale le mode.
  const start = await callSettings({ query: { oauth: "start" } });
  assert.equal(start.status, 302);
  assert.match(start.redirect, /discord=unconfigured/u);

  // Callback sans clés : retour à l'accueil avec un statut lisible.
  const callback = await callSettings({ query: { callback: "1", code: "abc", state: "def" } });
  assert.equal(callback.status, 302);
  assert.match(callback.redirect, /discord=unconfigured/u);
});

test("le routage /api/settings et /api/auth/discord passe par /api/profile", async () => {
  const profile = (await import("../api/profile.mjs")).default;
  const request = (query) => ({
    method: "GET",
    query,
    headers: { ...headers, cookie: memberCookie },
  });
  const read = makeResponse();
  await profile(request({ qg: "settings" }), read);
  assert.equal(read.result.status, 200);
  assert.equal(read.result.body.viewer, "FanLie");

  const oauth = makeResponse();
  await profile(request({ qg: "discord" }), oauth);
  assert.equal(oauth.result.status, 302);
  assert.match(oauth.result.redirect, /discord=unconfigured/u);
});
