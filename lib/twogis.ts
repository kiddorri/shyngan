// lib/twogis.ts
// 2ГИС Places API 3.0: поиск организации по названию → координаты.
// Используется ТОЛЬКО как независимый источник координат для вузов, у которых
// нет P625 в Wikidata. Фотографии из 2ГИС не берём: Catalog API их не отдаёт.
//
// Если ключа нет — функция возвращает null и профиль работает без 2ГИС.

import { haversineM } from "./geo";

const ENDPOINT = "https://catalog.api.2gis.com/3.0/items";
const REQUEST_TIMEOUT_MS = 6000;
const MAX_NEAR_DISTANCE_M = 5000;

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

    // location — мягкое ограничение поиска: первый ответ может оказаться в
    // другом городе. Берём ближайшую организацию и отбрасываем дальние совпадения.
    const ordered = items
      .filter((i) => i.point && Number.isFinite(i.point.lat) && Number.isFinite(i.point.lon))
      .sort((a, b) =>
        Number(b.type === "branch") - Number(a.type === "branch") ||
        (near ? haversineM(near.lat, near.lon, a.point!.lat, a.point!.lon) -
          haversineM(near.lat, near.lon, b.point!.lat, b.point!.lon) : 0),
      );
    const hit = ordered[0];
    if (!hit || !hit.point) return null;
    if (near && haversineM(near.lat, near.lon, hit.point.lat, hit.point.lon) > MAX_NEAR_DISTANCE_M) return null;

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
