import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const html = read("index.html");
const xApp = read("x-app.js");
const script = read("script.js");
const css = read("social-x.css");
const inbox = read("lib/contact-inbox.mjs");
const graph = read("lib/social-graph.mjs");
const profileApi = read("api/profile.mjs");

// ---------------------------------------------------------------------------
// 1. Comptes : unicité stricte, aucun rôle déduit du pseudo
// ---------------------------------------------------------------------------
test("1. aucun rôle n'est déduit du pseudo (ni couronne, ni admin)", () => {
  // Aucune condition du type « pseudo === gionny → host/admin » ne subsiste.
  for (const source of [inbox, graph, profileApi]) {
    assert.doesNotMatch(source, /pseudo[^\n]{0,40}=== ?["']gionny["'][^\n]{0,60}(isHost|isAdmin|role)/iu);
    assert.doesNotMatch(source, /\["gionny", ?"7gionny"\]\.includes\([^\n]*\)\s*\)?\s*\{?[^\n]*(role|isHost)/u);
  }
  // Le pseudo de la vitrine ne sert plus qu'à l'unicité et à la protection du profil.
  assert.match(inbox, /function canonicalAccountPseudo/u);
  assert.match(inbox, /aucun rôle|AUCUN rôle/iu);
  // L'inscription écrit toujours `role: "member"`.
  assert.match(inbox, /\/\/ Le rôle vient de la base uniquement : jamais du pseudo\.\s*\n\s*role: "member",/u);
  // La connexion ne crée jamais de compte.
  assert.match(inbox, /La connexion ne crée jamais rien/u);
  // Le message d'erreur exigé, mot pour mot.
  assert.match(read("api/contact.mjs"), /Ce pseudo est déjà pris\. Connecte-toi avec ton mot de passe\./u);
  // Unicité : pseudo trim + minuscules.
  assert.match(inbox, /export function accountIdentityKey/u);
  assert.match(inbox, /\.toLowerCase\(\);/u);
});

test("1 bis. les doublons historiques sont fusionnés en un seul compte", () => {
  assert.match(inbox, /export async function deduplicateAccounts/u);
  assert.match(inbox, /function mergeAccountRecords/u);
  // Le compte Hôte n'est jamais recréé par le serveur.
  assert.match(inbox, /export async function ensureOwnerAccountSeeded\(\) \{\s*\n\s*return null;/u);
  // Les routes continuent de compiler : le seed est neutre, pas supprimé.
  for (const file of ["api/admin-auth.mjs", "api/admin-members.mjs", "api/contact.mjs"]) {
    assert.match(read(file), /ensureOwnerAccountSeeded/u);
  }
});

// ---------------------------------------------------------------------------
// 2. Accueil : Pour toi / Suivis, aucun bouton au milieu, présentation en bas
// ---------------------------------------------------------------------------
test("2. l'accueil n'a que deux onglets : Pour toi et Suivis", () => {
  const tabs = [...html.matchAll(/data-x-feed-tab="([a-z]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(tabs, ["all", "follows"]);
  assert.doesNotMatch(html, /Officiel &amp; Validés/u);
  assert.doesNotMatch(html, />Reposts</u);
  assert.match(css, /\.x-feed-tabs \{\s*\n\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/u);
});

test("2 bis. plus de Mon profil / Déconnexion / Admin sous Bienvenue", () => {
  const bar = html.slice(
    html.indexOf('class="x-account-bar"'),
    html.indexOf('class="x-guest-card"')
  );
  assert.ok(bar.length > 0);
  // Aucun bouton visible : uniquement la ligne d'état + les miroirs cachés.
  const visible = bar.replace(/<div class="member-access-actions member-access-actions--connected"[\s\S]*?<\/div>\s*<\/div>/u, "");
  assert.doesNotMatch(visible, />Mon Profil</u);
  assert.doesNotMatch(visible, />Déconnexion</u);
  assert.doesNotMatch(visible, />Admin</u);
  for (const selector of ["data-x-profile-open", "data-contact-logout", "data-x-admin"]) {
    const index = bar.indexOf(selector);
    assert.ok(index > -1, `${selector} doit rester branché`);
    // Chaque nœud miroir est bien masqué et hors du parcours de tabulation.
    const opening = bar.lastIndexOf("<", index);
    const tag = bar.slice(opening, bar.indexOf(">", index) + 1);
    assert.match(tag, /hidden/u, `${selector} doit rester masqué`);
    assert.match(tag, /tabindex="-1"/u);
  }
});

test("2 ter. la présentation de Gionny est tout en bas de la colonne", () => {
  const feed = html.indexOf('data-x-feed-posts');
  const composer = html.indexOf("data-x-composer");
  const intro = html.indexOf('class="welcome-identity"');
  const welcome = html.indexOf("Bienvenue dans le");
  assert.ok(welcome > -1 && welcome < composer, "Bienvenue précède le composeur");
  assert.ok(composer < feed, "le composeur précède le fil");
  assert.ok(intro > feed, "la présentation vient après le fil");
});

// ---------------------------------------------------------------------------
// 3. Composeur : champ fondu, un seul bouton média, micro qui démarre
// ---------------------------------------------------------------------------
test("3. la zone de texte du composeur est 100 % transparente", () => {
  assert.match(css, /\.x-composer-field textarea,[\s\S]*?border: 0 !important;[\s\S]*?background: transparent !important;[\s\S]*?box-shadow: none !important;/u);
  assert.match(css, /\[data-x-post-input\]:focus,[\s\S]*?outline: 0 !important;/u);
  // Aucune règle ne réintroduit un fond ou une bordure sur ce champ.
  assert.doesNotMatch(css, /\[data-x-post-input\][^{]*\{[^}]*border: 1px/u);
});

test("3 bis. un seul bouton média (photo + vidéo) et trois icônes d'action", () => {
  const tools = html.slice(html.indexOf('class="x-composer-attach"'), html.indexOf("data-x-post-count"));
  const buttons = [...tools.matchAll(/data-x-post-(?:media|vocal|emoji|video|image)(?=[\s>])/gu)]
    .map((match) => match[0]);
  assert.deepEqual(buttons, ["data-x-post-media", "data-x-post-vocal", "data-x-post-emoji"]);
  assert.match(tools, /accept="image\/\*,video\/\*"/u);
  // Un seul input fichier, branché sur les deux compressions.
  const inputs = [...postInputs()];
  assert.equal(inputs.length, 1);
  assert.match(xApp, /async function addImageDraft/u);
  assert.match(xApp, /async function addVideoDraft/u);
  assert.match(xApp, /startsWith\("video\/"\)/u);
});

function postInputs() {
  return [...html.matchAll(/data-x-post-media-input/gu)].map((match) => match[0]);
}

test("3 ter. le micro démarre réellement l'enregistrement", () => {
  // Le gestionnaire appelle recorder.start(), il ne se contente plus d'exister.
  assert.match(xApp, /vocalButton\?\.addEventListener\("click", \(\) => \{[\s\S]*?void recorder\.start\(\);/u);
  // Et getUserMedia est bien demandé par le moteur vocal.
  assert.match(read("voice-recorder.js"), /navigator\.mediaDevices\.getUserMedia\(\{ audio: true \}\)/u);
  // La barre d'enregistrement rouge animée, le chrono et le bouton Stop.
  assert.match(css, /\.x-recorder-dot \{[\s\S]*?background: var\(--x-danger\);[\s\S]*?animation: qg-recorder-pulse/u);
  assert.match(css, /\.x-recorder-timer \{/u);
  assert.match(html, /data-x-recorder-stop>Stop</u);
  assert.match(html, /data-x-recorder-send hidden>Utiliser ce vocal</u);
});

// ---------------------------------------------------------------------------
// 4. Icône de message : vectorielle, centrée, jamais rognée
// ---------------------------------------------------------------------------
test("4. l'icône de message est neuve et ne peut pas être rognée", () => {
  assert.doesNotMatch(html, /viewBox="-1\.6 -1\.6 27\.2 27\.2"/u);
  const icons = [...html.matchAll(/<path(?:\s+class="[^"]*")?\s+d="M4 5\.6A2\.6 2\.6 0 0 1 6\.6 3h10\.8/gu)];
  assert.ok(icons.length >= 3, "au moins trois bulles de message propres");
  // La ligne de conversation n'affiche plus d'icône à droite : une ligne = une
  // seule icône utile (le compteur bleu). L'icône « + » de l'en-tête Messages
  // sert, elle, à créer une conversation / un groupe.
  assert.doesNotMatch(html, /class="x-dm-open-icon"/u);
  assert.match(html, /class="x-icon-button x-new-thread-button" type="button" data-x-new-thread/u);
  assert.match(css, /\.x-dm-thread\[data-unread="true"\]/u);
  // Le tracé reste entre 3 et 21.
  const path = html.match(/M4 5\.6A2\.6 2\.6 0 0 1 6\.6 3h10\.8A2\.6 2\.6 0 0 1 20 5\.6v8\.3/u);
  assert.ok(path);
});

// ---------------------------------------------------------------------------
// 5. Messagerie téléphone : page plein écran pilotée par visualViewport
// ---------------------------------------------------------------------------
test("5. sur téléphone, la conversation est une vraie page plein écran", () => {
  const mobile = css.slice(css.indexOf("@media (max-width: 639px)", css.indexOf("ÉTAPE 5")));
  assert.ok(mobile.length > 0, "bloc mobile présent");
  assert.match(mobile, /\.contact-widget,[\s\S]*?position: fixed;[\s\S]*?inset: 0;[\s\S]*?height: var\(--qg-chat-height, 100dvh\) !important;/u);
  assert.match(mobile, /border-radius: 0;/u);
  assert.match(mobile, /box-shadow: none;/u);
  // En-tête immobile, zone des messages scrollable, barre de saisie en bas.
  assert.match(mobile, /\.contact-widget \.contact-dialog-topline \{[\s\S]*?flex: 0 0 56px;[\s\S]*?border-bottom: 1px solid #1e293b;/u);
  assert.match(mobile, /\.contact-widget \.contact-thread-messages,[\s\S]*?flex: 1 1 auto;[\s\S]*?overflow-y: auto;/u);
  assert.match(mobile, /\.contact-reply-form\.contact-chat-composer,[\s\S]*?border-top: 1px solid #1e293b;/u);
});

test("5 bis. le clavier mobile est suivi au pixel via window.visualViewport", () => {
  assert.match(script, /const syncMobileChatViewport = \(\) => \{/u);
  assert.match(script, /widget\.style\.setProperty\("--qg-chat-height", `\$\{height\}px`\)/u);
  assert.match(script, /widget\.style\.setProperty\("--qg-chat-top", `\$\{top\}px`\)/u);
  assert.match(script, /window\.visualViewport\?\.addEventListener\("resize", syncMobileChatViewport/u);
  assert.match(script, /window\.visualViewport\?\.addEventListener\("scroll", syncMobileChatViewport/u);
  // L'en-tête ne bouge pas : il suit `offsetTop`, la barre du bas suit la hauteur.
  assert.match(css, /top: var\(--qg-chat-top, 0px\) !important;/u);
  // Le lanceur flottant et la barre du bas s'effacent sur une conversation ouverte.
  assert.match(css, /body:has\(\.contact-widget:not\(\[hidden\]\)\) \.contact-launcher/u);
  assert.match(css, /body:has\(\.contact-widget:not\(\[hidden\]\)\) \.x-mobile-nav/u);
  // La flèche ← de retour n'apparaît que sur téléphone.
  assert.match(html, /class="qg-icon contact-close-mobile"/u);
  assert.match(html, /data-minimize-contact aria-label="Revenir en arrière"/u);
  assert.match(css, /@media \(max-width: 639px\) \{\s*\n\s*\.contact-close-desktop \{\s*\n\s*display: none;/u);
});

// ---------------------------------------------------------------------------
// Garde-fous de la charte visuelle
// ---------------------------------------------------------------------------
test("aucun zoom ni transform: scale() sur la page, aucune bordure claire nouvelle", () => {
  const after = css.slice(css.indexOf("ÉTAPE 5"));
  assert.doesNotMatch(after, /(^|[^-\w])zoom\s*:/u);
  assert.doesNotMatch(after, /(body|html)[^{]*\{[^}]*transform:\s*scale/u);
  assert.doesNotMatch(after, /rgba\(255, ?255, ?255, ?0\.[23]\)\s*;?\s*\/\* bordure blanc/iu);
});
