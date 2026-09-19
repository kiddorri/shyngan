// lib/places.ts
// Тонкий клиент Google Places API (New). Только три вызова:
//   1) searchText       — POST https://places.googleapis.com/v1/places:searchText
//   2) getPlaceDetails  — GET  https://places.googleapis.com/v1/places/{place_id}
//   3) getPhotoUri      — GET  https://places.googleapis.com/v1/{photo.name}/media?skipHttpRedirect=true
// Ничего другого из Places не используется.

import type { PlaceReview } from "./types";

const PLACES_BASE = "https://places.googleapis.com/v1";
const REQUEST_TIMEOUT_MS = 8000;

/** Поля, которые нам нужны от места. Общий список для поиска и для карточки места. */
const PLACE_FIELDS = [
  "id",
  "displayName",
  "formattedAddress",
  // Структурный адрес: из него берётся город. Сравнивать города по строке адреса
  // нельзя — «Алматы» в адресе и «Алма-Ата» в справочнике это один город.
  "addressComponents",
  "location",
  "photos",
  "googleMapsUri",
  "websiteUri",
];

// Field mask обязателен: без него API возвращает ошибку.
// В ответе searchText места лежат в массиве places, поэтому здесь поля с префиксом.
const TEXT_SEARCH_FIELD_MASK = [...PLACE_FIELDS.map((f) => `places.${f}`), "nextPageToken"].join(",");
// Place Details отдаёт объект Place на верхнем уровне — здесь поля без префикса.
const PLACE_DETAILS_FIELD_MASK = PLACE_FIELDS.join(",");

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
  googleMapsUri?: string;
  authorAttributions?: Array<{
    displayName: string;
    uri?: string;
    photoUri?: string;
  }>;
};

export type AddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
};

export type Place = {
  id: string;
  displayName?: { text: string; languageCode?: string };
  formattedAddress?: string;
  addressComponents?: AddressComponent[];
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
  opts: { bias?: LocationBias; pageSize?: number; languageCode?: string; signal?: AbortSignal } = {},
): Promise<Place[]> {
  return (await searchTextPage(textQuery, opts)).places;
}

