// lib/profile.ts
// Оркестратор блока A: карточка вуза → параллельные запросы к Places →
// нормализация фото → тир доверия по расстоянию → покрытие по категориям.
//
// В блоке A НЕТ: дедупликации по pHash, vision-категоризации, стриминга, кеша,
// YouTube, Mapillary. Всё это — блок B. Здесь категория = поисковый запрос,
// который нашёл место, а доверие = расстояние до якорных координат.

import { haversineM } from "./geo";
import { getPhotoUri, searchText, type Place } from "./places";
import type {
  Category,
  CategoryCoverage,
  Evidence,
  PhotoItem,
  Profile,
  TrustTier,
  UniversityCandidate,
} from "./types";

// ---- Настраиваемые пороги. Показывать в README и в карточке провенанса. ----

/** Место в этом радиусе от якоря считается подтверждённым объектом кампуса. */
const VERIFIED_RADIUS_M = 1500;
/** Место в этом радиусе — вероятно относится к вузу (второй кампус, общежитие в городе). */
const PROBABLE_RADIUS_M = 6000;
/** Для категории "город": место в этом радиусе — тот же город. */
const CITY_RADIUS_M = 30000;
/** Радиус locationBias для Places при поиске объектов вуза. */
const SEARCH_BIAS_RADIUS_M = 5000;

const PHOTOS_PER_PLACE = 5;
const MAX_PHOTOS_TOTAL = 40;

// ---- План запросов. Порядок важен: первый запрос задаёт якорь и категорию "campus". ----

type QueryPlanItem = {
  category: Category;
  build: (u: UniversityCandidate) => string | null;
  pageSize: number;
};

const QUERY_PLAN: QueryPlanItem[] = [
  { category: "campus", build: (u) => u.label, pageSize: 1 },
  { category: "dorm", build: (u) => `${u.label} общежитие`, pageSize: 2 },
  { category: "library", build: (u) => `${u.label} библиотека`, pageSize: 2 },
  { category: "lab", build: (u) => `${u.label} лаборатория`, pageSize: 2 },
  { category: "sport", build: (u) => `${u.label} спортивный комплекс`, pageSize: 2 },
  { category: "city", build: (u) => u.city, pageSize: 1 },
];

const ALL_CATEGORIES: Category[] = ["campus", "dorm", "library", "lab", "sport", "life", "city"];

// ---- Доверие ----

type Anchor = { lat: number; lon: number; source: "wikidata" | "places" };

function downgrade(t: TrustTier): TrustTier {
  if (t === "verified") return "probable";
  return "unverified";
}

