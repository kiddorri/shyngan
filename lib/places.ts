// lib/places.ts
// Тонкий клиент Google Places API (New). Только два вызова:
//   1) searchText  — POST https://places.googleapis.com/v1/places:searchText
//   2) getPhotoUri — GET  https://places.googleapis.com/v1/{photo.name}/media?skipHttpRedirect=true
// Ничего другого из Places не используется.

const PLACES_BASE = "https://places.googleapis.com/v1";
const REQUEST_TIMEOUT_MS = 8000;

// Field mask обязателен: без него API возвращает ошибку.
// Перечисленные поля — единственные, которые нужны блоку A.
const TEXT_SEARCH_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.location",
  "places.photos",
  "places.googleMapsUri",
  "places.websiteUri",
].join(",");

function apiKey(): string {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY is not set");
  return key;
}

export type PlacePhoto = {
  /** Формат: "places/{place_id}/photos/{photo_reference}". Истекает — не кешировать. */
  name: string;
  widthPx: number;
  heightPx: number;
  authorAttributions?: Array<{
    displayName: string;
    uri?: string;
    photoUri?: string;
  }>;
};

export type Place = {
  id: string;
  displayName?: { text: string; languageCode?: string };
  location?: { latitude: number; longitude: number };
  photos?: PlacePhoto[];
  googleMapsUri?: string;
  websiteUri?: string;
};

export type LocationBias = {
  lat: number;
  lon: number;
  /** 0..50000 метров (ограничение API). */
  radiusM: number;
};

export async function searchText(
  textQuery: string,
  opts: { bias?: LocationBias; pageSize?: number } = {},
): Promise<Place[]> {
  const body: Record<string, unknown> = {
    textQuery,
    languageCode: "ru",
    pageSize: Math.min(Math.max(opts.pageSize ?? 3, 1), 20),
  };

  if (opts.bias) {
    body.locationBias = {
      circle: {
        center: { latitude: opts.bias.lat, longitude: opts.bias.lon },
        radius: Math.min(Math.max(opts.bias.radiusM, 0), 50000),
      },
    };
  }

  const res = await fetch(`${PLACES_BASE}/places:searchText`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey(),
      "X-Goog-FieldMask": TEXT_SEARCH_FIELD_MASK,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Places searchText HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as { places?: Place[] };
  return json.places ?? [];
}

/**
 * Возвращает короткоживущий URL картинки (lh3.googleusercontent.com).
 * skipHttpRedirect=true даёт JSON { name, photoUri } вместо редиректа,
 * поэтому ключ API на клиент не утекает.
 */
export async function getPhotoUri(
  photoName: string,
  maxWidthPx = 800,
): Promise<string | null> {
  const url =
    `${PLACES_BASE}/${photoName}/media` +
    `?maxWidthPx=${maxWidthPx}&skipHttpRedirect=true&key=${encodeURIComponent(apiKey())}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) return null;
    const json = (await res.json()) as { photoUri?: string };
    return json.photoUri ?? null;
  } catch {
    return null;
  }
}