export async function searchTextPage(
  textQuery: string,
  opts: { bias?: LocationBias; pageSize?: number; languageCode?: string; pageToken?: string; signal?: AbortSignal } = {},
): Promise<{ places: Place[]; nextPageToken: string | null }> {
  const body: Record<string, unknown> = {
    textQuery,
    languageCode: opts.languageCode ?? "ru",
    pageSize: Math.min(Math.max(opts.pageSize ?? 3, 1), 20),
  };

  if (opts.pageToken) body.pageToken = opts.pageToken;

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
    signal: opts.signal
      ? AbortSignal.any([opts.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
      : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Places searchText HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as { places?: Place[]; nextPageToken?: string };
  return { places: json.places ?? [], nextPageToken: json.nextPageToken ?? null };
}

/** Reads subsequent Text Search pages without changing the query parameters. */
export async function searchTextPages(
  textQuery: string,
  opts: { bias?: LocationBias; pageSize?: number; languageCode?: string; maxPages?: number; signal?: AbortSignal } = {},
): Promise<Place[]> {
  const out: Place[] = [];
  let pageToken: string | undefined;
  const pages = Math.max(1, opts.maxPages ?? 1);
  for (let page = 0; page < pages && !opts.signal?.aborted; page++) {
    const result = await searchTextPage(textQuery, { ...opts, pageToken });
    out.push(...result.places);
    if (!result.nextPageToken) break;
    pageToken = result.nextPageToken;
  }
  return out;
}

/**
 * Место по его place_id — штатный эндпоинт Place Details (New).
 * Текстовый поиск по place_id не работает: он возвращает пустой список.
 *
 * null — места с таким идентификатором не существует. Places говорит это двумя
 * способами: 404 NOT_FOUND для идентификатора, которого уже нет, и 400
 * INVALID_ARGUMENT для строки, которая идентификатором быть не может. Для нас
 * это один ответ: такого вуза нет.
 *
 * Любая другая ошибка пробрасывается: «не нашли» и «не смогли спросить» —
 * разные ответы, и путать их нельзя.
 */
export async function getPlaceDetails(placeId: string): Promise<Place | null> {
  const url = `${PLACES_BASE}/places/${encodeURIComponent(placeId)}?languageCode=ru`;

  const res = await fetch(url, {
    headers: {
      "X-Goog-Api-Key": apiKey(),
      "X-Goog-FieldMask": PLACE_DETAILS_FIELD_MASK,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let status: string | undefined;
    try {
      status = (JSON.parse(text) as { error?: { status?: string } }).error?.status;
    } catch {
      /* тело не JSON — считаем это сбоем, а не ответом «нет такого места» */
    }
    if (res.status === 404 || status === "NOT_FOUND" || status === "INVALID_ARGUMENT") return null;
    throw new Error(`Places details HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  // Ответ — сам объект Place, без обёртки.
  return (await res.json()) as Place;
}

/**
 * Отзывы о месте. Отдельный вызов с минимальной маской полей: поле reviews в Places
 * тарифицируется по более дорогому SKU, чем остальная карточка, поэтому оно
 * запрашивается один раз для кампуса, а не для каждого места.
 *
 * Пустой массив — отзывов нет либо запрос не удался: отзывы украшают профиль, но
 * ронять из-за них сборку нельзя.
 */
export async function getPlaceReviews(placeId: string, limit = 5): Promise<PlaceReview[]> {
  const url = `${PLACES_BASE}/places/${encodeURIComponent(placeId)}?languageCode=ru`;
  try {
    const res = await fetch(url, {
      headers: {
        "X-Goog-Api-Key": apiKey(),
        "X-Goog-FieldMask": "reviews",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      reviews?: Array<{
        authorAttribution?: { displayName?: string; uri?: string; photoUri?: string };
        rating?: number;
        text?: { text?: string; languageCode?: string };
        originalText?: { text?: string; languageCode?: string };
        publishTime?: string;
        googleMapsUri?: string;
        visitDate?: { year?: number; month?: number };
      }>;
    };
    return (json.reviews ?? [])
      // Свежие первыми: Places отдаёт «самые релевантные», а абитуриенту важнее
      // недавние. Сортировать по дате разрешено — она приходит вместе с отзывом.
      .slice()
      .sort((a, b) => Date.parse(b.publishTime ?? "") - Date.parse(a.publishTime ?? ""))
      .slice(0, limit)
      .map((r) => ({
        author: r.authorAttribution?.displayName ?? "аноним",
        authorUri: r.authorAttribution?.uri ?? null,
        authorPhotoUri: r.authorAttribution?.photoUri ?? null,
        sourceUrl: r.googleMapsUri ?? null,
        visitDate: r.visitDate?.year && r.visitDate?.month
          ? `${String(r.visitDate.month).padStart(2, "0")}.${r.visitDate.year}` : null,
        rating: typeof r.rating === "number" ? r.rating : null,
        text: (r.text?.text ?? r.originalText?.text ?? "").trim(),
        publishedAt: r.publishTime ?? null,
        languageCode: r.text?.languageCode ?? r.originalText?.languageCode ?? null,
      }))
      .filter((r) => r.text.length > 0);
  } catch {
    return [];
  }
}

/**
 * Возвращает короткоживущий URL картинки (lh3.googleusercontent.com).
 * skipHttpRedirect=true даёт JSON { name, photoUri } вместо редиректа,
 * поэтому ключ API на клиент не утекает.
 */
export async function getPhotoUri(
  photoName: string,
  maxWidthPx = 800,
  signal?: AbortSignal,
): Promise<string | null> {
  const url =
    `${PLACES_BASE}/${photoName}/media` +
    `?maxWidthPx=${maxWidthPx}&skipHttpRedirect=true&key=${encodeURIComponent(apiKey())}`;

  try {
    const res = await fetch(url, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
        : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { photoUri?: string };
    return json.photoUri ?? null;
  } catch {
    return null;
  }
}
