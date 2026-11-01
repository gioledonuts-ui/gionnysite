const DISCORD_INVITE_API = "https://discord.com/api/v9/invites";
const INVITE_CODE_PATTERN = /^[A-Za-z0-9-]{2,64}$/u;
const FETCH_TIMEOUT_MS = 5_000;

function readInviteCode(request) {
  const queryValue = request.query?.invite;
  if (typeof queryValue === "string") return queryValue;
  if (Array.isArray(queryValue) && typeof queryValue[0] === "string") return queryValue[0];

  try {
    return new URL(request.url || "/", `https://${request.headers?.host || "localhost"}`)
      .searchParams.get("invite") || "";
  } catch {
    return "";
  }
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=30");
  response.setHeader("Content-Type", "application/json; charset=utf-8");

  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ available: false, error: "Method not allowed" });
  }

  const inviteCode = readInviteCode(request);
  if (!INVITE_CODE_PATTERN.test(inviteCode)) {
    return response.status(400).json({ available: false, error: "Invite code is invalid" });
  }

  try {
    const url = `${DISCORD_INVITE_API}/${encodeURIComponent(inviteCode)}?with_counts=true`;
    const upstream = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "GionnySite/1.0 (+https://qg2gionny.vercel.app)",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!upstream.ok) return response.status(200).json({ available: false });

    const invite = await upstream.json();
    const onlineCount = invite?.approximate_presence_count;
    if (!Number.isSafeInteger(onlineCount) || onlineCount < 0) {
      return response.status(200).json({ available: false });
    }

    return response.status(200).json({ available: true, onlineCount });
  } catch {
    return response.status(200).json({ available: false });
  }
}
