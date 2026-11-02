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
  const adminTabs = [...document.querySelectorAll("[data-admin-tab]")];
  const adminTabPanels = [...document.querySelectorAll("[data-admin-tab-panel]")];
  const adminTitle = document.querySelector("[data-admin-title]");
  const membersList = document.querySelector("[data-members-list]");
  const membersStatus = document.querySelector("[data-members-status]");
  const membersRefreshButton = document.querySelector("[data-members-refresh]");
  const membersMoreButton = document.querySelector("[data-members-more]");
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
  const mailFilterButtons = [...document.querySelectorAll("[data-mail-filter]")];
  const conversationSubjectFilter = document.querySelector("[data-conversation-subject-filter]");
  const selectAllConversations = document.querySelector("[data-select-all-conversations]");
  const conversationPageCount = document.querySelector("[data-page-count]");
  const bulkToolbar = document.querySelector("[data-bulk-toolbar]");
  const selectionCount = document.querySelector("[data-selection-count]");
  const bulkFavoriteButton = document.querySelector("[data-bulk-favorite]");
  const bulkReadButton = document.querySelector("[data-bulk-read]");
  const bulkCloseButton = document.querySelector("[data-bulk-close]");
  const bulkDeleteButton = document.querySelector("[data-bulk-delete]");
  const bulkStatus = document.querySelector("[data-bulk-status]");
  const conversationEmpty = document.querySelector("[data-conversation-empty]");
  const conversationContent = document.querySelector("[data-conversation-content]");
  const threadPseudo = document.querySelector("[data-thread-pseudo]");
  const threadHostCrown = document.querySelector("[data-thread-host-crown]");
  const threadStatus = document.querySelector("[data-thread-status]");
  const threadSubject = document.querySelector("[data-thread-subject]");
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
  let queuedConversationsLoad = null;
  let conversationsCursor = "";
  let conversationsHasMore = false;
  let activeMailFilter = "all";
  let activeSubjectFilter = "";
  const selectedConversationIds = new Set();
  const conversationRecords = new Map();
  let currentConversationId = "";
  let currentConversationStatus = "";
  let selectedConversationLoading = false;
  let adminPollTimer = 0;
  let activeAdminTab = "settings";
  let hostSessionActive = false;
  let membersLoading = false;
  let membersLoaded = false;
  let membersCursor = "";
  let membersHasMore = false;
  const memberRecords = new Map();

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
    hostSessionActive = false;
    if (adminPollTimer) window.clearInterval(adminPollTimer);
    adminPollTimer = 0;
    queuedConversationsLoad = null;
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
    sender.textContent = typeof message.pseudo === "string" && message.pseudo.trim() ? message.pseudo : "Membre inconnu";

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

  const formatMemberDate = (value) => {
    const date = typeof value === "string" ? new Date(value) : null;
    if (!date || !Number.isFinite(date.getTime())) return "Membre pionnier";
    return new Intl.DateTimeFormat("fr-FR", {
      dateStyle: "medium",
      timeZone: "Europe/Paris",
    }).format(date);
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

  const createMemberAvatar = () => {
    const avatar = document.createElement("span");
    avatar.className = "member-default-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.innerHTML = '<svg viewBox="0 0 40 40" fill="none"><circle cx="20" cy="20" r="19"/><circle cx="20" cy="15" r="6"/><path d="M8.5 33.5c1.7-6.2 5.8-9.3 11.5-9.3s9.8 3.1 11.5 9.3"/></svg>';
    return avatar;
  };

  const memberSignature = (member) => JSON.stringify([
    member.pseudo, member.role, member.status, member.createdAt, member.conversationId,
  ]);

  const createMemberItem = (member) => {
    memberRecords.set(member.id, member);
    const row = document.createElement("article");
    row.className = "member-row";
    row.dataset.memberId = member.id;
    row.dataset.memberSignature = memberSignature(member);

    const identity = document.createElement("div");
    identity.className = "member-row-identity";
    identity.append(createMemberAvatar());
    const copy = document.createElement("div");
    copy.className = "member-row-copy";
    const nameLine = document.createElement("div");
    nameLine.className = "member-row-name-line";
    const pseudo = document.createElement("strong");
    pseudo.className = "member-row-pseudo";
    pseudo.textContent = member.pseudo || "Membre";
    nameLine.append(pseudo);
    if (member.role === "host") {
      nameLine.append(createHostCrownBadge("member-row-crown"));
      const hostBadge = document.createElement("span");
      hostBadge.className = "member-host-badge";
      hostBadge.textContent = "Hôte";
      nameLine.append(hostBadge);
    }
    if (member.status === "banned") {
      const bannedBadge = document.createElement("span");
      bannedBadge.className = "member-banned-badge";
      bannedBadge.textContent = "Banni";
      nameLine.append(bannedBadge);
    }
    const joined = document.createElement("span");
    joined.className = "member-row-date";
    joined.textContent = formatMemberDate(member.createdAt);
    copy.append(nameLine, joined);
    identity.append(copy);

    const actions = document.createElement("div");
    actions.className = "member-row-actions";
    const viewButton = document.createElement("button");
    viewButton.className = "member-action-button member-action-button--view";
    viewButton.type = "button";
    viewButton.textContent = "Voir la conversation";
    viewButton.disabled = !member.conversationId;
    viewButton.addEventListener("click", () => {
      if (!member.conversationId) return;
      setAdminTab("conversations");
      void selectConversation(member.conversationId, { scroll: true });
    });

    const roleButton = document.createElement("button");
    roleButton.className = "member-action-button";
    roleButton.type = "button";
    roleButton.textContent = member.role === "host" ? "Retirer Hôte" : "Nommer Hôte";
    roleButton.addEventListener("click", () => void changeMemberRole(member, roleButton));

    const banButton = document.createElement("button");
    banButton.className = "member-action-button member-action-button--danger";
    banButton.type = "button";
    banButton.textContent = member.status === "banned" ? "Réactiver" : "Bannir";
    banButton.disabled = member.role === "host";
    banButton.title = member.role === "host" ? "Retire d’abord le rôle Hôte" : "";
    banButton.addEventListener("click", () => void changeMemberBan(member, banButton));

    const deleteButton = document.createElement("button");
    deleteButton.className = "member-action-button member-action-button--delete";
    deleteButton.type = "button";
    deleteButton.textContent = "Supprimer";
    deleteButton.disabled = member.role === "host";
    deleteButton.title = member.role === "host" ? "Retire d’abord le rôle Hôte" : "";
    deleteButton.addEventListener("click", () => void removeMember(member, deleteButton));

    actions.append(viewButton, roleButton, banButton, deleteButton);
    row.append(identity, actions);
    return row;
  };

  const sortMemberRows = () => {
    if (!membersList) return;
    const rows = [...membersList.querySelectorAll(".member-row")];
    rows.sort((left, right) => {
      const leftMember = memberRecords.get(left.dataset.memberId);
      const rightMember = memberRecords.get(right.dataset.memberId);
      const leftDate = leftMember?.createdAt ? Date.parse(leftMember.createdAt) : 0;
      const rightDate = rightMember?.createdAt ? Date.parse(rightMember.createdAt) : 0;
      return rightDate - leftDate || (leftMember?.pseudo || "").localeCompare(rightMember?.pseudo || "");
    });
    rows.forEach((row) => membersList.append(row));
  };

  const upsertMemberItem = (member, { deferSort = false } = {}) => {
    if (!member || typeof member.id !== "string" || !membersList) return false;
    memberRecords.set(member.id, member);
    const existing = [...membersList.querySelectorAll(".member-row")]
      .find((row) => row.dataset.memberId === member.id);
    let changed = false;
    if (existing) {
      if (existing.dataset.memberSignature !== memberSignature(member)) {
        existing.replaceWith(createMemberItem(member));
        changed = true;
      }
    } else {
      membersList.append(createMemberItem(member));
      changed = true;
    }
    if (changed && !deferSort) sortMemberRows();
    return changed;
  };

  const loadMembers = async ({ reset = false, quiet = false } = {}) => {
    if (!membersList || membersLoading) return;
    const requestedCursor = reset || quiet ? "" : membersCursor;
    membersLoading = true;
    if (membersRefreshButton) membersRefreshButton.disabled = true;
    if (membersMoreButton) membersMoreButton.disabled = true;
    if (!quiet) setStatus(membersStatus, "Chargement des membres…");
    try {
      const url = new URL("/api/admin-members", window.location.origin);
      if (requestedCursor) url.searchParams.set("cursor", requestedCursor);
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
        if (!quiet) setStatus(membersStatus, data.error || "Les membres n’ont pas pu être chargés.", "error");
        return;
      }
      const validMember = (member) => member && typeof member === "object" &&
        typeof member.id === "string" && /^[0-9a-f-]{36}$/iu.test(member.id) &&
        typeof member.pseudo === "string" && member.pseudo.trim().length > 0 &&
        ["member", "host"].includes(member.role) && ["active", "banned"].includes(member.status);
      if (!Array.isArray(data.members) || !data.members.every(validMember) ||
          (data.cursor !== null && data.cursor !== undefined && typeof data.cursor !== "string") ||
          typeof data.hasMore !== "boolean") {
        if (!quiet) setStatus(membersStatus, "La réponse des membres est invalide. Les données affichées ont été conservées.", "error");
        return;
      }
      const members = data.members;
      if (quiet && members.length === 0) return;

      const nextCursor = typeof data.cursor === "string" ? data.cursor : "";
      const nextHasMore = data.hasMore === true && Boolean(nextCursor);
      if (reset && !quiet && members.length === 0) {
        membersList.replaceChildren();
        memberRecords.clear();
      } else {
        if (reset && !quiet && !nextHasMore) {
          const currentIds = new Set(members.map((member) => member.id));
          for (const id of memberRecords.keys()) {
            if (currentIds.has(id)) continue;
            memberRecords.delete(id);
            [...membersList.querySelectorAll(".member-row")]
              .find((row) => row.dataset.memberId === id)
              ?.remove();
          }
        }
        let listChanged = false;
        members.forEach((member) => {
          if (upsertMemberItem(member, { deferSort: true })) listChanged = true;
        });
        if (listChanged) sortMemberRows();
      }
      membersLoaded = true;
      membersCursor = nextCursor;
      membersHasMore = nextHasMore;
      if (membersMoreButton) membersMoreButton.hidden = !membersHasMore;
      const count = membersList.querySelectorAll(".member-row").length;
      if (!quiet) {
        setStatus(membersStatus, count ? `${count} membre${count > 1 ? "s" : ""} affiché${count > 1 ? "s" : ""}.` : "Aucun compte membre pour le moment.");
      }
    } catch {
      if (!quiet) setStatus(membersStatus, "Impossible de joindre le serveur. Réessaie.", "error");
    } finally {
      membersLoading = false;
      if (membersRefreshButton) membersRefreshButton.disabled = false;
      if (membersMoreButton) membersMoreButton.disabled = false;
    }
  };

  const performMemberPatch = async (member, action, button) => {
    if (!member || !button || button.disabled) return;
    button.disabled = true;
    try {
      const response = await fetch("/api/admin-members", {
        method: "PATCH",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ id: member.id, ...action }),
      });
      const data = await readJson(response);
      if (response.status === 401) {
        showLogin("Ta session a expiré. Saisis de nouveau le code d’accès.");
        return false;
      }
      if (!response.ok || data.ok !== true) {
        setStatus(membersStatus, data.error || "L’action sur ce membre a échoué.", "error");
        return false;
      }
      if (data.member) upsertMemberItem(data.member);
      await loadMembers({ reset: true, quiet: true });
      if (member.conversationId && member.conversationId === currentConversationId) {
        await loadSelectedConversation({ quiet: true });
      }
      await loadConversations({ reset: true, quiet: true, skipSelected: true });
      setStatus(membersStatus, "Modification du membre enregistrée.");
      return true;
    } catch {
      setStatus(membersStatus, "Impossible de joindre le serveur. Réessaie.", "error");
      return false;
    } finally {
      button.disabled = false;
    }
  };

  const changeMemberRole = async (member, button) => {
    const nextRole = member.role === "host" ? "member" : "host";
    const confirmation = nextRole === "host"
      ? `Nommer ${member.pseudo} compte Hôte ? Ce choix remplacera l’unique compte Hôte actuel, s’il y en a un.`
      : `Retirer le rôle Hôte de ${member.pseudo} ?`;
    if (!window.confirm(confirmation)) return;
    await performMemberPatch(member, { role: nextRole }, button);
  };

  const changeMemberBan = async (member, button) => {
    const banned = member.status !== "banned";
    const confirmation = banned
      ? `Bannir le compte de ${member.pseudo} ? Ses conversations et ses vocaux seront conservés.`
      : `Réactiver le compte de ${member.pseudo} ?`;
    if (!window.confirm(confirmation)) return;
    await performMemberPatch(member, { banned }, button);
  };

  const removeMember = async (member, button) => {
    if (!window.confirm(`Supprimer le compte de ${member.pseudo} ? Ses conversations et ses vocaux resteront conservés.`)) return;
    button.disabled = true;
    try {
      const response = await fetch("/api/admin-members", {
        method: "DELETE",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ id: member.id }),
      });
      const data = await readJson(response);
      if (response.status === 401) {
        showLogin("Ta session a expiré. Saisis de nouveau le code d’accès.");
        return;
      }
      if (!response.ok || data.deleted !== true) {
        setStatus(membersStatus, data.error || "Le compte n’a pas pu être supprimé.", "error");
        return;
      }
      memberRecords.delete(member.id);
      [...(membersList?.querySelectorAll(".member-row") || [])]
        .find((row) => row.dataset.memberId === member.id)
        ?.remove();
      await loadMembers({ reset: true, quiet: true });
      setStatus(membersStatus, "Compte supprimé. La conversation et les vocaux ont été conservés.");
    } catch {
      setStatus(membersStatus, "Impossible de joindre le serveur. Réessaie.", "error");
    } finally {
      button.disabled = false;
    }
  };

  const setAdminTab = (tabName, { focus = false } = {}) => {
    const validTab = ["settings", "members", "conversations"].includes(tabName) ? tabName : "settings";
    activeAdminTab = validTab;
    const tabTitles = { settings: "Tes réglages", members: "👥 Membres", conversations: "Discussions privées" };
    adminTabs.forEach((tab) => {
      const selected = tab.dataset.adminTab === validTab;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      if (focus && selected) tab.focus();
    });
    adminTabPanels.forEach((panel) => {
      panel.hidden = panel.dataset.adminTabPanel !== validTab;
    });
    if (adminTitle) adminTitle.textContent = tabTitles[validTab];
    if (validTab === "members" && !adminPanel.hidden && !membersLoaded) {
      void loadMembers({ reset: true, quiet: false });
    }
    if (validTab === "conversations" && !adminPanel.hidden && !conversationsList?.childElementCount) {
      void loadConversations({ reset: true, quiet: true });
    }
  };

  adminTabs.forEach((tab, index) => {
    tab.addEventListener("click", () => setAdminTab(tab.dataset.adminTab));
    tab.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? adminTabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : adminTabs.length - 1)) % adminTabs.length;
      setAdminTab(adminTabs[nextIndex]?.dataset.adminTab, { focus: true });
    });
  });
  membersRefreshButton?.addEventListener("click", () => void loadMembers({ reset: true }));
  membersMoreButton?.addEventListener("click", () => void loadMembers());

  const statusLabel = (status) => {
    if (status === "blocked") return "Bloquée";
    if (status === "closed") return "Fermée";
    return "Ouverte";
  };

  const visibleConversationIds = () => [...(conversationsList?.querySelectorAll(".conversation-list-item") || [])]
    .map((item) => item.dataset.conversationId)
    .filter(Boolean);

  const updateBulkToolbar = () => {
    const ids = [...selectedConversationIds];
    const selected = ids.map((id) => conversationRecords.get(id)).filter(Boolean);
    if (bulkToolbar) bulkToolbar.hidden = ids.length === 0;
    if (selectionCount) selectionCount.textContent = `${ids.length} sélectionnée${ids.length > 1 ? "s" : ""}`;

    const allFavorite = selected.length > 0 && selected.every((conversation) => conversation.favorite === true);
    const allRead = selected.length > 0 && selected.every((conversation) => conversation.adminUnread !== true);
    if (bulkFavoriteButton) bulkFavoriteButton.textContent = allFavorite ? "☆ Retirer des favoris" : "⭐ Mettre en favoris";
    if (bulkReadButton) bulkReadButton.textContent = allRead ? "Marquer comme non lu" : "Marquer comme lu";
    if (bulkCloseButton) bulkCloseButton.disabled = !selected.some((conversation) => conversation.status === "open");

    const visibleIds = visibleConversationIds();
    const visibleSelected = visibleIds.filter((id) => selectedConversationIds.has(id)).length;
    if (selectAllConversations) {
      selectAllConversations.disabled = visibleIds.length === 0;
      selectAllConversations.checked = visibleIds.length > 0 && visibleSelected === visibleIds.length;
      selectAllConversations.indeterminate = visibleSelected > 0 && visibleSelected < visibleIds.length;
    }
  };

  const updateConversationSelection = () => {
    conversationsList?.querySelectorAll(".conversation-list-item").forEach((item) => {
      const id = item.dataset.conversationId;
      const selected = selectedConversationIds.has(id);
      const checkbox = item.querySelector("[data-select-conversation]");
      const openButton = item.querySelector("[data-open-conversation]");
      if (checkbox) checkbox.checked = selected;
      if (openButton) openButton.setAttribute("aria-current", String(id === currentConversationId));
      item.classList.toggle("is-selected", selected);
      item.classList.toggle("is-current", id === currentConversationId);
    });
    if (conversationPageCount) {
      const visibleCount = conversationsList?.querySelectorAll(".conversation-list-item").length || 0;
      conversationPageCount.textContent = visibleCount ? `${visibleCount} affichée${visibleCount > 1 ? "s" : ""}` : "";
    }
    updateBulkToolbar();
  };

  const conversationRowSignature = (conversation) => JSON.stringify([
    conversation.pseudo,
    conversation.subject,
    conversation.status,
    conversation.updatedAt,
    conversation.lastMessagePreview,
    conversation.lastMessageSender,
    conversation.lastMessagePseudo,
    conversation.adminUnread,
    conversation.favorite,
    conversation.hasAudio,
    conversation.isHost,
  ]);

  const createConversationListItem = (conversation) => {
    conversationRecords.set(conversation.id, conversation);
    const item = document.createElement("article");
    item.className = "conversation-list-item";
    item.dataset.conversationId = conversation.id;
    item.dataset.recordSignature = conversationRowSignature(conversation);

    const checkbox = document.createElement("input");
    checkbox.className = "conversation-list-checkbox";
    checkbox.type = "checkbox";
    checkbox.dataset.selectConversation = "";
    checkbox.checked = selectedConversationIds.has(conversation.id);
    checkbox.setAttribute("aria-label", `Sélectionner la discussion de ${conversation.pseudo || "Membre"}`);
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedConversationIds.add(conversation.id);
      else selectedConversationIds.delete(conversation.id);
      updateConversationSelection();
    });

    const favorite = document.createElement("button");
    favorite.className = "conversation-list-star";
    favorite.type = "button";
    favorite.dataset.favorite = String(conversation.favorite === true);
    favorite.setAttribute("aria-pressed", String(conversation.favorite === true));
    favorite.setAttribute("aria-label", conversation.favorite
      ? `Retirer ${conversation.pseudo || "Membre"} des favoris`
      : `Ajouter ${conversation.pseudo || "Membre"} aux favoris`);
    favorite.title = conversation.favorite ? "Retirer des favoris" : "Ajouter aux favoris";
    favorite.textContent = conversation.favorite ? "★" : "☆";
    favorite.addEventListener("click", () => void toggleConversationFavorite(conversation.id));

    const openButton = document.createElement("button");
    openButton.className = "conversation-list-open";
    openButton.type = "button";
    openButton.dataset.openConversation = "";
    openButton.setAttribute("aria-current", String(conversation.id === currentConversationId));

    const head = document.createElement("span");
    head.className = "conversation-list-head";

    const pseudo = document.createElement("strong");
    pseudo.className = "conversation-list-pseudo";
    pseudo.textContent = typeof conversation.pseudo === "string" && conversation.pseudo.trim()
      ? conversation.pseudo
      : "Membre";

    const subject = document.createElement("span");
    subject.className = "conversation-list-subject";
    subject.textContent = typeof conversation.subject === "string" ? conversation.subject : "💬 Discussion";

    const unread = document.createElement("span");
    unread.className = "conversation-list-unread";
    unread.textContent = "Non lu";
    unread.hidden = conversation.adminUnread !== true;

    const status = document.createElement("span");
    status.className = "conversation-list-status";
    status.dataset.state = conversation.status;
    status.textContent = statusLabel(conversation.status);
    head.append(pseudo);
    if (conversation.isHost) {
      head.append(createHostCrownBadge("conversation-list-host-crown"));
    }
    head.append(subject, unread, status);

    const preview = document.createElement("span");
    preview.className = "conversation-list-preview";
    const previewText = typeof conversation.lastMessagePreview === "string" ? conversation.lastMessagePreview : "";
    const senderPseudo = typeof conversation.lastMessagePseudo === "string" && conversation.lastMessagePseudo.trim()
      ? conversation.lastMessagePseudo
      : conversation.lastMessageSender === "gionny" ? "Gionny" : conversation.pseudo || "Membre";
    preview.textContent = `${senderPseudo} : ${previewText}`;

    const date = document.createElement("time");
    date.className = "conversation-list-date";
    date.dateTime = conversation.updatedAt;
    date.textContent = formatInboxTime(conversation.updatedAt);

    openButton.append(head, preview, date);
    openButton.addEventListener("click", () => selectConversation(conversation.id, { scroll: true }));
    item.append(checkbox, favorite, openButton);
    return item;
  };

  const conversationMatchesCurrentFilters = (conversation) => {
    if (activeSubjectFilter && conversation.subject !== activeSubjectFilter) return false;
    if (activeMailFilter === "unread" && conversation.adminUnread !== true) return false;
    if (activeMailFilter === "favorites" && conversation.favorite !== true) return false;
    if (activeMailFilter === "audio" && conversation.hasAudio !== true) return false;
    return true;
  };

  const sortConversationListRows = () => {
    if (!conversationsList) return;
    const rows = [...conversationsList.querySelectorAll(".conversation-list-item")];
    rows.sort((left, right) => {
      const leftConversation = conversationRecords.get(left.dataset.conversationId);
      const rightConversation = conversationRecords.get(right.dataset.conversationId);
      return Date.parse(rightConversation?.updatedAt || "") - Date.parse(leftConversation?.updatedAt || "");
    });
    rows.forEach((row) => conversationsList.append(row));
  };

  const upsertConversationListItem = (conversation, { deferRender = false } = {}) => {
    if (!conversation || typeof conversation.id !== "string" || !conversationsList) return false;
    conversationRecords.set(conversation.id, conversation);
    const existing = [...conversationsList.querySelectorAll(".conversation-list-item")]
      .find((item) => item.dataset.conversationId === conversation.id);
    let changed = false;
    if (!conversationMatchesCurrentFilters(conversation)) {
      selectedConversationIds.delete(conversation.id);
      if (existing) {
        existing.remove();
        changed = true;
      }
    } else if (!existing) {
      conversationsList.append(createConversationListItem(conversation));
      changed = true;
    } else if (existing.dataset.recordSignature !== conversationRowSignature(conversation)) {
      existing.replaceWith(createConversationListItem(conversation));
      changed = true;
    }
    if (changed && !deferRender) {
      sortConversationListRows();
      updateConversationSelection();
    }
    return changed;
  };

  const updateConversationRow = (conversation) => upsertConversationListItem(conversation);

  const loadConversations = async ({ reset = false, quiet = false, skipSelected = false } = {}) => {
    if (!conversationsList) return;
    if (conversationsLoading) {
      if (quiet && !reset) return;
      queuedConversationsLoad = queuedConversationsLoad
        ? { reset: queuedConversationsLoad.reset || reset, quiet: queuedConversationsLoad.quiet && quiet, skipSelected: queuedConversationsLoad.skipSelected && skipSelected }
        : { reset, quiet, skipSelected };
      return;
    }

    const requestedFilter = activeMailFilter;
    const requestedSubject = activeSubjectFilter;
    const requestedCursor = reset || quiet ? "" : conversationsCursor;
    conversationsLoading = true;
    if (inboxRefreshButton) inboxRefreshButton.disabled = true;
    if (conversationsMoreButton) conversationsMoreButton.disabled = true;
    if (!quiet) setStatus(conversationsStatus, "Chargement des discussions…");

    try {
      const url = new URL("/api/admin-messages", window.location.origin);
      url.searchParams.set("view", "conversations");
      if (requestedCursor) url.searchParams.set("cursor", requestedCursor);
      url.searchParams.set("filter", requestedFilter);
      if (requestedSubject) url.searchParams.set("subject", requestedSubject);
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
      if (requestedFilter !== activeMailFilter || requestedSubject !== activeSubjectFilter) return;

      const validConversation = (conversation) => conversation && typeof conversation === "object" &&
        typeof conversation.id === "string" && /^[0-9a-f-]{36}$/iu.test(conversation.id) &&
        typeof conversation.pseudo === "string" && conversation.pseudo.trim().length > 0 &&
        typeof conversation.updatedAt === "string" && Number.isFinite(Date.parse(conversation.updatedAt)) &&
        ["open", "closed", "blocked"].includes(conversation.status) &&
        typeof conversation.lastMessagePreview === "string" &&
        ["visitor", "gionny"].includes(conversation.lastMessageSender) &&
        typeof conversation.adminUnread === "boolean" && typeof conversation.favorite === "boolean" &&
        typeof conversation.hasAudio === "boolean" && typeof conversation.isHost === "boolean";
      if (!Array.isArray(data.conversations) || !data.conversations.every(validConversation) ||
          (data.cursor !== null && data.cursor !== undefined && typeof data.cursor !== "string") ||
          typeof data.hasMore !== "boolean") {
        if (!quiet) setStatus(conversationsStatus, "La réponse des discussions est invalide. Les données affichées ont été conservées.", "error");
        return;
      }

      const items = data.conversations;
      if (quiet && items.length === 0) return;
      const nextCursor = typeof data.cursor === "string" ? data.cursor : "";
      const nextHasMore = data.hasMore === true && Boolean(nextCursor);

      // A completed explicit refresh can reconcile the visible page, but only
      // after a valid response arrives. Quiet polling only upserts non-empty data.
      if (reset && !quiet) {
        const responseIds = new Set(items.map((conversation) => conversation.id));
        [...(conversationsList.querySelectorAll(".conversation-list-item") || [])].forEach((row) => {
          if (!responseIds.has(row.dataset.conversationId)) row.remove();
        });
      }
      let listChanged = false;
      items.forEach((conversation) => {
        if (upsertConversationListItem(conversation, { deferRender: true })) listChanged = true;
      });
      if (listChanged) {
        sortConversationListRows();
        updateConversationSelection();
      }
      conversationsCursor = nextCursor;
      conversationsHasMore = nextHasMore;
      if (conversationsMoreButton) conversationsMoreButton.hidden = !conversationsHasMore;

      const count = conversationsList.querySelectorAll(".conversation-list-item").length;
      if (conversationPageCount) conversationPageCount.textContent = count ? `${count} affichée${count > 1 ? "s" : ""}` : "";
      const emptyMessage = requestedFilter !== "all" || requestedSubject
        ? "Aucune discussion ne correspond à ces filtres."
        : "Aucune discussion pour le moment.";
      if (!quiet) {
        setStatus(
          conversationsStatus,
          count ? `${count} discussion${count > 1 ? "s" : ""} affichée${count > 1 ? "s" : ""}.` : emptyMessage
        );
      }
      updateConversationSelection();

      if (!currentConversationId && items[0]) {
        await selectConversation(items[0].id, { markRead: false });
      } else if (currentConversationId && !skipSelected) {
        void loadSelectedConversation({ quiet: true });
      }
    } catch {
      if (!quiet) setStatus(conversationsStatus, "Impossible de joindre le serveur. Réessaie.", "error");
    } finally {
      conversationsLoading = false;
      if (inboxRefreshButton) inboxRefreshButton.disabled = false;
      if (conversationsMoreButton) conversationsMoreButton.disabled = false;
      if (queuedConversationsLoad) {
        const nextLoad = queuedConversationsLoad;
        queuedConversationsLoad = null;
        void loadConversations(nextLoad);
      }
    }
  };

  const createThreadMessage = (message) => {
    const item = document.createElement("article");
    const sender = message.sender === "gionny" ? "gionny" : "visitor";
    item.className = `thread-message thread-message--${sender}`;

    const ownerConversation = conversationRecords.get(currentConversationId);
    const senderPseudo = typeof message.pseudo === "string" && message.pseudo.trim()
      ? message.pseudo
      : sender === "gionny" ? "Gionny" : ownerConversation?.pseudo || "Membre";
    const isHostMessage = message.isHost === true || sender === "gionny";
    const name = document.createElement("span");
    name.className = "thread-message-sender";
    name.textContent = senderPseudo;
    if (isHostMessage) {
      name.append(createHostCrownBadge("thread-message-host-crown"));
    }

    let content;
    if (message.kind === "audio" || message.hasAudio) {
      const audioUrl = `/api/contact-audio?conversationId=${encodeURIComponent(currentConversationId)}&messageId=${encodeURIComponent(message.id)}`;
      content = typeof window.createQGVoicePlayer === "function"
        ? window.createQGVoicePlayer(audioUrl, `Message vocal de ${senderPseudo}`)
        : document.createElement("p");
      if (content.tagName === "P") content.textContent = "Le lecteur vocal est indisponible.";
      content.classList.add("thread-message-audio");
    } else {
      content = document.createElement("p");
      content.className = "thread-message-text";
      content.textContent = typeof message.text === "string" ? message.text : "";
    }

    const date = document.createElement("time");
    date.className = "thread-message-date";
    date.dateTime = message.createdAt;
    date.textContent = formatInboxTime(message.createdAt);

    item.append(name, content, date);
    return item;
  };

  const renderSelectedConversation = (data) => {
    const conversation = data.conversation;
    conversationRecords.set(conversation.id, conversation);
    currentConversationStatus = conversation.status;
    conversationEmpty.hidden = true;
    conversationContent.hidden = false;
    threadPseudo.textContent = conversation.pseudo || "Membre";
    if (threadHostCrown) threadHostCrown.hidden = conversation.isHost !== true;
    if (threadSubject) threadSubject.textContent = conversation.subject || "💬 Discussion";
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

    const messages = Array.isArray(data.messages) ? data.messages : [];
    const messageSignature = messages.map((message) =>
      `${message.id}:${message.kind || "text"}:${message.sender || ""}:${message.pseudo || ""}:${message.isHost === true}`
    ).join("|");
    if (threadMessages.dataset.messageSignature !== messageSignature) {
      const wasNearBottom = threadMessages.scrollHeight - threadMessages.scrollTop - threadMessages.clientHeight < 90;
      threadMessages.replaceChildren(...messages.map(createThreadMessage));
      threadMessages.dataset.messageSignature = messageSignature;
      if (wasNearBottom) threadMessages.scrollTop = threadMessages.scrollHeight;
    }
    updateConversationRow(conversation);
    updateConversationSelection();
  };

  const loadSelectedConversation = async ({ quiet = false } = {}) => {
    if (!currentConversationId || selectedConversationLoading) return null;
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
      if (requestedId === currentConversationId) {
        renderSelectedConversation(data);
        return data;
      }
    } catch {
      if (!quiet) setStatus(replyStatus, "Impossible de charger cette discussion.", "error");
    } finally {
      selectedConversationLoading = false;
      if (currentConversationId && currentConversationId !== requestedId) {
        void loadSelectedConversation({ quiet: true });
      }
    }
    return null;
  };

  const patchConversationMetadata = async (payload, { quiet = false } = {}) => {
    try {
      const response = await fetch("/api/admin-messages", {
        method: "PATCH",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(payload),
      });
      const data = await readJson(response);
      if (response.status === 401) {
        showLogin("Ta session a expiré. Saisis de nouveau le code d’accès.");
        return null;
      }
      if (!response.ok) {
        if (!quiet) setStatus(conversationsStatus, data.error || "La mise à jour n’a pas abouti.", "error");
        return null;
      }
      const updated = data.conversation ? [data.conversation] : Array.isArray(data.updated) ? data.updated : [];
      updated.forEach((conversation) => {
        conversationRecords.set(conversation.id, conversation);
        updateConversationRow(conversation);
      });
      return data;
    } catch {
      if (!quiet) setStatus(conversationsStatus, "Impossible de joindre le serveur. Réessaie.", "error");
      return null;
    }
  };

  const selectConversation = async (id, { scroll = false, markRead = true } = {}) => {
    if (!id) return;
    currentConversationId = id;
    setStatus(replyStatus, "");
    conversationEmpty.hidden = true;
    conversationContent.hidden = false;
    threadPseudo.textContent = "Chargement…";
    threadMessages.replaceChildren();
    updateConversationSelection();
    const shouldMarkRead = conversationRecords.get(id)?.adminUnread === true;
    const loaded = await loadSelectedConversation();
    if (markRead && (shouldMarkRead || loaded?.conversation?.adminUnread === true)) {
      const updated = await patchConversationMetadata({ conversationId: id, unread: false }, { quiet: true });
      if (updated) await loadConversations({ reset: true, quiet: true, skipSelected: true });
    }
    if (scroll && window.matchMedia("(max-width: 640px)").matches) {
      const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
      document.querySelector("[data-conversation-detail]")?.scrollIntoView({ behavior, block: "start" });
    }
  };

  const toggleConversationFavorite = async (conversationId) => {
    const conversation = conversationRecords.get(conversationId);
    if (!conversation) return;
    const result = await patchConversationMetadata({ conversationId, favorite: conversation.favorite !== true });
    if (!result?.conversation) return;
    setStatus(conversationsStatus, result.conversation.favorite ? "Ajoutée aux favoris." : "Retirée des favoris.");
  };

  const runBulkPatch = async (changes) => {
    const ids = [...selectedConversationIds];
    if (!ids.length) return;
    const actionLabel = typeof changes.favorite === "boolean"
      ? "Mise à jour des favoris…"
      : typeof changes.unread === "boolean"
        ? "Mise à jour du statut de lecture…"
        : "Fermeture des discussions…";
    setStatus(bulkStatus, actionLabel);
    [bulkFavoriteButton, bulkReadButton, bulkCloseButton, bulkDeleteButton].forEach((button) => {
      if (button) button.disabled = true;
    });

    const updated = [];
    const skipped = [];
    let failed = false;
    for (let index = 0; index < ids.length; index += 100) {
      const result = await patchConversationMetadata({ conversationIds: ids.slice(index, index + 100), ...changes }, { quiet: true });
      if (!result) {
        failed = true;
        break;
      }
      if (Array.isArray(result.updated)) updated.push(...result.updated);
      if (Array.isArray(result.skipped)) skipped.push(...result.skipped);
    }

    if (!failed) {
      selectedConversationIds.clear();
      updateConversationSelection();
      await loadConversations({ reset: true, quiet: true, skipSelected: true });
      if (changes.status && currentConversationId && updated.some((item) => item.id === currentConversationId)) {
        await loadSelectedConversation({ quiet: true });
      }
      const message = `${updated.length} discussion${updated.length > 1 ? "s" : ""} mise${updated.length > 1 ? "s" : ""} à jour${skipped.length ? ` · ${skipped.length} ignorée${skipped.length > 1 ? "s" : ""}` : ""}.`;
      setStatus(conversationsStatus, message, skipped.length ? "error" : "");
    } else {
      setStatus(conversationsStatus, "L’action groupée n’a pas abouti. Ta sélection est conservée pour réessayer.", "error");
    }

    [bulkFavoriteButton, bulkReadButton, bulkCloseButton, bulkDeleteButton].forEach((button) => {
      if (button) button.disabled = false;
    });
    updateBulkToolbar();
  };

  const deleteSelectedConversations = async () => {
    const ids = [...selectedConversationIds];
    if (!ids.length) return;
    if (!window.confirm(`Supprimer définitivement ${ids.length} discussion${ids.length > 1 ? "s" : ""} ? Tous les messages et vocaux associés seront supprimés.`)) return;

    setStatus(bulkStatus, "Suppression des discussions, messages et vocaux…");
    [bulkFavoriteButton, bulkReadButton, bulkCloseButton, bulkDeleteButton].forEach((button) => {
      if (button) button.disabled = true;
    });
    const deletedIds = [];
    const skippedIds = [];
    const failedIds = [];

    try {
      for (let index = 0; index < ids.length; index += 100) {
        const response = await fetch("/api/admin-messages", {
          method: "DELETE",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          credentials: "same-origin",
          cache: "no-store",
          body: JSON.stringify({ conversationIds: ids.slice(index, index + 100) }),
        });
        const data = await readJson(response);
        if (response.status === 401) {
          showLogin("Ta session a expiré. Saisis de nouveau le code d’accès.");
          return;
        }
        if (!response.ok) throw new Error(data.error || "La suppression groupée a échoué.");
        deletedIds.push(...(Array.isArray(data.deletedIds) ? data.deletedIds : []));
        skippedIds.push(...(Array.isArray(data.skippedIds) ? data.skippedIds : []));
        failedIds.push(...(Array.isArray(data.failedIds) ? data.failedIds : []));
      }

      [...deletedIds, ...skippedIds].forEach((id) => {
        selectedConversationIds.delete(id);
        conversationRecords.delete(id);
        [...(conversationsList?.querySelectorAll(".conversation-list-item") || [])]
          .find((item) => item.dataset.conversationId === id)
          ?.remove();
      });
      if (currentConversationId && deletedIds.includes(currentConversationId)) {
        currentConversationId = "";
        currentConversationStatus = "";
        conversationContent.hidden = true;
        conversationEmpty.hidden = false;
      }
      updateConversationSelection();
      await loadConversations({ reset: true, quiet: true, skipSelected: true });
      const deletionSummary = deletedIds.length
        ? `${deletedIds.length} discussion${deletedIds.length > 1 ? "s" : ""} supprimée${deletedIds.length > 1 ? "s" : ""}. Messages et vocaux associés purgés.`
        : "Aucune discussion n’a été supprimée.";
      const remainingSummary = failedIds.length
        ? ` ${failedIds.length} échec${failedIds.length > 1 ? "s" : ""} à réessayer.`
        : skippedIds.length
          ? ` ${skippedIds.length} discussion${skippedIds.length > 1 ? "s" : ""} introuvable${skippedIds.length > 1 ? "s" : ""}.`
          : "";
      setStatus(conversationsStatus, deletionSummary + remainingSummary, failedIds.length ? "error" : "");
    } catch (error) {
      setStatus(conversationsStatus, error instanceof Error ? error.message : "La suppression groupée a échoué.", "error");
    } finally {
      [bulkFavoriteButton, bulkReadButton, bulkCloseButton, bulkDeleteButton].forEach((button) => {
        if (button) button.disabled = false;
      });
      updateBulkToolbar();
    }
  };

  const changeConversationStatus = async (status) => {
    if (!currentConversationId) return;
    const conversationId = currentConversationId;
    if (status === "blocked" && !window.confirm("Bloquer cette discussion ? Le pseudo n’est pas une identité vérifiée.")) return;

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

  mailFilterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const filter = button.dataset.mailFilter;
      if (!["all", "unread", "favorites", "audio"].includes(filter) || filter === activeMailFilter) return;
      activeMailFilter = filter;
      mailFilterButtons.forEach((tab) => {
        tab.setAttribute("aria-pressed", String(tab === button));
      });
      selectedConversationIds.clear();
      updateConversationSelection();
      void loadConversations({ reset: true });
    });
  });

  conversationSubjectFilter?.addEventListener("change", () => {
    activeSubjectFilter = conversationSubjectFilter.value;
    selectedConversationIds.clear();
    updateConversationSelection();
    void loadConversations({ reset: true });
  });

  selectAllConversations?.addEventListener("change", () => {
    const ids = visibleConversationIds();
    if (selectAllConversations.checked) ids.forEach((id) => selectedConversationIds.add(id));
    else ids.forEach((id) => selectedConversationIds.delete(id));
    updateConversationSelection();
  });

  bulkFavoriteButton?.addEventListener("click", () => {
    const selected = [...selectedConversationIds].map((id) => conversationRecords.get(id)).filter(Boolean);
    const allFavorite = selected.length > 0 && selected.every((conversation) => conversation.favorite === true);
    void runBulkPatch({ favorite: !allFavorite });
  });
  bulkReadButton?.addEventListener("click", () => {
    const selected = [...selectedConversationIds].map((id) => conversationRecords.get(id)).filter(Boolean);
    const allRead = selected.length > 0 && selected.every((conversation) => conversation.adminUnread !== true);
    void runBulkPatch({ unread: allRead });
  });
  bulkCloseButton?.addEventListener("click", () => void runBulkPatch({ status: "closed" }));
  bulkDeleteButton?.addEventListener("click", () => void deleteSelectedConversations());

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
      void loadConversations({ quiet: true });
      if (activeAdminTab === "members") void loadMembers({ quiet: true });
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
    setAdminTab(activeAdminTab);
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
      hostSessionActive = data.hostAuthenticated === true;
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
      const response = await fetch("/api/admin-auth", {
        method: "DELETE",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
      });
      const data = await readJson(response);
      hostSessionActive = data.hostAuthenticated === true;
    } catch {
      // Hiding the admin screen is still useful if the network is unavailable.
    } finally {
      logoutButton.disabled = false;
      if (hostSessionActive) window.location.assign("/");
      else showLogin();
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
      hostSessionActive = data.hostAuthenticated === true;
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
