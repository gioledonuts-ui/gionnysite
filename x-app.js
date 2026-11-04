/* ==========================================================================
   QG2GIONNY · couche d'interface sociale (X-grade)
   --------------------------------------------------------------------------
   Ce fichier ne remplace RIEN : `script.js` garde la main sur les comptes,
   Supabase, le chat, le carrousel, le compteur et l'admin. On ne fait ici que
   la navigation entre les vues (Accueil, Notifications, Messages, Profil,
   Paramètres), les onglets du fil, les interrupteurs des paramètres et la
   synchronisation des éléments d'interface avec l'état réel du membre.

   Toutes les actions sensibles (connexion, profil, discussion) sont
   déléguées aux boutons d'origine, qui restent la seule source de vérité.
   ========================================================================== */
(() => {
  const shell = document.querySelector(".x-shell");
  if (!shell) return;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  /* ------------------------------------------------------------------------
     Vues de la colonne centrale
     ---------------------------------------------------------------------- */
  const VIEWS = ["home", "notifications", "profile", "settings", "messages"];
  let activeView = "home";

  const setActiveView = (view, { focus = false } = {}) => {
    if (!VIEWS.includes(view)) return;
    activeView = view;
    $$("[data-x-view]").forEach((section) => {
      section.hidden = section.dataset.xView !== view;
    });
    $$("[data-x-nav]").forEach((link) => {
      if (link.dataset.xNav === view) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    // Le rail mobile n'a qu'un bouton « Profil / Paramètres ».
    const mobileProfile = $('.x-mobile-nav [data-x-nav="profile"]');
    if (mobileProfile) {
      if (view === "profile" || view === "settings") mobileProfile.setAttribute("aria-current", "page");
      else mobileProfile.removeAttribute("aria-current");
    }
    if (focus) {
      const target = $(`[data-x-view="${view}"]`);
      target?.setAttribute("tabindex", "-1");
      target?.focus({ preventScroll: true });
    }
    if (view === "home") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  $$("[data-x-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      // Sur téléphone, toute navigation ramène au fil : sinon la vue choisie
      // resterait cachée derrière la bascule « Lives & réseaux ».
      if (typeof setMobileView === "function" && shell.dataset.mobileView === "social") {
        setMobileView("feed");
      }
      setActiveView(button.dataset.xNav);
    });
  });

  /* ------------------------------------------------------------------------
     Onglets du fil et des notifications
     ---------------------------------------------------------------------- */
  const feedState = $("[data-x-feed-state]");
  const FEED_COPY = {
    all: "Les posts publics de Gionny et des membres Validés s’afficheront ici. Les lives et les réseaux sont déjà dans la colonne de droite.",
    verified: "Seuls les posts de Gionny et des membres Validés apparaîtront ici.",
  };
  const feedTitle = $(".x-feed-title");
  const FEED_TITLE = {
    all: "Le fil arrive à l’étape suivante",
    verified: "Le fil des Validés arrive à l’étape suivante",
  };

  $$("[data-x-feed-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$("[data-x-feed-tab]").forEach((other) =>
        other.setAttribute("aria-selected", String(other === tab))
      );
      const key = tab.dataset.xFeedTab;
      if (feedState) feedState.textContent = FEED_COPY[key] || FEED_COPY.all;
      if (feedTitle) feedTitle.textContent = FEED_TITLE[key] || FEED_TITLE.all;
    });
  });

  $$("[data-x-notif-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$("[data-x-notif-tab]").forEach((other) =>
        other.setAttribute("aria-selected", String(other === tab))
      );
    });
  });

  /* ------------------------------------------------------------------------
     Paramètres : interrupteurs persistants
     ---------------------------------------------------------------------- */
  const PREFS_KEY = "qg:x:preferences:v1";
  const readPrefs = () => {
    try {
      const parsed = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  };
  const writePrefs = (prefs) => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Un stockage bloqué ne doit pas casser les paramètres de la session.
    }
  };

  const switches = $$("[data-x-switch]");
  if (switches.length) {
    const prefs = readPrefs();
    switches.forEach((toggle) => {
      const key = toggle.dataset.xSwitch;
      if (typeof prefs[key] === "boolean") toggle.setAttribute("aria-checked", String(prefs[key]));
      toggle.addEventListener("click", () => {
        const next = toggle.getAttribute("aria-checked") !== "true";
        toggle.setAttribute("aria-checked", String(next));
        writePrefs({ ...readPrefs(), [key]: next });
      });
    });
  }

  /* ------------------------------------------------------------------------
     Toutes les actions sensibles passent par les boutons d'origine
     ---------------------------------------------------------------------- */
  const forward = (selector) => {
    const target = $(selector);
    if (target) target.click();
    return Boolean(target);
  };

  const isSignedIn = () => {
    const connected = $("[data-member-logged-in]");
    const identity = $("[data-member-identity]");
    return Boolean((connected && !connected.hidden) || (identity && !identity.hidden));
  };

  const openLogger = () => {
    if (!forward("[data-open-contact]")) forward("[data-member-login]");
  };

  $$("[data-x-compose-open], [data-x-compose-focus], [data-x-dm-open], [data-x-messages-open]").forEach(
    (button) => button.addEventListener("click", openLogger)
  );

  $$("[data-x-login]").forEach((button) => button.addEventListener("click", () => forward("[data-member-login]")));
  $$("[data-x-register]").forEach((button) =>
    button.addEventListener("click", () => forward("[data-member-register]"))
  );
  $$("[data-x-profile-open], [data-x-profile-edit]").forEach((button) =>
    button.addEventListener("click", () => forward(isSignedIn() ? "[data-member-profile]" : "[data-member-login]"))
  );
  $$("[data-x-profile-settings]").forEach((button) =>
    button.addEventListener("click", () => setActiveView("settings"))
  );

  const mobileAccount = $("[data-x-mobile-account]");
  mobileAccount?.addEventListener("click", () => {
    if (isSignedIn()) forward("[data-member-profile]");
    else forward("[data-member-login]");
  });

  /* ------------------------------------------------------------------------
     Synchronisation avec l'état du membre (miroir, jamais calculé ici)
     ---------------------------------------------------------------------- */
  const railCard = $("[data-rail-account-card]");
  const railAuth = $("[data-rail-auth]");
  const railPseudo = $("[data-rail-account-pseudo]");
  const railHandle = $("[data-rail-account-handle]");
  const railAvatar = $("[data-rail-account-avatar]");
  const railCrown = $("[data-rail-account-crown]");
  const railVerified = $("[data-rail-account-verified]");
  const mobileAvatar = $("[data-x-mobile-account-avatar]");
  const dmBadge = $("[data-x-dm-badge]");
  const dmSnippet = $("[data-x-dm-snippet]");
  const messagesBadges = $$('[data-x-badge="messages"]');
  const profileName = $("[data-x-profile-name]");
  const profileHandle = $("[data-x-profile-handle]");
  const profileAvatar = $("[data-x-profile-avatar]");

  // Ré-entrance : `syncAccount` écrit dans le DOM qu'il observe. Sans ce
  // verrou, chaque écriture relançait un cycle (boucle infinie observée en
  // test). On compare aussi avant d'écrire : aucun nœud n'est recréé pour rien.
  let syncing = false;
  const setText = (node, value) => {
    if (!node) return;
    const next = String(value ?? "");
    if (node.textContent !== next) node.textContent = next;
  };

  const syncAccount = () => {
    if (syncing) return;
    syncing = true;
    try {
      syncAccountNow();
    } finally {
      syncing = false;
    }
  };

  const syncAccountNow = () => {
    const signedIn = isSignedIn();
    if (railCard) railCard.hidden = !signedIn;
    if (railAuth) railAuth.hidden = signedIn;

    const pseudo = ($("[data-member-pseudo]")?.textContent || "").trim();
    const sourceAvatar = $("[data-member-avatar]");
    const avatarSrc = sourceAvatar && !sourceAvatar.hidden ? sourceAvatar.getAttribute("src") || "" : "";
    const isCrown = Boolean($("[data-member-crown]") && !$("[data-member-crown]").hidden);
    const isVerified = Boolean(
      $("[data-member-verified-badge]") && !$("[data-member-verified-badge]").hidden
    );

    setText(railPseudo, pseudo || "Membre du QG");
    setText(railHandle, `@${(pseudo || "membre").replace(/\s+/gu, "")}`);
    if (railCrown) railCrown.toggleAttribute("hidden", !isCrown);
    if (railVerified) railVerified.toggleAttribute("hidden", !isVerified);

    if (railAvatar) {
      railAvatar.hidden = !avatarSrc;
      if (avatarSrc && railAvatar.getAttribute("src") !== avatarSrc) railAvatar.src = avatarSrc;
      const fallback = railAvatar.parentElement?.querySelector("svg");
      if (fallback) fallback.toggleAttribute("hidden", Boolean(avatarSrc));
    }
    if (mobileAvatar) {
      // Déconnecté : l'icône « profil » générique, comme sur X. Connecté : la photo.
      const fallbackIcon = mobileAvatar.parentElement?.querySelector("svg");
      mobileAvatar.hidden = !signedIn || !avatarSrc;
      if (fallbackIcon) fallbackIcon.style.display = mobileAvatar.hidden ? "block" : "none";
      if (avatarSrc && mobileAvatar.getAttribute("src") !== avatarSrc) mobileAvatar.src = avatarSrc;
    }
    if (profileAvatar) {
      const next = avatarSrc || "/assets/gionny-profile.jpg";
      if (profileAvatar.getAttribute("src") !== next) profileAvatar.src = next;
    }
    const adminLink = $("[data-x-admin]");
    const adminSource = $("[data-host-admin-link]");
    if (adminLink && adminSource) adminLink.hidden = adminSource.hidden;

    $("[data-x-profile-view-crown]")?.toggleAttribute("hidden", signedIn && !isCrown);
    $("[data-x-profile-verified]")?.toggleAttribute("hidden", signedIn && !isVerified);
    $$("[data-x-profile-host-details]").forEach((node) => { node.hidden = signedIn; });
    setText(profileName, signedIn ? pseudo || "Membre du QG" : "Gionny");
    setText(profileHandle, `@${(signedIn ? pseudo || "membre" : "7gionny").replace(/\s+/gu, "")}`);
  };

  const syncMessages = () => {
    if (syncing) return;
    syncing = true;
    try {
      syncMessagesNow();
    } finally {
      syncing = false;
    }
  };

  const syncMessagesNow = () => {
    const badge = $("[data-contact-badge]");
    const count = badge && !badge.hidden ? (badge.textContent || "").trim() : "";
    if (dmBadge) {
      dmBadge.hidden = !count || count === "0";
      setText(dmBadge, count || "");
    }
    messagesBadges.forEach((node) => {
      node.toggleAttribute("hidden", !count || count === "0");
    });
    if (dmSnippet) {
      setText(dmSnippet, count ? `${count} nouveau${count === "1" ? "" : "x"} message${count === "1" ? "" : "s"} de Gionny` : "Ta discussion privée avec Gionny");
    }
  };

  const memberAccess = $("[data-member-access]");
  if (memberAccess) {
    const observer = new MutationObserver(() => {
      syncAccount();
      syncMessages();
    });
    observer.observe(memberAccess, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  }
  // Les changements de visibilité ou d'avatar n'impliquent pas forcément de texte.
  ["[data-member-identity]", "[data-member-logged-in]", "[data-member-crown]", "[data-member-verified-badge]", "[data-member-avatar]", "[data-host-admin-link]"].forEach((selector) => {
    const source = $(selector);
    if (source) new MutationObserver(syncAccount).observe(source, { attributes: true, attributeFilter: ["hidden", "src"] });
  });
  const contactBadge = $("[data-contact-badge]");
  if (contactBadge) {
    new MutationObserver(syncMessages).observe(contactBadge, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["hidden"],
    });
  }
  syncAccount();
  syncMessages();

  /* ------------------------------------------------------------------------
     Téléphone : bascule Fil / Lives & réseaux
     ---------------------------------------------------------------------- */
  const switchButton = $("[data-x-mobile-switch]");
  const switchLabel = $("[data-x-mobile-switch-label]");
  function setMobileView(view) {
    const social = view === "social";
    shell.dataset.mobileView = social ? "social" : "feed";
    if (switchButton) {
      switchButton.setAttribute("aria-pressed", String(social));
      switchButton.setAttribute(
        "aria-label",
        social ? "Afficher le fil d’actualité" : "Afficher les lives et les réseaux"
      );
    }
    if (switchLabel) switchLabel.textContent = social ? "Fil d’actualité" : "Lives & réseaux";
    if (social) $('.x-mobile-nav [data-x-nav="home"]')?.removeAttribute("aria-current");
    // La barre mobile n'a qu'un bouton « Lives & réseaux » : il reste allumé
    // tant que cette vue est affichée.
    $$('[data-x-mobile-only="social"]').forEach((button) => {
      if (social) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  switchButton?.addEventListener("click", () =>
    setMobileView(shell.dataset.mobileView === "social" ? "feed" : "social")
  );
  $$('[data-x-mobile-only="social"]').forEach((button) =>
    button.addEventListener("click", () => {
      setActiveView("home");
      setMobileView("social");
    })
  );
  shell.dataset.mobileView = "feed";
  setMobileView("feed");

  /* ------------------------------------------------------------------------
     Accessibilité : Échap ramène à l'accueil, jamais de piège de focus
     ---------------------------------------------------------------------- */
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if ($("dialog[open]")) return;
    const widget = $("[data-contact-widget]");
    if (widget && !widget.hidden) return;
    if (activeView !== "home") setActiveView("home");
  });

  // Un lien interne (#main, #top) doit garder le fil visible.
  $$('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", () => {
      if (activeView !== "home") setActiveView("home");
    });
  });
})();
