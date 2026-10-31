(() => {
  const storageKey = "gionny:visited-links:v1";
  const links = [...document.querySelectorAll("[data-network]")];
  const knownNetworks = new Set(links.map((link) => link.dataset.network));
  const visitedNetworks = new Set();

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

  const showVisitedState = (link) => {
    const badge = link.querySelector(".visited-badge");
    if (badge) badge.hidden = false;
    link.dataset.visited = "true";
  };

  const saveVisitedState = (link) => {
    const network = link.dataset.network;
    if (!network || visitedNetworks.has(network)) return;

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

  const safeYouTubeUrl = (url) => {
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol === "https:" &&
        parsed.hostname === "www.youtube.com" &&
        parsed.pathname === "/watch" &&
        parsed.searchParams.has("v")
      ) {
        return parsed.href;
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

  const ticker = document.querySelector("[data-ticker]");
  const tickerTrack = ticker?.querySelector("[data-ticker-track]");
  const tickerSet = tickerTrack?.querySelector("[data-ticker-set]");
  let tickerCycleWidth = 0;

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

  const setTickerLinks = (selector, url) => {
    document.querySelectorAll(selector).forEach((link) => {
      link.href = url;
    });
  };

  const applyTickerUpdates = (updates) => {
    const twitch = updates?.twitch;
    const twitchAvailable = twitch?.available === true && typeof twitch.isLive === "boolean";

    document.querySelectorAll("[data-ticker-live]").forEach((item) => {
      const isLive = twitchAvailable && twitch.isLive;
      item.dataset.live = twitchAvailable ? (isLive ? "true" : "false") : "unknown";

      const label = item.querySelector("[data-live-label]");
      const message = item.querySelector("[data-live-message]");
      if (label) label.textContent = isLive ? "EN DIRECT" : "TWITCH";
      if (message) {
        const title = typeof twitch?.title === "string" ? twitch.title.trim() : "";
        message.textContent = !twitchAvailable
          ? "Suis la chaîne pour les prochains lives"
          : isLive
            ? title
              ? `Gionny est en live : ${title}`
              : "Gionny est en live, rejoins le chat"
            : "À bientôt sur Twitch";
      }
      item.href = safeTwitchUrl(twitch?.url);
    });

    const youtube = updates?.youtube;
    const youtubeUrl = safeYouTubeUrl(youtube?.url);
    const youtubeAvailable =
      youtube?.available === true &&
      typeof youtube.title === "string" &&
      youtube.title.trim() &&
      youtubeUrl !== "https://www.youtube.com/@gionnyyy";
    if (youtubeAvailable) {
      document.querySelectorAll("[data-video-title]").forEach((title) => {
        title.textContent = youtube.title.trim();
      });
      setTickerLinks("[data-ticker-youtube]", youtubeUrl);
    } else {
      document.querySelectorAll("[data-video-title]").forEach((title) => {
        title.textContent = "Voir la chaîne YouTube";
      });
      setTickerLinks("[data-ticker-youtube]", "https://www.youtube.com/@gionnyyy");
    }

    ensureTickerCopies();
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
    let hovering = false;
    let keyboardFocus = false;
    let touching = false;
    let resumeAt = 0;
    let lastFrame = 0;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    ensureTickerCopies();
    document.fonts?.ready.then(ensureTickerCopies);
    window.addEventListener("resize", ensureTickerCopies, { passive: true });

    ticker.addEventListener("mouseenter", () => {
      hovering = true;
    });
    ticker.addEventListener("mouseleave", () => {
      hovering = false;
    });
    ticker.addEventListener("focusin", () => {
      keyboardFocus = true;
    });
    ticker.addEventListener("focusout", (event) => {
      if (!ticker.contains(event.relatedTarget)) keyboardFocus = false;
    });
    ticker.addEventListener("pointerdown", (event) => {
      if (event.pointerType !== "mouse") touching = true;
    });
    ticker.addEventListener(
      "touchstart",
      () => {
        touching = true;
      },
      { passive: true }
    );

    const finishTouch = () => {
      if (!touching) return;
      touching = false;
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
      },
      { passive: true }
    );

    if (!reducedMotion) {
      const animateTicker = (now) => {
        if (!lastFrame) lastFrame = now;
        const elapsed = Math.min(now - lastFrame, 48);
        lastFrame = now;

        if (!hovering && !keyboardFocus && !touching && !document.hidden && now >= resumeAt) {
          tickerCycleWidth = tickerSet.getBoundingClientRect().width;
          if (tickerCycleWidth > 0) {
            ticker.scrollLeft += elapsed * 0.032;
            if (ticker.scrollLeft >= tickerCycleWidth) ticker.scrollLeft %= tickerCycleWidth;
          }
        }

        window.requestAnimationFrame(animateTicker);
      };
      window.requestAnimationFrame(animateTicker);
    }
  }

  void refreshTicker();
  window.setInterval(refreshTicker, 60_000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void refreshTicker();
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
