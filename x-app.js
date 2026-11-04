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
  // "" = mon profil, sinon le pseudo du profil public consulté.
  let viewedProfilePseudo = "";

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
    if (view === "profile") renderProfileView();
    if (view === "home") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  $$("[data-x-nav]").forEach((button) => {
    button.addEventListener("click", () => {
      // L'onglet Profil ouvre TOUJOURS le profil du compte connecté.
      if (button.dataset.xNav === "profile" && viewedProfilePseudo) viewedProfilePseudo = "";
      // Sur téléphone, toute navigation ramène au fil : sinon la vue choisie
      // resterait cachée derrière la bascule « Lives & réseaux ».
      if (typeof setMobileView === "function" && shell.dataset.mobileView === "social") {
        setMobileView("feed");
      }
      setActiveView(button.dataset.xNav);
    });
  });

  /* ------------------------------------------------------------------------
     ÉTAPE 2 · Profils publics du QG
     ------------------------------------------------------------------------
     • l'onglet « Profil » ouvre le profil du compte connecté (Modifier) ;
     • cliquer un pseudo / une photo ouvre le profil public de la personne
       (flèche Retour), avec Suivre, Message, Bloquer, Signaler ;
     • un visiteur non connecté ne voit jamais un profil : seulement l'invite.
     ---------------------------------------------------------------------- */
  const profileGuest = $("[data-x-profile-guest]");
  const profileCard = $("[data-x-profile-card]");
  const profileNameNode = $("[data-x-profile-name]");
  const profileHandleNode = $("[data-x-profile-handle]");
  const profileBioNode = $("[data-x-profile-bio]");
  const profileAvatarNode = $("[data-x-profile-avatar]");
  const profileAvatarFallback = $("[data-x-profile-avatar-fallback]");
  const profileCrown = $("[data-x-profile-view-crown]");
  const profileVerified = $("[data-x-profile-verified]");
  const profileFollowingCount = $("[data-x-profile-following]");
  const profileFollowersCount = $("[data-x-profile-followers]");
  const profileFollowsYou = $("[data-x-profile-follows-you]");
  const profileDiscord = $("[data-x-profile-discord]");
  const profileDiscordName = $("[data-x-profile-discord-name]");
  const profileTitleName = $("[data-x-profile-title-name]");
  const followButton = $("[data-x-follow-button]");
  const followLabel = $("[data-x-follow-label]");
  const messageButton = $("[data-x-message-button]");
  const moreButton = $("[data-x-profile-more]");
  const profileMenu = $("[data-x-profile-menu]");
  const blockButton = $("[data-x-block-button]");
  const blockLabel = $("[data-x-block-label]");
  const reportButton = $("[data-x-report-button]");
  const profileFeedEmpty = $("[data-x-profile-feed-empty]");

  let viewedProfile = null;      // profil public affiché
  let viewerProfile = null;      // profil du compte connecté (bio, Discord…)
  let profileRequestId = 0;

  const hostHandle = (pseudo) => `@${String(pseudo || "").replace(/\s+/gu, "")}`;

  const paintProfile = (profile, { isSelf }) => {
    const user = currentUser();
    const pseudo = profile?.pseudo || user?.pseudo || "";
    const isHost = profile ? profile.isHost === true : Boolean(user?.isHost);
    const badges = Array.isArray(profile?.badges)
      ? profile.badges
      : user?.isVerified ? ["verified"] : [];
    const avatar = profile?.avatarData || (isSelf ? user?.avatarData : "") || (isHost ? hostAvatar() : "");

    setText(profileTitleName, isSelf ? "Profil" : pseudo ? `@${pseudo}` : "Profil");
    setText(profileNameNode, pseudo);
    setText(profileHandleNode, pseudo ? hostHandle(pseudo) : "");
    setText(profileBioNode, profile?.bio || (isHost
      ? "La commu, les lives et les meilleurs moments sont ici. On se retrouve sur Discord, Twitch et YouTube."
      : ""));
    if (profileBioNode) profileBioNode.hidden = !profileBioNode.textContent;

    if (profileCrown) profileCrown.toggleAttribute("hidden", !isHost);
    if (profileVerified) profileVerified.toggleAttribute("hidden", !badges.includes("verified"));
    if (profileAvatarNode) {
      profileAvatarNode.hidden = !avatar;
      if (avatar && profileAvatarNode.getAttribute("src") !== avatar) profileAvatarNode.src = avatar;
    }
    if (profileAvatarFallback) profileAvatarFallback.hidden = Boolean(avatar);

    setText(profileFollowingCount, profile?.followingCount ?? (isSelf ? viewerProfile?.followingCount ?? 0 : 0));
    setText(profileFollowersCount, profile?.followersCount ?? 0);
    if (profileFollowsYou) profileFollowsYou.hidden = !profile?.followsYou || isSelf;
    if (profileDiscord) {
      const discord = profile?.discordUsername || (isSelf ? viewerProfile?.discordUsername : "") || "";
      profileDiscord.hidden = !discord;
      setText(profileDiscordName, discord ? `@${discord}` : "");
    }

    $$("[data-x-profile-host-details]").forEach((node) => { node.hidden = !isHost; });
    $$("[data-x-profile-self-only]").forEach((node) => { node.hidden = !isSelf; });
    $$("[data-x-profile-other]").forEach((node) => { node.hidden = Boolean(isSelf) || !user; });
    $$("[data-x-profile-back]").forEach((node) => { node.hidden = Boolean(isSelf); });

    if (followButton && !isSelf && profile) {
      const locked = profile.isHost === true;
      followButton.disabled = locked && profile.isFollowing !== false;
      followButton.dataset.following = String(profile.isFollowing === true);
      followButton.setAttribute("aria-pressed", String(profile.isFollowing === true));
      setText(followLabel, profile.isFollowing ? "Abonné" : "Suivre");
    }
    if (blockLabel && profile) {
      setText(blockLabel, profile.isBlocked ? `Débloquer @${pseudo}` : `Bloquer @${pseudo}`);
    }
    if (messageButton) {
      // Message : toujours possible vers l'Hôte, sinon seulement entre Validés.
      const allowed = profile
        ? profile.isHost === true || (user?.isVerified && badges.includes("verified"))
        : false;
      messageButton.hidden = isSelf || !allowed || profile?.isBlocked === true;
    }
    if (profileFeedEmpty) {
      profileFeedEmpty.textContent = isHost
        ? "Les posts de Gionny s’afficheront ici dès la prochaine étape du fil."
        : "Les posts de ce membre s’afficheront ici.";
    }
  };

  const loadViewerProfile = async () => {
    try {
      const response = await fetch("/api/contact", {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok) return null;
      const data = await response.json().catch(() => ({}));
      viewerProfile = data?.profile || null;
      return viewerProfile;
    } catch {
      return null;
    }
  };

  const loadPublicProfile = async (pseudo) => {
    const requestId = ++profileRequestId;
    try {
      const url = new URL("/api/profile", window.location.origin);
      url.searchParams.set("pseudo", pseudo);
      const response = await fetch(url.href, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (requestId !== profileRequestId) return null;
      if (!response.ok || !data.profile) return data?.error || "Ce profil est introuvable.";
      viewedProfile = { ...data.profile, reasons: Array.isArray(data.reasons) ? data.reasons : [] };
      return null;
    } catch {
      return "Ce profil ne peut pas être affiché pour le moment.";
    }
  };

  async function renderProfileView() {
    const user = currentUser();
    const signedIn = Boolean(user);
    if (profileGuest) profileGuest.hidden = signedIn;
    if (profileCard) profileCard.hidden = !signedIn;
    if (!signedIn) {
      viewedProfile = null;
      return;
    }

    const isSelf = !viewedProfilePseudo || !user
      ? true
      : viewedProfilePseudo.toLowerCase() === user.pseudo.toLowerCase();

    if (isSelf) {
      if (!viewerProfile) await loadViewerProfile();
      if (!viewerProfile) await loadViewerProfile();
      const myProfile = {
        pseudo: user.pseudo,
        isHost: user.isHost,
        badges: user.isVerified ? ["verified"] : [],
        avatarData: user.avatarData,
        bio: viewerProfile?.bio || "",
        discordUsername: viewerProfile?.discordUsername || "",
        followingCount: viewerProfile?.followingCount ?? 0,
        followersCount: viewedProfile?.pseudo?.toLowerCase() === user.pseudo.toLowerCase()
          ? viewedProfile.followersCount
          : 0,
        isFollowing: false,
        followsYou: false,
        isBlocked: false,
      };
      // Le compteur d'abonnés du profil vient du serveur : on le recharge.
      void loadPublicProfile(user.pseudo).then(() => {
        if (activeView !== "profile") return;
        if (viewedProfilePseudo) return;
        const refreshed = viewedProfile;
        if (refreshed) myProfile.followersCount = refreshed.followersCount;
        myProfile.isHost = refreshed?.isHost ?? myProfile.isHost;
        myProfile.badges = refreshed?.badges || myProfile.badges;
        paintProfile(myProfile, { isSelf: true });
      });
      paintProfile(myProfile, { isSelf: true });
      fillBioForm();
      void loadProfileFeed();
      return;
    }

    if (!viewedProfile || viewedProfile.pseudo.toLowerCase() !== viewedProfilePseudo.toLowerCase()) {
      if (profileCard) profileCard.dataset.loading = "true";
      const error = await loadPublicProfile(viewedProfilePseudo);
      if (profileCard) delete profileCard.dataset.loading;
      if (error) {
        viewedProfilePseudo = "";
        viewedProfile = null;
        paintProfile({ pseudo: user.pseudo, isHost: user.isHost, badges: [] }, { isSelf: true });
        return;
      }
    }
    paintProfile(viewedProfile, { isSelf: false });
    void loadProfileFeed();
  }

  /** Ouvre la page de profil public d'une personne. */
  async function openPublicProfile(pseudo) {
    const user = currentUser();
    if (!user) {
      forward("[data-member-login]");
      return;
    }
    const cleaned = String(pseudo || "").replace(/^@+/u, "").trim();
    if (!cleaned) return;
    viewedProfilePseudo = cleaned;
    viewedProfile = null;
    if (typeof setMobileView === "function" && shell.dataset.mobileView === "social") setMobileView("feed");
    setActiveView("profile");
  }

  const closePublicProfile = () => {
    viewedProfilePseudo = "";
    viewedProfile = null;
    const user = currentUser();
    if (user) {
      setActiveView("profile");
      return;
    }
    setActiveView("home");
  };

  $$("[data-x-profile-back]").forEach((button) => button.addEventListener("click", closePublicProfile));

  /* --- Onglets du profil : Posts | J’aime + feed réel ------------------- */
  const profileFeedNode = $("[data-x-profile-feed]");
  let profileFeedTab = "posts";

  $$("[data-x-profile-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$("[data-x-profile-tab]").forEach((other) =>
        other.setAttribute("aria-selected", String(other === tab))
      );
      profileFeedTab = tab.dataset.xProfileTab === "likes" ? "likes" : "posts";
      void loadProfileFeed();
    });
  });

  async function loadProfileFeed() {
    if (!profileFeedNode) return;
    const pseudo = viewedProfilePseudo || currentUser()?.pseudo || "";
    if (!pseudo) return;
    try {
      const url = new URL("/api/profile", window.location.origin);
      url.searchParams.set("author", pseudo);
      const response = await fetch(url.href, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return;
      const posts = Array.isArray(data.posts) ? data.posts : [];
      const visible = profileFeedTab === "likes" ? posts.filter((post) => post.liked) : posts;
      profileFeedNode.replaceChildren(...visible.map(createPostCard));
      if (profileFeedEmpty) {
        profileFeedEmpty.hidden = visible.length > 0;
        if (!visible.length) {
          profileFeedEmpty.textContent = profileFeedTab === "likes"
            ? "Aucun post liké pour le moment."
            : "Aucun post pour le moment.";
        }
        if (!profileFeedEmpty.parentElement) profileFeedNode.append(profileFeedEmpty);
      }
    } catch {
      // Le profil garde son état vide.
    }
  }
  /* --- Bio + pseudo Discord : éditables depuis « Mon profil » ------------ */
  const bioForm = $("[data-x-bio-form]");
  const bioStatus = $("[data-x-bio-status]");
  bioForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const bio = String(bioForm.elements.namedItem("bio")?.value || "").slice(0, 160);
    const discordUsername = String(bioForm.elements.namedItem("discordUsername")?.value || "").slice(0, 40);
    setText(bioStatus, "Enregistrement…");
    try {
      const response = await fetch("/api/profile", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ action: "details", bio, discordUsername }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setText(bioStatus, data.error || "La bio n’a pas pu être enregistrée.");
        return;
      }
      viewerProfile = {
        ...(viewerProfile || {}),
        bio: data.profile?.bio || "",
        discordUsername: data.profile?.discordUsername || "",
        followingCount: Array.isArray(data.profile?.following) ? data.profile.following.length : viewerProfile?.followingCount ?? 0,
      };
      setText(bioStatus, "Enregistré.");
      if (activeView === "profile" && !viewedProfilePseudo) await renderProfileView();
    } catch {
      setText(bioStatus, "Impossible de joindre le serveur. Réessaie.");
    }
  });

  const fillBioForm = () => {
    if (!bioForm) return;
    const bioField = bioForm.elements.namedItem("bio");
    const discordField = bioForm.elements.namedItem("discordUsername");
    if (bioField && document.activeElement !== bioField) bioField.value = viewerProfile?.bio || "";
    if (discordField && document.activeElement !== discordField) {
      discordField.value = viewerProfile?.discordUsername || "";
    }
  };



  // Toute photo / tout pseudo cliquable ouvre le profil public correspondant.
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-x-profile-link]");
    if (!trigger) return;
    event.preventDefault();
    void openPublicProfile(trigger.dataset.xProfileLink);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const trigger = event.target.closest?.("[data-x-profile-link]");
    if (!trigger) return;
    event.preventDefault();
    void openPublicProfile(trigger.dataset.xProfileLink);
  });

  const closeProfileMenu = () => {
    if (!profileMenu) return;
    profileMenu.hidden = true;
    moreButton?.setAttribute("aria-expanded", "false");
  };

  moreButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!profileMenu) return;
    const open = profileMenu.hidden;
    profileMenu.hidden = !open;
    moreButton.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (event) => {
    if (!profileMenu || profileMenu.hidden) return;
    if (profileMenu.contains(event.target) || moreButton?.contains(event.target)) return;
    closeProfileMenu();
  });

  const profileAction = async (action, extra = {}) => {
    if (!viewedProfile) return null;
    try {
      const response = await fetch("/api/profile", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ action, target: viewedProfile.pseudo, ...extra }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        window.alert?.(data.error || "Cette action n’a pas pu être enregistrée.");
        return null;
      }
      return data;
    } catch {
      window.alert?.("Impossible de joindre le serveur. Réessaie.");
      return null;
    }
  };

  followButton?.addEventListener("click", async () => {
    if (!viewedProfile) return;
    followButton.disabled = true;
    const willFollow = viewedProfile.isFollowing !== true;
    const data = await profileAction(willFollow ? "follow" : "unfollow");
    followButton.disabled = false;
    if (!data) return;
    viewedProfile = data.profile || { ...viewedProfile, isFollowing: willFollow };
    paintProfile(viewedProfile, { isSelf: false });
    if (willFollow) void loadViewerProfile();
  });

  messageButton?.addEventListener("click", () => {
    if (!viewedProfile) return;
    openLogger();
    const status = document.querySelector("[data-contact-status]");
    if (viewedProfile.isHost) {
      if (status) status.textContent = "";
      return;
    }
    if (status) {
      status.textContent = `Message privé avec @${viewedProfile.pseudo} : il arrive dans la boîte du QG, Gionny le transmet.`;
    }
  });

  blockButton?.addEventListener("click", async () => {
    if (!viewedProfile) return;
    const willBlock = viewedProfile.isBlocked !== true;
    const data = await profileAction(willBlock ? "block" : "unblock");
    closeProfileMenu();
    if (!data) return;
    viewedProfile = { ...viewedProfile, isBlocked: willBlock, isFollowing: willBlock ? false : viewedProfile.isFollowing };
    paintProfile(viewedProfile, { isSelf: false });
    void loadViewerProfile();
  });

  reportButton?.addEventListener("click", () => {
    closeProfileMenu();
    if (viewedProfile) openReportDialog({ pseudo: viewedProfile.pseudo, reasons: viewedProfile.reasons });
  });

  // Suivre / Abonné : la pastille blanche devient sombre au survol (CSS).
  followButton?.addEventListener("mouseenter", () => {
    if (followButton.dataset.following === "true" && viewedProfile?.isHost !== true) {
      setText(followLabel, "Se désabonner");
    }
  });
  followButton?.addEventListener("mouseleave", () => {
    if (viewedProfile) setText(followLabel, viewedProfile.isFollowing ? "Abonné" : "Suivre");
  });

  /* --- Signalement : petite fenêtre épurée, motif + envoi ---------------- */
  const reportDialog = document.querySelector("[data-x-report-dialog]");
  const reportReasons = $("[data-x-report-reasons]", reportDialog || document);
  const reportDetails = $("[data-x-report-details]", reportDialog || document);
  const reportStatus = $("[data-x-report-status]", reportDialog || document);
  const reportSend = $("[data-x-report-send]", reportDialog || document);
  const reportTitle = $("[data-x-report-title]", reportDialog || document);
  let reportTarget = null;
  let reportMessageId = "";
  let reportReason = "";

  function openReportDialog({ pseudo, reasons = [], messageId = "" } = {}) {
    if (!reportDialog) return;
    reportTarget = pseudo || "";
    reportMessageId = typeof messageId === "string" ? messageId : "";
    reportReason = "";
    setText(reportTitle, `Signaler @${reportTarget}`);
    if (reportDetails) reportDetails.value = "";
    setText(reportStatus, "");
    const list = Array.isArray(reasons) && reasons.length
      ? reasons
      : ["Usurpation d’identité", "Harcèlement ou insultes", "Spam ou contenu trompeur", "Propos haineux", "Autre"];
    if (reportReasons) {
      reportReasons.replaceChildren(...list.map((reason) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "x-report-reason";
        button.setAttribute("aria-pressed", "false");
        button.textContent = reason;
        button.addEventListener("click", () => {
          reportReason = reason;
          [...reportReasons.querySelectorAll("[aria-pressed]")].forEach((node) => {
            node.setAttribute("aria-pressed", String(node === button));
          });
        });
        return button;
      }));
    }
    if (typeof reportDialog.showModal === "function" && !reportDialog.open) reportDialog.showModal();
  }

  reportDialog?.addEventListener("click", (event) => {
    if (event.target === reportDialog) reportDialog.close();
  });
  $$("[data-x-report-cancel]", reportDialog || document).forEach((button) =>
    button.addEventListener("click", () => reportDialog?.close())
  );

  reportSend?.addEventListener("click", async () => {
    if (!reportTarget) return;
    if (!reportReason) {
      setText(reportStatus, "Choisis un motif avant d’envoyer.");
      return;
    }
    reportSend.disabled = true;
    setText(reportStatus, "Envoi…");
    try {
      const response = await fetch("/api/profile", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          action: "report",
          target: reportTarget,
          reason: reportReason,
          messageId: reportMessageId,
          details: String(reportDetails?.value || "").slice(0, 300),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setText(reportStatus, data.error || "Le signalement n’a pas pu être envoyé.");
        return;
      }
      setText(reportStatus, "Signalement envoyé à Gionny. Merci.");
      window.setTimeout(() => reportDialog?.close(), 900);
    } catch {
      setText(reportStatus, "Impossible de joindre le serveur. Réessaie.");
    } finally {
      reportSend.disabled = false;
    }
  });

  /* ------------------------------------------------------------------------
     Onglets du fil et des notifications
     ---------------------------------------------------------------------- */
  const FEED_COPY = {
    all: "Les posts publics de Gionny et des membres Validés s’affichent ici.",
    verified: "Seuls les posts de Gionny et des membres Validés apparaissent ici.",
  };
  const feedState = $("[data-x-feed-state]");

  let feedMode = "all";

  $$("[data-x-feed-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$("[data-x-feed-tab]").forEach((other) =>
        other.setAttribute("aria-selected", String(other === tab))
      );
      feedMode = tab.dataset.xFeedTab === "verified" ? "verified" : "all";
      if (feedState) feedState.textContent = FEED_COPY[feedMode] || FEED_COPY.all;
      void loadFeed({ mode: feedMode });
    });
  });


  /* ------------------------------------------------------------------------
     Le fil : posts réels (Gionny + membres Validés publient, tout le monde like)
     ---------------------------------------------------------------------- */
  const feedPostsNode = $("[data-x-feed-posts]");
  const feedEmpty = $("[data-x-feed-empty]");
  const postComposer = $("[data-x-post-input]");
  const postSubmit = $("[data-x-post-submit]");
  const composerNote = $("[data-x-composer-note]");

  const relativeTime = (value) => {
    const date = Date.parse(value || "");
    if (!Number.isFinite(date)) return "";
    const seconds = Math.round((Date.now() - date) / 1000);
    if (seconds < 60) return "à l’instant";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h`;
    const date3 = new Date(date);
    return date3.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  };

  const createPostCard = (post) => {
    const card = document.createElement("article");
    card.className = "x-post";
    card.dataset.postId = post.id;

    const avatar = document.createElement("button");
    avatar.type = "button";
    avatar.className = "x-post-avatar";
    avatar.dataset.xProfileLink = post.pseudo;
    avatar.setAttribute("aria-label", `Ouvrir le profil de ${post.pseudo}`);
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.src = post.avatarData || (post.isHost ? hostAvatar() : "");
    if (!image.src) {
      image.remove();
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 40 40");
      svg.setAttribute("fill", "none");
      svg.innerHTML = '<circle cx="20" cy="20" r="19" /><circle cx="20" cy="15" r="6" /><path d="M8.5 33.5c1.7-6.2 5.8-9.3 11.5-9.3s9.8 3.1 11.5 9.3" />';
      avatar.append(svg);
    } else {
      avatar.append(image);
    }

    const body = document.createElement("div");
    body.className = "x-post-body";

    const head = document.createElement("div");
    head.className = "x-post-head";
    const who = document.createElement("button");
    who.type = "button";
    who.className = "x-post-who";
    who.dataset.xProfileLink = post.pseudo;
    who.textContent = post.pseudo;
    head.append(who);
    if (post.isHost) {
      const crown = document.createElement("span");
      crown.className = "x-post-badge x-post-badge--host";
      crown.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#qg-crown-symbol"></use></svg>';
      head.append(crown);
    }
    if (Array.isArray(post.badges) && post.badges.includes("verified")) {
      const badge = document.createElement("span");
      badge.className = "x-post-badge x-post-badge--verified";
      badge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#qg-verified-symbol"></use></svg>';
      head.append(badge);
    }
    const when = document.createElement("span");
    when.className = "x-post-time";
    when.textContent = relativeTime(post.createdAt);
    head.append(when);

    const text = document.createElement("p");
    text.className = "x-post-text";
    text.textContent = post.text;

    const actions = document.createElement("div");
    actions.className = "x-post-actions";
    const like = document.createElement("button");
    like.type = "button";
    like.className = `x-post-action${post.liked ? " is-liked" : ""}`;
    like.dataset.action = "like";
    like.setAttribute("aria-pressed", String(Boolean(post.liked)));
    like.setAttribute("aria-label", post.liked ? "Retirer le like" : "Liker ce post");
    like.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.2 4.6 13a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9A4.6 4.6 0 1 1 19.4 13Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" /></svg>';
    const count = document.createElement("span");
    count.textContent = String(post.likes || 0);
    like.append(count);
    actions.append(like);

    const report = document.createElement("button");
    report.type = "button";
    report.className = "x-post-action x-post-action--quiet";
    report.dataset.action = "report";
    report.setAttribute("aria-label", `Signaler le post de ${post.pseudo}`);
    report.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6.2" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /><circle cx="17.8" cy="12" r="1.6" fill="currentColor" /></svg>';
    actions.append(report);

    if (post.canDelete) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "x-post-action x-post-action--quiet";
      remove.dataset.action = "delete";
      remove.setAttribute("aria-label", "Supprimer ce post");
      remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>';
      actions.append(remove);
    }

    body.append(head, text, actions);
    card.append(avatar, body);
    return card;
  };

  const paintFeed = (posts) => {
    if (!feedPostsNode) return;
    feedPostsNode.replaceChildren(...posts.map(createPostCard));
    if (feedEmpty) feedEmpty.hidden = posts.length > 0;
  };

  async function loadFeed({ mode = feedMode, quiet = false } = {}) {
    if (!feedPostsNode) return;
    if (!quiet) feedPostsNode.dataset.loading = "true";
    try {
      const url = new URL("/api/profile", window.location.origin);
      url.searchParams.set("feed", "1");
      url.searchParams.set("mode", mode);
      const response = await fetch(url.href, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return;
      paintFeed(Array.isArray(data.posts) ? data.posts : []);
    } catch {
      // Le fil reste sur son état vide : aucun écran cassé hors ligne.
    } finally {
      delete feedPostsNode.dataset.loading;
    }
  }

  // Liker / supprimer depuis le fil (délégation : aucun écouteur par post).
  feedPostsNode?.addEventListener("click", async (event) => {
    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    const card = actionButton.closest(".x-post");
    const postId = card?.dataset.postId;
    if (!postId) return;
    const action = actionButton.dataset.action;
    if (action === "report") {
      const who = card.querySelector(".x-post-who")?.textContent || "";
      openReportDialog({ pseudo: who, reasons: viewedProfile?.reasons, messageId: postId });
      return;
    }
    actionButton.disabled = true;
    try {
      const response = await fetch("/api/profile", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          action: action === "delete" ? "delete-post" : "like",
          postId,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401) forward("[data-member-login]");
        return;
      }
      if (action === "delete") {
        card.remove();
        if (feedPostsNode && !feedPostsNode.childElementCount) {
          if (feedEmpty) feedEmpty.hidden = false;
        }
        if (typeof renderProfileView === "function" && activeView === "profile") void renderProfileView();
        return;
      }
      const counter = actionButton.querySelector("span");
      const liked = data.liked === true;
      if (counter) counter.textContent = String(data.likes ?? 0);
      actionButton.classList.toggle("is-liked", liked);
      actionButton.setAttribute("aria-pressed", String(liked));
    } catch {
      // Rien à signaler : le bouton se réactive simplement.
    } finally {
      actionButton.disabled = false;
    }
  });

  const publishPost = async () => {
    if (!postComposer || !postSubmit) return;
    const text = String(postComposer.value || "").trim();
    if (!text) return;
    postSubmit.disabled = true;
    try {
      const response = await fetch("/api/profile", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ action: "post", text }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (composerNote) composerNote.textContent = data.error || "Le post n’a pas pu être publié.";
        if (response.status === 401) forward("[data-member-login]");
        return;
      }
      postComposer.value = "";
      postComposer.style.height = "";
      if (composerNote) {
        composerNote.textContent = "Seuls Gionny et les membres Validés publient des posts publics. Tu peux liker les posts dès maintenant.";
      }
      await loadFeed({ mode: feedMode });
    } catch {
      if (composerNote) composerNote.textContent = "Impossible de joindre le serveur. Réessaie.";
    } finally {
      postSubmit.disabled = false;
    }
  };

  postSubmit?.addEventListener("click", () => void publishPost());
  postComposer?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void publishPost();
    }
  });
  postComposer?.addEventListener("input", () => {
    postComposer.style.height = "auto";
    postComposer.style.height = `${Math.min(220, postComposer.scrollHeight)}px`;
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

  // Photo d'un profil : la sienne si elle existe, sinon la photo du QG.
  const FALLBACK_AVATAR = "/assets/gionny-profile.jpg";
  const hostAvatar = () => FALLBACK_AVATAR;

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

  /* ----------------------------------------------------------------------
     Séparation stricte : visiteur NON connecté / membre connecté
     ----------------------------------------------------------------------
     Un visiteur ne voit JAMAIS la photo ou le pseudo de Gionny comme s'il
     était connecté : pas d'avatar dans la barre, pas de zone de post, pas de
     profil, pas de réglages de compte. `currentUser` vient uniquement du DOM
     que `script.js` remplit après la connexion.
     ---------------------------------------------------------------------- */
  const currentUser = () => {
    if (!isSignedIn()) return null;
    const pseudo = ($("[data-member-pseudo]")?.textContent || "").trim();
    const avatarNode = $("[data-member-avatar]");
    const avatarData = avatarNode && !avatarNode.hidden && /^data:image\//u.test(avatarNode.getAttribute("src") || "")
      ? avatarNode.getAttribute("src")
      : "";
    const isHost = Boolean($("[data-member-crown]") && !$("[data-member-crown]").hidden);
    const isVerified = Boolean($("[data-member-verified-badge]") && !$("[data-member-verified-badge]").hidden);
    return { pseudo, avatarData, isHost, isVerified };
  };

  // Photo du membre connecté, ou l'icône générique : jamais celle de Gionny.
  const composerAvatar = $("[data-x-composer-avatar]");
  const composerAvatarFallback = composerAvatar?.parentElement?.querySelector("svg") || null;

  const applyComposerRights = (user) => {
    if (!postComposer || !postSubmit) return;
    const canPost = Boolean(user && (user.isHost || user.isVerified));
    postSubmit.disabled = !canPost;
    postComposer.readOnly = !canPost;
    postComposer.placeholder = canPost
      ? "Quoi de neuf dans le QG ?"
      : "Seuls Gionny et les membres Validés publient des posts publics";
    if (composerNote) {
      composerNote.textContent = canPost
        ? "Ton post est visible par toute la commu du QG."
        : "Seuls Gionny et les membres Validés publient des posts publics. Tu peux liker les posts dès maintenant.";
    }
  };

  const applyIdentityGates = (user) => {
    $$("[data-x-member-only]").forEach((node) => { node.hidden = !user; });
    // Les blocs « membre » des vues Notifications / Messages / Paramètres
    // restent masqués pour un visiteur, même s'ils n'ont pas le marqueur.
    $$('[data-x-view="notifications"] .x-empty, [data-x-view="messages"] .x-dm').forEach((node) => {
      node.hidden = !user;
    });
    $$("[data-x-guest-card]").forEach((node) => { node.hidden = Boolean(user); });
    $$("[data-x-guest-panel]").forEach((node) => { node.hidden = Boolean(user); });
    $$("[data-x-profile-self-only]").forEach((node) => { node.hidden = !user; });
    if (composerAvatar) {
      composerAvatar.hidden = !user || !user.avatarData;
      if (user?.avatarData && composerAvatar.getAttribute("src") !== user.avatarData) {
        composerAvatar.src = user.avatarData;
      }
      if (composerAvatarFallback) composerAvatarFallback.hidden = !composerAvatar.hidden;
    }
  };

  const syncAccountNow = () => {
    const user = currentUser();
    const signedIn = Boolean(user);

    applyIdentityGates(user);
    applyComposerRights(user);

    if (railCard) railCard.hidden = !signedIn;
    if (railAuth) railAuth.hidden = signedIn;

    setText(railPseudo, user?.pseudo || "");
    setText(railHandle, user?.pseudo ? `@${user.pseudo.replace(/\s+/gu, "")}` : "");

    if (railCrown) railCrown.toggleAttribute("hidden", !user?.isHost);
    if (railVerified) railVerified.toggleAttribute("hidden", !user?.isVerified);

    if (railAvatar) {
      const src = user?.avatarData || "";
      railAvatar.hidden = !src;
      if (src && railAvatar.getAttribute("src") !== src) railAvatar.src = src;
      const fallback = railAvatar.parentElement?.querySelector("svg");
      if (fallback) fallback.toggleAttribute("hidden", Boolean(src));
    }
    if (mobileAvatar) {
      // Déconnecté : l'icône « profil » générique, comme sur X. Connecté : la photo.
      const fallbackIcon = mobileAvatar.parentElement?.querySelector("svg");
      mobileAvatar.hidden = !signedIn || !user.avatarData;
      if (fallbackIcon) fallbackIcon.style.display = mobileAvatar.hidden ? "block" : "none";
      if (user?.avatarData && mobileAvatar.getAttribute("src") !== user.avatarData) {
        mobileAvatar.src = user.avatarData;
      }
    }

    const adminLink = $("[data-x-admin]");
    const adminSource = $("[data-host-admin-link]");
    if (adminLink && adminSource) adminLink.hidden = adminSource.hidden;

    // Le profil affiché est re-rendu : soit le sien, soit celui déjà ouvert.
    if (activeView === "profile") renderProfileView();
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
  void loadFeed();

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
