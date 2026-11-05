const TWITCH_LOGIN = "7gionny";
const YOUTUBE_HANDLE = "@Gionnyyy";
const TWITCH_URL = `https://www.twitch.tv/${TWITCH_LOGIN}`;
const YOUTUBE_CHANNEL_URL = `https://www.youtube.com/${YOUTUBE_HANDLE}`;
const DECAPI_BASE_URL = "https://decapi.me";
const FETCH_TIMEOUT_MS = 5_000;
const UPTIME_PATTERN = /\b\d+\s*(?:days?|hours?|minutes?|seconds?)\b/i;

async function fetchDecapiText(path) {
  const response = await fetch(`${DECAPI_BASE_URL}${path}`, {
    headers: { Accept: "text/plain" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("Public status service request failed");
  return (await response.text()).trim();
}

async function getTwitchStatus() {
  const uptime = await fetchDecapiText(`/twitch/uptime/${encodeURIComponent(TWITCH_LOGIN)}`);

  if (/\boffline\b/i.test(uptime)) {
    return { available: true, isLive: false, url: TWITCH_URL };
  }
  if (!UPTIME_PATTERN.test(uptime)) {
    return { available: false, isLive: null, url: TWITCH_URL };
  }

  let title = "";
  try {
    title = await fetchDecapiText(`/twitch/title/${encodeURIComponent(TWITCH_LOGIN)}`);
  } catch {
    // A title lookup failure must not hide a live status confirmed by the uptime endpoint.
  }

  return {
    available: true,
    isLive: true,
    title,
    url: TWITCH_URL,
  };
}

function parseLatestYouTubeVideo(responseText) {
  const match = responseText.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;

  const rawUrl = match[0].replace(/[),.;!?]+$/u, "");
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:") return null;

  let videoId = "";
  if (parsed.hostname === "youtu.be") {
    videoId = parsed.pathname.split("/").filter(Boolean)[0] || "";
  } else if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(parsed.hostname)) {
    videoId =
      parsed.searchParams.get("v") ||
      parsed.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/u)?.[1] ||
      "";
  }

  if (!/^[A-Za-z0-9_-]{6,20}$/u.test(videoId)) return null;

  const title = responseText
    .slice(0, match.index)
    .replace(/[\s\-–—|:]+$/u, "")
    .trim();
  return {
    id: videoId,
    title,
    url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
  };
}

async function getLatestYouTubeVideo() {
  const params = new URLSearchParams({ handle: YOUTUBE_HANDLE });
  const responseText = await fetchDecapiText(`/youtube/latest_video?${params}`);
  const video = parseLatestYouTubeVideo(responseText);
  if (!video) {
    return { available: false, url: YOUTUBE_CHANNEL_URL, uploads: [] };
  }

  return {
    available: true,
    title: video.title,
    url: video.url,
    // The public no-key source gives us the latest video ID, but not its publication time.
    // The browser compares IDs first and uses this fetch time only as a fallback marker.
    uploads: [{ ...video, publishedAt: new Date().toISOString() }],
  };
}

export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    return response.status(405).json({ error: "Method not allowed" });
  }

  response.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=180");

  const [twitchResult, youtubeResult] = await Promise.allSettled([
    getTwitchStatus(),
    getLatestYouTubeVideo(),
  ]);

  const twitch =
    twitchResult.status === "fulfilled"
      ? twitchResult.value
      : { available: false, isLive: null, url: TWITCH_URL };
  const youtube =
    youtubeResult.status === "fulfilled"
      ? youtubeResult.value
      : { available: false, url: YOUTUBE_CHANNEL_URL, uploads: [] };

  return response.status(200).json({ twitch, youtube, updatedAt: new Date().toISOString() });
}
