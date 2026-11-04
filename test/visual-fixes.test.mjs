import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Correctifs visuels PC (6 points) : ces tests lisent les fichiers livrés et
// vérifient les invariants d'affichage. Aucun DOM requis — le but est de
// garantir qu'une refonte ultérieure ne réintroduit pas les défauts corrigés.

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const html = read("index.html");
const fixes = read("visual-fixes.css");
const script = read("script.js");

/** Le CSS utile : on retire les commentaires pour ne pas tester de la prose. */
const cssRules = fixes.replace(/\/\*[\s\S]*?\*\//gu, "");

test("la couche de correctifs visuels est chargée en dernier", () => {
  const sheets = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/gu)].map((m) => m[1]);
  assert.equal(sheets.at(-1), "/visual-fixes.css");
});

test("1. bandeau « À la une » : badge bleu du QG, sans halo rouge", () => {
  // Le badge ne s'appuie plus sur une couleur rouge : capsule bleue du QG.
  assert.match(cssRules, /\.ticker-label[\s\S]*?background: rgba\(29, 155, 240, 0\.15\)/u);
  assert.match(cssRules, /\.ticker-label[\s\S]*?color: #38bdf8/u);
  assert.match(cssRules, /\.ticker-label[\s\S]*?box-shadow: none/u);
  // Aucune ombre colorée (rouge/rose) autour du badge.
  assert.doesNotMatch(cssRules, /ticker-label[^{]*\{[^}]*box-shadow:\s*0[^;]*(red|rose|#f|#e)/iu);
  // Écart court et régulier entre les capsules + icône dans un carré de 24 px.
  assert.match(cssRules, /\.ticker-item \+ \.ticker-item[\s\S]*?margin-right: 16px/u);
  assert.match(cssRules, /\.ticker-icon[\s\S]*?width: 24px;[\s\S]*?height: 24px/u);
  assert.match(cssRules, /\.ticker-copy[\s\S]*?align-items: center/u);
  // Les trois annonces sont toujours là, chacune avec son SVG.
  for (const label of ["TWITCH", "DERNIÈRE VIDÉO", "LA COMMU"]) {
    assert.ok(html.includes(`>${label}<`), `capsule ${label} absente`);
  }
  assert.equal((html.match(/class="ticker-icon ticker-icon--/gu) || []).length, 3);
});

test("2. carte « Bienvenue dans le QG » : ni photo, ni pseudo, ni badge", () => {
  const card = html.match(/<div class="x-guest-card" data-x-guest-card>([\s\S]*?)<\/div>\s*\n\s*<\/div>/u)
    || html.match(/<div class="x-guest-card" data-x-guest-card>([\s\S]*?)<\/div>/u);
  assert.ok(card, "carte visiteur introuvable");
  const inner = card[1];
  assert.doesNotMatch(inner, /<img/u, "la carte ne doit plus contenir d'image");
  assert.doesNotMatch(inner, /7gionny/u, "le pseudo @7gionny doit disparaître");
  assert.doesNotMatch(inner, /crown|verified/u, "aucun badge couronne/validé");
  assert.match(inner, /Bienvenue dans le QG/u);
  assert.match(inner, /La commu, les lives et les meilleurs moments sont ici\./u);
  assert.match(inner, /data-x-login/u);
  assert.match(inner, /data-x-register/u);
});

test("2 bis. en-tête du fil : plus d'avatar ni de @pseudo", () => {
  assert.doesNotMatch(html, /class="x-feed-avatar"/u);
  assert.doesNotMatch(html, /class="x-feed-handle"/u);
  const h1 = html.match(/<h1 id="welcome-title"[^>]*>([\s\S]*?)<\/h1>/u);
  assert.ok(h1);
  assert.match(h1[1], /Bienvenue dans le/u);
  assert.doesNotMatch(h1[1], /de Gionny/u);
  // Les anciennes boîtes restent neutralisées par la couche de correctifs.
  assert.match(cssRules, /\.x-feed-header-row \.x-feed-avatar,[\s\S]*?display: none !important/u);
});

test("3. logo du rail : boîte circulaire de 48 px, sans étirement", () => {
  assert.match(cssRules, /\.x-rail-logo[\s\S]*?width: 48px;[\s\S]*?height: 48px;[\s\S]*?border-radius: 999px/u);
  assert.match(cssRules, /\.x-rail-logo:hover[\s\S]*?background: rgba\(255, 255, 255, 0\.09\)/u);
  // Le média reste carré et contenu : plus de `width: auto` qui étirait la boîte.
  assert.match(cssRules, /\.x-rail-logo img[\s\S]*?width: 32px;[\s\S]*?height: 32px;[\s\S]*?object-fit: contain/u);
  assert.doesNotMatch(cssRules, /\.x-rail-logo[^{]*\{[^}]*w-full/u);
});

test("4. carrousel : contenu interne calibré en px et jamais coupé", () => {
  // Padding interne p-4 et titre en 20 px.
  assert.match(cssRules, /\.creator-carousel \.creator-slide[\s\S]*?padding: 16px/u);
  assert.match(cssRules, /\.discord-copy strong[\s\S]*?font-size: 20px/u);
  // Description sur deux lignes, interligne court.
  assert.match(cssRules, /\.discord-detail[\s\S]*?font-size: 12px;[\s\S]*?line-height: 16px;[\s\S]*?-webkit-line-clamp: 2/u);
  // Bouton REJOINDRE de 32 px de haut.
  assert.match(cssRules, /\.discord-action-default[\s\S]*?height: 32px/u);
  // Ligne du bas en 11 px, tronquée proprement plutôt que débordante.
  assert.match(cssRules, /\.discord-invite[\s\S]*?font-size: 11px/u);
  assert.match(cssRules, /text-overflow: ellipsis/u);
  // Les trois diapositives existent toujours dans le carrousel.
  for (const network of ["discord", "twitch", "youtube"]) {
    assert.ok(html.includes(`data-carousel-slide="${network}"`), `diapositive ${network} absente`);
  }
});

test("5. planning : horaire intégré au sous-titre, plus de badge flottant", () => {
  assert.doesNotMatch(html, /class="x-widget-time"/u);
  const sub = html.match(/<p class="x-widget-sub">([\s\S]*?)<\/p>/u);
  assert.ok(sub, "sous-titre du planning introuvable");
  assert.match(sub[1], /data-schedule-time/u);
  assert.match(sub[1], /Rendez-vous fixe · 22h00 \(heure FR\)/u);
  // Le script écrit l'horaire dans la même ligne, y compris le cas varié.
  assert.match(script, /Rendez-vous fixe · \$\{formatScheduleTimeBadge\(time\)\} \(heure FR\)/u);
  assert.match(script, /Horaires variés cette semaine · heure FR/u);
  assert.match(script, /Aucun live programmé pour le moment/u);
  // L'en-tête ne contient plus que le titre.
  const head = html.match(/<div class="x-widget-head">([\s\S]*?)<\/div>/u);
  assert.ok(head);
  assert.match(head[1], /Les prochains lives/u);
  assert.doesNotMatch(head[1], /HORAIRES|22H00/u);
  assert.match(cssRules, /\.x-widget--schedule \.x-widget-sub[\s\S]*?font-size: 12px/u);
});

test("6. échelle PC : colonnes élargies, sans zoom ni transform sur la page", () => {
  assert.match(cssRules, /@media \(min-width: 1024px\)[\s\S]*?\.x-shell[\s\S]*?max-width: 1380px/u);
  assert.match(cssRules, /\.x-main[\s\S]*?max-width: 650px/u);
  assert.match(cssRules, /\.x-right-rail[\s\S]*?width: 380px/u);
  // Interdits absolus : ils cassaient le centrage des modales.
  assert.doesNotMatch(cssRules, /(^|[^-\w])zoom\s*:/u);
  assert.doesNotMatch(cssRules, /body[^{]*\{[^}]*transform:\s*scale/u);
  assert.doesNotMatch(cssRules, /html[^{]*\{[^}]*transform:\s*scale/u);
});

test("la fonctionnalité de l'étape 3 reste branchée", () => {
  // Composeur, onglets du fil, notifications et actions de post : intacts.
  assert.match(html, /data-x-composer/u);
  assert.match(html, /Quoi de neuf dans le QG \?/u);
  for (const tab of ["all", "follows", "verified", "reposts"]) {
    assert.ok(html.includes(`data-x-feed-tab="${tab}"`), `onglet ${tab} absent`);
  }
  assert.match(html, /data-x-nav="notifications"/u);
  assert.ok(fs.existsSync(path.join(ROOT, "x-app.js")));
});
