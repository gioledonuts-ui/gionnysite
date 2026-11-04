import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [indexHtml, socialCss, messages, adminHtml, adminJs, siteConfig, settingsLib, script] = await Promise.all([
  read("index.html"),
  read("social-x.css"),
  read("x-messages.js"),
  read("gestion-qg/index.html"),
  read("gestion-qg/admin.js"),
  read("lib/site-config.mjs"),
  read("lib/discord-link.mjs"),
  read("script.js"),
]);

// ---------------------------------------------------------------------------
// 1. Messagerie : boîte de réception et demandes
// ---------------------------------------------------------------------------
test("1. la page Messages a deux sous-onglets et un bouton « nouveau message »", () => {
  assert.match(indexHtml, /data-x-dm-tab="inbox" aria-selected="true">Boîte de réception</u);
  assert.match(indexHtml, /data-x-dm-tab="requests"[\s\S]{0,80}Demandes/u);
  assert.match(indexHtml, /data-x-new-thread aria-label="Nouveau message ou nouveau groupe"/u);
  assert.match(indexHtml, /data-x-dm-list role="list"/u);
  assert.match(indexHtml, /data-x-dm-requests-count/u);
});

test("1 bis. une demande se traite par Accepter ou Refuser / Bloquer", () => {
  assert.match(messages, /accept\.textContent = "Accepter"/u);
  assert.match(messages, /refuse\.textContent = "Refuser \/ Bloquer"/u);
  assert.match(messages, /action,\s*\n\s*threadId: entry\.id/u);
  assert.match(messages, /entry\.requestState === "incoming"/u);
});

test("1 ter. les groupes se créent avec plusieurs membres Validés", () => {
  assert.match(indexHtml, /data-x-dm-group-title/u);
  assert.match(indexHtml, /data-x-dm-search/u);
  assert.match(messages, /action: "group", members: chosen\.map/u);
  assert.match(messages, /action: "direct", pseudo: chosen\[0\]\.pseudo/u);
  assert.match(indexHtml, /réservés aux membres Validés ✓/u);
});

// ---------------------------------------------------------------------------
// 2. Paramètres
// ---------------------------------------------------------------------------
test("2. le libellé exact « Masquer les posts des comptes non-validés »", () => {
  const occurrences = [...indexHtml.matchAll(/Masquer les posts des comptes non-validés/gu)];
  assert.equal(occurrences.length, 4, "deux libellés + deux aria-label");
  assert.doesNotMatch(indexHtml, /Masquer l’activité des comptes non-validés/u);
});

