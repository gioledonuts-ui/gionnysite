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
    version: 2,
    pseudo,
    bio: "",
    // Liaison Discord traçable : l'ID ne change jamais, le pseudo peut changer.
    discordUsername: "",
    discordId: "",
    discordLinkedAt: "",
    // Confidentialité : un compte privé cache son activité aux non-abonnés.
    isPrivate: false,
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
    // L'ID est fourni par Discord (jamais saisi à la main) : on ne garde que des
    // chiffres, et le compte Hôte reste toujours public.
    discordId: /^\d{15,25}$/u.test(typeof raw.discordId === "string" ? raw.discordId : "") ? raw.discordId : "",
    discordLinkedAt: typeof raw.discordLinkedAt === "string" && Number.isFinite(Date.parse(raw.discordLinkedAt))
      ? raw.discordLinkedAt
      : "",
    isPrivate: raw.isPrivate === true && !isOwnerPseudo(pseudo),
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
  const isHost = isOwnerPseudo(resolved);
  const viewerIsHost = Boolean(viewerKey) && isOwnerPseudo(viewer);
  // Confidentialité : Gionny voit tout, le propriétaire aussi. Sinon un compte
  // privé n'ouvre son activité qu'à ses abonnés.
  const isSelf = Boolean(viewerKey) && viewerKey === pseudoKey(resolved);
  const canSeeActivity = !profile.isPrivate || isHost || isSelf || viewerIsHost || isFollowing;
  return {
    ok: true,
    profile: {
      pseudo: resolved,
      isHost,
      bio: profile.bio,
      discordUsername: profile.discordUsername,
      discordLinkedAt: profile.discordLinkedAt,
      isPrivate: profile.isPrivate,
      canSeeActivity,
      privateMessage: canSeeActivity
        ? ""
        : "Ce compte est privé. Seuls ses abonnés approuvés et le QG peuvent voir son activité.",
      followingCount: profile.following.length,
      followersCount: followers.length,
      isFollowing: isHost ? true : isFollowing,
      followsYou,
      isBlocked: viewerProfile.blockedUsers.some((entry) => pseudoKey(entry) === pseudoKey(resolved)),
      hasBlockedViewer: profile.blockedUsers.some((entry) => pseudoKey(entry) === pseudoKey(viewer)),
    },
  };
}

/**
 * Confidentialité du compte (switch « Passer mon compte en privé »).
 * L'Hôte reste toujours public : c'est la vitrine du QG.
 */
export async function setProfilePrivacy({ pseudo, isPrivate }, store = blob) {
  const owner = normalizePseudo(pseudo);
  if (!owner) return { ok: false, reason: "invalid" };
  if (isOwnerPseudo(owner)) return { ok: false, reason: "host_public" };
  const profile = await getProfileRecord(owner, store);
  profile.isPrivate = isPrivate === true;
  profile.updatedAt = new Date().toISOString();
  await writeProfileRecord(profile, store);
  return { ok: true, isPrivate: profile.isPrivate };
}

/**
 * Liaison Discord persistée sur le profil social (le compte reste la source de
 * vérité de l'identité). Refuse un ID déjà lié à un autre compte du QG.
 */
export async function linkProfileDiscord({ pseudo, discordId, discordUsername }, store = blob) {
  const owner = normalizePseudo(pseudo);
  if (!owner) return { ok: false, reason: "invalid" };
  const id = typeof discordId === "string" ? discordId.trim() : "";
  if (!/^\d{15,25}$/u.test(id)) return { ok: false, reason: "discord_id" };
  const username = cleanText(discordUsername, MAX_DISCORD).replace(/^@+/u, "");
  if (!username) return { ok: false, reason: "discord_username" };

  // Unicité : aucun autre profil ne peut porter cet ID.
  const conflict = await findProfileByDiscordId(id, store);
  if (conflict && pseudoKey(conflict) !== pseudoKey(owner)) {
    return { ok: false, reason: "discord_taken", pseudo: conflict };
  }

  const profile = await getProfileRecord(owner, store);
  profile.discordId = id;
  profile.discordUsername = username;
  profile.discordLinkedAt = profile.discordLinkedAt || new Date().toISOString();
  profile.updatedAt = new Date().toISOString();
  await writeProfileRecord(profile, store);
  return {
    ok: true,
    discord: {
      discordId: profile.discordId,
      discordUsername: profile.discordUsername,
      discordLinkedAt: profile.discordLinkedAt,
    },
  };
}

