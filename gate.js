(() => {
  "use strict";

  // -------------------------------------------------------------------------
  // Rideau « SITE EN TRAVAUX »
  // -------------------------------------------------------------------------
  // Le site démarre fermé. Tant que Gionny n'a pas ouvert l'accès depuis
  // /gestion-qg/, tout visiteur voit ce rideau : le vrai site reste derrière,
  // complètement flouté, et seuls « Retrouve-moi ici » (à droite) et le
  // planning (à gauche) restent lisibles.
  //
  // L'état vient de /api/access (session admin valide → le site s'ouvre).
  // Un paramètre d'URL `?suite=1` sert de secours depuis le panneau admin.
  // -------------------------------------------------------------------------

  const gate = document.querySelector("[data-works-gate]");
  if (!gate) return;

  const shell = document.querySelector(".x-shell");
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

  const scheduleTimeNode = gate.querySelector("[data-gate-schedule-time]");
  const scheduleDaysNode = gate.querySelector("[data-gate-schedule-days]");
  const countdownNode = gate.querySelector("[data-gate-countdown]");
  const linkNodes = [...gate.querySelectorAll("[data-gate-link]")];

  const safeUrl = (key, value) => {
    if (typeof value !== "string" || !value.trim()) return "";
    try {
      const url = new URL(value.trim());
      if (url.protocol !== "https:") return "";
      if (!(SAFE_HOSTS[key] || []).includes(url.hostname.toLowerCase())) return "";
      return url.href;
    } catch {
      return "";
    }
  };

  const formatTime = (time) => String(time || "").replace(":", "h");

  const nextLiveAt = (schedule) => {
    const now = new Date();
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
    if (!countdownNode) return;
    if (!nextAt) {
      countdownNode.textContent = "Aucun live programmé";
      return;
    }
    const remaining = Math.max(0, Math.floor((nextAt.getTime() - Date.now()) / 1000));
    const days = Math.floor(remaining / 86_400);
    const hours = Math.floor((remaining % 86_400) / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    countdownNode.textContent = days > 0
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
          ? `Rendez-vous fixe · ${formatTime(schedule[active[0][0]].time)} (heure FR)`
          : "Horaires variés cette semaine · heure FR";
    }
    const items = active.map(([key, label]) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = label;
      const time = document.createElement("strong");
      time.textContent = formatTime(schedule[key].time);
      item.append(name, time);
      return item;
    });
    if (!items.length) {
      const empty = document.createElement("li");
      empty.className = "works-gate-day-empty";
      empty.textContent = "Le planning arrive.";
      items.push(empty);
    }
    scheduleDaysNode.replaceChildren(...items);
    nextAt = nextLiveAt(schedule);
    paintCountdown();
  };

  const paintLinks = (socials) => {
    linkNodes.forEach((link) => {
      const url = safeUrl(link.dataset.gateLink, socials?.[link.dataset.gateLink]);
      if (url) link.href = url;
    });
  };

  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    gate.hidden = true;
    document.documentElement.classList.remove("qg-works");
    if (shell) shell.removeAttribute("inert");
    if (shell) shell.removeAttribute("aria-hidden");
  };

  const applyLock = () => {
    document.documentElement.classList.add("qg-works");
    gate.hidden = false;
    if (shell) {
      shell.setAttribute("inert", "");
      shell.setAttribute("aria-hidden", "true");
    }
    // La page repart du haut, jamais au milieu d'une conversation.
    window.scrollTo(0, 0);
    document.body.style.overflow = "hidden";
  };

  const loadGateContent = async () => {
    try {
      const response = await fetch("/api/site-config", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = await response.json();
      paintLinks(data?.config?.socials);
      paintSchedule(data?.config?.schedule);
    } catch {
      // Les liens par défaut du rideau restent cliquables.
    }
  };

  const init = async () => {
    // Secours depuis le panneau admin : « Voir le site » ajoute ?suite=1.
    const params = new URLSearchParams(window.location.search);
    if (params.get("suite") === "1") {
      params.delete("suite");
      const clean = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
      window.history.replaceState(null, "", clean);
      reveal();
      void loadGateContent();
      return;
    }

    try {
      const response = await fetch("/api/access", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (response.ok && (data.locked === false || data.canEnter === true)) {
        reveal();
        return;
      }
    } catch {
      // Serveur injoignable : on garde le rideau (le site reste fermé).
    }

    applyLock();
    void loadGateContent();
    window.setInterval(paintCountdown, 30_000);
  };

  void init();
})();
