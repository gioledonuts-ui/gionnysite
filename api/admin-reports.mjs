import { isAdminRequest, isSameOriginRequest } from "../lib/admin-security.mjs";
import {
  listVisitorAccounts,
  setVisitorAccountBadges,
  setVisitorAccountBanned,
} from "../lib/contact-inbox.mjs";
import {
  ensureStateLoaded,
  snapshotAdminState,
  syncStateToSupabase,
  writeAdminStateReplica,
} from "../lib/blob-store.mjs";
import {
  deleteReport,
  ensureEveryAccountFollowsHost,
  listReports,
  setReportStatus,
} from "../lib/social-graph.mjs";

// ---------------------------------------------------------------------------
// Panneau Admin · SIGNALEMENTS
// ---------------------------------------------------------------------------
// GET    /api/admin-reports                 → liste des signalements
// DELETE /api/admin-reports?id=…            → supprime un signalement
// PATCH  /api/admin-reports {id, action}    → action en un clic :
//          • handled / reopen  → marque traité ou rouvert
//          • unverify          → retire le badge Validé du compte signalé
//          • ban / unban       → bannit ou réactive le compte signalé
// Réservé à l'Hôte (session admin + rôle Hôte côté serveur comme pour
// /api/admin-members).

const MAX_BODY_BYTES = 4000;

function setNoStore(response) {
  response.setHeader("Cache-Control", "no-store, private");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Vary", "Cookie");
}

function readJsonBody(request) {
  if (request.body && typeof request.body === "object" && !Buffer.isBuffer(request.body)) {
    try {
      return Buffer.byteLength(JSON.stringify(request.body), "utf8") <= MAX_BODY_BYTES ? request.body : null;
    } catch {
      return null;
    }
  }
  const raw = Buffer.isBuffer(request.body)
    ? request.body.toString("utf8")
    : typeof request.body === "string"
      ? request.body
      : "";
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function queryValue(request, key) {
  const value = request.query?.[key];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  try {
    return new URL(request.url || "/", `https://${request.headers?.host || "localhost"}`).searchParams.get(key) || "";
  } catch {
    return "";
  }
}

function isIdentifier(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

/** Retrouve l'identifiant du compte signalé à partir de son pseudo. */
async function resolveMemberId(pseudo) {
  const wanted = String(pseudo || "").replace(/^@+/u, "").trim().toLowerCase();
  if (!wanted) return null;
  const aliases = ["gionny", "7gionny"].includes(wanted) ? new Set(["gionny", "7gionny"]) : new Set([wanted]);
  const page = await listVisitorAccounts("").catch(() => ({ members: [] }));
  const member = (Array.isArray(page.members) ? page.members : []).find(
    (entry) => aliases.has(String(entry.pseudo || "").trim().toLowerCase())
  );
  return member && isIdentifier(member.id) ? member.id : null;
}

function persisted(response, status, payload) {
  return syncStateToSupabase()
    .catch(() => ({ saved: false }))
    .then(() => response.status(status).json(payload));
}

export default async function handler(request, response) {
  setNoStore(response);
  await ensureStateLoaded().catch(() => {});

  if (!["GET", "PATCH", "DELETE"].includes(request.method)) {
    response.setHeader("Allow", "GET, PATCH, DELETE");
    return response.status(405).json({ error: "Méthode non autorisée." });
  }
  if (!isSameOriginRequest(request)) return response.status(403).json({ error: "Requête refusée." });
  if (!(await isAdminRequest(request))) {
    return response.status(401).json({ error: "Reconnecte-toi au panneau d’administration." });
  }

  try {
    if (request.method === "GET") {
      // Rattrape au passage les comptes créés avant la règle d'or : l'Hôte
      // ouvre l'admin, tout le monde suit l'Hôte.
      await ensureEveryAccountFollowsHost().catch(() => {});
      return response.status(200).json({ reports: await listReports() });
    }

    if (request.method === "DELETE") {
      const id = queryValue(request, "id");
      if (!isIdentifier(id)) return response.status(400).json({ error: "Choisis un signalement valide." });
      const result = await deleteReport(id);
      if (!result.ok) return response.status(404).json({ error: "Ce signalement n’existe déjà plus." });
      return persisted(response, 200, { ok: true, deleted: true });
    }

    const body = readJsonBody(request);
    if (!body || !isIdentifier(body.id) || typeof body.action !== "string") {
      return response.status(400).json({ error: "Choisis une action pour ce signalement." });
    }

    if (body.action === "handled" || body.action === "reopen") {
      const result = await setReportStatus(body.id, body.action === "handled" ? "handled" : "open");
      if (!result.ok) return response.status(404).json({ error: "Ce signalement n’existe déjà plus." });
      return persisted(response, 200, { ok: true, report: result.report });
    }

    const known = (await listReports()).some((entry) => entry.id === body.id);
    if (!known) return response.status(404).json({ error: "Ce signalement n’existe déjà plus." });

    // Les autres actions visent le compte signalé : le pseudo est résolu côté
    // serveur, on ne fait jamais confiance à un identifiant envoyé du navigateur.
    const memberId = await resolveMemberId(body.pseudo).catch(() => null);
    if (!memberId) {
      return response.status(404).json({ error: "Ce compte signalé n’existe plus." });
    }
    if (body.action === "unverify") {
      const result = await setVisitorAccountBadges(memberId, []);
      if (!result.ok) return response.status(404).json({ error: "Ce membre n’existe plus." });
      await writeAdminStateReplica(snapshotAdminState()).catch(() => {});
      await setReportStatus(body.id, "handled").catch(() => {});
      return persisted(response, 200, { ok: true, member: result.member, handled: true });
    }
    if (body.action === "ban" || body.action === "unban") {
      const result = await setVisitorAccountBanned(memberId, body.action === "ban");
      if (!result.ok) {
        if (result.reason === "host") return response.status(409).json({ error: "Le compte Hôte ne peut pas être banni." });
        return response.status(404).json({ error: "Ce membre n’existe plus." });
      }
      await writeAdminStateReplica(snapshotAdminState()).catch(() => {});
      if (body.action === "ban") await setReportStatus(body.id, "handled").catch(() => {});
      return persisted(response, 200, { ok: true, member: result.member, handled: body.action === "ban" });
    }

    return response.status(400).json({ error: "Cette action n’est pas reconnue." });
  } catch (error) {
    console.error("[admin-reports] report request failed", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return response.status(502).json({ error: "Les signalements ne peuvent pas être chargés pour le moment." });
  }
}