/** Retire la liaison Discord du profil social. */
export async function unlinkProfileDiscord({ pseudo }, store = blob) {
  const owner = normalizePseudo(pseudo);
  if (!owner) return { ok: false, reason: "invalid" };
  const profile = await getProfileRecord(owner, store);
  profile.discordId = "";
  profile.discordUsername = "";
  profile.discordLinkedAt = "";
  profile.updatedAt = new Date().toISOString();
  await writeProfileRecord(profile, store);
  return { ok: true };
}

/** Pseudo du profil déjà lié à cet ID Discord (ou chaîne vide). */
async function findProfileByDiscordId(discordId, store = blob) {
  if (!/^\d{15,25}$/u.test(discordId)) return "";
  let cursor = "";
  let hasMore = true;
  while (hasMore) {
    const page = await store.list({ prefix: PROFILE_PREFIX, limit: 200, ...(cursor ? { cursor } : {}) });
    for (const entry of Array.isArray(page.blobs) ? page.blobs : []) {
      const stored = await readJson(entry.pathname, store).catch(() => null);
      if (stored?.discordId === discordId && normalizePseudo(stored.pseudo)) return normalizePseudo(stored.pseudo);
    }
    hasMore = page.hasMore === true && typeof page.cursor === "string";
    cursor = hasMore ? page.cursor : "";
  }
  return "";
}

/** Liste des pseudos bloqués par ce compte (section « Comptes bloqués »). */
export async function listBlockedUsers({ pseudo } = {}, store = blob) {
  const viewer = normalizePseudo(pseudo);
  if (!viewer) return [];
  const profile = await getProfileRecord(viewer, store);
  return profile.blockedUsers;
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
  // « @pseudo a commencé à te suivre » : la notification part une seule fois
  // par couple (le modèle regroupe par référence).
  await pushNotification({
    recipient: resolved,
    actor: follower,
    type: "follow",
    reference: `follow:${pseudoKey(follower)}`,
  }, store).catch(() => {});
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
//   { version, id, pseudo, text, createdAt, likedBy: [pseudo…],
//     repostedBy: [pseudo…], media: { kind, path, alt, duration } | null,
//     quoteOf: <id> | "" }
//
// Médias : le fichier vit à côté du post, dans l'état durable, et n'est lu que
// par /api/profile?media=1 (jamais exposé en data-URL dans le JSON du fil) :
//   gionny/posts/<id>-image.webp    photo compressée côté navigateur (≤ 120 Ko)
//   gionny/posts/<id>-vocal.webm    message vocal (≤ 200 Ko, ≤ 60 s)
//   gionny/posts/<id>-video.mp4     vidéo compressée côté navigateur (≤ 3 Mo)
//
// Règles : seuls l'Hôte et les membres Validés publient ; tout le monde peut
// liker et reposter. Les posts des comptes bloqués sont filtrés à la lecture.

const POST_PREFIX = "gionny/posts/";
const NOTIF_PREFIX = "gionny/notifications/";
const MAX_POSTS = 400;
// Les médias vivent dans le même état (et donc dans la ligne Supabase) : on
// plafonne leur poids total pour que la sauvegarde reste sûre et rapide.
// Au-delà, les plus vieux médias sont retirés (le post texte reste lisible).
const MEDIA_KINDS_FOR_PRUNE = ["image", "vocal", "video"];
const MAX_MEDIA_BYTES_TOTAL = 12 * 1024 * 1024;
const MAX_POST_TEXT = 500;
const MAX_NOTIFICATIONS = 40;
const MAX_NOTIFICATION_ACTORS = 100;

const MEDIA_KINDS = ["image", "vocal", "video"];

function postPath(id) {
  return `${POST_PREFIX}${id}.json`;
}

function postMediaPath(id, kind) {
  const extension = kind === "image" ? "webp" : kind === "vocal" ? "webm" : "mp4";
  return `${POST_PREFIX}${id}-${kind}.${extension}`;
}

function notificationPath(id) {
  return `${NOTIF_PREFIX}${id}.json`;
}

// Horloge monotone : deux posts publiés dans la même milliseconde gardent un
// ordre stable dans le fil (le plus récent d'abord).
let lastPostTimestamp = 0;
function nextPostTimestamp() {
  const now = Math.max(Date.now(), lastPostTimestamp + 1);
  lastPostTimestamp = now;
  return new Date(now).toISOString();
}

/** Normalise le descripteur de média (jamais le contenu, seulement l'entrée). */
function normalizeMedia(raw) {
  if (!raw || typeof raw !== "object") return null;
  const kind = MEDIA_KINDS.includes(raw.kind) ? raw.kind : "";
  if (!kind) return null;
  const duration = Number(raw.duration);
  return {
    kind,
    alt: cleanText(raw.alt, 200),
    duration: Number.isFinite(duration) && duration > 0 ? Math.min(60, Math.round(duration)) : 0,
  };
}

function normalizePost(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.id !== "string") return null;
  const pseudo = normalizePseudo(raw.pseudo);
  const text = cleanText(raw.text, MAX_POST_TEXT);
  const media = normalizeMedia(raw.media);
  if (!pseudo || (!text && !media)) return null;
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
    repostedBy: Array.isArray(raw.repostedBy)
      ? [...new Set(raw.repostedBy.map((entry) => normalizePseudo(entry)).filter(Boolean))]
      : [],
    media,
    quoteOf: isIdentifier(raw.quoteOf) ? raw.quoteOf : "",
    pinned: raw.pinned === true,
  };
}

