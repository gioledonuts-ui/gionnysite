import { readPostMedia } from "../lib/social-graph.mjs";
import { ensureStateLoaded } from "../lib/blob-store.mjs";

// ---------------------------------------------------------------------------
// Médias des posts du fil
// ---------------------------------------------------------------------------
// GET /api/media?post=<uuid>&kind=image|vocal|video
//
// Le binaire vit dans l'état durable (Supabase inclus), jamais dans le JSON du
// fil : l'API le sert ici, avec un cache privé court et un type MIME strict.
// Aucune écriture n'est acceptée sur cette route : les médias se déposent via
// POST /api/profile (action `media`), une fois le post créé.

const MEDIA_TYPES = {
  image: "image/webp",
  vocal: "audio/webm",
  video: "video/mp4",
};

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

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "private, max-age=120");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Vary", "Cookie");

  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return response.status(405).json({ error: "Méthode non autorisée." });
  }

  const postId = queryValue(request, "post");
  const kind = queryValue(request, "kind");
  if (!postId || !MEDIA_TYPES[kind]) {
    return response.status(400).json({ error: "Ce média n’est pas valide." });
  }

  await ensureStateLoaded().catch(() => {});
  try {
    const media = await readPostMedia({ postId, kind });
    if (!media) return response.status(404).json({ error: "Ce média n’existe plus." });
    const buffer = await streamToBuffer(media.stream);
    response.setHeader("Content-Type", MEDIA_TYPES[kind]);
    response.setHeader("Content-Length", String(buffer.length));
    if (request.method === "HEAD") return response.status(200).end();
    return response.status(200).send(buffer);
  } catch {
    return response.status(502).json({ error: "Ce média ne peut pas être chargé pour le moment." });
  }
}