function assessTrust(
  place: Place,
  category: Category,
  anchor: Anchor | null,
  anchorPlaceId: string | null,
): { trust: TrustTier; distanceM: number | null; reasons: string[] } {
  const reasons: string[] = [`Место найдено через Google Places (place_id ${place.id})`];

  if (anchorPlaceId && place.id === anchorPlaceId) {
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

  const distanceM = haversineM(
    anchor.lat,
    anchor.lon,
    place.location.latitude,
    place.location.longitude,
  );

  let trust: TrustTier;
  if (category === "city") {
    trust = distanceM <= CITY_RADIUS_M ? "verified" : "unverified";
    reasons.push(`Расстояние до кампуса ${distanceM} м (порог для города ${CITY_RADIUS_M} м)`);
  } else if (distanceM <= VERIFIED_RADIUS_M) {
    trust = "verified";
    reasons.push(`Расстояние до кампуса ${distanceM} м (порог ${VERIFIED_RADIUS_M} м)`);
  } else if (distanceM <= PROBABLE_RADIUS_M) {
    trust = "probable";
    reasons.push(`Расстояние до кампуса ${distanceM} м — дальше ${VERIFIED_RADIUS_M} м, но в пределах ${PROBABLE_RADIUS_M} м`);
  } else {
    trust = "unverified";
    reasons.push(`Расстояние до кампуса ${distanceM} м — дальше порога ${PROBABLE_RADIUS_M} м`);
  }

  reasons.push(
    anchor.source === "wikidata"
      ? "Якорные координаты: Wikidata (независимый источник)"
      : "Координат в Wikidata нет — якорь взят из Google Places, доверие понижено на один уровень",
  );
  if (anchor.source === "places") trust = downgrade(trust);

  reasons.push("Проверено место, а не содержимое снимка: фотография загружена пользователем на страницу этого места в Google Places");
  return { trust, distanceM, reasons };
}

// ---- Нормализация фото ----

async function placeToPhotos(
  place: Place,
  category: Category,
  anchor: Anchor | null,
  anchorPlaceId: string | null,
): Promise<PhotoItem[]> {
  const photos = (place.photos ?? []).slice(0, PHOTOS_PER_PLACE);
  if (photos.length === 0) return [];

  const { trust, distanceM, reasons } = assessTrust(place, category, anchor, anchorPlaceId);
  const placeName = place.displayName?.text ?? place.id;

  const uris = await Promise.all(photos.map((p) => getPhotoUri(p.name)));

  const items: PhotoItem[] = [];
  photos.forEach((p, i) => {
    const imageUrl = uris[i];
    if (!imageUrl) return;

    const evidence: Evidence = {
      anchorSource: anchor?.source ?? "none",
      placeId: place.id,
      placeName,
      distanceM,
      queryIntent: category,
      reasons,
    };

    items.push({
      id: p.name,
      source: "google_places",
      imageUrl,
      sourceUrl: place.googleMapsUri ?? null,
      attribution: (p.authorAttributions ?? []).map((a) => ({
        name: a.displayName,
        uri: a.uri ?? null,
      })),
      publishedAt: null,
      category,
      trust,
      evidence,
      widthPx: p.widthPx,
      heightPx: p.heightPx,
    });
  });

  return items;
}

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

export async function buildProfile(university: UniversityCandidate): Promise<Profile> {
  const started = Date.now();
  const warnings: string[] = [];

  // 1. Главный запрос — отдельно, потому что от него может зависеть якорь.
  const [campusPlan, ...restPlan] = QUERY_PLAN;
  const campusQuery = campusPlan.build(university);
  const wikidataBias =
    university.lat !== null && university.lon !== null
      ? { lat: university.lat, lon: university.lon, radiusM: SEARCH_BIAS_RADIUS_M }
      : undefined;

  let campusPlaces: Place[] = [];
  try {
    campusPlaces = campusQuery
      ? await searchText(campusQuery, { bias: wikidataBias, pageSize: campusPlan.pageSize })
      : [];
  } catch (e) {
    warnings.push(`Places: основной запрос не выполнен (${(e as Error).message})`);
  }
  const campusPlace = campusPlaces[0];

  // 2. Якорь: Wikidata приоритетнее; Places — запасной вариант с понижением доверия.
  let anchor: Anchor | null = null;
  if (university.lat !== null && university.lon !== null) {
    anchor = { lat: university.lat, lon: university.lon, source: "wikidata" };
  } else if (campusPlace?.location) {
    anchor = {
      lat: campusPlace.location.latitude,
      lon: campusPlace.location.longitude,
      source: "places",
    };
    warnings.push("В Wikidata нет координат кампуса — якорь взят из Google Places, все тиры доверия понижены");
  } else {
    warnings.push("Координаты кампуса не найдены ни в Wikidata, ни в Places — проверка расстояния невозможна");
  }

  const anchorPlaceId = anchor?.source === "places" ? (campusPlace?.id ?? null) : null;

  // 3. Остальные запросы — параллельно, с якорем как locationBias.
  const bias = anchor ? { lat: anchor.lat, lon: anchor.lon, radiusM: SEARCH_BIAS_RADIUS_M } : undefined;

  const restResults = await Promise.all(
    restPlan.map(async (item) => {
      const q = item.build(university);
      if (!q) {
        if (item.category === "city") warnings.push("В Wikidata нет города (P131) — запрос по городу пропущен");
        return { category: item.category, places: [] as Place[] };
      }
      try {
        const places = await searchText(q, { bias, pageSize: item.pageSize });
        return { category: item.category, places };
      } catch (e) {
        warnings.push(`Places: запрос «${q}» не выполнен (${(e as Error).message})`);
        return { category: item.category, places: [] as Place[] };
      }
    }),
  );

  // 4. Одно место — одна категория. Первое вхождение побеждает (campus идёт первым).
  const seen = new Set<string>();
  const jobs: Array<{ place: Place; category: Category }> = [];

  if (campusPlace && !seen.has(campusPlace.id)) {
    seen.add(campusPlace.id);
    jobs.push({ place: campusPlace, category: "campus" });
  }
  for (const r of restResults) {
    for (const place of r.places) {
      if (seen.has(place.id)) continue;
      seen.add(place.id);
      jobs.push({ place, category: r.category });
    }
  }

  // 5. Фото — параллельно по всем местам.
  const photoGroups = await Promise.all(
    jobs.map((j) => placeToPhotos(j.place, j.category, anchor, anchorPlaceId)),
  );
  const photos = photoGroups.flat().slice(0, MAX_PHOTOS_TOTAL);

  // 6. Честные предупреждения о том, чего в блоке A нет по построению.
  warnings.push("Категория «Студенческая жизнь» в блоке A не заполняется: её источник (YouTube) подключается в блоке B");
  if (photos.length === 0) {
    warnings.push("Ни одной фотографии не найдено — профиль пуст");
  }

  return {
    university,
    anchor,
    photos,
    coverage: computeCoverage(photos),
    warnings,
    timingMs: Date.now() - started,
  };
}
