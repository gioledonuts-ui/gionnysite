import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (file) => readFile(new URL(file, root), "utf8");
const [html, css, xApp, script] = await Promise.all([
  read("index.html"),
  read("social-x.css"),
  read("x-app.js"),
  read("script.js"),
]);

// ---------------------------------------------------------------------------
// 1. Une seule flèche de retour dans une conversation
// ---------------------------------------------------------------------------
test("1. la conversation n'a qu'une flèche : retour en arrière", () => {
  const closeButton = html.match(/<button class="contact-dialog-close"[\s\S]*?<\/button>/u);
  assert.ok(closeButton, "bouton de fermeture présent");
  const arrows = [...closeButton[0].matchAll(/<svg/gu)];
  assert.equal(arrows.length, 1, "une seule icône dans le bouton de retour");
  assert.match(closeButton[0], /aria-label="Revenir en arrière"/u);
  assert.doesNotMatch(closeButton[0], /icon-chevron-down/u);
  assert.match(closeButton[0], /d="M20 12H5M11 5\.6 4\.6 12 11 18\.4"/u);
});

// ---------------------------------------------------------------------------
// 2. Liste des conversations : pas d'icône à droite, non-lus signés
// ---------------------------------------------------------------------------
test("2. la ligne de conversation n'a plus d'icône et signe les non-lus", () => {
  const row = html.match(/<button class="x-dm-thread"[\s\S]*?<\/button>/u);
  assert.ok(row, "ligne de conversation présente");
  // Seuls les badges du pseudo restent : aucune icône décorative à droite.
  assert.doesNotMatch(row[0], /x-dm-open-icon/u, "aucune icône décorative dans la ligne");
  assert.equal([...row[0].matchAll(/<svg/gu)].length, 2, "couronne + badge vérifié seulement");
  assert.match(row[0], /data-x-dm-badge/u);
  assert.match(css, /\.x-dm-thread\[data-unread="true"\] \{[\s\S]*?border-color: rgba\(56, 189, 248, 0\.55\)/u);
  assert.match(css, /\.x-dm-thread\[data-unread="true"\] \.x-dm-snippet \{[\s\S]*?font-weight: 700;/u);
  assert.match(xApp, /row\.dataset\.unread = String\(hasUnread\)/u);
});

test("2 bis. l'icône Messages de l'en-tête crée une conversation, pas le tiroir", () => {
  assert.match(html, /data-x-new-thread aria-label="Nouvelle conversation"/u);
  assert.doesNotMatch(html, /data-x-messages-open/u);
  assert.match(xApp, /\[data-x-new-thread\]/u);
  assert.match(xApp, /querySelector\("\[data-new-conversation\]"\)/u);
  // Le tiroir s'ouvre désormais uniquement par la ligne de conversation.
  assert.match(xApp, /\[data-x-compose-open\], \[data-x-compose-focus\], \[data-x-dm-open\]/u);
});

// ---------------------------------------------------------------------------
// 3. Profil accessible depuis les messages
// ---------------------------------------------------------------------------
test("3. on peut ouvrir le profil de la personne depuis la conversation", () => {
  assert.match(html, /data-contact-open-profile aria-label="Voir le profil de Gionny"/u);
  assert.match(html, /data-x-dm-profile="Gionny"/u);
  // L'avatar reste décoratif : le chemin clavier est l'en-tête de la conversation.
  assert.match(html, /data-x-dm-profile="Gionny" aria-hidden="true"/u);
  assert.match(script, /contactHeaderProfile\.addEventListener\("click", openContactProfile\)/u);
  assert.match(script, /window\.qgOpenProfile\("Gionny"\)/u);
  assert.match(xApp, /window\.qgOpenProfile = \(pseudo\) => openPublicProfile\(pseudo\)/u);
  // Retour : on revient d'où l'on vient.
  assert.match(xApp, /if \(profileReturnView === "messages"\)/u);
});

// ---------------------------------------------------------------------------
// 4. On n'atterrit plus en bas de page
// ---------------------------------------------------------------------------
test("4. chaque page s'ouvre en haut et la conversation fige la page", () => {
  assert.match(xApp, /const resetPageScroll = \(\) => \{[\s\S]*?window\.scrollTo\(0, 0\);/u);
  assert.match(xApp, /new MutationObserver\(resetPageScrollSoon\)\.observe\(memberIdentityNode/u);
  assert.match(xApp, /if \(view !== "home"\) resetPageScrollSoon\(\);/u);
  // Téléphone : la page passe en position fixe, puis reprend sa place exacte.
  assert.match(script, /if \(chatPageIsFullScreen\(\)\) lockBackgroundScroll\("contact-widget"\);/u);
  assert.match(script, /unlockBackgroundScroll\("contact-widget"\);/u);
  assert.match(script, /const chatPageIsFullScreen = \(\) =>[\s\S]*?\.matches;/u);
  assert.match(script, /MOBILE_CHAT_QUERY = "max-width: 639px"|MOBILE_CHAT_QUERY = "\(max-width: 639px\)"/u);
});

// ---------------------------------------------------------------------------
// 5. Le pseudo ne se coupe plus au bout de cinq caractères
// ---------------------------------------------------------------------------
test("5. le pseudo de la barre de compte garde sa place", () => {
  assert.match(css, /\.x-account-bar \.member-profile-pseudo,[\s\S]*?max-width: min\(46vw, 210px\);/u);
  assert.doesNotMatch(css, /\.x-account-bar \.member-profile-pseudo \{\s*max-width: (?:52|74)px/u);
  assert.match(css, /@media \(max-width: 420px\) \{[\s\S]*?max-width: min\(52vw, 190px\);/u);
});

// ---------------------------------------------------------------------------
// 6. La bannière ne passe plus au-dessus de la photo
// ---------------------------------------------------------------------------
test("6. la photo de profil passe devant le bandeau", () => {
  assert.match(css, /\.x-profile \{\s*position: relative;\s*isolation: isolate;/u);
  assert.match(css, /\.x-profile-banner \{[\s\S]*?z-index: 0;/u);
  assert.match(css, /\.x-profile-avatar \{[\s\S]*?z-index: 3;/u);
});

// ---------------------------------------------------------------------------
// 7. Aucun survol fantôme en scrollant sur téléphone
// ---------------------------------------------------------------------------
test("7. « Retrouve-moi ici » ne se présélectionne pas au doigt", () => {
  assert.match(css, /@media \(hover: none\), \(pointer: coarse\) \{[\s\S]*?filter: none !important;/u);
  assert.match(css, /-webkit-tap-highlight-color: transparent/u);
});
