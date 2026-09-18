// lib/wikidata.ts
// Резолв названия университета через Wikidata SPARQL.
// Ключ не нужен. Нужен только описательный User-Agent (политика Wikimedia).

import type { UniversityCandidate } from "./types";
import { getUniversityByQidViaApi, resolveUniversityViaApi } from "./wikidata-api";

const SPARQL_ENDPOINT = "https://query.wikidata.org/sparql";

// ЗАМЕНИТЬ на реальный URL репозитория или контакт перед первым коммитом.
const USER_AGENT = "shyngan/0.1 (https://github.com/kiddorri/shyngan)";

const REQUEST_TIMEOUT_MS = 8000;
/** SPARQL-сервис отдаёт 429 при нескольких запросах подряд — жюри вводит вузы именно так. */
const SPARQL_RETRY_DELAY_MS = 1200;

/** Казахские буквы, которых нет в русском алфавите. */
const KAZAKH_LETTERS = /[әғқңөұүһі]/i;
const CYRILLIC = /[а-яёА-ЯЁ]/;

/**
 * Порядок языков для поиска в EntitySearch зависит от алфавита запроса.
 *
 * EntitySearch ищет по меткам и алиасам ИМЕННО заданного языка, а не по всем сразу.
 * Раньше порядок был всегда ["ru","en","kk"]: запрос «Harvard» сначала уходил с
 * language=ru, и если у карточки в Wikidata нет русского алиаса «Harvard» (для
 * большинства зарубежных вузов его и нет), первая попытка возвращала пусто —
 * заведомо впустую потраченный запрос перед тем, что мог сработать. Раз запрос
 * набран латиницей, разумнее спрашивать en первым, а кириллицу и казахские буквы —
 * ru/kk первым. Ни один язык не выпадает: остальные два всё равно проверяются,
 * это только порядок, а не фильтр.
 */
function languageOrder(search: string): readonly ("ru" | "en" | "kk")[] {
  if (KAZAKH_LETTERS.test(search)) return ["kk", "ru", "en"];
  if (CYRILLIC.test(search)) return ["ru", "kk", "en"];
  return ["en", "ru", "kk"];
}

/** Сервис не ответил (429, 5xx, таймаут). Отличается от «вуз не найден». */
export class WikidataUnavailableError extends Error {}

// Q38723 = "higher education institution" — родительский класс для
// university / institute / academy. Фильтр wdt:P31/wdt:P279* означает:
// "тип элемента или любой его надкласс равен Q38723".
const HIGHER_EDU_CLASS = "wd:Q38723";
// Q3918 = "university" — более узкая ветка. У вуза бывает несколько значений P31,
// и порядок строк в ответе SPARQL не определён, поэтому спрашиваем обе ветки
// и предпочитаем узкую: иначе «Назарбаев Университет — местонахождение».
const UNIVERSITY_CLASS = "wd:Q3918";

// Общий набор полей. ?item должен быть связан до вставки этого фрагмента.
const FIELDS_FRAGMENT = `
  ?item wdt:P31/wdt:P279* ${HIGHER_EDU_CLASS}.
  OPTIONAL { ?item wdt:P625 ?coord. }
  OPTIONAL { ?item wdt:P856 ?website. }
  # Страна и город берутся только из действующих утверждений: у старых вузов
  # в Wikidata остаётся «СССР» с датой окончания, и без этого фильтра профиль
  # сообщал, что академия находится в Советском Союзе.
  OPTIONAL {
    ?item p:P17 ?countryStmt.
    ?countryStmt ps:P17 ?country.
    FILTER NOT EXISTS { ?countryStmt pq:P582 ?countryEnd. }
    FILTER NOT EXISTS { ?countryStmt wikibase:rank wikibase:DeprecatedRank. }
  }
  OPTIONAL {
    ?item p:P131 ?cityStmt.
    ?cityStmt ps:P131 ?city.
    FILTER NOT EXISTS { ?cityStmt pq:P582 ?cityEnd. }
    FILTER NOT EXISTS { ?cityStmt wikibase:rank wikibase:DeprecatedRank. }
  }
  OPTIONAL { ?item wdt:P18 ?image. }
  # Число языковых разделов — мера известности. Нужна для порядка выдачи: по запросу
  # «Harward» строковое совпадение выигрывает безвестный колледж, а человек имел в
  # виду Гарвард. Это не фильтр — отбрасывать по известности нельзя, малый
  # региональный вуз тоже должен находиться, — а только порядок кандидатов.
  OPTIONAL { ?item wikibase:sitelinks ?sitelinks. }
  OPTIONAL { ?item wdt:P31 ?instanceUni. ?instanceUni wdt:P279* ${UNIVERSITY_CLASS}. }
  OPTIONAL { ?item wdt:P31 ?instance. ?instance wdt:P279* ${HIGHER_EDU_CLASS}. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ru,kk,en". }
`;

const SELECT_HEAD =
  "SELECT ?item ?itemLabel ?coord ?website ?countryLabel ?cityLabel ?image ?instanceLabel ?instanceUniLabel ?sitelinks WHERE {";

