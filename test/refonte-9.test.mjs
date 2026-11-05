import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [indexHtml, gate, gateCss, worksHtml, worksJs, accessApi, adminHtml, adminJs, siteConfig] =
  await Promise.all([
    read("index.html"),
    read("gate.js"),
    read("social-x.css"),
    read("travaux.html"),
    read("travaux.js"),
    read("api/site-config.mjs"),
    read("gestion-qg/index.html"),
    read("gestion-qg/admin.js"),
    read("lib/site-config.mjs"),
  ]);

// ---------------------------------------------------------------------------
// 1. Le rideau existe et démarre fermé
// ---------------------------------------------------------------------------
test("1. la page principale porte le rideau « Site en travaux »", () => {
  assert.match(indexHtml, /<div class="works-gate" data-works-gate hidden>/u);
  assert.match(indexHtml, /Site en <span>travaux<\/span>/u);
  assert.match(indexHtml, /<script src="\/gate\.js" defer><\/script>/u);
  // Le rideau est déclaré AVANT le site pour peindre en premier.
  assert.ok(indexHtml.indexOf("data-works-gate") < indexHtml.indexOf('class="x-shell"'));
});

test("1 bis. le planning est à gauche, les réseaux à droite", () => {
  const columns = indexHtml.slice(indexHtml.indexOf("works-gate-columns"), indexHtml.indexOf("works-gate-foot"));
  const scheduleIndex = columns.indexOf("data-gate-schedule-days");
  const networksIndex = columns.indexOf("data-gate-link=\"discord\"");
  assert.ok(scheduleIndex > -1 && networksIndex > -1);
  assert.ok(scheduleIndex < networksIndex, "le planning précède les réseaux");
  assert.match(gateCss, /\.works-gate-columns \{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/u);
});

test("1 ter. le site derrière est flouté et non cliquable", () => {
  assert.match(gate, /shell\.setAttribute\("inert", ""\)/u);
  assert.match(gate, /shell\.setAttribute\("aria-hidden", "true"\)/u);
  assert.match(gateCss, /html\.qg-works \.x-shell \{[^}]*filter: blur\(/u);
  // Aucun zoom : la consigne du projet reste tenue.
  const block = gateCss.slice(gateCss.indexOf("html.qg-works .x-shell {"));
  assert.doesNotMatch(block.slice(0, 320), /transform:\s*scale|zoom:/u);
});

// ---------------------------------------------------------------------------
// 2. Accès hôte
// ---------------------------------------------------------------------------
test("2. seul l'hôte peut entrer sur le site", () => {
  assert.match(accessApi, /export async function viewerCanEnter/u);
  assert.match(accessApi, /return isAdminRequest\(request\)\.catch\(\(\) => false\)/u);
  assert.match(gate, /data\.locked === false \|\| data\.canEnter === true/u);
  assert.match(gate, /params\.get\("suite"\) === "1"/u);
});

test("2 bis. l'admin permet de voir le site et d'ouvrir/fermer le rideau", () => {
  assert.match(adminHtml, /data-admin-gate-view>Voir le site</u);
  assert.match(adminHtml, /href="\/\?suite=1"/u);
  assert.match(adminHtml, /data-admin-gate-toggle/u);
  assert.match(adminJs, /body: JSON\.stringify\(\{ locked: next \}\)/u);
  assert.match(adminJs, /"Ouvrir au public" : "Fermer au public"/u);
});

test("2 ter. l'API n'ouvre le rideau qu'à une session admin valide", async () => {
  assert.match(accessApi, /if \(!\(await viewerCanEnter\(request\)\)\) \{\s*\n\s*return response\.status\(401\)/u);
  assert.match(accessApi, /if \(request\.query\?\.access === "1"\)/u);
  assert.match(accessApi, /const next = \{ \.\.\.base, siteLocked: body\.locked \}/u);
  // Le rideau doit rester une réécriture : 12 fonctions maximum en Hobby.
  const vercel = JSON.parse(await read("vercel.json"));
  const route = vercel.rewrites.find((rewrite) => rewrite.source === "/api/access");
  assert.equal(route.destination, "/api/site-config?access=1");
});

// ---------------------------------------------------------------------------
// 3. Configuration : fermé par défaut
// ---------------------------------------------------------------------------
test("3. le site est fermé par défaut, et reste fermé sans config", async () => {
  const { makeDefaultSiteConfig, validateSiteConfig, SITE_LOCKED_BY_DEFAULT } =
    await import("../lib/site-config.mjs");
  assert.equal(SITE_LOCKED_BY_DEFAULT, true);
  const base = makeDefaultSiteConfig();
  assert.equal(base.siteLocked, true);

  const legacy = validateSiteConfig({ version: 1, socials: base.socials, schedule: base.schedule });
  assert.equal(legacy.ok, true);
  assert.equal(legacy.config.siteLocked, true, "une config sans champ reste fermée");

  const opened = validateSiteConfig({ ...base, siteLocked: false });
  assert.equal(opened.ok, true);
  assert.equal(opened.config.siteLocked, false);

  const { isPublicLocked } = await import("../api/site-config.mjs");
  assert.equal(isPublicLocked(null), true);
  assert.equal(isPublicLocked({}), true);
  assert.equal(isPublicLocked({ siteLocked: false }), false);
});

// ---------------------------------------------------------------------------
// 4. Page d'attente autonome (repli sans JavaScript du site)
// ---------------------------------------------------------------------------
test("4. /travaux est une page complète, prête et sobre", () => {
  assert.match(worksHtml, /<title>QG2GIONNY — Site en travaux<\/title>/u);
  assert.match(worksHtml, /class="works-preview" aria-hidden="true" inert/u);
  assert.match(worksHtml, /class="works-card works-card--schedule"/u);
  assert.match(worksHtml, /class="works-card works-card--networks"/u);
  assert.ok(
    worksHtml.indexOf("works-card--schedule") < worksHtml.indexOf("works-card--networks"),
    "planning à gauche, réseaux à droite"
  );
  assert.match(worksJs, /if \(data\?\.canEnter === true\) addHostAccess\(\)/u);
  assert.match(worksJs, /button\.href = "\/\?suite=1"/u);
  // Le visiteur lambda n'a aucun moyen d'entrer.
  assert.doesNotMatch(worksHtml, /href="\/\?suite=1"/u);
});

test("4 bis. la config reste rétro-compatible pour les autres champs", async () => {
  const { makeDefaultSiteConfig, validateSiteConfig } = await import("../lib/site-config.mjs");
  const base = makeDefaultSiteConfig();
  const result = validateSiteConfig({ ...base, siteLocked: false, announcements: ["Coucou"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.announcements, ["Coucou"]);
  assert.equal(result.config.siteLocked, false);
  assert.equal(typeof result.config.schedule.monday.time, "string");
  assert.match(siteConfig, /siteLocked: SITE_LOCKED_BY_DEFAULT/u);
});
