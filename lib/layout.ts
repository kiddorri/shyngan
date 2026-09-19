// lib/layout.ts
// Правила композиции визуального профиля.
//
// Профиль собирается из того, что реально нашлось, и набор снимков у каждого вуза
// свой: где-то тридцать кадров кампуса и ни одного общежития, где-то наоборот.
// Поэтому вёрстка не задаётся вручную, а выводится из данных: эти функции решают,
// какой кадр станет обложкой и какой ритм получит каждая категория.
//
// Здесь нет ни одного обращения к DOM и ни одного побочного эффекта — только
// чистые функции над PhotoItem. Это единственное место, где живут правила
// композиции; страница их лишь применяет.

import type { Category, PhotoItem, TrustTier } from "./types";

/** Доверие — главный вес: обложкой не может стать неподтверждённый кадр,
 *  если рядом лежит проверенный. Профиль обещает провенанс, и обложка обязана
 *  выполнять это обещание первой. */
const TRUST_WEIGHT: Record<TrustTier, number> = {
  verified: 1000,
  probable: 420,
  unverified: 60,
};

/** Происхождение — второй вес. Снимок с домена вуза доказан сильнее прочих. */
const SOURCE_WEIGHT: Record<PhotoItem["source"], number> = {
  official_site: 150,
  wikimedia_commons: 95,
  google_places: 80,
};

/** Что годится в обложку. Общий вид кампуса создаёт впечатление о вузе; кадр
 *  столовой — нет, даже если он технически лучше. Категории вне списка получают 0
 *  и остаются кандидатами только когда других нет. */
const COVER_WEIGHT: Partial<Record<Category, number>> = {
  campus: 260,
  outdoor: 200,
  life: 130,
  library: 110,
  sport: 80,
  lecture: 70,
  citywide: 60,
  dorm: 40,
};

/** Порядок «движений» профиля. Читается как рассказ: сначала место целиком,
 *  потом учёба, потом жизнь, потом контекст вокруг. Категории, которых нет
 *  в списке, идут после него в исходном порядке — новая категория в данных
 *  не должна ломать страницу. */
export const NARRATIVE_ORDER: Category[] = [
  "campus",
  "outdoor",
  "lecture",
  "library",
  "lab",
  "life",
  "sport",
  "canteen",
  "dorm",
  "city",
  "citywide",
];

/** Пропорция кадра. Нужна и для отбора обложки, и для выбора раскладки:
 *  вертикальный кадр в широкой рамке обрезается до неузнаваемости. */
export function aspect(p: PhotoItem): number {
  if (!p.widthPx || !p.heightPx) return 1.5;
  return p.widthPx / p.heightPx;
}

export function isPortrait(p: PhotoItem): boolean {
  return aspect(p) < 0.95;
}

export function isPanorama(p: PhotoItem): boolean {
  return aspect(p) >= 2.1;
}

/** Общая сила кадра: провенанс, происхождение, разрешение и вердикт модели.
 *  Разрешение берётся логарифмом — между 800 и 1600 пикселями разница заметна,
 *  между 4000 и 5000 уже нет, и линейный вес отдал бы всё одному большому файлу. */
export function scorePhoto(p: PhotoItem): number {
  let score = TRUST_WEIGHT[p.trust] + SOURCE_WEIGHT[p.source];
  const pixels = (p.widthPx || 0) * (p.heightPx || 0);
  if (pixels > 0) score += Math.min(220, Math.log2(pixels / 100_000 + 1) * 55);
  const vision = p.evidence.vision;
  if (vision) {
    score += vision.confidence === "high" ? 90 : vision.confidence === "medium" ? 45 : 0;
    if (vision.wideView) score += 40;
  }
  if (p.evidence.distanceM !== null && p.evidence.distanceM <= 400) score += 45;
  return score;
}

/** Пригодность на роль обложки. Отдельно от scorePhoto: обложке нужна ещё и
 *  подходящая категория и горизонтальная пропорция, а рядовому кадру — нет. */
function scoreCover(p: PhotoItem): number {
  let score = scorePhoto(p) + (COVER_WEIGHT[p.category] ?? 0);
  const ratio = aspect(p);
  // Обложка растягивается на всю ширину. Портрет в такой рамке превращается
  // в полосу из середины кадра, поэтому вертикальные снимки уступают.
  if (ratio >= 1.25 && ratio <= 2.4) score += 120;
  else if (ratio < 1.0) score -= 180;
  if ((p.widthPx || 0) < 900) score -= 90;
  return score;
}

export function byScore(a: PhotoItem, b: PhotoItem): number {
  return scorePhoto(b) - scorePhoto(a);
}

/** Обложка профиля: кадр, который первым скажет, как выглядит этот вуз. */
export function pickCover(photos: PhotoItem[]): PhotoItem | null {
  if (photos.length === 0) return null;
  return photos.reduce((best, p) => (scoreCover(p) > scoreCover(best) ? p : best));
}

