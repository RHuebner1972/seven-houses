import type { Reading } from "./types";

export const DAILY_CACHE_KEY = "sh.lastDaily";

/** What `sh.lastDaily` holds: the card is the user's, so it is keyed by who drew it. */
export interface CachedDaily {
  userId: string | null;
  /** the local calendar day the reading belongs to */
  localDate: string;
  reading: Reading;
}

export function readDailyCache(): string | null {
  try {
    return localStorage.getItem(DAILY_CACHE_KEY);
  } catch {
    return null;
  }
}

/**
 * The cached reading for `userId` on `today`, or null. Entries written for another user,
 * another day, or in the pre-scoping shape (no `userId`) are ignored.
 */
export function parseDailyCache(raw: string | null, userId: string | null, today: string): Reading | null {
  try {
    if (!raw || !userId) return null;
    const c = JSON.parse(raw) as Partial<CachedDaily> | null;
    if (!c || typeof c !== "object" || !("userId" in c)) return null;
    return c.userId === userId && c.localDate === today && c.reading?.cards?.length ? c.reading : null;
  } catch {
    return null;
  }
}

export function writeDailyCache(entry: CachedDaily) {
  try {
    localStorage.setItem(DAILY_CACHE_KEY, JSON.stringify(entry));
  } catch {
    /* storage full or unavailable */
  }
}

export function clearDailyCache() {
  try {
    localStorage.removeItem(DAILY_CACHE_KEY);
  } catch {
    /* storage unavailable */
  }
}
