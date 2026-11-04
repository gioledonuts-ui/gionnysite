(() => {
  "use strict";

  // -------------------------------------------------------------------------
  // ÉTAPE 7 · Boîte de messages du widget (bas-droite, ordinateur)
  // -------------------------------------------------------------------------
  // Le tiroir « discussion avec Gionny » garde son comportement (script.js).
  // Ce module ne s'active que si l'on clique sur l'icône de boîte de réception :
  // il affiche la même messagerie multi-DM que la page Messages (fils, demandes,
  // groupes) sans jamais toucher au tiroir lui-même.
  // -------------------------------------------------------------------------

  const widget = document.querySelector("[data-contact-widget]");
  const section = document.querySelector("[data-contact-dm]");
  if (!widget || !section) return;

  const $ = (selector, scope = section) => scope.querySelector(selector);
  const $$ = (selector, scope = section) => [...scope.querySelectorAll(selector)];

  const toggle = document.querySelector("[data-widget-inbox-toggle]");
  const listView = $("[data-contact-dm-list-view]");
  const chatView = $("[data-contact-dm-chat-view]");
  const listNode = $("[data-contact-dm-threads]");
  const emptyNode = $("[data-contact-dm-empty]");
  const listStatus = $("[data-contact-dm-status]");
  const chatStatus = $("[data-contact-dm-chat-status]");
  const countNode = $("[data-contact-dm-count]");
  const tabNodes = $$("[data-contact-dm-tab]");
  const titleNode = $("[data-contact-dm-title]");
  const subtitleNode = $("[data-contact-dm-subtitle]");
  const avatarNode = $("[data-contact-dm-avatar]");
  const messagesNode = $("[data-contact-dm-messages]");
  const form = $("[data-contact-dm-form]");
  const input = $("[data-contact-dm-input]");
  const imageInput = $("[data-contact-dm-image]");
  const authSection = document.querySelector("[data-contact-auth]");
  const threadSection = document.querySelector("[data-contact-thread]");
  const newSection = document.querySelector("[data-contact-new]");

  const state = {
    open: false,
    viewer: "",
    tab: "inbox",
    data: null,
    activeThread: null,
    messages: [],
    loading: false,
  };

  const isSignedIn = () => widget.dataset.signedOut === "false";

  const setStatus = (node, text) => {
    if (!node) return;
    node.textContent = text || "";
    node.hidden = !text;
  };

  const request = async (url, options = {}) => {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {}),
      },
    });
    return { ok: response.ok, status: response.status, data: await response.json().catch(() => ({})) };
  };

  const timeLabel = (value) => {
    const date = new Date(value || 0);
    if (!Number.isFinite(date.getTime())) return "";
    const now = new Date();
    return date.toDateString() === now.toDateString()
      ? date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
  };

  const makeAvatar = (entry) => {
    const holder = document.createElement("span");
    holder.className = "contact-dm-row-avatar";
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
      holder.textContent = String(entry?.title || "?").trim().charAt(0).toUpperCase();
      holder.dataset.fallback = "true";
    }
    return holder;
  };

  const paintList = () => {
    if (!listNode) return;
    const data = state.data || {};
    const threads = state.tab === "requests"
      ? [...(data.requests || []), ...(data.outgoing || [])]
      : (data.inbox || []);
    listNode.replaceChildren();

    threads.forEach((entry) => {
      const row = document.createElement("div");
      row.className = "contact-dm-row";
      row.dataset.unread = entry.unread > 0 ? "true" : "false";
      row.setAttribute("role", "listitem");

      const open = document.createElement("button");
      open.type = "button";
      open.className = "contact-dm-row-open";
      open.setAttribute("aria-label", `Ouvrir la discussion avec ${entry.title}`);
      open.append(makeAvatar(entry));

      const copy = document.createElement("span");
      copy.className = "contact-dm-row-copy";
      const name = document.createElement("span");
      name.className = "contact-dm-row-name";
      name.textContent = entry.title;
      if (entry.kind === "group") {
        const tag = document.createElement("span");
        tag.className = "contact-dm-row-tag";
        tag.textContent = "Groupe";
        name.append(tag);
      }
      const time = document.createElement("span");
      time.className = "contact-dm-row-time";
      time.textContent = timeLabel(entry.lastMessage?.createdAt || entry.updatedAt);
      name.append(time);
      const snippet = document.createElement("span");
      snippet.className = "contact-dm-row-snippet";
      snippet.textContent = entry.lastMessage?.text || "Nouvelle discussion";
      copy.append(name, snippet);
      open.append(copy);

      if (entry.unread > 0) {
        const badge = document.createElement("span");
        badge.className = "contact-dm-row-badge";
        badge.textContent = entry.unread > 99 ? "99+" : String(entry.unread);
        open.append(badge);
      }
      open.addEventListener("click", () => void openThread(entry));
      row.append(open);

      if (entry.requestState === "incoming") {
        const actions = document.createElement("div");
        actions.className = "contact-dm-row-actions";
        const accept = document.createElement("button");
        accept.type = "button";
        accept.className = "contact-dm-accept";
        accept.textContent = "Accepter";
        accept.addEventListener("click", () => void decide(entry, "accept"));
        const refuse = document.createElement("button");
        refuse.type = "button";
        refuse.className = "contact-dm-refuse";
        refuse.textContent = "Refuser / Bloquer";
        refuse.addEventListener("click", () => void decide(entry, "refuse"));
        actions.append(accept, refuse);
        row.append(actions);
      }
      listNode.append(row);
    });

    if (emptyNode) {
      emptyNode.hidden = threads.length > 0;
      emptyNode.textContent = state.tab === "requests"
        ? "Aucune demande de message."
        : "Aucune discussion pour le moment.";
    }
    const pending = (data.requests || []).length;
    if (countNode) {
      countNode.hidden = pending === 0;
      countNode.textContent = String(pending);
    }
    tabNodes.forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.contactDmTab === state.tab));
    });
  };

  const decide = async (entry, action) => {
    setStatus(listStatus, action === "accept" ? "Acceptation…" : "Refus…");
    const { ok, data } = await request("/api/messages", {
      method: "POST",
      body: JSON.stringify({ action, threadId: entry.id }),
    });
    if (!ok) {
      setStatus(listStatus, data.error || "Impossible de joindre la messagerie.");
      return;
    }
    state.data = data;
    setStatus(listStatus, action === "accept" ? "Demande acceptée." : "Demande refusée.");
    paintList();
  };

  const loadInbox = async ({ quiet = false } = {}) => {
    if (!isSignedIn() || state.loading) return;
    state.loading = true;
    if (!quiet) setStatus(listStatus, "Chargement des messages…");
    try {
      const { ok, data } = await request("/api/messages");
      if (!ok) {
        setStatus(listStatus, data.error || "Impossible de joindre la messagerie.");
        return;
      }
      state.viewer = data.viewer || "";
      state.data = data;
      if (!quiet) setStatus(listStatus, "");
      paintList();
    } catch {
      if (!quiet) setStatus(listStatus, "Impossible de joindre la messagerie.");
    } finally {
      state.loading = false;
    }
  };

  const paintChat = () => {
    const thread = state.activeThread;
    if (!thread) return;
    if (titleNode) titleNode.textContent = thread.title;
    if (subtitleNode) subtitleNode.textContent = thread.subtitle || "";
    if (avatarNode) {
      avatarNode.replaceChildren(...makeAvatar(thread).childNodes);
    }
    if (messagesNode) {
      messagesNode.replaceChildren();
      state.messages.forEach((message) => {
        const mine = message.senderPseudo === state.viewer;
        const bubble = document.createElement("div");
        bubble.className = `contact-dm-bubble${mine ? " is-mine" : ""}`;
        bubble.dataset.kind = message.kind || "text";
        const who = document.createElement("span");
        who.className = "contact-dm-bubble-who";
        who.textContent = `${mine ? "Moi" : message.senderPseudo} · ${timeLabel(message.createdAt)}`;
        bubble.append(who);
        if (message.kind === "image" && message.mediaUrl) {
          const image = document.createElement("img");
          image.src = message.mediaUrl;
          image.alt = message.text || "Image envoyée";
          image.loading = "lazy";
          bubble.append(image);
        }
        if (message.kind === "audio" && message.mediaUrl) {
          const audio = document.createElement("audio");
          audio.controls = true;
          audio.preload = "metadata";
          audio.src = message.mediaUrl;
          bubble.append(audio);
        }
        if (message.text) {
          const text = document.createElement("p");
          text.textContent = message.text;
          bubble.append(text);
        }
        messagesNode.append(bubble);
      });
      messagesNode.scrollTop = messagesNode.scrollHeight;
    }
    const canSend = thread.canSend !== false && thread.requestState !== "incoming";
    if (form) {
      form.hidden = !canSend;
      form.dataset.locked = String(!canSend);
    }
    setStatus(
      chatStatus,
      canSend ? "" : "Cette personne doit accepter ta demande avant que tu puisses écrire."
    );
  };

  const openThread = async (entry) => {
    setStatus(listStatus, "");
    const { ok, data } = await request(`/api/messages?thread=${encodeURIComponent(entry.id)}`);
    if (!ok) {
      setStatus(listStatus, data.error || "Impossible d’ouvrir cette discussion.");
      return;
    }
    state.activeThread = data.thread || entry;
    state.messages = Array.isArray(data.messages) ? data.messages : [];
    showChat();
    void loadInbox({ quiet: true });
  };

  const send = async ({ data = "", mimeType = "" } = {}) => {
    const thread = state.activeThread;
    if (!thread) return;
    const text = String(input?.value || "").trim();
    if (!text && !data) return;
    if (input) input.value = "";
    setStatus(chatStatus, "Envoi…");
    const { ok, data: payload } = await request("/api/messages", {
      method: "POST",
      body: JSON.stringify({ action: "send", threadId: thread.id, text, data, mimeType }),
    });
    if (!ok) {
      setStatus(chatStatus, payload.error || "Le message n’a pas pu être envoyé.");
      if (text && input) input.value = text;
      return;
    }
    setStatus(chatStatus, "");
    if (payload.message) {
      state.messages.push(payload.message);
      paintChat();
    }
    void loadInbox({ quiet: true });
  };

  const showList = () => {
    if (listView) listView.hidden = false;
    if (chatView) chatView.hidden = true;
    state.activeThread = null;
  };

  const showChat = () => {
    if (listView) listView.hidden = true;
    if (chatView) chatView.hidden = false;
    paintChat();
  };

  // Le tiroir d'origine et cette boîte ne sont jamais visibles ensemble.
  const setOpen = (open) => {
    state.open = open;
    if (section) section.hidden = !open;
    if (toggle) toggle.setAttribute("aria-pressed", String(open));
    [authSection, threadSection, newSection].forEach((node) => {
      if (!node) return;
      if (open) {
        node.dataset.widgetHidden = node.hidden ? "true" : "false";
        node.hidden = true;
      } else if (node.dataset.widgetHidden !== undefined) {
        node.hidden = node.dataset.widgetHidden === "true";
        delete node.dataset.widgetHidden;
      }
    });
    if (open) {
      showList();
      void loadInbox();
    }
  };

  toggle?.addEventListener("click", () => {
    if (!isSignedIn()) {
      // Sans compte : on laisse le tiroir afficher le panneau de connexion.
      setStatus(listStatus, "");
      return;
    }
    setOpen(!state.open);
    if (state.open) {
      listView?.scrollTo?.({ top: 0 });
      input?.blur();
    }
  });

  document.querySelector("[data-contact-dm-close]")?.addEventListener("click", () => setOpen(false));
  document.querySelector("[data-contact-dm-back]")?.addEventListener("click", () => {
    showList();
    void loadInbox({ quiet: true });
  });

  tabNodes.forEach((tab) => {
    tab.addEventListener("click", () => {
      state.tab = tab.dataset.contactDmTab === "requests" ? "requests" : "inbox";
      paintList();
    });
  });

  document.querySelector("[data-contact-dm-new]")?.addEventListener("click", () => {
    // On renvoie vers la page Messages, qui porte le composeur complet
    // (choix de plusieurs membres + nom du groupe).
    window.location.assign("/#messages");
    document.querySelector('[data-x-nav="messages"]')?.dispatchEvent(new Event("click", { bubbles: true }));
  });

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    void send();
  });
  input?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  });
  document.querySelector("[data-contact-dm-attach]")?.addEventListener("click", () => imageInput?.click());
  imageInput?.addEventListener("change", () => {
    const file = imageInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      void send({ data: String(reader.result || ""), mimeType: file.type || "image/jpeg" });
    });
    reader.readAsDataURL(file);
    imageInput.value = "";
  });

  // Fermer le widget d'origine referme aussi cette boîte.
  new MutationObserver(() => {
    if (widget.hidden && state.open) setOpen(false);
  }).observe(widget, { attributes: true, attributeFilter: ["hidden"] });
})();
