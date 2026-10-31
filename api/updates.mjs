const TWITCH_LOGIN = "7gionny";
const YOUTUBE_HANDLE = "@gionnyyy";
const TWITCH_URL = `https://www.twitch.tv/${TWITCH_LOGIN}`;
const YOUTUBE_CHANNEL_URL = `https://www.youtube.com/${YOUTUBE_HANDLE}`;
const FETCH_TIMEOUT_MS = 4_000;

let cachedTwitchToken = "";
let cachedTwitchTokenClientId = "";
let cachedTwitchTokenExpiresAt = 0;

async function getTwitchAppToken(clientId, clientSecret) {
  if (
    cachedTwitchToken &&
    cachedTwitchTokenClientId === clientId &&
    Date.now() < cachedTwitchTokenExpiresAt - 60_000
  ) {
    return cachedTwitchToken;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });
  const response = await fetch("https://id.twitch.tv/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error("Twitch token request failed");

  const token = await response.json();
  if (!token.access_token || !token.expires_in) throw new Error("Twitch returned no app token");

  cachedTwitchToken = token.access_token;
  cachedTwitchTokenClientId = clientId;
  cachedTwitchTokenExpiresAt = Date.now() + token.expires_in * 1000;
  return cachedTwitchToken;
}

async function getTwitchStatus() {
  const clientId = process.env.TWITCH_CLIENT_ID?.trim();
  const clientSecret = process.env.TWITCH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return { available: false, isLive: null, url: TWITCH_URL };

  const accessToken = await getTwitchAppToken(clientId, clientSecret);
  const params = new URLSearchParams({ user_login: TWITCH_LOGIN });
  const response = await fetch(`https://api.twitch.tv/helix/streams?${params}`, {
    headers: {
      "Client-ID": clientId,
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!response.ok) throw new Error("Twitch stream request failed");

  const payload = await response.json();
  const stream = payload.data?.[0];
  if (!stream) return { available: true, isLive: false, url: TWITCH_URL };

  return {
    available: true,
    isLive: true,
    title: typeof stream.title === "string" ? stream.title : "",
    category: typeof stream.game_name === "string" ? stream.game_name : "",
    url: TWITCH_URL,
  };
}

async function getRecentYouTubeVideos() {
  const apiKey = process.env.YOUTUBE_API_KEY?.trim();
  if (!apiKey) return { available: false, url: YOUTUBE_CHANNEL_URL, uploads: [] };

  const channelParams = new URLSearchParams({
    part: "contentDetails",
    forHandle: YOUTUBE_HANDLE,
    key: apiKey,
  });
  const channelResponse = await fetch(
    `https://www.googleapis.com/youtube/v3/channels?${channelParams}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
  );
  if (!channelResponse.ok) throw new Error("YouTube channel request failed");

  const channelPayload = await channelResponse.json();
  const uploadsPlaylistId = channelPayload.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) return { available: false, url: YOUTUBE_CHANNEL_URL, uploads: [] };

  const videoParams = new URLSearchParams({
    part: "snippet,contentDetails",
    playlistId: uploadsPlaylistId,
    maxResults: "50",
    key: apiKey,
  });
  const videoResponse = await fetch(
    `https://www.googleapis.com/youtube/v3/playlistItems?${videoParams}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
  );
  if (!videoResponse.ok) throw new Error("YouTube uploads request failed");

  const videoPayload = await videoResponse.json();
  const uploads = (Array.isArray(videoPayload.items) ? videoPayload.items : [])
    .map((item) => {
      const videoId = item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId;
      if (typeof videoId !== "string" || !videoId) return null;

      const publishedAt =
        item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt || "";
      return {
        id: videoId,
        publishedAt: typeof publishedAt === "string" ? publishedAt : "",
        title: typeof item.snippet?.title === "string" ? item.snippet.title : "",
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      };
    })
    .filter((upload) => upload && Number.isFinite(Date.parse(upload.publishedAt)))
    .sort((first, second) => Date.parse(second.publishedAt) - Date.parse(first.publishedAt));

  const latestVideo = uploads[0];
  return {
    available: true,
    title: latestVideo?.title || "",
    url: latestVideo?.url || YOUTUBE_CHANNEL_URL,
    uploads,
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
    getRecentYouTubeVideos(),
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
