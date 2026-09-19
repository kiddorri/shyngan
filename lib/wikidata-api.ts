// lib/wikidata-api.ts
// Запасной резолв через Wikidata Action API (www.wikidata.org/w/api.php).
//
// Зачем: SPARQL-сервис query.wikidata.org отдаёт 429 при нескольких запросах подряд —
// ровно тот ритм, которым жюри вводит вузы. Action API — другая дверь к тем же данным,
// с несопоставимо мягкими лимитами. Источник тот же, вопросов к доверию не добавляется.
//
// Отличие от SPARQL-пути: здесь нет обхода подклассов (P279*), поэтому «это вуз»
// определяется по прямому P31 из известного набора ИЛИ по описанию сущности.
// Это осознанно более мягкий фильтр. Карточки помечаются resolvedVia: "action-api",
// и профиль по этой пометке добавляет предупреждение для пользователя.

import type { UniversityCandidate } from "./types";

const API = "https://www.wikidata.org/w/api.php";
const REQUEST_TIMEOUT_MS = 8000;

/** Прямые значения P31, которые точно означают вуз. Обход подклассов здесь недоступен. */
const HIGHER_ED_QIDS = new Set(["Q3918", "Q38723"]);
/** Запасной признак: описание сущности говорит о высшем учебном заведении. */
const HIGHER_ED_TEXT = /универс|инстит|академи|college|universit|polytechnic|высш/i;

const P_COORD = "P625";
const P_WEBSITE = "P856";
const P_COUNTRY = "P17";
const P_ADMIN = "P131";
const P_INSTANCE = "P31";

type SearchHit = { id?: string; label?: string; description?: string };
type Snak = {
  rank?: "preferred" | "normal" | "deprecated";
  qualifiers?: Record<string, unknown>;
  mainsnak?: { datavalue?: { value?: unknown; type?: string } };
};
type Entity = {
  id?: string;
  labels?: Record<string, { value?: string }>;
  descriptions?: Record<string, { value?: string }>;
  claims?: Record<string, Snak[]>;
};

