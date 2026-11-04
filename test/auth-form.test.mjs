import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = readFileSync(new URL("../script.js", import.meta.url), "utf8");

test("visitor login and registration bypass browser pseudo patterns and trim before submit", () => {
  const marker = html.indexOf("data-auth-form");
  assert.notEqual(marker, -1);
  const formStart = html.lastIndexOf("<form", marker);
  const formOpenEnd = html.indexOf(">", marker);
  const formEnd = html.indexOf("</form>", formOpenEnd);
  assert.ok(formStart >= 0 && formOpenEnd > formStart && formEnd > formOpenEnd);
  const formMarkup = html.slice(formStart, formEnd);
  assert.match(html.slice(formStart, formOpenEnd), /\bnovalidate\b/iu);
  assert.doesNotMatch(formMarkup, /\spattern\s*=/iu);

  const submitStart = script.indexOf('authForm?.addEventListener("submit"');
  const submitEnd = script.indexOf('logoutButtons.forEach', submitStart);
  assert.ok(submitStart >= 0 && submitEnd > submitStart);
  const submitHandler = script.slice(submitStart, submitEnd);
  assert.match(submitHandler, /String\(pseudoInput\?\.value \|\| ""\)\.trim\(\)/u);
  assert.doesNotMatch(submitHandler, /reportValidity\(\)/u);
});


// ---------------------------------------------------------------------------
// Refonte sociale « X » : la structure attendue et les garde-fous d'interface.
// ---------------------------------------------------------------------------

const socialCss = readFileSync(new URL("../social-x.css", import.meta.url), "utf8");
const twemoji = readFileSync(new URL("../twemoji.js", import.meta.url), "utf8");
const xApp = readFileSync(new URL("../x-app.js", import.meta.url), "utf8");

