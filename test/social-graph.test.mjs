import test from "node:test";
import assert from "node:assert/strict";

import { registerVisitorAccount, setVisitorAccountBadges } from "../lib/contact-inbox.mjs";
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
  listFeed,
  listReports,
  setBlock,
  setFollow,
  setReportStatus,
  toggleLike,
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

test("every new account follows the host automatically", async () => {
  const store = new MemoryBlobStore();
  await register(store, "NouveauVenu");
  const ensured = await ensureHostFollowFor("NouveauVenu", store);
  assert.equal(ensured.ok, true);

  const host = await getPublicProfile("Gionny", { viewer: "NouveauVenu" }, store);
  assert.equal(host.ok, true);
  assert.equal(host.profile.isHost, true);
  assert.ok(host.profile.followersCount >= 1);
  assert.equal(host.profile.isFollowing, true);

  const member = await getProfileRecord("NouveauVenu", store);
  assert.deepEqual(member.following, ["Gionny"]);
});

test("ensureEveryAccountFollowsHost catches accounts created before the rule", async () => {
  const store = new MemoryBlobStore();
  await register(store, "AncienMembre");
  await register(store, "AutreAncien");
  await ensureEveryAccountFollowsHost(store);
  await ensureEveryAccountFollowsHost(store);

  const host = await getPublicProfile("Gionny", {}, store);
  assert.equal(host.profile.followersCount, 2);
  const second = await getProfileRecord("AutreAncien", store);
  assert.equal(second.following.filter((entry) => entry === "Gionny").length, 1);
});

test("the host cannot be unfollowed: the rule wins", async () => {
  const store = new MemoryBlobStore();
  await register(store, "Fidele");
  const result = await setFollow({ pseudo: "Fidele", target: "Gionny", follow: false }, store);
  assert.equal(result.ok, true);
  assert.equal(result.locked, true);
  const host = await getPublicProfile("Gionny", { viewer: "Fidele" }, store);
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
  const hostBlock = await setBlock({ pseudo: "Carla", target: "Gionny", blocked: true }, store);
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

  const hostPost = await createPost({ pseudo: "Gionny", text: "Salut le QG" }, store);
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
  const byHost = await deletePost({ pseudo: "Gionny", postId: verifiedPost.post.id }, store);
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
