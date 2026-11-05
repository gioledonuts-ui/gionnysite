import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Le store autonome doit pointer sur un fichier jetable AVANT le chargement du
// graphe de modules (le chemin est lu à l'import).
const STATE_FILE = path.join(os.tmpdir(), `qg-feed-state-${process.pid}.json`);
const ADMIN_STATE_FILE = path.join(os.tmpdir(), `qg-feed-admin-${process.pid}.json`);
process.env.QG_STATE_FILE = STATE_FILE;
process.env.QG_ADMIN_STATE_FILE = ADMIN_STATE_FILE;
delete process.env.BLOB_READ_WRITE_TOKEN;
delete process.env.BLOB_STORE_ID;

const store = await import("../lib/blob-store.mjs");
const inbox = await import("../lib/contact-inbox.mjs");
const graph = await import("../lib/social-graph.mjs");

const ORIGIN = "https://qg.test";
const headers = { host: "qg.test", origin: ORIGIN };

/** Petite réponse HTTP compatible avec les handlers Vercel. */
const makeResponse = () => {
  const state = { status: 200, body: undefined, headers: {} };
  const response = {
    setHeader(name, value) {
      state.headers[String(name).toLowerCase()] = value;
    },
    status(code) {
      state.status = code;
      return response;
    },
    json(value) {
      state.body = value;
      return { status: state.status, body: state.body, headers: state.headers };
    },
    send(value) {
      state.body = value;
      return { status: state.status, body: state.body, headers: state.headers };
    },
    end() {
      return { status: state.status, body: state.body, headers: state.headers };
    },
    get result() {
      return state;
    },
  };
  return response;
};

const call = async (handler, { method = "GET", query = {}, body, cookie, extraHeaders = {} } = {}) => {
  const request = {
    method,
    query,
    headers: { ...headers, ...(cookie ? { cookie } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body }),
  };
  const response = makeResponse();
  await handler(request, response);
  return response.result;
};

const profileHandler = (await import("../api/profile.mjs")).default;
const mediaHandler = (await import("../api/profile.mjs")).default;
// Les médias sont servis par la même fonction (`?media=1`) : le handler est
// appelé avec ce paramètre pour reproduire la route réelle.

let hostCookie = "";
let memberCookie = "";
let adminPseudo = "";

const accountCookie = (token) => `gionny_account_session=${token}`;

