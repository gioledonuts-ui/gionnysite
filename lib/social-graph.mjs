// ---------------------------------------------------------------------------
// Le graphe social du QG : profils publics, abonnements, blocages, signalements
// ---------------------------------------------------------------------------
// Tout vit dans le même état durable que le reste du site (`globalThis.__qgState`
// -> Supabase `public.qg_app_state`, ligne `main`). Trois préfixes :
//
//   gionny/profiles/<pseudo>   bio, discordUsername, abonnements (following)
//   gionny/followers/<pseudo>  liste des pseudos abonnés à ce profil
//   gionny/reports/<id>        un signalement (profil ou message)
//
// Règles :
//   • 100 % des comptes suivent l'Hôte dès leur création (règle d'or) ;
//   • un membre ne peut suivre que des comptes qui existent ;
//   • bloquer ajoute le pseudo à `blockedUsers` du profil et retire
//     réciproquement l'abonnement croisé (plus aucun contact possible) ;
//   • les signalements sont lisibles et traitables uniquement par l'Hôte
//     (panneau /gestion-qg/, onglet SIGNALEMENTS).
//
// Les comptes restent la source de vérité de l'identité (pseudo, rôle, badge,
// photo) : ce module ne fait qu'ajouter les relations et les signalements.

import { randomUUID } from "node:crypto";
import { sharedBlobStore as blob } from "./blob-store.mjs";

const PROFILE_PREFIX = "gionny/profiles/";
const FOLLOWERS_PREFIX = "gionny/followers/";
const REPORT_PREFIX = "gionny/reports/";
const ACCOUNT_PREFIX = "gionny/visitor-accounts/";

const REPORT_REASONS = [
  "Usurpation d’identité",
  "Harcèlement ou insultes",
  "Spam ou contenu trompeur",
  "Propos haineux",
  "Autre",
];
const MAX_REPORTS = 500;
const MAX_FOLLOWING = 500;
const MAX_BIO = 160;
const MAX_DISCORD = 40;

const OWNER_PSEUDO = "Gionny";

function normalizePseudo(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/^@+/u, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 32);
}

function pseudoKey(pseudo) {
  return normalizePseudo(pseudo).toLowerCase();
}

function isOwnerPseudo(pseudo) {
  return ["gionny", "7gionny"].includes(pseudoKey(pseudo));
}

function profilePath(pseudo) {
  return `${PROFILE_PREFIX}${encodeURIComponent(pseudoKey(pseudo))}.json`;
}

function followersPath(pseudo) {
  return `${FOLLOWERS_PREFIX}${encodeURIComponent(pseudoKey(pseudo))}.json`;
}

function reportPath(id) {
  return `${REPORT_PREFIX}${id}.json`;
}

function isIdentifier(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

async function readJson(pathname, store = blob) {
  const result = await store.get(pathname, { access: "private", useCache: false }).catch(() => null);
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  try {
    return JSON.parse(await new Response(result.stream).text());
  } catch {
    return null;
  }
}

async function writeJson(pathname, value, store = blob) {
  await store.put(pathname, JSON.stringify(value), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
  });
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "")
    .replace(/\r\n?/gu, "\n")
    .trim()
    .slice(0, maxLength);
}

