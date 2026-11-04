(() => {
  "use strict";

  // -------------------------------------------------------------------------
  // ÉTAPE 7 · Messagerie multi-DM (style X)
  // -------------------------------------------------------------------------
  // Boîte de réception + Demandes, discussion officielle épinglée, groupes,
  // envoi de texte / image / note vocale. Tout passe par /api/messages.
  // Le tiroir « conversation avec Gionny » (script.js) reste intact : cette
  // couche ne fait que la boîte de réception et l'ouverture d'un fil.
  // -------------------------------------------------------------------------

  const root = document.querySelector('[data-x-view="messages"]');
  if (!root) return;

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

  const listNode = $("[data-x-dm-list]", root);
  const emptyNode = $("[data-x-dm-empty]", root);
  const statusNode = $("[data-x-dm-status]", root);
  const tabNodes = $$("[data-x-dm-tab]", root);
  const requestsCount = $("[data-x-dm-requests-count]", root);
  const composeNode = $("[data-x-dm-compose]", root);
  const composeStatus = $("[data-x-dm-compose-status]", root);
  const composePeople = $("[data-x-dm-people]", root);
  const composeSubmit = $("[data-x-dm-compose-submit]", root);
  const groupTitleInput = $("[data-x-dm-group-title]", root);
  const searchInput = $("[data-x-dm-search]", root);
  const conversationNode = $("[data-x-dm-conversation]", root);
  const conversationTitle = $("[data-x-dm-conversation-title]", root);
  const conversationSubtitle = $("[data-x-dm-conversation-subtitle]", root);
  const conversationAvatar = $("[data-x-dm-conversation-avatar]", root);
  const conversationMessages = $("[data-x-dm-messages]", root);
  const conversationStatus = $("[data-x-dm-conversation-status]", root);
  const conversationForm = $("[data-x-dm-form]", root);
  const conversationInput = $("[data-x-dm-input]", root);
  const conversationImage = $("[data-x-dm-image]", root);
  const newThreadButton = $("[data-x-new-thread]");
  const legacyDmRow = $(".x-dm-thread");

  const COPY = {
    inbox: "Boîte de réception",
    requests: "Demandes",
    empty: "Aucune discussion pour le moment.",
    emptyRequests: "Aucune demande de message.",
    loading: "Chargement des messages…",
    offline: "Impossible de joindre la messagerie. Réessaie.",
    locked: "Réservé aux membres Validés ✓.",
  };

  const state = {
    viewer: "",
    tab: "inbox",
    data: null,
    contacts: [],
    selected: new Map(),
    activeThread: null,
    activeMessages: [],
    pollTimer: 0,
    loading: false,
  };

  const isSignedIn = () => {
    const identity = document.querySelector("[data-member-identity]");
    const logged = document.querySelector("[data-member-logged-in]");
    return Boolean((identity && !identity.hidden) || (logged && !logged.hidden));
  };

  const setStatus = (node, message) => {
    if (!node) return;
    node.textContent = message || "";
    node.hidden = !message;
  };

  const initials = (name) => (String(name || "?").trim().charAt(0) || "?").toLocaleUpperCase("fr-FR");

  const timeLabel = (value) => {
    const date = new Date(value || 0);
    if (!Number.isFinite(date.getTime())) return "";
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    if (sameDay) return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
  };

  const request = async (path, options = {}) => {
    const response = await fetch(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  };

  // -------------------------------------------------------------------------
  // Boîte de réception
  // -------------------------------------------------------------------------

  const avatarNode = (entry, extraClass = "") => {
    const holder = document.createElement("span");
    holder.className = `x-dm-row-avatar ${extraClass}`.trim();
    if (entry?.avatarData) {
      const image = document.createElement("img");
      image.src = entry.avatarData;
      image.alt = "";
      holder.append(image);
    } else if (entry?.official) {
      const image = document.createElement("img");
      image.src = "/assets/gionny-profile.jpg";
      image.alt = "";
      holder.append(image);
    } else {
      holder.textContent = initials(entry?.title);
      holder.dataset.fallback = "true";
    }
    return holder;
  };

  const createRow = (entry) => {
    const row = document.createElement("div");
    row.className = "x-dm-row";
    row.dataset.threadId = entry.id;
    row.dataset.unread = String(entry.unread > 0);
    row.setAttribute("role", "listitem");

    const open = document.createElement("button");
    open.type = "button";
    open.className = "x-dm-row-open";
    open.setAttribute("aria-label", `Ouvrir la discussion avec ${entry.title}`);
    open.append(avatarNode(entry));

    const copy = document.createElement("span");
    copy.className = "x-dm-row-copy";
    const nameLine = document.createElement("span");
    nameLine.className = "x-dm-row-name";
    const name = document.createElement("strong");
    name.textContent = entry.title;
    nameLine.append(name);
    if (entry.kind === "group") {
      const badge = document.createElement("span");
      badge.className = "x-dm-row-tag";
      badge.textContent = "Groupe";
      nameLine.append(badge);
    } else {
      const other = entry.participants.find((person) => person.pseudo !== state.viewer);
      if (other?.isHost) {
        const crown = document.createElement("span");
        crown.className = "x-dm-row-crown";
        crown.setAttribute("aria-label", "Compte Hôte");
        crown.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#qg-crown-symbol"></use></svg>';
        nameLine.append(crown);
      }
      if (other?.isVerified) {
        const verified = document.createElement("span");
        verified.className = "x-dm-row-verified";
        verified.setAttribute("aria-label", "Membre vérifié");
        verified.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#qg-verified-symbol"></use></svg>';
        nameLine.append(verified);
      }
    }
    const time = document.createElement("span");
    time.className = "x-dm-row-time";
    time.textContent = timeLabel(entry.lastMessage?.createdAt || entry.updatedAt);
    nameLine.append(time);

    const snippet = document.createElement("span");
    snippet.className = "x-dm-snippet";
    const preview = entry.lastMessage?.text || "Nouvelle discussion";
    snippet.textContent = entry.kind === "group" && entry.lastMessage
      ? `${entry.lastMessage.senderPseudo} : ${preview}`
      : preview;
    copy.append(nameLine, snippet);
    open.append(copy);

    if (entry.unread > 0) {
      const badge = document.createElement("span");
      badge.className = "x-dm-badge";
      badge.textContent = entry.unread > 99 ? "99+" : String(entry.unread);
      open.append(badge);
    }
    row.append(open);

    if (entry.requestState === "incoming") {
      const actions = document.createElement("div");
      actions.className = "x-dm-request-actions";
      const accept = document.createElement("button");
      accept.type = "button";
      accept.className = "x-dm-accept";
      accept.textContent = "Accepter";
      accept.addEventListener("click", () => void decide(entry, "accept"));
      const refuse = document.createElement("button");
      refuse.type = "button";
      refuse.className = "x-dm-refuse";
      refuse.textContent = "Refuser / Bloquer";
      refuse.addEventListener("click", () => void decide(entry, "refuse"));
      actions.append(accept, refuse);
      row.append(actions);
    }

    open.addEventListener("click", () => void openThread(entry));
    return row;
  };

  const paintInbox = () => {
    if (!listNode) return;
    const data = state.data || {};
    const entries = state.tab === "requests"
      ? [...(data.requests || []), ...(data.outgoing || [])]
      : (data.inbox || []);
    listNode.replaceChildren(...entries.map(createRow));
    if (emptyNode) {
      emptyNode.hidden = entries.length > 0;
      emptyNode.textContent = state.tab === "requests" ? COPY.emptyRequests : COPY.empty;
    }
    const pending = (data.requests || []).length;
    if (requestsCount) {
      requestsCount.hidden = pending === 0;
      requestsCount.textContent = String(pending);
    }
    tabNodes.forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.xDmTab === state.tab));
    });
  };

  const decide = async (entry, action) => {
    setStatus(statusNode, action === "accept" ? "Acceptation…" : "Refus…");
    const { ok, data } = await request("/api/messages", {
      method: "POST",
      body: JSON.stringify({
        action,
        threadId: entry.id,
        ...(action === "refuse" ? { block: false } : {}),
      }),
    });
    if (!ok) {
      setStatus(statusNode, data.error || COPY.offline);
      return;
    }
    state.data = data;
    setStatus(statusNode, action === "accept" ? "Demande acceptée." : "Demande refusée.");
    paintInbox();
    syncLegacySnippet();
  };

  const loadInbox = async ({ quiet = false } = {}) => {
    if (!isSignedIn()) return;
    if (state.loading) return;
    state.loading = true;
    if (!quiet) setStatus(statusNode, COPY.loading);
    try {
      const { ok, data } = await request("/api/messages");
      if (!ok) {
        setStatus(statusNode, data.error || COPY.offline);
        return;
      }
      state.viewer = data.viewer || "";
      state.data = data;
      state.contacts = Array.isArray(data.contacts) ? data.contacts : [];
      if (!quiet) setStatus(statusNode, "");
      paintInbox();
      syncLegacySnippet();
    } catch {
      if (!quiet) setStatus(statusNode, COPY.offline);
    } finally {
      state.loading = false;
    }
  };

  // La ligne « discussion avec Gionny » du rail de droite suit le compteur réel.
  const syncLegacySnippet = () => {
    if (!legacyDmRow || !state.data) return;
    const official = (state.data.inbox || []).find((entry) => entry.official === true);
    const unread = state.data.unread || 0;
    legacyDmRow.dataset.unread = String(unread > 0);
    const snippet = legacyDmRow.querySelector("[data-x-dm-snippet]");
    const badge = legacyDmRow.querySelector("[data-x-dm-badge]");
    if (snippet) {
      snippet.textContent = official?.lastMessage?.text
        || (unread > 0 ? `${unread} nouveau${unread > 1 ? "x" : ""} message${unread > 1 ? "s" : ""}` : "Ta discussion privée avec Gionny");
    }
    if (badge) {
      badge.hidden = unread === 0;
      badge.textContent = unread > 99 ? "99+" : String(unread);
    }
  };

  // -------------------------------------------------------------------------
  // Composeur (direct ou groupe)
  // -------------------------------------------------------------------------

  const paintPeople = () => {
    if (!composePeople) return;
    const query = String(searchInput?.value || "").trim().toLocaleLowerCase("fr-FR");
    const people = state.contacts.filter((entry) => !query || entry.pseudo.toLocaleLowerCase("fr-FR").includes(query));
    composePeople.replaceChildren();
    if (!people.length) {
      const note = document.createElement("p");
      note.className = "x-dm-help";
      note.textContent = state.contacts.length ? "Aucun membre ne correspond." : COPY.locked;
      composePeople.append(note);
    }
    people.forEach((person) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "x-dm-person";
      button.dataset.pseudo = person.pseudo;
      button.setAttribute("aria-pressed", String(state.selected.has(person.pseudo)));
      button.append(avatarNode(person));
      const label = document.createElement("span");
      label.className = "x-dm-person-name";
      label.textContent = person.pseudo;
      button.append(label);
      if (person.isHost) {
        const crown = document.createElement("span");
        crown.className = "x-dm-row-crown";
        crown.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#qg-crown-symbol"></use></svg>';
        button.append(crown);
      }
      if (person.isVerified) {
        const verified = document.createElement("span");
        verified.className = "x-dm-row-verified";
        verified.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#qg-verified-symbol"></use></svg>';
        button.append(verified);
      }
      button.addEventListener("click", () => {
        if (state.selected.has(person.pseudo)) state.selected.delete(person.pseudo);
        else state.selected.set(person.pseudo, person);
        paintPeople();
        syncComposeSubmit();
      });
      composePeople.append(button);
    });
  };

  const syncComposeSubmit = () => {
    if (!composeSubmit) return;
    const count = state.selected.size;
    composeSubmit.disabled = count === 0;
    composeSubmit.textContent = count > 1 ? `Créer le groupe (${count})` : "Ouvrir la discussion";
  };

  const openCompose = () => {
    if (!composeNode) return;
    state.selected.clear();
    if (groupTitleInput) groupTitleInput.value = "";
    if (searchInput) searchInput.value = "";
    state.tab = "inbox";
    showPane("compose");
    paintPeople();
    syncComposeSubmit();
    setStatus(composeStatus, "");
    searchInput?.focus({ preventScroll: true });
  };

  const submitCompose = async () => {
    const chosen = [...state.selected.values()];
    if (!chosen.length) return;
    composeSubmit.disabled = true;
    const isGroup = chosen.length > 1 || Boolean(String(groupTitleInput?.value || "").trim());
    setStatus(composeStatus, isGroup ? "Création du groupe…" : "Ouverture de la discussion…");
    const payload = isGroup
      ? { action: "group", members: chosen.map((entry) => entry.pseudo), title: groupTitleInput?.value || "" }
      : { action: "direct", pseudo: chosen[0].pseudo };
    const { ok, data } = await request("/api/messages", { method: "POST", body: JSON.stringify(payload) });
    if (!ok) {
      setStatus(composeStatus, data.error || COPY.offline);
      syncComposeSubmit();
      return;
    }
    setStatus(composeStatus, "");
    if (data.thread) {
      state.activeThread = data.thread;
      state.activeMessages = Array.isArray(data.messages) ? data.messages : [];
      paintConversation();
      showPane("conversation");
    }
    void loadInbox({ quiet: true });
  };

  // -------------------------------------------------------------------------
  // Conversation
  // -------------------------------------------------------------------------

  const paintConversation = () => {
    const thread = state.activeThread;
    if (!thread) return;
    if (conversationTitle) conversationTitle.textContent = thread.title;
    if (conversationSubtitle) conversationSubtitle.textContent = thread.subtitle || "";
    if (conversationAvatar) {
      conversationAvatar.replaceChildren();
      const holder = avatarNode(thread);
      conversationAvatar.append(...holder.childNodes);
      conversationAvatar.className = `x-dm-conversation-avatar ${thread.avatarData ? "" : "is-fallback"}`.trim();
    }
    if (conversationMessages) {
      conversationMessages.replaceChildren(...state.activeMessages.map(createBubble));
      conversationMessages.scrollTop = conversationMessages.scrollHeight;
    }
    const canSend = thread.canSend !== false && thread.requestState !== "incoming";
    if (conversationInput) conversationInput.disabled = !canSend;
    if (conversationForm) {
      conversationForm.dataset.locked = String(!canSend);
      conversationForm.hidden = !canSend;
    }
    setStatus(
      conversationStatus,
      canSend ? "" : "Cette personne doit accepter ta demande avant que tu puisses écrire."
    );
  };

  const createBubble = (message) => {
    const mine = message.senderPseudo === state.viewer;
    const row = document.createElement("div");
    row.className = `x-dm-bubble${mine ? " is-mine" : ""}`;
    row.dataset.kind = message.kind || "text";

    const head = document.createElement("div");
    head.className = "x-dm-bubble-head";
    const who = document.createElement("strong");
    who.textContent = mine ? "Moi" : message.senderPseudo;
    const time = document.createElement("span");
    time.textContent = timeLabel(message.createdAt);
    head.append(who, time);

    const body = document.createElement("div");
    body.className = "x-dm-bubble-body";
    if (message.kind === "audio" && message.mediaUrl) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "metadata";
      audio.src = message.mediaUrl;
      audio.className = "x-dm-audio";
      body.append(audio);
      if (Array.isArray(message.audioPeaks) && message.audioPeaks.length) {
        const wave = document.createElement("span");
        wave.className = "x-dm-wave";
        message.audioPeaks.slice(0, 40).forEach((peak) => {
          const bar = document.createElement("i");
          bar.style.height = `${Math.max(12, Math.round(Math.max(0, Math.min(1, Number(peak) || 0)) * 100))}%`;
          wave.append(bar);
        });
        body.prepend(wave);
      }
    } else if (message.kind === "image" && message.mediaUrl) {
      const image = document.createElement("img");
      image.src = message.mediaUrl;
      image.alt = message.text || "Image envoyée";
      image.loading = "lazy";
      image.className = "x-dm-image";
      body.append(image);
    }
    if (message.text) {
      const text = document.createElement("p");
      text.textContent = message.text;
      body.append(text);
    }

    row.append(head, body);
    return row;
  };

  const openThread = async (entry) => {
    setStatus(statusNode, "");
    const { ok, data } = await request(`/api/messages?thread=${encodeURIComponent(entry.id)}`);
    if (!ok) {
      setStatus(statusNode, data.error || COPY.offline);
      return;
    }
    state.activeThread = data.thread || entry;
    state.activeMessages = Array.isArray(data.messages) ? data.messages : [];
    paintConversation();
    showPane("conversation");
    void loadInbox({ quiet: true });
  };

  const sendMessage = async ({ data = "", mimeType = "", audioPeaks = [] } = {}) => {
    const thread = state.activeThread;
    if (!thread) return;
    const text = String(conversationInput?.value || "").trim();
    if (!text && !data) return;
    if (conversationInput) conversationInput.value = "";
    setStatus(conversationStatus, "Envoi…");
    const { ok, data: payload } = await request("/api/messages", {
      method: "POST",
      body: JSON.stringify({ action: "send", threadId: thread.id, text, data, mimeType, audioPeaks }),
    });
    if (!ok) {
      setStatus(conversationStatus, payload.error || COPY.offline);
      if (text && conversationInput) conversationInput.value = text;
      return;
    }
    setStatus(conversationStatus, "");
    if (payload.message) {
      state.activeMessages.push(payload.message);
      paintConversation();
    }
    void loadInbox({ quiet: true });
  };

  const resizeInput = () => {
    if (!conversationInput) return;
    conversationInput.style.height = "auto";
    conversationInput.style.height = `${Math.min(120, conversationInput.scrollHeight)}px`;
  };

  // -------------------------------------------------------------------------
  // Panneaux
  // -------------------------------------------------------------------------

  const panes = ["inbox", "compose", "conversation"];
  const showPane = (pane) => {
    if (listNode) listNode.closest(".x-dm")?.toggleAttribute("hidden", pane !== "inbox");
    if (composeNode) composeNode.hidden = pane !== "compose";
    if (conversationNode) conversationNode.hidden = pane !== "conversation";
  };

  // -------------------------------------------------------------------------
  // Événements
  // -------------------------------------------------------------------------

  tabNodes.forEach((tab) => {
    tab.addEventListener("click", () => {
      state.tab = tab.dataset.xDmTab === "requests" ? "requests" : "inbox";
      paintInbox();
    });
  });

  newThreadButton?.addEventListener("click", () => {
    if (!isSignedIn()) return;
    if (!state.data) void loadInbox().then(() => openCompose());
    else openCompose();
  });

  $("[data-x-dm-compose-close]", root)?.addEventListener("click", () => {
    showPane("inbox");
    paintInbox();
  });

  $("[data-x-dm-back]", root)?.addEventListener("click", () => {
    state.activeThread = null;
    showPane("inbox");
    void loadInbox({ quiet: true });
  });

  $("[data-x-dm-conversation-profile]", root)?.addEventListener("click", () => {
    const thread = state.activeThread;
    const other = thread?.participants?.find((person) => person.pseudo !== state.viewer);
    if (!other?.pseudo) return;
    if (typeof window.qgOpenProfile === "function") window.qgOpenProfile(other.pseudo);
  });

  searchInput?.addEventListener("input", paintPeople);

  composeSubmit?.addEventListener("click", () => void submitCompose());

  conversationForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void sendMessage();
  });

  conversationInput?.addEventListener("input", resizeInput);
  conversationInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  });

  conversationForm?.querySelector("[data-x-dm-attach]")?.addEventListener("click", () => conversationImage?.click());

  conversationImage?.addEventListener("change", () => {
    const file = conversationImage.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      void sendMessage({
        data: String(reader.result || ""),
        mimeType: file.type || "image/jpeg",
      });
    });
    reader.readAsDataURL(file);
    conversationImage.value = "";
  });

  // L'état de connexion vit dans la barre d'identité : on s'aligne dessus.
  const identity = document.querySelector("[data-member-identity]");
  if (identity) {
    new MutationObserver(() => {
      if (isSignedIn()) void loadInbox({ quiet: true });
      else {
        state.data = null;
        listNode?.replaceChildren();
        if (emptyNode) emptyNode.hidden = false;
        showPane("inbox");
      }
    }).observe(identity, { attributes: true, attributeFilter: ["hidden"] });
  }

  // Rafraîchissement doux quand la page Messages est visible.
  window.setInterval(() => {
    const view = root.dataset.visible;
    if (view === "false") return;
    if (document.hidden) return;
    if (!isSignedIn()) return;
    if (!conversationNode?.hidden) return;
    void loadInbox({ quiet: true });
  }, 25_000);

  if (isSignedIn()) void loadInbox({ quiet: true });
  showPane("inbox");
})();
