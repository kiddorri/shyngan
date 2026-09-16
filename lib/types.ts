// lib/types.ts
// Единственный источник правды для типов данных. Другие файлы импортируют отсюда.

export type TrustTier = "verified" | "probable" | "unverified";

export type Category =
  | "campus"
  | "dorm"
  | "library"
  | "lab"
  | "sport"
  | "life"
  | "city";

export const CATEGORY_LABELS: Record<Category, string> = {
  campus: "Кампус",
  dorm: "Общежитие",
  library: "Библиотека",
  lab: "Лаборатории",
  sport: "Спорт",
  life: "Студенческая жизнь",
  city: "Город",
};

export type UniversityCandidate = {
  qid: string;
  label: string;
  lat: number | null;
  lon: number | null;
  officialWebsite: string | null;
  country: string | null;
  city: string | null;
  image: string | null;
  instanceOf: string | null;
};

export type Attribution = {
  name: string;
  uri: string | null;
};

export type Evidence = {
  /** Откуда взяты координаты, относительно которых считалось расстояние. */
  anchorSource: "wikidata" | "places" | "none";
  placeId: string;
  placeName: string;
  distanceM: number | null;
  /** Какой поисковый запрос нашёл это место — определяет категорию в блоке A. */
  queryIntent: Category;
  /** Человекочитаемые причины для карточки провенанса. Только реально выполненные проверки. */
  reasons: string[];
};

export type PhotoItem = {
  id: string;
  source: "google_places";
  /** Короткоживущий URL картинки. Не кешировать. */
  imageUrl: string;
  /** Кликабельный источник: страница места в Google Maps. */
  sourceUrl: string | null;
  attribution: Attribution[];
  /** Google Places не отдаёт дату публикации — всегда null. Не выдумывать. */
  publishedAt: null;
  category: Category;
  trust: TrustTier;
  evidence: Evidence;
  widthPx: number;
  heightPx: number;
};

export type CategoryCoverage = {
  category: Category;
  verified: number;
  probable: number;
  unverified: number;
};

export type Profile = {
  university: UniversityCandidate;
  anchor: { lat: number; lon: number; source: "wikidata" | "places" } | null;
  photos: PhotoItem[];
  coverage: CategoryCoverage[];
  warnings: string[];
  timingMs: number;
};