test("la charte du QG est appliquée : fond #070b14, surfaces #0e1525, bordures #1e293b", () => {
  // Étape 2 : le site garde l'organisation de X mais reprend l'identité du QG
  // (fond sombre profond, surfaces bleu nuit, bordures fines).
  assert.match(socialCss, /--x-bg:\s*#070b14/u);
  assert.match(socialCss, /--x-surface:\s*#0e1525/u);
  assert.match(socialCss, /--x-surface-hover:\s*#152037/u);
  assert.match(socialCss, /--x-line:\s*#1e293b/u);
  assert.match(socialCss, /--x-text:\s*#e8eefb/u);
  assert.match(socialCss, /--x-muted:\s*#8b9ab4/u);
  // surface de page mate
  assert.match(socialCss, /body \{[^}]*background: var\(--x-bg\)/su);
  // plus aucun noir pur #000000 : le QG n'est pas un clone brut de X
  assert.doesNotMatch(socialCss, /#000000/u);
  // un seul dégradé autorisé : le bandeau de couverture du profil
  const gradients = socialCss.match(/gradient\(/gu) || [];
  assert.equal(gradients.length, 1);
  assert.match(socialCss, /x-profile-banner \{[^}]*gradient\(90deg, #132038 0%, #1a2c4e 100%\)/su);
});

test("l'architecture en trois colonnes et le bandeau « À la une » sont en place", () => {
  assert.equal((html.match(/class="x-left-rail"/gu) || []).length, 1);
  assert.equal((html.match(/class="x-main"/gu) || []).length, 1);
  assert.equal((html.match(/class="x-right-rail"/gu) || []).length, 1);
  assert.match(html, /class="site-header"[\s\S]{0,400}À LA UNE/u);
  assert.match(html, /data-site-presence-count/u);
  // navigation principale complète
  for (const view of ["home", "notifications", "messages", "profile", "settings"]) {
    assert.match(html, new RegExp(`data-x-nav="${view}"`, "u"));
  }
  // accès admin réservé à l'hôte (masqué par défaut)
  assert.match(html, /data-x-admin hidden/u);
});

test("le compteur, le planning et le carrousel restent branchés sur script.js", () => {
  for (const hook of [
    "data-next-live-countdown",
    "data-countdown-hours",
    "data-countdown-minutes",
    "data-countdown-seconds",
    "data-schedule-day",
    "data-social-carousel",
    "data-carousel-slide",
    "data-carousel-dot",
    "data-member-profile",
    "data-member-login",
    "data-member-register",
    "data-open-contact",
  ]) {
    assert.match(html, new RegExp(hook, "u"));
  }
  // le compteur n'affiche plus de chiffre fantôme
  assert.match(socialCss, /\.schedule-countdown-ghost \{\s*display: none !important;/u);
});

test("les emojis passent par Twemoji, avec un rendu borné", () => {
  assert.match(twemoji, /cdnjs\.cloudflare\.com\/ajax\/libs\/twemoji\/14\.0\.2\/svg/u);
  assert.match(twemoji, /\\p\{Extended_Pictographic\}/u);
  // jamais de motif pouvant correspondre à la chaîne vide (boucle infinie)
  assert.doesNotMatch(twemoji, /\[\\u\{1F000\}/u);
  assert.match(twemoji, /emojiRegex = \(\) => new RegExp/u);
  assert.match(twemoji, /owned/u);
});

test("la couche d'interface ne surveille pas les attributs qu'elle écrit", () => {
  // Les attributs observés appartiennent uniquement aux sources script.js,
  // jamais aux éléments miroirs modifiés par syncAccount / syncMessages.
  assert.match(xApp, /new MutationObserver\(syncAccount\)\.observe\(source/u);
  assert.match(xApp, /attributeFilter: \["hidden", "src"\]/u);
  assert.doesNotMatch(xApp, /observe\(rail(?:Card|Crown|Verified)/u);
  assert.match(xApp, /railCrown\.toggleAttribute\("hidden", !user\?\.isHost\)/u);
  assert.match(xApp, /node\.toggleAttribute\("hidden", !count/u);
  assert.doesNotMatch(xApp, /\[data-x-profile-edit\], \[data-rail-account-card\]/u);
  assert.match(xApp, /if \(syncing\) return;/u);
  // toutes les actions sensibles sont déléguées aux boutons d'origine
  assert.match(xApp, /forward\("\[data-member-login\]"\)/u);
  assert.match(xApp, /forward\("\[data-member-profile\]"\).*|forward\(isSignedIn\(\)/u);
});

// ---------------------------------------------------------------------------
// Étape 3 : composeur média, emojis Twemoji, likes/reposts, notifications.
// ---------------------------------------------------------------------------

const postComposer = (() => {
  const marker = html.indexOf("data-x-composer");
  const start = html.lastIndexOf("<div", marker);
  const end = html.indexOf('<div class="x-feed"', marker);
  return html.slice(start, end);
})();

test("le composeur offre trois attachements, réservés à l'Hôte et aux Validés", () => {
  for (const hook of [
    "data-x-post-input",
    "data-x-post-submit",
    "data-x-post-media",
    "data-x-post-media-input",
    "data-x-post-vocal",
    "data-x-post-emoji",
    "data-x-emoji-panel",
    "data-x-post-recorder",
    "data-x-composer-attachment",
    "data-x-post-count",
  ]) {
    assert.match(postComposer, new RegExp(hook, "u"), `attendu : ${hook}`);
  }

  // Un SEUL bouton multimédia (photo + vidéo), plus d'icône vidéo séparée.
  assert.doesNotMatch(postComposer, /data-x-post-image|data-x-post-video/u);
  assert.match(postComposer, /accept="image\/\*,video\/\*"/u);

  // Le droit de publier est le même pour le texte et pour les médias.
  assert.match(xApp, /\[data-x-post-media\], \[data-x-post-vocal\], \[data-x-post-emoji\]/u);
  assert.match(xApp, /const canPost = Boolean\(user && \(user\.isHost \|\| user\.isVerified\)\)/u);
  // Aucun média ne part sans passer par les limites annoncées.
  assert.match(xApp, /const MEDIA_LIMITS = \{ image: 60 \* 1024, vocal: 200 \* 1024, video: 2 \* 1024 \* 1024 \}/u);
  // Image : 800 px max ; vidéo : 30 s max (refus explicite au-delà).
  assert.match(xApp, /maxWidth: 800,\s*\n\s*maxHeight: 800/u);
  assert.match(xApp, /const MEDIA_MAX_SECONDS = \{ video: 30, vocal: 60 \}/u);
  // Le binaire est déposé après la création du post, jamais dans le même POST.
  assert.match(xApp, /action: "media",\s*\n\s*postId,/u);
});

test("les emojis du composeur s'insèrent au curseur et se rendent en Twemoji", () => {
  assert.match(xApp, /const insertEmoji = \(emoji\) =>/u);
  assert.match(xApp, /setSelectionRange\(caret, caret\)/u);
  assert.match(xApp, /window\.qgTwemoji\?\.render\?\.\(card\)/u);
  assert.match(twemoji, /cdnjs\.cloudflare\.com\/ajax\/libs\/twemoji\/14\.0\.2\/svg/u);
});

test("likes, reposts et notifications restent branchés sur les mêmes routes", () => {
  assert.match(xApp, /action: already \? "unrepost" : "repost"/u);
  assert.match(xApp, /action: already \? "unlike" : "like"/u);
  assert.match(xApp, /action: "notifications-read"/u);
  assert.match(xApp, /url\.searchParams\.set\("notifications", "1"\)/u);
  assert.match(xApp, /notificationsFilter === "verified"/u);
  // Deux onglets seulement depuis la remise à neuf : Pour toi et Suivis.
  for (const mode of ["all", "follows"]) {
    assert.match(html, new RegExp(`data-x-feed-tab="${mode}"`, "u"));
  }
  for (const mode of ["verified", "reposts"]) {
    assert.doesNotMatch(html, new RegExp(`data-x-feed-tab="${mode}"`, "u"));
  }
  // Le badge de la nav reçoit le compte réel, plafonné à 9+.
  assert.match(xApp, /count > 9 \? "9\+"/u);
});
