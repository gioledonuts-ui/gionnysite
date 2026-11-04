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

test("la charte X est appliquée : noir pur, surfaces #16181c, dividers #2f3336", () => {
  assert.match(socialCss, /--x-bg:\s*#000000/u);
  assert.match(socialCss, /--x-surface:\s*#16181c/u);
  assert.match(socialCss, /--x-surface-hover:\s*#1d1f23/u);
  assert.match(socialCss, /--x-line:\s*#2f3336/u);
  assert.match(socialCss, /--x-text:\s*#e7e9ea/u);
  assert.match(socialCss, /--x-muted:\s*#71767b/u);
  assert.match(socialCss, /--x-accent:\s*#1d9bf0/u);
  // couleur d'accent survolée
  assert.match(socialCss, /#1a8cd8/u);
  // surface de page mate, jamais de dégradé sur le body
  assert.match(socialCss, /body \{[^}]*background: var\(--x-bg\)/su);
  assert.doesNotMatch(socialCss, /gradient\(/u);
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
  assert.match(xApp, /railCrown\.toggleAttribute\("hidden", !isCrown\)/u);
  assert.match(xApp, /node\.toggleAttribute\("hidden", !count/u);
  assert.doesNotMatch(xApp, /\[data-x-profile-edit\], \[data-rail-account-card\]/u);
  assert.match(xApp, /if \(syncing\) return;/u);
  // toutes les actions sensibles sont déléguées aux boutons d'origine
  assert.match(xApp, /forward\("\[data-member-login\]"\)/u);
  assert.match(xApp, /forward\(isSignedIn\(\) \? "\[data-member-profile\]"/u);
});