function publicPost(post, { viewer = "", isHost = false, badges = [] } = {}) {
  const viewerKey = pseudoKey(viewer);
  const repostedBy = Array.isArray(post.repostedBy) ? post.repostedBy : [];
  return {
    id: post.id,
    pseudo: post.pseudo,
    handle: `@${String(post.pseudo || "").replace(/\s+/gu, "")}`,
    text: post.text,
    createdAt: post.createdAt,
    isHost,
    badges: Array.isArray(badges) ? badges : [],
    likes: post.likedBy.length,
    liked: Boolean(viewerKey) && post.likedBy.some((entry) => pseudoKey(entry) === viewerKey),
    reposts: repostedBy.length,
    reposted: Boolean(viewerKey) && repostedBy.some((entry) => pseudoKey(entry) === viewerKey),
    // Le dernier reposteur alimente la ligne « Republié par @pseudo ».
    repostedBy: repostedBy[repostedBy.length - 1] || "",
    pinned: post.pinned === true,
    canDelete: Boolean(viewerKey) && pseudoKey(post.pseudo) === viewerKey,
    canPin: Boolean(viewerKey) && isOwnerPseudo(viewer),
    permalink: `/post/${post.id}`,
    media: post.media
      ? { ...post.media, url: `/api/profile?media=1&post=${encodeURIComponent(post.id)}&kind=${post.media.kind}` }
      : null,
    quoteOf: post.quoteOf,
  };
}

async function readAllPosts(store = blob) {
  const page = await store.list({ prefix: POST_PREFIX, limit: 1000 });
  const posts = [];
  for (const entry of Array.isArray(page.blobs) ? page.blobs : []) {
    // Les fichiers médias vivent sous le même préfixe : on ne lit que le JSON.
    if (!entry.pathname.endsWith(".json")) continue;
    const stored = normalizePost(await readJson(entry.pathname, store).catch(() => null));
    if (stored) posts.push(stored);
  }
  posts.sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return Date.parse(right.createdAt) - Date.parse(left.createdAt);
  });
  return posts;
}

async function readPost(id, store = blob) {
  if (!isIdentifier(id)) return null;
  return normalizePost(await readJson(postPath(id), store).catch(() => null));
}

