// lib/profile.ts
// Оркестратор блока B. Пайплайн:
//   1. якорь координат: Wikidata → (Places + подтверждение 2ГИС) → Places → нет
//   2. кандидаты: места из Google Places (по плану запросов) + картинки с сайта вуза
//   3. загрузка всех картинок, отсев слишком мелких
//   4. дедупликация по dHash
//   5. vision: что изображено → отсев нерелевантных, категория по содержимому
//   6. покрытие, статистика отсева, описание
//
// Каждая строка в evidence.reasons — реально выполненная проверка.

import { describeCampus } from "./describe";
import { loadDeepContext } from "./deep-context";
import { findCommonsPhotos } from "./commons";
import { haversineM } from "./geo";
import { dHash, hamming, loadImage, sharpness, type LoadedImage } from "./image";
import { chooseAnchor, AGREEMENT_RADIUS_M, type LocationObservation } from "./location";
import { collectOfficialImages, type OfficialResult } from "./official";
import { findCityCenter } from "./osm";
import { getPhotoUri, getPlaceReviews, searchText, type Place } from "./places";
import { findInTwoGis } from "./twogis";
import { BATCH_SIZE, classifyImages, type VisionInput } from "./vision";
import {
  ALL_CATEGORIES,
  QUICK_CATEGORIES,
  type Anchor,
  type Category,
  type CityCenter,
  type MapPoint,
  type PlaceReview,
  type ProfileMode,
  type CategoryCoverage,
  type Evidence,
  type PhotoItem,
  type PhotoSource,
  type Profile,
  type ProgressEvent,
  type RemovalStats,
  type TrustTier,
  type UniversityCandidate,
  type VisionVerdict,
} from "./types";

// ---- Настраиваемые пороги. Показывать в README и в карточке провенанса. ----

const VERIFIED_RADIUS_M = 1500;
const PROBABLE_RADIUS_M = 6000;
const SEARCH_BIAS_RADIUS_M = 5000;
/** Радиус поиска общественных мест вокруг кампуса: парки и кафе, до которых студент дойдёт пешком. */
const NEIGHBORHOOD_BIAS_RADIUS_M = 2000;

/** Кейс прямо говорит: пятнадцать проверенных снимков ценнее сотни случайных.
 *  Отсюда все лимиты ниже: они режут не качество, а повторы одного и того же. */
const PHOTOS_PER_PLACE = 2;
/** Для окружения — один кадр с места. Два снимка одного кафе не добавляют ничего:
 *  это по-прежнему одно кафе, а место в профиле занято. */
const CITY_PHOTOS_PER_PLACE = 1;
/** Потолок на категорию. Шесть кадров общежития снаружи — это не «покрытие
 *  категории», а один и тот же дом с разных сторон. */
const MAX_PER_CATEGORY = 6;
/** Порог резкости (дисперсия лапласиана, см. lib/image.ts). Взят с большим запасом:
 *  на калибровке резкий кадр даёт ~1000, сильно размытый — единицы и десятки,
 *  однотонная заливка — ноль. Всё, что ниже, показывать бессмысленно: там нечего
 *  рассматривать. Отсеянное считается отдельной строкой, чтобы порог было видно. */
const SHARPNESS_MIN = 20;
const MAX_PLACES_PHOTOS = 30;
/** Снимков с сайта вуза берём больше, чем раньше: обход стал целевым, и десяти
 *  слотов не хватает, чтобы в профиль попали и библиотека, и спортзал, и столовая. */
const MAX_OFFICIAL_PHOTOS = 14;
/** Окружение — контекст, а не кампус: держим его небольшим, чтобы оно не забивало профиль. */
const MAX_CITY_PHOTOS = 3;
/** Снимков города — немного: кейс требует показать город, но профиль остаётся про вуз. */
const MAX_CITYWIDE_PHOTOS = 4;
/** Радиус поиска по городу: центр может быть в десятке километров от кампуса. */
const CITY_BIAS_RADIUS_M = 20000;
/** Дальше этого расстояния от кампуса место считается уже не этим городом.
 *  Проверка грубая и поэтому не единственная: основная — совпадение названия города
 *  в адресе места из Google Places. */
const SAME_CITY_RADIUS_M = 40000;
/** Порог для категории «вокруг кампуса»: то, до чего студент дойдёт пешком.
 *  Снимок окружения дальше этого расстояния описывает другой район города, а не
 *  окрестности вуза, и в профиле ему делать нечего — даже с честной пометкой
 *  «вероятно». Проверка применяется к итоговой категории, поэтому ловит и те
 *  снимки, которые в «город» переразметила модель, а нашёл их другой запрос. */
const NEIGHBORHOOD_MAX_M = 2000;
const MIN_WIDTH_PX = 500;
const MIN_HEIGHT_PX = 300;
/** Хэммингово расстояние между dHash, при котором снимки считаются дублями. */
const DUPLICATE_HAMMING = 10;

// ЗАМЕНИТЬ на реальный URL репозитория (тот же, что в lib/wikidata.ts).
const USER_AGENT = "shyngan/0.2 (https://github.com/kiddorri/shyngan)";

// ---- План запросов к Places. Порядок важен: первый задаёт якорь и категорию "campus". ----

type QueryPlanItem = {
  category: Category;
  build: (u: UniversityCandidate) => string | null;
  pageSize: number;
  /** Радиус locationBias. По умолчанию SEARCH_BIAS_RADIUS_M. */
  biasRadiusM?: number;
  /** Входит ли запрос в быстрый взгляд. Быстрый спрашивает по одному запросу на
   *  категорию — этого хватает, чтобы показать вуз целиком, и не хватает, чтобы
   *  потратить полминуты. */
  quick?: boolean;
};

const QUERY_PLAN: QueryPlanItem[] = [
  { category: "campus", build: (u) => u.label, pageSize: 1, quick: true },
  { category: "lecture", build: (u) => `${u.label} учебный корпус`, pageSize: 2, quick: true },
  { category: "dorm", build: (u) => `${u.label} общежитие`, pageSize: 2, quick: true },
  { category: "library", build: (u) => `${u.label} библиотека`, pageSize: 2, quick: true },
  { category: "lab", build: (u) => `${u.label} лаборатория`, pageSize: 2 },
  { category: "sport", build: (u) => `${u.label} спортивный комплекс`, pageSize: 2, quick: true },
  // Места, которые студент видит каждый день, но которых не было в плане.
  // «Актовый зал» ищем отдельно от учебных корпусов: в Places это чаще самостоятельное
  // место, а внутри — ряды кресел и сцена, то есть ровно та категория, которая пустует.
  { category: "lecture", build: (u) => `${u.label} актовый зал`, pageSize: 1 },
  { category: "canteen", build: (u) => `${u.label} столовая`, pageSize: 2, quick: true },
  { category: "outdoor", build: (u) => `${u.label} территория кампуса`, pageSize: 2, quick: true },
  { category: "life", build: (u) => `${u.label} студенческая жизнь`, pageSize: 2 },
  // Запросов «музей» и «коворкинг» здесь быть не должно. Оба слова сильнее привязаны
  // к известным городским заведениям, чем к названию вуза: по «<вуз> музей» Places
  // отдаёт главный музей города за несколько километров от кампуса, и снимок доходит
  // до профиля законным путём — в пределах порога «вероятно». Университетский музей,
  // если он есть, находится внутри корпуса и попадает в профиль по другим запросам.
  // Окружение кампуса ищем рядом с якорем, а не по названию города: студенту
  // полезен парк в десяти минутах ходьбы, а не панорама центра в восьми километрах.
  { category: "city", build: () => "парк", pageSize: 1, biasRadiusM: NEIGHBORHOOD_BIAS_RADIUS_M },
  { category: "city", build: () => "кафе", pageSize: 1, biasRadiusM: NEIGHBORHOOD_BIAS_RADIUS_M },
  // А это уже сам город — требование 2 кейса. Отдельные запросы и широкий радиус:
  // центр города к кампусу не привязан и может быть в десятке километров.
  //
  // Запросы выбраны под общие виды, а не под «что угодно в городе»: у смотровой
  // площадки и набережной посетители снимают панораму, у «достопримечательностей» —
  // крупный план памятника. Город должен быть виден городом.
  { category: "citywide", build: (u) => (u.city ? `${u.city} смотровая площадка` : null), pageSize: 2, biasRadiusM: CITY_BIAS_RADIUS_M },
  { category: "citywide", build: (u) => (u.city ? `${u.city} набережная` : null), pageSize: 1, biasRadiusM: CITY_BIAS_RADIUS_M },
  { category: "citywide", build: (u) => (u.city ? `${u.city} центр города` : null), pageSize: 2, biasRadiusM: CITY_BIAS_RADIUS_M },
];