test("2 bis. les cartes de paramètres suivent la sobriété demandée", () => {
  assert.match(socialCss, /\.x-settings-card,\s*\n\.x-setting-card \{[\s\S]{0,160}border: 1px solid #1e293b;[\s\S]{0,120}background: #0e1525;/u);
  assert.match(socialCss, /\.x-settings-card,[\s\S]{0,80}border-radius: 16px;/u);
});

test("2 ter. un compte bloqué se débloque depuis les paramètres", () => {
  assert.match(indexHtml, /data-x-blocked-list role="list"/u);
  assert.match(settingsLib, /action === "unblock"/u);
  assert.match(settingsLib, /setBlock\(\{ pseudo, target: body\.target \|\| body\.pseudo, blocked: false \}\)/u);
});

test("2 quater. Discord se lie sans recréer le compte (ID + pseudo seulement)", () => {
  assert.match(indexHtml, /data-x-discord-id-input/u);
  assert.match(indexHtml, /data-x-discord-username-input/u);
  assert.doesNotMatch(indexHtml, /discord.*avatarData/iu);
  assert.match(settingsLib, /linkDiscordAccount\(sessionToken, \{ discordId, discordUsername \}\)/u);
});

// ---------------------------------------------------------------------------
// 3. Administration
// ---------------------------------------------------------------------------
test("3. l'admin a les quatre sections attendues", () => {
  assert.match(adminHtml, /data-admin-tab="conversations"/u);
  assert.match(adminHtml, /data-admin-tab="members"/u);
  assert.match(adminHtml, /data-admin-tab="reports"/u);
  assert.match(adminHtml, /data-admin-tab="planning"/u);
  assert.match(adminHtml, /Planning &amp; à la une/u);
});

test("3 bis. l'onglet DISCUSSIONS (DM) affiche liste + chat complet", () => {
  assert.match(adminHtml, /data-admin-tab="dm"[^>]*aria-label="Discussions directes"/u);
  assert.match(adminHtml, /Discussions \(DM\)/u);
  assert.match(adminHtml, /data-dm-list role="list"/u);
  assert.match(adminHtml, /data-dm-history role="log"/u);
  assert.match(adminHtml, /data-dm-form/u);
  assert.match(adminJs, /\/api\/admin-messages\?view=dm-threads/u);
  assert.match(adminJs, /\/api\/admin-messages\?view=dm-thread&id=/u);
  assert.match(adminJs, /ticks\.textContent = "✓✓"/u);
});

test("3 ter bis. l'API admin des DM ne sert que les fils de Gionny", async () => {
  const adminMessages = await read("api/admin-messages.mjs");
  assert.match(adminMessages, /view === "dm-threads"/u);
  assert.match(adminMessages, /listInbox\(\{ pseudo: "Gionny" \}\)/u);
  assert.match(adminMessages, /getThreadForMember\(\{ pseudo: "Gionny", threadId \}\)/u);
});

test("3 bis. chaque membre lié montre son pseudo et son ID Discord", () => {
  assert.match(adminJs, /`Discord : @\$\{member\.discordUsername\}`|Discord : @\$\{member\.discordUsername\}/u);
  assert.match(adminJs, /· ID : \$\{member\.discordId\}/u);
});

test("3 ter. les interrupteurs Validé / Hôte et la suspension sont présents", () => {
  assert.match(adminJs, /\[ ✓ VALIDÉ \]/u);
  assert.match(adminJs, /\[ 👑 HÔTE \]/u);
  assert.match(adminJs, /member\.status === "banned" \? "Réactiver" : "Bannir"/u);
});

test("3 quater. un signalement s'ignore, se supprime ou bannit", () => {
  assert.match(adminJs, /ignoreButton\.textContent = handled \? "Rouvrir" : "Ignorer"/u);
  assert.match(adminJs, /removePostButton\.textContent = "Supprimer le post"/u);
  assert.match(adminJs, /banButton\.textContent = "Bannir l’utilisateur"/u);
  assert.match(adminJs, /reportAction\(report, "remove-post", removePostButton\)/u);
});

test("3 quinquies. le planning édite les jours et les annonces, enregistrés en direct", () => {
  assert.match(adminHtml, /data-planning-days/u);
  assert.match(adminHtml, /data-planning-announcements/u);
  assert.match(adminHtml, /data-planning-save/u);
  assert.match(adminJs, /const savePlanning = async \(\) => \{/u);
  assert.match(adminJs, /announcements,/u);
  assert.match(adminJs, /body: JSON\.stringify\(collectPlanning\(\)\)/u);
});

// ---------------------------------------------------------------------------
// 4. Configuration du site : annonces
// ---------------------------------------------------------------------------
test("4. les annonces sont un champ facultatif validé côté serveur", async () => {
  const { makeDefaultSiteConfig, validateSiteConfig, MAX_ANNOUNCEMENTS, MAX_ANNOUNCEMENT_LENGTH } =
    await import("../lib/site-config.mjs");
  const base = makeDefaultSiteConfig();
  assert.ok(Array.isArray(base.announcements));

  const ok = validateSiteConfig({ ...base, announcements: ["  a   b  ", "", "c"] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.config.announcements, ["a b", "c"]);

  // Absent : les valeurs par défaut restent, aucune régression.
  const legacy = validateSiteConfig({ version: 1, socials: base.socials, schedule: base.schedule });
  assert.equal(legacy.ok, true);
  assert.ok(legacy.config.announcements.length > 0);

  const tooLong = validateSiteConfig({ ...base, announcements: ["x".repeat(MAX_ANNOUNCEMENT_LENGTH + 1)] });
  assert.equal(tooLong.ok, false);

  const tooMany = validateSiteConfig({ ...base, announcements: Array(MAX_ANNOUNCEMENTS + 1).fill("ok") });
  assert.equal(tooMany.ok, true, "on tronque proprement au lieu de refuser");
  assert.equal(tooMany.config.announcements.length, MAX_ANNOUNCEMENTS);
});

test("4 bis. le bandeau public affiche les annonces sans halo coloré", () => {
  assert.match(indexHtml, /data-ticker-announcements/u);
  assert.match(script, /renderAnnouncements\(config\.announcements\)/u);
  assert.match(socialCss, /\.ticker-item--news \.ticker-eyebrow \{\s*\n\s*color: #38bdf8;/u);
  // Aucun halo : la règle du bandeau d'annonces ne porte ni ombre ni lueur.
  const newsBlock = socialCss.slice(
    socialCss.lastIndexOf(".ticker-item--news {"),
    socialCss.indexOf("}", socialCss.lastIndexOf(".ticker-item--news {"))
  );
  // `box-shadow: none` neutralise explicitement tout halo hérité.
  assert.match(newsBlock, /box-shadow: none;/u);
  assert.doesNotMatch(newsBlock, /drop-shadow|text-shadow|rgba\(/u);
});