/** Le compte peut-il publier ? (Hôte, ou membre Validé, jamais un banni) */
async function canPublish(pseudo, store = blob) {
  const author = normalizePseudo(pseudo);
  if (!author) return { ok: false, reason: "author" };
  if (isOwnerPseudo(author)) return { ok: true };
  const accounts = await store.list({ prefix: ACCOUNT_PREFIX, limit: 200 });
  for (const entry of Array.isArray(accounts.blobs) ? accounts.blobs : []) {
    const account = await readJson(entry.pathname, store).catch(() => null);
    if (pseudoKey(account?.pseudo) !== pseudoKey(author)) continue;
    if (account.status === "banned") return { ok: false, reason: "banned" };
    const allowed = account.role === "host" ||
      (Array.isArray(account.badges) && account.badges.includes("verified"));
    return allowed ? { ok: true } : { ok: false, reason: "not_allowed" };
  }
  return { ok: false, reason: "not_allowed" };
}

/**
 * Publie un post (texte, image, vocal, vidéo — au moins un contenu requis).
 * `media` ne transporte que le descripteur ; le binaire arrive ensuite par
 * `attachPostMedia`, une fois le post créé.
 */
export async function createPost({ pseudo, text, media = null, quoteOf = "" }, store = blob) {
  const author = normalizePseudo(pseudo);
  if (!author) return { ok: false, reason: "author" };
  const body = cleanText(text, MAX_POST_TEXT);
  const descriptor = normalizeMedia(media);
  if (!body && !descriptor) return { ok: false, reason: "empty" };
  const allowed = await canPublish(author, store);
  if (!allowed.ok) return allowed;

  let quoted = "";
  if (isIdentifier(quoteOf)) {
    const original = await readPost(quoteOf, store);
    if (original) quoted = original.id;
  }

  const post = {
    version: 2,
    id: randomUUID(),
    pseudo: author,
    text: body,
    createdAt: nextPostTimestamp(),
    likedBy: [],
    repostedBy: [],
    media: descriptor,
    quoteOf: quoted,
  };
  await writeJson(postPath(post.id), post, store);
  // Un post officiel de l'Hôte est annoncé à toute la communauté connectée.
  if (isOwnerPseudo(author)) {
    await broadcastHostPost(post, store).catch(() => {});
  }
  const posts = await readAllPosts(store).catch(() => []);
  if (posts.length > MAX_POSTS) {
    const extra = posts.slice(MAX_POSTS);
    const paths = [];
    for (const entry of extra) {
      for (const kind of [null, ...MEDIA_KINDS]) {
        paths.push(kind ? postMediaPath(entry.id, kind) : postPath(entry.id));
      }
    }
    await store.del(paths).catch(() => {});
  }
  return { ok: true, post };
}

/**
 * Diffuse un post de l'Hôte à tous les comptes (sauf l'Hôte lui-même) :
 * chacun reçoit « Gionny a publié un nouveau post dans le QG ».
 */
async function broadcastHostPost(post, store = blob) {
  const pseudos = await listAccountPseudos(store).catch(() => []);
  const preview = cleanText(post.text, 120)
    || (post.media?.kind === "image" ? "Photo publiée par Gionny"
      : post.media?.kind === "video" ? "Vidéo publiée par Gionny"
      : post.media?.kind === "vocal" ? "Vocal publié par Gionny"
      : "Nouveau post officiel");
  let sent = 0;
  for (const pseudo of pseudos) {
    if (isOwnerPseudo(pseudo)) continue;
    const created = await pushNotification({
      recipient: pseudo,
      actor: post.pseudo,
      type: "post",
      postId: post.id,
      preview,
    }, store).catch(() => ({ ok: false }));
    if (created.ok) sent += 1;
  }
  return { sent };
}

/** Enregistre le binaire d'un média sur un post déjà créé. */
export async function attachPostMedia({ pseudo, postId, kind, bytes, contentType }, store = blob) {
  const author = normalizePseudo(pseudo);
  if (!author || !isIdentifier(postId) || !MEDIA_KINDS.includes(kind)) {
    return { ok: false, reason: "invalid" };
  }
  const stored = await readPost(postId, store);
  if (!stored) return { ok: false, reason: "not_found" };
  if (!isOwnerPseudo(author) && pseudoKey(stored.pseudo) !== pseudoKey(author)) {
    return { ok: false, reason: "forbidden" };
  }
  if (!stored.media || stored.media.kind !== kind) return { ok: false, reason: "invalid" };
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!buffer.length) return { ok: false, reason: "invalid" };
  await store.put(postMediaPath(postId, kind), buffer, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: contentType || (kind === "image" ? "image/webp" : kind === "vocal" ? "audio/webm" : "video/mp4"),
  });
  await pruneMediaBudget(store).catch(() => {});
  return { ok: true };
}