// ---- Промежуточное представление снимка до загрузки ----

type RawPhoto = {
  id: string;
  source: PhotoSource;
  /** Дата публикации страницы-источника, если она известна. */
  publishedAt: string | null;
  imageUrl: string;
  sourceUrl: string | null;
  attribution: PhotoItem["attribution"];
  license: PhotoItem["license"];
  category: Category;
  trust: TrustTier;
  evidence: Evidence;
  widthPx: number;
  heightPx: number;
};

type Loaded = { raw: RawPhoto; img: LoadedImage; hash: string };

/** A facade is visually a campus building, but a named library or dormitory
 * remains that facility when the place itself supplies independent evidence. */
function categoryFromEvidence(raw: RawPhoto, verdict: VisionVerdict): Category | "other" {
  if (verdict.category !== "campus" || raw.source !== "google_places") return verdict.category;
  const name = raw.evidence.placeName.toLocaleLowerCase();
  const patterns: Partial<Record<Category, RegExp>> = {
    library: /librar|библиотек|кітапхан|图书馆|圖書館|도서관|図書館/i,
    dorm: /dorm|residen|общежити|жатақхан|宿舍|기숙사|寮/i,
    sport: /sport|athletic|gymnasium|спорт|спортив|体育|體育|체육/i,
    canteen: /canteen|cafeteria|dining hall|столов|асхан|食堂|학생식당/i,
    lecture: /lecture|classroom|аудитор|учебный корпус|教学楼|教學樓|강의동/i,
  };
  return patterns[raw.category]?.test(name) ? raw.category : verdict.category;
}

const TIER_RANK: Record<TrustTier, number> = { verified: 0, probable: 1, unverified: 2 };
const SOURCE_RANK: Record<PhotoSource, number> = { official_site: 0, google_places: 1, wikimedia_commons: 2 };
/** Порядок вывода: объекты вуза впереди, город последним. */
const CATEGORY_RANK: Record<Category, number> = {
  campus: 0, lecture: 1, library: 2, sport: 3, canteen: 4, dorm: 5, outdoor: 6, lab: 7, life: 8, city: 9, citywide: 10,
};

// ---- Доверие по расстоянию ----

function downgrade(t: TrustTier): TrustTier {
  return t === "verified" ? "probable" : "unverified";
}

function assessTrust(
  place: Place,
  anchor: Anchor | null,
  anchorPlaceId: string | null,
  universityLabel: string,
  universityWebsite: string | null,
): { trust: TrustTier; distanceM: number | null; reasons: string[] } {
  const reasons: string[] = [`Место найдено через Google Places (place_id ${place.id})`];

  if (anchorPlaceId && place.id === anchorPlaceId) {
    if (anchor?.source === "places+2gis") {
      reasons.push("Это место — источник якорных координат; его расположение независимо подтверждено 2ГИС");
      return { trust: "probable", distanceM: null, reasons };
    }
    reasons.push("Якорные координаты взяты из этого же места — расстояние с ним ничего не подтверждает");
    reasons.push("Независимой географической проверки нет: место найдено только по совпадению названия");
    return { trust: "unverified", distanceM: null, reasons };
  }

  if (!anchor) {
    reasons.push("Якорных координат нет — расстояние не проверялось");
    return { trust: "unverified", distanceM: null, reasons };
  }
  if (!place.location) {
    reasons.push("У места нет координат в Places — расстояние не проверялось");
    return { trust: "unverified", distanceM: null, reasons };
  }

  const distanceM = haversineM(anchor.lat, anchor.lon, place.location.latitude, place.location.longitude);
  reasons.push("Расстояние измеряется до отметки места на карте, а не до точки, где сделан снимок");

  let trust: TrustTier;
  if (distanceM <= VERIFIED_RADIUS_M) {
    trust = "verified";
    reasons.push(`Расстояние до кампуса ${distanceM} м (порог ${VERIFIED_RADIUS_M} м)`);
    // Близость к кампусу подтверждает район, но рядом бывают чужие учреждения.
    // Для бейджа «Подтверждено» нужен ещё признак принадлежности самого места.
    const siteMatches = (() => {
      if (!place.websiteUri || !universityWebsite) return false;
      try {
        const a = new URL(place.websiteUri).hostname.replace(/^www\./, "");
        const b = new URL(universityWebsite).hostname.replace(/^www\./, "");
        return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
      } catch { return false; }
    })();
    if (siteMatches) reasons.push("Сайт места находится на домене университета");
    else if (nameLooksLikeUniversity(place.displayName?.text ?? "", universityLabel)) {
      reasons.push("Название места совпадает с названием университета");
    } else {
      trust = "probable";
      reasons.push("Место рядом с кампусом, но его название и сайт не подтверждают принадлежность университету");
    }
  } else if (distanceM <= PROBABLE_RADIUS_M) {
    trust = "probable";
    reasons.push(`Расстояние до кампуса ${distanceM} м — дальше ${VERIFIED_RADIUS_M} м, но в пределах ${PROBABLE_RADIUS_M} м`);
  } else {
    trust = "unverified";
    reasons.push(`Расстояние до кампуса ${distanceM} м — дальше порога ${PROBABLE_RADIUS_M} м`);
    // У вуза бывает несколько корпусов в разных концах города. Совпадение названия —
    // не доказательство (тёзки существуют), но и молчать о нём нечестно.
    if (nameLooksLikeUniversity(place.displayName?.text ?? "", universityLabel)) {
      trust = "probable";
      reasons.push("Название места совпадает с названием вуза — вероятно, другой корпус; географически это не подтверждено");
    }
  }

  switch (anchor.source) {
    case "wikidata+places+2gis":
      reasons.push("Расположение сверено по Wikidata, Google Places и 2ГИС");
      break;
    case "wikidata+places":
      reasons.push("Расположение сверено по Wikidata и Google Places");
      break;
    case "wikidata+2gis":
      reasons.push("Расположение сверено по Wikidata и 2ГИС");
      break;
    case "wikidata":
      reasons.push("Якорные координаты: Wikidata; второй источник не подтвердил точку");
      break;
    case "places+2gis":
      reasons.push("Координат в Wikidata нет; якорь из Google Places подтверждён 2ГИС (второй независимый провайдер)");
      break;
    case "places":
      reasons.push("Координат в Wikidata нет — якорь взят из Google Places без подтверждения, доверие понижено на один уровень");
      trust = downgrade(trust);
      break;
  }

  if (anchor.disputed) {
    reasons.push("Найденные источники расходятся по расположению — доверие понижено");
    trust = downgrade(trust);
  }

  return { trust, distanceM, reasons };
}