function escapeLiteral(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildSearchQuery(search: string, lang: "ru" | "kk" | "en"): string {
  return `
${SELECT_HEAD}
  SERVICE wikibase:mwapi {
    bd:serviceParam wikibase:api "EntitySearch".
    bd:serviceParam wikibase:endpoint "www.wikidata.org".
    bd:serviceParam mwapi:search "${escapeLiteral(search)}".
    bd:serviceParam mwapi:language "${lang}".
    ?item wikibase:apiOutputItem mwapi:item.
  }
${FIELDS_FRAGMENT}
}
LIMIT 10
`.trim();
}

function buildByQidQuery(qid: string): string {
  return `
${SELECT_HEAD}
  VALUES ?item { wd:${qid} }
${FIELDS_FRAGMENT}
}
LIMIT 10
`.trim();
}

// P625 приходит как WKT: "Point(76.928 43.238)" — порядок ДОЛГОТА ШИРОТА.
function parsePoint(wkt: string | undefined): { lat: number | null; lon: number | null } {
  if (!wkt) return { lat: null, lon: null };
  const m = wkt.match(/Point\(([-\d.]+)\s+([-\d.]+)\)/);
  if (!m) return { lat: null, lon: null };
  return { lon: parseFloat(m[1]), lat: parseFloat(m[2]) };
}

type Binding = Record<string, { value: string } | undefined>;

async function runSparql(query: string): Promise<UniversityCandidate[]> {
  const url = `${SPARQL_ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;

  let res: Response | null = null;
  // Одна повторная попытка: троттлинг и пятисотки у SPARQL-сервиса обычно кратковременны.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(url, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt === 1) throw new WikidataUnavailableError(`SPARQL недоступен: ${(e as Error).name}`);
      await new Promise((r) => setTimeout(r, SPARQL_RETRY_DELAY_MS));
      continue;
    }
    if (res.ok) break;
    if (attempt === 1 || (res.status !== 429 && res.status < 500)) {
      throw new WikidataUnavailableError(`SPARQL HTTP ${res.status}`);
    }
    await new Promise((r) => setTimeout(r, SPARQL_RETRY_DELAY_MS));
  }
  if (!res || !res.ok) throw new WikidataUnavailableError("SPARQL не ответил");

  const json = (await res.json()) as { results?: { bindings?: Binding[] } };
  const bindings = json.results?.bindings ?? [];

  // Один ?item может прийти несколькими строками (разные OPTIONAL-комбинации).
  // Схлопываем по QID, сохраняя первое непустое значение каждого поля.
  const byQid = new Map<string, UniversityCandidate>();
  const sitelinksByQid = new Map<string, number>();

  for (const b of bindings) {
    const qid = b.item?.value.split("/").pop();
    if (!qid) continue;

    const prev = byQid.get(qid);
    const { lat, lon } = parsePoint(b.coord?.value);
    const sitelinks = Number.parseInt(b.sitelinks?.value ?? "", 10);
    if (Number.isFinite(sitelinks)) {
      sitelinksByQid.set(qid, Math.max(sitelinksByQid.get(qid) ?? 0, sitelinks));
    }

    byQid.set(qid, {
      qid,
      resolvedVia: "sparql",
      label: b.itemLabel?.value ?? prev?.label ?? qid,
      lat: lat ?? prev?.lat ?? null,
      lon: lon ?? prev?.lon ?? null,
      officialWebsite: b.website?.value ?? prev?.officialWebsite ?? null,
      country: b.countryLabel?.value ?? prev?.country ?? null,
      city: b.cityLabel?.value ?? prev?.city ?? null,
      image: b.image?.value ?? prev?.image ?? null,
      // Первое непустое значение, узкая ветка приоритетнее широкой.
      instanceOf: prev?.instanceOf ?? b.instanceUniLabel?.value ?? b.instanceLabel?.value ?? null,
    });
  }

  // Порядок: известные вузы выше малоизвестных. У Wikidata нет ранжирования выдачи,
  // поэтому без этой сортировки первым оказывается тот, чьё название совпало по
  // буквам, а не тот, кого искали.
  return Array.from(byQid.values()).sort(
    (a, b) => (sitelinksByQid.get(b.qid) ?? 0) - (sitelinksByQid.get(a.qid) ?? 0),
  );
}

/**
 * Название → список кандидатов. Пробует ru → en → kk, пока не найдёт хоть что-то.
 * Возвращает МАССИВ намеренно: больше одного кандидата = неоднозначный запрос,
 * выбор делает UI, а не резолвер.
 */
export async function resolveUniversity(search: string): Promise<UniversityCandidate[]> {
  const trimmed = search.trim();
  if (!trimmed) return [];

  const langs = languageOrder(trimmed);
  let sparqlFailed = false;
  for (const lang of langs) {
    try {
      const candidates = await runSparql(buildSearchQuery(trimmed, lang));
      if (candidates.length > 0) return candidates;
    } catch (e) {
      sparqlFailed = true;
      console.error(`resolveUniversity: SPARQL lang=${lang} failed`, e);
      // Раньше здесь стоял break: сбой ОДНОГО языка (429, таймаут) обрывал перебор
      // остальных и сразу уводил на Action API для всех трёх языков сразу. Один
      // подвисший запрос на "ru" не должен мешать заведомо рабочей попытке на "en" —
      // поэтому теперь просто идём дальше по списку.
    }
  }

  // Все языки опрошены SPARQL-ом. Ни один не упал — вуза действительно нет.
  if (!sparqlFailed) return [];

  // Хотя бы один язык не ответил: пробуем Action API, в том же порядке языков.
  try {
    return await resolveUniversityViaApi(trimmed, USER_AGENT, langs);
  } catch (e) {
    throw new WikidataUnavailableError(
      `Wikidata не отвечает: SPARQL и Action API недоступны (${(e as Error).message})`,
    );
  }
}

/** QID → одна карточка (для /api/profile после выбора кандидата в UI). */
export async function getUniversityByQid(qid: string): Promise<UniversityCandidate | null> {
  if (!/^Q\d+$/.test(qid)) return null;
  try {
    const rows = await runSparql(buildByQidQuery(qid));
    if (rows[0]) return rows[0];
  } catch (e) {
    console.error("getUniversityByQid: SPARQL failed, trying Action API", e);
    return getUniversityByQidViaApi(qid, USER_AGENT);
  }
  return null;
}