/** Lit le binaire d'un média de post (route /api/profile?media=1). */
export async function readPostMedia({ postId, kind }, store = blob) {
  if (!isIdentifier(postId) || !MEDIA_KINDS.includes(kind)) return null;
  const stored = await readPost(postId, store);
  if (!stored || !stored.media || stored.media.kind !== kind) return null;
  const result = await store.get(postMediaPath(postId, kind)).catch(() => null);
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  return {
    stream: result.stream,
    contentType: result.blob?.contentType ||
      (kind === "image" ? "image/webp" : kind === "vocal" ? "audio/webm" : "video/mp4"),
    size: result.blob?.size || 0,
  };
}

/**
 * Purge les médias les plus anciens tant que la somme dépasse le plafond.
 * Le post lui-même n'est jamais supprimé : seul le fichier lourd disparaît,
 * et l'API média répond alors proprement 404.
 */
async function pruneMediaBudget(store = blob) {
  const page = await store.list({ prefix: POST_PREFIX, limit: 1000 });
  const media = (Array.isArray(page.blobs) ? page.blobs : [])
    .filter((entry) => MEDIA_KINDS_FOR_PRUNE.some((kind) => entry.pathname.endsWith(`-${kind}.${kind === "image" ? "webp" : kind === "vocal" ? "webm" : "mp4"}`)))
    .map((entry) => ({ pathname: entry.pathname, size: Number(entry.size) || 0 }))
    .sort((left, right) => left.pathname.localeCompare(right.pathname));
  let total = media.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= MAX_MEDIA_BYTES_TOTAL) return { removed: 0, total };
  const drop = [];
  for (const entry of media) {
    if (total <= MAX_MEDIA_BYTES_TOTAL) break;
    drop.push(entry.pathname);
    total -= entry.size;
  }
  if (drop.length) await store.del(drop).catch(() => {});
  return { removed: drop.length, total };
}

/** Liker / ne plus liker (idempotent). Notifie l'auteur au premier like. */
export async function toggleLike({ pseudo, postId }, store = blob) {
  const liker = normalizePseudo(pseudo);
  if (!liker || !isIdentifier(postId)) return { ok: false, reason: "invalid" };
  const stored = await readPost(postId, store);
  if (!stored) return { ok: false, reason: "not_found" };
  const already = stored.likedBy.some((entry) => pseudoKey(entry) === pseudoKey(liker));
  const next = {
    ...stored,
    likedBy: already
      ? stored.likedBy.filter((entry) => pseudoKey(entry) !== pseudoKey(liker))
      : [...stored.likedBy, liker],
  };
  await writeJson(postPath(postId), next, store);
  if (!already) {
    await pushNotification({
      recipient: stored.pseudo,
      actor: liker,
      type: "like",
      postId,
      preview: stored.text,
    }, store).catch(() => {});
  }
  return { ok: true, liked: !already, likes: next.likedBy.length };
}

/** Reposter / annuler un repost (idempotent). Notifie l'auteur au premier. */
export async function toggleRepost({ pseudo, postId }, store = blob) {
  const actor = normalizePseudo(pseudo);
  if (!actor || !isIdentifier(postId)) return { ok: false, reason: "invalid" };
  const stored = await readPost(postId, store);
  if (!stored) return { ok: false, reason: "not_found" };
  const viewerProfile = await getProfileRecord(actor, store);
  if (viewerProfile.blockedUsers.some((entry) => pseudoKey(entry) === pseudoKey(stored.pseudo))) {
    return { ok: false, reason: "blocked" };
  }
  const already = stored.repostedBy.some((entry) => pseudoKey(entry) === pseudoKey(actor));
  const next = {
    ...stored,
    repostedBy: already
      ? stored.repostedBy.filter((entry) => pseudoKey(entry) !== pseudoKey(actor))
      : [...stored.repostedBy, actor],
  };
  await writeJson(postPath(postId), next, store);
  if (!already) {
    await pushNotification({
      recipient: stored.pseudo,
      actor,
      type: "repost",
      postId,
      preview: stored.text,
    }, store).catch(() => {});
  }
  return { ok: true, reposted: !already, reposts: next.repostedBy.length };
}

