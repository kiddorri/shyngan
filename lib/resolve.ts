// lib/resolve.ts
// Единая точка резолва названия вуза. Три источника по убыванию силы:
//
//   1. Wikidata SPARQL      — есть независимые координаты и проверка «это вуз» по подклассам
//   2. Wikidata Action API  — тот же источник, другая дверь; включается при отказе SPARQL
//   3. Google Places        — вуза нет в Wikidata вообще (так бывает у части казахстанских вузов
//                             и почти всегда у аббревиатур, которых нет в псевдонимах Wikidata)
//
// Третий путь принципиально слабее: координаты и сайт приходят из того же провайдера,
// что и фотографии, поэтому независимого подтверждения у него нет. Профиль сообщает
// об этом предупреждением, а уровни доверия понижаются обычным механизмом якоря.

import { getPlaceDetails, searchText } from "./places";
import type { UniversityCandidate } from "./types";
import { getUniversityByQid, resolveUniversity, WikidataUnavailableError } from "./wikidata";

/** Префикс идентификатора для вузов, найденных только в Places. */
export const PLACES_ID_PREFIX = "places:";

/** Слова, по которым место из Places считается учебным заведением. */
const UNIVERSITY_NAME = /универс|инстит|академи|колледж|консерватор|universit|institut|academy|college/i;

const MAX_PLACES_CANDIDATES = 5;

export function isPlacesId(id: string): boolean {
  return id.startsWith(PLACES_ID_PREFIX);
}

export function placeIdFrom(id: string): string {
  return id.slice(PLACES_ID_PREFIX.length);
}

function placeToCandidate(place: {
  id: string;
  displayName?: { text: string };
  websiteUri?: string;
  formattedAddress?: string;
}): UniversityCandidate {
  return {
    qid: PLACES_ID_PREFIX + place.id,
    resolvedVia: "places",
    label: place.displayName?.text ?? place.id,
    // Координаты намеренно не берём: якорем станет то же место из Places, и механизм
    // якоря сам пометит это как неподтверждённое. Иначе получилось бы ложное
    // «координаты из независимого источника».
    lat: null,
    lon: null,
    officialWebsite: place.websiteUri ?? null,
    country: null,
    city: null,
    image: null,
    instanceOf: null,
  };
}

/** Поиск вуза в Google Places по названию. Используется, когда Wikidata его не знает. */
export async function resolveViaPlaces(search: string): Promise<UniversityCandidate[]> {
  const trimmed = search.trim();
  if (!trimmed) return [];
  try {
    const places = await searchText(trimmed, { pageSize: MAX_PLACES_CANDIDATES });
    return places
      .filter((p) => UNIVERSITY_NAME.test(p.displayName?.text ?? ""))
      .map(placeToCandidate);
  } catch {
    return [];
  }
}

/**
 * Название → кандидаты. Wikidata, затем её же Action API, затем Google Places.
 * Пустой результат означает, что вуза не нашёл ни один источник.
 */
export async function resolveAny(search: string): Promise<UniversityCandidate[]> {
  const fromWikidata = await resolveUniversity(search);
  if (fromWikidata.length > 0) return fromWikidata;
  return resolveViaPlaces(search);
}

/** Карточка по идентификатору: QID из Wikidata либо places:<place_id>. */
export async function getUniversityByAnyId(id: string): Promise<UniversityCandidate | null> {
  if (isPlacesId(id)) {
    const placeId = placeIdFrom(id);
    if (!placeId) return null;
    // Place Details — единственный способ получить место по идентификатору.
    // Ошибку не глушим: пусть маршрут отличит «нет такого места» от «Places не ответил».
    const place = await getPlaceDetails(placeId);
    if (!place) return null;
    // Подстановки «похожего» места здесь быть не может: эндпоинт отвечает
    // ровно на запрошенный идентификатор либо не отвечает вовсе.
    return placeToCandidate(place);
  }
  return getUniversityByQid(id);
}

export { WikidataUnavailableError };
