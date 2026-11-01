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

  return { ok: true, config: { version: 1, socials, schedule } };
}

export function readStoredSiteConfig(value) {
  const result = validateSiteConfig(value?.config ?? value);
  return result.ok ? result.config : makeDefaultSiteConfig();
}