/**
 * Épingle / désépingle un post. Réservé à l'Hôte : l'épinglage est éditorial,
 * il met en avant une annonce du QG. Un seul post épinglé à la fois.
 */
export async function setPinned({ pseudo, postId, pinned }, store = blob) {
  const actor = normalizePseudo(pseudo);
  if (!actor || !isIdentifier(postId)) return { ok: false, reason: "invalid" };
  if (!isOwnerPseudo(actor)) return { ok: false, reason: "forbidden" };
  const stored = await readPost(postId, store);
  if (!stored) return { ok: false, reason: "not_found" };
  if (pinned !== false) {
    // On désépingle d'abord tout le reste : un seul post en tête du QG.
    const others = await readAllPosts(store);
    for (const post of others) {
      if (post.pinned && post.id !== postId) {
        await writeJson(postPath(post.id), { ...post, pinned: false }, store);
      }
    }
  }
  await writeJson(postPath(postId), { ...stored, pinned: pinned !== false }, store);
  return { ok: true, pinned: pinned !== false };
}

export async function deletePost({ pseudo, postId }, store = blob) {
  const actor = normalizePseudo(pseudo);
  if (!actor || !isIdentifier(postId)) return { ok: false, reason: "invalid" };
  const stored = await readPost(postId, store);
  if (!stored) return { ok: false, reason: "not_found" };
  const isHost = isOwnerPseudo(actor);
  if (!isHost && pseudoKey(stored.pseudo) !== pseudoKey(actor)) return { ok: false, reason: "forbidden" };
  const paths = [postPath(postId), ...MEDIA_KINDS.map((kind) => postMediaPath(postId, kind))];
  await store.del(paths).catch(() => {});
  await removePostNotifications(postId, store).catch(() => {});
  return { ok: true };
}

/** Retire d'un coup les notifications qui pointaient vers un post supprimé. */
async function removePostNotifications(postId, store = blob) {
  const page = await store.list({ prefix: NOTIF_PREFIX, limit: 1000 });
  for (const entry of Array.isArray(page.blobs) ? page.blobs : []) {
    if (!entry.pathname.endsWith(".json")) continue;
    const raw = await readJson(entry.pathname, store).catch(() => null);
    if (!Array.isArray(raw?.items)) continue;
    const kept = raw.items.filter((item) => item?.postId !== postId);
    if (kept.length !== raw.items.length) {
      await writeJson(entry.pathname, { ...raw, items: kept, updatedAt: new Date().toISOString() }, store);
    }
  }
}

// ---------------------------------------------------------------------------
// Notifications (likes et reposts reçus)
// ---------------------------------------------------------------------------
// Une notification par destinataire et par post : les acteurs s'empilent, donc
// 100 likes ne créent pas 100 entrées. Le tout vit dans l'état durable.
//   gionny/notifications/<pseudo>.json
//   { version, pseudo, updatedAt, items: [{ id, type, postId, preview,
//     actors: [pseudo…], count, createdAt, readAt }] }

function notificationOwner(pseudo) {
  return `${NOTIF_PREFIX}${encodeURIComponent(pseudoKey(pseudo))}.json`;
}

async function readNotifications(pseudo, store = blob) {
  if (!pseudoKey(pseudo)) return { version: 1, pseudo: "", updatedAt: "", items: [] };
  const raw = await readJson(notificationOwner(pseudo), store).catch(() => null);
  const items = Array.isArray(raw?.items)
    ? raw.items
        .filter((item) => item && typeof item.id === "string")
        .map((item) => ({
          id: item.id,
          type: ["like", "repost", "follow", "post"].includes(item.type) ? item.type : "like",
          postId: typeof item.postId === "string" ? item.postId : "",
          reference: typeof item.reference === "string" ? item.reference : "",
          preview: cleanText(item.preview, 120),
          actors: Array.isArray(item.actors)
            ? [...new Set(item.actors.map((entry) => normalizePseudo(entry)).filter(Boolean))].slice(0, MAX_NOTIFICATION_ACTORS)
            : [],
          createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
          readAt: typeof item.readAt === "string" ? item.readAt : "",
        }))
        .slice(0, MAX_NOTIFICATIONS)
    : [];
  return {
    version: 1,
    pseudo: normalizePseudo(raw?.pseudo) || normalizePseudo(pseudo),
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : "",
    items,
  };
}

