import test from "node:test";
import assert from "node:assert/strict";

import {
  listVisitorAccounts,
  registerVisitorAccount,
  setVisitorAccountBadges,
  setVisitorAccountRole,
} from "../lib/contact-inbox.mjs";
import {
  canMessage,
  createPost,
  createReport,
  deletePost,
  deleteReport,
  ensureEveryAccountFollowsHost,
  ensureHostFollowFor,
  getProfileRecord,
  getPublicProfile,
  attachPostMedia,
  countUnreadNotifications,
  listFeed,
  listNotifications,
  listReports,
  markNotificationsRead,
  readPostMedia,
  setBlock,
  setFollow,
  setPinned,
  setReportStatus,
  toggleLike,
  toggleRepost,
  updateProfileDetails,
  REPORT_REASONS,
} from "../lib/social-graph.mjs";

// Small in-memory store with the exact surface the social graph uses.
class MemoryBlobStore {
  constructor() {
    this.objects = new Map();
  }

  async put(pathname, body, options = {}) {
    if (!options.allowOverwrite && this.objects.has(pathname)) {
      throw new Error(`Object already exists: ${pathname}`);
    }
    this.objects.set(pathname, Buffer.from(body));
    return { pathname };
  }

  async get(pathname) {
    const body = this.objects.get(pathname);
    if (!body) return null;
    return { statusCode: 200, stream: new Response(body).body };
  }

  async list({ prefix = "", limit = 1000, cursor = "" } = {}) {
    const paths = [...this.objects.keys()].filter((path) => path.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) || 0 : 0;
    const end = Math.min(paths.length, start + limit);
    return {
      blobs: paths.slice(start, end).map((pathname) => ({ pathname })),
      hasMore: end < paths.length,
      cursor: end < paths.length ? String(end) : null,
    };
  }

  async del(paths) {
    for (const pathname of Array.isArray(paths) ? paths : [paths]) this.objects.delete(pathname);
  }
}

const register = async (store, pseudo) => {
  const created = await registerVisitorAccount({ pseudo, password: "correct-horse-battery" }, store);
  assert.equal(created.ok, true, `registration failed for ${pseudo}`);
  return created;
};

// Le rôle Hôte vient UNIQUEMENT de la base (panneau /admin), jamais du pseudo.
const promoteToHost = async (store, pseudo) => {
  const { members } = await listVisitorAccounts("", store);
  const member = members.find((entry) => entry.pseudo === pseudo);
  assert.ok(member, `compte ${pseudo} introuvable`);
  const result = await setVisitorAccountRole(member.id, "host", store);
  assert.equal(result.ok, true);
  return result.member;
};

// L'Hôte du QG tel qu'il existe en production : un compte, un rôle en base.
const registerHost = async (store, pseudo = "ChefDuQG") => {
  const created = await register(store, pseudo);
  await promoteToHost(store, created.account.pseudo);
  return created;
};

test("every new account follows the host automatically", async () => {
  const store = new MemoryBlobStore();
  await registerHost(store, "ChefDuQG");
  await register(store, "NouveauVenu");
  const ensured = await ensureHostFollowFor("NouveauVenu", store);
  assert.equal(ensured.ok, true);

  const host = await getPublicProfile("ChefDuQG", { viewer: "NouveauVenu" }, store);
  assert.equal(host.ok, true);
  assert.equal(host.profile.isHost, true);
  assert.ok(host.profile.followersCount >= 1);
  assert.equal(host.profile.isFollowing, true);

  const member = await getProfileRecord("NouveauVenu", store);
  assert.deepEqual(member.following, ["ChefDuQG"]);
});

test("ensureEveryAccountFollowsHost catches accounts created before the rule", async () => {
  const store = new MemoryBlobStore();
  await registerHost(store, "ChefDuQG");
  await register(store, "AncienMembre");
  await register(store, "AutreAncien");
  await ensureEveryAccountFollowsHost(store);
  await ensureEveryAccountFollowsHost(store);

  const host = await getPublicProfile("ChefDuQG", {}, store);
  assert.equal(host.profile.followersCount, 2);
  const second = await getProfileRecord("AutreAncien", store);
  assert.equal(second.following.filter((entry) => entry === "ChefDuQG").length, 1);
});

