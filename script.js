(() => {
  const pageScrollLockOwners = new Set();
  let savedPageScrollStyles = null;

  const syncVisualViewportBounds = () => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    if (!root) return;
    const height = Math.max(1, Math.round(viewport?.height || window.innerHeight || root.clientHeight));
    const top = Math.max(0, Math.round(viewport?.offsetTop || 0));
    root.style.setProperty("--qg-visual-viewport-height", `${height}px`);
    root.style.setProperty("--qg-visual-viewport-top", `${top}px`);
  };

  syncVisualViewportBounds();
  window.addEventListener("resize", syncVisualViewportBounds, { passive: true });
  window.visualViewport?.addEventListener("resize", syncVisualViewportBounds, { passive: true });
  window.visualViewport?.addEventListener("scroll", syncVisualViewportBounds, { passive: true });

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
      body.style.left = "0";
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
    const count = Math.max(0, Number(unseenCount) || 0);
    document.querySelectorAll("[data-youtube-count]").forEach((countBadge) => {
      countBadge.hidden = !available || count === 0;
      if (count > 0) {
        countBadge.textContent = String(Math.min(count, 3));
        countBadge.setAttribute(
          "aria-label",
          `${count} nouvelle${count > 1 ? "s" : ""} vidéo${count > 1 ? "s" : ""}`
        );
      }
    });
    document.querySelectorAll("[data-youtube-visited]").forEach((visitedBadge) => {
      visitedBadge.hidden = available ? count > 0 : !visitedNetworks.has("youtube");
    });
    const youtubeSlideLabel = document.querySelector('[data-carousel-slide="youtube"] .creator-state-pill--youtube');
    if (youtubeSlideLabel) {
      youtubeSlideLabel.hidden = available ? count > 0 : visitedNetworks.has("youtube");
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
    const twitchIsLive = link.dataset.network === "twitch" && link.dataset.live === "true";
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
        (link.hasAttribute("data-youtube-card") || link.hasAttribute("data-ticker-youtube") || link.hasAttribute("data-carousel-youtube"));
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

  const getNextScheduledDayKey = () => {
    if (!nextScheduledLiveAt) return "";
    const parisDate = readParisDateParts(nextScheduledLiveAt);
    const weekdayIndex = new Date(Date.UTC(parisDate.year, parisDate.month - 1, parisDate.day)).getUTCDay();
    return PARIS_DAY_KEYS[weekdayIndex] || "";
  };

  const updateHighlightedScheduleDay = () => {
    const nextDayKey = getNextScheduledDayKey();
    document.querySelectorAll("[data-schedule-day]").forEach((item) => {
      const isNextLive = Boolean(nextDayKey) && item.dataset.scheduleDay === nextDayKey;
      item.toggleAttribute("data-next-live", isNextLive);
      const nextLabel = item.querySelector(".schedule-day-next-label");
      if (nextLabel) nextLabel.hidden = !isNextLive;
      if (isNextLive) {
        item.setAttribute("aria-current", "date");
        item.setAttribute("aria-label", `${item.querySelector(".schedule-day-name")?.textContent || "Jour"}, prochain live`);
      } else {
        item.removeAttribute("aria-current");
        item.setAttribute("aria-label", item.querySelector(".schedule-day-name")?.textContent || "Jour de live");
      }
    });
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
    updateHighlightedScheduleDay();

    if (!nextScheduledLiveAt) {
      countdownPrefix.hidden = true;
      countdownValue.dataset.empty = "true";
      countdownValue.textContent = "Aucun live programmé";
      countdownValue.setAttribute("aria-label", "Aucun live programmé");
      return;
    }

    countdownPrefix.hidden = false;
    delete countdownValue.dataset.empty;
    const remainingSeconds = Math.max(0, Math.floor((nextScheduledLiveAt - Date.now()) / 1000));
    const hours = Math.floor(remainingSeconds / 3600);
    const minutes = Math.floor((remainingSeconds % 3600) / 60);
    const seconds = remainingSeconds % 60;
    const formattedHours = String(hours).padStart(2, "0");
    const formattedMinutes = String(minutes).padStart(2, "0");
    const formattedSeconds = String(seconds).padStart(2, "0");
    countdownValue.textContent = `${formattedHours}:${formattedMinutes}:${formattedSeconds}`;
    countdownValue.setAttribute("aria-label", `Prochain live dans ${hours} heures, ${minutes} minutes et ${seconds} secondes`);
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
      updateHighlightedScheduleDay();
      return;
    }

    for (const { key, label } of activeDays) {
      const item = document.createElement("li");
      item.dataset.scheduleDay = key;
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
      const nextLabel = document.createElement("span");
      nextLabel.className = "schedule-day-next-label";
      nextLabel.textContent = "PROCHAIN";
      nextLabel.hidden = key !== getNextScheduledDayKey();
      item.append(nextLabel);
      daysList.append(item);
    }
    updateHighlightedScheduleDay();
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
  const contactHeaderSubject = document.querySelector("[data-contact-header-subject]");
  const minimizeContactButton = document.querySelector("[data-minimize-contact]");
  const contactAuth = document.querySelector("[data-contact-auth]");
  const authForm = document.querySelector("[data-auth-form]");
  const authSubmit = document.querySelector("[data-auth-submit]");
  const authSubmitLabel = document.querySelector("[data-auth-submit-label]");
  const authStatus = document.querySelector("[data-auth-status]");
  const authTabs = [...document.querySelectorAll("[data-auth-tab]")];
  const memberAccessBar = document.querySelector("[data-member-access]");
  const memberVisitorIdentity = document.querySelector("[data-member-visitor]");
  const memberIdentity = document.querySelector("[data-member-identity]");
  const memberLoggedOut = document.querySelector("[data-member-logged-out]");
  const memberLoggedIn = document.querySelector("[data-member-logged-in]");
  const memberPseudo = document.querySelector("[data-member-pseudo]");
  const memberVerifiedBadge = document.querySelector("[data-member-verified-badge]");
  const hostAdminLink = document.querySelector("[data-host-admin-link]");
  const memberAvatarImage = document.querySelector("[data-member-avatar]");
  const sitePresence = document.querySelector("[data-site-presence]");
  const sitePresenceCount = document.querySelector("[data-site-presence-count]");
  const welcomeTitle = document.querySelector("[data-intro-title]");
  const welcomeName = document.querySelector("[data-welcome-name]");
  const welcomeComma = document.querySelector("[data-welcome-comma]");
  const memberCrown = document.querySelector("[data-member-crown]");
  const memberProfileCrown = document.querySelector("[data-member-profile-crown]");
  const memberLoginButton = document.querySelector("[data-member-login]");
  const memberRegisterButton = document.querySelector("[data-member-register]");
  const profileDialog = document.querySelector("[data-profile-dialog]");
  const profileOpenButton = document.querySelector("[data-member-profile]");
  const profileCloseButtons = profileDialog?.querySelectorAll("[data-profile-close]") || [];
  const profilePseudoForm = document.querySelector("[data-profile-pseudo-form]");
  const profilePseudoInput = profilePseudoForm?.elements.namedItem("pseudo");
  const profilePseudoSubmit = document.querySelector("[data-profile-pseudo-submit]");
  const profilePseudoEditButton = document.querySelector("[data-profile-pseudo-edit]");
  const profilePseudoCancelButton = document.querySelector("[data-profile-pseudo-cancel]");
  const profileDisplayName = document.querySelector("[data-profile-display-name]");
  const profileAvatarTrigger = document.querySelector("[data-profile-avatar-trigger]");
  const profileAvatarFile = document.querySelector("[data-profile-avatar-file]");
  const profileAvatarImage = document.querySelector("[data-profile-avatar]");
  const profileAvatarFallback = document.querySelector("[data-profile-avatar-fallback]");
  const profileAvatarStatus = document.querySelector("[data-profile-avatar-status]");
  const profilePseudoStatus = document.querySelector("[data-profile-pseudo-status]");
  const profileCooldownStatus = document.querySelector("[data-profile-cooldown]");
  const profileCrown = document.querySelector("[data-profile-crown]");
  const profileVerifiedBadge = document.querySelector("[data-profile-verified-badge]");
  const profilePasswordToggle = document.querySelector("[data-profile-password-toggle]");
  const profilePasswordPlus = document.querySelector("[data-password-toggle-plus]");
  const profilePasswordMinus = document.querySelector("[data-password-toggle-minus]");
  const profilePasswordForm = document.querySelector("[data-profile-password-form]");
  const profilePasswordSubmit = document.querySelector("[data-profile-password-submit]");
  const profilePasswordStatus = document.querySelector("[data-profile-password-status]");
  const profileLogoutButton = document.querySelector("[data-profile-logout]");
  const accountHostCrown = document.querySelector("[data-account-host-crown]");
  const accountVerifiedBadge = document.querySelector("[data-account-verified-badge]");
  const contactThreadCrown = document.querySelector("[data-contact-thread-crown]");
  const contactThreadVerifiedBadge = document.querySelector("[data-contact-thread-verified-badge]");
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
  const MAX_VOICE_BYTES = 200_000;
  const USERNAME_CHANGE_COOLDOWN_MS = 15 * 24 * 60 * 60 * 1000;
  const CHAT_SUBJECTS = ["Passer en live", "Idée vidéo / React", "Histoire / Anecdote", "Question", "Discussion"];
  let profileSaving = false;

  let visitorAccount = null;
  let visitorConversation = null;
  let visitorConversationMessages = [];
  let newConversationMode = false;
  let visitorConversationLoading = false;
  let visitorPollTimer = 0;
  let visitorReadMarkKey = "";
  let visitorReadMarkInProgress = false;
  let authMode = "register";
  const voiceControlStates = [];
  const chatComposerStates = new WeakMap();
  let lastContactTrigger = null;

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
    const pseudo = authForm?.elements.namedItem("pseudo");
    if (pseudo) {
      pseudo.minLength = authMode === "login" ? 0 : 3;
      pseudo.maxLength = authMode === "login" ? 128 : 16;
      pseudo.removeAttribute("pattern");
      pseudo.title = authMode === "login" ? "Saisis le pseudo utilisé lors de la création du compte." : "3 à 16 caractères après suppression des espaces de début et de fin.";
    }
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
    if (!visitorConversation || !contactWidget || contactWidget.hidden || visitorAccount?.role === "host") return;
    const incoming = visitorConversationMessages.filter((message) => message.sender === "gionny");
    const lastGionnyMessage = incoming.at(-1);
    if (lastGionnyMessage) {
      try {
        localStorage.setItem(`${VISITOR_SEEN_PREFIX}${visitorConversation.id}`, lastGionnyMessage.id);
      } catch {
        // A full or disabled local store must not prevent opening the conversation.
      }
    }
    if (contactBadge) contactBadge.hidden = true;
    const unreadIds = incoming.filter((message) => message.read !== true).map((message) => message.id);
    const requestKey = `${visitorConversation.id}:${unreadIds.join(",")}`;
    if (!unreadIds.length || visitorReadMarkInProgress || requestKey === visitorReadMarkKey) return;
    visitorReadMarkKey = requestKey;
    visitorReadMarkInProgress = true;
    fetch("/api/contact", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ action: "mark-read" }),
    }).then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) throw new Error("read_receipt_failed");
      const readIds = new Set(unreadIds);
      visitorConversationMessages = visitorConversationMessages.map((message) =>
        readIds.has(message.id) ? { ...message, read: true } : message
      );
      visitorReadMarkKey = "";
      renderVisitorConversation();
    }).catch(() => {
      visitorReadMarkKey = "";
    }).finally(() => {
      visitorReadMarkInProgress = false;
    });
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
    const rawPseudo = profilePseudoInput.value.normalize("NFKC");
    const cleanedPseudo = rawPseudo.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ");
    const pseudoIsValid = rawPseudo === rawPseudo.trim() && cleanedPseudo.length >= 3 && cleanedPseudo.length <= 16;
    const hasChanged = cleanedPseudo !== visitorAccount.pseudo;
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
    profilePseudoSubmit.disabled = profileSaving || !pseudoIsValid || !hasChanged || daysRemaining > 0;
    if (profilePseudoEditButton) profilePseudoEditButton.disabled = profileSaving;
    if (profilePseudoCancelButton) profilePseudoCancelButton.disabled = profileSaving;
    if (profileAvatarTrigger) profileAvatarTrigger.disabled = profileSaving;
    if (profilePasswordSubmit) profilePasswordSubmit.disabled = profileSaving;
  };

  const createHostCrownBadge = (className) => {
    const badge = document.createElement("span");
    badge.className = className;
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", "Compte Hôte");
    badge.title = "Compte Hôte";
    if (typeof window.qgIcon === "function") badge.append(window.qgIcon("crown", "host-crown-icon"));
    return badge;
  };

  const createVerifiedBadge = (className = "verified-badge") => {
    const badge = document.createElement("span");
    badge.className = className;
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", "Membre vérifié");
    badge.title = "Membre vérifié";
    if (typeof window.qgIcon === "function") badge.append(window.qgIcon("verified", "verified-badge-icon"));
    return badge;
  };

  const subjectIcon = (subject) => ({
    "Passer en live": "live",
    "Idée vidéo / React": "bulb",
    "Histoire / Anecdote": "book",
    "Question": "help",
    Discussion: "chat",
  }[subject] || "chat");

  const renderSubjectLabel = (element, subject) => {
    if (!element) return;
    const label = CHAT_SUBJECTS.includes(subject) ? subject : "Discussion";
    const text = document.createElement("span");
    text.textContent = label;
    const icon = typeof window.qgIcon === "function" ? window.qgIcon(subjectIcon(label), "subject-label-icon") : null;
    element.replaceChildren(...(icon ? [icon, text] : [text]));
  };

  const createChatAvatar = (source, pseudo, className) => {
    const avatar = document.createElement("span");
    avatar.className = className;
    avatar.setAttribute("aria-hidden", "true");
    if (typeof source === "string" && source) {
      const image = document.createElement("img");
      image.src = source;
      image.alt = "";
      avatar.append(image);
    } else {
      avatar.textContent = (String(pseudo || "M").trim().charAt(0) || "M").toLocaleUpperCase("fr-FR");
    }
    return avatar;
  };

  const createVisitorChatMessage = (message) => {
    const item = document.createElement("article");
    const sender = message.sender === "gionny" ? "gionny" : "visitor";
    item.className = `contact-chat-message contact-chat-message--${sender}`;
    const senderPseudo = typeof message.pseudo === "string" && message.pseudo.trim()
      ? message.pseudo
      : sender === "gionny" ? "Gionny" : visitorAccount?.pseudo || visitorConversation?.pseudo || "Membre";
    const isHostMessage = message.isHost === true || sender === "gionny";
    const avatarSource = message.avatarData || (sender === "gionny" ? "/assets/gionny-profile.jpg" : visitorAccount?.avatarData || "");
    const identity = document.createElement("div");
    identity.className = "contact-chat-identity";
    identity.append(createChatAvatar(avatarSource, senderPseudo, "contact-chat-avatar"));
    const name = document.createElement("span");
    name.className = "contact-chat-sender";
    name.textContent = senderPseudo;
    if (isHostMessage) name.append(createHostCrownBadge("contact-chat-host-crown"));
    else if ((Array.isArray(message.badges) && message.badges.includes("verified")) || visitorAccount?.badges?.includes("verified")) {
      name.append(createVerifiedBadge("contact-chat-verified-badge"));
    }
    identity.append(name);
    item.append(identity);

    if (message.kind === "audio" || message.hasAudio) {
      item.classList.add("contact-chat-message--audio");
      const audioUrl = `/api/contact-audio?conversationId=${encodeURIComponent(visitorConversation.id)}&messageId=${encodeURIComponent(message.id)}`;
      const player = typeof window.createQGVoicePlayer === "function"
        ? window.createQGVoicePlayer(audioUrl, `Message vocal de ${senderPseudo}`, { peaks: message.audioPeaks })
        : document.createElement("p");
      if (player.tagName === "P") player.textContent = "Le lecteur vocal est indisponible.";
      player.classList.add("contact-chat-audio");
      item.append(player);
    } else if (message.kind === "image" || message.hasImage) {
      const imageUrl = message.pending && typeof message.previewUrl === "string" && message.previewUrl
        ? message.previewUrl
        : `/api/contact-image?conversationId=${encodeURIComponent(visitorConversation.id)}&messageId=${encodeURIComponent(message.id)}`;
      const imageButton = document.createElement("button");
      imageButton.type = "button";
      imageButton.className = "chat-attachment-image";
      imageButton.setAttribute("aria-label", `Agrandir l’image envoyée par ${senderPseudo}`);
      const image = document.createElement("img");
      image.src = imageUrl;
      image.alt = "Image jointe à la discussion";
      image.loading = "lazy";
      imageButton.append(image);
      imageButton.addEventListener("click", () => window.qgImageTools?.openImageViewer(imageUrl, image.alt));
      item.append(imageButton);
      if (typeof message.text === "string" && message.text) {
        const caption = document.createElement("p");
        caption.className = "contact-chat-text contact-chat-caption";
        caption.textContent = message.text;
        item.append(caption);
      }
    } else {
      const text = document.createElement("p");
      text.className = "contact-chat-text";
      text.textContent = typeof message.text === "string" ? message.text : "";
      item.append(text);
    }

    const meta = document.createElement("div");
    meta.className = "contact-chat-meta";
    const date = document.createElement("time");
    date.className = "contact-chat-date";
    date.dateTime = message.createdAt;
    date.textContent = formatConversationTime(message.createdAt);
    meta.append(date);
    const isOwnMessage = visitorAccount?.role === "host" ? sender === "gionny" : sender === "visitor";
    if (isOwnMessage) {
      const receipt = document.createElement("span");
      receipt.className = "chat-read-receipt";
      receipt.dataset.state = message.pending ? "sending" : message.read === true ? "read" : "sent";
      receipt.setAttribute("aria-label", message.read === true ? "Message lu" : "Message envoyé");
      receipt.title = message.read === true ? "Lu" : "Envoyé";
      if (typeof window.qgIcon === "function") receipt.append(window.qgIcon(message.pending ? "check" : "check-double", "chat-receipt-icon"));
      meta.append(receipt);
    }
    item.append(meta);
    return item;
  };

  const renderVisitorConversation = ({ announceNewReply = false } = {}) => {
    if (!visitorConversation || !contactThread || !contactNewView) return;
    if (contactAuth) contactAuth.hidden = true;
    contactNewView.hidden = true;
    contactThread.hidden = false;
    contactThreadPseudo.textContent = visitorConversation.pseudo || visitorAccount?.pseudo || "Ta discussion privée";
    const currentSubject = visitorConversation.subject || "Discussion";
    renderSubjectLabel(contactThreadSubject, currentSubject);
    renderSubjectLabel(contactHeaderSubject, currentSubject);
    if (contactThreadVerifiedBadge) contactThreadVerifiedBadge.hidden = !visitorAccount?.badges?.includes("verified");
    contactThreadState.textContent = visitorConversation.status === "blocked"
      ? "Bloquée"
      : visitorConversation.status === "closed"
        ? "Fermée"
        : "Ouverte";
    contactThreadState.dataset.state = visitorConversation.status;

    const canReply = visitorConversation.status === "open";
    contactReplyForm.hidden = !canReply;
    chatComposerStates.get(contactReplyForm)?.voice?.syncAvailability();
    contactThreadClosed.hidden = canReply;
    contactThreadClosedCopy.textContent = visitorConversation.status === "blocked"
      ? "Cette discussion a été bloquée. Tu ne peux plus y envoyer de message."
      : "Cette discussion est fermée. Tu peux démarrer un nouveau fil si tu as une autre question.";
    newConversationButton.hidden = visitorConversation.status !== "closed";
    const subjectInput = contactReplyForm?.elements.namedItem("subject");
    if (subjectInput) subjectInput.value = visitorConversation.subject || "Discussion";

    const messageSignature = visitorConversationMessages.map((message) =>
      `${message.id}:${message.kind || "text"}:${message.sender || ""}:${message.pseudo || ""}:${message.isHost === true}:${message.read === true}:${message.avatarData || ""}:${Array.isArray(message.audioPeaks) ? message.audioPeaks.join(",") : ""}:${Array.isArray(message.badges) ? message.badges.join(",") : ""}`
    ).join("|");
    if (contactThreadMessages.dataset.messageSignature !== messageSignature) {
      const wasNearBottom = contactThreadMessages.scrollHeight - contactThreadMessages.scrollTop - contactThreadMessages.clientHeight < 80;
      const renderedMessages = visitorConversationMessages.map(createVisitorChatMessage);
      if (visitorConversationMessages.length === 0) {
        const emptyNote = document.createElement("p");
        emptyNote.className = "contact-chat-empty-note";
        emptyNote.textContent = "Ta discussion est prête. Tu peux écrire ou enregistrer ton premier message.";
        renderedMessages.push(emptyNote);
      }
      contactThreadMessages.replaceChildren(...renderedMessages);
      contactThreadMessages.dataset.messageSignature = messageSignature;
      if (wasNearBottom) contactThreadMessages.scrollTop = contactThreadMessages.scrollHeight;
    }

    const unreadCount = visitorAccount?.role === "host"
      ? 0
      : visitorConversationMessages.filter((message) => message.sender === "gionny" && message.read !== true).length;
    if (contactBadge) {
      contactBadge.textContent = unreadCount > 99 ? "99+" : String(unreadCount);
      contactBadge.hidden = unreadCount === 0 || !contactWidget.hidden;
      contactBadge.setAttribute("aria-label", `${unreadCount} réponse${unreadCount === 1 ? "" : "s"} non lue${unreadCount === 1 ? "" : "s"}`);
    }
    contactLauncher?.setAttribute("data-has-messages", String(visitorConversation.messageCount > 0));
    if (announceNewReply && unreadCount > 0 && contactWidget.hidden) {
      contactLauncher?.setAttribute("aria-label", `${unreadCount} réponse${unreadCount === 1 ? "" : "s"} non lue${unreadCount === 1 ? "" : "s"} dans ta discussion avec Gionny`);
    } else {
      contactLauncher?.setAttribute("aria-label", "Ouvrir ta discussion privée avec Gionny");
    }
    if (!contactWidget.hidden) markVisitorThreadSeen();
  };

  const renderMemberAccess = () => {
    const isConnected = Boolean(visitorAccount);
    const isHost = visitorAccount?.role === "host";
    const pseudo = isConnected ? visitorAccount.pseudo || "" : "";
    if (memberVisitorIdentity) memberVisitorIdentity.hidden = isConnected;
    if (memberIdentity) memberIdentity.hidden = !isConnected;
    if (memberLoggedOut) memberLoggedOut.hidden = isConnected;
    if (memberLoggedIn) memberLoggedIn.hidden = !isConnected;
    if (memberPseudo) memberPseudo.textContent = pseudo;
    if (profileDisplayName) profileDisplayName.textContent = pseudo;
    const avatarData = typeof visitorAccount?.avatarData === "string" ? visitorAccount.avatarData : "";
    if (memberAvatarImage) {
      memberAvatarImage.hidden = !isConnected || !avatarData;
      if (avatarData && memberAvatarImage.src !== avatarData) memberAvatarImage.src = avatarData;
      const fallback = memberAvatarImage.parentElement?.querySelector("svg");
      if (fallback) fallback.hidden = !memberAvatarImage.hidden;
    }
    if (profileAvatarImage) {
      profileAvatarImage.hidden = !avatarData;
      if (avatarData && profileAvatarImage.src !== avatarData) profileAvatarImage.src = avatarData;
    }
    if (profileAvatarFallback) profileAvatarFallback.hidden = Boolean(avatarData);
    if (welcomeName) {
      welcomeName.textContent = pseudo;
      welcomeName.hidden = !isConnected;
    }
    if (welcomeComma) welcomeComma.hidden = !isConnected;
    if (welcomeTitle) {
      welcomeTitle.setAttribute(
        "aria-label",
        isConnected ? `Bienvenue ${pseudo}, dans le QG de Gionny` : "Bienvenue dans le QG de Gionny"
      );
    }
    const isVerified = visitorAccount?.badges?.includes("verified") === true;
    if (memberCrown) memberCrown.hidden = !isHost;
    if (memberProfileCrown) memberProfileCrown.hidden = !isHost;
    if (profileCrown) profileCrown.hidden = !isHost;
    if (accountHostCrown) accountHostCrown.hidden = !isHost;
    if (contactThreadCrown) contactThreadCrown.hidden = !isHost;
    if (memberVerifiedBadge) memberVerifiedBadge.hidden = !isVerified;
    if (profileVerifiedBadge) profileVerifiedBadge.hidden = !isVerified;
    if (accountVerifiedBadge) accountVerifiedBadge.hidden = !isVerified;
    if (contactThreadVerifiedBadge) contactThreadVerifiedBadge.hidden = !isVerified;
    if (hostAdminLink) hostAdminLink.hidden = !isHost;
    [contactForm, contactReplyForm].forEach((form) => chatComposerStates.get(form)?.voice?.syncAvailability());
    if (profileOpenButton) {
      profileOpenButton.setAttribute(
        "aria-label",
        isConnected ? `Mon profil : ${pseudo || "membre"}` : "Mon profil"
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
      if (contactLauncher) contactLauncher.setAttribute("data-has-messages", "false");
      renderSubjectLabel(contactHeaderSubject, "Discussion");
      return;
    }

    if (contactAuth) contactAuth.hidden = true;
    if (accountPseudo) accountPseudo.textContent = visitorAccount.pseudo || "";
    if (visitorConversation && !newConversationMode) {
      renderVisitorConversation();
      return;
    }
    if (contactThread) contactThread.hidden = true;
    if (contactNewView) contactNewView.hidden = false;
    if (contactBadge) contactBadge.hidden = true;
    if (contactLauncher) contactLauncher.setAttribute("data-has-messages", "false");
    renderSubjectLabel(contactHeaderSubject, newConversationMode
      ? (contactForm?.elements.namedItem("subject")?.value || "Discussion")
      : "Discussion");
  };

  const loadVisitorConversation = async ({ quiet = false } = {}) => {
    if (!contactWidget || visitorConversationLoading) return;
    visitorConversationLoading = true;
    try {
      const afterSequence = quiet && visitorConversation && Number.isInteger(visitorConversation.messageCount)
        ? visitorConversation.messageCount
        : null;
      const url = new URL("/api/contact", window.location.origin);
      if (afterSequence !== null) url.searchParams.set("after", String(afterSequence));
      const response = await fetch(url.href, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (!quiet) setContactStatus(data.error || "La discussion n’a pas pu être chargée.", "error");
        return;
      }

      const previousConversationId = visitorConversation?.id;
      visitorAccount = data.account || null;
      visitorConversation = data.conversation || null;
      if (previousConversationId !== visitorConversation?.id) {
        visitorConversationMessages = [];
        visitorReadMarkKey = "";
      }
      const incomingMessages = Array.isArray(data.messages) ? data.messages : [];
      if (data.messagesComplete === false) {
        const messagesById = new Map(visitorConversationMessages.map((message) => [message.id, message]));
        incomingMessages.forEach((message) => messagesById.set(message.id, message));
        visitorConversationMessages = [...messagesById.values()]
          .sort((left, right) => (left.sequence || 0) - (right.sequence || 0));
      } else {
        const pendingMessages = visitorConversationMessages.filter((message) => message.pending === true);
        visitorConversationMessages = [...incomingMessages, ...pendingMessages];
      }
      newConversationMode = false;
      renderContactState();
      if (visitorConversation) renderVisitorConversation({ announceNewReply: true });
    } catch {
      if (!quiet) setContactStatus("Impossible de joindre le serveur. Réessaie dans un instant.", "error");
    } finally {
      visitorConversationLoading = false;
    }
  };

  const openContactWidget = ({ context = "launcher", trigger = contactLauncher } = {}) => {
    if (!contactWidget) return;
    const opensAtHero = context === "top";
    lastContactTrigger = trigger || contactLauncher;
    contactWidget.dataset.openContext = opensAtHero ? "top" : "launcher";
    contactWidget.hidden = false;
    if (contactScrim) contactScrim.hidden = false;
    document.body.classList.add("contact-page-open");
    lockBackgroundScroll("contact-widget");
    contactLauncher?.setAttribute("aria-expanded", "true");
    memberLoginButton?.setAttribute("aria-expanded", String(trigger === memberLoginButton));
    memberRegisterButton?.setAttribute("aria-expanded", String(trigger === memberRegisterButton));
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
    delete contactWidget.dataset.openContext;
    if (contactScrim) contactScrim.hidden = true;
    document.body.classList.remove("contact-page-open");
    unlockBackgroundScroll("contact-widget");
    contactLauncher?.setAttribute("aria-expanded", "false");
    memberLoginButton?.setAttribute("aria-expanded", "false");
    memberRegisterButton?.setAttribute("aria-expanded", "false");
    const trigger = lastContactTrigger && !lastContactTrigger.closest("[hidden]") ? lastContactTrigger : contactLauncher;
    trigger?.focus({ preventScroll: true });
    lastContactTrigger = null;
    if (visitorConversation && !newConversationMode) renderVisitorConversation({ announceNewReply: true });
  };

  const updateConversationFromResponse = (data) => {
    const previousConversationId = visitorConversation?.id;
    if (data.account) visitorAccount = data.account;
    if (data.conversation) visitorConversation = data.conversation;
    if (previousConversationId !== visitorConversation?.id) visitorReadMarkKey = "";
    if (Array.isArray(data.messages)) visitorConversationMessages = data.messages;
    else if (data.message) visitorConversationMessages.push(data.message);
  };

  const clearChatAttachment = (form) => {
    const state = form ? chatComposerStates.get(form) : null;
    if (!state) return;
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = "";
    state.imageBlob = null;
    state.imageFile = null;
    state.preview.hidden = true;
    state.previewImage.removeAttribute("src");
    state.fileInput.value = "";
    updateChatComposerAction(form);
  };

  const updateChatComposerAction = (form) => {
    const state = form ? chatComposerStates.get(form) : null;
    if (!state) return;
    const hasPayload = Boolean(String(state.messageInput.value || "").trim() || state.imageBlob);
    state.recordButton.dataset.mode = hasPayload ? "send" : "voice";
    state.micIcon.hidden = hasPayload;
    state.sendIcon.hidden = !hasPayload;
    state.recordButton.setAttribute("aria-label", hasPayload ? "Envoyer le message" : "Enregistrer un message vocal");
    state.recordButton.title = hasPayload ? "Envoyer" : "Message vocal";
    state.voice?.syncAvailability();
  };

  const closeChatMenu = (state) => {
    state.menu.hidden = true;
    state.menuToggle.setAttribute("aria-expanded", "false");
    state.subjectOptions.hidden = true;
    state.subjectToggle?.setAttribute("aria-expanded", "false");
  };

  const setupVisitorChatComposer = (form) => {
    if (!form || chatComposerStates.has(form)) return;
    const messageInput = form.querySelector("[data-chat-message]");
    const fileInput = form.querySelector("[data-chat-image-input]");
    const menu = form.querySelector("[data-chat-menu]");
    const menuToggle = form.querySelector("[data-chat-menu-toggle]");
    const subjectToggle = form.querySelector("[data-chat-subject-toggle]");
    const subjectOptions = form.querySelector("[data-chat-subject-options]");
    const imagePreview = form.querySelector("[data-chat-image-preview]");
    const previewImage = form.querySelector("[data-chat-image-preview-img]");
    const removeImage = form.querySelector("[data-chat-image-remove]");
    const recordButton = form.querySelector("[data-compose-action]");
    const micIcon = recordButton?.querySelector("[data-compose-mic]");
    const sendIcon = recordButton?.querySelector("[data-compose-send-icon]");
    const voicePanel = form.querySelector("[data-voice-controls]");
    const voiceCancel = form.querySelector("[data-voice-cancel]");
    const voiceStop = form.querySelector("[data-voice-stop]");
    const voiceSend = form.querySelector("[data-voice-send]");
    const voicePreview = form.querySelector("[data-voice-preview]");
    const voiceLive = form.querySelector("[data-voice-recording-controls]");
    const voiceWave = form.querySelector("[data-voice-wave]");
    const voiceTimer = form.querySelector("[data-voice-timer]");
    const voiceStatus = form.querySelector("[data-voice-status]");
    const inputPill = form.querySelector("[data-chat-input-surface]");
    if (!messageInput || !fileInput || !menu || !menuToggle || !subjectOptions || !imagePreview || !previewImage || !removeImage || !recordButton || !micIcon || !sendIcon || !voicePanel || !voiceCancel || !voiceStop || !voiceSend || !voicePreview || !voiceLive || !voiceWave || !voiceTimer || !voiceStatus || !inputPill) return;
    const state = { form, messageInput, fileInput, menu, menuToggle, subjectToggle, subjectOptions, preview: imagePreview, previewImage, removeImage, recordButton, micIcon, sendIcon, imageBlob: null, imageFile: null, previewUrl: "", voice: null };
    chatComposerStates.set(form, state);
    if (typeof window.createQGVoiceComposer === "function") {
      const isReply = form === contactReplyForm;
      state.voice = window.createQGVoiceComposer({
        inputPill,
        panel: voicePanel,
        liveControls: voiceLive,
        waveform: voiceWave,
        timer: voiceTimer,
        stopButton: voiceStop,
        cancelButton: voiceCancel,
        sendButton: voiceSend,
        preview: voicePreview,
        composeButton: recordButton,
        plusButton: menuToggle,
        status: voiceStatus,
        label: "message vocal",
        canRecord: () => Boolean(visitorAccount) && !state.imageBlob && !String(messageInput.value || "").trim() && (!isReply || visitorConversation?.status === "open"),
        canSend: () => Boolean(visitorAccount) && Boolean(state.imageBlob || String(messageInput.value || "").trim()) && (!isReply || visitorConversation?.status === "open"),
        canUsePlus: () => Boolean(visitorAccount) && (!isReply || visitorConversation?.status === "open"),
        onSend: (blob, peaks, voice) => uploadVoice(state, blob, peaks, voice),
      });
      if (state.voice) voiceControlStates.push(state.voice);
    }

    menuToggle.addEventListener("click", () => {
      menu.hidden = !menu.hidden;
      menuToggle.setAttribute("aria-expanded", String(!menu.hidden));
    });
    subjectToggle?.addEventListener("click", () => {
      subjectOptions.hidden = !subjectOptions.hidden;
      subjectToggle.setAttribute("aria-expanded", String(!subjectOptions.hidden));
      if (!subjectOptions.hidden) {
        const selectedSubject = form.elements.namedItem("subject")?.value || visitorConversation?.subject || "Discussion";
        subjectOptions.querySelectorAll("[data-chat-subject-value]").forEach((option) => {
          option.setAttribute("aria-pressed", String(option.dataset.chatSubjectValue === selectedSubject));
        });
      }
    });
    form.querySelector("[data-chat-image-option]")?.addEventListener("click", () => {
      closeChatMenu(state);
      fileInput.click();
    });
    removeImage.addEventListener("click", () => {
      clearChatAttachment(form);
      messageInput.focus({ preventScroll: true });
    });
    form.querySelectorAll("[data-chat-subject-value]").forEach((button) => {
      button.addEventListener("click", async () => {
        const subject = button.dataset.chatSubjectValue;
        if (!CHAT_SUBJECTS.includes(subject)) return;
        closeChatMenu(state);
        const subjectInput = form.elements.namedItem("subject");
        if (form === contactReplyForm && visitorConversation) {
          button.disabled = true;
          setContactThreadStatus("Mise à jour du sujet…");
          try {
            const response = await fetch("/api/contact", {
              method: "POST",
              headers: { Accept: "application/json", "Content-Type": "application/json" },
              credentials: "same-origin",
              cache: "no-store",
              body: JSON.stringify({ action: "subject", subject }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || data.ok !== true) {
              setContactThreadStatus(data.error || "Le sujet n’a pas pu être modifié.", "error");
              return;
            }
            updateConversationFromResponse(data);
            if (subjectInput) subjectInput.value = subject;
            renderContactState();
            setContactThreadStatus("Sujet mis à jour.", "success");
          } catch {
            setContactThreadStatus("Impossible de modifier le sujet.", "error");
          } finally {
            button.disabled = false;
          }
          return;
        }
        if (subjectInput) subjectInput.value = subject;
        renderSubjectLabel(contactHeaderSubject, subject);
        state.subjectOptions.querySelectorAll("[data-chat-subject-value]").forEach((option) => {
          option.setAttribute("aria-pressed", String(option.dataset.chatSubjectValue === subject));
        });
      });
    });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      if (!window.qgImageTools?.compressToWebp) {
        setStatusNode(form === contactReplyForm ? contactReplyStatus : contactStatus, "La compression WebP n’est pas disponible dans ce navigateur.", "error");
        fileInput.value = "";
        return;
      }
      const statusNode = form === contactReplyForm ? contactReplyStatus : contactStatus;
      setStatusNode(statusNode, "Compression de l’image en WebP…");
      try {
        const imageBlob = await window.qgImageTools.compressToWebp(file, {
          maxWidth: 800,
          maxHeight: 800,
          maxBytes: 40_000,
          initialQuality: 0.75,
        });
        if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
        state.imageBlob = imageBlob;
        state.imageFile = file;
        state.previewUrl = URL.createObjectURL(imageBlob);
        previewImage.src = state.previewUrl;
        imagePreview.hidden = false;
        setStatusNode(statusNode, `Image prête · ${Math.round(imageBlob.size / 1024)} Ko.`, "success");
        updateChatComposerAction(form);
      } catch (error) {
        setStatusNode(statusNode, error instanceof Error ? error.message : "L’image n’a pas pu être compressée.", "error");
      } finally {
        fileInput.value = "";
      }
    });

    messageInput.addEventListener("input", () => {
      messageInput.style.height = "auto";
      messageInput.style.height = `${Math.min(messageInput.scrollHeight, 112)}px`;
      updateChatComposerAction(form);
    });
    messageInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (!String(messageInput.value || "").trim() && !state.imageBlob) return;
      const submitButton = form.querySelector("button[type=submit]");
      if (submitButton && !submitButton.disabled) form.requestSubmit(submitButton);
    });
    recordButton.addEventListener("click", (event) => {
      if (state.voice?.sending) return;
      if (String(messageInput.value || "").trim() || state.imageBlob) return;
      event.preventDefault();
      closeChatMenu(state);
      void state.voice?.start();
    });
    form.addEventListener("click", (event) => {
      const actionButton = event.target.closest("[data-compose-action]");
      if (!actionButton || !form.contains(actionButton)) return;
      if (!String(messageInput.value || "").trim() && !state.imageBlob) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      const submitButton = form.querySelector("button[type=submit]");
      if (submitButton && !submitButton.disabled) form.requestSubmit(submitButton);
    }, true);
    document.addEventListener("click", (event) => {
      if (!form.contains(event.target) && !menu.hidden) closeChatMenu(state);
    });
    form.addEventListener("reset", () => window.setTimeout(() => {
      clearChatAttachment(form);
      messageInput.style.height = "auto";
      updateChatComposerAction(form);
    }, 0));
    updateChatComposerAction(form);
  };

  setupVisitorChatComposer(contactForm);
  setupVisitorChatComposer(contactReplyForm);

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
    openContactWidget({ context: "top", trigger: memberLoginButton });
  });
  memberRegisterButton?.addEventListener("click", () => {
    setAuthMode("register");
    openContactWidget({ context: "top", trigger: memberRegisterButton });
  });

  const openProfileDialog = () => {
    if (!visitorAccount || !profileDialog?.showModal) return;
    if (profilePseudoInput) profilePseudoInput.value = visitorAccount.pseudo || "";
    if (profileDisplayName) profileDisplayName.textContent = visitorAccount.pseudo || "";
    if (profilePseudoForm) profilePseudoForm.hidden = true;
    if (profilePseudoEditButton) profilePseudoEditButton.hidden = false;
    if (profilePseudoStatus) setStatusNode(profilePseudoStatus, "");
    if (profileAvatarStatus) setStatusNode(profileAvatarStatus, "");
    if (profileAvatarFile) profileAvatarFile.value = "";
    if (profilePasswordStatus) setStatusNode(profilePasswordStatus, "");
    profilePasswordForm?.reset();
    if (profilePasswordForm) profilePasswordForm.hidden = true;
    profilePasswordToggle?.setAttribute("aria-expanded", "false");
    if (profilePasswordPlus) profilePasswordPlus.hidden = false;
    if (profilePasswordMinus) profilePasswordMinus.hidden = true;
    profileDialog.showModal();
    lockBackgroundScroll("profile-dialog");
    profileOpenButton?.setAttribute("aria-expanded", "true");
    updateProfilePseudoControls();
    profileAvatarTrigger?.focus({ preventScroll: true });
  };

  profileOpenButton?.addEventListener("click", openProfileDialog);
  profileCloseButtons.forEach((button) => button.addEventListener("click", () => profileDialog?.close()));
  profileDialog?.addEventListener("click", (event) => {
    if (event.target === profileDialog) profileDialog.close();
  });
  profileDialog?.addEventListener("close", () => {
    unlockBackgroundScroll("profile-dialog");
    profileOpenButton?.setAttribute("aria-expanded", "false");
    if (profileOpenButton && !profileOpenButton.closest("[hidden]")) profileOpenButton.focus({ preventScroll: true });
  });
  profilePseudoInput?.addEventListener("input", updateProfilePseudoControls);
  profilePseudoEditButton?.addEventListener("click", () => {
    if (!visitorAccount || profileSaving || !profilePseudoForm) return;
    profilePseudoInput.value = visitorAccount.pseudo || "";
    profilePseudoForm.hidden = false;
    profilePseudoEditButton.hidden = true;
    if (profilePseudoStatus) setStatusNode(profilePseudoStatus, "");
    updateProfilePseudoControls();
    profilePseudoInput.focus({ preventScroll: true });
    profilePseudoInput.select();
  });
  profilePseudoCancelButton?.addEventListener("click", () => {
    if (!visitorAccount || profileSaving) return;
    profilePseudoInput.value = visitorAccount.pseudo || "";
    profilePseudoForm.hidden = true;
    profilePseudoEditButton.hidden = false;
    if (profilePseudoStatus) setStatusNode(profilePseudoStatus, "");
    updateProfilePseudoControls();
    profilePseudoEditButton.focus({ preventScroll: true });
  });
  profileAvatarTrigger?.addEventListener("click", () => {
    if (!profileSaving && visitorAccount) profileAvatarFile?.click();
  });
  profilePasswordToggle?.addEventListener("click", () => {
    if (!profilePasswordForm) return;
    profilePasswordForm.hidden = !profilePasswordForm.hidden;
    const expanded = !profilePasswordForm.hidden;
    profilePasswordToggle.setAttribute("aria-expanded", String(expanded));
    if (profilePasswordPlus) profilePasswordPlus.hidden = expanded;
    if (profilePasswordMinus) profilePasswordMinus.hidden = !expanded;
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
      if (Object.hasOwn(payload, "pseudo")) {
        if (profilePseudoForm) profilePseudoForm.hidden = true;
        if (profilePseudoEditButton) profilePseudoEditButton.hidden = false;
        if (profileDisplayName && visitorAccount) profileDisplayName.textContent = visitorAccount.pseudo || "";
      }
      if (profilePasswordForm) profilePasswordForm.reset();
      setStatusNode(statusNode, Object.hasOwn(payload, "avatarData") ? "Photo de profil mise à jour." : "Profil mis à jour.", "success");
      updateProfilePseudoControls();
    } catch {
      setStatusNode(statusNode, "Impossible de joindre le serveur. Réessaie dans un instant.", "error");
    } finally {
      profileSaving = false;
      updateProfilePseudoControls();
    }
  };

  profileAvatarFile?.addEventListener("change", async () => {
    const file = profileAvatarFile.files?.[0];
    if (!file || !visitorAccount || profileSaving) return;
    if (!window.qgImageTools?.compressToWebp || !window.qgImageTools?.blobToDataUrl) {
      setStatusNode(profileAvatarStatus, "Le recadrage d’image n’est pas disponible dans ce navigateur.", "error");
      profileAvatarFile.value = "";
      return;
    }
    profileAvatarTrigger.disabled = true;
    setStatusNode(profileAvatarStatus, "Recadrage carré et compression WebP…");
    try {
      const imageBlob = await window.qgImageTools.compressToWebp(file, {
        maxWidth: 128,
        maxHeight: 128,
        cropSquare: true,
        preserveDimensions: true,
        maxBytes: 7_000,
        initialQuality: 0.86,
      });
      const avatarData = await window.qgImageTools.blobToDataUrl(imageBlob);
      if (!avatarData.startsWith("data:image/webp;base64,") || avatarData.length >= 10_000) {
        throw new Error("La photo dépasse la limite WebP de 10 Ko. Choisis une autre image.");
      }
      profileAvatarTrigger.disabled = false;
      await submitProfileUpdate({ avatarData }, profileAvatarStatus, profileAvatarTrigger);
    } catch (error) {
      setStatusNode(profileAvatarStatus, error instanceof Error ? error.message : "La photo n’a pas pu être préparée.", "error");
    } finally {
      if (profileAvatarFile) profileAvatarFile.value = "";
      if (!profileSaving) updateProfilePseudoControls();
    }
  });

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
    if (!authSubmit || authSubmit.disabled) return;
    const pseudoInput = authForm.elements.namedItem("pseudo");
    const passwordInput = authForm.elements.namedItem("password");
    const pseudo = String(pseudoInput?.value || "").trim();
    const password = String(passwordInput?.value || "");
    if (pseudoInput) pseudoInput.value = pseudo;
    if (!pseudo || !password) {
      setStatusNode(authStatus, "Saisis ton pseudo et ton mot de passe.", "error");
      return;
    }
    if (authMode === "register" && (pseudo.length < 3 || pseudo.length > 16)) {
      setStatusNode(authStatus, "Le pseudo doit contenir entre 3 et 16 caractères après suppression des espaces au début et à la fin.", "error");
      return;
    }
    if (authMode === "register" && password.length < 8) {
      setStatusNode(authStatus, "Le mot de passe doit contenir au moins 8 caractères.", "error");
      return;
    }
    if (password.length > 128) {
      setStatusNode(authStatus, "Le mot de passe ne peut pas dépasser 128 caractères.", "error");
      return;
    }
    const closeAfterAuthentication = lastContactTrigger === memberLoginButton || lastContactTrigger === memberRegisterButton;
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
          pseudo,
          password,
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
      if (visitorConversation) markVisitorThreadSeen();
      if (closeAfterAuthentication) {
        minimizeContactWidget();
      } else if (!visitorConversation) {
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
    const composer = chatComposerStates.get(contactForm);
    const message = String(formData.get("message") || "").trim();
    if (!message && !composer?.imageBlob) return;
    const subject = String(formData.get("subject") || "Discussion");
    const payload = {
      action: "send",
      subject,
      message,
      website: String(formData.get("website") || ""),
      newConversation: newConversationMode,
    };
    contactSubmit.disabled = true;
    const originalConversation = visitorConversation;
    const originalMessages = visitorConversationMessages;
    const originalNewConversationMode = newConversationMode;
    const showPendingThread = !visitorConversation || newConversationMode;
    const pendingMessageId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (showPendingThread) {
      visitorConversation = {
        id: pendingMessageId,
        pseudo: visitorAccount?.pseudo || "Membre",
        subject,
        status: "open",
        messageCount: 1,
        adminUnread: false,
      };
      visitorConversationMessages = [{
        id: pendingMessageId,
        sender: visitorAccount?.role === "host" ? "gionny" : "visitor",
        pseudo: visitorAccount?.pseudo || "Membre",
        isHost: visitorAccount?.role === "host",
        avatarData: visitorAccount?.avatarData || "",
        text: message,
        createdAt: new Date().toISOString(),
        kind: composer?.imageBlob ? "image" : "text",
        hasImage: Boolean(composer?.imageBlob),
        pending: true,
        previewUrl: composer?.previewUrl || "",
      }];
      renderVisitorConversation();
    }
    setContactStatus(composer?.imageBlob ? "Envoi de l’image…" : newConversationMode ? "Ouverture d’une nouvelle discussion…" : "Envoi de ton message…");
    if (showPendingThread) setContactThreadStatus(composer?.imageBlob ? "Envoi de l’image…" : "Envoi du message…");
    const restorePendingThread = () => {
      if (!showPendingThread) return;
      visitorConversation = originalConversation;
      visitorConversationMessages = originalMessages;
      newConversationMode = originalNewConversationMode;
      renderContactState();
    };
    const removePendingMessage = () => {
      visitorConversationMessages = visitorConversationMessages.filter((item) => item.id !== pendingMessageId);
    };

    try {
      const response = composer?.imageBlob
        ? await fetch("/api/contact-image", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "image/webp",
            "X-Conversation-Subject": encodeURIComponent(subject),
            "X-Message-Text": encodeURIComponent(message),
            "X-Website": encodeURIComponent(payload.website),
            ...(newConversationMode ? { "X-New-Conversation": "true" } : {}),
          },
          credentials: "same-origin",
          cache: "no-store",
          body: composer.imageBlob,
        })
        : await fetch("/api/contact", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify(payload),
        });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        restorePendingThread();
        setContactStatus(data.error || "Ton message n’a pas pu être envoyé. Réessaie.", "error");
        if (response.status === 409 || response.status === 403) await loadVisitorConversation({ quiet: true });
        return;
      }

      removePendingMessage();
      updateConversationFromResponse(data);
      newConversationMode = false;
      contactForm.reset();
      clearChatAttachment(contactForm);
      setContactStatus("");
      renderContactState();
      markVisitorThreadSeen();
      contactReplyForm?.querySelector("textarea")?.focus({ preventScroll: true });
    } catch {
      restorePendingThread();
      setContactStatus("Impossible de joindre le serveur. Réessaie dans un instant.", "error");
    } finally {
      contactSubmit.disabled = false;
    }
  });

  contactReplyForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!contactReplyForm.reportValidity() || !contactReplySubmit || contactReplySubmit.disabled) return;
    const messageField = contactReplyForm.elements.namedItem("message");
    const composer = chatComposerStates.get(contactReplyForm);
    const message = String(messageField?.value || "").trim();
    if (!message && !composer?.imageBlob) return;

    const subject = String(contactReplyForm.elements.namedItem("subject")?.value || visitorConversation?.subject || "Discussion");
    contactReplySubmit.disabled = true;
    setContactThreadStatus(composer?.imageBlob ? "Envoi de l’image…" : "Envoi de ton message…");
    const pendingMessageId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const showPending = Boolean(visitorConversation && !newConversationMode);
    const pendingMessage = {
      id: pendingMessageId,
      sender: visitorAccount?.role === "host" ? "gionny" : "visitor",
      pseudo: visitorAccount?.pseudo || "Membre",
      isHost: visitorAccount?.role === "host",
      avatarData: visitorAccount?.avatarData || "",
      text: message,
      createdAt: new Date().toISOString(),
      kind: composer?.imageBlob ? "image" : "text",
      hasImage: Boolean(composer?.imageBlob),
      pending: true,
      previewUrl: composer?.previewUrl || "",
    };
    if (showPending) {
      visitorConversationMessages = [...visitorConversationMessages, pendingMessage];
      renderVisitorConversation();
    }
    const removePendingMessage = () => {
      if (!showPending) return;
      visitorConversationMessages = visitorConversationMessages.filter((item) => item.id !== pendingMessageId);
      renderVisitorConversation();
    };
    try {
      const response = composer?.imageBlob
        ? await fetch("/api/contact-image", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "image/webp",
            "X-Conversation-Subject": encodeURIComponent(subject),
            "X-Message-Text": encodeURIComponent(message),
          },
          credentials: "same-origin",
          cache: "no-store",
          body: composer.imageBlob,
        })
        : await fetch("/api/contact", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify({ action: "send", message, subject }),
        });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        removePendingMessage();
        setContactThreadStatus(data.error || "Ton message n’a pas pu être envoyé.", "error");
        if (response.status === 409 || response.status === 403 || response.status === 404) await loadVisitorConversation({ quiet: true });
        return;
      }
      removePendingMessage();
      updateConversationFromResponse(data);
      messageField.value = "";
      messageField.style.height = "auto";
      clearChatAttachment(contactReplyForm);
      setContactThreadStatus("");
      renderContactState();
      markVisitorThreadSeen();
    } catch {
      removePendingMessage();
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

  const uploadVoice = async (state, audioBlob, audioPeaks = [], voice = state.voice) => {
    if (!audioBlob || !audioBlob.size) {
      voice?.setStatus("Aucun son n’a été enregistré. Réessaie.", "error");
      return false;
    }
    if (audioBlob.size > MAX_VOICE_BYTES) {
      voice?.setStatus("Ce vocal dépasse 200 Ko. Essaie un enregistrement plus court.", "error");
      return false;
    }

    const form = state.form;
    const subject = form?.elements.namedItem("subject")?.value || visitorConversation?.subject || "Discussion";
    const isReply = form === contactReplyForm;
    const isNewConversation = !isReply && (newConversationMode || !visitorConversation);
    const submitButton = form?.querySelector("[data-contact-submit], [data-contact-reply-submit]");
    if (submitButton) submitButton.disabled = true;

    try {
      const response = await fetch("/api/contact-audio", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": audioBlob.type || "audio/webm",
          "X-Conversation-Subject": encodeURIComponent(subject),
          "X-Voice-Peaks": Array.from(audioPeaks).map((peak) => Math.round(Math.max(0, Math.min(1, Number(peak) || 0)) * 100) / 100).join(","),
          ...(isNewConversation ? { "X-New-Conversation": "true" } : {}),
        },
        credentials: "same-origin",
        cache: "no-store",
        body: audioBlob,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        voice?.setStatus(data.error || "Le vocal n’a pas pu être envoyé. Réessaie.", "error");
        if (response.status === 409 || response.status === 403) await loadVisitorConversation({ quiet: true });
        return false;
      }
      updateConversationFromResponse(data);
      newConversationMode = false;
      renderContactState();
      markVisitorThreadSeen();
      return true;
    } catch {
      voice?.setStatus("Impossible de joindre le serveur. Réessaie.", "error");
      return false;
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  };

  if (contactLauncher && contactWidget) {
    contactLauncher.addEventListener("click", () => {
      if (contactWidget.hidden) openContactWidget({ context: "launcher", trigger: contactLauncher });
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
      contactForm?.reset();
      clearChatAttachment(contactForm);
      renderSubjectLabel(contactHeaderSubject, "Discussion");
      contactForm?.querySelector("[data-chat-message]")?.focus({ preventScroll: true });
    });

    void loadVisitorConversation();
    visitorPollTimer = window.setInterval(() => {
      if (visitorAccount && !newConversationMode && !contactWidget.hidden && !document.hidden) {
        void loadVisitorConversation({ quiet: true });
      }
    }, 45_000);
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

    const twitchSlide = document.querySelector('[data-carousel-slide="twitch"]');
    if (twitchSlide) {
      twitchSlide.dataset.live = twitchAvailable ? (isLive ? "true" : "false") : "unknown";
      const liveLabel = twitchSlide.querySelector("[data-carousel-twitch-live-label]");
      const channelLabel = twitchSlide.querySelector("[data-carousel-twitch-channel]");
      const liveBadge = twitchSlide.querySelector("[data-carousel-twitch-live]");
      const detail = twitchSlide.querySelector("[data-carousel-twitch-copy]");
      if (liveLabel) liveLabel.hidden = !isLive;
      if (channelLabel) channelLabel.hidden = isLive;
      if (liveBadge) liveBadge.hidden = !isLive;
      const visitedBadge = twitchSlide.querySelector(".visited-badge");
      if (visitedBadge) visitedBadge.hidden = isLive || !visitedNetworks.has("twitch");
      if (detail) {
        detail.textContent = !twitchAvailable
          ? "La chaîne officielle de Gionny : retrouve ici les prochains lives."
          : isLive
            ? streamTitle
              ? `En direct : ${streamTitle}`
              : "Gionny est en direct. Rejoins le chat et la commu sur Twitch."
            : "Retrouve-moi sur la chaîne pour les prochains lives et les bons moments avec la commu.";
      }
      twitchSlide.href = safeTwitchUrl(twitch?.url);
    }

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
    const carouselYouTubeDetail = document.querySelector("[data-carousel-youtube-detail]");
    if (carouselYouTubeDetail) {
      carouselYouTubeDetail.textContent = latestYouTubeUrl && youtubeTitle
        ? `Dernière vidéo : ${youtubeTitle}`
        : "Vidéos, replays de live et meilleurs moments sur YouTube.";
    }

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

  const carousel = document.querySelector("[data-social-carousel]");
  if (carousel) {
    const slides = [...carousel.querySelectorAll("[data-carousel-slide]")];
    const dots = [...carousel.querySelectorAll("[data-carousel-dot]")];
    const nextButton = carousel.querySelector("[data-carousel-next]");
    let activeSlideIndex = Math.max(0, slides.findIndex((slide) => slide.dataset.active === "true"));
    let swipeOrigin = null;
    let ignoreSlideClickUntil = 0;

    const showCarouselSlide = (requestedIndex) => {
      if (!slides.length) return;
      activeSlideIndex = (requestedIndex + slides.length) % slides.length;
      slides.forEach((slide, index) => {
        const isActive = index === activeSlideIndex;
        slide.hidden = false;
        slide.dataset.active = String(isActive);
        slide.setAttribute("aria-hidden", String(!isActive));
      });
      dots.forEach((dot, index) => dot.setAttribute("aria-current", String(index === activeSlideIndex)));
      if (nextButton) {
        const nextSlide = slides[(activeSlideIndex + 1) % slides.length];
        const nextName = nextSlide?.dataset.carouselSlide || "suivant";
        nextButton.setAttribute("aria-label", `Afficher ${nextName === "youtube" ? "YouTube" : nextName === "twitch" ? "Twitch" : "Discord"}`);
      }
    };

    dots.forEach((dot, index) => dot.addEventListener("click", () => showCarouselSlide(index)));
    nextButton?.addEventListener("click", () => showCarouselSlide(activeSlideIndex + 1));
    carousel.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight") {
        event.preventDefault();
        showCarouselSlide(activeSlideIndex + 1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        showCarouselSlide(activeSlideIndex - 1);
      }
    });
    carousel.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
      swipeOrigin = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    }, { passive: true });
    window.addEventListener("pointerup", (event) => {
      if (!swipeOrigin || event.pointerId !== swipeOrigin.pointerId) return;
      const deltaX = event.clientX - swipeOrigin.x;
      const deltaY = event.clientY - swipeOrigin.y;
      swipeOrigin = null;
      if (Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY) * 1.2) return;
      showCarouselSlide(activeSlideIndex + (deltaX < 0 ? 1 : -1));
      ignoreSlideClickUntil = performance.now() + 450;
    }, { passive: true });
    window.addEventListener("pointercancel", () => { swipeOrigin = null; }, { passive: true });
    carousel.addEventListener("click", (event) => {
      if (performance.now() >= ignoreSlideClickUntil || !event.target.closest("[data-carousel-slide]")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    showCarouselSlide(activeSlideIndex);
  }

  let presenceInFlight = false;
  const refreshSitePresence = async () => {
    if (!sitePresence || presenceInFlight || document.hidden) return;
    presenceInFlight = true;
    try {
      const response = await fetch("/api/presence", {
        method: "POST",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return;
      if (Number.isInteger(data.activeSessions)) {
        sitePresenceCount.textContent = String(data.activeSessions);
        sitePresence.hidden = false;
      } else {
        sitePresence.hidden = true;
      }
    } catch {
      // The capsule stays hidden or keeps its last count if the heartbeat is offline.
    } finally {
      presenceInFlight = false;
    }
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
    let mouseHovering = false;
    let touching = false;
    let lastFrame = 0;

    ensureTickerCopies();
    tickerPosition = ticker.scrollLeft;
    document.fonts?.ready.then(ensureTickerCopies);
    window.addEventListener("resize", ensureTickerCopies, { passive: true });

    ticker.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse") return;
      mouseHovering = true;
      tickerPosition = ticker.scrollLeft;
    });
    ticker.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "mouse") return;
      tickerPosition = ticker.scrollLeft;
      mouseHovering = false;
    });
    ticker.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
      touching = true;
      tickerPosition = ticker.scrollLeft;
    }, { passive: true });
    ticker.addEventListener("touchstart", () => {
      touching = true;
      tickerPosition = ticker.scrollLeft;
    }, { passive: true });

    const finishTouch = () => {
      if (!touching) return;
      tickerPosition = ticker.scrollLeft;
      touching = false;
    };
    window.addEventListener("pointerup", finishTouch, { passive: true });
    window.addEventListener("pointercancel", finishTouch, { passive: true });
    window.addEventListener("touchend", finishTouch, { passive: true });
    window.addEventListener("touchcancel", finishTouch, { passive: true });

    const animateTicker = (now) => {
      if (!lastFrame) lastFrame = now;
      const elapsed = Math.min(now - lastFrame, 120);
      lastFrame = now;

      if (!mouseHovering && !touching && !document.hidden) {
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
  void refreshSitePresence();
  void refreshTicker();
  void refreshDiscordStatus();
  window.setInterval(refreshSitePresence, 60_000);
  window.setInterval(refreshTicker, 60_000);
  window.setInterval(refreshDiscordStatus, 30_000);
  window.setInterval(updateScheduleCountdown, 1_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void refreshSitePresence();
      void refreshTicker();
      void refreshDiscordStatus();
      if (visitorAccount && contactWidget && !contactWidget.hidden && !newConversationMode) {
        void loadVisitorConversation({ quiet: true });
      }
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
