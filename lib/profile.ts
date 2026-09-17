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
import { haversineM } from "./geo";
import { dHash, hamming, loadImage, type LoadedImage } from "./image";
import { collectOfficialImages } from "./official";
import { getPhotoUri, searchText, type Place } from "./places";
import { findInTwoGis } from "./twogis";
import { classifyImages, type VisionInput } from "./vision";
import {
  ALL_CATEGORIES,
  type Anchor,
  type Category,
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
const CITY_RADIUS_M = 30000;
const SEARCH_BIAS_RADIUS_M = 5000;
/** Точки Places и 2ГИС ближе этого порога считаются одним и тем же местом. */
const CORROBORATION_RADIUS_M = 500;

const PHOTOS_PER_PLACE = 5;
const MAX_PLACES_PHOTOS = 40;
const MAX_OFFICIAL_PHOTOS = 10;
/** Город — контекст, а не кампус: держим его небольшим, чтобы он не забивал профиль. */
const MAX_CITY_PHOTOS = 3;
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
};

const QUERY_PLAN: QueryPlanItem[] = [
  { category: "campus", build: (u) => u.label, pageSize: 1 },
  { category: "dorm", build: (u) => `${u.label} общежитие`, pageSize: 2 },
  { category: "library", build: (u) => `${u.label} библиотека`, pageSize: 2 },
  { category: "lab", build: (u) => `${u.label} лаборатория`, pageSize: 2 },
  { category: "sport", build: (u) => `${u.label} спортивный комплекс`, pageSize: 2 },
  { category: "city", build: (u) => u.city, pageSize: 1 },
];

// ---- Промежуточное представление снимка до загрузки ----

type RawPhoto = {
  id: string;
  source: PhotoSource;
  imageUrl: string;
  sourceUrl: string | null;
  attribution: PhotoItem["attribution"];
  category: Category;
  trust: TrustTier;
  evidence: Evidence;
  widthPx: number;
  heightPx: number;
};

type Loaded = { raw: RawPhoto; img: LoadedImage; hash: string };

const TIER_RANK: Record<TrustTier, number> = { verified: 0, probable: 1, unverified: 2 };
const SOURCE_RANK: Record<PhotoSource, number> = { official_site: 0, google_places: 1 };
/** Порядок вывода: объекты вуза впереди, город последним. */
const CATEGORY_RANK: Record<Category, number> = {
  campus: 0, dorm: 1, library: 2, lab: 3, sport: 4, life: 5, city: 6,
};

// ---- Доверие по расстоянию ----

function downgrade(t: TrustTier): TrustTier {
  return t === "verified" ? "probable" : "unverified";
}

function assessTrust(
  place: Place,
  category: Category,
  anchor: Anchor | null,
  anchorPlaceId: string | null,
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

  switch (anchor.source) {
    case "wikidata":
      reasons.push("Якорные координаты: Wikidata (независимый источник)");
      break;
    case "places+2gis":
      reasons.push("Координат в Wikidata нет; якорь из Google Places подтверждён 2ГИС (второй независимый провайдер)");
      break;
    case "places":
      reasons.push("Координат в Wikidata нет — якорь взят из Google Places без подтверждения, доверие понижено на один уровень");
      trust = downgrade(trust);
      break;
  }

  return { trust, distanceM, reasons };
}

// ---- Сбор кандидатов из Places ----

