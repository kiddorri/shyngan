// lib/resolve.ts
// Единая точка резолва названия вуза. Три источника по убыванию силы:
//
//   1. Wikidata SPARQL      — есть независимые координаты и проверка «это вуз» по подклассам
//   2. Wikidata Action API  — тот же источник, другая дверь; включается при отказе SPARQL
//   3. Google Places        — дополнительный поиск при слабом ответе, аббревиатуре
//                             или недоступности Wikidata
//
// Третий путь принципиально слабее: координаты и сайт приходят из того же провайдера,
// что и фотографии, поэтому независимого подтверждения у него нет. Профиль сообщает
// об этом предупреждением, а уровни доверия понижаются обычным механизмом якоря.

import { getPlaceDetails, searchText, type Place } from "./places";
import type { UniversityCandidate } from "./types";
import { getUniversityByQid, resolveUniversity, WikidataUnavailableError } from "./wikidata";

/** Префикс идентификатора для вузов, найденных только в Places. */
export const PLACES_ID_PREFIX = "places:";

/** Слова, по которым место из Places считается учебным заведением. */
const UNIVERSITY_NAME = /универс|инстит|академи|колледж|консерватор|universit|institut|academy|college|大学|大學|学院|學院|대학교|대학|과학기술원/iu;

const MAX_PLACES_CANDIDATES = 5;

function words(value: string): string[] {
  return value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Слабая транслитерация нужна только для сопоставления аббревиатуры с доменом:
 *  «КазНУИ» → kaznui.edu.kz. Это не перевод названий и не источник карточки. */
function latinSkeleton(value: string): string {
  const map: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", ғ: "g", д: "d", е: "e", ё: "e", ж: "zh",
    з: "z", и: "i", й: "i", к: "k", қ: "q", л: "l", м: "m", н: "n", ң: "n",
    о: "o", ө: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ұ: "u", ү: "u",
    ф: "f", х: "h", һ: "h", ц: "c", ч: "ch", ш: "sh", щ: "sh", ы: "y", і: "i",
    э: "e", ю: "yu", я: "ya", ъ: "", ь: "",
  };
  return [...value.toLocaleLowerCase()].map((char) => map[char] ?? char).join("");
}

function closeWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4 || Math.abs(a.length - b.length) > 1) return false;
  // Одна замена, вставка или удаление: помогает с опечаткой, но не принимает
  // произвольный вуз из ответа полнотекстового поиска Places.
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + Number(i < a.length || j < b.length) <= 1;
}

function nameMatchesQuery(query: string, label: string): boolean {
  const q = words(query).filter((w) => !/^(university|universitet|college|университет|колледж)$/.test(w));
  const name = words(label);
  if (q.length === 0 || name.length === 0) return false;
  if (q.length === 1 && q[0].length <= 5 && /^[a-z]+$/.test(q[0])) {
    const initials = name.filter((w) => !/^(of|the|and)$/.test(w)).map((w) => w[0]).join("");
    if (initials === q[0]) return true;
  }
  return q.filter((token) => name.some((part) =>
    closeWord(token, part) || closeWord(latinSkeleton(token), latinSkeleton(part)),
  )).length >= Math.ceil(q.length / 2);
}

/** Places иногда хранит пользовательское название вуза в адресе, а аббревиатуру —
 *  только в домене: «Шабыт» и «КазНУИ» для формального названия университета. */
export function placeMatchesQuery(
  query: string,
  place: Pick<Place, "displayName" | "formattedAddress" | "websiteUri">,
): boolean {
  const searchable = [place.displayName?.text, place.formattedAddress, place.websiteUri]
    .filter(Boolean)
    .join(" ");
  return nameMatchesQuery(query, searchable);
}

function isLikelyAcronym(value: string): boolean {
  const letters = [...value.normalize("NFKC")].filter((char) => /\p{L}/u.test(char));
  if (letters.length < 2 || letters.length > 10) return false;
  const uppercase = letters.filter((char) =>
    char === char.toLocaleUpperCase() && char !== char.toLocaleLowerCase(),
  ).length;
  return uppercase >= 2 && uppercase / letters.length >= 0.5;
}

function sameNormalizedName(a: string, b: string): boolean {
  return words(a).join(" ") === words(b).join(" ");
}