test.before(async () => {
  store.resetState();
  // L'Hôte réel du site : premier compte créé, rôle host.
  const host = await inbox.registerVisitorAccount({ pseudo: "Gionny", password: "host-password-2026" });
  assert.equal(host.ok, true);
  hostCookie = accountCookie(host.sessionToken || "");
  adminPseudo = host.account?.pseudo || "Gionny";
  // La couronne ne vient plus du pseudo : elle est attribuée en base, comme
  // depuis le panneau /admin.
  const hostRecord = (await inbox.listVisitorAccounts("", undefined)).members
    .find((entry) => entry.pseudo === adminPseudo);
  assert.ok(hostRecord, "le compte Hôte doit exister");
  assert.equal((await inbox.setVisitorAccountRole(hostRecord.id, "host", undefined)).ok, true);

  const member = await inbox.registerVisitorAccount({ pseudo: "FanValide", password: "member-password-2026" });
  assert.equal(member.ok, true);
  memberCookie = accountCookie(member.sessionToken || "");
  const { members } = await inbox.listVisitorAccounts("", undefined);
  const fan = members.find((entry) => entry.pseudo === "FanValide");
  assert.ok(fan, "le compte membre doit exister");
  await inbox.setVisitorAccountBadges(fan.id, ["verified"], undefined);
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

test("un visiteur lit le fil mais ne peut pas publier", async () => {
  const read = await call(profileHandler, { query: { feed: "1", mode: "all" } });
  assert.equal(read.status, 200);
  assert.ok(Array.isArray(read.body.posts));

  const publish = await call(profileHandler, { method: "POST", body: { action: "post", text: "Coucou" } });
  assert.equal(publish.status, 401);
  assert.match(publish.body.error, /Connecte-toi/u);
});

test("l'Hôte publie un post avec image, la dépose puis la sert avec le bon type", async () => {
  const created = await call(profileHandler, {
    method: "POST",
    cookie: hostCookie,
    body: { action: "post", text: "Affiche du live 🔥", media: { kind: "image", alt: "Affiche" } },
  });
  assert.equal(created.status, 201);
  const postId = created.body.post.id;
  assert.ok(postId);
  assert.equal(created.body.post.media.kind, "image");
  assert.ok(created.body.post.media.url.includes(postId));

  const bytes = Buffer.from("RIFF0000WEBPVP8 test-payload", "binary");
  const upload = await call(profileHandler, {
    method: "POST",
    cookie: hostCookie,
    body: {
      action: "media",
      postId,
      kind: "image",
      contentType: "image/webp",
      mediaData: bytes.toString("base64"),
    },
  });
  assert.equal(upload.status, 201);

  const served = await call(mediaHandler, { query: { media: "1", post: postId, kind: "image" } });
  assert.equal(served.status, 200);
  assert.equal(served.headers["content-type"], "image/webp");
  assert.deepEqual(Buffer.from(served.body), bytes);

  // Un média inexistant ne casse rien.
  const missing = await call(mediaHandler, { query: { media: "1", post: "00000000-0000-4000-8000-000000000000", kind: "image" } });
  assert.equal(missing.status, 404);

  // Un type de média inconnu est refusé.
  const badKind = await call(mediaHandler, { query: { media: "1", post: postId, kind: "gif" } });
  assert.equal(badKind.status, 400);

  // Le fil expose l'URL, pas le binaire.
  const feed = await call(profileHandler, { query: { feed: "1" } });
  const posted = feed.body.posts.find((entry) => entry.id === postId);
  assert.ok(posted);
  assert.equal(posted.media.kind, "image");
  assert.equal(typeof posted.media.url, "string");
  assert.equal(posted.text.includes("RIFF"), false);
});

test("un média trop lourd est refusé avant d'écrire quoi que ce soit", async () => {
  const created = await call(profileHandler, {
    method: "POST",
    cookie: hostCookie,
    body: { action: "post", text: "", media: { kind: "video", duration: 12 } },
  });
  assert.equal(created.status, 201);
  const postId = created.body.post.id;

  // 2 Mo + 1 Ko de charge utile : au-delà de la limite vidéo (30 s / 2 Mo).
  const tooBig = Buffer.alloc(2 * 1024 * 1024 + 1024, 1);
  const upload = await call(profileHandler, {
    method: "POST",
    cookie: hostCookie,
    body: { action: "media", postId, kind: "video", mediaData: tooBig.toString("base64") },
  });
  assert.equal(upload.status, 413);
  assert.match(upload.body.error, /2 Mo/u);

  const served = await call(mediaHandler, { query: { media: "1", post: postId, kind: "video" } });
  assert.equal(served.status, 404);
});

test("likes et reposts d'un membre créent des notifications lisibles par l'auteur", async () => {
  const created = await call(profileHandler, {
    method: "POST",
    cookie: hostCookie,
    body: { action: "post", text: "Qui est chaud pour ce soir ?" },
  });
  const postId = created.body.post.id;

  const like = await call(profileHandler, {
    method: "POST",
    cookie: memberCookie,
    body: { action: "like", postId },
  });
  assert.equal(like.status, 200);
  assert.equal(like.body.liked, true);
  assert.equal(like.body.likes, 1);

  const repost = await call(profileHandler, {
    method: "POST",
    cookie: memberCookie,
    body: { action: "repost", postId },
  });
  assert.equal(repost.status, 200);
  assert.equal(repost.body.reposted, true);
  assert.equal(repost.body.reposts, 1);

  const notifications = await call(profileHandler, {
    cookie: hostCookie,
    query: { notifications: "1" },
  });
  assert.equal(notifications.status, 200);
  assert.ok(notifications.body.notifications.length >= 2);
  assert.ok(notifications.body.notifications.every((item) => item.postId === postId));
  assert.ok(notifications.body.notifications.some((item) => item.type === "like"));
  assert.ok(notifications.body.notifications.some((item) => item.type === "repost"));
  assert.equal(notifications.body.notifications[0].actors[0].pseudo, "FanValide");
  assert.ok(notifications.body.unread >= 1);

  const read = await call(profileHandler, {
    method: "POST",
    cookie: hostCookie,
    body: { action: "notifications-read" },
  });
  assert.equal(read.status, 200);
  const afterRead = await call(profileHandler, { cookie: hostCookie, query: { notifications: "1" } });
  assert.equal(afterRead.body.unread, 0);

  // Un visiteur n'a jamais de notifications, et n'écrit pas.
  const guest = await call(profileHandler, { query: { notifications: "1" } });
  assert.equal(guest.status, 200);
  assert.deepEqual(guest.body.notifications, []);
  const guestLike = await call(profileHandler, { method: "POST", body: { action: "like", postId } });
  assert.equal(guestLike.status, 401);
});

test("les filtres « suivis » et « reposts » répondent avec les bons posts", async () => {
  await graph.ensureHostFollowFor("FanValide");
  const follows = await call(profileHandler, {
    cookie: memberCookie,
    query: { feed: "1", mode: "follows" },
  });
  assert.equal(follows.status, 200);
  assert.ok(follows.body.posts.length >= 1);
  assert.ok(follows.body.posts.every((post) => post.isHost));

  const reposts = await call(profileHandler, { query: { feed: "1", mode: "reposts" } });
  assert.equal(reposts.status, 200);
  assert.ok(reposts.body.posts.length >= 1);
  assert.ok(reposts.body.posts.every((post) => post.reposts >= 1));
});

test("un membre non validé peut liker mais pas publier", async () => {
  const simple = await inbox.registerVisitorAccount({ pseudo: "SimpleFan", password: "simple-password-2026" });
  assert.equal(simple.ok, true);
  const cookie = accountCookie(simple.sessionToken || "");

  const refused = await call(profileHandler, {
    method: "POST",
    cookie,
    body: { action: "post", text: "Je publie ?" },
  });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /Validés/u);

  const feed = await call(profileHandler, { query: { feed: "1" } });
  const postId = feed.body.posts[0].id;
  const like = await call(profileHandler, { method: "POST", cookie, body: { action: "like", postId } });
  assert.equal(like.status, 200);
});

test("seul Gionny épingle un post, et l'épinglage se voit dans le fil", async () => {
  const created = await call(profileHandler, {
    method: "POST",
    cookie: hostCookie,
    body: { action: "post", text: "Annonce à épingler" },
  });
  assert.equal(created.status, 201);
  const postId = created.body.post.id;

  const pin = await call(profileHandler, {
    method: "POST",
    cookie: hostCookie,
    body: { action: "pin", postId },
  });
  assert.equal(pin.status, 200);
  assert.equal(pin.body.pinned, true);

  const feed = await call(profileHandler, { query: { feed: "1" } });
  assert.equal(feed.body.posts[0].id, postId);
  assert.equal(feed.body.posts[0].pinned, true);
  assert.equal(feed.body.posts.filter((post) => post.pinned).length, 1);

  // Un membre Validé n'a pas ce droit.
  const refused = await call(profileHandler, {
    method: "POST",
    cookie: memberCookie,
    body: { action: "pin", postId },
  });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /Gionny/u);

  const unpin = await call(profileHandler, {
    method: "POST",
    cookie: hostCookie,
    body: { action: "unpin", postId },
  });
  assert.equal(unpin.status, 200);
  assert.equal(unpin.body.pinned, false);
});

test("un follow et un post de l'Hôte arrivent dans les notifications", async () => {
  const simple = await inbox.registerVisitorAccount({ pseudo: "NotifFan", password: "notif-password-2026" });
  assert.equal(simple.ok, true);
  const cookie = accountCookie(simple.sessionToken);

  // NotifFan suit FanValide → FanValide reçoit un follow.
  const follow = await call(profileHandler, {
    method: "POST",
    cookie,
    body: { action: "follow", target: "FanValide" },
  });
  assert.equal(follow.status, 200);
  const fanNotifs = await call(profileHandler, { cookie: memberCookie, query: { notifications: "1" } });
  assert.ok(fanNotifs.body.notifications.some((item) => item.type === "follow"));

  // Un post de l'Hôte est annoncé à NotifFan.
  await call(profileHandler, {
    method: "POST",
    cookie: hostCookie,
    body: { action: "post", text: "Le QG est en live 🔥" },
  });
  const notifFan = await call(profileHandler, { cookie, query: { notifications: "1" } });
  const announced = notifFan.body.notifications.filter((item) => item.type === "post");
  assert.equal(announced.length, 1);
  assert.equal(announced[0].actors[0].isHost, true);
});
