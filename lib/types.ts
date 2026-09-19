// lib/types.ts
// Единственный источник правды для типов данных. Другие файлы импортируют отсюда.
// Блок B: добавлены источник снимка, вердикт vision, статистика отсева, описание.

export type TrustTier = "verified" | "probable" | "unverified";

/** Режим сборки профиля.
 *  quick — быстрый взгляд: по одному-двум снимкам на категорию, только главная
 *  страница сайта, укороченный план запросов. Задача — показать вуз целиком и сразу.
 *  deep — полный сбор по запросу пользователя: больше запросов, глубокий обход
 *  сайта, больше снимков в каждой категории. Разделение нужно, чтобы не тратить
 *  время и квоты на тех, кому хватило первого взгляда. */
export type ProfileMode = "quick" | "deep";

/** «city» и «citywide» — разные вещи, и путать их нельзя.
 *  city — то, до чего студент дойдёт пешком от кампуса (кейс: окружение).
 *  citywide — сам город, в котором расположен вуз (кейс, требование 2).
 *  Модель различить их не может: на снимке улица и там, и там. Разделяет география. */
export type Category =
  | "campus"
  | "lecture"
  | "dorm"
  | "library"
  | "lab"
  | "sport"
  | "canteen"
  | "outdoor"
  | "life"
  | "city"
  | "citywide";

export const CATEGORY_LABELS: Record<Category, string> = {
  campus: "Кампус",
  lecture: "Аудитории",
  dorm: "Общежитие",
  library: "Библиотека",
  lab: "Лаборатории",
  sport: "Спорт",
  canteen: "Столовая",
  outdoor: "Территория",
  life: "Студенческая жизнь",
  city: "Вокруг кампуса",
  citywide: "Город",
};

export const QUICK_CATEGORIES: Category[] = ["campus", "lecture", "library", "sport", "canteen", "dorm", "outdoor"];
export const ALL_CATEGORIES: Category[] = ["campus", "lecture", "library", "sport", "canteen", "dorm", "outdoor", "lab", "life", "city", "citywide"];

/** Откуда снимок. official_site — опубликован на сайте вуза; google_places — загружен посетителем. */
export type PhotoSource = "google_places" | "official_site" | "wikimedia_commons";

export const SOURCE_LABELS: Record<PhotoSource, string> = {
  google_places: "Глазами людей",
  official_site: "Официальные",
  wikimedia_commons: "Wikimedia Commons",
};

/** Откуда взяты координаты, относительно которых считалось расстояние. */
export type AnchorSource =
  | "wikidata+places+2gis"
  | "wikidata+places"
  | "wikidata+2gis"
  | "places+2gis"
  | "wikidata"
  | "places"
  | "none";

/** Каким путём получена карточка.
 *  sparql — основной путь через Wikidata.
 *  action-api — запасной при отказе SPARQL: без обхода подклассов, фильтр «это вуз» мягче.
 *  places — вуза нет в Wikidata вообще; карточка собрана из Google Places, координат
 *  из независимого источника нет, поэтому доверие заведомо ниже. */
export type ResolvedVia = "sparql" | "action-api" | "places";

export type UniversityCandidate = {
  /** Идентификатор: QID вида Q12345 либо `places:<place_id>` для вузов вне Wikidata. */
  qid: string;
  resolvedVia: ResolvedVia;
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
  /** Общий вид (панорама, перспектива улицы, силуэт города) против крупного плана.
   *  Нужно для категории «Город»: город показывают панорамой, а не киоском в городе. */
  wideView: boolean;
};

export type Evidence = {
  anchorSource: AnchorSource;
  /** null для снимков с официального сайта — они не привязаны к месту в Places. */
  placeId: string | null;
  placeName: string;
  /** Человекочитаемый адрес места. null для снимков с сайта вуза. */
  address: string | null;
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
  /** У файлов Commons условия повторного использования указаны для каждого файла. */
  license: { name: string; url: string } | null;
  /** Дата публикации, если источник её сообщил. У Google Places её нет никогда.
   *  У снимков со страниц новостей и событий вуза она есть: берётся из разметки
   *  страницы (article:published_time, <time datetime>) или из адреса вида
   *  /news/2026/03/. Не выдумывать: если источник молчит — null. */
  publishedAt: string | null;
  /** Момент получения снимка (ISO). Требование 6 кейса допускает дату публикации ИЛИ получения. */
  retrievedAt: string;
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
  /** Загрузились, но не поместились в лимит снимков с одного сайта вуза. */
  overSiteLimit: number;
  /** Окружение кампуса дальше порога пешей доступности — это уже другой район города. */
  farFromCampus: number;
  /** Резкость ниже порога: рассматривать в кадре нечего. */
  blurry: number;
  /** Сверх потолка на категорию — чтобы одно здание с разных сторон её не занимало. */
  overCategoryLimit: number;
  /** Кадры города, оказавшиеся крупным планом: город показывают общим видом. */
  cityNotWide: number;
};