test("the host cannot be unfollowed: the rule wins", async () => {
  const store = new MemoryBlobStore();
  await registerHost(store, "ChefDuQG");
  await register(store, "Fidele");
  const result = await setFollow({ pseudo: "Fidele", target: "ChefDuQG", follow: false }, store);
  assert.equal(result.ok, true);
  assert.equal(result.locked, true);
  const host = await getPublicProfile("ChefDuQG", { viewer: "Fidele" }, store);
  assert.equal(host.profile.isFollowing, true);
});

test("following and unfollowing a member updates both counters", async () => {
  const store = new MemoryBlobStore();
  await register(store, "Alice");
  await register(store, "Bruno");

  const follow = await setFollow({ pseudo: "Alice", target: "Bruno", follow: true }, store);
  assert.equal(follow.ok, true);
  let bruno = await getPublicProfile("Bruno", { viewer: "Alice" }, store);
  assert.equal(bruno.profile.followersCount, 1);
  assert.equal(bruno.profile.isFollowing, true);

  await setFollow({ pseudo: "Alice", target: "Bruno", follow: false }, store);
  bruno = await getPublicProfile("Bruno", { viewer: "Alice" }, store);
  assert.equal(bruno.profile.followersCount, 0);
  assert.equal(bruno.profile.isFollowing, false);
});

test("blocking removes both follows and hides the contact", async () => {
  const store = new MemoryBlobStore();
  await registerHost(store, "ChefDuQG");
  await register(store, "Carla");
  await register(store, "David");
  await setFollow({ pseudo: "Carla", target: "David", follow: true }, store);
  await setFollow({ pseudo: "David", target: "Carla", follow: true }, store);

  const blocked = await setBlock({ pseudo: "Carla", target: "David", blocked: true }, store);
  assert.equal(blocked.ok, true);

  const david = await getPublicProfile("David", { viewer: "Carla" }, store);
  assert.equal(david.profile.isBlocked, true);
  assert.equal(david.profile.followersCount, 0);
  const carla = await getPublicProfile("Carla", { viewer: "David" }, store);
  assert.equal(carla.profile.hasBlockedViewer, true);

  // On ne peut pas (re)suivre quelqu'un qui nous a bloqués.
  const retry = await setFollow({
    pseudo: "David",
    target: "Carla",
    follow: true,
    store,
  }, store);
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, "blocked");

  // The host itself can never be blocked.
  const hostBlock = await setBlock({ pseudo: "Carla", target: "ChefDuQG", blocked: true }, store);
  assert.equal(hostBlock.ok, false);
  assert.equal(hostBlock.reason, "host");
});

test("profile details keep the bio short and validate the Discord handle", async () => {
  const store = new MemoryBlobStore();
  await register(store, "Emma");
  const saved = await updateProfileDetails(
    { pseudo: "Emma", bio: "  Salut la commu !  ", discordUsername: "@emma.qg" },
    store
  );
  assert.equal(saved.ok, true);
  assert.equal(saved.profile.bio, "Salut la commu !");
  assert.equal(saved.profile.discordUsername, "emma.qg");

  const refused = await updateProfileDetails({ pseudo: "Emma", discordUsername: "pas de pseudo discord" }, store);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "discord");
});

test("message permission: host always, verified members together", () => {
  assert.equal(canMessage({ pseudo: "A", target: "Gionny", isTargetHost: true }), true);
  assert.equal(
    canMessage({ pseudo: "A", target: "B", isTargetHost: false, senderIsVerified: true, targetIsVerified: true }),
    true
  );
  assert.equal(
    canMessage({ pseudo: "A", target: "B", isTargetHost: false, senderIsVerified: true, targetIsVerified: false }),
    false
  );
});