/**
 * Спутники обложки — кадры для составной шапки полного профиля.
 *
 * Отбор идёт с оглядкой на разнообразие: два лучших снимка одного двора скажут
 * меньше, чем двор и библиотека. Поэтому категория, уже попавшая в выборку,
 * получает штраф, а не запрет: если сильных категорий меньше, чем мест, шапка
 * всё равно заполнится.
 */
export function pickSupporting(photos: PhotoItem[], cover: PhotoItem | null, limit: number): PhotoItem[] {
  const pool = photos.filter((p) => p.id !== cover?.id);
  const used = new Map<Category, number>();
  const chosen: PhotoItem[] = [];
  while (chosen.length < limit && chosen.length < pool.length) {
    let best: PhotoItem | null = null;
    let bestScore = -Infinity;
    for (const p of pool) {
      if (chosen.includes(p)) continue;
      const seen = used.get(p.category) ?? 0;
      const score = scorePhoto(p) - seen * 300;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (!best) break;
    chosen.push(best);
    used.set(best.category, (used.get(best.category) ?? 0) + 1);
  }
  return chosen;
}

/** Раскладка одного «движения» — блока одной категории.
 *  Выбирается количеством снимков, потому что это единственное, что заранее
 *  известно про любую категорию любого вуза. */
export type PlateLayout = "absent" | "solo" | "pair" | "triptych" | "mosaic" | "stream";

export function plateLayout(count: number): PlateLayout {
  if (count === 0) return "absent";
  if (count === 1) return "solo";
  if (count === 2) return "pair";
  if (count <= 4) return "triptych";
  if (count <= 9) return "mosaic";
  return "stream";
}

export type Plate = {
  category: Category;
  photos: PhotoItem[];
  layout: PlateLayout;
  /** Сторона подписи. Чередуется, чтобы страница не читалась одной колонкой. */
  align: "left" | "right";
  /** Порядковый номер движения — набирается крупной цифрой как в журнальной вёрстке. */
  index: number;
};

/**
 * Разложить снимки по движениям профиля.
 *
 * Пустые категории сюда не попадают: семь подряд одинаковых заглушек
 * «не найдено» — худшее, что может случиться с профилем бедного на снимки вуза.
 * То, чего не нашлось, называется одной строкой (missingCategories) — коротко
 * и честно, без семи абзацев извинений.
 *
 * limit ограничивает длину серии. Быстрый взгляд им пользуется: его задача —
 * показать вуз за секунды, а не выложить всё найденное.
 */
export function buildPlates(
  photos: PhotoItem[],
  categories: Category[],
  options: { limit?: number } = {},
): Plate[] {
  const ordered = [
    ...NARRATIVE_ORDER.filter((c) => categories.includes(c)),
    ...categories.filter((c) => !NARRATIVE_ORDER.includes(c)),
  ];
  const plates: Plate[] = [];
  for (const category of ordered) {
    const all = photos.filter((p) => p.category === category).sort(byScore);
    if (all.length === 0) continue;
    const items = options.limit ? all.slice(0, options.limit) : all;
    plates.push({
      category,
      photos: items,
      layout: plateLayout(items.length),
      align: plates.length % 2 === 0 ? "left" : "right",
      index: plates.length + 1,
    });
  }
  return plates;
}

/** Категории, для которых не нашлось ни одного снимка. */
export function missingCategories(photos: PhotoItem[], categories: Category[]): Category[] {
  const present = new Set(photos.map((p) => p.category));
  const ordered = [
    ...NARRATIVE_ORDER.filter((c) => categories.includes(c)),
    ...categories.filter((c) => !NARRATIVE_ORDER.includes(c)),
  ];
  return ordered.filter((c) => !present.has(c));
}

/**
 * Границы пропорции кадра для конкретной раскладки.
 *
 * Снимок сохраняет свою форму, но не любой ценой: портрет 900×1350 в колонке
 * пары вырастает башней на полтора экрана, а панорама 3:1 в мозаике
 * превращается в полоску. Поэтому каждая раскладка задаёт свой коридор, внутри
 * которого пропорция кадра остаётся собственной, а за его пределами — режется.
 */
export function ratioBounds(layout: PlateLayout): [number, number] {
  switch (layout) {
    // Одиночный кадр держит разворот: вертикаль здесь особенно дорого стоит.
    case "solo": return [1.2, 1.9];
    case "pair": return [0.85, 1.9];
    case "triptych": return [0.85, 2.0];
    default: return [0.75, 2.2];
  }
}

/** Человекочитаемый размер набора — для микроподписи у заголовка движения. */
export function plateNote(count: number): string {
  if (count === 0) return "не найдено";
  const tail = count % 100 >= 11 && count % 100 <= 14 ? "снимков" : count % 10 === 1 ? "снимок" : count % 10 >= 2 && count % 10 <= 4 ? "снимка" : "снимков";
  return `${count} ${tail}`;
}