// ---- Принадлежность городу (для категории «Город») ----

/** «г. Астана» и «Астана» должны совпасть. Нормализуем мягко. */
function normalizeCity(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я]+/gi, " ").trim();
}

/** Город из структурного адреса Google Places. Строку адреса для этого использовать
 *  нельзя: в ней город соседствует с улицей, индексом и районом. */
function localityOf(place: Place): string | null {
  const c = (place.addressComponents ?? []).find((x) => (x.types ?? []).includes("locality"));
  return c?.longText ?? c?.shortText ?? null;
}

/** Название места похоже на название вуза? Это слабый признак: тёзки существуют.
 *  Но у вуза с несколькими корпусами второй адрес называется так же, и молчать об
 *  этом хуже, чем сказать «вероятно». */
function nameLooksLikeUniversity(placeName: string, universityLabel: string): boolean {
  const norm = (x: string) => normalizeCity(x).split(" ").filter((w) => w.length > 3);
  const uniWords = new Set(norm(universityLabel));
  const placeWords = norm(placeName);
  if (uniWords.size === 0 || placeWords.length === 0) return false;
  const shared = placeWords.filter((w) => uniWords.has(w)).length;
  return shared >= Math.min(2, uniWords.size);
}

/**
 * Снимок города проверяется на другое утверждение, чем снимок вуза: не «это объект
 * университета», а «это тот город, в котором университет находится». Смешивать их
 * нельзя — иначе площадь в центре города оказывается «неподтверждённым кампусом».
 */
function assessCityTrust(
  place: Place,
  anchor: Anchor | null,
  cityName: string | null,
  campusCity: string | null,
): { trust: TrustTier; distanceM: number | null; reasons: string[] } {
  const reasons = [
    `Место найдено через Google Places (place_id ${place.id})`,
    "Это снимок города, а не объекта вуза: проверяется принадлежность городу, а не университету",
  ];

  // Сверяем город места с городом кампуса по структурному адресу. Справочник и карты
  // называют один город по-разному («Алма-Ата» против «Алматы»), поэтому эталоном
  // служит город кампуса из Google Places, а название из Wikidata — запасным вариантом.
  const placeCity = localityOf(place);
  const expected = [campusCity, cityName].filter((x): x is string => Boolean(x));
  const addressHasCity =
    placeCity !== null &&
    expected.some((e) => {
      const a = normalizeCity(placeCity);
      const b = normalizeCity(e);
      return a === b || a.includes(b) || b.includes(a);
    });
  if (expected.length === 0) reasons.push("Город вуза неизвестен — сверять не с чем");
  else if (placeCity === null) reasons.push("Google Places не сообщил город этого места");
  else if (addressHasCity) reasons.push(`Город места «${placeCity}» совпадает с городом кампуса (Google Places)`);
  else reasons.push(`Город места «${placeCity}» не совпадает с городом кампуса «${expected[0]}»`);

  let distanceM: number | null = null;
  if (anchor && place.location) {
    distanceM = haversineM(anchor.lat, anchor.lon, place.location.latitude, place.location.longitude);
    reasons.push(
      distanceM <= SAME_CITY_RADIUS_M
        ? `Расстояние до кампуса ${distanceM} м — в пределах города (порог ${SAME_CITY_RADIUS_M} м)`
        : `Расстояние до кампуса ${distanceM} м — дальше порога ${SAME_CITY_RADIUS_M} м`,
    );
  } else {
    reasons.push("Расстояние не проверялось: нет якоря или координат места");
  }

  const nearEnough = distanceM !== null && distanceM <= SAME_CITY_RADIUS_M;
  let trust: TrustTier = addressHasCity && nearEnough ? "verified" : addressHasCity || nearEnough ? "probable" : "unverified";
  if (anchor?.disputed) {
    trust = downgrade(trust);
    reasons.push("Источники расходятся по расположению кампуса — проверка расстояния до города ограничена");
  }
  return { trust, distanceM, reasons };
}

// ---- Сбор кандидатов из Places ----

async function placeToRaw(
  place: Place,
  category: Category,
  anchor: Anchor | null,
  anchorPlaceId: string | null,
  cityName: string | null,
  campusCity: string | null,
  universityLabel: string,
  universityWebsite: string | null,
  photosPerPlace: number,
): Promise<RawPhoto[]> {
  const perPlace = category === "city" || category === "citywide" ? CITY_PHOTOS_PER_PLACE : photosPerPlace;
  const photos = (place.photos ?? []).slice(0, perPlace);
  if (photos.length === 0) return [];

  const { trust, distanceM, reasons } =
    category === "citywide"
      ? assessCityTrust(place, anchor, cityName, campusCity)
      : assessTrust(place, anchor, anchorPlaceId, universityLabel, universityWebsite);
  const placeName = place.displayName?.text ?? place.id;
  const uris = await Promise.all(photos.map((p) => getPhotoUri(p.name)));

  const out: RawPhoto[] = [];
  photos.forEach((p, i) => {
    const imageUrl = uris[i];
    if (!imageUrl) return;
    out.push({
      id: p.name,
      source: "google_places",
      // Google Places не сообщает, когда сделан или опубликован снимок. Никогда.
      publishedAt: null,
      imageUrl,
      sourceUrl: p.googleMapsUri ?? place.googleMapsUri ?? null,
      attribution: (p.authorAttributions ?? []).map((a) => ({ name: a.displayName, uri: a.uri ?? null })),
      license: null,
      category,
      trust,
      evidence: {
        anchorSource: anchor?.source ?? "none",
        placeId: place.id,
        placeName,
        address: place.formattedAddress ?? null,
        distanceM,
        queryIntent: category,
        vision: null,
        reasons: [...reasons],
      },
      widthPx: p.widthPx,
      heightPx: p.heightPx,
    });
  });
  return out;
}

