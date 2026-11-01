import { randomUUID } from "node:crypto";
import { del, get, list, put } from "@vercel/blob";

const MESSAGE_PREFIX = "gionny/inbox/";
const MESSAGE_PATH_PATTERN = /^gionny\/inbox\/\d{13}-[0-9a-f-]{36}\.json$/u;
const PAGE_SIZE = 40;

export function isContactMessagePath(pathname) {
  return typeof pathname === "string" && MESSAGE_PATH_PATTERN.test(pathname);
}

export async function saveContactMessage({ pseudo, message }) {
  const createdAt = new Date().toISOString();
  const pathname = `${MESSAGE_PREFIX}${Date.now()}-${randomUUID()}.json`;
  const body = JSON.stringify({ version: 1, createdAt, pseudo, message });

  await put(pathname, body, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: "application/json; charset=utf-8",
  });

  return { createdAt };
}

async function readOneMessage(pathname) {
  try {
    const result = await get(pathname, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;

    const stored = JSON.parse(await new Response(result.stream).text());
    if (
      stored?.version !== 1 ||
      typeof stored.pseudo !== "string" ||
      typeof stored.message !== "string" ||
      typeof stored.createdAt !== "string" ||
      !Number.isFinite(Date.parse(stored.createdAt))
    ) {
      return null;
    }

    return {
      id: pathname,
      pseudo: stored.pseudo,
      message: stored.message,
      createdAt: stored.createdAt,
    };
  } catch {
    // Ignore a damaged message without blocking the rest of the inbox.
    return null;
  }
}

export async function listContactMessages(cursor = "") {
  const page = await list({
    prefix: MESSAGE_PREFIX,
    limit: PAGE_SIZE,
    ...(cursor ? { cursor } : {}),
  });

  const messages = (await Promise.all(page.blobs.map(({ pathname }) => readOneMessage(pathname))))
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

  const hasMore = page.hasMore === true && typeof page.cursor === "string";
  return {
    messages,
    hasMore,
    cursor: hasMore ? page.cursor : null,
  };
}

export async function deleteContactMessage(pathname) {
  if (!isContactMessagePath(pathname)) return false;
  await del(pathname);
  return true;
}