async function callApi(params: Record<string, string>, userAgent: string): Promise<unknown> {
  const url = `${API}?${new URLSearchParams({ ...params, format: "json", origin: "*" }).toString()}`;
  const res = await fetch(url, {
    headers: { "User-Agent": userAgent, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Wikidata Action API HTTP ${res.status}`);
  return res.json();
}

function firstClaim(entity: Entity, pid: string): unknown {
  const statements = (entity.claims?.[pid] ?? []).filter((statement) =>
    statement.rank !== "deprecated" &&
    ((pid !== P_COUNTRY && pid !== P_ADMIN) || !statement.qualifiers?.P582));
  return (statements.find((statement) => statement.rank === "preferred") ?? statements[0])
    ?.mainsnak?.datavalue?.value;
}

/** P625 приходит как { latitude, longitude, globe }. */
function readCoord(v: unknown): { lat: number | null; lon: number | null } {
  if (v && typeof v === "object") {
    const o = v as { latitude?: unknown; longitude?: unknown };
    if (typeof o.latitude === "number" && typeof o.longitude === "number") {
      return { lat: o.latitude, lon: o.longitude };
    }
  }
  return { lat: null, lon: null };
}

/** P856 приходит строкой. */
function readString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** P17/P131/P31 приходят как { "entity-type": "item", id: "Q123" }. */
function readEntityId(v: unknown): string | null {
  if (v && typeof v === "object") {
    const o = v as { id?: unknown };
    if (typeof o.id === "string" && /^Q\d+$/.test(o.id)) return o.id;
  }
  return null;
}

function pickLabel(entity: Entity, fallback: string): string {
  for (const lang of ["ru", "kk", "en"]) {
    const v = entity.labels?.[lang]?.value;
    if (v) return v;
  }
  const any = entity.labels ? Object.values(entity.labels)[0]?.value : undefined;
  return any ?? fallback;
}

function pickDescription(entity: Entity): string {
  for (const lang of ["ru", "kk", "en"]) {
    const v = entity.descriptions?.[lang]?.value;
    if (v) return v;
  }
  return "";
}

async function fetchEntities(qids: string[], userAgent: string): Promise<Record<string, Entity>> {
  if (qids.length === 0) return {};
  const json = (await callApi(
    {
      action: "wbgetentities",
      ids: qids.slice(0, 20).join("|"),
      props: "labels|descriptions|claims",
      languages: "ru|kk|en",
    },
    userAgent,
  )) as { entities?: Record<string, Entity> };
  return json.entities ?? {};
}

/** Разрешает QID-ссылки (страна, город, тип) в подписи одним дополнительным запросом. */
async function fetchLabels(qids: string[], userAgent: string): Promise<Map<string, string>> {
  const unique = Array.from(new Set(qids.filter(Boolean)));
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  try {
    const json = (await callApi(
      { action: "wbgetentities", ids: unique.slice(0, 50).join("|"), props: "labels", languages: "ru|kk|en" },
      userAgent,
    )) as { entities?: Record<string, Entity> };
    for (const [qid, entity] of Object.entries(json.entities ?? {})) {
      out.set(qid, pickLabel(entity, qid));
    }
  } catch {
    /* подписи необязательны: без них карточка просто беднее */
  }
  return out;
}

function looksLikeUniversity(entity: Entity): boolean {
  const instances = (entity.claims?.[P_INSTANCE] ?? [])
    .map((s) => readEntityId(s.mainsnak?.datavalue?.value))
    .filter((x): x is string => x !== null);
  if (instances.some((q) => HIGHER_ED_QIDS.has(q))) return true;
  return HIGHER_ED_TEXT.test(pickDescription(entity));
}

/**
 * Поиск вуза по названию через Action API. Пробует языки в переданном порядке
 * (по умолчанию ru → en → kk — тот же порядок, что раньше был единственным).
 * Возвращает кандидатов в том же формате, что и SPARQL-путь.
 *
 * Сбой одного языка (сеть, троттлинг) не должен обрывать перебор остальных: если
 * ru упал, а en ответил — результат en всё равно нужен. «Не нашли» и «сервис не
 * ответил» — разные исходы, поэтому исключение прокидывается наверх только тогда,
 * когда упали ВСЕ языки; если хотя бы один ответил (пусть и пустым списком), это
 * означает «вуза нет», а не «Wikidata недоступна».
 */
export async function resolveUniversityViaApi(
  search: string,
  userAgent: string,
  langs: readonly ("ru" | "en" | "kk" | "zh" | "ko")[] = ["ru", "en", "kk"],
): Promise<UniversityCandidate[]> {
  const trimmed = search.trim();
  if (!trimmed) return [];

  let hits: SearchHit[] = [];
  let lastError: unknown = null;
  for (const lang of langs) {
    try {
      const json = (await callApi(
        { action: "wbsearchentities", search: trimmed, language: lang, uselang: lang, type: "item", limit: "10" },
        userAgent,
      )) as { search?: SearchHit[] };
      hits = json.search ?? [];
      lastError = null;
      if (hits.length > 0) break;
    } catch (e) {
      lastError = e;
    }
  }
  if (hits.length === 0) {
    if (lastError) throw lastError instanceof Error ? lastError : new Error(String(lastError));
    return [];
  }

  const qids = hits.map((h) => h.id).filter((x): x is string => typeof x === "string" && /^Q\d+$/.test(x));
  if (qids.length === 0) return [];

  const entities = await fetchEntities(qids, userAgent);

  const kept = qids
    .map((qid) => entities[qid])
    .filter((e): e is Entity => Boolean(e))
    .filter(looksLikeUniversity);

  const refQids = kept.flatMap((e) => [
    readEntityId(firstClaim(e, P_COUNTRY)),
    readEntityId(firstClaim(e, P_ADMIN)),
    readEntityId(firstClaim(e, P_INSTANCE)),
  ]).filter((x): x is string => x !== null);
  const labels = await fetchLabels(refQids, userAgent);

  return kept.map((e) => {
    const { lat, lon } = readCoord(firstClaim(e, P_COORD));
    const countryQid = readEntityId(firstClaim(e, P_COUNTRY));
    const cityQid = readEntityId(firstClaim(e, P_ADMIN));
    const instanceQid = readEntityId(firstClaim(e, P_INSTANCE));
    return {
      qid: e.id ?? "",
      resolvedVia: "action-api" as const,
      label: pickLabel(e, e.id ?? ""),
      lat,
      lon,
      officialWebsite: readString(firstClaim(e, P_WEBSITE)),
      country: countryQid ? labels.get(countryQid) ?? null : null,
      city: cityQid ? labels.get(cityQid) ?? null : null,
      image: null,
      instanceOf: instanceQid ? labels.get(instanceQid) ?? null : null,
    };
  }).filter((c) => c.qid !== "");
}

/** Одна карточка по QID через Action API. */
export async function getUniversityByQidViaApi(
  qid: string,
  userAgent: string,
): Promise<UniversityCandidate | null> {
  if (!/^Q\d+$/.test(qid)) return null;
  const entities = await fetchEntities([qid], userAgent);
  const e = entities[qid];
  if (!e) return null;
  // Тот же фильтр, что и в поиске: SPARQL-путь для не-вуза возвращает null,
  // запасной путь обязан вести себя так же, иначе профиль соберётся для любой сущности.
  if (!looksLikeUniversity(e)) return null;

  const countryQid = readEntityId(firstClaim(e, P_COUNTRY));
  const cityQid = readEntityId(firstClaim(e, P_ADMIN));
  const instanceQid = readEntityId(firstClaim(e, P_INSTANCE));
  const labels = await fetchLabels(
    [countryQid, cityQid, instanceQid].filter((x): x is string => x !== null),
    userAgent,
  );
  const { lat, lon } = readCoord(firstClaim(e, P_COORD));

  return {
    qid,
    resolvedVia: "action-api",
    label: pickLabel(e, qid),
    lat,
    lon,
    officialWebsite: readString(firstClaim(e, P_WEBSITE)),
    country: countryQid ? labels.get(countryQid) ?? null : null,
    city: cityQid ? labels.get(cityQid) ?? null : null,
    image: null,
    instanceOf: instanceQid ? labels.get(instanceQid) ?? null : null,
  };
}