test("reports are stored, listed and can be handled or deleted", async () => {
  const store = new MemoryBlobStore();
  await register(store, "Reporter");
  await register(store, "Suspect");

  const created = await createReport(
    { reporterPseudo: "Reporter", targetPseudo: "Suspect", reason: REPORT_REASONS[1], details: "Insultes" },
    store
  );
  assert.equal(created.ok, true);
  assert.equal(created.report.status, "open");

  const refused = await createReport({ reporterPseudo: "Reporter", targetPseudo: "Suspect", reason: "n’importe quoi" }, store);
  assert.equal(refused.ok, false);

  const self = await createReport(
    { reporterPseudo: "Reporter", targetPseudo: "Reporter", reason: REPORT_REASONS[0] },
    store
  );
  assert.equal(self.ok, false);
  assert.equal(self.reason, "self");

  const list = await listReports(store);
  assert.equal(list.length, 1);
  assert.equal(list[0].details, "Insultes");

  const handled = await setReportStatus(created.report.id, "handled", store);
  assert.equal(handled.ok, true);
  assert.equal((await listReports(store))[0].status, "handled");

  await deleteReport(created.report.id, store);
  assert.equal((await listReports(store)).length, 0);
});

test("verified badge is what allows member to member messaging", async () => {
  const store = new MemoryBlobStore();
  const created = await register(store, "Verifie");
  const { members } = await import("../lib/contact-inbox.mjs").then((module) =>
    module.listVisitorAccounts("", store)
  );
  const target = members.find((member) => member.pseudo === "Verifie");
  await setVisitorAccountBadges(target.id, ["verified"], store);
  const profile = await getPublicProfile("Verifie", {}, store);
  assert.equal(profile.ok, true);
  assert.equal(created.ok, true);
});

test("only the host and verified members publish, everybody can like", async () => {
  const store = new MemoryBlobStore();
  await registerHost(store, "ChefDuQG");
  await register(store, "SimpleMembre");
  await register(store, "MembreValide");
  const { members } = await import("../lib/contact-inbox.mjs").then((module) =>
    module.listVisitorAccounts("", store)
  );
  const verified = members.find((member) => member.pseudo === "MembreValide");
  await setVisitorAccountBadges(verified.id, ["verified"], store);

  const refused = await createPost({ pseudo: "SimpleMembre", text: "Coucou" }, store);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "not_allowed");

  const hostPost = await createPost({ pseudo: "ChefDuQG", text: "Salut le QG" }, store);
  assert.equal(hostPost.ok, true);
  const verifiedPost = await createPost({ pseudo: "MembreValide", text: "Premier post validé" }, store);
  assert.equal(verifiedPost.ok, true);

  const feed = await listFeed({ viewer: "SimpleMembre", mode: "all" }, store);
  assert.equal(feed.length, 2);
  assert.equal(feed[0].pseudo, "MembreValide");
  assert.equal(feed[1].isHost, true);

  const trustedOnly = await listFeed({ viewer: "SimpleMembre", mode: "verified" }, store);
  assert.equal(trustedOnly.length, 2);

  const liked = await toggleLike({ pseudo: "SimpleMembre", postId: hostPost.post.id }, store);
  assert.equal(liked.ok, true);
  assert.equal(liked.liked, true);
  assert.equal(liked.likes, 1);
  const again = await toggleLike({ pseudo: "SimpleMembre", postId: hostPost.post.id }, store);
  assert.equal(again.liked, false);

  const removed = await deletePost({ pseudo: "SimpleMembre", postId: hostPost.post.id }, store);
  assert.equal(removed.ok, false);
  assert.equal(removed.reason, "forbidden");
  const byHost = await deletePost({ pseudo: "ChefDuQG", postId: verifiedPost.post.id }, store);
  assert.equal(byHost.ok, true);
  assert.equal((await listFeed({ mode: "all" }, store)).length, 1);
});