async function writeNotifications(pseudo, items, store = blob) {
  const payload = {
    version: 1,
    pseudo: normalizePseudo(pseudo),
    updatedAt: new Date().toISOString(),
    items: items.slice(0, MAX_NOTIFICATIONS),
  };
  await writeJson(notificationOwner(pseudo), payload, store);
  return payload;
}

/**
 * Ajoute (ou rafraîchit) une notification. Aucune notification pour soi-même,
 * et jamais pour un compte qui a bloqué l'acteur.
 */
export async function pushNotification({ recipient, actor, type, postId = "", preview = "", reference = "" }, store = blob) {
  const target = normalizePseudo(recipient);
  const source = normalizePseudo(actor);
  const kind = ["like", "repost", "follow", "post"].includes(type) ? type : "like";
  if (!target || !source) return { ok: false, reason: "invalid" };
  // Un like / repost / post doit cibler un post ; un follow n'en a pas.
  if (kind !== "follow" && !isIdentifier(postId)) return { ok: false, reason: "invalid" };
  if (pseudoKey(target) === pseudoKey(source)) return { ok: false, reason: "self" };
  const targetProfile = await getProfileRecord(target, store);
  if (targetProfile.blockedUsers.some((entry) => pseudoKey(entry) === pseudoKey(source))) {
    return { ok: false, reason: "blocked" };
  }
  const current = await readNotifications(target, store);
  // Une notification par (type, post) — un follow est unique par référent.
  const existing = current.items.find((item) =>
    item.type === kind && (kind === "follow" ? item.reference === reference : item.postId === postId)
  );
  const items = existing
    ? current.items.map((item) =>
        item === existing
          ? {
              ...item,
              actors: [source, ...item.actors.filter((entry) => pseudoKey(entry) !== pseudoKey(source))]
                .slice(0, MAX_NOTIFICATION_ACTORS),
              preview: cleanText(preview, 120) || item.preview,
              createdAt: new Date().toISOString(),
              readAt: "",
            }
          : item
      )
    : [
        {
          id: randomUUID(),
          type: kind,
          postId: isIdentifier(postId) ? postId : "",
          reference: cleanText(reference, 80),
          preview: cleanText(preview, 120),
          actors: [source],
          createdAt: new Date().toISOString(),
          readAt: "",
        },
        ...current.items,
      ];
  await writeNotifications(target, items, store);
  return { ok: true };
}

/** Notifications d'un membre, acteurs résolus en identités publiques. */
export async function listNotifications({ viewer } = {}, store = blob) {
  const pseudo = normalizePseudo(viewer);
  if (!pseudo) return [];
  const data = await readNotifications(pseudo, store);
  const accounts = new Map();
  const directory = await store.list({ prefix: ACCOUNT_PREFIX, limit: 200 });
  for (const entry of Array.isArray(directory.blobs) ? directory.blobs : []) {
    const account = await readJson(entry.pathname, store).catch(() => null);
    const name = normalizePseudo(account?.pseudo);
    if (name) accounts.set(pseudoKey(name), account);
  }
  // Un acteur bloqué par le lecteur disparaît aussi des notifications déjà
  // reçues : bloquer coupe réellement le contact dans les deux sens.
  const mine = await getProfileRecord(pseudo, store);
  const blocked = new Set(mine.blockedUsers.map((entry) => pseudoKey(entry)));
  return data.items
    .map((item) => ({ ...item, actors: item.actors.filter((name) => !blocked.has(pseudoKey(name))) }))
    .filter((item) => item.actors.length > 0)
    .map((item) => {
      const actors = item.actors.map((name) => {
        const account = accounts.get(pseudoKey(name));
        return {
          pseudo: name,
          isHost: isOwnerPseudo(name),
          badges: Array.isArray(account?.badges) ? account.badges.filter((badge) => badge === "verified") : [],
          avatarData: typeof account?.avatarData === "string" ? account.avatarData : "",
        };
      });
      return {
        ...item,
        read: Boolean(item.readAt),
        count: actors.length,
        actors,
      };
    });
}

