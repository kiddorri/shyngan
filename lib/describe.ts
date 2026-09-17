// lib/describe.ts
// Краткое описание кампуса (требование 7). Собирается ТОЛЬКО из найденных данных:
// карточка Wikidata, покрытие по категориям, подписи vision к подтверждённым снимкам.
// Никакой генерации фактов: если чего-то нет в данных, этого нет и в тексте.

import { CATEGORY_LABELS, type Anchor, type CategoryCoverage, type PhotoItem, type UniversityCandidate } from "./types";

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function describeCampus(
  university: UniversityCandidate,
  anchor: Anchor | null,
  photos: PhotoItem[],
  coverage: CategoryCoverage[],
): string {
  const parts: string[] = [];

  // 1. Кто и где — из Wikidata.
  const what = university.instanceOf ?? "учебное заведение";
  const where = [university.city, university.country].filter(Boolean).join(", ");
  parts.push(`${university.label} — ${what}${where ? ` (${where})` : ""}.`);

  // 2. Что нашлось и насколько подтверждено.
  const total = photos.length;
  const verified = photos.filter((p) => p.trust === "verified").length;
  const covered = coverage.filter((c) => c.verified + c.probable + c.unverified > 0);
  if (total === 0) {
    parts.push("Фотографий, прошедших проверку, не найдено.");
  } else {
    const cats = covered.map((c) => CATEGORY_LABELS[c.category].toLowerCase()).join(", ");
    parts.push(`Найдено ${total} фото по категориям: ${cats}; подтверждено ${verified}.`);
  }

  // 3. Что видно на подтверждённых снимках — подписи vision, без домыслов.
  const captions = photos
    .filter((p) => p.trust === "verified" && p.evidence.vision?.caption)
    .map((p) => p.evidence.vision!.caption.trim())
    .filter((c, i, arr) => c && arr.indexOf(c) === i)
    .slice(0, 5);
  if (captions.length > 0) {
    parts.push(`На подтверждённых снимках: ${captions.join("; ")}.`);
  }

  // 4. Чем подтверждали.
  if (anchor?.source === "wikidata") {
    parts.push("Координаты кампуса взяты из Wikidata и сверены с Google Places.");
  } else if (anchor?.source === "places+2gis") {
    parts.push("Координат в Wikidata нет; расположение подтверждено совпадением Google Places и 2ГИС.");
  } else if (anchor?.source === "places") {
    parts.push("Координат в Wikidata нет; расположение известно только по Google Places, поэтому доверие понижено.");
  }

  const host = hostOf(university.officialWebsite);
  if (host) parts.push(`Официальный сайт: ${host}.`);

  return parts.join(" ");
}
