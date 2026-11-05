(() => {
  "use strict";

  // -------------------------------------------------------------------------
  // Page d'attente « SITE EN TRAVAUX »
  // -------------------------------------------------------------------------
  // Elle lit le site config partagé (links + planning) et propose un accès
  // hôte : si la session admin est valide, un bouton « Entrer sur le site »
  // apparaît et redirige vers la vraie page.
  // -------------------------------------------------------------------------

  const WEEKDAYS = [
    ["monday", "Lundi"],
    ["tuesday", "Mardi"],
    ["wednesday", "Mercredi"],
    ["thursday", "Jeudi"],
    ["friday", "Vendredi"],
    ["saturday", "Samedi"],
    ["sunday", "Dimanche"],
  ];
  const DAY_INDEX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

  const SAFE_HOSTS = {
    twitch: ["twitch.tv", "www.twitch.tv"],
    tiktok: ["tiktok.com", "www.tiktok.com"],
    youtube: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"],
    x: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
    instagram: ["instagram.com", "www.instagram.com"],
    discord: ["discord.gg", "discord.com", "www.discord.com"],
  };

  const scheduleTimeNode = document.querySelector("[data-schedule-time]");
  const scheduleDaysNode = document.querySelector("[data-schedule-days]");
  const countdownNode = document.querySelector("[data-next-live-countdown]");
  const countdownValue = document.querySelector("[data-next-live-value]");

  const safeUrl = (key, value) => {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const url = new URL(value.trim());
      if (url.protocol !== "https:") return "";
      if (!(SAFE_HOSTS[key] || []).includes(url.hostname.toLowerCase())) return "";
      url.hash = "";
      return url.href;
    } catch {
      return "";
    }
  };

  const applyLinks = (socials) => {
    document.querySelectorAll("[data-config-link]").forEach((link) => {
      const url = safeUrl(link.dataset.configLink, socials?.[link.dataset.configLink]);
      if (url) link.href = url;
    });
  };

  const formatTime = (time) => String(time || "").replace(":", "h");

  const readParisNow = () => new Date();

  const nextLiveAt = (schedule) => {
    const now = readParisNow();
    for (let offset = 0; offset < 8; offset += 1) {
      const probe = new Date(now.getTime() + offset * 86_400_000);
      const key = Object.keys(DAY_INDEX).find((day) => DAY_INDEX[day] === probe.getDay());
      const day = schedule?.[key];
      if (!day?.enabled || !/^\d{2}:\d{2}$/u.test(day.time || "")) continue;
      const [hours, minutes] = day.time.split(":").map(Number);
      const target = new Date(probe);
      target.setHours(hours, minutes, 0, 0);
      if (target.getTime() > now.getTime()) return target;
    }
    return null;
  };

  let nextAt = null;

  const paintCountdown = () => {
    if (!countdownValue) return;
    if (!nextAt) {
      countdownValue.textContent = "Aucun live programmé";
      return;
    }
    const remaining = Math.max(0, Math.floor((nextAt.getTime() - Date.now()) / 1000));
    const days = Math.floor(remaining / 86_400);
    const hours = Math.floor((remaining % 86_400) / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    countdownValue.textContent = days > 0
      ? `${days} j ${String(hours).padStart(2, "0")} h ${String(minutes).padStart(2, "0")} min`
      : `${String(hours).padStart(2, "0")} h ${String(minutes).padStart(2, "0")} min`;
  };

  const paintSchedule = (schedule) => {
    if (!scheduleDaysNode) return;
    const active = WEEKDAYS.filter(([key]) => schedule?.[key]?.enabled);
    const uniqueTimes = new Set(active.map(([key]) => schedule[key].time));

    if (scheduleTimeNode) {
      scheduleTimeNode.textContent = active.length === 0
        ? "Aucun live programmé pour le moment"
        : uniqueTimes.size === 1
          ? `Rendez-vous fixe · ${formatTime(active[0][1] ? schedule[active[0][0]].time : "")} (heure FR)`
          : "Horaires variés cette semaine · heure FR";
    }

    scheduleDaysNode.replaceChildren();
    for (const [key, label] of WEEKDAYS) {
      const day = schedule?.[key];
      if (!day?.enabled) continue;
      const item = document.createElement("li");
      item.className = "works-day";
      const name = document.createElement("span");
      name.className = "works-day-name";
      name.textContent = label;
      const time = document.createElement("span");
      time.className = "works-day-time";
      time.textContent = formatTime(day.time);
      item.append(name, time);
      scheduleDaysNode.append(item);
    }
    if (!scheduleDaysNode.childElementCount) {
      const empty = document.createElement("li");
      empty.className = "works-day works-day--empty";
      empty.textContent = "Le planning arrive.";
      scheduleDaysNode.append(empty);
    }

    nextAt = nextLiveAt(schedule);
    paintCountdown();
  };

  const loadConfig = async () => {
    try {
      const response = await fetch("/api/site-config", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = await response.json();
      applyLinks(data?.config?.socials);
      paintSchedule(data?.config?.schedule);
    } catch {
      // Les liens par défaut restent utilisables, le planning reste générique.
    }
  };

  // Accès hôte : uniquement si la session admin (ou le compte Hôte) est valide.
  const addHostAccess = () => {
    const button = document.createElement("a");
    button.className = "works-enter";
    button.href = "/?suite=1";
    button.textContent = "Entrer sur le site · accès Gionny";
    button.setAttribute("aria-label", "Entrer sur le site en tant qu’hôte");
    document.querySelector(".works-main")?.append(button);
  };

  const checkHost = async () => {
    try {
      const response = await fetch("/api/access", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = await response.json();
      if (data?.canEnter === true) addHostAccess();
    } catch {
      // Sans réponse, la page d'attente reste seule.
    }
  };

  void loadConfig();
  void checkHost();
  window.setInterval(paintCountdown, 30_000);
})();