/** «farabi.university/gallery» — видно, с какой именно страницы сайта взят снимок. */
function pagePathOf(pageUrl: string, host: string | null): string {
  try {
    const u = new URL(pageUrl);
    const path = u.pathname === "/" ? " (главная)" : u.pathname;
    return `${u.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return host ?? pageUrl;
  }
}

/** «/gallery» — короткое имя прочитанной страницы для предупреждений. */
function shortPath(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    return u.pathname === "/" ? "главная" : decodeURIComponent(u.pathname);
  } catch {
    return pageUrl;
  }
}

/** Датированное и свежее — вперёд, недатированное — следом, старое — в конец.
 *  Без даты снимок не считается старым: источник просто промолчал. */
const FRESH_MS = 3 * 365.25 * 24 * 3600 * 1000;
function freshnessRank(publishedAt: string | null): number {
  if (!publishedAt) return 1;
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return 1;
  return Date.now() - t <= FRESH_MS ? 0 : 2;
}

/** Сколько картинок тянем одновременно. Раньше грузились все сразу — до сорока
 *  запросов в одну секунду на один вузовский сервер. Это уже не «сбор данных», а
 *  небольшая атака: при повторных сборах сайт начинал отвечать отказом, и профиль
 *  оставался пустым. Вежливость здесь не только этика, но и работоспособность. */
const DOWNLOAD_CONCURRENCY = 6;
/** В быстром взгляде медленный сайт не должен задерживать уже найденные снимки Places. */
const QUICK_OFFICIAL_BUDGET_MS = 6500;
const QUICK_TOTAL_BUDGET_MS = 28000;

async function withDeadline<T>(promise: Promise<T>, remainingMs: number, fallback: T): Promise<T> {
  if (remainingMs <= 0) return fallback;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), remainingMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(fallback); },
    );
  });
}

/** Выполняет задачи пачками по limit штук, сохраняя порядок результатов. */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---- Распределение бюджета ----

/** Берёт по одному элементу из каждой группы по кругу, пока не наберётся limit.
 *  Экспортируется для оффлайн-теста. */
export function interleave<T>(groups: T[][], limit: number): T[] {
  const out: T[] = [];
  for (let i = 0; out.length < limit; i++) {
    let anyLeft = false;
    for (const group of groups) {
      if (i >= group.length) continue;
      anyLeft = true;
      out.push(group[i]);
      if (out.length >= limit) break;
    }
    if (!anyLeft) break;
  }
  return out;
}

// ---- Покрытие ----

function computeCoverage(photos: PhotoItem[]): CategoryCoverage[] {
  return ALL_CATEGORIES.map((category) => {
    const inCat = photos.filter((p) => p.category === category);
    return {
      category,
      verified: inCat.filter((p) => p.trust === "verified").length,
      probable: inCat.filter((p) => p.trust === "probable").length,
      unverified: inCat.filter((p) => p.trust === "unverified").length,
    };
  });
}

// ---- Главная функция ----

/** Пределы, различающиеся между быстрым взглядом и полным сбором.
 *  Быстрый должен показать вуз целиком и сразу: по одному-два снимка на категорию.
 *  Полный — дать материал тем, кто нажал «подробнее». */
function limitsFor(mode: ProfileMode) {
  return mode === "quick"
    ? {
        photosPerPlace: 1,
        maxPlacesPhotos: 20,
        // Было 6/2: быстрый взгляд — это то, что видит жюри по умолчанию, и с этими
        // потолками он показывал 1-2 фотографии на категорию даже когда кандидатов
        // хватало на больше. maxDuration у /api/profile — 180 с, а быстрый обычно
        // укладывается в 10-15 — запас есть, несколько лишних снимков его не тронут.
        maxOfficialPhotos: 9,
        maxPerCategory: 2,
        maxCityPhotos: 1,
        maxCitywidePhotos: 1,
      }
    : {
        photosPerPlace: PHOTOS_PER_PLACE,
        maxPlacesPhotos: MAX_PLACES_PHOTOS,
        maxOfficialPhotos: MAX_OFFICIAL_PHOTOS,
        maxPerCategory: MAX_PER_CATEGORY,
        maxCityPhotos: MAX_CITY_PHOTOS,
        maxCitywidePhotos: MAX_CITYWIDE_PHOTOS,
      };
}

export async function buildProfile(
  university: UniversityCandidate,
  onProgress: (e: ProgressEvent) => void = () => {},
  mode: ProfileMode = "deep",
  quickBudgetMs = QUICK_TOTAL_BUDGET_MS,
): Promise<Profile> {
  const started = Date.now();
  const quickDeadline = mode === "quick" ? started + Math.min(QUICK_TOTAL_BUDGET_MS, quickBudgetMs) : Infinity;
  const timeLeft = () => Math.max(0, quickDeadline - Date.now());
  const limits = limitsFor(mode);
  const plan = QUERY_PLAN.filter((item) => mode === "deep" || item.quick);
  const warnings: string[] = [];
  if (university.resolvedVia === "places") {
    warnings.push(
      // Про координаты здесь говорить нельзя: расположение проверяется ниже, и 2ГИС
      // вполне может его подтвердить. Эта строка — только про карточку вуза.
      "Карточка вуза получена только из Google Places: название и сайт пока не подтверждены независимым источником. Координаты Wikidata для этой карточки недоступны; расположение проверяется отдельно.",
    );
  }
  if (university.resolvedVia === "action-api") {
    warnings.push(
      "Справочник SPARQL не ответил — карточка вуза получена запасным путём (Wikidata Action API). Там недоступна проверка по цепочке подклассов, поэтому отбор «это вуз» мягче обычного.",
    );
  }
  const removed: RemovalStats = {
    duplicates: 0,
    irrelevant: 0,
    tooSmall: 0,
    failedDownload: 0,
    overSiteLimit: 0,
    farFromCampus: 0,
    blurry: 0,
    overCategoryLimit: 0,
    cityNotWide: 0,
  };

  // 1. Главный запрос к Places — от него может зависеть якорь.
  const [campusPlan, ...restPlan] = plan;
  const campusQuery = campusPlan.build(university);
  const wikidataBias =
    university.lat !== null && university.lon !== null
      ? { lat: university.lat, lon: university.lon, radiusM: SEARCH_BIAS_RADIUS_M }
      : undefined;
  const twoGisPromise = wikidataBias
    ? findInTwoGis(university.label, wikidataBias)
    : null;

  // Обход сайта не зависит от координат и запросов Places. Запускаем его сразу,
  // пока остальные источники определяют кампус и соседние места.
  const officialPromise: Promise<OfficialResult> = university.officialWebsite
    ? collectOfficialImages(university.officialWebsite, USER_AGENT, {
        deep: mode === "deep",
        maxCandidates: mode === "deep" ? undefined : limits.maxOfficialPhotos * 2,
      }).catch((e) => ({
        candidates: [], pagesVisited: [], blockedByRobots: [], robotsNote: null,
        skippedForTime: 0, error: `сайт недоступен: ${(e as Error).message}`,
      }))
    : Promise.resolve({
        candidates: [], pagesVisited: [], blockedByRobots: [], robotsNote: null,
        skippedForTime: 0, error: "официальный сайт вуза неизвестен",
      });
  const selectedOfficialPromise = mode === "quick"
    ? withDeadline(officialPromise, QUICK_OFFICIAL_BUDGET_MS, {
        candidates: [], pagesVisited: [], blockedByRobots: [], robotsNote: null, skippedForTime: 0,
        error: "сайт не ответил за время быстрого взгляда; полный сбор продолжит его проверку",
      })
    : officialPromise;
  // Commons — дополнительный источник с более слабой географической привязкой.
  // Его несколько последовательных API-запросов не должны задерживать быстрый взгляд.
  const commonsPromise = (university.qid.startsWith("Q") ? findCommonsPhotos(university.qid, mode === "deep" ? 8 : 6) : Promise.resolve([]))
    .catch((e) => {
      warnings.push(`Wikimedia Commons: запрос не выполнен (${(e as Error).message})`);
      return [];
    });

  let campusPlaces: Place[] = [];
  try {
    campusPlaces = campusQuery
      ? await (mode === "quick"
          ? withDeadline(searchText(campusQuery, { bias: wikidataBias, pageSize: Math.max(3, campusPlan.pageSize) }), 6500, [])
          : searchText(campusQuery, { bias: wikidataBias, pageSize: Math.max(3, campusPlan.pageSize) }))
      : [];
  } catch (e) {
    warnings.push(`Places: основной запрос не выполнен (${(e as Error).message})`);
  }
  const siteHost = (url: string | null) => {
    try { return url ? new URL(url).hostname.replace(/^www\./, "") : null; }
    catch { return null; }
  };
  const officialDomain = siteHost(university.officialWebsite);
  const campusPlace = [...campusPlaces].sort((a, b) => {
    const score = (p: Place) => {
      let value = 0;
      const host = siteHost(p.websiteUri ?? null);
      if (host && officialDomain && (host === officialDomain || host.endsWith(`.${officialDomain}`))) value += 10;
      if (wikidataBias && p.location) {
        const distance = haversineM(wikidataBias.lat, wikidataBias.lon, p.location.latitude, p.location.longitude);
        if (distance <= AGREEMENT_RADIUS_M) value += 5;
        else if (distance > 10000) value -= 10;
      }
      return value;
    };
    return score(b) - score(a);
  })[0];

  // 2. Сверка всех доступных точек: Wikidata, Google Places и 2ГИС.
  const googlePoint = campusPlace?.location
    ? { lat: campusPlace.location.latitude, lon: campusPlace.location.longitude }
    : null;
  const twoGisWork = twoGisPromise ?? (googlePoint ? findInTwoGis(university.label, googlePoint) : Promise.resolve(null));
  const twoGis = mode === "quick" ? await withDeadline(twoGisWork, Math.min(1500, timeLeft()), null) : await twoGisWork;
  const points: LocationObservation[] = [];
  if (wikidataBias) points.push({ source: "wikidata", name: university.label, address: null, lat: wikidataBias.lat, lon: wikidataBias.lon });
  if (googlePoint) points.push({ source: "places", name: campusPlace.displayName?.text ?? university.label,
    address: campusPlace.formattedAddress ?? null, ...googlePoint });
  if (twoGis) points.push({ source: "2gis", name: twoGis.name, address: twoGis.address,
    lat: twoGis.lat, lon: twoGis.lon });
  const anchor: Anchor | null = chooseAnchor(points);
  if (!anchor) warnings.push("Координаты кампуса не найдены — проверка расстояния невозможна");
  else if (anchor.disputed) warnings.push("Источники указывают разные точки кампуса; расстояния рассчитаны от выбранной точки, доверие снижено. Сравнение координат открывается в разделе «Как собран этот профиль».");
  else if (anchor.observations.length === 1) warnings.push(`Расположение сообщил только один источник (${anchor.source}); независимой сверки координат нет.`);
  else {
    for (const observation of anchor.observations.filter((p) => p.distanceM > AGREEMENT_RADIUS_M)) {
      warnings.push(`${observation.source} указывает точку в ${observation.distanceM} м от выбранного якоря; она не использована для подтверждения.`);
    }
  }
  onProgress({ stage: "anchor", source: anchor?.source ?? "none" });
  const deepContextPromise = mode === "deep" ? loadDeepContext(university, anchor) : Promise.resolve(undefined);

  // Дополнительные функции кейса: расстояние до центра города и отзывы о кампусе.
  // Запускаем сразу и забираем в самом конце — они не должны удлинять сборку профиля.
  const anchorForCity = anchor;
  const cityCenterPromise: Promise<CityCenter | null> =
    mode === "deep" && university.city && anchorForCity
      ? findCityCenter(university.city, USER_AGENT, university.country).then((c) =>
          c
            ? {
                name: c.name,
                lat: c.lat,
                lon: c.lon,
                distanceM: haversineM(anchorForCity.lat, anchorForCity.lon, c.lat, c.lon),
                source: "openstreetmap" as const,
              }
            : null,
        )
      : Promise.resolve(null);
  // Отзывы тарифицируются по более дорогому SKU Places, поэтому их можно выключить
  // переменной окружения, не трогая код.
  const reviewsPromise: Promise<PlaceReview[]> =
    mode === "deep" && campusPlace && process.env.PLACE_REVIEWS !== "off" ? getPlaceReviews(campusPlace.id) : Promise.resolve([]);

  // Город кампуса по данным карт — эталон для сверки городских снимков.
  const campusCity = campusPlace ? localityOf(campusPlace) : null;
  const anchorPlaceId = anchor && ["places", "places+2gis"].includes(anchor.source) && campusPlace ? campusPlace.id : null;
  const bias = anchor ? { lat: anchor.lat, lon: anchor.lon, radiusM: SEARCH_BIAS_RADIUS_M } : undefined;

  // 3. Остальные запросы к Places. Обход официального сайта уже выполняется.
  const restResults = await Promise.all(
    restPlan.map(async (item) => {
        const q = item.build(university);
        if (!q) return { category: item.category, places: [] as Place[] };
        const itemBias = bias && item.biasRadiusM ? { ...bias, radiusM: item.biasRadiusM } : bias;
        // В быстром взгляде берём по одному месту на запрос: доске хватает, а время
        // уходит не на поиск, а на загрузку и проверку снимков.
        const pageSize = mode === "quick" ? 1 : item.pageSize;
        try {
          const request = searchText(q, { bias: itemBias, pageSize });
          return { category: item.category, places: mode === "quick" ? await withDeadline(request, Math.min(6500, timeLeft()), []) : await request };
        } catch (e) {
          warnings.push(`Places: запрос «${q}» не выполнен (${(e as Error).message})`);
          return { category: item.category, places: [] as Place[] };
        }
    }),
  );

  // Одно место — одна категория. Первое вхождение побеждает (campus идёт первым).
  const seenPlaces = new Set<string>();
  const jobs: Array<{ place: Place; category: Category }> = [];
  if (campusPlace) {
    seenPlaces.add(campusPlace.id);
    jobs.push({ place: campusPlace, category: "campus" });
  }
  for (const r of restResults) {
    for (const place of r.places) {
      if (seenPlaces.has(place.id)) continue;
      seenPlaces.add(place.id);
      jobs.push({ place, category: r.category });
    }
  }

  // Бюджет снимков делим между местами по кругу, а не обрезаем хвост плана: иначе три
  // фотографии главного корпуса вытесняют единственный снимок общежития или столовой,
  // и категория остаётся пустой не потому, что снимков не нашлось.
  const perPlace = await Promise.all(
    jobs.map((j) =>
      mode === "quick"
        ? withDeadline(placeToRaw(j.place, j.category, anchor, anchorPlaceId, university.city, campusCity, university.label, university.officialWebsite, limits.photosPerPlace), Math.min(5000, timeLeft()), [])
        : placeToRaw(j.place, j.category, anchor, anchorPlaceId, university.city, campusCity, university.label, university.officialWebsite, limits.photosPerPlace),
    ),
  );
  const placesRaw = interleave(perPlace, limits.maxPlacesPhotos);
  onProgress({ stage: "places", found: placesRaw.length });

  // Разрешение URL снимков Places выполнялось только после завершения обхода
  // сайта, хотя эти операции независимы. Дожидаемся сайта лишь перед сбором
  // общего набора кандидатов.
  const official = await selectedOfficialPromise;

  if (official.error) warnings.push(`Официальный сайт: ${official.error}`);
  else if (official.pagesVisited.length > 1) {
    // Перечисляем реально прочитанные адреса. Раньше здесь стояло «главная и разделы
    // с фотографиями» — утверждение о содержимом страниц, которое мы не проверяли:
    // внутренние ссылки отбираются по тексту, и иногда это не галерея.
    const paths = official.pagesVisited.map(shortPath).join(", ");
    warnings.push(`Официальный сайт: прочитано страниц — ${official.pagesVisited.length} (${paths})`);
  }
  // Пропущенное по просьбе сайта показываем отдельно: «не нашли» и «не смотрели,
  // потому что сайт попросил не смотреть» — разные ответы, и второй тоже результат.
  if (official.blockedByRobots.length > 0) {
    const blocked = official.blockedByRobots.map(shortPath).join(", ");
    warnings.push(`Обход не заходил в разделы, закрытые robots.txt сайта: ${blocked}`);
  }
  if (official.skippedForTime > 0) {
    warnings.push(
      `Обход сайта прерван по времени: ${official.skippedForTime} раздел(ов) не прочитано — сайт отвечал слишком медленно для 30-секундного бюджета`,
    );
  }
  if (official.robotsNote) warnings.push(`Официальный сайт: ${official.robotsNote}`);
  let officialHost: string | null = null;
  try {
    officialHost = university.officialWebsite ? new URL(university.officialWebsite).hostname.replace(/^www\./, "") : null;
  } catch {
    officialHost = null;
  }
  const officialRaw: RawPhoto[] = official.candidates.map((c, i) => ({
    id: `official/${i}/${c.url}`,
    source: "official_site",
    publishedAt: c.publishedAt,
    imageUrl: c.url,
    sourceUrl: c.pageUrl,
    attribution: [{ name: officialHost ?? "официальный сайт", uri: university.officialWebsite }],
    license: null,
    category: "campus",
    trust: "verified",
    evidence: {
      anchorSource: anchor?.source ?? "none",
      placeId: null,
      placeName: officialHost ?? "официальный сайт",
      address: null,
      distanceM: null,
      queryIntent: null,
      vision: null,
      reasons: [
        `Опубликовано на официальном сайте вуза: ${pagePathOf(c.pageUrl, officialHost)}`,
        ...(c.publishedAt
          ? [`Страница опубликована ${new Date(c.publishedAt).toLocaleDateString("ru-RU")} — снимок появился на сайте не позже этой даты; когда сделан кадр, страница не сообщает`]
          : []),
        university.resolvedVia === "places"
          ? "Адрес сайта взят из карточки места в Google Places"
          : "Адрес сайта взят из Wikidata (свойство P856)",
        "Географическая проверка не применяется: провенанс доказан доменом, а не координатами",
      ],
    },
    widthPx: 0,
    heightPx: 0,
  }));
  onProgress({ stage: "official", found: officialRaw.length, error: official.error });

  const commonsFiles = mode === "quick" ? await withDeadline(commonsPromise, Math.min(1200, timeLeft()), []) : await commonsPromise;
  const commonsRaw: RawPhoto[] = commonsFiles.map((file) => ({
    id: `commons/${file.title}`,
    source: "wikimedia_commons",
    publishedAt: null,
    imageUrl: file.imageUrl,
    sourceUrl: file.sourceUrl,
    attribution: [{ name: file.author, uri: file.sourceUrl }],
    license: { name: file.licenseName, url: file.licenseUrl },
    category: "campus",
    trust: "unverified",
    evidence: {
      anchorSource: anchor?.source ?? "none",
      placeId: null,
      placeName: file.title.replace(/^File:/, ""),
      address: null,
      distanceM: null,
      queryIntent: null,
      vision: null,
      reasons: [
        `Файл найден в категории Wikimedia Commons, связанной с карточкой вуза ${university.qid}, или в её тематическом подразделе: ${file.categoryUrl}`,
        `У файла указана лицензия ${file.licenseName}; она разрешает использование на своих условиях, но не подтверждает, что снимок показывает этот вуз`,
        "Координаты съёмки не подтверждены; принадлежность изображённого университету не доказана",
      ],
    },
    widthPx: file.width,
    heightPx: file.height,
  }));

  // 4. Загрузка всех картинок. Официальные — с проверкой размера (на сайтах много иконок).
  const allRaw = [...officialRaw, ...placesRaw, ...commonsRaw];
  onProgress({ stage: "download", total: allRaw.length });

  const completedDownloads: Loaded[] = [];
  const downloadWork = mapWithLimit(allRaw, DOWNLOAD_CONCURRENCY, async (raw): Promise<Loaded | null> => {
      const img = await loadImage(raw.imageUrl, USER_AGENT);
      if (!img) {
        removed.failedDownload++;
        return null;
      }
      if (raw.source === "official_site" && (img.width < MIN_WIDTH_PX || img.height < MIN_HEIGHT_PX)) {
        removed.tooSmall++;
        return null;
      }
      // Резкость меряем до всего остального: размытый кадр не станет полезнее ни от
      // проверки расстояния, ни от вердикта модели, а место в профиле займёт.
      if ((await sharpness(img.bytes)) < SHARPNESS_MIN) {
        removed.blurry++;
        return null;
      }
      const hash = await dHash(img.bytes);
      if (raw.source === "official_site") {
        raw.widthPx = img.width;
        raw.heightPx = img.height;
      }
      const result = { raw, img, hash };
      completedDownloads.push(result);
      return result;
  });
  if (mode === "quick") await withDeadline(downloadWork, Math.max(0, timeLeft() - 9000), []);
  else await downloadWork;
  let loaded = completedDownloads.slice();
  // Массовый отказ загрузок — это не «фотографий нет», а «источник перестал отвечать».
  // Разные вещи, и путать их в профиле нельзя.
  const officialTried = allRaw.filter((r) => r.source === "official_site").length;
  const officialLoadedCount = loaded.filter((l) => l.raw.source === "official_site").length;
  if (officialTried >= 5 && officialLoadedCount * 2 < officialTried) {
    warnings.push(
      `Сайт вуза отдал ${officialLoadedCount} изображений из ${officialTried}: остальные не загрузились. Похоже на ограничение по частоте запросов на стороне сайта, а не на отсутствие фотографий`,
    );
  }
  // Снимков с одного сайта берём не больше лимита. Остаток раньше просто исчезал:
  // в статистике его не было ни в одной строке, и «осталось N» на экране выглядело
  // как результат дедупликации, хотя дело было в обрезке.
  const officialLoaded = loaded.filter((l) => l.raw.source === "official_site");
  // Свежее вперёд. Абитуриенту важно, каким вуз выглядит сейчас, а не в позапрошлом
  // десятилетии. Сортировка стабильная, поэтому внутри одного возраста сохраняется
  // прежний порядок — по одному снимку с каждой прочитанной страницы.
  officialLoaded.sort((a, b) => freshnessRank(a.raw.publishedAt) - freshnessRank(b.raw.publishedAt));
  removed.overSiteLimit = Math.max(0, officialLoaded.length - limits.maxOfficialPhotos);
  loaded = [
    ...officialLoaded.slice(0, limits.maxOfficialPhotos),
    ...loaded.filter((l) => l.raw.source !== "official_site"),
  ];
  onProgress({
    stage: "prefilter",
    kept: loaded.length,
    failedDownload: removed.failedDownload,
    tooSmall: removed.tooSmall,
    blurry: removed.blurry,
    overSiteLimit: removed.overSiteLimit,
  });

  // 5. Дедупликация: приоритет официальным, затем по тиру. Первый в очереди остаётся.
  loaded.sort(
    (a, b) =>
      SOURCE_RANK[a.raw.source] - SOURCE_RANK[b.raw.source] ||
      TIER_RANK[a.raw.trust] - TIER_RANK[b.raw.trust],
  );
  const kept: Loaded[] = [];
  for (const cand of loaded) {
    const dup = kept.find((k) => hamming(k.hash, cand.hash) <= DUPLICATE_HAMMING);
    if (dup) {
      removed.duplicates++;
      continue;
    }
    kept.push(cand);
  }
  onProgress({ stage: "dedupe", kept: kept.length, duplicates: removed.duplicates });

  // 6. Vision: что изображено. Батчи по BATCH_SIZE, ошибки не роняют профиль.
  const visionInputs: VisionInput[] = kept.map((k) => ({ id: k.raw.id, bytes: k.img.bytes, mime: k.img.mime }));
  onProgress({ stage: "vision", batches: mode === "quick" ? 0 : Math.ceil(visionInputs.length / BATCH_SIZE) });
  let verdicts = new Map<string, VisionVerdict>();
  let visionErrors: string[] = [];
  if (process.env.GEMINI_API_KEY) {
    const context = { universityName: university.label, city: university.city };
    if (mode === "quick") {
      // One candidate per still-empty category per round. A vision verdict may move a
      // photo to another category; only actual verdicts count toward coverage.
      const attempted = new Set<string>();
      const covered = new Set<Category>();
      const queues = new Map<Category, Loaded[]>(QUICK_CATEGORIES.map((c) => [c, kept.filter((k) => k.raw.category === c)]));
      const officialExtras = kept.filter((k) => k.raw.source === "official_site").slice(1, 5);
      for (let round = 0; round < 3 && timeLeft() > 2500; round++) {
        const selection: Loaded[] = [];
        for (const category of QUICK_CATEGORIES) {
          if (covered.has(category)) continue;
          const candidate = queues.get(category)?.find((k) => !attempted.has(k.raw.id));
          if (candidate) selection.push(candidate);
        }
        // Official pages have no reliable category metadata. Inspect a few as
        // wildcards while some categories remain empty.
        if (round > 0 && covered.size < QUICK_CATEGORIES.length) {
          const extra = officialExtras.find((k) => !attempted.has(k.raw.id));
          if (extra && !selection.includes(extra)) selection.push(extra);
        }
        if (!selection.length) break;
        selection.forEach((k) => attempted.add(k.raw.id));
        const inputs = selection.map((k) => ({ id: k.raw.id, bytes: k.img.bytes, mime: k.img.mime }));
        const aiBudgetMs = Math.max(0, timeLeft() - 500);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), aiBudgetMs);
        const result = await classifyImages(inputs, context, { concurrency: 2, retry: false, signal: controller.signal });
        clearTimeout(timeout);
        result.verdicts.forEach((v, id) => {
          verdicts.set(id, v);
          if (!v.relevant || v.category === "other") return;
          const candidate = selection.find((k) => k.raw.id === id);
          if (!candidate) return;
          const raw = candidate.raw;
          const category = categoryFromEvidence(raw, v);
          if (category === "other" || !QUICK_CATEGORIES.includes(category)) return;
          const trust = v.confidence === "low" ? downgrade(raw.trust) : raw.trust;
          if (trust !== "unverified") covered.add(category);
          const reasons = [...raw.evidence.reasons,
            `Содержимое проверено (Gemini, уверенность ${v.confidence}): ${v.caption}`,
            ...(category !== v.category ? [`На фото виден фасад; тип здания подтверждён названием места «${raw.evidence.placeName}»`] : []),
            ...(category !== raw.category ? [`Категория по содержимому: «${category}» (по запросу было «${raw.category}»)`] : []),
          ];
          onProgress({ stage: "photo", photo: {
            id: raw.id, source: raw.source, imageUrl: raw.imageUrl,
            sourceUrl: raw.sourceUrl, attribution: raw.attribution, license: raw.license,
            publishedAt: raw.publishedAt, retrievedAt: new Date().toISOString(),
            category, trust,
            evidence: { ...raw.evidence, vision: v, reasons },
            widthPx: raw.widthPx || candidate.img.width,
            heightPx: raw.heightPx || candidate.img.height,
            hash: candidate.hash,
          } });
        });
        visionErrors.push(...result.errors);
      }
    } else {
      const r = await classifyImages(visionInputs, context);
      verdicts = r.verdicts;
      visionErrors = r.errors;
    }
  } else {
    warnings.push("Ключ GEMINI_API_KEY не задан — содержимое снимков не проверялось, доверие ограничено уровнем «вероятно»");
  }
  if (visionErrors.length > 0) {
    warnings.push(`Vision: ${visionErrors.length} батч(ей) не обработано (${visionErrors[0]})`);
  }
  const visionAvailable = verdicts.size > 0;

  // 7. Применяем вердикты: отсев нерелевантных, категория по содержимому.
  const photos: PhotoItem[] = [];
  for (const k of kept) {
    const raw = k.raw;
    const v = verdicts.get(raw.id) ?? null;
    // Quick Board never shows a photo whose content check did not finish.
    if (mode === "quick" && !v) continue;
    // Связанная категория Commons означает «файл имеет отношение к вузу», а не
    // «на нём кампус». Без проверки содержимого такой снимок не показываем.
    if (raw.source === "wikimedia_commons" && !v) {
      removed.irrelevant++;
      continue;
    }
    let category = raw.category;
    let trust = raw.trust;
    const reasons = [...raw.evidence.reasons];

    if (v) {
      if (!v.relevant || v.category === "other") {
        removed.irrelevant++;
        continue;
      }
      const evidenceCategory = categoryFromEvidence(raw, v);
      if (raw.category === "citywide" && v.category === "city") {
        // Модель не различает «рядом с кампусом» и «город»: и там, и там улица.
        // Снимок пришёл из городского запроса, и модель подтвердила, что это город —
        // значит, категорию определяет география, а не содержимое.
        reasons.push("Содержимое подтверждено как городская сцена; отнесено к городу, а не к окружению кампуса, по запросу и расстоянию");
      } else if (evidenceCategory !== raw.category) {
        reasons.push(`Категория по содержимому: «${evidenceCategory}» (по запросу было «${raw.category}»)`);
        category = evidenceCategory as Category;
      } else if (evidenceCategory === v.category) {
        reasons.push(`Категория по содержимому совпала с запросом: «${category}»`);
      }
      if (evidenceCategory !== v.category) reasons.push(`На фото виден фасад; тип здания подтверждён названием места «${raw.evidence.placeName}»`);
      reasons.push(`Содержимое проверено (Gemini, уверенность ${v.confidence}): ${v.caption}`);
      if (v.confidence === "low") {
        reasons.push("Низкая уверенность модели в содержимом — доверие понижено на один уровень");
        trust = downgrade(trust);
      }
    } else {
      reasons.push("Содержимое снимка не проверено: vision недоступен — доверие ограничено уровнем «вероятно»");
      if (trust === "verified") trust = "probable";
    }

    if (mode === "quick" && !QUICK_CATEGORIES.includes(category)) continue;

    // Commons не даёт проверенных координат съёмки: городская сцена из связанной
    // категории не может автоматически стать «вокруг кампуса».
    if (raw.source === "wikimedia_commons" && (category === "city" || category === "citywide")) {
      removed.irrelevant++;
      continue;
    }

    // Город показывают общим видом. Крупный план памятника или вывески — это не
    // «фотография города», а фотография предмета, который в нём стоит. Проверка
    // содержательная: модель отвечает, широкий это кадр или крупный план.
    if (category === "citywide") {
      if (v && !v.wideView) {
        removed.cityNotWide++;
        continue;
      }
      if (v) reasons.push("Кадр определён как общий вид: панорама, перспектива улицы или силуэт города");
      else reasons.push("Общий это вид или крупный план — не проверено: vision недоступен");
    }

    // «Вокруг кампуса» — это пешая доступность. Дальше порога снимок описывает другой
    // район города; порог «вероятно» (6 км) для окружения слишком широкий, и через него
    // в профиль попадали городские достопримечательности. Снимки без измеренного
    // расстояния (с сайта вуза) под проверку не подпадают: их провенанс — домен.
    if (category === "city" && raw.evidence.distanceM !== null && raw.evidence.distanceM > NEIGHBORHOOD_MAX_M) {
      removed.farFromCampus++;
      continue;
    }

    photos.push({
      id: raw.id,
      source: raw.source,
      imageUrl: raw.imageUrl,
      sourceUrl: raw.sourceUrl,
      attribution: raw.attribution,
      license: raw.license,
      publishedAt: raw.publishedAt,
      retrievedAt: new Date().toISOString(),
      category,
      trust,
      evidence: { ...raw.evidence, vision: v, reasons },
      widthPx: raw.widthPx || k.img.width,
      heightPx: raw.heightPx || k.img.height,
      hash: k.hash,
    });
  }

  // 8. Окружение ограничиваем и ставим в конец: это контекст, а не объекты вуза.
  // Из снимков окружения оставляем в первую очередь те, что пришли из запросов
  // про окружение: они действительно про район, а не переразмечены из места вуза.
  const cityPhotos = photos
    .filter((p) => p.category === "city")
    .sort((a, b) => Number(b.evidence.queryIntent === "city") - Number(a.evidence.queryIntent === "city"))
    .slice(0, limits.maxCityPhotos);
  // Город — отдельная категория и отдельный лимит: кейс требует показать город,
  // но профиль остаётся профилем вуза, а не фотоальбомом города.
  // При равном уровне доверия вперёд идёт более широкий кадр: панорама города
  // рассказывает о нём больше, чем квадратный снимок той же площади.
  const citywidePhotos = photos
    .filter((p) => p.category === "citywide")
    .sort(
      (a, b) =>
        TIER_RANK[a.trust] - TIER_RANK[b.trust] ||
        b.widthPx / Math.max(1, b.heightPx) - a.widthPx / Math.max(1, a.heightPx),
    )
    .slice(0, limits.maxCitywidePhotos);
  removed.overCategoryLimit += Math.max(0, photos.filter((p) => p.category === "citywide").length - citywidePhotos.length);
  removed.overCategoryLimit += Math.max(0, photos.filter((p) => p.category === "city").length - cityPhotos.length);

  // Потолок на остальные категории. Внутри категории сначала оставляем то, что лучше
  // подтверждено, а при равном тире — снимки с разных мест: одно здание, снятое с
  // четырёх сторон, категорию не наполняет. Отброшенное считается отдельной строкой,
  // а не исчезает молча.
  const rest: PhotoItem[] = [];
  for (const category of ALL_CATEGORIES) {
    if (category === "city" || category === "citywide") continue;
    const inCat = photos
      .filter((p) => p.category === category)
      .sort((a, b) => TIER_RANK[a.trust] - TIER_RANK[b.trust] || SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);
    const picked: PhotoItem[] = [];
    const usedPlaces = new Set<string>();
    // Первый проход — по одному снимку с места, второй добирает остаток по тиру.
    for (const p of inCat) {
      const placeKey = p.evidence.placeId ?? `site:${p.evidence.placeName}`;
      if (usedPlaces.has(placeKey) || picked.length >= limits.maxPerCategory) continue;
      usedPlaces.add(placeKey);
      picked.push(p);
    }
    for (const p of inCat) {
      if (picked.length >= limits.maxPerCategory) break;
      if (!picked.includes(p)) picked.push(p);
    }
    removed.overCategoryLimit += inCat.length - picked.length;
    rest.push(...picked);
  }

  const ordered = [...rest, ...cityPhotos, ...citywidePhotos].sort(
    (a, b) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] || TIER_RANK[a.trust] - TIER_RANK[b.trust],
  );
  photos.length = 0;
  photos.push(...ordered);

  // 9. План мест: только те, что реально дали снимки, и только с координатами.
  // Карта рисуется по этим же измеренным расстояниям — это визуализация проверки,
  // а не отдельная картинка «для красоты».
  const photosByPlace = new Map<string, { count: number; category: Category }>();
  for (const p of photos) {
    if (!p.evidence.placeId) continue;
    const prev = photosByPlace.get(p.evidence.placeId);
    photosByPlace.set(p.evidence.placeId, { count: (prev?.count ?? 0) + 1, category: prev?.category ?? p.category });
  }
  const mapPoints: MapPoint[] = anchor
    ? jobs
        .filter((j) => j.place.location && (photosByPlace.get(j.place.id)?.count ?? 0) > 0)
        .map((j) => ({
          placeId: j.place.id,
          name: j.place.displayName?.text ?? j.place.id,
          lat: j.place.location!.latitude,
          lon: j.place.location!.longitude,
          distanceM: haversineM(anchor.lat, anchor.lon, j.place.location!.latitude, j.place.location!.longitude),
          category: photosByPlace.get(j.place.id)!.category,
          photos: photosByPlace.get(j.place.id)!.count,
        }))
    : [];

  // 10. Итоги.
  const [cityCenter, reviews, deepContext] = await Promise.all([cityCenterPromise, reviewsPromise, deepContextPromise]);
  // Возраст отзывов — то немногое, что мы знаем точно. Если самый свежий отзыв
  // многолетней давности, это характеристика источника, и молчать о ней нельзя.
  const newestReview = reviews
    .map((r) => (r.publishedAt ? Date.parse(r.publishedAt) : NaN))
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a)[0];
  if (newestReview && Date.now() - newestReview > FRESH_MS) {
    warnings.push(
      `Свежих отзывов нет: самый новый из доступных — от ${new Date(newestReview).toLocaleDateString("ru-RU")}`,
    );
  }
  // Даты публикации есть только у снимков со страниц, которые их сообщают.
  const datedPhotos = photos.filter((p) => p.publishedAt).length;
  if (photos.length > 0 && datedPhotos === 0) {
    warnings.push("Ни один источник не сообщил дату публикации снимков — показана только дата получения");
  }
  const coverage = computeCoverage(photos);
  const description = describeCampus(university, anchor, photos, coverage, cityCenter);
  if (photos.length === 0) warnings.push("Ни одной фотографии не прошло проверку — профиль пуст");
  onProgress({ stage: "done" });

  return {
    mode,
    deepContext,
    university,
    anchor,
    cityCenter,
    mapPoints,
    reviews,
    reviewsPlaceName: campusPlace?.displayName?.text ?? null,
    photos,
    coverage,
    description,
    removed,
    sources: {
      official: photos.filter((p) => p.source === "official_site").length,
      visitors: photos.filter((p) => p.source === "google_places").length,
      commons: photos.filter((p) => p.source === "wikimedia_commons").length,
    },
    visionAvailable,
    warnings,
    timingMs: Date.now() - started,
  };
}