function sameWebsite(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  try {
    const first = new URL(a).hostname.replace(/^www\./, "").toLowerCase();
    const second = new URL(b).hostname.replace(/^www\./, "").toLowerCase();
    return first === second || first.endsWith(`.${second}`) || second.endsWith(`.${first}`);
  } catch {
    return false;
  }
}

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

/** Поиск вуза в Google Places по названию при слабом ответе или сбое Wikidata. */
export async function resolveViaPlaces(search: string): Promise<UniversityCandidate[]> {
  const trimmed = search.trim();
  if (!trimmed) return [];
  try {
    const options = {
      pageSize: MAX_PLACES_CANDIDATES,
      languageCode: /[\uAC00-\uD7AF]/u.test(trimmed) ? "ko"
        : /[\u3400-\u9FFF]/u.test(trimmed) ? "zh-CN"
        : /^[\x00-\x7F]+$/.test(trimmed) ? "en" : "ru",
    };
    const places = await searchText(trimmed, options);
    return places
      .filter((p) => UNIVERSITY_NAME.test(p.displayName?.text ?? "") &&
        placeMatchesQuery(trimmed, p))
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
  const acronym = isLikelyAcronym(search.trim());
  // Для коротких аббревиатур Wikidata часто знает другое учреждение с тем же
  // псевдонимом. Второй источник нужен всегда, поэтому не ждём первый впустую.
  const placesPromise = acronym ? resolveViaPlaces(search) : null;
  let fromWikidata: UniversityCandidate[] = [];
  let wikidataError: WikidataUnavailableError | null = null;
  try {
    fromWikidata = await resolveUniversity(search);
  } catch (e) {
    if (!(e instanceof WikidataUnavailableError)) throw e;
    wikidataError = e;
  }
  // EntitySearch может найти точное совпадение с опечаткой в названии малоизвестного
  // учреждения. Если у всех результатов нет ни сайта, ни координат, проверяем
  // запрос ещё и по Places. Иначе один такой результат автоматически откроется
  // как профиль, хотя пользователь мог иметь в виду другой университет.
  if (!acronym && fromWikidata.some((c) => c.officialWebsite || (c.lat !== null && c.lon !== null))) {
    return fromWikidata;
  }
  const fromPlaces = await (placesPromise ?? resolveViaPlaces(search));
  if (wikidataError && fromPlaces.length === 0) throw wikidataError;
  // Places умеет исправлять опечатки, но его карточка сама по себе не даёт
  // независимого подтверждения координат. Повторно ищем первое подходящее имя
  // в Wikidata и связываем карточки только при совпадении официального домена.
  const suggested = fromPlaces.find((c) => c.officialWebsite);
  const verifiedExisting = suggested && fromWikidata.find((c) => sameWebsite(c.officialWebsite, suggested.officialWebsite));
  if (verifiedExisting) {
    return [verifiedExisting, ...fromWikidata.filter((c) => c.qid !== verifiedExisting.qid),
      ...fromPlaces.filter((c) => !sameWebsite(c.officialWebsite, verifiedExisting.officialWebsite))];
  }
  if (!wikidataError && suggested && suggested.label.toLocaleLowerCase() !== search.trim().toLocaleLowerCase()) {
    try {
      const verified = await resolveUniversity(suggested.label);
      const match = verified.find((c) =>
        sameWebsite(c.officialWebsite, suggested.officialWebsite) || sameNormalizedName(c.label, suggested.label),
      );
      if (match) {
        return [match, ...fromWikidata.filter((c) => c.qid !== match.qid)];
      }
    } catch {
      // Places всё равно остаётся доступным вариантом для ручного выбора.
    }
  }
  const seen = new Set(fromWikidata.map((c) => c.officialWebsite?.replace(/\/$/, "").toLowerCase()).filter(Boolean));
  const additional = fromPlaces.filter((c) => {
    const site = c.officialWebsite?.replace(/\/$/, "").toLowerCase();
    return !site || !seen.has(site);
  });
  // Адрес сайта здесь полезнее буквального совпадения: это хотя бы проверяемая
  // точка входа для сбора снимков. Выбор в любом случае остаётся за человеком.
  return [...additional.filter((c) => c.officialWebsite), ...fromWikidata,
    ...additional.filter((c) => !c.officialWebsite)];
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