export type Anchor = {
  lat: number;
  lon: number;
  source: Exclude<AnchorSource, "none">;
  /** Сравниваем все найденные точки, а не скрываем отличающиеся ответы. */
  observations: Array<{
    source: "wikidata" | "places" | "2gis";
    name: string;
    address: string | null;
    lat: number;
    lon: number;
    distanceM: number;
  }>;
  disputed: boolean;
};

/** Центр города по данным OpenStreetMap (Nominatim). Нужен для расстояния «кампус —
 *  центр города» из дополнительных функций кейса. Лицензия ODbL требует атрибуции,
 *  поэтому источник указан прямо в типе и показывается в интерфейсе. */
export type CityCenter = {
  name: string;
  lat: number;
  lon: number;
  /** Расстояние от якоря кампуса до центра города. */
  distanceM: number;
  source: "openstreetmap";
};

/** Точка на плане кампуса: место, которое дало снимки, с измеренным расстоянием. */
export type MapPoint = {
  placeId: string;
  name: string;
  lat: number;
  lon: number;
  distanceM: number;
  category: Category;
  photos: number;
};

/** Отзыв о месте из Google Places.
 *  Это отзывы посетителей места, а не проверенных студентов: платформа не сообщает,
 *  кем является автор, и выдавать их за студенческие нельзя. Зато у них есть то,
 *  чего нет у фотографий, — настоящая дата публикации. */
export type PlaceReview = {
  author: string;
  authorUri: string | null;
  authorPhotoUri: string | null;
  sourceUrl: string | null;
  visitDate: string | null;
  rating: number | null;
  text: string;
  /** ISO-дата публикации отзыва — реальная, от платформы. */
  publishedAt: string | null;
  languageCode: string | null;
};

export type DeepContext = {
  climate: { winterC: number; summerC: number; annualPrecipitationMm: number; years: string; sourceUrl: string } | null;
  transport: Array<{ name: string; kind: string; distanceM: number; lat: number; lon: number }>;
  transportSourceUrl: string | null;
  livingCosts: { currency: string; city: string; updated: string | null; items: Array<{ label: string; average: number; unit: string }> } | null;
};

export type ProgressEvent =
  | { stage: "photo"; photo: PhotoItem }
  | { stage: "anchor"; source: AnchorSource }
  | { stage: "places"; found: number }
  | { stage: "official"; found: number; error: string | null }
  | { stage: "download"; total: number }
  /** Что потерялось между загрузкой и дедупликацией: иначе «осталось N» выглядит
   *  как результат одной проверки, хотя причин было несколько. */
  | { stage: "prefilter"; kept: number; failedDownload: number; tooSmall: number; blurry: number; overSiteLimit: number }
  | { stage: "dedupe"; kept: number; duplicates: number }
  | { stage: "vision"; batches: number }
  | { stage: "done" };

export type Profile = {
  mode: ProfileMode;
  university: UniversityCandidate;
  anchor: Anchor | null;
  /** null — город неизвестен или Nominatim не ответил. */
  cityCenter: CityCenter | null;
  /** Места, попавшие в профиль, для плана кампуса. Пусто, если якоря нет. */
  mapPoints: MapPoint[];
  /** Отзывы о кампусе из Google Places. Пусто, если их нет или сбор отключён. */
  reviews: PlaceReview[];
  /** Место, к которому относятся отзывы. */
  reviewsPlaceName: string | null;
  deepContext?: DeepContext;
  photos: PhotoItem[];
  coverage: CategoryCoverage[];
  /** Краткое описание кампуса, собранное только из найденных данных. */
  description: string;
  removed: RemovalStats;
  sources: { official: number; visitors: number; commons: number };
  visionAvailable: boolean;
  warnings: string[];
  timingMs: number;
  /** Возраст сохранённого профиля при повторном открытии. */
  cacheAgeMs?: number;
};
