// lib/types.ts
// Единственный источник правды для типов данных. Другие файлы импортируют отсюда.
// Блок B: добавлены источник снимка, вердикт vision, статистика отсева, описание.

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

export const ALL_CATEGORIES: Category[] = ["campus", "dorm", "library", "lab", "sport", "life", "city"];

/** Откуда снимок. official_site — опубликован на сайте вуза; google_places — загружен посетителем. */
export type PhotoSource = "google_places" | "official_site";

export const SOURCE_LABELS: Record<PhotoSource, string> = {
  google_places: "Глазами людей",
  official_site: "Официальные",
};

/** Откуда взяты координаты, относительно которых считалось расстояние. */
export type AnchorSource = "wikidata" | "places" | "places+2gis" | "none";

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

/** Что модель увидела на снимке. Модель НЕ утверждает, что это именно данный вуз — только что изображено. */
export type VisionVerdict = {
  relevant: boolean;
  category: Category | "other";
  caption: string;
  confidence: "high" | "medium" | "low";
};

export type Evidence = {
  anchorSource: AnchorSource;
  /** null для снимков с официального сайта — они не привязаны к месту в Places. */
  placeId: string | null;
  placeName: string;
  distanceM: number | null;
  /** Какой поисковый запрос нашёл место. null для официального сайта. */
  queryIntent: Category | null;
  /** null — vision недоступен для этого снимка (ошибка API). */
  vision: VisionVerdict | null;
  /** Человекочитаемые причины для карточки провенанса. Только реально выполненные проверки. */
  reasons: string[];
};

export type PhotoItem = {
  id: string;
  source: PhotoSource;
  /** Короткоживущий URL картинки. Не кешировать. */
  imageUrl: string;
  /** Кликабельный источник: страница места в Google Maps или страница сайта вуза. */
  sourceUrl: string | null;
  attribution: Attribution[];
  /** Ни Places, ни главная страница сайта не отдают дату публикации — всегда null. Не выдумывать. */
  publishedAt: null;
  category: Category;
  trust: TrustTier;
  evidence: Evidence;
  widthPx: number;
  heightPx: number;
  /** Перцептивный хэш (dHash, 16 hex-символов). null, если картинку не удалось загрузить. */
  hash: string | null;
};

export type CategoryCoverage = {
  category: Category;
  verified: number;
  probable: number;
  unverified: number;
};

export type RemovalStats = {
  duplicates: number;
  irrelevant: number;
  tooSmall: number;
  failedDownload: number;
};

export type Anchor = {
  lat: number;
  lon: number;
  source: Exclude<AnchorSource, "none">;
};

export type ProgressEvent =
  | { stage: "anchor"; source: AnchorSource }
  | { stage: "places"; found: number }
  | { stage: "official"; found: number; error: string | null }
  | { stage: "download"; total: number }
  | { stage: "dedupe"; kept: number; duplicates: number }
  | { stage: "vision"; batches: number }
  | { stage: "done" };

export type Profile = {
  university: UniversityCandidate;
  anchor: Anchor | null;
  photos: PhotoItem[];
  coverage: CategoryCoverage[];
  /** Краткое описание кампуса, собранное только из найденных данных. */
  description: string;
  removed: RemovalStats;
  sources: { official: number; visitors: number };
  visionAvailable: boolean;
  warnings: string[];
  timingMs: number;
};
