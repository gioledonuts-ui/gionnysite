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
    // Ouvrir l'onglet Notifications marque tout comme lu (badge remis à zéro).
    if (view === "notifications") void refreshNotifications({ markRead: true });
    // Paramètres : on relit les réglages réels du compte à chaque ouverture.
    if (view === "settings") void loadSettings({ quiet: true });
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
  const profileLock = $("[data-x-profile-lock]");
  const profilePrivateNote = $("[data-x-profile-private]");
  const profileTabsNode = $("[data-x-profile-tabs]");

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
      setText(profileDiscordName, discord ? `Discord : @${discord}` : "");
    }

    // Étape 4 · compte privé : cadenas à côté du pseudo, activité masquée.
    const isPrivate = profile?.isPrivate === true;
    const canSeeActivity = profile ? profile.canSeeActivity !== false : true;
    if (profileLock) profileLock.hidden = !isPrivate;
    if (profilePrivateNote) {
      profilePrivateNote.hidden = !isPrivate || canSeeActivity;
      profilePrivateNote.textContent = isPrivate && !canSeeActivity
        ? profile?.privateMessage || "Ce compte est privé. Seuls ses abonnés approuvés et le QG peuvent voir son activité."
        : "";
    }
    if (profileTabsNode) profileTabsNode.hidden = !canSeeActivity;
    const profileFeedNodeForPrivacy = $("[data-x-profile-feed]");
    if (profileFeedNodeForPrivacy) profileFeedNodeForPrivacy.hidden = !canSeeActivity;
    // Le suivi reste possible (l'abonné verra l'activité), la confidentialité
    // ne bloque jamais le bouton Suivre.

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
        // Le propriétaire voit toujours son propre profil, même privé.
        isPrivate: viewerProfile?.isPrivate === true,
        canSeeActivity: true,
      };
      // Le compteur d'abonnés du profil vient du serveur : on le recharge.
      void loadPublicProfile(user.pseudo).then(() => {
        if (activeView !== "profile") return;
        if (viewedProfilePseudo) return;
        const refreshed = viewedProfile;
        if (refreshed) myProfile.followersCount = refreshed.followersCount;
        myProfile.isHost = refreshed?.isHost ?? myProfile.isHost;
        myProfile.badges = refreshed?.badges || myProfile.badges;
        myProfile.isPrivate = refreshed?.isPrivate ?? myProfile.isPrivate;
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
    follows: "Les posts des membres que tu suis apparaissent ici.",
    verified: "Seuls les posts de Gionny et des membres Validés apparaissent ici.",
    reposts: "Les posts que le QG a repostés apparaissent ici.",
  };
  const feedState = $("[data-x-feed-state]");

  let feedMode = "all";

  $$("[data-x-feed-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$("[data-x-feed-tab]").forEach((other) =>
        other.setAttribute("aria-selected", String(other === tab))
      );
      const wanted = String(tab.dataset.xFeedTab || "all");
      feedMode = ["all", "follows", "verified", "reposts"].includes(wanted) ? wanted : "all";
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

  /* ------------------------------------------------------------------------
     Médias : image, vocal, vidéo — compressés dans le navigateur
     ----------------------------------------------------------------------
     Rien de lourd ne part vers le serveur : une image est ré-encodée en WebP
     (max 120 Ko), une vidéo est ré-encodée si le navigateur sait le faire
     (max ~2,6 Mo visés, 3 Mo refusés côté API), un vocal reste en dessous de
     200 Ko grâce à l'enregistreur du chat.
     -------------------------------------------------------------------- */
  const MEDIA_LIMITS = { image: 60 * 1024, vocal: 200 * 1024, video: 2 * 1024 * 1024 };
  const MEDIA_MAX_SECONDS = { video: 30, vocal: 60 };
  const MEDIA_LIMIT_COPY = {
    image: "Image trop lourde : 60 Ko maximum après compression (800 px).",
    vocal: "Vocal trop long : 60 secondes et 200 Ko maximum.",
    video: "Vidéo trop longue ou trop lourde : 30 secondes et 2 Mo maximum.",
  };

  const readFileAsDataUrl = (blob) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("read_failed"));
      reader.readAsDataURL(blob);
    });

  const dataUrlPayload = (value) => {
    const text = String(value || "");
    const comma = text.indexOf(",");
    return comma >= 0 ? text.slice(comma + 1) : "";
  };

  const formatBytes = (bytes) => {
    const size = Math.max(0, Number(bytes) || 0);
    if (size < 1024) return `${size} o`;
    if (size < 1024 * 1024) return `${Math.round(size / 1024)} Ko`;
    return `${(size / (1024 * 1024)).toFixed(1).replace(".", ",")} Mo`;
  };

  // Image : on réutilise le compresseur WebP du chat (image-tools.js).
  const compressImageForPost = async (file) => {
    if (typeof window.qgImageTools?.compressToWebp !== "function") {
      throw new Error("Ce navigateur ne peut pas compresser l’image.");
    }
    const blob = await window.qgImageTools.compressToWebp(file, {
      maxWidth: 800,
      maxHeight: 800,
      preserveDimensions: true,
      maxBytes: MEDIA_LIMITS.image,
      initialQuality: 0.7,
    });
    if (!blob || blob.size > MEDIA_LIMITS.image) throw new Error("too_large");
    return blob;
  };

  // Vidéo : ré-encodage dans un <canvas> + MediaRecorder quand c'est possible.
  // Si le navigateur ne sait pas le faire, on refuse proprement plutôt que
  // d'envoyer 40 Mo qui feraient échouer le post.
  const compressVideoForPost = async (file, onProgress) => {
    if (!file || !file.type.startsWith("video/")) throw new Error("not_video");
    if (!(file.size > 0)) throw new Error("empty");
    const Recorder = window.MediaRecorder;
    const canTranscode = typeof Recorder === "function" &&
      typeof document.createElement("canvas").captureStream === "function" &&
      typeof URL.createObjectURL === "function";
    if (!canTranscode) throw new Error("unsupported");

    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    try {
      await new Promise((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("not_video"));
      });
      const fullDuration = Number(video.duration) || 0;
      if (!fullDuration) throw new Error("not_video");
      // Clip court uniquement : au-delà de 30 s, on refuse au lieu de tronquer
      // silencieusement le contenu de l'utilisateur.
      if (fullDuration > MEDIA_MAX_SECONDS.video + 0.5) throw new Error("too_long");
      const duration = Math.min(MEDIA_MAX_SECONDS.video, fullDuration);
      const scale = Math.min(1, 720 / Math.max(video.videoWidth || 720, video.videoHeight || 720));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(2, Math.round((video.videoWidth || 720) * scale));
      canvas.height = Math.max(2, Math.round((video.videoHeight || 720) * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("unsupported");
      const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
        .find((type) => Recorder.isTypeSupported?.(type));
      if (!mimeType) throw new Error("unsupported");
      const stream = canvas.captureStream(24);
      const recorder = new Recorder(stream, { mimeType, videoBitsPerSecond: 900_000 });
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunks.push(event.data);
      };
      const done = new Promise((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start(200);
      await video.play();
      let stopped = false;
      await new Promise((resolve) => {
        const draw = () => {
          if (stopped) return;
          if (video.paused || video.ended || video.currentTime >= duration) {
            resolve();
            return;
          }
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          onProgress?.(Math.min(1, video.currentTime / duration));
          window.requestAnimationFrame(draw);
        };
        draw();
      });
      stopped = true;
      recorder.stop();
      stream.getTracks().forEach((track) => track.stop());
      await done;
      const blob = new Blob(chunks, { type: "video/webm" });
      if (!blob.size) throw new Error("unsupported");
      if (blob.size > MEDIA_LIMITS.video) throw new Error("too_large");
      return { blob, duration: Math.round(duration) };
    } finally {
      URL.revokeObjectURL(url);
      video.removeAttribute("src");
    }
  };

  /* ------------------------------------------------------------------------
     Le composeur : aperçu, médias, emojis, publication
     -------------------------------------------------------------------- */
  const composerNode = $("[data-x-composer]");
  const attachmentBox = $("[data-x-composer-attachment]");
  const attachmentPreview = $("[data-x-composer-attachment-media]");
  const attachmentName = $("[data-x-composer-attachment-name]");
  const attachmentMeta = $("[data-x-composer-attachment-meta]");
  const attachmentRemove = $("[data-x-composer-attachment-remove]");
  const imageInput = $("[data-x-post-image-input]");
  const videoInput = $("[data-x-post-video-input]");
  const vocalButton = $("[data-x-post-vocal]");
  const emojiButton = $("[data-x-post-emoji]");
  const emojiPanel = $("[data-x-emoji-panel]");
  const emojiGrid = $("[data-x-emoji-grid]");
  const postCount = $("[data-x-post-count]");
  const recorderBox = $("[data-x-post-recorder]");
  const recorderLive = $("[data-x-recorder-live]");
  const recorderWave = $("[data-x-recorder-wave]");
  const recorderPreview = $("[data-x-recorder-preview]");
  const recorderTimer = $("[data-x-recorder-timer]");
  const recorderStatus = $("[data-x-recorder-status]");
  const recorderStop = $("[data-x-recorder-stop]");
  const recorderCancel = $("[data-x-recorder-cancel]");
  const recorderSend = $("[data-x-recorder-send]");

  let draftMedia = null;          // { kind, blob, alt, duration, url }
  let mediaBusy = false;
  let composerUser = null;        // dernier état connu du compte connecté

  const clearDraftMedia = () => {
    if (draftMedia?.url) URL.revokeObjectURL(draftMedia.url);
    draftMedia = null;
    if (attachmentPreview) attachmentPreview.replaceChildren();
    if (attachmentBox) attachmentBox.hidden = true;
    if (attachmentName) attachmentName.textContent = "";
    if (attachmentMeta) attachmentMeta.textContent = "";
    syncComposerState();
  };

  const paintDraftMedia = () => {
    if (!attachmentBox || !attachmentPreview) return;
    if (!draftMedia) {
      attachmentBox.hidden = true;
      return;
    }
    attachmentPreview.replaceChildren();
    if (draftMedia.kind === "image") {
      const image = document.createElement("img");
      image.src = draftMedia.url;
      image.alt = draftMedia.alt || "Image du post";
      image.loading = "lazy";
      attachmentPreview.append(image);
      if (attachmentName) attachmentName.textContent = "Photo";
      if (attachmentMeta) attachmentMeta.textContent = `${formatBytes(draftMedia.blob.size)} · WebP compressé`;
    } else if (draftMedia.kind === "video") {
      const video = document.createElement("video");
      video.src = draftMedia.url;
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      attachmentPreview.append(video);
      if (attachmentName) attachmentName.textContent = "Vidéo";
      if (attachmentMeta) {
        attachmentMeta.textContent = `${draftMedia.duration || 0} s · ${formatBytes(draftMedia.blob.size)} · compressée`;
      }
    } else {
      const badge = document.createElement("span");
      badge.className = "x-composer-attachment-vocal";
      badge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2.8" width="6" height="11.4" rx="3" fill="none" stroke="currentColor" stroke-width="1.8" /><path d="M5.6 11.6a6.4 6.4 0 0 0 12.8 0M12 18v3.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>';
      attachmentPreview.append(badge);
      if (attachmentName) attachmentName.textContent = "Message vocal";
      if (attachmentMeta) {
        attachmentMeta.textContent = `${draftMedia.duration || 0} s · ${formatBytes(draftMedia.blob.size)}`;
      }
    }
    attachmentBox.hidden = false;
    syncComposerState();
  };

  const syncComposerState = () => {
    if (!postComposer || !postSubmit) return;
    const user = composerUser || currentUser();
    const canPost = Boolean(user && (user.isHost || user.isVerified));
    const hasText = Boolean(String(postComposer.value || "").trim());
    postSubmit.disabled = !canPost || mediaBusy || (!hasText && !draftMedia);
    if (postCount) {
      const length = String(postComposer.value || "").length;
      postCount.hidden = length < 400;
      postCount.textContent = `${length}/500`;
      postCount.dataset.warn = String(length >= 480);
    }
  };

  const setComposerNote = (message) => {
    if (!composerNote) return;
    composerNote.textContent = message ||
      "Seuls Gionny et les membres Validés publient des posts publics. Tu peux liker et reposter les posts dès maintenant.";
  };

  // Image
  $("[data-x-post-image]")?.addEventListener("click", () => imageInput?.click());
  imageInput?.addEventListener("change", async () => {
    const file = imageInput.files?.[0];
    imageInput.value = "";
    if (!file) return;
    mediaBusy = true;
    syncComposerState();
    setComposerNote("Compression de l’image…");
    try {
      const blob = await compressImageForPost(file);
      clearDraftMedia();
      draftMedia = { kind: "image", blob, alt: "", duration: 0, url: URL.createObjectURL(blob) };
      paintDraftMedia();
      setComposerNote("");
    } catch (error) {
      setComposerNote(error?.message === "too_large" ? MEDIA_LIMIT_COPY.image : "Cette image ne peut pas être ajoutée.");
    } finally {
      mediaBusy = false;
      syncComposerState();
    }
  });

  // Vidéo
  $("[data-x-post-video]")?.addEventListener("click", () => videoInput?.click());
  videoInput?.addEventListener("change", async () => {
    const file = videoInput.files?.[0];
    videoInput.value = "";
    if (!file) return;
    mediaBusy = true;
    syncComposerState();
    setComposerNote("Compression de la vidéo… (garde l’onglet ouvert)");
    try {
      const result = await compressVideoForPost(file, (progress) => {
        setComposerNote(`Compression de la vidéo… ${Math.round(progress * 100)} %`);
      });
      clearDraftMedia();
      draftMedia = {
        kind: "video",
        blob: result.blob,
        alt: "",
        duration: result.duration,
        url: URL.createObjectURL(result.blob),
      };
      paintDraftMedia();
      setComposerNote("");
    } catch (error) {
      const reason = error?.message;
      setComposerNote(
        reason === "too_large"
          ? MEDIA_LIMIT_COPY.video
          : reason === "unsupported"
            ? "Ce navigateur ne sait pas compresser la vidéo : envoie-la en photo ou en vocal."
            : "Cette vidéo ne peut pas être ajoutée."
      );
    } finally {
      mediaBusy = false;
      syncComposerState();
    }
  });

  attachmentRemove?.addEventListener("click", () => {
    clearDraftMedia();
    setComposerNote("");
  });

  // Emojis : grille curated, insertion au curseur, rendu Twemoji dans le post.
  const EMOJIS = [
    "😀", "😂", "🥲", "😍", "😎", "🤔", "😴", "🥳", "😭", "😱",
    "🔥", "💜", "✨", "🎉", "👑", "🏆", "🎮", "🎧", "🎬", "📣",
    "👀", "🙌", "👏", "🤝", "💪", "🫡", "🫶", "❤️", "💯", "⚡",
    "🌙", "☀️", "🌊", "🍩", "🍕", "☕", "🚀", "🎯", "💬", "✅",
  ];

  const buildEmojiGrid = () => {
    if (!emojiGrid || emojiGrid.childElementCount) return;
    const fragment = document.createDocumentFragment();
    EMOJIS.forEach((emoji) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "x-emoji";
      button.textContent = emoji;
      button.setAttribute("aria-label", `Emoji ${emoji}`);
      button.addEventListener("click", () => insertEmoji(emoji));
      fragment.append(button);
    });
    emojiGrid.append(fragment);
  };

  const insertEmoji = (emoji) => {
    if (!postComposer) return;
    const start = postComposer.selectionStart ?? postComposer.value.length;
    const end = postComposer.selectionEnd ?? start;
    postComposer.value = `${postComposer.value.slice(0, start)}${emoji}${postComposer.value.slice(end)}`;
    const caret = start + emoji.length;
    postComposer.focus();
    postComposer.setSelectionRange(caret, caret);
    autoGrowComposer();
    syncComposerState();
  };

  emojiButton?.addEventListener("click", () => {
    if (!emojiPanel) return;
    buildEmojiGrid();
    const open = emojiPanel.hidden;
    emojiPanel.hidden = !open;
    emojiButton.setAttribute("aria-expanded", String(open));
  });

  const autoGrowComposer = () => {
    if (!postComposer) return;
    postComposer.style.height = "auto";
    postComposer.style.height = `${Math.min(220, postComposer.scrollHeight)}px`;
  };

  /* --- Enregistreur vocal du composeur --------------------------------- */
  let composerRecorder = null;
  const ensureComposerRecorder = () => {
    if (composerRecorder || typeof window.createQGVoiceComposer !== "function") return composerRecorder;
    if (!recorderBox || !recorderLive || !recorderWave || !recorderTimer || !recorderStop ||
        !recorderCancel || !recorderSend || !recorderPreview || !vocalButton || !recorderStatus) {
      return null;
    }
    composerRecorder = window.createQGVoiceComposer({
      inputPill: vocalButton,
      panel: recorderBox,
      liveControls: recorderLive,
      waveform: recorderWave,
      timer: recorderTimer,
      stopButton: recorderStop,
      cancelButton: recorderCancel,
      sendButton: recorderSend,
      preview: recorderPreview,
      composeButton: postSubmit,
      plusButton: null,
      status: recorderStatus,
      label: "vocal du post",
      canRecord: () => {
        const user = currentUser();
        return Boolean(user && (user.isHost || user.isVerified));
      },
      canSend: () => true,
      onSend: async (blob) => {
        if (!blob || !blob.size) return false;
        if (blob.size > MEDIA_LIMITS.vocal) {
          if (recorderStatus) recorderStatus.textContent = MEDIA_LIMIT_COPY.vocal;
          return false;
        }
        clearDraftMedia();
        const duration = composerRecorder?.getDuration?.() || 0;
        draftMedia = {
          kind: "vocal",
          blob,
          alt: "",
          duration: Math.round(duration),
          url: URL.createObjectURL(blob),
        };
        paintDraftMedia();
        setComposerNote("");
        return true;
      },
    });
    return composerRecorder;
  };

  vocalButton?.addEventListener("click", () => {
    const recorder = ensureComposerRecorder();
    if (!recorder) {
      setComposerNote("Ce navigateur ne peut pas enregistrer de vocal. Tu peux publier un texte ou une image.");
      return;
    }
  });

  /* --- Publication ------------------------------------------------------ */
  const postJson = async (payload) => {
    const response = await fetch("/api/profile", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  };

  const publishPost = async () => {
    if (!postComposer || !postSubmit) return;
    const text = String(postComposer.value || "").trim();
    const media = draftMedia;
    if (!text && !media) return;
    postSubmit.disabled = true;
    mediaBusy = true;
    syncComposerState();
    setComposerNote("Publication…");
    try {
      const { response, data } = await postJson({
        action: "post",
        text,
        media: media ? { kind: media.kind, alt: media.alt, duration: media.duration } : null,
      });
      if (!response.ok) {
        if (response.status === 401) forward("[data-member-login]");
        setComposerNote(data.error || "Le post n’a pas pu être publié.");
        return;
      }
      const postId = data?.post?.id || "";
      if (media && postId) {
        const mediaData = dataUrlPayload(await readFileAsDataUrl(media.blob));
        const upload = await postJson({
          action: "media",
          postId,
          kind: media.kind,
          contentType: media.blob.type || undefined,
          mediaData,
        });
        if (!upload.response.ok) {
          // Le post texte existe déjà : on prévient sans le supprimer.
          setComposerNote(upload.data?.error || "Le post est publié, mais le média n’a pas pu être joint.");
        }
      }
      postComposer.value = "";
      postComposer.style.height = "";
      clearDraftMedia();
      if (emojiPanel) emojiPanel.hidden = true;
      setComposerNote("");
      await loadFeed({ mode: feedMode });
      void refreshNotifications({ quiet: true });
    } catch {
      setComposerNote("Impossible de joindre le serveur. Réessaie.");
    } finally {
      mediaBusy = false;
      syncComposerState();
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
    autoGrowComposer();
    syncComposerState();
  });

  const quitComposerTransients = () => {
    if (emojiPanel) emojiPanel.hidden = true;
    emojiButton?.setAttribute("aria-expanded", "false");
  };
  document.addEventListener("click", (event) => {
    if (!emojiPanel || emojiPanel.hidden) return;
    if (emojiPanel.contains(event.target) || emojiButton?.contains(event.target)) return;
    quitComposerTransients();
  });

  /* ------------------------------------------------------------------------
     Une carte de post : texte, média, likes, reposts, signalement, suppression
     -------------------------------------------------------------------- */
  /* ------------------------------------------------------------------------
     Toast discret (lien copié, action confirmée)
     -------------------------------------------------------------------- */
  const toastNode = $("[data-qg-toast]");
  let toastTimer = 0;
  const showToast = (message) => {
    if (!toastNode || !message) return;
    toastNode.textContent = message;
    toastNode.hidden = false;
    toastNode.dataset.visible = "true";
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastNode.dataset.visible = "false";
      toastNode.hidden = true;
    }, 2400);
  };

  /* ------------------------------------------------------------------------
     Médias d'un post : image (zoom), vocal (pilule style X), vidéo
     -------------------------------------------------------------------- */
  // Pilule vocale : bouton blanc, spectre de barres, durée — construite ici pour
  // rester dans la palette du QG (le lecteur du chat a ses propres couleurs).
  const createVocalPill = (media) => {
    const pill = document.createElement("div");
    pill.className = "x-vocal-pill";
    pill.dataset.state = "idle";

    const play = document.createElement("button");
    play.type = "button";
    play.className = "x-vocal-play";
    play.setAttribute("aria-label", "Lire la note vocale");
    play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.4 4.9a1.5 1.5 0 0 1 2.2-1.3l10 6.7a2 2 0 0 1 0 3.4l-10 6.7a1.5 1.5 0 0 1-2.2-1.3V4.9Z" fill="currentColor" /></svg>';

    const wave = document.createElement("div");
    wave.className = "x-vocal-wave";
    const bars = [];
    for (let index = 0; index < 34; index += 1) {
      const bar = document.createElement("span");
      bar.className = "x-vocal-bar";
      bar.style.setProperty("--bar", `${22 + ((index * 37 + 13) % 70)}%`);
      wave.append(bar);
      bars.push(bar);
    }

    const time = document.createElement("span");
    time.className = "x-vocal-time";
    const total = Math.max(0, Number(media.duration) || 0);
    const format = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
    time.textContent = total ? format(total) : "--:--";

    const audio = document.createElement("audio");
    audio.preload = "none";
    audio.src = media.url;
    audio.hidden = true;

    const paintProgress = () => {
      const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : total;
      const ratio = duration ? Math.min(1, audio.currentTime / duration) : 0;
      bars.forEach((bar, index) => {
        bar.classList.toggle("is-played", index / bars.length <= ratio);
      });
      if (duration) time.textContent = `${format(audio.currentTime)} / ${format(duration)}`;
    };

    const toggle = () => {
      if (audio.paused) {
        void audio.play().catch(() => {
          pill.dataset.state = "error";
        });
      } else {
        audio.pause();
      }
    };

    play.addEventListener("click", toggle);
    wave.addEventListener("click", (event) => {
      const rect = wave.getBoundingClientRect();
      const duration = Number.isFinite(audio.duration) ? audio.duration : total;
      if (!rect.width || !duration) return;
      audio.currentTime = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * duration;
      paintProgress();
    });
    audio.addEventListener("play", () => {
      pill.dataset.state = "playing";
      play.setAttribute("aria-label", "Mettre la note vocale en pause");
      play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.6h3.4v14.8H7zM13.6 4.6H17v14.8h-3.4z" fill="currentColor" /></svg>';
      const tick = () => {
        if (audio.paused) return;
        paintProgress();
        window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    });
    audio.addEventListener("pause", () => {
      pill.dataset.state = "idle";
      play.setAttribute("aria-label", "Lire la note vocale");
      play.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.4 4.9a1.5 1.5 0 0 1 2.2-1.3l10 6.7a2 2 0 0 1 0 3.4l-10 6.7a1.5 1.5 0 0 1-2.2-1.3V4.9Z" fill="currentColor" /></svg>';
      paintProgress();
    });
    audio.addEventListener("ended", () => {
      audio.currentTime = 0;
      paintProgress();
    });
    audio.addEventListener("loadedmetadata", paintProgress);

    pill.append(play, wave, time, audio);
    return pill;
  };

  const createMediaNode = (media, { compact = false } = {}) => {
    if (!media) return null;
    const wrap = document.createElement("div");
    wrap.className = `x-post-media x-post-media--${media.kind}${compact ? " x-post-media--compact" : ""}`;
    if (media.kind === "image") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "x-post-media-image";
      button.setAttribute("aria-label", "Agrandir l’image");
      const image = document.createElement("img");
      image.src = media.url;
      image.alt = media.alt || "Image du post";
      image.loading = "lazy";
      image.decoding = "async";
      button.append(image);
      button.addEventListener("click", () => {
        if (typeof window.qgImageTools?.openImageViewer === "function") {
          window.qgImageTools.openImageViewer(media.url, media.alt || "Image du post");
          return;
        }
        window.open(media.url, "_blank", "noopener");
      });
      wrap.append(button);
      return wrap;
    }
    if (media.kind === "video") {
      const video = document.createElement("video");
      video.className = "x-post-media-video";
      video.src = media.url;
      video.controls = true;
      video.playsInline = true;
      video.preload = "metadata";
      if (media.duration) video.dataset.duration = String(media.duration);
      wrap.append(video);
      return wrap;
    }
    wrap.append(createVocalPill(media));
    return wrap;
  };

  const postActionIcon = {
    like: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.2 4.6 13a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9A4.6 4.6 0 1 1 19.4 13Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" /></svg>',
    likeFull: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.2 4.6 13a4.6 4.6 0 0 1 6.5-6.5l.9.9.9-.9A4.6 4.6 0 1 1 19.4 13Z" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" /></svg>',
    repost: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 8.6h9.8a2.4 2.4 0 0 1 2.4 2.4v3.4M17.6 15.4l-2.4-2.4M17.6 15.4l-2.4 2.4M17.6 15.4H7.8a2.4 2.4 0 0 1-2.4-2.4V9.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.4v11.2M8.2 7.2 12 3.4l3.8 3.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /><path d="M5.4 13.4v4.8a2.4 2.4 0 0 0 2.4 2.4h8.4a2.4 2.4 0 0 0 2.4-2.4v-4.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg>',
    quiet: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.4" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="12" r="1.6" fill="currentColor" /><circle cx="18.6" cy="12" r="1.6" fill="currentColor" /></svg>',
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.4 3.8h5.2l-.7 4.3 3.1 3.1H6.8l3.1-3.1-.5-4.3ZM12 11.2v6.4M9.6 20.4 12 17.6l2.4 2.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></svg>',
    crown: '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#qg-crown-symbol"></use></svg>',
  };

  // Temps relatif court : « à l’instant », « 2 min », « 1 h », « 3 j ».
  const shortTime = (value) => {
    const date = Date.parse(value || "");
    if (!Number.isFinite(date)) return "";
    const seconds = Math.round((Date.now() - date) / 1000);
    if (seconds < 60) return "à l’instant";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h`;
    const days = Math.round(hours / 24);
    if (days < 7) return `${days} j`;
    return new Date(date).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  };

  /* ------------------------------------------------------------------------
     Une carte de post : épinglé/republié, texte, média, actions, menu •••
     -------------------------------------------------------------------- */
  const closePostMenus = (except) => {
    $$(".x-post-menu").forEach((menu) => {
      if (menu === except) return;
      menu.hidden = true;
      menu.closest(".x-post-menu-wrap")?.querySelector("[data-post-menu-button]")?.setAttribute("aria-expanded", "false");
    });
  };

  const buildPostMenu = (post) => {
    const wrap = document.createElement("div");
    wrap.className = "x-post-menu-wrap";
    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "x-post-menu-button";
    trigger.dataset.postMenuButton = "";
    trigger.setAttribute("aria-label", "Options du post");
    trigger.setAttribute("aria-expanded", "false");
    trigger.innerHTML = postActionIcon.quiet;

    const menu = document.createElement("div");
    menu.className = "x-post-menu";
    menu.setAttribute("role", "menu");
    menu.hidden = true;

    const item = (label, action, { danger = false } = {}) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `x-post-menu-item${danger ? " x-post-menu-item--danger" : ""}`;
      button.setAttribute("role", "menuitem");
      button.dataset.postMenuAction = action;
      button.textContent = label;
      return button;
    };

    if (post.canPin) {
      menu.append(item(post.pinned ? "Désépingler" : "Épingler en haut du QG", post.pinned ? "unpin" : "pin"));
    }
    if (post.canDelete) menu.append(item("Supprimer le post", "delete", { danger: true }));
    menu.append(item("Signaler ce post", "report"));
    if (!post.isMine) menu.append(item(`Bloquer @${post.pseudo}`, "block", { danger: true }));

    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = menu.hidden;
      closePostMenus(menu);
      menu.hidden = !open;
      trigger.setAttribute("aria-expanded", String(open));
    });

    wrap.append(trigger, menu);
    return wrap;
  };

  const createPostCard = (post) => {
    const card = document.createElement("article");
    card.className = "x-post";
    card.dataset.postId = post.id;
    if (post.pinned) card.dataset.pinned = "true";
    post.isMine = Boolean(currentUser() && post.pseudo && currentUser().pseudo.toLowerCase() === String(post.pseudo).toLowerCase());

    const body = document.createElement("div");
    body.className = "x-post-body";

    // Ligne de contexte : épinglé (Hôte) ou republié (membre).
    if (post.pinned) {
      const pinned = document.createElement("p");
      pinned.className = "x-post-context x-post-context--pinned";
      pinned.innerHTML = `${postActionIcon.pin}<span>Post épinglé par Gionny</span>`;
      body.append(pinned);
    } else if (post.repostedBy) {
      const reposted = document.createElement("p");
      reposted.className = "x-post-context x-post-context--repost";
      reposted.innerHTML = `${postActionIcon.repost}<span>Republié par <strong>@${post.repostedBy}</strong></span>`;
      body.append(reposted);
    }

    const row = document.createElement("div");
    row.className = "x-post-row";

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

    const column = document.createElement("div");
    column.className = "x-post-column";

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
      crown.title = "Hôte du QG";
      crown.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#qg-crown-symbol"></use></svg>';
      head.append(crown);
    }
    if (Array.isArray(post.badges) && post.badges.includes("verified")) {
      const badge = document.createElement("span");
      badge.className = "x-post-badge x-post-badge--verified";
      badge.title = "Membre Validé";
      badge.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><use href="#qg-verified-symbol"></use></svg>';
      head.append(badge);
    }
    const handle = document.createElement("span");
    handle.className = "x-post-handle";
    handle.textContent = post.handle || `@${String(post.pseudo || "").replace(/\s+/gu, "")}`;
    const dot = document.createElement("span");
    dot.className = "x-post-dot";
    dot.textContent = "·";
    const when = document.createElement("span");
    when.className = "x-post-time";
    when.textContent = shortTime(post.createdAt);
    head.append(handle, dot, when);

    const menu = buildPostMenu(post);
    head.append(menu);

    column.append(head);

    if (post.text) {
      const text = document.createElement("p");
      text.className = "x-post-text";
      text.textContent = post.text;
      column.append(text);
    }
    const mediaNode = createMediaNode(post.media);
    if (mediaNode) column.append(mediaNode);

    // Barre d'actions : repost, j'aime, partager.
    const actions = document.createElement("div");
    actions.className = "x-post-actions";

    const repost = document.createElement("button");
    repost.type = "button";
    repost.className = `x-post-action x-post-action--repost${post.reposted ? " is-reposted" : ""}`;
    repost.dataset.action = "repost";
    repost.setAttribute("aria-pressed", String(Boolean(post.reposted)));
    repost.setAttribute("aria-label", post.reposted ? "Annuler le repost" : "Reposter ce post");
    repost.innerHTML = postActionIcon.repost;
    const repostCount = document.createElement("span");
    repostCount.textContent = String(post.reposts || 0);
    repost.append(repostCount);

    const like = document.createElement("button");
    like.type = "button";
    like.className = `x-post-action x-post-action--like${post.liked ? " is-liked" : ""}`;
    like.dataset.action = "like";
    like.setAttribute("aria-pressed", String(Boolean(post.liked)));
    like.setAttribute("aria-label", post.liked ? "Retirer le like" : "Liker ce post");
    like.innerHTML = post.liked ? postActionIcon.likeFull : postActionIcon.like;
    const likeCount = document.createElement("span");
    likeCount.textContent = String(post.likes || 0);
    like.append(likeCount);

    const share = document.createElement("button");
    share.type = "button";
    share.className = "x-post-action x-post-action--share";
    share.dataset.action = "share";
    share.setAttribute("aria-label", "Copier le lien du post");
    share.innerHTML = postActionIcon.share;

    actions.append(repost, like, share);
    column.append(actions);

    row.append(avatar, column);
    body.append(row);
    card.append(body);

    window.qgTwemoji?.render?.(card);
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
      // Préférence « Masquer les comptes non-validés », activée par défaut.
      if (hideUnverifiedEnabled()) url.searchParams.set("hideUnverified", "1");
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

  // Liker / reposter / supprimer depuis le fil (délégation, zéro écouteur par post).
  const feedAction = async (actionButton, container) => {
    const card = actionButton.closest(".x-post");
    const postId = card?.dataset.postId;
    if (!postId) return;
    const action = actionButton.dataset.action;
    if (action === "share") {
      const permalink = `${window.location.origin}/post/${encodeURIComponent(postId)}`;
      // 1. partage natif, 2. presse-papiers, 3. repli manuel : jamais de cul-de-sac.
      try {
        if (typeof navigator.share === "function") {
          await navigator.share({ url: permalink, title: "QG2GIONNY" });
          return;
        }
      } catch {
        // Partage annulé par l'utilisateur : on ne dit rien.
        return;
      }
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(permalink);
          showToast("Lien copié");
          return;
        }
      } catch {
        // Presse-papiers refusé : on bascule sur la sélection manuelle.
      }
      window.prompt("Copie le lien du post :", permalink);
      return;
    }
    if (action === "report") {
      const who = card.querySelector(".x-post-who")?.textContent || "";
      openReportDialog({ pseudo: who, reasons: viewedProfile?.reasons, messageId: postId });
      return;
    }
    if (action === "like" || action === "repost") {
      const already = actionButton.getAttribute("aria-pressed") === "true";
      if (action === "like" && !isSignedIn()) {
        forward("[data-member-login]");
        return;
      }
      const payload = action === "like"
        ? { action: already ? "unlike" : "like", postId }
        : { action: already ? "unrepost" : "repost", postId };
      actionButton.disabled = true;
      try {
        const { response, data } = await postJson(payload);
        if (!response.ok) {
          if (response.status === 401) forward("[data-member-login]");
          return;
        }
        const counter = actionButton.querySelector("span");
        if (action === "like") {
          const liked = data.liked === true;
          if (counter) counter.textContent = String(data.likes ?? 0);
          actionButton.classList.toggle("is-liked", liked);
          actionButton.setAttribute("aria-pressed", String(liked));
          actionButton.setAttribute("aria-label", liked ? "Retirer le like" : "Liker ce post");
          // Cœur au trait → cœur plein, rose, avec le petit rebond.
          actionButton.innerHTML = (liked ? postActionIcon.likeFull : postActionIcon.like);
          if (counter) actionButton.append(counter);
          actionButton.classList.remove("is-bumping");
          void actionButton.offsetWidth;
          actionButton.classList.add("is-bumping");
        } else {
          const reposted = data.reposted === true;
          if (counter) counter.textContent = String(data.reposts ?? 0);
          actionButton.classList.toggle("is-reposted", reposted);
          actionButton.setAttribute("aria-pressed", String(reposted));
          actionButton.setAttribute("aria-label", reposted ? "Annuler le repost" : "Reposter ce post");
        }
      } catch {
        // Le bouton se réactive simplement.
      } finally {
        actionButton.disabled = false;
      }
      return;
    }

    actionButton.disabled = true;
    try {
      const { response, data } = await postJson({
        action: "delete-post",
        postId,
      });
      if (!response.ok) {
        if (response.status === 401) forward("[data-member-login]");
        return;
      }
      card.remove();
      if (container && !container.querySelector(".x-post")) {
        if (container === feedPostsNode && feedEmpty) feedEmpty.hidden = false;
        if (container === profileFeedNode && profileFeedEmpty) profileFeedEmpty.hidden = false;
      }
      if (container === profileFeedNode) void loadProfileFeed();
      void data;
    } catch {
      // Rien à signaler : le bouton se réactive.
    } finally {
      actionButton.disabled = false;
    }
  };

  feedPostsNode?.addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    void feedAction(actionButton, feedPostsNode);
  });

  profileFeedNode?.addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    void feedAction(actionButton, profileFeedNode);
  });

  // Menu ••• d'un post : épingler, supprimer, signaler, bloquer.
  document.addEventListener("click", (event) => {
    if (!event.target.closest?.(".x-post-menu-wrap")) closePostMenus();
  });

  document.addEventListener("click", async (event) => {
    const menuItem = event.target.closest?.("[data-post-menu-action]");
    if (!menuItem) return;
    const card = menuItem.closest(".x-post");
    const postId = card?.dataset.postId;
    const action = menuItem.dataset.postMenuAction;
    const who = card?.querySelector(".x-post-who")?.textContent || "";
    closePostMenus();
    if (!postId) return;

    if (action === "report") {
      openReportDialog({ pseudo: who, reasons: viewedProfile?.reasons, messageId: postId });
      return;
    }
    if (action === "delete") {
      const desired = window.confirm("Supprimer définitivement ce post ?");
      if (!desired) return;
      const { response, data } = await postJson({ action: "delete-post", postId });
      if (!response.ok) {
        showToast(data.error || "Ce post n’a pas pu être supprimé.");
        return;
      }
      const box = card.closest("[data-x-feed-posts], [data-x-profile-feed]");
      card.remove();
      if (box && !box.querySelector(".x-post")) {
        if (box === feedPostsNode && feedEmpty) feedEmpty.hidden = false;
        if (box === profileFeedNode && profileFeedEmpty) profileFeedEmpty.hidden = false;
      }
      showToast("Post supprimé");
      return;
    }
    if (action === "pin" || action === "unpin") {
      const { response, data } = await postJson({ action, postId });
      if (!response.ok) {
        showToast(data.error || "Impossible de modifier l’épinglage.");
        return;
      }
      showToast(action === "pin" ? "Post épinglé en haut du QG" : "Post désépinglé");
      await loadFeed({ mode: feedMode, quiet: true });
      return;
    }
    if (action === "block") {
      const confirmed = window.confirm(`Bloquer @${who} ? Son contenu et ses messages disparaîtront du QG.`);
      if (!confirmed) return;
      const { response, data } = await postJson({ action: "block", target: who });
      if (!response.ok) {
        showToast(data.error || "Ce blocage n’a pas pu être enregistré.");
        return;
      }
      showToast(`@${who} est bloqué`);
      await loadFeed({ mode: feedMode, quiet: true });
    }
  });

  /* ------------------------------------------------------------------------
     Notifications réelles : likes, reposts, follows et posts de l'Hôte
     -------------------------------------------------------------------- */
  const notificationsList = $("[data-x-notifications-list]");
  const notificationsEmpty = $("[data-x-notifications-empty]");
  const notificationBadges = $$('[data-x-badge="notifications"]');
  let notificationsFilter = "all";
  let lastNotifications = [];

  const notificationSentence = (item) => {
    const names = Array.isArray(item.actors) ? item.actors : [];
    const first = names[0]?.pseudo || "Quelqu’un";
    if (item.type === "follow") {
      if (names.length <= 1) return `${first} a commencé à te suivre`;
      return `${first} et ${names.length - 1} autre${names.length > 2 ? "s" : ""} ont commencé à te suivre`;
    }
    if (item.type === "post") return "Gionny 👑 a publié un nouveau post dans le QG";
    const verbs = {
      repost: ["a reposté ton post", "ont reposté ton post"],
      like: ["a aimé ton post", "ont aimé ton post"],
    }[item.type] || ["a interagi avec ton post", "ont interagi avec ton post"];
    if (names.length <= 1) return `${first} ${verbs[0]}`;
    return `${first} et ${names.length - 1} autre${names.length > 2 ? "s" : ""} ${verbs[1]}`;
  };

  const createNotificationRow = (item) => {
    const row = document.createElement("article");
    row.className = "x-notification";
    row.dataset.kind = item.type;
    if (!item.read) row.dataset.unread = "true";

    const icon = document.createElement("span");
    icon.className = `x-notification-icon x-notification-icon--${item.type}`;
    icon.innerHTML = item.type === "repost"
      ? postActionIcon.repost
      : item.type === "post"
        ? postActionIcon.crown
        : item.type === "follow"
          ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.4" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.7" /><path d="M3.4 20.4a7 7 0 0 1 14 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /><path d="M18.6 8.4v5M21.1 10.9h-5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg>'
          : postActionIcon.like;

    // Avatar de l'auteur de l'action (ou couronne du QG pour un post officiel).
    const avatar = document.createElement("span");
    avatar.className = "x-notification-avatar";
    const actor = item.actors?.[0];
    if (actor?.avatarData) {
      const img = document.createElement("img");
      img.src = actor.avatarData;
      img.alt = "";
      avatar.append(img);
    } else if (actor?.isHost || item.type === "post") {
      const img = document.createElement("img");
      img.src = hostAvatar();
      img.alt = "";
      avatar.append(img);
    } else {
      avatar.innerHTML = '<svg viewBox="0 0 40 40" fill="none" aria-hidden="true"><circle cx="20" cy="20" r="19" /><circle cx="20" cy="15" r="6" /><path d="M8.5 33.5c1.7-6.2 5.8-9.3 11.5-9.3s9.8 3.1 11.5 9.3" /></svg>';
    }

    const copy = document.createElement("div");
    copy.className = "x-notification-copy";
    const line = document.createElement("p");
    line.className = "x-notification-text";
    line.textContent = notificationSentence(item);
    const preview = document.createElement("p");
    preview.className = "x-notification-preview";
    preview.textContent = item.preview || "Ton post";
    const when = document.createElement("span");
    when.className = "x-notification-time";
    when.textContent = relativeTime(item.createdAt);
    copy.append(line, preview, when);

    const lead = document.createElement("div");
    lead.className = "x-notification-lead";
    lead.append(icon, avatar);

    row.append(lead, copy);
    row.addEventListener("click", () => {
      if (item.type === "post" && item.postId) {
        setActiveView("home");
        window.requestAnimationFrame(() => {
          document.querySelector(`.x-post[data-post-id="${item.postId}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
        });
        return;
      }
      const pseudo = item.actors?.[0]?.pseudo;
      if (pseudo) void openPublicProfile(pseudo);
    });
    window.qgTwemoji?.render?.(row);
    return row;
  };

  const paintNotifications = (items) => {
    if (!notificationsList) return;
    const filtered = notificationsFilter === "verified"
      ? items.filter((item) => item.type === "post" ||
          (item.actors || []).some((actor) => actor.isHost || actor.badges?.includes("verified")))
      : items;
    notificationsList.replaceChildren(...filtered.map(createNotificationRow));
    if (notificationsEmpty) notificationsEmpty.hidden = filtered.length > 0;
  };

  const setNotificationBadge = (unread) => {
    const count = Math.max(0, Number(unread) || 0);
    notificationBadges.forEach((node) => {
      node.hidden = count === 0;
      if (count > 0) {
        node.textContent = count > 9 ? "9+" : String(count);
        node.setAttribute("aria-label", `${count} notification${count > 1 ? "s" : ""} non lue${count > 1 ? "s" : ""}`);
      }
    });
  };

  async function refreshNotifications({ quiet = false, markRead = false } = {}) {
    if (!notificationsList) return;
    try {
      const url = new URL("/api/profile", window.location.origin);
      url.searchParams.set("notifications", "1");
      const response = await fetch(url.href, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return;
      const items = Array.isArray(data.notifications) ? data.notifications : [];
      lastNotifications = items;
      paintNotifications(items);
      if (markRead && items.some((item) => !item.read)) {
        const { response: readResponse } = await postJson({ action: "notifications-read" });
        if (readResponse.ok) {
          setNotificationBadge(0);
          return;
        }
      }
      setNotificationBadge(data.unread || 0);
      if (quiet) return;
    } catch {
      // Aucune notification affichée : le panneau garde son état vide.
    }
  }

  $$("[data-x-notif-tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$("[data-x-notif-tab]").forEach((other) =>
        other.setAttribute("aria-selected", String(other === tab))
      );
      notificationsFilter = tab.dataset.xNotifTab === "verified" ? "verified" : "all";
      paintNotifications(lastNotifications);
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

  // `hideUnverifiedContent` est activé par défaut : c'est la préférence qui
  // décide si le fil met en avant uniquement l'officiel et les Validés ✓.
  const DEFAULT_PREFS = { hideUnverified: true, hideUnverifiedContent: true };
  const readPreference = (key) => {
    const prefs = { ...DEFAULT_PREFS, ...readPrefs() };
    return typeof prefs[key] === "boolean" ? prefs[key] : false;
  };
  const hideUnverifiedEnabled = () =>
    readPreference("hideUnverified") || readPreference("hideUnverifiedContent");

  const switches = $$("[data-x-switch]");
  if (switches.length) {
    const prefs = { ...DEFAULT_PREFS, ...readPrefs() };
    switches.forEach((toggle) => {
      const key = toggle.dataset.xSwitch;
      if (typeof prefs[key] === "boolean") toggle.setAttribute("aria-checked", String(prefs[key]));
      toggle.addEventListener("click", () => {
        const next = toggle.getAttribute("aria-checked") !== "true";
        // Plusieurs interrupteurs peuvent porter la même préférence (visiteur
        // et membre) : on les garde tous synchronisés.
        $$(`[data-x-switch="${key}"]`).forEach((other) => other.setAttribute("aria-checked", String(next)));
        writePrefs({ ...readPrefs(), [key]: next });
        if (key === "hideUnverified" || key === "hideUnverifiedContent") {
          void loadFeed({ mode: feedMode, quiet: true });
        }
        if (key === "private") void savePrivacy(next);
      });
    });
  }


  /* ------------------------------------------------------------------------
     ÉTAPE 4 · Page Paramètres, liaison Discord et confidentialité
     ------------------------------------------------------------------------
     • la page montre 4 cartes pour un membre, une seule pour un visiteur ;
     • `GET /api/settings` remplit les valeurs réelles (Discord, privé, bloqués) ;
     • changer un réglage écrit tout de suite côté serveur (state + Supabase).
     ---------------------------------------------------------------------- */
  const settingsReader = $("[data-x-settings-reader]");
  const settingsStack = $("[data-x-settings-stack]") || $(".x-settings-stack");
  const discordStatePill = $("[data-x-settings-discord-state]");
  const discordLinkedBox = $("[data-x-settings-discord-linked]");
  const discordForm = $("[data-x-settings-discord-form]");
  const discordNameNode = $("[data-x-settings-discord-name]");
  const discordIdNode = $("[data-x-settings-discord-id]");
  const discordDateNode = $("[data-x-settings-discord-date]");
  const discordMessage = $("[data-x-discord-message]");
  const discordIdInput = $("[data-x-discord-id-input]");
  const discordUsernameInput = $("[data-x-discord-username-input]");
  const discordOauthButton = $("[data-x-discord-oauth]");
  const discordOauthHint = $("[data-x-discord-mode-oauth]");
  const discordCodeHint = $("[data-x-discord-mode-code]");
  const privacyPill = $("[data-x-settings-privacy-state]");
  const verifiedPill = $("[data-x-settings-verified]");
  const verifiedCopy = $("[data-x-settings-verified-copy]");
  const blockedList = $("[data-x-blocked-list]");
  const blockedEmpty = $("[data-x-blocked-empty]");
  const passwordMessage = $("[data-x-settings-password-message]");

  let settingsSnapshot = null;

  const setSettingsMessage = (node, text, state = "") => {
    if (!node) return;
    node.textContent = text || "";
    if (state) node.dataset.state = state;
    else delete node.dataset.state;
  };

  const settingsRequest = async (body) => {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  };

  const paintBlockedUsers = (users) => {
    if (!blockedList) return;
    const list = Array.isArray(users) ? users : [];
    blockedList.replaceChildren();
    list.forEach((pseudo) => {
      const item = document.createElement("li");
      item.className = "x-settings-blocked-row";
      const name = document.createElement("span");
      name.className = "x-settings-blocked-name";
      name.textContent = `@${pseudo}`;
      const button = document.createElement("button");
      button.className = "x-settings-unblock";
      button.type = "button";
      button.textContent = "Débloquer";
      button.dataset.unblock = pseudo;
      item.append(name, button);
      blockedList.append(item);
    });
    if (blockedEmpty) blockedEmpty.hidden = list.length > 0;
  };

  const paintSettings = (snapshot) => {
    settingsSnapshot = snapshot;
    const settings = snapshot?.settings || {};
    const discord = settings.discord || {};
    const isHost = Boolean(currentUser()?.isHost);

    if (settingsReader) settingsReader.hidden = Boolean(snapshot?.viewer);
    if (settingsStack) settingsStack.hidden = !snapshot?.viewer;

    // Discord
    const linked = discord.linked === true;
    if (discordStatePill) {
      discordStatePill.textContent = linked ? "Lié" : "Non lié";
      discordStatePill.dataset.state = linked ? "on" : "";
    }
    if (discordLinkedBox) discordLinkedBox.hidden = !linked;
    if (discordForm) discordForm.hidden = linked;
    setText(discordNameNode, discord.discordUsername ? `@${discord.discordUsername}` : "");
    setText(discordIdNode, discord.discordId || "—");
    if (discordDateNode) {
      discordDateNode.textContent = discord.discordLinkedAt
        ? `Lié le ${new Date(discord.discordLinkedAt).toLocaleDateString("fr-FR")}`
        : "";
    }

    // Mode de liaison : OAuth si les clés existent, sinon ID + pseudo vérifiés.
    const oauth = snapshot?.oauth === true;
    if (discordOauthButton) discordOauthButton.hidden = !oauth;
    if (discordOauthHint) discordOauthHint.hidden = !oauth;
    if (discordCodeHint) discordCodeHint.hidden = oauth;

    // Confidentialité
    const isPrivate = settings.isPrivate === true;
    if (privacyPill) {
      privacyPill.textContent = isPrivate ? "Privé" : "Public";
      privacyPill.dataset.state = isPrivate ? "on" : "";
    }
    $$('[data-x-switch="private"]').forEach((node) =>
      node.setAttribute("aria-checked", String(isPrivate))
    );

    // Statut de validation (lecture seule ici : c'est l'admin qui décide)
    const verified = Boolean(currentUser()?.isVerified);
    if (verifiedPill) verifiedPill.hidden = !verified;
    if (verifiedCopy) {
      verifiedCopy.textContent = verified
        ? "Ton badge Validé ✓ est actif : tu peux publier dans le QG."
        : isHost
          ? "Compte Hôte : tu publies et épingles toujours."
          : "Badge Validé non accordé. Gionny peut l’activer depuis l’admin.";
    }

    // Comptes bloqués
    paintBlockedUsers(settings.blockedUsers);
  };

  const loadSettings = async ({ quiet = false } = {}) => {
    if (!isSignedIn()) {
      paintSettings({ viewer: null, settings: {}, oauth: false });
      return null;
    }
    try {
      const response = await fetch("/api/settings", {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return null;
      paintSettings(data);
      return data;
    } catch {
      if (!quiet) setSettingsMessage(discordMessage, "Les paramètres ne peuvent pas être chargés pour le moment.", "error");
      return null;
    }
  };

  async function savePrivacy(next) {
    if (!isSignedIn()) return;
    const { ok, data } = await settingsRequest({ action: "privacy", isPrivate: next });
    if (!ok) {
      $$('[data-x-switch="private"]').forEach((node) => node.setAttribute("aria-checked", String(!next)));
      writePrefs({ ...readPrefs(), private: !next });
      showToast(data?.error || "Ce réglage n’a pas pu être enregistré.");
      return;
    }
    writePrefs({ ...readPrefs(), private: data.isPrivate === true });
    if (privacyPill) {
      privacyPill.textContent = data.isPrivate ? "Privé" : "Public";
      privacyPill.dataset.state = data.isPrivate ? "on" : "";
    }
    showToast(data.isPrivate ? "Compte passé en privé" : "Compte repassé en public");
    // Le profil affiché peut changer d'état : on le recharge.
    if (activeView === "profile") void renderProfileView();
  }

  $("[data-x-discord-link]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const discordId = (discordIdInput?.value || "").trim();
    const discordUsername = (discordUsernameInput?.value || "").trim();
    setSettingsMessage(discordMessage, "");
    if (!/^\d{17,20}$/u.test(discordId)) {
      setSettingsMessage(discordMessage, "L’identifiant Discord doit être le nombre à 17-20 chiffres (clic droit → Copier l’identifiant).", "error");
      discordIdInput?.focus();
      return;
    }
    if (!discordUsername) {
      setSettingsMessage(discordMessage, "Indique aussi ton pseudo Discord.", "error");
      discordUsernameInput?.focus();
      return;
    }
    button.disabled = true;
    const { ok, data } = await settingsRequest({ action: "discord-link", discordId, discordUsername });
    button.disabled = false;
    if (!ok) {
      setSettingsMessage(discordMessage, data?.error || "La liaison n’a pas pu être enregistrée.", "error");
      return;
    }
    setSettingsMessage(
      discordMessage,
      data.verified
        ? `Discord lié et vérifié : @${data.discord?.discordUsername || discordUsername}`
        : `Discord lié : @${data.discord?.discordUsername || discordUsername}`,
      "ok"
    );
    if (discordIdInput) discordIdInput.value = "";
    if (discordUsernameInput) discordUsernameInput.value = "";
    await loadSettings({ quiet: true });
    if (activeView === "profile") void renderProfileView();
  });

  $("[data-x-discord-oauth]")?.addEventListener("click", () => {
    window.location.href = "/api/auth/discord";
  });

  $("[data-x-discord-unlink]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const { ok, data } = await settingsRequest({ action: "discord-unlink" });
    button.disabled = false;
    if (!ok) {
      setSettingsMessage(discordMessage, data?.error || "La liaison n’a pas pu être retirée.", "error");
      return;
    }
    setSettingsMessage(discordMessage, "Liaison Discord retirée.", "ok");
    await loadSettings({ quiet: true });
    if (activeView === "profile") void renderProfileView();
  });

  // Débloquer depuis la liste des comptes bloqués.
  blockedList?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-unblock]");
    if (!button) return;
    const pseudo = button.dataset.unblock;
    button.disabled = true;
    try {
      const response = await fetch("/api/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "unblock", target: pseudo }),
      });
      if (!response.ok) throw new Error("unblock-failed");
      showToast(`@${pseudo} débloqué`);
      if (blockLabel && viewedProfile?.pseudo?.toLowerCase() === String(pseudo).toLowerCase()) {
        setText(blockLabel, `Bloquer @${pseudo}`);
      }
      await loadSettings({ quiet: true });
      void loadFeed({ mode: feedMode, quiet: true });
    } catch {
      showToast("Ce compte n’a pas pu être débloqué.");
      button.disabled = false;
    }
  });

  // Changement de mot de passe : passe par la route profile existante.
  $("[data-x-settings-password]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const currentInput = $("[data-x-settings-current-password]");
    const nextInput = $("[data-x-settings-new-password]");
    const currentPassword = currentInput?.value || "";
    const newPassword = nextInput?.value || "";
    setSettingsMessage(passwordMessage, "");
    if (!currentPassword) {
      setSettingsMessage(passwordMessage, "Saisis ton mot de passe actuel.", "error");
      currentInput?.focus();
      return;
    }
    if (newPassword.length < 8) {
      setSettingsMessage(passwordMessage, "Le nouveau mot de passe doit faire 8 caractères minimum.", "error");
      nextInput?.focus();
      return;
    }
    button.disabled = true;
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "profile", currentPassword, newPassword }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setSettingsMessage(passwordMessage, data?.error || "Le mot de passe n’a pas pu être modifié.", "error");
        return;
      }
      if (currentInput) currentInput.value = "";
      if (nextInput) nextInput.value = "";
      setSettingsMessage(passwordMessage, "Mot de passe mis à jour et enregistré.", "ok");
      showToast("Mot de passe mis à jour");
    } catch {
      setSettingsMessage(passwordMessage, "Le mot de passe n’a pas pu être modifié.", "error");
    } finally {
      button.disabled = false;
    }
  });

  // Retour d'OAuth Discord : ?discord=linked&discord_username=…
  (() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("discord");
    if (!status) return;
    params.delete("discord");
    params.delete("discord_username");
    const url = `${window.location.pathname}${params.toString() ? `?${params}` : ""}${window.location.hash}`;
    window.history.replaceState({}, "", url);
    setActiveView("settings");
    if (status === "linked") showToast("Discord lié au QG");
    else if (status === "unconfigured") showToast("Liaison Discord : le mode ID + pseudo est actif.");
    else if (status === "taken") showToast("Ce Discord est déjà lié à un autre compte.");
    else if (status === "login") showToast("Connecte-toi avant de lier ton Discord.");
    else if (status === "invalid_state" || status === "failed") showToast("La liaison Discord a échoué. Réessaie.");
  })();

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
    composerUser = user;
    const canPost = Boolean(user && (user.isHost || user.isVerified));
    // Connecté mais pas encore Validé : le bandeau remplace la zone d'écriture.
    if (composerNode) composerNode.hidden = !canPost;
    const lockedBanner = $("[data-x-composer-locked]");
    if (lockedBanner) lockedBanner.hidden = !user || canPost;
    postComposer.readOnly = !canPost;
    postComposer.placeholder = canPost
      ? "Quoi de neuf dans le QG ?"
      : "Seuls Gionny et les membres Validés publient des posts publics";
    // Les outils d'attachement suivent exactement le droit de publier.
    $$("[data-x-post-image], [data-x-post-video], [data-x-post-vocal], [data-x-post-emoji]").forEach(
      (button) => {
        button.disabled = !canPost;
      }
    );
    if (!canPost && draftMedia) clearDraftMedia();
    if (!canPost) quitComposerTransients();
    setComposerNote(
      canPost ? "Ton post est visible par toute la commu du QG." : ""
    );
    syncComposerState();
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
  void refreshNotifications({ quiet: true });

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
