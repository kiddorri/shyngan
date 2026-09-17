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

/** Сервис не ответил (429, 5xx, таймаут). Отличается от «вуз не найден». */
export class WikidataUnavailableError extends Error {}

// Q38723 = "higher education institution" — родительский класс для
// university / institute / academy. Фильтр wdt:P31/wdt:P279* означает:
// "тип элемента или любой его надкласс равен Q38723".
const HIGHER_EDU_CLASS = "wd:Q38723";

// Общий набор полей. ?item должен быть связан до вставки этого фрагмента.
const FIELDS_FRAGMENT = `
  ?item wdt:P31/wdt:P279* ${HIGHER_EDU_CLASS}.
  OPTIONAL { ?item wdt:P625 ?coord. }
  OPTIONAL { ?item wdt:P856 ?website. }
  OPTIONAL { ?item wdt:P17 ?country. }
  OPTIONAL { ?item wdt:P131 ?city. }
  OPTIONAL { ?item wdt:P18 ?image. }
  OPTIONAL { ?item wdt:P31 ?instance. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "ru,kk,en". }
`;

const SELECT_HEAD =
  "SELECT ?item ?itemLabel ?coord ?website ?countryLabel ?cityLabel ?image ?instanceLabel WHERE {";

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

  for (const b of bindings) {
    const qid = b.item?.value.split("/").pop();
    if (!qid) continue;

    const prev = byQid.get(qid);
    const { lat, lon } = parsePoint(b.coord?.value);

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
      instanceOf: b.instanceLabel?.value ?? prev?.instanceOf ?? null,
    });
  }

  return Array.from(byQid.values());
}

/**
 * Название → список кандидатов. Пробует ru → en → kk, пока не найдёт хоть что-то.
 * Возвращает МАССИВ намеренно: больше одного кандидата = неоднозначный запрос,
 * выбор делает UI, а не резолвер.
 */
export async function resolveUniversity(search: string): Promise<UniversityCandidate[]> {
  const trimmed = search.trim();
  if (!trimmed) return [];

  let sparqlFailed = false;
  for (const lang of ["ru", "en", "kk"] as const) {
    try {
      const candidates = await runSparql(buildSearchQuery(trimmed, lang));
      if (candidates.length > 0) return candidates;
    } catch (e) {
      sparqlFailed = true;
      console.error(`resolveUniversity: SPARQL lang=${lang} failed`, e);
      break; // сервис лежит — перебирать языки бессмысленно, сразу к запасному пути
    }
  }

  // SPARQL вернул пустой результат по всем языкам — вуза действительно нет.
  if (!sparqlFailed) return [];

  // Сервис не ответил: пробуем Action API — те же данные, другие лимиты.
  try {
    return await resolveUniversityViaApi(trimmed, USER_AGENT);
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