/** Marque toutes les notifications comme lues (badge de la nav remis à zéro). */
export async function markNotificationsRead({ viewer } = {}, store = blob) {
  const pseudo = normalizePseudo(viewer);
  if (!pseudo) return { ok: false, reason: "invalid", unread: 0 };
  const data = await readNotifications(pseudo, store);
  const now = new Date().toISOString();
  const items = data.items.map((item) => (item.readAt ? item : { ...item, readAt: now }));
  await writeNotifications(pseudo, items, store);
  return { ok: true, unread: 0 };
}

/** Compte des notifications non lues (badge « Notifications »). */
export async function countUnreadNotifications({ viewer } = {}, store = blob) {
  const pseudo = normalizePseudo(viewer);
  if (!pseudo) return 0;
  const data = await readNotifications(pseudo, store);
  return data.items.filter((item) => !item.readAt).length;
}

/**
 * Fil de lecture. `mode` = "all" (tout le QG) ou "verified" (Hôte + Validés),
 * `mode` = "reposts" (ce que le QG a reposté), `mode` = "likes" (les posts
 * likés par `viewer`). `author` limite au profil demandé. Les posts des comptes
 * bloqués (dans un sens ou dans l'autre) ne sortent jamais.
 */
export async function listFeed({ viewer = "", mode = "all", author = "", hideUnverified = false } = {}, store = blob) {
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

  const viewerKey = pseudoKey(viewer);
  const wantedAuthor = pseudoKey(author);
  // Confidentialité : l'activité d'un compte privé n'est lisible que par ses
  // abonnés, par lui-même et par l'Hôte (qui voit toujours tout).
  if (wantedAuthor) {
    const authorProfile = await getProfileRecord(author, store).catch(() => null);
    if (authorProfile?.isPrivate) {
      const allowed = viewerKey === wantedAuthor || isOwnerPseudo(viewer) ||
        (await getProfileRecord(viewer, store).catch(() => null))?.following?.some(
          (entry) => pseudoKey(entry) === wantedAuthor
        );
      if (!allowed) return [];
    }
  }
  // « Suivis » : les posts des comptes que le lecteur suit réellement.
  let following = new Set();
  if (mode === "follows") {
    if (!viewerKey) return [];
    const mine = await getProfileRecord(viewer, store);
    following = new Set(mine.following.map((entry) => pseudoKey(entry)));
  }
  return posts
    .filter((post) => (wantedAuthor ? pseudoKey(post.pseudo) === wantedAuthor : true))
    .filter((post) => (mode === "follows" ? following.has(pseudoKey(post.pseudo)) : true))
    .filter((post) => {
      // Un repost n'est jamais anonyme : il n'y a pas de repost sans auteur.
      if (mode === "reposts" && !post.repostedBy.length) return false;
      if (mode === "likes" && !post.likedBy.some((entry) => pseudoKey(entry) === viewerKey)) return false;
      return true;
    })
    .filter((post) => {
      const key = pseudoKey(post.pseudo);
      if (blocked.has(key)) return false;
      const info = accounts.get(key) || { isHost: isOwnerPseudo(post.pseudo), badges: [], banned: false };
      if (info.banned) return false;
      if (mode === "verified" && !info.isHost && !info.badges.includes("verified")) return false;
      // Préférence « Masquer les comptes non-validés », activée par défaut :
      // le fil ne met en avant que Gionny et les membres Validés ✓.
      if (hideUnverified && !info.isHost && !info.badges.includes("verified")) return false;
      return true;
    })
    .slice(0, 60)
    .map((post) => {
      const info = accounts.get(pseudoKey(post.pseudo)) || { isHost: isOwnerPseudo(post.pseudo), badges: [] };
      return publicPost(post, { viewer, isHost: info.isHost, badges: info.badges });
    });
}

export { MEDIA_KINDS };