test("a blocked author disappears from the feed", async () => {
  const store = new MemoryBlobStore();
  await register(store, "Lecteur");
  await register(store, "Auteur");
  const { listVisitorAccounts } = await import("../lib/contact-inbox.mjs");
  const { members } = await listVisitorAccounts("", store);
  const author = members.find((member) => member.pseudo === "Auteur");
  await setVisitorAccountBadges(author.id, ["verified"], store);
  await createPost({ pseudo: "Auteur", text: "Post visible" }, store);
  await setBlock({ pseudo: "Lecteur", target: "Auteur", blocked: true }, store);
  assert.equal((await listFeed({ viewer: "Lecteur", mode: "all" }, store)).length, 0);
  assert.equal((await listFeed({ mode: "all" }, store)).length, 1);
});

test("un post accepte une image, un vocal ou une vidéo, jamais un média vide", async () => {
  const store = new MemoryBlobStore();
  await register(store, "MediaMembre");
  const { listVisitorAccounts } = await import("../lib/contact-inbox.mjs");
  const { members } = await listVisitorAccounts("", store);
  const member = members.find((entry) => entry.pseudo === "MediaMembre");
  await setVisitorAccountBadges(member.id, ["verified"], store);

  // Ni texte ni média : refusé.
  const empty = await createPost({ pseudo: "MediaMembre", text: "   " }, store);
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "empty");

  // Un média seul suffit à publier.
  const withImage = await createPost(
    { pseudo: "MediaMembre", text: "", media: { kind: "image", alt: "Affiche du live" } },
    store
  );
  assert.equal(withImage.ok, true);
  assert.equal(withImage.post.media.kind, "image");

  // Un type inconnu est ignoré comme un média absent.
  const bogus = await createPost({ pseudo: "MediaMembre", text: "", media: { kind: "gif" } }, store);
  assert.equal(bogus.reason, "empty");

  const bytes = Buffer.from("RIFF0000WEBPVP8 ", "ascii");
  const stored = await attachPostMedia(
    { pseudo: "MediaMembre", postId: withImage.post.id, kind: "image", bytes, contentType: "image/webp" },
    store
  );
  assert.equal(stored.ok, true);

  const read = await readPostMedia({ postId: withImage.post.id, kind: "image" }, store);
  assert.ok(read);
  assert.equal(read.contentType, "image/webp");
  assert.deepEqual(Buffer.from(await new Response(read.stream).arrayBuffer()), bytes);

  // Un autre membre ne peut pas déposer de média sur ce post.
  await register(store, "Voisin");
  const stolen = await attachPostMedia(
    { pseudo: "Voisin", postId: withImage.post.id, kind: "image", bytes },
    store
  );
  assert.equal(stolen.ok, false);
  assert.equal(stolen.reason, "forbidden");

  // Le fil expose l'URL média, jamais le binaire.
  const feed = await listFeed({ mode: "all" }, store);
  const posted = feed.find((entry) => entry.id === withImage.post.id);
  assert.ok(posted.media.url.includes(`post=${withImage.post.id}`));
  assert.equal(posted.media.kind, "image");

  // Supprimer le post supprime aussi son média.
  await deletePost({ pseudo: "MediaMembre", postId: withImage.post.id }, store);
  assert.equal(await readPostMedia({ postId: withImage.post.id, kind: "image" }, store), null);
});

