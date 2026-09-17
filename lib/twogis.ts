// lib/twogis.ts
// 2ГИС Places API 3.0: поиск организации по названию → координаты.
// Используется ТОЛЬКО как независимый источник координат для вузов, у которых
// нет P625 в Wikidata. Фотографии из 2ГИС не берём: Catalog API их не отдаёт.
//
// Если ключа нет — функция возвращает null и профиль работает без 2ГИС.

const ENDPOINT = "https://catalog.api.2gis.com/3.0/items";
const REQUEST_TIMEOUT_MS = 6000;

export type TwoGisHit = {
  lat: number;
  lon: number;
  name: string;
  address: string | null;
};

type Item = {
  name?: string;
  address_name?: string;
  type?: string;
  point?: { lat: number; lon: number };
};

export async function findInTwoGis(
  query: string,
  near: { lat: number; lon: number } | null,
): Promise<TwoGisHit | null> {
  const key = process.env.TWOGIS_API_KEY;
  if (!key) return null;

  const params = new URLSearchParams({
    q: query,
    fields: "items.point",
    page_size: "5",
    key,
  });
  // Формат location у 2ГИС — "lon,lat" (долгота первой).
  if (near) params.set("location", `${near.lon},${near.lat}`);

  try {
    const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    const json = (await res.json()) as { result?: { items?: Item[] } };
    const items = json.result?.items ?? [];

    // Организация ("branch") предпочтительнее здания или района.
    const ordered = [...items.filter((i) => i.type === "branch"), ...items.filter((i) => i.type !== "branch")];
    const hit = ordered.find((i) => i.point && Number.isFinite(i.point.lat) && Number.isFinite(i.point.lon));
    if (!hit || !hit.point) return null;

    return {
      lat: hit.point.lat,
      lon: hit.point.lon,
      name: hit.name ?? query,
      address: hit.address_name ?? null,
    };
  } catch {
    return null;
  }
}
