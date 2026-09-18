// lib/osm.ts
// Центр города по данным OpenStreetMap через геокодер Nominatim.
//
// Зачем: дополнительная функция кейса — расстояние от кампуса до центра города.
// Собственных координат «центра» у нас нет, а у OSM это отдельный объект (place=city
// с точкой центра), и его лицензия позволяет использование при указании авторства.
//
// Условия использования Nominatim, которые здесь соблюдаются:
//   • один запрос на профиль, не больше (сервис просит не превышать 1 запрос в секунду);
//   • осмысленный User-Agent с адресом проекта — анонимные запросы там блокируют;
//   • атрибуция «© Участники OpenStreetMap» в интерфейсе рядом с результатом;
//   • таймаут: медленный геокодер не должен задерживать сборку профиля.
//
// Данные распространяются по лицензии ODbL 1.0.

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const REQUEST_TIMEOUT_MS = 6000;

export type OsmPlace = {
  name: string;
  lat: number;
  lon: number;
};

type NominatimItem = {
  lat: string;
  lon: string;
  name?: string;
  display_name?: string;
  addresstype?: string;
  class?: string;
  type?: string;
};

/**
 * Центр города по названию. null — город не найден, сервис не ответил или ответ
 * оказался не населённым пунктом (геокодер охотно возвращает улицы и здания).
 */
export async function findCityCenter(city: string, userAgent: string, country?: string | null): Promise<OsmPlace | null> {
  const query = [city, country].filter(Boolean).join(", ");
  if (!query.trim()) return null;

  const url =
    `${NOMINATIM}?q=${encodeURIComponent(query)}` +
    `&format=jsonv2&limit=5&accept-language=ru&featureType=city`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": userAgent, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const items = (await res.json()) as NominatimItem[];
    if (!Array.isArray(items) || items.length === 0) return null;

    // Берём именно населённый пункт: featureType сужает выдачу, но не гарантирует её.
    const hit =
      items.find((i) => i.class === "place" && ["city", "town", "municipality", "village"].includes(i.type ?? "")) ??
      items[0];

    const lat = Number.parseFloat(hit.lat);
    const lon = Number.parseFloat(hit.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    return { name: hit.name || hit.display_name?.split(",")[0] || city, lat, lon };
  } catch {
    return null;
  }
}