test("likes et reposts créent des notifications groupées par post", async () => {
  const store = new MemoryBlobStore();
  await register(store, "AuteurPost");
  await register(store, "FanUn");
  await register(store, "FanDeux");
  const { listVisitorAccounts } = await import("../lib/contact-inbox.mjs");
  const { members } = await listVisitorAccounts("", store);
  await setVisitorAccountBadges(members.find((entry) => entry.pseudo === "AuteurPost").id, ["verified"], store);

  const created = await createPost({ pseudo: "AuteurPost", text: "Salut le QG" }, store);
  const postId = created.post.id;

  await toggleLike({ pseudo: "FanUn", postId }, store);
  await toggleLike({ pseudo: "FanDeux", postId }, store);
  const again = await toggleLike({ pseudo: "FanUn", postId }, store);
  assert.equal(again.liked, false);

  // Deux acteurs, une seule entrée (regroupée), non lue.
  const notifications = await listNotifications({ viewer: "AuteurPost" }, store);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].type, "like");
  assert.equal(notifications[0].count, 2);
  assert.deepEqual(notifications[0].actors.map((actor) => actor.pseudo).sort(), ["FanDeux", "FanUn"]);
  assert.equal(notifications[0].read, false);
  assert.equal(await countUnreadNotifications({ viewer: "AuteurPost" }, store), 1);

  const repost = await toggleRepost({ pseudo: "FanUn", postId }, store);
  assert.equal(repost.ok, true);
  assert.equal(repost.reposted, true);
  assert.equal(repost.reposts, 1);

  const all = await listNotifications({ viewer: "AuteurPost" }, store);
  assert.equal(all.length, 2);
  assert.equal(all.filter((item) => item.type === "repost").length, 1);

  // Se liker soi-même ne notifie personne.
  await toggleLike({ pseudo: "AuteurPost", postId }, store);
  assert.equal((await listNotifications({ viewer: "AuteurPost" }, store)).length, 2);

  await markNotificationsRead({ viewer: "AuteurPost" }, store);
  assert.equal(await countUnreadNotifications({ viewer: "AuteurPost" }, store), 0);
  assert.equal((await listNotifications({ viewer: "AuteurPost" }, store)).every((item) => item.read), true);

  // Un compte bloqué ne notifie plus son auteur de référence.
  await setBlock({ pseudo: "AuteurPost", target: "FanDeux", blocked: true }, store);
  await toggleLike({ pseudo: "FanDeux", postId }, store);
  const afterBlock = await listNotifications({ viewer: "AuteurPost" }, store);
  const likeItem = afterBlock.find((item) => item.type === "like");
  assert.equal(likeItem.actors.some((actor) => actor.pseudo === "FanDeux"), false);
});

test("les filtres du fil : suivis, reposts et j'aime", async () => {
  const store = new MemoryBlobStore();
  await register(store, "Suiveur");
  await register(store, "Suivi");
  await register(store, "Ignore");
  const { listVisitorAccounts } = await import("../lib/contact-inbox.mjs");
  const { members } = await listVisitorAccounts("", store);
  for (const pseudo of ["Suivi", "Ignore"]) {
    await setVisitorAccountBadges(members.find((entry) => entry.pseudo === pseudo).id, ["verified"], store);
  }

  const followed = await createPost({ pseudo: "Suivi", text: "Post suivi" }, store);
  await createPost({ pseudo: "Ignore", text: "Post ignoré" }, store);
  await setFollow({ pseudo: "Suiveur", target: "Suivi", follow: true }, store);

  const followsFeed = await listFeed({ viewer: "Suiveur", mode: "follows" }, store);
  assert.equal(followsFeed.length, 1);
  assert.equal(followsFeed[0].pseudo, "Suivi");

  // Un visiteur n'a pas de « suivis » : le fil est vide, jamais cassé.
  assert.equal((await listFeed({ mode: "follows" }, store)).length, 0);

  await toggleRepost({ pseudo: "Suiveur", postId: followed.post.id }, store);
  const repostsFeed = await listFeed({ viewer: "Suiveur", mode: "reposts" }, store);
  assert.equal(repostsFeed.length, 1);
  assert.equal(repostsFeed[0].reposts, 1);
  assert.equal(repostsFeed[0].reposted, true);

  await toggleLike({ pseudo: "Suiveur", postId: followed.post.id }, store);
  const likesFeed = await listFeed({ viewer: "Suiveur", mode: "likes" }, store);
  assert.equal(likesFeed.length, 1);
  assert.equal((await listFeed({ viewer: "Suiveur", mode: "all" }, store)).length, 2);
});

