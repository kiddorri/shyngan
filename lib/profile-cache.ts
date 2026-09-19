import type { Profile, ProfileMode } from "./types";

// Ссылки Google Places на изображения короткоживущие: сохраняем готовый профиль
// только на время повторных открытий во время одной демонстрации.
export const PROFILE_CACHE_TTL_MS = 90_000;
const MAX_ENTRIES = 24;
const entries = new Map<string, { profile: Profile; savedAt: number }>();

function key(qid: string, mode: ProfileMode): string {
  return `${qid}:${mode}`;
}

export function cachedProfile(qid: string, mode: ProfileMode): { profile: Profile; ageMs: number } | null {
  const entry = entries.get(key(qid, mode));
  if (!entry) return null;
  const ageMs = Date.now() - entry.savedAt;
  if (ageMs >= PROFILE_CACHE_TTL_MS) {
    entries.delete(key(qid, mode));
    return null;
  }
  return { profile: entry.profile, ageMs };
}

export function saveProfile(profile: Profile): void {
  const cacheKey = key(profile.university.qid, profile.mode);
  entries.delete(cacheKey);
  entries.set(cacheKey, { profile, savedAt: Date.now() - (profile.cacheAgeMs ?? 0) });
  if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}
