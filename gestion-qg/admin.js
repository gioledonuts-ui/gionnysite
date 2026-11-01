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

  let storageConfigured = false;
  let saving = false;
  let inboxLoading = false;
  let inboxCursor = "";
  let inboxHasMore = false;

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
        count ? "Message supprimé." : inboxHasMore ? "Page supprimée." : "Aucun message pour le moment."
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
    setStatus(inboxStatus, "Chargement des messages…");

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
        setStatus(inboxStatus, data.error || "La boîte de réception n’a pas pu être chargée.", "error");
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
        count ? `${count} message${count > 1 ? "s" : ""} reçu${count > 1 ? "s" : ""}.` : "Aucun message pour le moment."
      );
    } catch {
      setStatus(inboxStatus, "Impossible de joindre le serveur. Réessaie.", "error");
    } finally {
      inboxLoading = false;
      if (inboxRefreshButton) inboxRefreshButton.disabled = false;
      if (inboxMoreButton) inboxMoreButton.disabled = false;
    }
  };

  inboxRefreshButton?.addEventListener("click", () => void loadInbox({ reset: true }));
  inboxMoreButton?.addEventListener("click", () => void loadInbox());

  const showAdmin = async () => {
    loginPanel.hidden = true;
    adminPanel.hidden = false;
    setStatus(loginStatus, "");
    setStatus(saveStatus, "");
    await Promise.all([loadSettings(), loadInbox({ reset: true })]);
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
    const schedule = Object.fromEntries(
      DAYS.map((day) => [
        day,
        {
          enabled: document.querySelector(`[data-day-enabled="${day}"]`).checked,
          time: document.querySelector(`[data-day-time="${day}"]`).value,
        },
      ])
    );
    return { version: 1, socials, schedule };
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