test("seul l'Hôte épingle, et un seul post reste en tête du QG", async () => {
  const store = new MemoryBlobStore();
  await registerHost(store, "ChefDuQG");
  await register(store, "Epingleur");
  const { listVisitorAccounts } = await import("../lib/contact-inbox.mjs");
  const { members } = await listVisitorAccounts("", store);
  await setVisitorAccountBadges(members.find((m) => m.pseudo === "Epingleur").id, ["verified"], store);

  const first = await createPost({ pseudo: "Epingleur", text: "Annonce 1" }, store);
  const second = await createPost({ pseudo: "ChefDuQG", text: "Annonce 2" }, store);

  // Un membre ne peut pas épingler.
  const refused = await setPinned({ pseudo: "Epingleur", postId: first.post.id, pinned: true }, store);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "forbidden");

  const pinnedFirst = await setPinned({ pseudo: "ChefDuQG", postId: first.post.id, pinned: true }, store);
  assert.equal(pinnedFirst.ok, true);
  let feed = await listFeed({ mode: "all" }, store);
  assert.equal(feed[0].id, first.post.id);
  assert.equal(feed[0].pinned, true);

  // Épingler un autre post retire l'épinglage du précédent.
  await setPinned({ pseudo: "ChefDuQG", postId: second.post.id, pinned: true }, store);
  feed = await listFeed({ mode: "all" }, store);
  assert.equal(feed[0].id, second.post.id);
  assert.equal(feed.filter((post) => post.pinned).length, 1);

  await setPinned({ pseudo: "ChefDuQG", postId: second.post.id, pinned: false }, store);
  feed = await listFeed({ mode: "all" }, store);
  assert.equal(feed.filter((post) => post.pinned).length, 0);
  // Sans épinglage, le plus récent reprend la tête.
  assert.equal(feed[0].id, second.post.id);
});

test("suivre un membre le notifie une seule fois", async () => {
  const store = new MemoryBlobStore();
  await register(store, "SuiviNotif");
  await register(store, "SuiveurNotif");

  await setFollow({ pseudo: "SuiveurNotif", target: "SuiviNotif", follow: true }, store);
  let notifications = await listNotifications({ viewer: "SuiviNotif" }, store);
  const follow = notifications.filter((item) => item.type === "follow");
  assert.equal(follow.length, 1);
  assert.equal(follow[0].actors[0].pseudo, "SuiveurNotif");
  assert.equal(follow[0].postId, "");

  // Suivre / ne plus suivre / re-suivre ne duplique pas l'entrée.
  await setFollow({ pseudo: "SuiveurNotif", target: "SuiviNotif", follow: false }, store);
  await setFollow({ pseudo: "SuiveurNotif", target: "SuiviNotif", follow: true }, store);
  notifications = await listNotifications({ viewer: "SuiviNotif" }, store);
  assert.equal(notifications.filter((item) => item.type === "follow").length, 1);
});

test("un post de l'Hôte est annoncé à toute la communauté, pas à lui-même", async () => {
  const store = new MemoryBlobStore();
  await registerHost(store, "ChefDuQG");
  await register(store, "MembreUn");
  await register(store, "MembreDeux");

  const hostPost = await createPost({ pseudo: "ChefDuQG", text: "Le live démarre 🎥" }, store);
  assert.equal(hostPost.ok, true);

  for (const pseudo of ["MembreUn", "MembreDeux"]) {
    const notifications = await listNotifications({ viewer: pseudo }, store);
    const announced = notifications.filter((item) => item.type === "post");
    assert.equal(announced.length, 1, `${pseudo} doit recevoir l'annonce`);
    assert.equal(announced[0].postId, hostPost.post.id);
    assert.equal(announced[0].actors[0].isHost, true);
  }
  assert.equal((await listNotifications({ viewer: "ChefDuQG" }, store)).length, 0);

  // Supprimer le post retire l'annonce de toutes les boîtes.
  await deletePost({ pseudo: "ChefDuQG", postId: hostPost.post.id }, store);
  assert.equal((await listNotifications({ viewer: "MembreUn" }, store)).length, 0);
});
