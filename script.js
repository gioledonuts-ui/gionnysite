(() => {
  const storageKey = "gionny:visited-links:v1";
  const youtubeSeenKey = "gionny:youtube:last-seen:v1";
  const links = [...document.querySelectorAll("[data-network]")];
  const knownNetworks = new Set(links.map((link) => link.dataset.network));
  const visitedNetworks = new Set();
  let recentYouTubeUploads = [];
  let youtubeApiAvailable = false;
  let latestTickerUpdates = null;
  let configuredSocials = {};
  let latestYouTubeUrl = "";

  const DEFAULT_YOUTUBE_URL = "https://www.youtube.com/@gionnyyy";
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

  const isValidSiteConfig = (config) => {
    if (!config || typeof config !== "object" || !config.socials || !config.schedule) return false;
    if (Object.keys(SOCIAL_HOSTS).some((key) => !safeSocialUrl(key, config.socials[key]))) return false;
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

  const formatScheduleTime = (value) => {
    const [hour, minute] = value.split(":");
    return `${Number(hour)}h${minute === "00" ? "" : minute}`;
  };

  const renderSchedule = (schedule) => {
    const timeDisplay = document.querySelector("[data-schedule-time]");
    const daysList = document.querySelector("[data-schedule-days]");
    if (!timeDisplay || !daysList) return;

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
    renderSchedule(config.schedule);

    if (latestTickerUpdates) applyTickerUpdates(latestTickerUpdates);
    else applyConfiguredLinks();
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
      aboutDialog.showModal();
      profileTrigger.setAttribute("aria-expanded", "true");
      aboutDialog.querySelector("[data-close-about]")?.focus();
    });
    closeAboutButtons.forEach((button) => {
      button.addEventListener("click", () => aboutDialog.close());
    });
    aboutDialog.addEventListener("click", (event) => {
      if (event.target === aboutDialog) aboutDialog.close();
    });
    aboutDialog.addEventListener("close", () => {
      profileTrigger.setAttribute("aria-expanded", "false");
      profileTrigger.focus({ preventScroll: true });
    });
  }

  const contactLauncher = document.querySelector("[data-open-contact]");
  const contactWidget = document.querySelector("[data-contact-widget]");
  const minimizeContactButton = document.querySelector("[data-minimize-contact]");
  const contactNewView = document.querySelector("[data-contact-new]");
  const contactForm = document.querySelector("[data-contact-form]");
  const contactSubmit = document.querySelector("[data-contact-submit]");
  const contactStatus = document.querySelector("[data-contact-status]");
  const contactReplyForm = document.querySelector("[data-contact-reply-form]");
  const contactReplySubmit = document.querySelector("[data-contact-reply-submit]");
  const contactReplyStatus = document.querySelector("[data-contact-thread-status]");
  const contactThread = document.querySelector("[data-contact-thread]");
  const contactThreadMessages = document.querySelector("[data-contact-thread-messages]");
  const contactThreadPseudo = document.querySelector("[data-contact-thread-pseudo]");
  const contactThreadState = document.querySelector("[data-contact-thread-state]");
  const contactThreadClosed = document.querySelector("[data-contact-closed]");
  const contactThreadClosedCopy = document.querySelector("[data-contact-closed-copy]");
  const newConversationButton = document.querySelector("[data-new-conversation]");
  const contactBadge = document.querySelector("[data-contact-badge]");
  const VISITOR_SEEN_PREFIX = "gionny:conversation:last-seen:v1:";

  let visitorConversation = null;
  let visitorConversationMessages = [];
  let newConversationMode = false;
  let visitorConversationLoading = false;
  let visitorPollTimer = 0;

  const setContactStatus = (message, kind = "") => {
    if (!contactStatus) return;
    contactStatus.textContent = message;
    if (kind) contactStatus.dataset.kind = kind;
    else delete contactStatus.dataset.kind;
  };

  const setContactThreadStatus = (message, kind = "") => {
    if (!contactReplyStatus) return;
    contactReplyStatus.textContent = message;
    if (kind) contactReplyStatus.dataset.kind = kind;
    else delete contactReplyStatus.dataset.kind;
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

  const createVisitorChatMessage = (message) => {
    const item = document.createElement("article");
    const sender = message.sender === "gionny" ? "gionny" : "visitor";
    item.className = `contact-chat-message contact-chat-message--${sender}`;

    const name = document.createElement("span");
    name.className = "contact-chat-sender";
    name.textContent = sender === "gionny" ? "Gionny" : visitorConversation?.pseudo || "Toi";

    const text = document.createElement("p");
    text.className = "contact-chat-text";
    text.textContent = typeof message.text === "string" ? message.text : "";

    const date = document.createElement("time");
    date.className = "contact-chat-date";
    date.dateTime = message.createdAt;
    date.textContent = formatConversationTime(message.createdAt);

    item.append(name, text, date);
    return item;
  };

  const renderVisitorConversation = ({ announceNewReply = false } = {}) => {
    if (!visitorConversation || !contactThread || !contactNewView) return;
    contactNewView.hidden = true;
    contactThread.hidden = false;
    contactThreadPseudo.textContent = visitorConversation.pseudo || "Ta discussion privée";
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

    const wasNearBottom = contactThreadMessages.scrollHeight - contactThreadMessages.scrollTop - contactThreadMessages.clientHeight < 80;
    contactThreadMessages.replaceChildren(...visitorConversationMessages.map(createVisitorChatMessage));
    if (wasNearBottom) contactThreadMessages.scrollTop = contactThreadMessages.scrollHeight;

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

      if (data.conversation && Array.isArray(data.messages)) {
        visitorConversation = data.conversation;
        visitorConversationMessages = data.messages;
        renderVisitorConversation({ announceNewReply: true });
      } else {
        visitorConversation = null;
        visitorConversationMessages = [];
        newConversationMode = false;
        contactThread.hidden = true;
        contactNewView.hidden = false;
        if (contactBadge) contactBadge.hidden = true;
      }
    } catch {
      if (!quiet) setContactStatus("Impossible de joindre le serveur. Réessaie dans un instant.", "error");
    } finally {
      visitorConversationLoading = false;
    }
  };

  const openContactWidget = () => {
    if (!contactWidget) return;
    contactWidget.hidden = false;
    contactLauncher?.setAttribute("aria-expanded", "true");
    if (contactBadge) contactBadge.hidden = true;
    if (visitorConversation && !newConversationMode) {
      markVisitorThreadSeen();
      void loadVisitorConversation({ quiet: true });
      contactReplyForm?.querySelector("textarea")?.focus({ preventScroll: true });
    } else {
      contactForm?.elements.namedItem("pseudo")?.focus({ preventScroll: true });
    }
  };

  const minimizeContactWidget = () => {
    if (!contactWidget) return;
    contactWidget.hidden = true;
    contactLauncher?.setAttribute("aria-expanded", "false");
    contactLauncher?.focus({ preventScroll: true });
    if (visitorConversation && !newConversationMode) renderVisitorConversation({ announceNewReply: true });
  };

  if (contactLauncher && contactWidget) {
    contactLauncher.addEventListener("click", () => {
      if (contactWidget.hidden) openContactWidget();
      else minimizeContactWidget();
    });
    minimizeContactButton?.addEventListener("click", minimizeContactWidget);

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || contactWidget.hidden || document.querySelector("dialog[open]")) return;
      minimizeContactWidget();
    });

    contactForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!contactForm.reportValidity() || !contactSubmit || contactSubmit.disabled) return;

      const formData = new FormData(contactForm);
      const payload = {
        pseudo: String(formData.get("pseudo") || ""),
        message: String(formData.get("message") || ""),
        website: String(formData.get("website") || ""),
        newConversation: newConversationMode,
      };
      contactSubmit.disabled = true;
      setContactStatus(newConversationMode ? "Ouverture d’une nouvelle discussion…" : "Envoi de ton message…");

      try {
        const response = await fetch("/api/contact", {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
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

        if (data.conversation) {
          visitorConversation = data.conversation;
          if (Array.isArray(data.messages)) visitorConversationMessages = data.messages;
          else if (data.message) visitorConversationMessages.push(data.message);
          newConversationMode = false;
          contactForm.reset();
          setContactStatus("");
          renderVisitorConversation();
          markVisitorThreadSeen();
          contactReplyForm?.querySelector("textarea")?.focus({ preventScroll: true });
        } else {
          setContactStatus("Merci, ton message a bien été reçu.", "success");
        }
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
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify({ message }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) {
          setContactThreadStatus(data.error || "Ton message n’a pas pu être envoyé.", "error");
          if (response.status === 409 || response.status === 403 || response.status === 404) {
            await loadVisitorConversation({ quiet: true });
          }
          return;
        }
        if (data.message) visitorConversationMessages.push(data.message);
        if (data.conversation) visitorConversation = data.conversation;
        messageField.value = "";
        setContactThreadStatus("");
        renderVisitorConversation();
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
      contactNewView.hidden = false;
      setContactStatus("");
      const pseudoInput = contactForm?.elements.namedItem("pseudo");
      const messageInput = contactForm?.elements.namedItem("message");
      if (pseudoInput) pseudoInput.value = visitorConversation.pseudo || "";
      if (messageInput) messageInput.value = "";
      messageInput?.focus({ preventScroll: true });
    });

    void loadVisitorConversation();
    visitorPollTimer = window.setInterval(() => {
      if (visitorConversation && !newConversationMode && !contactWidget.hidden) {
        void loadVisitorConversation({ quiet: true });
      }
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

  void refreshSiteConfig();
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
