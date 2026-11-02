(() => {
  const pageScrollLockOwners = new Set();
  let savedPageScrollStyles = null;

  const lockBackgroundScroll = (owner) => {
    if (!owner || pageScrollLockOwners.has(owner)) return;

    const body = document.body;
    const root = document.documentElement;
    if (!body || !root) return;

    if (pageScrollLockOwners.size === 0) {
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      const scrollbarWidth = Math.max(0, window.innerWidth - root.clientWidth);
      const bodyPaddingRight = Number.parseFloat(window.getComputedStyle(body).paddingRight) || 0;
      savedPageScrollStyles = {
        scrollX,
        scrollY,
        body: {
          overflow: body.style.overflow,
          position: body.style.position,
          top: body.style.top,
          left: body.style.left,
          right: body.style.right,
          width: body.style.width,
          paddingRight: body.style.paddingRight,
        },
        rootOverflow: root.style.overflow,
        bodyPaddingRight,
      };

      root.style.overflow = "hidden";
      document.body.style.overflow = "hidden";
      body.style.position = "fixed";
      body.style.top = `${-scrollY}px`;
      body.style.left = `${-scrollX}px`;
      body.style.right = "0";
      body.style.width = "100%";
      if (scrollbarWidth > 0) {
        body.style.paddingRight = `${bodyPaddingRight + scrollbarWidth}px`;
      }
      body.classList.add("page-scroll-locked");
    }

    pageScrollLockOwners.add(owner);
  };

  const unlockBackgroundScroll = (owner) => {
    if (!owner || !pageScrollLockOwners.delete(owner) || pageScrollLockOwners.size > 0) return;

    const body = document.body;
    const root = document.documentElement;
    const saved = savedPageScrollStyles;
    savedPageScrollStyles = null;
    if (!body || !root || !saved) return;

    body.classList.remove("page-scroll-locked");
    body.style.overflow = saved.body.overflow;
    body.style.position = saved.body.position;
    body.style.top = saved.body.top;
    body.style.left = saved.body.left;
    body.style.right = saved.body.right;
    body.style.width = saved.body.width;
    body.style.paddingRight = saved.body.paddingRight;
    root.style.overflow = saved.rootOverflow;

    const previousScrollBehavior = root.style.scrollBehavior;
    root.style.scrollBehavior = "auto";
    window.scrollTo(saved.scrollX, saved.scrollY);
    window.requestAnimationFrame(() => {
      root.style.scrollBehavior = previousScrollBehavior;
    });
  };

  const storageKey = "gionny:visited-links:v1";
  const youtubeSeenKey = "gionny:youtube:last-seen:v1";
  const links = [...document.querySelectorAll("[data-network]")];
  const knownNetworks = new Set(links.map((link) => link.dataset.network));
  const visitedNetworks = new Set();
  let recentYouTubeUploads = [];
  let youtubeApiAvailable = false;
  let latestTickerUpdates = null;
  let configuredSocials = {};
  let configuredSocialInfo = {};
  let latestYouTubeUrl = "";
  let currentTwitchIsLive = false;
  let currentSchedule = null;
  let nextScheduledLiveAt = null;

  const DEFAULT_YOUTUBE_URL = "https://www.youtube.com/@gionnyyy";
  const DEFAULT_DISCORD_URL = "https://discord.gg/nPACfBTnPx";
  const SOCIAL_INFO_KEYS = ["twitch", "tiktok", "youtube", "x", "instagram"];
  const SOCIAL_HOSTS = {
    twitch: new Set(["twitch.tv", "www.twitch.tv"]),
    tiktok: new Set(["tiktok.com", "www.tiktok.com"]),
    youtube: new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]),
    x: new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]),
    instagram: new Set(["instagram.com", "www.instagram.com"]),
    discord: new Set(["discord.gg", "discord.com", "www.discord.com"]),
  };
  const WEEKDAYS = [
    { key: "monday", label: "Lundi" },
    { key: "tuesday", label: "Mardi" },
    { key: "wednesday", label: "Mercredi" },
    { key: "thursday", label: "Jeudi" },
    { key: "friday", label: "Vendredi" },
    { key: "saturday", label: "Samedi" },
    { key: "sunday", label: "Dimanche" },
  ];
  const DEFAULT_LIVE_DAYS = new Set(["tuesday", "wednesday", "saturday", "sunday"]);
  const PARIS_DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const parisDateFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  currentSchedule = Object.fromEntries(
    WEEKDAYS.map(({ key }) => [key, { enabled: DEFAULT_LIVE_DAYS.has(key), time: "22:00" }])
  );

  try {
    const savedNetworks = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (Array.isArray(savedNetworks)) {
      savedNetworks.forEach((network) => {
        if (knownNetworks.has(network)) visitedNetworks.add(network);
      });
    }
  } catch {
    // The links still work if local storage is unavailable.
  }

  const renderYouTubeVisitState = (unseenCount, available = youtubeApiAvailable) => {
    const card = document.querySelector("[data-youtube-card]");
    const countBadge = card?.querySelector("[data-youtube-count]");
    const visitedBadge = card?.querySelector("[data-youtube-visited]");
    if (!countBadge || !visitedBadge) return;

    const count = Math.max(0, Number(unseenCount) || 0);
    countBadge.hidden = !available || count === 0;
    visitedBadge.hidden = available ? count > 0 : !visitedNetworks.has("youtube");

    if (count > 0) {
      countBadge.textContent = String(Math.min(count, 3));
      countBadge.setAttribute(
        "aria-label",
        `${count} nouvelle${count > 1 ? "s" : ""} vidéo${count > 1 ? "s" : ""}`
      );
    }
  };

  const readYouTubeMarker = () => {
    try {
      const marker = JSON.parse(localStorage.getItem(youtubeSeenKey) || "null");
      return marker && typeof marker === "object" ? marker : null;
    } catch {
      return null;
    }
  };

  const writeYouTubeMarker = (video = recentYouTubeUploads[0]) => {
    const marker = video
      ? { id: video.id || "", publishedAt: video.publishedAt || new Date().toISOString() }
      : { id: "", publishedAt: new Date().toISOString() };

    try {
      localStorage.setItem(youtubeSeenKey, JSON.stringify(marker));
    } catch {
      // The notification still clears for the current page if storage is blocked.
    }
    renderYouTubeVisitState(0, youtubeApiAvailable);
  };

  const countUnseenYouTubeUploads = (uploads) => {
    const marker = readYouTubeMarker();
    if (!marker) {
      writeYouTubeMarker(uploads[0]);
      return 0;
    }
    if (!uploads.length) return 0;

    const seenIndex = marker.id ? uploads.findIndex((upload) => upload.id === marker.id) : -1;
    if (seenIndex >= 0) return seenIndex;
    if (!marker.id) {
      writeYouTubeMarker(uploads[0]);
      return 0;
    }

    const seenAt = Date.parse(marker.publishedAt || "");
    if (!Number.isFinite(seenAt)) {
      writeYouTubeMarker(uploads[0]);
      return 0;
    }
    return uploads.filter((upload) => Date.parse(upload.publishedAt) > seenAt).length;
  };

  const showVisitedState = (link) => {
    if (link.dataset.network === "youtube") return;
    const badge = link.querySelector(".visited-badge");
    const twitchIsLive = link.matches('[data-twitch-card][data-live="true"]');
    if (badge) badge.hidden = twitchIsLive;
    link.dataset.visited = "true";
  };

  const saveVisitedState = (link) => {
    const network = link.dataset.network;
    if (!network) return;

    if (network === "youtube") {
      visitedNetworks.add(network);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...visitedNetworks]));
      } catch {
        // Keep the visual state for this page even if storage is blocked.
      }
      writeYouTubeMarker();
      return;
    }

    if (visitedNetworks.has(network)) return;
    visitedNetworks.add(network);
    links
      .filter((candidate) => candidate.dataset.network === network)
      .forEach(showVisitedState);

    try {
      localStorage.setItem(storageKey, JSON.stringify([...visitedNetworks]));
    } catch {
      // Keep the visual state for this page even if storage is blocked.
    }
  };

  links.forEach((link) => {
    if (visitedNetworks.has(link.dataset.network)) showVisitedState(link);
    link.addEventListener("click", () => saveVisitedState(link));
  });
  renderYouTubeVisitState(0, false);

  const safeYouTubeUrl = (url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") return "https://www.youtube.com/@gionnyyy";

      let videoId = "";
      if (parsed.hostname === "youtu.be") {
        videoId = parsed.pathname.split("/").filter(Boolean)[0] || "";
      } else if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(parsed.hostname)) {
        videoId =
          parsed.searchParams.get("v") ||
          parsed.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/u)?.[1] ||
          "";
      }

      if (/^[A-Za-z0-9_-]{6,20}$/u.test(videoId)) {
        return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
      }
    } catch {
      // Use the public channel link below when an API response has no valid video URL.
    }
    return "https://www.youtube.com/@gionnyyy";
  };

  const safeTwitchUrl = (url) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" && parsed.hostname === "www.twitch.tv") return parsed.href;
    } catch {
      // Use the known public channel link when no valid Twitch URL is provided.
    }
    return "https://www.twitch.tv/7gionny";
  };

  const safeSocialUrl = (key, value) => {
    try {
      const parsed = new URL(value);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        (parsed.port && parsed.port !== "443") ||
        !SOCIAL_HOSTS[key]?.has(parsed.hostname.toLowerCase())
      ) {
        return "";
      }
      parsed.hash = "";
      return parsed.href;
    } catch {
      return "";
    }
  };

  const extractDiscordInviteCode = (value) => {
    const safeUrl = safeSocialUrl("discord", value);
    if (!safeUrl) return "";
    try {
      const parsed = new URL(safeUrl);
      const code = parsed.hostname === "discord.gg"
        ? parsed.pathname.split("/").filter(Boolean)[0] || ""
        : parsed.pathname.match(/^\/invite\/([^/]+)\/?$/iu)?.[1] || "";
      return /^[A-Za-z0-9-]{2,64}$/u.test(code) ? code : "";
    } catch {
      return "";
    }
  };

  const extractTwitchChannel = (value) => {
    const safeUrl = safeSocialUrl("twitch", value);
    if (!safeUrl) return "7gionny";
    try {
      const segment = new URL(safeUrl).pathname.split("/").filter(Boolean)[0] || "";
      return /^[A-Za-z0-9_]{1,25}$/u.test(segment) ? segment : "7gionny";
    } catch {
      return "7gionny";
    }
  };

  const isValidSiteConfig = (config) => {
    if (!config || typeof config !== "object" || !config.socials || !config.schedule) return false;
    if (Object.keys(SOCIAL_HOSTS).some((key) => !safeSocialUrl(key, config.socials[key]))) return false;
    if (config.socialInfo !== undefined && (!config.socialInfo || typeof config.socialInfo !== "object" || Array.isArray(config.socialInfo))) return false;
    if (
      SOCIAL_INFO_KEYS.some((key) =>
        config.socialInfo?.[key] !== undefined &&
        (typeof config.socialInfo[key] !== "string" || config.socialInfo[key].length > 120)
      )
    ) return false;
    return WEEKDAYS.every(({ key }) => {
      const day = config.schedule[key];
      return (
        day &&
        typeof day.enabled === "boolean" &&
        typeof day.time === "string" &&
        /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(day.time)
      );
    });
  };

  const applyConfiguredLinks = () => {
    document.querySelectorAll("[data-config-link]").forEach((link) => {
      const key = link.dataset.configLink;
      let url = safeSocialUrl(key, configuredSocials[key]);
      if (!url) return;

      const isYouTubeLink = key === "youtube" &&
        (link.hasAttribute("data-youtube-card") || link.hasAttribute("data-ticker-youtube"));
      if (isYouTubeLink && url === DEFAULT_YOUTUBE_URL && latestYouTubeUrl) {
        url = latestYouTubeUrl;
      }
      link.href = url;
    });
  };

  const renderSocialInfo = () => {
    for (const key of SOCIAL_INFO_KEYS) {
      const element = document.querySelector(`[data-social-info="${key}"]`);
      if (!element) continue;
      const value = typeof configuredSocialInfo[key] === "string" ? configuredSocialInfo[key].trim() : "";
      element.textContent = value;
      element.hidden = !value;
    }
  };

  let discordStatusInFlight = false;
  let activeDiscordInviteCode = "";

  const renderDiscordOnlineStatus = (status) => {
    const badge = document.querySelector("[data-discord-online]");
    const count = document.querySelector("[data-discord-online-count]");
    const memberCount = document.querySelector("[data-discord-member-count]");
    const inviteLabel = document.querySelector("[data-discord-invite]");
    const isAvailable = status?.available === true && Number.isSafeInteger(status.onlineCount) && status.onlineCount >= 0;
    if (badge) badge.hidden = !isAvailable;
    if (isAvailable && count) count.textContent = status.onlineCount.toLocaleString("fr-FR");

    const hasMemberCount = Number.isSafeInteger(status?.memberCount) && status.memberCount >= 0;
    if (memberCount) {
      memberCount.hidden = !hasMemberCount;
      if (hasMemberCount) {
        const formattedCount = status.memberCount.toLocaleString("fr-FR");
        memberCount.textContent = `${formattedCount} membre${status.memberCount === 1 ? "" : "s"}`;
      }
    }
    if (inviteLabel && activeDiscordInviteCode) {
      inviteLabel.textContent = `discord.gg/${activeDiscordInviteCode}`;
    }
  };

  const refreshDiscordStatus = async () => {
    if (document.hidden) return;
    const inviteCode = extractDiscordInviteCode(configuredSocials.discord || DEFAULT_DISCORD_URL);
    activeDiscordInviteCode = inviteCode;
    if (!inviteCode) {
      renderDiscordOnlineStatus(null);
      return;
    }
    if (discordStatusInFlight) return;

    discordStatusInFlight = true;
    try {
      const response = await fetch(`/api/discord-status?invite=${encodeURIComponent(inviteCode)}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const status = await response.json().catch(() => ({}));
      if (activeDiscordInviteCode === inviteCode) renderDiscordOnlineStatus(response.ok ? status : null);
    } catch {
      if (activeDiscordInviteCode === inviteCode) renderDiscordOnlineStatus(null);
    } finally {
      discordStatusInFlight = false;
      if (extractDiscordInviteCode(configuredSocials.discord || DEFAULT_DISCORD_URL) !== inviteCode) {
        void refreshDiscordStatus();
      }
    }
  };

  let liveOverflowCheckVersion = 0;
  const scheduleLiveOverflowCheck = () => {
    const version = ++liveOverflowCheckVersion;
    const check = () => {
      if (version !== liveOverflowCheckVersion) return;
      const panels = [document.querySelector(".welcome-panel"), document.querySelector(".networks-panel")];
      const isAnimating = panels.some((panel) =>
        panel?.getAnimations().some((animation) => animation.playState === "running")
      );
      if (isAnimating) {
        window.requestAnimationFrame(check);
        return;
      }

      const needsScroll =
        document.body.dataset.twitchLive === "true" && document.body.scrollHeight > window.innerHeight;
      document.documentElement.dataset.liveOverflow = String(needsScroll);
    };
    window.requestAnimationFrame(check);
  };

  const renderLivePlayer = (isLive, twitch) => {
    document.body.dataset.twitchLive = String(isLive);
    if (!isLive) document.documentElement.dataset.liveOverflow = "false";
    scheduleLiveOverflowCheck();

    const card = document.querySelector("[data-live-player]");
    const playerContainer = document.querySelector("[data-twitch-player]");
    const chatLink = document.querySelector("[data-live-chat-link]");
    const title = document.querySelector("[data-live-player-title]");
    if (!card || !playerContainer) return;

    const profileUrl = safeSocialUrl("twitch", configuredSocials.twitch) || "https://www.twitch.tv/7gionny";
    if (chatLink) chatLink.href = profileUrl;
    if (title) {
      title.textContent = typeof twitch?.title === "string" && twitch.title.trim()
        ? twitch.title.trim()
        : "Gionny est en direct sur Twitch.";
    }

    card.hidden = !isLive;
    if (!isLive) {
      playerContainer.replaceChildren();
      delete playerContainer.dataset.channel;
      delete playerContainer.dataset.parent;
      return;
    }

    const channel = extractTwitchChannel(twitch?.url || configuredSocials.twitch);
    const parent = window.location.hostname;
    const existingPlayer = playerContainer.querySelector("iframe");
    if (existingPlayer?.dataset.channel === channel && existingPlayer.dataset.parent === parent) return;

    const playerUrl = new URL("https://player.twitch.tv/");
    playerUrl.searchParams.set("channel", channel);
    playerUrl.searchParams.set("parent", parent);
    playerUrl.searchParams.set("muted", "true");
    playerUrl.searchParams.set("autoplay", "true");

    const iframe = document.createElement("iframe");
    iframe.src = playerUrl.href;
    iframe.title = `Direct Twitch de Gionny, chaîne ${channel}`;
    iframe.allow = "autoplay; fullscreen";
    iframe.allowFullscreen = true;
    iframe.loading = "lazy";
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.dataset.channel = channel;
    iframe.dataset.parent = parent;
    playerContainer.replaceChildren(iframe);
    playerContainer.dataset.channel = channel;
    playerContainer.dataset.parent = parent;
  };

  const formatScheduleTime = (value) => {
    const [hour, minute] = value.split(":");
    return `${Number(hour)}h${minute === "00" ? "" : minute}`;
  };

  const readParisDateParts = (timestamp) => {
    const parts = Object.fromEntries(
      parisDateFormatter.formatToParts(new Date(timestamp)).map(({ type, value }) => [type, value])
    );
    return {
      year: Number(parts.year),
      month: Number(parts.month),
      day: Number(parts.day),
      hour: Number(parts.hour),
      minute: Number(parts.minute),
      second: Number(parts.second),
    };
  };

  const findParisWallTimeInstants = (wallClock, target) => {
    const offsets = new Set(
      [-36, -12, -6, 0, 6, 12, 36].map((hours) => {
        const sample = wallClock + hours * 60 * 60 * 1000;
        const local = readParisDateParts(sample);
        const localAsUtc = Date.UTC(
          local.year,
          local.month - 1,
          local.day,
          local.hour,
          local.minute,
          local.second
        );
        return localAsUtc - Math.floor(sample / 1000) * 1000;
      })
    );
    return [...offsets]
      .map((offset) => wallClock - offset)
      .filter((timestamp) => {
        const local = readParisDateParts(timestamp);
        return (
          local.year === target.year &&
          local.month === target.month &&
          local.day === target.day &&
          local.hour === target.hour &&
          local.minute === target.minute
        );
      })
      .sort((left, right) => left - right);
  };

  const parisWallTimeInstants = (year, month, day, hour, minute) => {
    const wallClock = Date.UTC(year, month - 1, day, hour, minute);
    const target = { year, month, day, hour, minute };
    const exactMatches = findParisWallTimeInstants(wallClock, target);
    if (exactMatches.length) return exactMatches;

    // If a chosen time falls in the spring DST gap, use the next valid Paris minute.
    for (let delta = 1; delta <= 180; delta += 1) {
      const adjusted = new Date(wallClock + delta * 60_000);
      const adjustedTarget = {
        year: adjusted.getUTCFullYear(),
        month: adjusted.getUTCMonth() + 1,
        day: adjusted.getUTCDate(),
        hour: adjusted.getUTCHours(),
        minute: adjusted.getUTCMinutes(),
      };
      const matches = findParisWallTimeInstants(adjusted.getTime(), adjustedTarget);
      if (matches.length) return matches;
    }
    return [];
  };

  const findNextScheduledLiveAt = (schedule, now = Date.now()) => {
    const today = readParisDateParts(now);
    const parisMidnightAsUtc = Date.UTC(today.year, today.month - 1, today.day);

    for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
      const day = new Date(parisMidnightAsUtc + dayOffset * 86_400_000);
      const dayKey = PARIS_DAY_KEYS[day.getUTCDay()];
      const entry = schedule?.[dayKey];
      if (!entry?.enabled || typeof entry.time !== "string") continue;
      const [hour, minute] = entry.time.split(":").map(Number);
      if (!Number.isInteger(hour) || !Number.isInteger(minute)) continue;

      const instants = parisWallTimeInstants(
        day.getUTCFullYear(),
        day.getUTCMonth() + 1,
        day.getUTCDate(),
        hour,
        minute
      );
      const next = instants.find((timestamp) => timestamp > now);
      if (next) return next;
    }
    return null;
  };

  const updateScheduleCountdown = () => {
    const countdown = document.querySelector("[data-next-live-countdown]");
    const countdownPrefix = document.querySelector("[data-next-live-prefix]");
    const countdownValue = document.querySelector("[data-next-live-value]");
    const liveStatus = document.querySelector("[data-current-live]");
    if (!countdown || !countdownPrefix || !countdownValue || !liveStatus) return;

    if (currentTwitchIsLive) {
      countdown.hidden = true;
      liveStatus.hidden = false;
      return;
    }

    liveStatus.hidden = true;
    countdown.hidden = false;
    const now = Date.now();
    const scheduledTimeReached = Boolean(nextScheduledLiveAt && nextScheduledLiveAt <= now);
    if (!nextScheduledLiveAt || scheduledTimeReached) {
      nextScheduledLiveAt = findNextScheduledLiveAt(currentSchedule, now);
      if (scheduledTimeReached) void refreshTicker();
    }

    if (!nextScheduledLiveAt) {
      countdownPrefix.hidden = true;
      countdownValue.textContent = "Aucun live programmé";
      return;
    }

    countdownPrefix.hidden = false;
    const remainingSeconds = Math.max(0, Math.floor((nextScheduledLiveAt - Date.now()) / 1000));
    const hours = Math.floor(remainingSeconds / 3600);
    const minutes = Math.floor((remainingSeconds % 3600) / 60);
    const seconds = remainingSeconds % 60;
    countdownValue.textContent = `${String(hours).padStart(2, "0")}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  };

  const renderSchedule = (schedule) => {
    const timeDisplay = document.querySelector("[data-schedule-time]");
    const daysList = document.querySelector("[data-schedule-days]");
    if (!timeDisplay || !daysList) return;

    currentSchedule = schedule;
    nextScheduledLiveAt = findNextScheduledLiveAt(schedule);
    updateScheduleCountdown();

    const activeDays = WEEKDAYS.filter(({ key }) => schedule[key].enabled);
    const uniqueTimes = new Set(activeDays.map(({ key }) => schedule[key].time));
    const sameTime = activeDays.length > 0 && uniqueTimes.size === 1;
    const layout = activeDays.length === 0 ? "empty" : sameTime ? "common" : "varied";
    timeDisplay.dataset.layout = layout;
    daysList.dataset.layout = layout;
    daysList.replaceChildren();

    const description = document.querySelector(".schedule-copy p");
    if (description) {
      description.textContent = layout === "common"
        ? "Horaire commun · heure française"
        : layout === "varied"
          ? "Heure française"
          : "Pas de live programmé";
    }

    if (sameTime) {
      const [hour, minute] = activeDays[0] ? schedule[activeDays[0].key].time.split(":") : ["22", "00"];
      const hourLabel = document.createTextNode(String(Number(hour)));
      const unit = document.createElement("span");
      unit.textContent = "h";
      timeDisplay.replaceChildren(hourLabel, unit);
      if (minute !== "00") timeDisplay.append(document.createTextNode(minute));
    } else {
      timeDisplay.textContent = activeDays.length ? "Horaires\nvariés" : "—";
    }

    if (activeDays.length === 0) {
      const emptyItem = document.createElement("li");
      emptyItem.className = "schedule-empty";
      emptyItem.textContent = "Aucun live programmé";
      daysList.append(emptyItem);
      return;
    }

    for (const { key, label } of activeDays) {
      const item = document.createElement("li");
      const dayName = document.createElement("span");
      dayName.className = "schedule-day-name";
      dayName.textContent = label;
      item.append(dayName);

      if (!sameTime) {
        const hour = document.createElement("span");
        hour.className = "schedule-day-time";
        hour.textContent = formatScheduleTime(schedule[key].time);
        item.append(hour);
      }
      daysList.append(item);
    }
  };

  const applySiteConfig = (config) => {
    if (!isValidSiteConfig(config)) return false;
    configuredSocials = config.socials;
    configuredSocialInfo = Object.fromEntries(
      SOCIAL_INFO_KEYS.map((key) => [key, typeof config.socialInfo?.[key] === "string" ? config.socialInfo[key] : ""])
    );
    renderSocialInfo();
    renderSchedule(config.schedule);

    if (latestTickerUpdates) applyTickerUpdates(latestTickerUpdates);
    else applyConfiguredLinks();
    void refreshDiscordStatus();
    return true;
  };

  const introTitle = document.querySelector("[data-intro-title]");
  if (introTitle) {
    const walker = document.createTreeWalker(introTitle, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);

    let characterIndex = 0;
    for (const textNode of textNodes) {
      const fragment = document.createDocumentFragment();
      const pieces = (textNode.textContent || "").match(/\s+|\S+/gu) || [];
      for (const piece of pieces) {
        if (/^\s+$/u.test(piece)) {
          fragment.append(document.createTextNode(piece));
          continue;
        }

        const word = document.createElement("span");
        word.className = "intro-word";
        for (const character of Array.from(piece)) {
          const span = document.createElement("span");
          span.className = "intro-character";
          span.setAttribute("aria-hidden", "true");
          span.style.animationDelay = `${420 + characterIndex * 34}ms`;
          span.textContent = character;
          word.append(span);
          characterIndex += 1;
        }
        fragment.append(word);
      }
      textNode.replaceWith(fragment);
    }
  }

  const profileTrigger = document.querySelector("[data-open-about]");
  const aboutDialog = document.querySelector("[data-about-dialog]");
  const closeAboutButtons = aboutDialog?.querySelectorAll("[data-close-about]") || [];
  if (profileTrigger && aboutDialog?.showModal) {
    profileTrigger.setAttribute("aria-expanded", "false");
    profileTrigger.addEventListener("click", () => {
      if (aboutDialog.open) return;
      aboutDialog.showModal();
      lockBackgroundScroll("about-dialog");
      profileTrigger.setAttribute("aria-expanded", "true");
      aboutDialog.querySelector("[data-close-about]")?.focus({ preventScroll: true });
    });
    closeAboutButtons.forEach((button) => {
      button.addEventListener("click", () => aboutDialog.close());
    });
    aboutDialog.addEventListener("click", (event) => {
      if (event.target === aboutDialog) aboutDialog.close();
    });
    aboutDialog.addEventListener("close", () => {
      unlockBackgroundScroll("about-dialog");
      profileTrigger.setAttribute("aria-expanded", "false");
      profileTrigger.focus({ preventScroll: true });
    });
  }

  const legalDialog = document.querySelector("[data-legal-dialog]");
  const openLegalButton = document.querySelector("[data-open-legal]");
  const closeLegalButtons = legalDialog?.querySelectorAll("[data-close-legal]") || [];
  if (openLegalButton && legalDialog?.showModal) {
    openLegalButton.setAttribute("aria-expanded", "false");
    openLegalButton.addEventListener("click", () => {
      if (legalDialog.open) return;
      legalDialog.showModal();
      lockBackgroundScroll("legal-dialog");
      openLegalButton.setAttribute("aria-expanded", "true");
      legalDialog.querySelector("[data-close-legal]")?.focus({ preventScroll: true });
    });
    closeLegalButtons.forEach((button) => {
      button.addEventListener("click", () => legalDialog.close());
    });
    legalDialog.addEventListener("click", (event) => {
      if (event.target === legalDialog) legalDialog.close();
    });
    legalDialog.addEventListener("close", () => {
      unlockBackgroundScroll("legal-dialog");
      openLegalButton.setAttribute("aria-expanded", "false");
      openLegalButton.focus({ preventScroll: true });
    });
  }

  const contactLauncher = document.querySelector("[data-open-contact]");
  const contactScrim = document.querySelector("[data-contact-scrim]");
  const contactWidget = document.querySelector("[data-contact-widget]");
  const minimizeContactButton = document.querySelector("[data-minimize-contact]");
  const contactAuth = document.querySelector("[data-contact-auth]");
  const authForm = document.querySelector("[data-auth-form]");
  const authSubmit = document.querySelector("[data-auth-submit]");
  const authSubmitLabel = document.querySelector("[data-auth-submit-label]");
  const authStatus = document.querySelector("[data-auth-status]");
  const authTabs = [...document.querySelectorAll("[data-auth-tab]")];
  const memberLoggedOut = document.querySelector("[data-member-logged-out]");
  const memberLoggedIn = document.querySelector("[data-member-logged-in]");
  const memberPseudo = document.querySelector("[data-member-pseudo]");
  const memberCrown = document.querySelector("[data-member-crown]");
  const memberLoginButton = document.querySelector("[data-member-login]");
  const memberRegisterButton = document.querySelector("[data-member-register]");
  const profileDialog = document.querySelector("[data-profile-dialog]");
  const profileOpenButton = document.querySelector("[data-member-profile]");
  const profileCloseButtons = profileDialog?.querySelectorAll("[data-profile-close]") || [];
  const profilePseudoForm = document.querySelector("[data-profile-pseudo-form]");
  const profilePseudoInput = profilePseudoForm?.elements.namedItem("pseudo");
  const profilePseudoSubmit = document.querySelector("[data-profile-pseudo-submit]");
  const profilePseudoStatus = document.querySelector("[data-profile-pseudo-status]");
  const profileCooldownStatus = document.querySelector("[data-profile-cooldown]");
  const profileCrown = document.querySelector("[data-profile-crown]");
  const profilePasswordToggle = document.querySelector("[data-profile-password-toggle]");
  const profilePasswordForm = document.querySelector("[data-profile-password-form]");
  const profilePasswordSubmit = document.querySelector("[data-profile-password-submit]");
  const profilePasswordStatus = document.querySelector("[data-profile-password-status]");
  const profileLogoutButton = document.querySelector("[data-profile-logout]");
  const accountHostCrown = document.querySelector("[data-account-host-crown]");
  const contactThreadCrown = document.querySelector("[data-contact-thread-crown]");
  const contactNewView = document.querySelector("[data-contact-new]");
  const contactForm = document.querySelector("[data-contact-form]");
  const contactSubmit = document.querySelector("[data-contact-submit]");
  const contactStatus = document.querySelector("[data-contact-status]");
  const accountPseudo = document.querySelector("[data-account-pseudo]");
  const contactReplyForm = document.querySelector("[data-contact-reply-form]");
  const contactReplySubmit = document.querySelector("[data-contact-reply-submit]");
  const contactReplyStatus = document.querySelector("[data-contact-thread-status]");
  const contactThread = document.querySelector("[data-contact-thread]");
  const contactThreadMessages = document.querySelector("[data-contact-thread-messages]");
  const contactThreadPseudo = document.querySelector("[data-contact-thread-pseudo]");
  const contactThreadSubject = document.querySelector("[data-contact-thread-subject]");
  const contactThreadState = document.querySelector("[data-contact-thread-state]");
  const contactThreadClosed = document.querySelector("[data-contact-closed]");
  const contactThreadClosedCopy = document.querySelector("[data-contact-closed-copy]");
  const newConversationButton = document.querySelector("[data-new-conversation]");
  const logoutButtons = [...document.querySelectorAll("[data-contact-logout]")];
  const contactBadge = document.querySelector("[data-contact-badge]");
  const VISITOR_SEEN_PREFIX = "gionny:conversation:last-seen:v1:";
  const MAX_VOICE_DURATION_SECONDS = 60;
  const MAX_VOICE_BYTES = 200_000;
  const USERNAME_CHANGE_COOLDOWN_MS = 15 * 24 * 60 * 60 * 1000;
  let profileSaving = false;

  let visitorAccount = null;
  let visitorConversation = null;
  let visitorConversationMessages = [];
  let newConversationMode = false;
  let visitorConversationLoading = false;
  let visitorPollTimer = 0;
  let authMode = "register";
  const voiceControlStates = [];

  const setStatusNode = (node, message, kind = "") => {
    if (!node) return;
    node.textContent = message;
    if (kind) node.dataset.kind = kind;
    else delete node.dataset.kind;
  };

  const setContactStatus = (message, kind = "") => {
    if (contactThread && !contactThread.hidden) {
      setStatusNode(contactReplyStatus, message, kind);
      return;
    }
    const target = contactNewView && !contactNewView.hidden ? contactStatus : authStatus;
    setStatusNode(target, message, kind);
  };

  const setContactThreadStatus = (message, kind = "") => {
    setStatusNode(contactReplyStatus, message, kind);
  };

  const setAuthMode = (mode) => {
    authMode = mode === "login" ? "login" : "register";
    authTabs.forEach((tab) => {
      const selected = tab.dataset.authTab === authMode;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    const password = authForm?.elements.namedItem("password");
    if (password) {
      password.autocomplete = authMode === "login" ? "current-password" : "new-password";
      password.placeholder = authMode === "login" ? "Ton mot de passe" : "8 caractères minimum";
    }
    if (authSubmitLabel) authSubmitLabel.textContent = authMode === "login" ? "Se connecter" : "Créer mon compte";
    setStatusNode(authStatus, "");
  };

  const readVisitorSeenId = (conversationId) => {
    try {
      return localStorage.getItem(`${VISITOR_SEEN_PREFIX}${conversationId}`) || "";
    } catch {
      return "";
    }
  };

  const markVisitorThreadSeen = () => {
    if (!visitorConversation) return;
    const lastGionnyMessage = [...visitorConversationMessages].reverse().find((message) => message.sender === "gionny");
    if (!lastGionnyMessage) return;
    try {
      localStorage.setItem(`${VISITOR_SEEN_PREFIX}${visitorConversation.id}`, lastGionnyMessage.id);
    } catch {
      // A full or disabled local store must not prevent opening the conversation.
    }
    if (contactBadge) contactBadge.hidden = true;
  };

  const formatConversationTime = (value) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return new Intl.DateTimeFormat("fr-FR", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "Europe/Paris",
    }).format(date);
  };

  const updateProfilePseudoControls = () => {
    if (!visitorAccount || !profilePseudoInput || !profilePseudoSubmit) {
      if (profilePseudoSubmit) profilePseudoSubmit.disabled = true;
      return;
    }
    const isHost = visitorAccount.role === "host";
    const hasChanged = profilePseudoInput.value.normalize("NFKC").trim().replace(/\s+/gu, " ") !== visitorAccount.pseudo;
    const lastChange = typeof visitorAccount.lastUsernameChange === "string"
      ? Date.parse(visitorAccount.lastUsernameChange)
      : Number.NaN;
    const remainingMs = !isHost && Number.isFinite(lastChange)
      ? Math.max(0, lastChange + USERNAME_CHANGE_COOLDOWN_MS - Date.now())
      : 0;
    const daysRemaining = remainingMs > 0 ? Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000))) : 0;
    if (profileCooldownStatus) {
      const message = isHost
        ? "Le compte Hôte peut modifier son pseudo sans délai."
        : daysRemaining > 0
          ? `Prochain changement possible dans ${daysRemaining} jours.`
          : "Tu peux modifier ton pseudo une fois tous les 15 jours.";
      setStatusNode(profileCooldownStatus, message, daysRemaining > 0 ? "warning" : "");
    }
    profilePseudoSubmit.disabled = profileSaving || !hasChanged || daysRemaining > 0;
    if (profilePasswordSubmit) profilePasswordSubmit.disabled = profileSaving;
  };

  const createHostCrownBadge = (className) => {
    const badge = document.createElement("span");
    badge.className = className;
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", "Compte Hôte");
    badge.title = "Compte Hôte";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 20 20");
    svg.setAttribute("aria-hidden", "true");
    const crown = document.createElementNS("http://www.w3.org/2000/svg", "path");
    crown.setAttribute("d", "m2.2 6.3 4.1 3.1 3.7-5.6 3.7 5.6 4.1-3.1-1.6 9.2H3.8L2.2 6.3Z");
    const base = document.createElementNS("http://www.w3.org/2000/svg", "path");
    base.setAttribute("d", "M4 17.2h12");
    svg.append(crown, base);
    badge.append(svg);
    return badge;
  };

  const createVisitorChatMessage = (message) => {
    const item = document.createElement("article");
    const sender = message.sender === "gionny" ? "gionny" : "visitor";
    item.className = `contact-chat-message contact-chat-message--${sender}`;

    const name = document.createElement("span");
    name.className = "contact-chat-sender";
    name.textContent = sender === "gionny" ? "Gionny" : visitorConversation?.pseudo || "Toi";
    if (sender === "visitor" && visitorConversation?.isHost) {
      name.append(createHostCrownBadge("contact-chat-host-crown"));
    }
    item.append(name);

    if (message.kind === "audio" || message.hasAudio) {
      const audio = document.createElement("audio");
      audio.className = "contact-chat-audio";
      audio.controls = true;
      audio.preload = "none";
      audio.setAttribute("aria-label", `Message vocal de ${sender === "gionny" ? "Gionny" : visitorConversation?.pseudo || "toi"}`);
      audio.src = `/api/contact-audio?conversationId=${encodeURIComponent(visitorConversation.id)}&messageId=${encodeURIComponent(message.id)}`;
      item.append(audio);
    } else {
      const text = document.createElement("p");
      text.className = "contact-chat-text";
      text.textContent = typeof message.text === "string" ? message.text : "";
      item.append(text);
    }

    const date = document.createElement("time");
    date.className = "contact-chat-date";
    date.dateTime = message.createdAt;
    date.textContent = formatConversationTime(message.createdAt);
    item.append(date);
    return item;
  };

  const renderVisitorConversation = ({ announceNewReply = false } = {}) => {
    if (!visitorConversation || !contactThread || !contactNewView) return;
    if (contactAuth) contactAuth.hidden = true;
    contactNewView.hidden = true;
    contactThread.hidden = false;
    contactThreadPseudo.textContent = visitorConversation.pseudo || visitorAccount?.pseudo || "Ta discussion privée";
    if (contactThreadSubject) contactThreadSubject.textContent = visitorConversation.subject || "💬 Discussion";
    contactThreadState.textContent = visitorConversation.status === "blocked"
      ? "Bloquée"
      : visitorConversation.status === "closed"
        ? "Fermée"
        : "Ouverte";
    contactThreadState.dataset.state = visitorConversation.status;

    const canReply = visitorConversation.status === "open";
    contactReplyForm.hidden = !canReply;
    contactThreadClosed.hidden = canReply;
    contactThreadClosedCopy.textContent = visitorConversation.status === "blocked"
      ? "Cette discussion a été bloquée. Tu ne peux plus y envoyer de message."
      : "Cette discussion est fermée. Tu peux démarrer un nouveau fil si tu as une autre question.";
    newConversationButton.hidden = visitorConversation.status !== "closed";

    const messageSignature = visitorConversationMessages.map((message) => `${message.id}:${message.kind || "text"}`).join("|");
    if (contactThreadMessages.dataset.messageSignature !== messageSignature) {
      const wasNearBottom = contactThreadMessages.scrollHeight - contactThreadMessages.scrollTop - contactThreadMessages.clientHeight < 80;
      contactThreadMessages.replaceChildren(...visitorConversationMessages.map(createVisitorChatMessage));
      contactThreadMessages.dataset.messageSignature = messageSignature;
      if (wasNearBottom) contactThreadMessages.scrollTop = contactThreadMessages.scrollHeight;
    }

    const latestGionnyMessage = [...visitorConversationMessages].reverse().find((message) => message.sender === "gionny");
    const seenId = readVisitorSeenId(visitorConversation.id);
    const hasUnseenReply = Boolean(latestGionnyMessage && latestGionnyMessage.id !== seenId);
    if (contactBadge) contactBadge.hidden = !hasUnseenReply || !contactWidget.hidden;
    if (announceNewReply && hasUnseenReply && contactWidget.hidden) {
      contactLauncher?.setAttribute("aria-label", "Une réponse t’attend dans ta discussion privée avec Gionny");
    } else {
      contactLauncher?.setAttribute("aria-label", "Ouvrir ta discussion privée avec Gionny");
    }
    if (!contactWidget.hidden) markVisitorThreadSeen();
  };

  const renderMemberAccess = () => {
    const isConnected = Boolean(visitorAccount);
    const isHost = visitorAccount?.role === "host";
    if (memberLoggedOut) memberLoggedOut.hidden = isConnected;
    if (memberLoggedIn) memberLoggedIn.hidden = !isConnected;
    if (memberPseudo) memberPseudo.textContent = isConnected ? visitorAccount.pseudo || "" : "";
    if (memberCrown) memberCrown.hidden = !isHost;
    if (profileCrown) profileCrown.hidden = !isHost;
    if (accountHostCrown) accountHostCrown.hidden = !isHost;
    if (contactThreadCrown) contactThreadCrown.hidden = !isHost;
    if (profileOpenButton) {
      profileOpenButton.setAttribute(
        "aria-label",
        isConnected ? `Mon profil : ${visitorAccount.pseudo || "membre"}` : "Mon profil"
      );
    }
    if (profileDialog?.open) updateProfilePseudoControls();
  };

  const renderContactState = () => {
    renderMemberAccess();
    if (!visitorAccount) {
      if (contactAuth) contactAuth.hidden = false;
      if (contactNewView) contactNewView.hidden = true;
      if (contactThread) contactThread.hidden = true;
      if (contactBadge) contactBadge.hidden = true;
      return;
    }

    if (contactAuth) contactAuth.hidden = true;
    if (accountPseudo) accountPseudo.textContent = visitorAccount.pseudo || "";
    if (visitorConversation) {
      renderVisitorConversation();
      return;
    }
    if (contactThread) contactThread.hidden = true;
    if (contactNewView) contactNewView.hidden = false;
    if (contactBadge) contactBadge.hidden = true;
  };

  const loadVisitorConversation = async ({ quiet = false } = {}) => {
    if (!contactWidget || visitorConversationLoading) return;
    visitorConversationLoading = true;
    try {
      const response = await fetch("/api/contact", {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (!quiet) setContactStatus(data.error || "La discussion n’a pas pu être chargée.", "error");
        return;
      }

      visitorAccount = data.account || null;
      visitorConversation = data.conversation || null;
      visitorConversationMessages = Array.isArray(data.messages) ? data.messages : [];
      newConversationMode = false;
      renderContactState();
      if (visitorConversation) renderVisitorConversation({ announceNewReply: true });
    } catch {
      if (!quiet) setContactStatus("Impossible de joindre le serveur. Réessaie dans un instant.", "error");
    } finally {
      visitorConversationLoading = false;
    }
  };

  const openContactWidget = () => {
    if (!contactWidget) return;
    contactWidget.hidden = false;
    if (contactScrim) contactScrim.hidden = false;
    document.body.classList.add("contact-page-open");
    lockBackgroundScroll("contact-widget");
    contactLauncher?.setAttribute("aria-expanded", "true");
    if (contactBadge) contactBadge.hidden = true;
    if (visitorConversation && !newConversationMode) {
      markVisitorThreadSeen();
      void loadVisitorConversation({ quiet: true });
      contactReplyForm?.querySelector("textarea")?.focus({ preventScroll: true });
    } else if (visitorAccount) {
      contactForm?.elements.namedItem("message")?.focus({ preventScroll: true });
    } else {
      authForm?.elements.namedItem("pseudo")?.focus({ preventScroll: true });
    }
  };

  const minimizeContactWidget = () => {
    if (!contactWidget) return;
    voiceControlStates.forEach((state) => state.cancel());
    contactWidget.hidden = true;
    if (contactScrim) contactScrim.hidden = true;
    document.body.classList.remove("contact-page-open");
    unlockBackgroundScroll("contact-widget");
    contactLauncher?.setAttribute("aria-expanded", "false");
    contactLauncher?.focus({ preventScroll: true });
    if (visitorConversation && !newConversationMode) renderVisitorConversation({ announceNewReply: true });
  };

  const updateConversationFromResponse = (data) => {
    if (data.account) visitorAccount = data.account;
    if (data.conversation) visitorConversation = data.conversation;
    if (Array.isArray(data.messages)) visitorConversationMessages = data.messages;
    else if (data.message) visitorConversationMessages.push(data.message);
  };

  const logoutVisitor = async () => {
    if (voiceControlStates.some((state) => state.sending)) {
      setContactStatus("Attends la fin de l’envoi du vocal avant de te déconnecter.", "error");
      return;
    }
    voiceControlStates.forEach((state) => state.cancel());
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ action: "logout" }),
      });
      if (!response.ok) {
        setContactStatus("La déconnexion n’a pas abouti. Réessaie.", "error");
        return;
      }
    } catch {
      setContactStatus("Impossible de joindre le serveur pour te déconnecter.", "error");
      return;
    }
    if (profileDialog?.open) profileDialog.close();
    visitorAccount = null;
    visitorConversation = null;
    visitorConversationMessages = [];
    newConversationMode = false;
    renderContactState();
    setAuthMode("register");
    setContactStatus("Tu es déconnecté·e.", "success");
  };

  authTabs.forEach((tab) => tab.addEventListener("click", () => setAuthMode(tab.dataset.authTab)));
  memberLoginButton?.addEventListener("click", () => {
    setAuthMode("login");
    openContactWidget();
  });
  memberRegisterButton?.addEventListener("click", () => {
    setAuthMode("register");
    openContactWidget();
  });

  const openProfileDialog = () => {
    if (!visitorAccount || !profileDialog?.showModal) return;
    if (profilePseudoInput) profilePseudoInput.value = visitorAccount.pseudo || "";
    if (profilePseudoStatus) setStatusNode(profilePseudoStatus, "");
    if (profilePasswordStatus) setStatusNode(profilePasswordStatus, "");
    profilePasswordForm?.reset();
    if (profilePasswordForm) profilePasswordForm.hidden = true;
    profilePasswordToggle?.setAttribute("aria-expanded", "false");
    if (profilePasswordToggle?.lastElementChild) profilePasswordToggle.lastElementChild.textContent = "＋";
    profileDialog.showModal();
    lockBackgroundScroll("profile-dialog");
    profileOpenButton?.setAttribute("aria-expanded", "true");
    updateProfilePseudoControls();
    profilePseudoInput?.focus({ preventScroll: true });
  };

  profileOpenButton?.addEventListener("click", openProfileDialog);
  profileCloseButtons.forEach((button) => button.addEventListener("click", () => profileDialog?.close()));
  profileDialog?.addEventListener("click", (event) => {
    if (event.target === profileDialog) profileDialog.close();
  });
  profileDialog?.addEventListener("close", () => {
    unlockBackgroundScroll("profile-dialog");
    profileOpenButton?.setAttribute("aria-expanded", "false");
    if (profileOpenButton && !profileOpenButton.hidden) profileOpenButton.focus({ preventScroll: true });
  });
  profilePseudoInput?.addEventListener("input", updateProfilePseudoControls);
  profilePasswordToggle?.addEventListener("click", () => {
    if (!profilePasswordForm) return;
    profilePasswordForm.hidden = !profilePasswordForm.hidden;
    const expanded = !profilePasswordForm.hidden;
    profilePasswordToggle.setAttribute("aria-expanded", String(expanded));
    if (profilePasswordToggle.lastElementChild) profilePasswordToggle.lastElementChild.textContent = expanded ? "−" : "＋";
    if (expanded) profilePasswordForm.elements.namedItem("currentPassword")?.focus({ preventScroll: true });
  });

  const submitProfileUpdate = async (payload, statusNode, submitButton) => {
    if (!submitButton || submitButton.disabled || profileSaving) return;
    profileSaving = true;
    submitButton.disabled = true;
    updateProfilePseudoControls();
    setStatusNode(statusNode, "Enregistrement du profil…");
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ action: "profile", ...payload }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        setStatusNode(statusNode, data.error || "Le profil n’a pas pu être enregistré. Réessaie.", "error");
        if (response.status === 409 && Number.isInteger(data.daysRemaining)) {
          if (profileCooldownStatus) setStatusNode(profileCooldownStatus, data.error, "warning");
          const nextAllowed = Date.parse(data.nextUsernameChangeAt);
          if (Number.isFinite(nextAllowed) && visitorAccount) {
            visitorAccount.lastUsernameChange = new Date(nextAllowed - USERNAME_CHANGE_COOLDOWN_MS).toISOString();
          }
        }
        return;
      }
      updateConversationFromResponse(data);
      renderContactState();
      if (profilePseudoInput && visitorAccount) profilePseudoInput.value = visitorAccount.pseudo || "";
      if (profilePasswordForm) profilePasswordForm.reset();
      setStatusNode(statusNode, "Profil mis à jour.", "success");
      updateProfilePseudoControls();
    } catch {
      setStatusNode(statusNode, "Impossible de joindre le serveur. Réessaie dans un instant.", "error");
    } finally {
      profileSaving = false;
      updateProfilePseudoControls();
    }
  };

  profilePseudoForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!profilePseudoForm.reportValidity() || !visitorAccount) return;
    void submitProfileUpdate(
      { pseudo: String(profilePseudoInput?.value || "") },
      profilePseudoStatus,
      profilePseudoSubmit
    );
  });
  profilePasswordForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!profilePasswordForm.reportValidity() || !visitorAccount) return;
    const passwordData = new FormData(profilePasswordForm);
    void submitProfileUpdate({
      currentPassword: String(passwordData.get("currentPassword") || ""),
      newPassword: String(passwordData.get("newPassword") || ""),
    }, profilePasswordStatus, profilePasswordSubmit);
  });
  profileLogoutButton?.addEventListener("click", () => void logoutVisitor());

  authForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!authForm.reportValidity() || !authSubmit || authSubmit.disabled) return;
    const formData = new FormData(authForm);
    authSubmit.disabled = true;
    setStatusNode(authStatus, authMode === "register" ? "Création de ton compte…" : "Connexion…");
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          action: authMode,
          pseudo: String(formData.get("pseudo") || ""),
          password: String(formData.get("password") || ""),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        setStatusNode(authStatus, data.error || "La connexion n’a pas abouti. Réessaie.", "error");
        return;
      }
      visitorAccount = data.account || null;
      visitorConversation = data.conversation || null;
      visitorConversationMessages = Array.isArray(data.messages) ? data.messages : [];
      newConversationMode = false;
      authForm.reset();
      setStatusNode(authStatus, "");
      renderContactState();
      if (visitorConversation) {
        renderVisitorConversation();
        markVisitorThreadSeen();
      } else {
        contactForm?.elements.namedItem("message")?.focus({ preventScroll: true });
      }
    } catch {
      setStatusNode(authStatus, "Impossible de joindre le serveur. Réessaie dans un instant.", "error");
    } finally {
      authSubmit.disabled = false;
    }
  });

  logoutButtons.forEach((button) => button.addEventListener("click", () => void logoutVisitor()));

  contactForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!contactForm.reportValidity() || !contactSubmit || contactSubmit.disabled) return;
    const formData = new FormData(contactForm);
    const payload = {
      action: "send",
      subject: String(formData.get("subject") || "💬 Discussion"),
      message: String(formData.get("message") || ""),
      website: String(formData.get("website") || ""),
      newConversation: newConversationMode,
    };
    contactSubmit.disabled = true;
    setContactStatus(newConversationMode ? "Ouverture d’une nouvelle discussion…" : "Envoi de ton message…");

    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        setContactStatus(data.error || "Ton message n’a pas pu être envoyé. Réessaie.", "error");
        if (response.status === 409 || response.status === 403) await loadVisitorConversation({ quiet: true });
        return;
      }

      updateConversationFromResponse(data);
      newConversationMode = false;
      contactForm.reset();
      setContactStatus("");
      renderContactState();
      markVisitorThreadSeen();
      contactReplyForm?.querySelector("textarea")?.focus({ preventScroll: true });
    } catch {
      setContactStatus("Impossible de joindre le serveur. Réessaie dans un instant.", "error");
    } finally {
      contactSubmit.disabled = false;
    }
  });

  contactReplyForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!contactReplyForm.reportValidity() || !contactReplySubmit || contactReplySubmit.disabled) return;
    const messageField = contactReplyForm.elements.namedItem("message");
    const message = String(messageField?.value || "").trim();
    if (!message) return;

    contactReplySubmit.disabled = true;
    setContactThreadStatus("Envoi de ton message…");
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ action: "send", message, subject: visitorConversation?.subject || "💬 Discussion" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        setContactThreadStatus(data.error || "Ton message n’a pas pu être envoyé.", "error");
        if (response.status === 409 || response.status === 403 || response.status === 404) await loadVisitorConversation({ quiet: true });
        return;
      }
      updateConversationFromResponse(data);
      messageField.value = "";
      setContactThreadStatus("");
      renderContactState();
      markVisitorThreadSeen();
    } catch {
      setContactThreadStatus("Impossible de joindre le serveur. Réessaie.", "error");
    } finally {
      contactReplySubmit.disabled = false;
    }
  });

  newConversationButton?.addEventListener("click", () => {
    if (visitorConversation?.status !== "closed") return;
    newConversationMode = true;
    contactThread.hidden = true;
    contactAuth.hidden = true;
    contactNewView.hidden = false;
    setContactStatus("");
    const messageInput = contactForm?.elements.namedItem("message");
    if (messageInput) messageInput.value = "";
    contactForm?.elements.namedItem("subject")?.focus({ preventScroll: true });
  });

  const formatVoiceDuration = (seconds) => {
    const wholeSeconds = Math.max(0, Math.floor(seconds));
    return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
  };

  const voiceMimeTypes = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg"];

  const uploadVoice = async (state, audioBlob) => {
    if (!audioBlob || !audioBlob.size) {
      state.setStatus("Aucun son n’a été enregistré. Réessaie.", "error");
      return;
    }
    if (audioBlob.size > MAX_VOICE_BYTES) {
      state.setStatus("Ce vocal dépasse 200 Ko. Essaie un enregistrement plus court.", "error");
      return;
    }

    const form = state.form;
    const subject = form?.elements.namedItem("subject")?.value || visitorConversation?.subject || "💬 Discussion";
    const isReply = form === contactReplyForm;
    const submitButton = form?.querySelector("[data-contact-submit], [data-contact-reply-submit]");
    state.sending = true;
    state.sendButton.disabled = true;
    state.recordButton.disabled = true;
    if (submitButton) submitButton.disabled = true;
    state.setStatus("Envoi du vocal…");

    try {
      const response = await fetch("/api/contact-audio", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": audioBlob.type || "audio/webm",
          "X-Conversation-Subject": encodeURIComponent(subject),
          ...(newConversationMode && !isReply ? { "X-New-Conversation": "true" } : {}),
        },
        credentials: "same-origin",
        cache: "no-store",
        body: audioBlob,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        state.setStatus(data.error || "Le vocal n’a pas pu être envoyé. Réessaie.", "error");
        return;
      }
      updateConversationFromResponse(data);
      newConversationMode = false;
      state.reset();
      renderContactState();
      markVisitorThreadSeen();
      state.setStatus("Vocal envoyé.", "success");
    } catch {
      state.setStatus("Impossible de joindre le serveur. Réessaie.", "error");
    } finally {
      state.sending = false;
      state.sendButton.disabled = false;
      state.recordButton.disabled = false;
      if (submitButton) submitButton.disabled = false;
    }
  };

  document.querySelectorAll("[data-voice-controls]").forEach((controls) => {
    const recordButton = controls.querySelector("[data-voice-record]");
    const recorderPanel = controls.querySelector("[data-voice-recorder]");
    const waveform = controls.querySelector("[data-voice-wave]");
    const timer = controls.querySelector("[data-voice-timer]");
    const cancelButton = controls.querySelector("[data-voice-cancel]");
    const sendButton = controls.querySelector("[data-voice-send]");
    const status = controls.querySelector("[data-voice-status]");
    const form = controls.closest("form");
    if (!recordButton || !recorderPanel || !timer || !cancelButton || !sendButton || !status || !form) return;

    for (let index = 0; index < 28; index += 1) {
      const bar = document.createElement("span");
      bar.style.setProperty("--wave-height", `${20 + ((index * 17 + 11) % 72)}%`);
      bar.style.setProperty("--wave-delay", `${-(index * 37)}ms`);
      waveform?.append(bar);
    }

    const state = {
      recordButton,
      recorderPanel,
      cancelButton,
      sendButton,
      form,
      recorder: null,
      stream: null,
      chunks: [],
      recordedBlob: null,
      timerId: 0,
      startedAt: 0,
      byteCount: 0,
      cancelled: false,
      overflow: false,
      sendAfterStop: false,
      sending: false,
      setStatus: (message, kind = "") => setStatusNode(status, message, kind),
      stopStream() {
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
      },
      reset() {
        window.clearInterval(this.timerId);
        this.timerId = 0;
        this.stopStream();
        this.recorder = null;
        this.chunks = [];
        this.recordedBlob = null;
        this.byteCount = 0;
        this.cancelled = false;
        this.overflow = false;
        this.sendAfterStop = false;
        this.recorderPanel.hidden = true;
        this.recorderPanel.dataset.recording = "false";
        this.recordButton.hidden = false;
        this.recordButton.disabled = false;
        this.sendButton.disabled = false;
        this.setStatus("");
        timer.textContent = "0:00 / 1:00";
      },
      cancel() {
        this.cancelled = true;
        this.sendAfterStop = false;
        if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
        else this.reset();
      },
    };
    voiceControlStates.push(state);

    if (!navigator.mediaDevices?.getUserMedia || typeof window.MediaRecorder !== "function") {
      recordButton.hidden = true;
      state.setStatus("L’enregistrement vocal n’est pas disponible dans ce navigateur.");
      return;
    }

    const updateTimer = () => {
      const elapsed = Math.min(MAX_VOICE_DURATION_SECONDS, (performance.now() - state.startedAt) / 1000);
      timer.textContent = `${formatVoiceDuration(elapsed)} / 1:00`;
      if (elapsed >= MAX_VOICE_DURATION_SECONDS && state.recorder?.state === "recording") {
        state.setStatus("Une minute maximum. Tu peux envoyer ou supprimer le vocal.");
        state.recorder.stop();
      }
    };

    recordButton.addEventListener("click", async () => {
      if (state.sending || state.recorder?.state === "recording") return;
      recordButton.disabled = true;
      state.setStatus("Autorise l’accès au micro…");
      try {
        state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const preferredType = voiceMimeTypes.find((type) => window.MediaRecorder.isTypeSupported?.(type));
        let recorder;
        try {
          recorder = new window.MediaRecorder(state.stream, {
            audioBitsPerSecond: 24_000,
            ...(preferredType ? { mimeType: preferredType } : {}),
          });
        } catch {
          recorder = new window.MediaRecorder(state.stream, { audioBitsPerSecond: 24_000 });
        }
        state.recorder = recorder;
        state.chunks = [];
        state.byteCount = 0;
        state.startedAt = performance.now();
        state.cancelled = false;
        state.overflow = false;
        state.sendAfterStop = false;
        state.recordButton.hidden = true;
        state.recorderPanel.hidden = false;
        state.recorderPanel.dataset.recording = "true";
        state.setStatus("Enregistrement en cours…");

        recorder.addEventListener("dataavailable", (event) => {
          if (performance.now() - state.startedAt >= MAX_VOICE_DURATION_SECONDS * 1000 && recorder.state === "recording") {
            state.setStatus("Une minute maximum. Tu peux envoyer ou supprimer le vocal.");
            recorder.stop();
          }
          if (!event.data?.size) return;
          state.byteCount += event.data.size;
          if (state.byteCount > MAX_VOICE_BYTES) {
            state.overflow = true;
            state.sendAfterStop = false;
            state.setStatus("Ce navigateur a dépassé 200 Ko. Annule ou recommence plus court.", "error");
            if (recorder.state !== "inactive") recorder.stop();
            return;
          }
          state.chunks.push(event.data);
        });
        recorder.addEventListener("stop", () => {
          window.clearInterval(state.timerId);
          state.timerId = 0;
          state.stopStream();
          state.recorderPanel.dataset.recording = "false";
          if (state.cancelled) {
            state.reset();
            return;
          }
          if (state.overflow) {
            state.sendButton.disabled = true;
            state.setStatus("Vocal trop volumineux (maximum 200 Ko). Essaie plus court.", "error");
            return;
          }
          state.recordedBlob = new Blob(state.chunks, { type: recorder.mimeType || preferredType || "audio/webm" });
          if (state.sendAfterStop) {
            void uploadVoice(state, state.recordedBlob);
          } else {
            state.setStatus("Enregistrement terminé. Envoie-le ou supprime-le.");
          }
        }, { once: true });
        recorder.start(500);
        state.timerId = window.setInterval(updateTimer, 200);
        updateTimer();
      } catch (error) {
        state.reset();
        recordButton.disabled = false;
        state.setStatus(error?.name === "NotAllowedError"
          ? "Le micro est bloqué. Autorise-le dans les réglages du navigateur."
          : "Impossible de démarrer le micro sur cet appareil.", "error");
      }
    });

    sendButton.addEventListener("click", () => {
      if (state.sending) return;
      if (state.recorder?.state === "recording") {
        state.sendAfterStop = true;
        sendButton.disabled = true;
        state.setStatus("Préparation du vocal…");
        state.recorder.stop();
      } else if (state.recordedBlob) {
        void uploadVoice(state, state.recordedBlob);
      }
    });

    cancelButton.addEventListener("click", () => {
      state.cancelled = true;
      state.sendAfterStop = false;
      state.setStatus("");
      if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
      else state.reset();
    });
  });

  if (contactLauncher && contactWidget) {
    contactLauncher.addEventListener("click", () => {
      if (contactWidget.hidden) openContactWidget();
      else minimizeContactWidget();
    });
    minimizeContactButton?.addEventListener("click", minimizeContactWidget);

    contactScrim?.addEventListener("click", minimizeContactWidget);
    document.addEventListener("keydown", (event) => {
      if (contactWidget.hidden || document.querySelector("dialog[open]")) return;
      if (event.key === "Escape") {
        minimizeContactWidget();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...contactWidget.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")]
        .filter((element) => !element.hidden && !element.closest("[hidden]"));
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || !contactWidget.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !contactWidget.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    });

    newConversationButton?.addEventListener("click", () => {
      if (visitorConversation?.status !== "closed") return;
      newConversationMode = true;
      contactThread.hidden = true;
      contactAuth.hidden = true;
      contactNewView.hidden = false;
      setContactStatus("");
      const messageInput = contactForm?.elements.namedItem("message");
      if (messageInput) messageInput.value = "";
      contactForm?.elements.namedItem("subject")?.focus({ preventScroll: true });
    });

    void loadVisitorConversation();
    visitorPollTimer = window.setInterval(() => {
      if (visitorAccount && !newConversationMode) void loadVisitorConversation({ quiet: true });
    }, 20_000);
  } else if (contactLauncher) {
    contactLauncher.hidden = true;
  }

  const profileImage = document.querySelector("[data-profile-image]");
  if (profileImage) {
    const hideUnavailableProfileImage = () => (profileImage.hidden = true);
    profileImage.addEventListener("error", hideUnavailableProfileImage, { once: true });
    if (profileImage.complete && profileImage.naturalWidth === 0) {
      hideUnavailableProfileImage();
    }
  }

  const ticker = document.querySelector("[data-ticker]");
  const tickerTrack = ticker?.querySelector("[data-ticker-track]");
  const tickerSet = tickerTrack?.querySelector("[data-ticker-set]");
  let tickerCycleWidth = 0;
  let tickerPosition = 0;

  const ensureTickerCopies = () => {
    if (!ticker || !tickerTrack || !tickerSet) return;

    tickerCycleWidth = tickerSet.getBoundingClientRect().width;
    if (!tickerCycleWidth) return;

    const minimumWidth = ticker.clientWidth + tickerCycleWidth;
    let copiesAdded = 0;
    while (tickerTrack.scrollWidth < minimumWidth && copiesAdded < 8) {
      const copy = tickerSet.cloneNode(true);
      copy.removeAttribute("data-ticker-set");
      copy.dataset.tickerCopy = "true";
      copy.setAttribute("aria-hidden", "true");
      copy.inert = true;
      tickerTrack.append(copy);
      copiesAdded += 1;
    }
  };

  const applyTickerUpdates = (updates) => {
    latestTickerUpdates = updates;
    const twitch = updates?.twitch;
    const twitchAvailable = twitch?.available === true && typeof twitch.isLive === "boolean";
    const isLive = twitchAvailable && twitch.isLive;
    const streamTitle = typeof twitch?.title === "string" ? twitch.title.trim() : "";
    currentTwitchIsLive = isLive;
    updateScheduleCountdown();
    renderLivePlayer(isLive, twitch);

    document.querySelectorAll("[data-ticker-live]").forEach((item) => {
      item.dataset.live = twitchAvailable ? (isLive ? "true" : "false") : "unknown";
      const label = item.querySelector("[data-live-label]");
      const message = item.querySelector("[data-live-message]");
      if (label) label.textContent = isLive ? "EN DIRECT" : "TWITCH";
      if (message) {
        message.textContent = !twitchAvailable
          ? "Suis la chaîne pour les prochains lives"
          : isLive
            ? streamTitle
              ? `Gionny est en live : ${streamTitle}`
              : "Gionny est en live, rejoins le chat"
            : "À bientôt sur Twitch";
      }
      item.href = safeTwitchUrl(twitch?.url);
    });

    document.querySelectorAll("[data-twitch-card]").forEach((card) => {
      card.dataset.live = twitchAvailable ? (isLive ? "true" : "false") : "unknown";
      const status = card.querySelector("[data-stream-status]");
      const title = card.querySelector("[data-stream-title]");
      const visitedBadge = card.querySelector(".visited-badge");
      if (status) status.hidden = !isLive;
      if (visitedBadge) visitedBadge.hidden = isLive || !visitedNetworks.has("twitch");
      if (title) {
        title.textContent = streamTitle;
        title.hidden = !isLive || !streamTitle;
      }
    });

    const youtube = updates?.youtube;
    const youtubeUrl = safeYouTubeUrl(youtube?.url);
    const youtubeVideoAvailable = youtube?.available === true && youtubeUrl !== DEFAULT_YOUTUBE_URL;
    const youtubeTitle = typeof youtube?.title === "string" ? youtube.title.trim() : "";
    const configuredYouTubeUrl = safeSocialUrl("youtube", configuredSocials.youtube) || DEFAULT_YOUTUBE_URL;
    const usesDefaultYouTubeChannel = configuredYouTubeUrl === DEFAULT_YOUTUBE_URL;

    latestYouTubeUrl = youtubeVideoAvailable && usesDefaultYouTubeChannel ? youtubeUrl : "";
    document.querySelectorAll("[data-video-title]").forEach((title) => {
      title.textContent = latestYouTubeUrl
        ? youtubeTitle || "Voir la dernière vidéo"
        : usesDefaultYouTubeChannel
          ? "Voir la chaîne YouTube"
          : "Ouvrir la chaîne YouTube";
    });

    recentYouTubeUploads = Array.isArray(youtube?.uploads)
      ? youtube.uploads.filter(
          (upload) =>
            upload &&
            typeof upload.id === "string" &&
            typeof upload.publishedAt === "string" &&
            Number.isFinite(Date.parse(upload.publishedAt))
        )
      : [];
    youtubeApiAvailable = youtube?.available === true && usesDefaultYouTubeChannel;
    if (youtubeApiAvailable) {
      renderYouTubeVisitState(countUnseenYouTubeUploads(recentYouTubeUploads), true);
    } else {
      renderYouTubeVisitState(0, false);
    }

    applyConfiguredLinks();
    ensureTickerCopies();
  };

  const refreshSiteConfig = async () => {
    try {
      const response = await fetch("/api/site-config", {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = await response.json();
      applySiteConfig(data?.config);
    } catch {
      // Keep the static links and planning if the shared settings service is unavailable.
    }
  };

  let updateInFlight = false;
  const refreshTicker = async () => {
    if (updateInFlight || document.hidden) return;
    updateInFlight = true;

    try {
      const response = await fetch("/api/updates", {
        headers: { Accept: "application/json" },
      });
      applyTickerUpdates(response.ok ? await response.json() : null);
    } catch {
      applyTickerUpdates(null);
    } finally {
      updateInFlight = false;
    }
  };

  if (ticker && tickerTrack && tickerSet) {
    let keyboardFocus = false;
    let mouseHovering = false;
    let touching = false;
    let resumeAt = 0;
    let lastFrame = 0;

    ensureTickerCopies();
    tickerPosition = ticker.scrollLeft;
    document.fonts?.ready.then(ensureTickerCopies);
    window.addEventListener("resize", ensureTickerCopies, { passive: true });

    ticker.addEventListener("focusin", () => {
      keyboardFocus = true;
      tickerPosition = ticker.scrollLeft;
    });
    ticker.addEventListener("focusout", (event) => {
      if (!ticker.contains(event.relatedTarget)) {
        keyboardFocus = false;
        tickerPosition = ticker.scrollLeft;
      }
    });
    ticker.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse") return;
      mouseHovering = true;
      tickerPosition = ticker.scrollLeft;
    });
    ticker.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "mouse") return;
      mouseHovering = false;
      tickerPosition = ticker.scrollLeft;
      resumeAt = performance.now() + 1000;
    });
    ticker.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse") {
        touching = true;
        tickerPosition = ticker.scrollLeft;
      }
    });
    ticker.addEventListener(
      "touchstart",
      () => {
        touching = true;
        tickerPosition = ticker.scrollLeft;
      },
      { passive: true }
    );

    const finishTouch = () => {
      if (!touching) return;
      touching = false;
      tickerPosition = ticker.scrollLeft;
      resumeAt = performance.now() + 2600;
    };
    window.addEventListener("pointerup", finishTouch, { passive: true });
    window.addEventListener(
      "pointercancel",
      (event) => {
        if (event.pointerType !== "touch") finishTouch();
      },
      { passive: true }
    );
    window.addEventListener("touchend", finishTouch, { passive: true });
    window.addEventListener("touchcancel", finishTouch, { passive: true });
    ticker.addEventListener(
      "wheel",
      () => {
        resumeAt = performance.now() + 2600;
        window.requestAnimationFrame(() => {
          tickerPosition = ticker.scrollLeft;
        });
      },
      { passive: true }
    );

    // Keep the ticker moving even with reduced motion enabled, as requested.
    const animateTicker = (now) => {
      if (!lastFrame) lastFrame = now;
      const elapsed = Math.min(now - lastFrame, 120);
      lastFrame = now;

      if (!keyboardFocus && !mouseHovering && !touching && !document.hidden && now >= resumeAt) {
        tickerCycleWidth = tickerSet.getBoundingClientRect().width;
        if (tickerCycleWidth > 0) {
          tickerPosition = (tickerPosition + elapsed * 0.045) % tickerCycleWidth;
          ticker.scrollLeft = tickerPosition;
        }
      }

      window.requestAnimationFrame(animateTicker);
    };
    window.requestAnimationFrame(animateTicker);
  }

  window.addEventListener("resize", scheduleLiveOverflowCheck, { passive: true });
  void refreshSiteConfig();
  void refreshTicker();
  void refreshDiscordStatus();
  window.setInterval(refreshTicker, 60_000);
  window.setInterval(refreshDiscordStatus, 30_000);
  window.setInterval(updateScheduleCountdown, 1_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void refreshTicker();
      void refreshDiscordStatus();
    }
  });

  const canFollowPointer =
    window.matchMedia("(hover: hover) and (pointer: fine)").matches &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (canFollowPointer) {
    let frame = 0;
    let pointerX = window.innerWidth / 2;
    let pointerY = window.innerHeight * 0.42;

    window.addEventListener(
      "pointermove",
      (event) => {
        if (event.pointerType !== "mouse") return;

        pointerX = event.clientX;
        pointerY = event.clientY;
        if (frame) return;

        frame = window.requestAnimationFrame(() => {
          document.documentElement.style.setProperty("--pointer-x", `${pointerX}px`);
          document.documentElement.style.setProperty("--pointer-y", `${pointerY}px`);
          frame = 0;
        });
      },
      { passive: true }
    );
  }
})();