async function placeToRaw(
  place: Place,
  category: Category,
  anchor: Anchor | null,
  anchorPlaceId: string | null,
): Promise<RawPhoto[]> {
  const photos = (place.photos ?? []).slice(0, PHOTOS_PER_PLACE);
  if (photos.length === 0) return [];

  const { trust, distanceM, reasons } = assessTrust(place, category, anchor, anchorPlaceId);
  const placeName = place.displayName?.text ?? place.id;
  const uris = await Promise.all(photos.map((p) => getPhotoUri(p.name)));

  const out: RawPhoto[] = [];
  photos.forEach((p, i) => {
    const imageUrl = uris[i];
    if (!imageUrl) return;
    out.push({
      id: p.name,
      source: "google_places",
      imageUrl,
      sourceUrl: place.googleMapsUri ?? null,
      attribution: (p.authorAttributions ?? []).map((a) => ({ name: a.displayName, uri: a.uri ?? null })),
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

export async function buildProfile(
  university: UniversityCandidate,
  onProgress: (e: ProgressEvent) => void = () => {},
): Promise<Profile> {
  const started = Date.now();
  const warnings: string[] = [];
  const removed: RemovalStats = { duplicates: 0, irrelevant: 0, tooSmall: 0, failedDownload: 0 };

  // 1. Главный запрос к Places — от него может зависеть якорь.
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

  // 2. Якорь: Wikidata → Places+2ГИС → Places → нет.
  let anchor: Anchor | null = null;
  if (university.lat !== null && university.lon !== null) {
    anchor = { lat: university.lat, lon: university.lon, source: "wikidata" };
  } else if (campusPlace?.location) {
    const placesPoint = { lat: campusPlace.location.latitude, lon: campusPlace.location.longitude };
    const twoGis = await findInTwoGis(university.label, placesPoint);
    if (twoGis) {
      const gap = haversineM(placesPoint.lat, placesPoint.lon, twoGis.lat, twoGis.lon);
      if (gap <= CORROBORATION_RADIUS_M) {
        anchor = { ...placesPoint, source: "places+2gis" };
        warnings.push(`В Wikidata нет координат кампуса; Google Places и 2ГИС сошлись на расположении с расхождением ${gap} м${twoGis.address ? ` (2ГИС: ${twoGis.address})` : ""}`);
      } else {
        anchor = { ...placesPoint, source: "places" };
        warnings.push(`В Wikidata нет координат кампуса; 2ГИС указывает точку в ${gap} м от Google Places — подтверждения нет, доверие понижено`);
      }
    } else {
      anchor = { ...placesPoint, source: "places" };
      warnings.push(
        process.env.TWOGIS_API_KEY
          ? "В Wikidata нет координат кампуса; 2ГИС не нашёл организацию — якорь только из Google Places, доверие понижено"
          : "В Wikidata нет координат кампуса — якорь взят из Google Places, доверие понижено (ключ 2ГИС не задан)",
      );
    }
  } else {
    warnings.push("Координаты кампуса не найдены ни в Wikidata, ни в Places — проверка расстояния невозможна");
  }
  onProgress({ stage: "anchor", source: anchor?.source ?? "none" });

  const anchorPlaceId = anchor?.source !== "wikidata" && campusPlace ? campusPlace.id : null;
  const bias = anchor ? { lat: anchor.lat, lon: anchor.lon, radiusM: SEARCH_BIAS_RADIUS_M } : undefined;

  // 3. Остальные запросы к Places и главная страница сайта — параллельно.
  const [restResults, official] = await Promise.all([
    Promise.all(
      restPlan.map(async (item) => {
        const q = item.build(university);
        if (!q) {
          if (item.category === "city") warnings.push("В Wikidata нет города (P131) — запрос по городу пропущен");
          return { category: item.category, places: [] as Place[] };
        }
        try {
          return { category: item.category, places: await searchText(q, { bias, pageSize: item.pageSize }) };
        } catch (e) {
          warnings.push(`Places: запрос «${q}» не выполнен (${(e as Error).message})`);
          return { category: item.category, places: [] as Place[] };
        }
      }),
    ),
    university.officialWebsite
      ? collectOfficialImages(university.officialWebsite, USER_AGENT)
      : Promise.resolve({ candidates: [], error: "в Wikidata не указан официальный сайт (P856)" }),
  ]);

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

  const placesRaw = (await Promise.all(jobs.map((j) => placeToRaw(j.place, j.category, anchor, anchorPlaceId))))
    .flat()
    .slice(0, MAX_PLACES_PHOTOS);
  onProgress({ stage: "places", found: placesRaw.length });

  if (official.error) warnings.push(`Официальный сайт: ${official.error}`);
  let officialHost: string | null = null;
  try {
    officialHost = university.officialWebsite ? new URL(university.officialWebsite).hostname.replace(/^www\./, "") : null;
  } catch {
    officialHost = null;
  }
  const officialRaw: RawPhoto[] = official.candidates.map((c, i) => ({
    id: `official/${i}/${c.url}`,
    source: "official_site",
    imageUrl: c.url,
    sourceUrl: c.pageUrl,
    attribution: [{ name: officialHost ?? "официальный сайт", uri: university.officialWebsite }],
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
        `Опубликовано на главной странице официального сайта ${officialHost ?? ""} (домен указан в Wikidata, P856)`,
        "Географическая проверка не применяется: провенанс доказан доменом, а не координатами",
      ],
    },
    widthPx: 0,
    heightPx: 0,
  }));
  onProgress({ stage: "official", found: officialRaw.length, error: official.error });

  // 4. Загрузка всех картинок. Официальные — с проверкой размера (на сайтах много иконок).
  const allRaw = [...officialRaw, ...placesRaw];
  onProgress({ stage: "download", total: allRaw.length });

  const loadedOrNull = await Promise.all(
    allRaw.map(async (raw): Promise<Loaded | null> => {
      const img = await loadImage(raw.imageUrl, USER_AGENT);
      if (!img) {
        removed.failedDownload++;
        return null;
      }
      if (raw.source === "official_site" && (img.width < MIN_WIDTH_PX || img.height < MIN_HEIGHT_PX)) {
        removed.tooSmall++;
        return null;
      }
      const hash = await dHash(img.bytes);
      if (raw.source === "official_site") {
        raw.widthPx = img.width;
        raw.heightPx = img.height;
      }
      return { raw, img, hash };
    }),
  );
  let loaded = loadedOrNull.filter((x): x is Loaded => x !== null);
  loaded = [
    ...loaded.filter((l) => l.raw.source === "official_site").slice(0, MAX_OFFICIAL_PHOTOS),
    ...loaded.filter((l) => l.raw.source === "google_places"),
  ];

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

  // 6. Vision: что изображено. Батчи по 8, ошибки не роняют профиль.
  const visionInputs: VisionInput[] = kept.map((k) => ({ id: k.raw.id, bytes: k.img.bytes, mime: k.img.mime }));
  onProgress({ stage: "vision", batches: Math.ceil(visionInputs.length / 8) });
  let verdicts = new Map<string, VisionVerdict>();
  let visionErrors: string[] = [];
  if (process.env.GEMINI_API_KEY) {
    const r = await classifyImages(visionInputs, { universityName: university.label, city: university.city });
    verdicts = r.verdicts;
    visionErrors = r.errors;
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
    let category = raw.category;
    let trust = raw.trust;
    const reasons = [...raw.evidence.reasons];

    if (v) {
      if (!v.relevant || v.category === "other") {
        removed.irrelevant++;
        continue;
      }
      if (v.category !== raw.category) {
        reasons.push(`Категория по содержимому: «${v.category}» (по запросу было «${raw.category}»)`);
        category = v.category;
      } else {
        reasons.push(`Категория по содержимому совпала с запросом: «${category}»`);
      }
      reasons.push(`Содержимое проверено (Gemini, уверенность ${v.confidence}): ${v.caption}`);
      if (v.confidence === "low") {
        reasons.push("Низкая уверенность модели в содержимом — доверие понижено на один уровень");
        trust = downgrade(trust);
      }
    } else {
      reasons.push("Содержимое снимка не проверено: vision недоступен — доверие ограничено уровнем «вероятно»");
      if (trust === "verified") trust = "probable";
    }

    photos.push({
      id: raw.id,
      source: raw.source,
      imageUrl: raw.imageUrl,
      sourceUrl: raw.sourceUrl,
      attribution: raw.attribution,
      publishedAt: null,
      category,
      trust,
      evidence: { ...raw.evidence, vision: v, reasons },
      widthPx: raw.widthPx || k.img.width,
      heightPx: raw.heightPx || k.img.height,
      hash: k.hash,
    });
  }

  // 8. Город ограничиваем и ставим в конец: это контекст, а не объекты вуза.
  const cityPhotos = photos.filter((p) => p.category === "city").slice(0, MAX_CITY_PHOTOS);
  const rest = photos.filter((p) => p.category !== "city");
  const ordered = [...rest, ...cityPhotos].sort(
    (a, b) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] || TIER_RANK[a.trust] - TIER_RANK[b.trust],
  );
  photos.length = 0;
  photos.push(...ordered);

  // 9. Итоги.
  const coverage = computeCoverage(photos);
  const description = describeCampus(university, anchor, photos, coverage);
  if (photos.length === 0) warnings.push("Ни одной фотографии не прошло проверку — профиль пуст");
  onProgress({ stage: "done" });

  return {
    university,
    anchor,
    photos,
    coverage,
    description,
    removed,
    sources: {
      official: photos.filter((p) => p.source === "official_site").length,
      visitors: photos.filter((p) => p.source === "google_places").length,
    },
    visionAvailable,
    warnings,
    timingMs: Date.now() - started,
  };
}
