export const SOCIAL_FIELDS = [
  { key: "twitch", label: "Twitch" },
  { key: "tiktok", label: "TikTok" },
  { key: "youtube", label: "YouTube" },
  { key: "x", label: "X" },
  { key: "instagram", label: "Instagram" },
  { key: "discord", label: "Discord" },
];

export const WEEKDAYS = [
  { key: "monday", label: "Lundi" },
  { key: "tuesday", label: "Mardi" },
  { key: "wednesday", label: "Mercredi" },
  { key: "thursday", label: "Jeudi" },
  { key: "friday", label: "Vendredi" },
  { key: "saturday", label: "Samedi" },
  { key: "sunday", label: "Dimanche" },
];

export const SOCIAL_INFO_FIELDS = ["twitch", "tiktok", "youtube", "x", "instagram"];

// Bandeau « À la une » : les annonces qui défilent sous l'en-tête.
// Champ facultatif (rétro-compatible) : absent → les textes par défaut restent.
export const MAX_ANNOUNCEMENTS = 8;
export const MAX_ANNOUNCEMENT_LENGTH = 120;

// Rideau « site en travaux » : par défaut le site est fermé au public et seul
// l'hôte peut l'ouvrir depuis le panneau d'administration.
export const SITE_LOCKED_BY_DEFAULT = true;

export const DEFAULT_ANNOUNCEMENTS = [
  "Bienvenue dans le QG de Gionny",
  "Lives Twitch : mardi, mercredi, samedi et dimanche à 22:00",
  "Rejoins le Discord pour ne rien rater",
];

const DEFAULT_SOCIAL_INFO = Object.fromEntries(SOCIAL_INFO_FIELDS.map((key) => [key, ""]));

const DEFAULT_SOCIALS = {
  twitch: "https://www.twitch.tv/7gionny",
  tiktok: "https://www.tiktok.com/@gio_nny",
  youtube: "https://www.youtube.com/@gionnyyy",
  x: "https://x.com/nny_gio",
  instagram: "https://www.instagram.com/nny_gio/",
  discord: "https://discord.gg/nPACfBTnPx",
};

const DEFAULT_LIVE_DAYS = new Set(["tuesday", "wednesday", "saturday", "sunday"]);

const ALLOWED_HOSTS = {
  twitch: new Set(["twitch.tv", "www.twitch.tv"]),
  tiktok: new Set(["tiktok.com", "www.tiktok.com"]),
  youtube: new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]),
  x: new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]),
  instagram: new Set(["instagram.com", "www.instagram.com"]),
  discord: new Set(["discord.gg", "discord.com", "www.discord.com"]),
};

const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function makeDefaultSiteConfig() {
  return {
    version: 1,
    socials: { ...DEFAULT_SOCIALS },
    socialInfo: { ...DEFAULT_SOCIAL_INFO },
    announcements: [...DEFAULT_ANNOUNCEMENTS],
    siteLocked: SITE_LOCKED_BY_DEFAULT,
    schedule: Object.fromEntries(
      WEEKDAYS.map(({ key }) => [
        key,
        { enabled: DEFAULT_LIVE_DAYS.has(key), time: "22:00" },
      ])
    ),
  };
}

function normalizeSocialUrl(key, value) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 300) return null;

  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !ALLOWED_HOSTS[key]?.has(url.hostname.toLowerCase())
    ) {
      return null;
    }

    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

export function validateSiteConfig(input) {
  if (!isRecord(input) || !isRecord(input.socials) || !isRecord(input.schedule)) {
    return { ok: false, error: "Les données du panneau sont incomplètes." };
  }

  const socials = {};
  for (const { key, label } of SOCIAL_FIELDS) {
    const url = normalizeSocialUrl(key, input.socials[key]);
    if (!url) {
      return {
        ok: false,
        error: `Vérifie le lien ${label} : colle une adresse HTTPS valide du réseau.`,
      };
    }
    socials[key] = url;
  }

  const socialInfoInput = input.socialInfo === undefined ? {} : input.socialInfo;
  if (!isRecord(socialInfoInput)) {
    return { ok: false, error: "Vérifie les sous-titres des réseaux sociaux." };
  }

  const socialInfo = {};
  for (const key of SOCIAL_INFO_FIELDS) {
    const value = socialInfoInput[key] ?? "";
    if (typeof value !== "string") {
      return { ok: false, error: "Chaque sous-titre doit être un texte facultatif." };
    }
    const normalized = value
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    if (normalized.length > 120) {
      return { ok: false, error: "Chaque sous-titre peut contenir jusqu’à 120 caractères." };
    }
    socialInfo[key] = normalized;
  }

  const schedule = {};
  for (const { key, label } of WEEKDAYS) {
    const day = input.schedule[key];
    if (
      !isRecord(day) ||
      typeof day.enabled !== "boolean" ||
      typeof day.time !== "string" ||
      !TIME_PATTERN.test(day.time)
    ) {
      return {
        ok: false,
        error: `Vérifie le jour « ${label} » et son heure.`,
      };
    }
    schedule[key] = { enabled: day.enabled, time: day.time };
  }

  // « À la une » : liste facultative de textes courts, éditée dans l'admin.
  let announcements = [...DEFAULT_ANNOUNCEMENTS];
  if (input.announcements !== undefined) {
    if (!Array.isArray(input.announcements)) {
      return { ok: false, error: "Les annonces du bandeau doivent être une liste." };
    }
    const cleaned = [];
    for (const raw of input.announcements.slice(0, MAX_ANNOUNCEMENTS)) {
      if (typeof raw !== "string") {
        return { ok: false, error: "Chaque annonce doit être un texte." };
      }
      const text = raw
        .normalize("NFKC")
        .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
      if (!text) continue;
      if (text.length > MAX_ANNOUNCEMENT_LENGTH) {
        return {
          ok: false,
          error: `Chaque annonce peut contenir jusqu’à ${MAX_ANNOUNCEMENT_LENGTH} caractères.`,
        };
      }
      cleaned.push(text);
    }
    announcements = cleaned;
  }

  // Rideau d'accès : absent → fermé (le site démarre en travaux), sinon on
  // respecte strictement le booléen enregistré par l'hôte.
  const siteLocked = typeof input.siteLocked === "boolean" ? input.siteLocked : SITE_LOCKED_BY_DEFAULT;

  return { ok: true, config: { version: 1, socials, socialInfo, schedule, announcements, siteLocked } };
}

export function readStoredSiteConfig(value) {
  const result = validateSiteConfig(value?.config ?? value);
  return result.ok ? result.config : makeDefaultSiteConfig();
}
