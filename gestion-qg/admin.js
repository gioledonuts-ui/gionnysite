(() => {
  const DAYS = [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ];
  const SOCIALS = ["twitch", "tiktok", "youtube", "x", "instagram", "discord"];
  const SOCIAL_INFO = ["twitch", "tiktok", "youtube", "x", "instagram"];
  const loginPanel = document.querySelector("[data-login-panel]");
  const adminPanel = document.querySelector("[data-admin-panel]");
  const loginForm = document.querySelector("#login-form");
  const settingsForm = document.querySelector("#settings-form");
  const loginInput = document.querySelector("#admin-password");
  const loginButton = document.querySelector("[data-login-button]");
  const loginStatus = document.querySelector("[data-login-status]");
  const storageNotice = document.querySelector("[data-storage-notice]");
  const saveButton = document.querySelector("[data-save-button]");
  const saveStatus = document.querySelector("[data-save-status]");
  const logoutButton = document.querySelector("[data-logout]");
  const inboxList = document.querySelector("[data-inbox-list]");
  const inboxStatus = document.querySelector("[data-inbox-status]");
  const inboxRefreshButton = document.querySelector("[data-inbox-refresh]");
  const inboxMoreButton = document.querySelector("[data-inbox-more]");
  const conversationsList = document.querySelector("[data-conversation-list]");
  const conversationsStatus = document.querySelector("[data-conversations-status]");
  const conversationsMoreButton = document.querySelector("[data-conversations-more]");
  const conversationEmpty = document.querySelector("[data-conversation-empty]");
  const conversationContent = document.querySelector("[data-conversation-content]");
  const threadPseudo = document.querySelector("[data-thread-pseudo]");
  const threadStatus = document.querySelector("[data-thread-status]");
  const threadMessages = document.querySelector("[data-thread-messages]");
  const threadCloseButton = document.querySelector("[data-thread-close]");
  const threadBlockButton = document.querySelector("[data-thread-block]");
  const threadDeleteButton = document.querySelector("[data-thread-delete]");
  const threadClosedNote = document.querySelector("[data-thread-closed-note]");
  const replyForm = document.querySelector("[data-reply-form]");
  const replyInput = document.querySelector("[data-reply-input]");
  const replySendButton = document.querySelector("[data-reply-send]");
  const replyStatus = document.querySelector("[data-reply-status]");

  let storageConfigured = false;
  let saving = false;
  let inboxLoading = false;
  let inboxCursor = "";
  let inboxHasMore = false;
  let conversationsLoading = false;
  let conversationsCursor = "";
  let conversationsHasMore = false;
  let currentConversationId = "";
  let currentConversationStatus = "";
  let selectedConversationLoading = false;
  let adminPollTimer = 0;

  const setStatus = (element, message, kind = "") => {
    if (!element) return;
    element.textContent = message;
    if (kind) element.dataset.kind = kind;
    else delete element.dataset.kind;
  };

  const readJson = async (response) => {
    try {
      return await response.json();
    } catch {
      return {};
    }
  };

  const showLogin = (message = "") => {
    if (adminPollTimer) window.clearInterval(adminPollTimer);
    adminPollTimer = 0;
    loginPanel.hidden = false;
    adminPanel.hidden = true;
    setStatus(loginStatus, message, message ? "error" : "");
    window.setTimeout(() => loginInput?.focus(), 0);
  };

  const updateDayInputState = (day) => {
    const enabled = document.querySelector(`[data-day-enabled="${day}"]`);
    const time = document.querySelector(`[data-day-time="${day}"]`);
    const row = document.querySelector(`[data-day-row="${day}"]`);
    if (!enabled || !time || !row) return;
    time.disabled = !enabled.checked;
    row.dataset.disabled = String(!enabled.checked);
  };

  const populateForm = (config) => {
    for (const key of SOCIALS) {
      const input = settingsForm.elements.namedItem(`socials.${key}`);
      if (input && typeof config?.socials?.[key] === "string") input.value = config.socials[key];
    }

    for (const key of SOCIAL_INFO) {
      const input = settingsForm.elements.namedItem(`socialInfo.${key}`);
      if (input) input.value = typeof config?.socialInfo?.[key] === "string" ? config.socialInfo[key] : "";
    }

    for (const day of DAYS) {
      const enabled = document.querySelector(`[data-day-enabled="${day}"]`);
      const time = document.querySelector(`[data-day-time="${day}"]`);
      const saved = config?.schedule?.[day];
      if (!enabled || !time || !saved) continue;
      enabled.checked = saved.enabled === true;
      if (typeof saved.time === "string") time.value = saved.time;
      updateDayInputState(day);
    }
  };

  const formatSavedTime = (value) => {
    if (typeof value !== "string") return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return new Intl.DateTimeFormat("fr-FR", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "Europe/Paris",
    }).format(date);
  };

  const updateStorageNotice = (data) => {
    storageConfigured = data?.storageConfigured === true;
    saveButton.disabled = !storageConfigured || saving;

    if (!storageConfigured) {
      storageNotice.dataset.state = "warning";
      storageNotice.textContent =
        "Le stockage partagé n’est pas encore activé dans Vercel. Tu peux préparer tes réglages ici, mais l’enregistrement pour tous sera disponible après la création et la connexion d’un espace Vercel Blob.";
      return;
    }

    storageNotice.dataset.state = "ready";
    const savedTime = formatSavedTime(data.updatedAt);
    storageNotice.textContent = savedTime
      ? `Stockage en ligne actif. Dernière sauvegarde partagée : ${savedTime}.`
      : "Stockage en ligne actif. Les réglages seront partagés après le premier enregistrement.";
  };

  const loadSettings = async () => {
    setStatus(saveStatus, "Chargement des réglages…");
    saveButton.disabled = true;

    try {
      const response = await fetch("/api/site-config", {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await readJson(response);
      if (!response.ok) {
        storageNotice.dataset.state = "error";
        storageNotice.textContent = data.message || "Impossible de charger les réglages en ligne.";
        setStatus(saveStatus, "Les réglages n’ont pas pu être chargés.", "error");
        return;
      }

      populateForm(data.config);
      updateStorageNotice(data);
      setStatus(saveStatus, data.updatedAt ? "Réglages partagés chargés." : "Prêt à configurer.");
    } catch {
      storageNotice.dataset.state = "error";
      storageNotice.textContent = "Impossible de joindre le serveur. Vérifie ta connexion et réessaie.";
      setStatus(saveStatus, "Erreur de connexion.", "error");
    }
  };

  const formatInboxTime = (value) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "Date inconnue";
    return new Intl.DateTimeFormat("fr-FR", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Paris",
    }).format(date);
  };

  const createInboxMessage = (message) => {
    const card = document.createElement("article");
    card.className = "inbox-message";

    const header = document.createElement("div");
    header.className = "inbox-message-header";

    const sender = document.createElement("strong");
    sender.className = "inbox-message-sender";
    sender.textContent = typeof message.pseudo === "string" ? message.pseudo : "Visiteur";

    const date = document.createElement("time");
    date.className = "inbox-message-date";
    date.dateTime = message.createdAt;
    date.textContent = formatInboxTime(message.createdAt);

    const identity = document.createElement("div");
    identity.className = "inbox-message-identity";
    identity.append(sender, date);

    const removeButton = document.createElement("button");
    removeButton.className = "inbox-delete";
    removeButton.type = "button";
    removeButton.textContent = "Supprimer";
    removeButton.setAttribute("aria-label", `Supprimer le message de ${sender.textContent}`);

    const content = document.createElement("p");
    content.className = "inbox-message-content";
    content.textContent = typeof message.message === "string" ? message.message : "";

    header.append(identity, removeButton);
    card.append(header, content);
    removeButton.addEventListener("click", () => {
      void deleteInboxMessage(message.id, card, removeButton);
    });
    return card;
  };

  const deleteInboxMessage = async (id, card, button) => {
    if (!id || !window.confirm("Supprimer définitivement ce message ?")) return;
    button.disabled = true;

    try {
      const response = await fetch("/api/admin-messages", {
        method: "DELETE",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ id }),
      });
      const data = await readJson(response);

      if (response.status === 401) {
        showLogin("Ta session a expiré. Saisis de nouveau le code d’accès.");
        return;
      }
      if (!response.ok || data.deleted !== true) {
        setStatus(inboxStatus, data.error || "Le message n’a pas pu être supprimé.", "error");
        return;
      }

      card.remove();
      const count = inboxList?.querySelectorAll(".inbox-message").length || 0;
      setStatus(
        inboxStatus,
        count ? "Message supprimé." : inboxHasMore ? "Page supprimée." : "Aucun ancien message."
      );
    } catch {
      setStatus(inboxStatus, "Impossible de joindre le serveur. Réessaie.", "error");
    } finally {
      button.disabled = false;
    }
  };

  const loadInbox = async ({ reset = false } = {}) => {
    if (!inboxList || inboxLoading) return;
    if (reset) {
      inboxList.replaceChildren();
      inboxCursor = "";
      inboxHasMore = false;
    }

    inboxLoading = true;
    if (inboxRefreshButton) inboxRefreshButton.disabled = true;
    if (inboxMoreButton) inboxMoreButton.disabled = true;
    setStatus(inboxStatus, "Chargement des anciens messages…");

    try {
      const url = new URL("/api/admin-messages", window.location.origin);
      if (inboxCursor) url.searchParams.set("cursor", inboxCursor);
      const response = await fetch(url.href, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await readJson(response);

      if (response.status === 401) {
        showLogin("Ta session a expiré. Saisis de nouveau le code d’accès.");
        return;
      }
      if (!response.ok) {
        setStatus(inboxStatus, data.error || "Les anciens messages n’ont pas pu être chargés.", "error");
        return;
      }

      const messages = Array.isArray(data.messages) ? data.messages : [];
      messages.forEach((message) => inboxList.append(createInboxMessage(message)));
      inboxCursor = typeof data.cursor === "string" ? data.cursor : "";
      inboxHasMore = data.hasMore === true && Boolean(inboxCursor);
      if (inboxMoreButton) inboxMoreButton.hidden = !inboxHasMore;

      const count = inboxList.querySelectorAll(".inbox-message").length;
      setStatus(
        inboxStatus,
        count ? `${count} ancien${count > 1 ? "s" : ""} message${count > 1 ? "s" : ""}.` : "Aucun ancien message."
      );
    } catch {
      setStatus(inboxStatus, "Impossible de joindre le serveur. Réessaie.", "error");
    } finally {
      inboxLoading = false;
      if (inboxRefreshButton) inboxRefreshButton.disabled = false;
      if (inboxMoreButton) inboxMoreButton.disabled = false;
    }
  };

  const statusLabel = (status) => {
    if (status === "blocked") return "Bloquée";
    if (status === "closed") return "Fermée";
    return "Ouverte";
  };

  const createConversationListItem = (conversation) => {
    const button = document.createElement("button");
    button.className = "conversation-list-item";
    button.type = "button";
    button.dataset.conversationId = conversation.id;
    button.setAttribute("aria-current", String(conversation.id === currentConversationId));

    const head = document.createElement("span");
    head.className = "conversation-list-head";

    const pseudo = document.createElement("strong");
    pseudo.className = "conversation-list-pseudo";
    pseudo.textContent = typeof conversation.pseudo === "string" ? conversation.pseudo : "Visiteur";

    const status = document.createElement("span");
    status.className = "conversation-list-status";
    status.dataset.state = conversation.status;
    status.textContent = statusLabel(conversation.status);
    head.append(pseudo, status);

    const preview = document.createElement("span");
    preview.className = "conversation-list-preview";
    const previewText = typeof conversation.lastMessagePreview === "string" ? conversation.lastMessagePreview : "";
    preview.textContent = conversation.lastMessageSender === "gionny" ? `Toi : ${previewText}` : `Visiteur : ${previewText}`;

    const date = document.createElement("time");
    date.className = "conversation-list-date";
    date.dateTime = conversation.updatedAt;
    date.textContent = formatInboxTime(conversation.updatedAt);

    button.append(head, preview, date);
    button.addEventListener("click", () => selectConversation(conversation.id, { scroll: true }));
    return button;
  };

  const updateConversationSelection = () => {
    conversationsList?.querySelectorAll("[data-conversation-id]").forEach((button) => {
      button.setAttribute("aria-current", String(button.dataset.conversationId === currentConversationId));
    });
  };

  const loadConversations = async ({ reset = false, quiet = false } = {}) => {
    if (!conversationsList || conversationsLoading) return;
    if (reset) {
      conversationsList.replaceChildren();
      conversationsCursor = "";
      conversationsHasMore = false;
    }

    conversationsLoading = true;
    if (inboxRefreshButton) inboxRefreshButton.disabled = true;
    if (conversationsMoreButton) conversationsMoreButton.disabled = true;
    if (!quiet) setStatus(conversationsStatus, "Chargement des discussions…");

    try {
      const url = new URL("/api/admin-messages", window.location.origin);
      url.searchParams.set("view", "conversations");
      if (conversationsCursor) url.searchParams.set("cursor", conversationsCursor);
      const response = await fetch(url.href, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await readJson(response);

      if (response.status === 401) {
        showLogin("Ta session a expiré. Saisis de nouveau le code d’accès.");
        return;
      }
      if (!response.ok) {
        if (!quiet) setStatus(conversationsStatus, data.error || "Les discussions n’ont pas pu être chargées.", "error");
        return;
      }

      const items = Array.isArray(data.conversations) ? data.conversations : [];
      items.forEach((conversation) => conversationsList.append(createConversationListItem(conversation)));
      conversationsCursor = typeof data.cursor === "string" ? data.cursor : "";
      conversationsHasMore = data.hasMore === true && Boolean(conversationsCursor);
      if (conversationsMoreButton) conversationsMoreButton.hidden = !conversationsHasMore;

      const count = conversationsList.querySelectorAll("[data-conversation-id]").length;
      if (!quiet) {
        setStatus(
          conversationsStatus,
          count ? `${count} discussion${count > 1 ? "s" : ""}.` : "Aucune discussion pour le moment."
        );
      }
      updateConversationSelection();

      if (!currentConversationId && items[0]) {
        await selectConversation(items[0].id);
      } else if (currentConversationId) {
        void loadSelectedConversation({ quiet: true });
      }
    } catch {
      if (!quiet) setStatus(conversationsStatus, "Impossible de joindre le serveur. Réessaie.", "error");
    } finally {
      conversationsLoading = false;
      if (inboxRefreshButton) inboxRefreshButton.disabled = false;
      if (conversationsMoreButton) conversationsMoreButton.disabled = false;
    }
  };

  const createThreadMessage = (message) => {
    const item = document.createElement("article");
    const sender = message.sender === "gionny" ? "gionny" : "visitor";
    item.className = `thread-message thread-message--${sender}`;

    const name = document.createElement("span");
    name.className = "thread-message-sender";
    name.textContent = sender === "gionny" ? "Gionny" : "Visiteur";

    const text = document.createElement("p");
    text.className = "thread-message-text";
    text.textContent = typeof message.text === "string" ? message.text : "";

    const date = document.createElement("time");
    date.className = "thread-message-date";
    date.dateTime = message.createdAt;
    date.textContent = formatInboxTime(message.createdAt);

    item.append(name, text, date);
    return item;
  };

  const renderSelectedConversation = (data) => {
    const conversation = data.conversation;
    currentConversationStatus = conversation.status;
    conversationEmpty.hidden = true;
    conversationContent.hidden = false;
    threadPseudo.textContent = conversation.pseudo || "Visiteur";
    threadStatus.textContent = statusLabel(conversation.status);
    threadStatus.dataset.state = conversation.status;
    threadCloseButton.disabled = conversation.status === "blocked";
    threadCloseButton.textContent = conversation.status === "open" ? "Fermer" : "Réouvrir";
    threadBlockButton.textContent = conversation.status === "blocked" ? "Débloquer" : "Bloquer";
    threadDeleteButton.disabled = false;

    const isOpen = conversation.status === "open";
    replyForm.hidden = !isOpen;
    threadClosedNote.hidden = isOpen;
    threadClosedNote.textContent = conversation.status === "blocked"
      ? "Cette discussion est bloquée. Débloque-la pour pouvoir répondre à nouveau."
      : "Cette discussion est fermée. Tu peux la rouvrir quand tu veux.";

    const wasNearBottom = threadMessages.scrollHeight - threadMessages.scrollTop - threadMessages.clientHeight < 90;
    threadMessages.replaceChildren(...(Array.isArray(data.messages) ? data.messages : []).map(createThreadMessage));
    if (wasNearBottom) threadMessages.scrollTop = threadMessages.scrollHeight;
    updateConversationSelection();
  };

  const loadSelectedConversation = async ({ quiet = false } = {}) => {
    if (!currentConversationId || selectedConversationLoading) return;
    const requestedId = currentConversationId;
    selectedConversationLoading = true;

    try {
      const url = new URL("/api/admin-messages", window.location.origin);
      url.searchParams.set("view", "conversation");
      url.searchParams.set("id", requestedId);
      const response = await fetch(url.href, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await readJson(response);

      if (response.status === 401) {
        showLogin("Ta session a expiré. Saisis de nouveau le code d’accès.");
        return;
      }
      if (!response.ok) {
        if (requestedId === currentConversationId && response.status === 404) {
          currentConversationId = "";
          currentConversationStatus = "";
          conversationContent.hidden = true;
          conversationEmpty.hidden = false;
        } else if (requestedId === currentConversationId) {
          setStatus(replyStatus, data.error || "La discussion n’a pas pu être chargée.", "error");
        }
        return;
      }
      if (requestedId === currentConversationId) renderSelectedConversation(data);
    } catch {
      if (!quiet) setStatus(replyStatus, "Impossible de charger cette discussion.", "error");
    } finally {
      selectedConversationLoading = false;
      if (currentConversationId && currentConversationId !== requestedId) {
        void loadSelectedConversation({ quiet: true });
      }
    }
  };

  const selectConversation = async (id, { scroll = false } = {}) => {
    if (!id) return;
    currentConversationId = id;
    setStatus(replyStatus, "");
    conversationEmpty.hidden = true;
    conversationContent.hidden = false;
    threadPseudo.textContent = "Chargement…";
    threadMessages.replaceChildren();
    updateConversationSelection();
    await loadSelectedConversation();
    if (scroll && window.matchMedia("(max-width: 640px)").matches) {
      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      document.querySelector("[data-conversation-detail]")?.scrollIntoView({ behavior, block: "start" });
    }
  };

  const changeConversationStatus = async (status) => {
    if (!currentConversationId) return;
    const conversationId = currentConversationId;
    if (status === "blocked" && !window.confirm("Bloquer cette discussion sur ce navigateur ? Sans compte ni e-mail, une autre session peut démarrer un nouveau fil.")) return;

    threadCloseButton.disabled = true;
    threadBlockButton.disabled = true;
    setStatus(replyStatus, status === "blocked" ? "Blocage de la discussion…" : "Mise à jour…");
    try {
      const response = await fetch("/api/admin-messages", {
        method: "PATCH",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ conversationId, status }),
      });
      const data = await readJson(response);
      if (response.status === 401) {
        showLogin("Ta session a expiré. Saisis de nouveau le code d’accès.");
        return;
      }
      if (!response.ok || !data.conversation) {
        setStatus(replyStatus, data.error || "Le statut n’a pas pu être changé.", "error");
        return;
      }
      setStatus(replyStatus, status === "blocked" ? "Discussion bloquée." : "Statut mis à jour.");
      await loadSelectedConversation({ quiet: true });
      await loadConversations({ reset: true, quiet: true });
    } catch {
      setStatus(replyStatus, "Impossible de joindre le serveur. Réessaie.", "error");
    } finally {
      threadCloseButton.disabled = !currentConversationId || currentConversationStatus === "blocked";
      threadBlockButton.disabled = !currentConversationId;
    }
  };

  const removeConversation = async () => {
    if (!currentConversationId || !window.confirm("Supprimer définitivement toute cette discussion ?")) return;
    const conversationId = currentConversationId;
    threadDeleteButton.disabled = true;
    try {
      const response = await fetch("/api/admin-messages", {
        method: "DELETE",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ conversationId }),
      });
      const data = await readJson(response);
      if (response.status === 401) {
        showLogin("Ta session a expiré. Saisis de nouveau le code d’accès.");
        return;
      }
      if (!response.ok || data.deleted !== true) {
        setStatus(replyStatus, data.error || "La discussion n’a pas pu être supprimée.", "error");
        return;
      }
      currentConversationId = "";
      currentConversationStatus = "";
      conversationContent.hidden = true;
      conversationEmpty.hidden = false;
      setStatus(replyStatus, "Discussion supprimée.");
      await loadConversations({ reset: true });
    } catch {
      setStatus(replyStatus, "Impossible de joindre le serveur. Réessaie.", "error");
    } finally {
      threadDeleteButton.disabled = false;
    }
  };

  replyForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = replyInput.value.trim();
    const conversationId = currentConversationId;
    if (!conversationId || !message || !replyForm.reportValidity() || replySendButton.disabled) return;

    replySendButton.disabled = true;
    setStatus(replyStatus, "Envoi de ta réponse…");
    try {
      const response = await fetch("/api/admin-messages", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ conversationId, message }),
      });
      const data = await readJson(response);
      if (response.status === 401) {
        showLogin("Ta session a expiré. Saisis de nouveau le code d’accès.");
        return;
      }
      if (!response.ok || data.ok !== true) {
        setStatus(replyStatus, data.error || "Ta réponse n’a pas pu être envoyée.", "error");
        if (response.status === 409) await loadSelectedConversation({ quiet: true });
        return;
      }
      replyInput.value = "";
      setStatus(replyStatus, "Réponse envoyée.");
      await Promise.all([loadSelectedConversation({ quiet: true }), loadConversations({ reset: true, quiet: true })]);
    } catch {
      setStatus(replyStatus, "Impossible de joindre le serveur. Réessaie.", "error");
    } finally {
      replySendButton.disabled = false;
    }
  });

  threadCloseButton?.addEventListener("click", () => {
    const nextStatus = currentConversationStatus === "open" ? "closed" : "open";
    void changeConversationStatus(nextStatus);
  });
  threadBlockButton?.addEventListener("click", () => {
    const nextStatus = currentConversationStatus === "blocked" ? "open" : "blocked";
    void changeConversationStatus(nextStatus);
  });
  threadDeleteButton?.addEventListener("click", () => void removeConversation());

  const startAdminPolling = () => {
    if (adminPollTimer) window.clearInterval(adminPollTimer);
    adminPollTimer = window.setInterval(() => {
      if (adminPanel.hidden) return;
      void loadConversations({ reset: true, quiet: true });
      if (currentConversationId) void loadSelectedConversation({ quiet: true });
    }, 20_000);
  };

  inboxRefreshButton?.addEventListener("click", () => {
    void loadInbox({ reset: true });
    void loadConversations({ reset: true });
    if (currentConversationId) void loadSelectedConversation({ quiet: true });
  });
  inboxMoreButton?.addEventListener("click", () => void loadInbox());
  conversationsMoreButton?.addEventListener("click", () => void loadConversations());

  const showAdmin = async () => {
    loginPanel.hidden = true;
    adminPanel.hidden = false;
    setStatus(loginStatus, "");
    setStatus(saveStatus, "");
    await Promise.all([
      loadSettings(),
      loadInbox({ reset: true }),
      loadConversations({ reset: true }),
    ]);
    startAdminPolling();
  };

  loginForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!loginForm.reportValidity()) return;

    loginButton.disabled = true;
    setStatus(loginStatus, "Vérification du code…");
    try {
      const response = await fetch("/api/admin-auth", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({ password: loginInput.value }),
      });
      const data = await readJson(response);

      if (!response.ok || data.authenticated !== true) {
        setStatus(loginStatus, data.error || "La connexion n’a pas abouti.", "error");
        loginInput.select();
        return;
      }

      loginInput.value = "";
      await showAdmin();
    } catch {
      setStatus(loginStatus, "Impossible de joindre le serveur. Réessaie.", "error");
    } finally {
      loginButton.disabled = false;
    }
  });

  for (const day of DAYS) {
    document.querySelector(`[data-day-enabled="${day}"]`)?.addEventListener("change", () => {
      updateDayInputState(day);
    });
    updateDayInputState(day);
  }

  const collectConfig = () => {
    const socials = Object.fromEntries(
      SOCIALS.map((key) => [key, settingsForm.elements.namedItem(`socials.${key}`).value.trim()])
    );
    const socialInfo = Object.fromEntries(
      SOCIAL_INFO.map((key) => [key, settingsForm.elements.namedItem(`socialInfo.${key}`).value.trim()])
    );
    const schedule = Object.fromEntries(
      DAYS.map((day) => [
        day,
        {
          enabled: document.querySelector(`[data-day-enabled="${day}"]`).checked,
          time: document.querySelector(`[data-day-time="${day}"]`).value,
        },
      ])
    );
    return { version: 1, socials, socialInfo, schedule };
  };

  settingsForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!settingsForm.reportValidity() || saving) return;
    if (!storageConfigured) {
      setStatus(saveStatus, "Active d’abord le stockage Vercel Blob pour enregistrer en ligne.", "error");
      return;
    }

    saving = true;
    saveButton.disabled = true;
    setStatus(saveStatus, "Enregistrement en ligne…");

    try {
      const response = await fetch("/api/site-config", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(collectConfig()),
      });
      const data = await readJson(response);

      if (response.status === 401) {
        showLogin("Ta session a expiré. Saisis de nouveau le code d’accès.");
        return;
      }
      if (!response.ok) {
        if (response.status === 503 && data.error === "blob_storage_not_configured") {
          updateStorageNotice({ storageConfigured: false });
        }
        setStatus(saveStatus, data.message || data.error || "La sauvegarde a échoué.", "error");
        return;
      }

      populateForm(data.config);
      updateStorageNotice(data);
      const savedTime = formatSavedTime(data.updatedAt);
      setStatus(
        saveStatus,
        savedTime ? `Enregistré pour tout le monde · ${savedTime}.` : "Enregistré pour tout le monde.",
        "success"
      );
    } catch {
      setStatus(saveStatus, "Erreur de connexion : les changements n’ont pas été enregistrés.", "error");
    } finally {
      saving = false;
      saveButton.disabled = !storageConfigured;
    }
  });

  logoutButton?.addEventListener("click", async () => {
    logoutButton.disabled = true;
    try {
      await fetch("/api/admin-auth", {
        method: "DELETE",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
    } catch {
      // Hiding the admin screen is still useful if the network is unavailable.
    } finally {
      logoutButton.disabled = false;
      showLogin();
    }
  });

  const restoreSession = async () => {
    try {
      const response = await fetch("/api/admin-auth", {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await readJson(response);
      if (response.ok && data.authenticated === true) {
        await showAdmin();
        return;
      }
    } catch {
      // The login form remains available if the session check cannot reach the server.
    }
    showLogin();
  };

  void restoreSession();
})();
