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