function emptyProfile(pseudo) {
  return {
    version: 1,
    pseudo,
    bio: "",
    discordUsername: "",
    following: [],
    blockedUsers: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizeProfile(raw, pseudo) {
  const base = emptyProfile(pseudo);
  if (!raw || typeof raw !== "object") return base;
  return {
    ...base,
    bio: cleanText(raw.bio, MAX_BIO),
    discordUsername: cleanText(raw.discordUsername, MAX_DISCORD).replace(/^@+/u, ""),
    following: Array.isArray(raw.following)
      ? [...new Set(raw.following.map((value) => normalizePseudo(value)).filter(Boolean))].slice(0, MAX_FOLLOWING)
      : [],
    blockedUsers: Array.isArray(raw.blockedUsers)
      ? [...new Set(raw.blockedUsers.map((value) => normalizePseudo(value)).filter(Boolean))].slice(0, MAX_FOLLOWING)
      : [],
    updatedAt: typeof raw.updatedAt === "string" && Number.isFinite(Date.parse(raw.updatedAt))
      ? raw.updatedAt
      : base.updatedAt,
  };
}

function normalizeFollowers(raw) {
  if (!raw || !Array.isArray(raw.followers)) return [];
  return [...new Set(raw.followers.map((value) => normalizePseudo(value)).filter(Boolean))];
}

/** Liste des comptes connus, pour valider un pseudo avant de le suivre. */
async function listAccountPseudos(store = blob) {
  const pseudos = new Map();
  let cursor = "";
  let hasMore = true;
  while (hasMore) {
    const page = await store.list({ prefix: ACCOUNT_PREFIX, limit: 200, ...(cursor ? { cursor } : {}) });
    for (const entry of Array.isArray(page.blobs) ? page.blobs : []) {
      const stored = await readJson(entry.pathname, store).catch(() => null);
      const pseudo = normalizePseudo(stored?.pseudo);
      if (pseudo && stored?.status !== "banned") pseudos.set(pseudoKey(pseudo), pseudo);
    }
    hasMore = page.hasMore === true && typeof page.cursor === "string";
    cursor = hasMore ? page.cursor : "";
  }
  return [...pseudos.values()];
}

function resolvePseudo(input, known) {
  const wanted = pseudoKey(input);
  if (!wanted) return "";
  const match = known.find((pseudo) => pseudoKey(pseudo) === wanted);
  if (match) return match;
  if (isOwnerPseudo(input)) return OWNER_PSEUDO;
  return "";
}

export async function getProfileRecord(pseudo, store = blob) {
  const resolved = normalizePseudo(pseudo);
  if (!resolved) return emptyProfile("");
  return normalizeProfile(await readJson(profilePath(resolved), store).catch(() => null), resolved);
}

async function writeProfileRecord(profile, store = blob) {
  await writeJson(profilePath(profile.pseudo), profile, store);
  return profile;
}

async function readFollowers(pseudo, store = blob) {
  const id = pseudoKey(pseudo);
  const stored = await readJson(followersPath(pseudo), store).catch(() => null);
  const list = normalizeFollowers(
    stored && stored.id === id ? stored : { id, followers: [] }
  );
  // On ne renvoie jamais un abonné dont le compte a disparu : le profil Hôte
  // reflète les membres réellement présents sur le site.
  return list;
}

async function writeFollowers(pseudo, followers, store = blob) {
  const id = pseudoKey(pseudo);
  await writeJson(
    followersPath(pseudo),
    { version: 1, id, followers: [...new Set(followers)], updatedAt: new Date().toISOString() },
    store
  );
  return followers;
}

/** Abonne `pseudo` à `target` (idempotent). */
async function addFollow(pseudo, target, store = blob) {
  const profile = await getProfileRecord(pseudo, store);
  if (!profile.following.some((entry) => pseudoKey(entry) === pseudoKey(target))) {
    profile.following = [...profile.following, target].slice(0, MAX_FOLLOWING);
    profile.updatedAt = new Date().toISOString();
    await writeProfileRecord(profile, store);
  }
  const followers = await readFollowers(target, store);
  if (!followers.some((entry) => pseudoKey(entry) === pseudoKey(pseudo))) {
    await writeFollowers(target, [...followers, pseudo], store);
  }
  return profile;
}

async function removeFollow(pseudo, target, store = blob) {
  const profile = await getProfileRecord(pseudo, store);
  profile.following = profile.following.filter((entry) => pseudoKey(entry) !== pseudoKey(target));
  profile.updatedAt = new Date().toISOString();
  await writeProfileRecord(profile, store);
  const followers = await readFollowers(target, store);
  await writeFollowers(target, followers.filter((entry) => pseudoKey(entry) !== pseudoKey(pseudo)), store);
  return profile;
}

/**
 * Règle d'or du QG : chaque compte suit automatiquement l'Hôte.
 * Appelée à chaque inscription et à chaque connexion (idempotent), les comptes
 * existants sont donc rattrapés sans aucune action de leur part.
 */
export async function ensureHostFollowFor(pseudo, store = blob) {
  const member = normalizePseudo(pseudo);
  if (!member || isOwnerPseudo(member)) return { ok: true, skipped: true };
  try {
    await addFollow(member, OWNER_PSEUDO, store);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/** Rattrape tous les comptes déjà créés (appelé quand l'Hôte ouvre l'admin). */
export async function ensureEveryAccountFollowsHost(store = blob) {
  const pseudos = await listAccountPseudos(store).catch(() => []);
  let updated = 0;
  for (const pseudo of pseudos) {
    if (isOwnerPseudo(pseudo)) continue;
    const profile = await getProfileRecord(pseudo, store);
    if (profile.following.some((entry) => pseudoKey(entry) === OWNER_PSEUDO)) continue;
    const ensured = await ensureHostFollowFor(pseudo, store);
    if (ensured.ok) updated += 1;
  }
  return { updated };
}

/** Profil public complet : identité (compte) + relations + compteurs. */
export async function getPublicProfile(pseudo, { viewer = "" } = {}, store = blob) {
  const pseudos = await listAccountPseudos(store).catch(() => []);
  const resolved = resolvePseudo(pseudo, pseudos);
  if (!resolved) return { ok: false, reason: "not_found" };
  const profile = await getProfileRecord(resolved, store);
  const followers = await readFollowers(resolved, store);
  const viewerProfile = viewer ? await getProfileRecord(viewer, store) : emptyProfile("");
  const viewerKey = pseudoKey(viewer);
  const followsYou = Boolean(viewerKey) && (await readFollowers(viewer, store)).some(
    (entry) => pseudoKey(entry) === pseudoKey(resolved)
  );
  const isFollowing = viewerProfile.following.some((entry) => pseudoKey(entry) === pseudoKey(resolved));
  return {
    ok: true,
    profile: {
      pseudo: resolved,
      isHost: isOwnerPseudo(resolved),
      bio: profile.bio,
      discordUsername: profile.discordUsername,
      followingCount: profile.following.length,
      followersCount: followers.length,
      isFollowing: isOwnerPseudo(resolved) ? true : isFollowing,
      followsYou,
      isBlocked: viewerProfile.blockedUsers.some((entry) => pseudoKey(entry) === pseudoKey(resolved)),
      hasBlockedViewer: profile.blockedUsers.some((entry) => pseudoKey(entry) === viewerKey),
    },
  };
}

/** Suivre / ne plus suivre. L'Hôte ne peut pas être désabonné. */
export async function setFollow({ pseudo, target, follow }, store = blob) {
  const follower = normalizePseudo(pseudo);
  const wanted = normalizePseudo(target);
  if (!follower || !wanted) return { ok: false, reason: "invalid" };
  if (pseudoKey(follower) === pseudoKey(wanted)) return { ok: false, reason: "self" };
  if (pseudoKey(wanted) === pseudoKey(OWNER_PSEUDO)) {
    // Règle d'or : tout le monde suit l'Hôte, définitivement.
    await ensureHostFollowFor(follower, store);
    return { ok: true, following: true, locked: true };
  }
  if (follow === false) {
    await removeFollow(follower, wanted, store);
    return { ok: true, following: false };
  }
  const pseudos = await listAccountPseudos(store).catch(() => []);
  const resolved = resolvePseudo(wanted, pseudos);
  if (!resolved) return { ok: false, reason: "not_found" };
  // Blocage dans un sens ou dans l'autre : aucun abonnement possible.
  const targetProfile = await getProfileRecord(resolved, store);
  const followerProfile = await getProfileRecord(follower, store);
  if (
    targetProfile.blockedUsers.some((entry) => pseudoKey(entry) === pseudoKey(follower)) ||
    followerProfile.blockedUsers.some((entry) => pseudoKey(entry) === pseudoKey(resolved))
  ) {
    return { ok: false, reason: "blocked" };
  }
  await addFollow(follower, resolved, store);
  return { ok: true, following: true };
}

/** Bloquer / débloquer. Bloquer coupe l'abonnement dans les deux sens. */
export async function setBlock({ pseudo, target, blocked }, store = blob) {
  const owner = normalizePseudo(pseudo);
  const wanted = normalizePseudo(target);
  if (!owner || !wanted) return { ok: false, reason: "invalid" };
  if (pseudoKey(owner) === pseudoKey(wanted)) return { ok: false, reason: "self" };
  if (pseudoKey(wanted) === pseudoKey(OWNER_PSEUDO)) return { ok: false, reason: "host" };
  const profile = await getProfileRecord(owner, store);
  if (blocked === false) {
    profile.blockedUsers = profile.blockedUsers.filter((entry) => pseudoKey(entry) !== pseudoKey(wanted));
  } else if (!profile.blockedUsers.some((entry) => pseudoKey(entry) === pseudoKey(wanted))) {
    profile.blockedUsers = [...profile.blockedUsers, wanted].slice(0, MAX_FOLLOWING);
    await removeFollow(owner, wanted, store).catch(() => {});
    await removeFollow(wanted, owner, store).catch(() => {});
  }
  profile.updatedAt = new Date().toISOString();
  await writeProfileRecord(profile, store);
  return { ok: true, blocked: blocked !== false, blockedUsers: profile.blockedUsers };
}

/** Met à jour la bio et le pseudo Discord du profil public d'un membre. */
export async function updateProfileDetails({ pseudo, bio, discordUsername }, store = blob) {
  const owner = normalizePseudo(pseudo);
  if (!owner) return { ok: false, reason: "invalid" };
  const profile = await getProfileRecord(owner, store);
  if (bio !== undefined) profile.bio = cleanText(bio, MAX_BIO);
  if (discordUsername !== undefined) {
    const cleaned = cleanText(discordUsername, MAX_DISCORD).replace(/^@+/u, "");
    if (cleaned && !/^[A-Za-z0-9._-]{2,40}$/u.test(cleaned)) return { ok: false, reason: "discord" };
    profile.discordUsername = cleaned;
  }
  profile.updatedAt = new Date().toISOString();
  await writeProfileRecord(profile, store);
  return { ok: true, profile };
}

/** Le membre peut-il écrire à ce destinataire ? (Hôte : toujours, sinon Validés) */
export function canMessage({ pseudo, target, isTargetHost, senderIsVerified, targetIsVerified }) {
  if (isTargetHost) return true;
  return senderIsVerified === true && targetIsVerified === true && Boolean(pseudo && target);
}

function publicReport(report) {
  return {
    id: report.id,
    targetPseudo: report.targetPseudo || "",
    targetMessageId: report.targetMessageId || "",
    reason: report.reason,
    details: report.details || "",
    reporterPseudo: report.reporterPseudo || "",
    createdAt: report.createdAt,
    status: report.status === "handled" ? "handled" : "open",
  };
}

/** Enregistre un signalement (profil ou message) dans l'état global. */
export async function createReport({ reporterPseudo, targetPseudo, targetMessageId, reason, details }, store = blob) {
  const reporter = normalizePseudo(reporterPseudo);
  const target = normalizePseudo(targetPseudo);
  const label = cleanText(reason, 80);
  if (!target || !REPORT_REASONS.includes(label)) return { ok: false, reason: "reason" };
  if (!reporter) return { ok: false, reason: "reporter" };
  if (pseudoKey(reporter) === pseudoKey(target)) return { ok: false, reason: "self" };
  const id = randomUUID();
  const report = {
    version: 1,
    id,
    targetPseudo: target,
    targetMessageId: isIdentifier(targetMessageId) ? targetMessageId : "",
    reason: label,
    details: cleanText(details, 300),
    reporterPseudo: reporter,
    createdAt: new Date().toISOString(),
    status: "open",
  };
  await writeJson(reportPath(id), report, store);
  await pruneReports(store).catch(() => {});
  return { ok: true, report: publicReport(report) };
}

async function pruneReports(store = blob) {
  const page = await store.list({ prefix: REPORT_PREFIX, limit: 1000 });
  const entries = Array.isArray(page.blobs) ? page.blobs : [];
  if (entries.length <= MAX_REPORTS) return;
  const sorted = entries.sort((left, right) => left.pathname.localeCompare(right.pathname));
  const extra = sorted.slice(0, Math.max(0, sorted.length - MAX_REPORTS)).map((entry) => entry.pathname);
  if (extra.length) await store.del(extra).catch(() => {});
}

/** Liste des signalements (Hôte uniquement), les plus récents d'abord. */
export async function listReports(store = blob) {
  const page = await store.list({ prefix: REPORT_PREFIX, limit: 1000 });
  const reports = [];
  for (const entry of Array.isArray(page.blobs) ? page.blobs : []) {
    const stored = await readJson(entry.pathname, store).catch(() => null);
    if (stored && typeof stored.id === "string" && typeof stored.targetPseudo === "string") {
      reports.push(publicReport(stored));
    }
  }
  reports.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return reports;
}

/** Marque un signalement comme traité, avant ou après l'action de l'Hôte. */
export async function setReportStatus(id, status, store = blob) {
  if (!isIdentifier(id)) return { ok: false, reason: "invalid" };
  const stored = await readJson(reportPath(id), store).catch(() => null);
  if (!stored) return { ok: false, reason: "not_found" };
  const next = { ...stored, status: status === "open" ? "open" : "handled", updatedAt: new Date().toISOString() };
  await writeJson(reportPath(id), next, store);
  return { ok: true, report: publicReport(next) };
}

/** Suppression définitive d'un signalement. */
export async function deleteReport(id, store = blob) {
  if (!isIdentifier(id)) return { ok: false, reason: "invalid" };
  await store.del(reportPath(id)).catch(() => {});
  return { ok: true };
}

export { REPORT_REASONS };

// ---------------------------------------------------------------------------
// Posts publics du fil
// ---------------------------------------------------------------------------
// Un post est un petit objet JSON : gionny/posts/<id>.json
//   { version, id, pseudo, text, createdAt, likedBy: [pseudo…] }
// Seuls l'Hôte et les membres Validés publient (règle du QG) ; tout le monde
// peut liker. Les posts des comptes bloqués sont filtrés à la lecture.

const POST_PREFIX = "gionny/posts/";
const MAX_POSTS = 400;
const MAX_POST_TEXT = 500;

function postPath(id) {
  return `${POST_PREFIX}${id}.json`;
}

// Horloge monotone : deux posts publiés dans la même milliseconde gardent un
// ordre stable dans le fil (le plus récent d'abord).
let lastPostTimestamp = 0;
function nextPostTimestamp() {
  const now = Math.max(Date.now(), lastPostTimestamp + 1);
  lastPostTimestamp = now;
  return new Date(now).toISOString();
}

function normalizePost(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
  const pseudo = normalizePseudo(raw.pseudo);
  const text = cleanText(raw.text, MAX_POST_TEXT);
  if (!pseudo || !text) return null;
  return {
    id: raw.id,
    pseudo,
    text,
    createdAt: typeof raw.createdAt === "string" && Number.isFinite(Date.parse(raw.createdAt))
      ? raw.createdAt
      : new Date().toISOString(),
    likedBy: Array.isArray(raw.likedBy)
      ? [...new Set(raw.likedBy.map((entry) => normalizePseudo(entry)).filter(Boolean))]
      : [],
  };
}

function publicPost(post, { viewer = "", isHost = false, badges = [] } = {}) {
  const viewerKey = pseudoKey(viewer);
  return {
    id: post.id,
    pseudo: post.pseudo,
    text: post.text,
    createdAt: post.createdAt,
    isHost,
    badges: Array.isArray(badges) ? badges : [],
    likes: post.likedBy.length,
    liked: Boolean(viewerKey) && post.likedBy.some((entry) => pseudoKey(entry) === viewerKey),
    canDelete: Boolean(viewerKey) && pseudoKey(post.pseudo) === viewerKey,
  };
}

async function readAllPosts(store = blob) {
  const page = await store.list({ prefix: POST_PREFIX, limit: 1000 });
  const posts = [];
  for (const entry of Array.isArray(page.blobs) ? page.blobs : []) {
    const stored = normalizePost(await readJson(entry.pathname, store).catch(() => null));
    if (stored) posts.push(stored);
  }
  posts.sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return posts;
}

/** Publie un post. Refusé si le compte n'est ni Hôte ni Validé, ou banni. */
export async function createPost({ pseudo, text }, store = blob) {
  const author = normalizePseudo(pseudo);
  const body = cleanText(text, MAX_POST_TEXT);
  if (!author) return { ok: false, reason: "author" };
  if (body.length < 1) return { ok: false, reason: "empty" };
  const accounts = await store.list({ prefix: ACCOUNT_PREFIX, limit: 200 });
  let allowed = false;
  for (const entry of Array.isArray(accounts.blobs) ? accounts.blobs : []) {
    const account = await readJson(entry.pathname, store).catch(() => null);
    if (pseudoKey(account?.pseudo) !== pseudoKey(author)) continue;
    if (account.status === "banned") return { ok: false, reason: "banned" };
    allowed = account.role === "host" || (Array.isArray(account.badges) && account.badges.includes("verified"));
  }
  if (isOwnerPseudo(author)) allowed = true;
  if (!allowed) return { ok: false, reason: "not_allowed" };

  const post = {
    version: 1,
    id: randomUUID(),
    pseudo: author,
    text: body,
    createdAt: nextPostTimestamp(),
    likedBy: [],
  };
  await writeJson(postPath(post.id), post, store);
  const posts = await readAllPosts(store).catch(() => []);
  if (posts.length > MAX_POSTS) {
    const extra = posts.slice(MAX_POSTS).map((entry) => postPath(entry.id));
    if (extra.length) await store.del(extra).catch(() => {});
  }
  return { ok: true, post };
}

/** Liker / ne plus liker (idempotent). */
export async function toggleLike({ pseudo, postId }, store = blob) {
  const liker = normalizePseudo(pseudo);
  if (!liker || !isIdentifier(postId)) return { ok: false, reason: "invalid" };
  const stored = normalizePost(await readJson(postPath(postId), store).catch(() => null));
  if (!stored) return { ok: false, reason: "not_found" };
  const already = stored.likedBy.some((entry) => pseudoKey(entry) === pseudoKey(liker));
  const next = {
    ...stored,
    likedBy: already
      ? stored.likedBy.filter((entry) => pseudoKey(entry) !== pseudoKey(liker))
      : [...stored.likedBy, liker],
  };
  await writeJson(postPath(postId), next, store);
  return { ok: true, liked: !already, likes: next.likedBy.length };
}

export async function deletePost({ pseudo, postId }, store = blob) {
  const actor = normalizePseudo(pseudo);
  if (!actor || !isIdentifier(postId)) return { ok: false, reason: "invalid" };
  const stored = normalizePost(await readJson(postPath(postId), store).catch(() => null));
  if (!stored) return { ok: false, reason: "not_found" };
  const isHost = isOwnerPseudo(actor);
  if (!isHost && pseudoKey(stored.pseudo) !== pseudoKey(actor)) return { ok: false, reason: "forbidden" };
  await store.del(postPath(postId)).catch(() => {});
  return { ok: true };
}

/**
 * Fil de lecture. `mode` = "all" (tout le QG) ou "verified" (Hôte + Validés).
 * `author` limite au profil demandé. Les posts des comptes bloqués (dans un
 * sens ou dans l'autre) ne sortent jamais.
 */
export async function listFeed({ viewer = "", mode = "all", author = "" } = {}, store = blob) {
  const posts = await readAllPosts(store);
  const accounts = new Map();
  const directory = await store.list({ prefix: ACCOUNT_PREFIX, limit: 200 });
  for (const entry of Array.isArray(directory.blobs) ? directory.blobs : []) {
    const account = await readJson(entry.pathname, store).catch(() => null);
    const pseudo = normalizePseudo(account?.pseudo);
    if (!pseudo) continue;
    accounts.set(pseudoKey(pseudo), {
      isHost: account.role === "host" || isOwnerPseudo(pseudo),
      badges: Array.isArray(account.badges) ? account.badges.filter((badge) => badge === "verified") : [],
      banned: account.status === "banned",
    });
  }

  let blocked = new Set();
  if (viewer) {
    const mine = await getProfileRecord(viewer, store);
    blocked = new Set(mine.blockedUsers.map((entry) => pseudoKey(entry)));
    for (const entry of accounts.keys()) {
      const other = await getProfileRecord(entry, store).catch(() => null);
      if (other?.blockedUsers?.some((value) => pseudoKey(value) === pseudoKey(viewer))) blocked.add(entry);
    }
  }

  const wantedAuthor = pseudoKey(author);
  return posts
    .filter((post) => (wantedAuthor ? pseudoKey(post.pseudo) === wantedAuthor : true))
    .filter((post) => {
      const key = pseudoKey(post.pseudo);
      if (blocked.has(key)) return false;
      const info = accounts.get(key) || { isHost: isOwnerPseudo(post.pseudo), badges: [], banned: false };
      if (info.banned) return false;
      if (mode === "verified" && !info.isHost && !info.badges.includes("verified")) return false;
      return true;
    })
    .slice(0, 60)
    .map((post) => {
      const info = accounts.get(pseudoKey(post.pseudo)) || { isHost: isOwnerPseudo(post.pseudo), badges: [] };
      return publicPost(post, { viewer, isHost: info.isHost, badges: info.badges });
    });
}
