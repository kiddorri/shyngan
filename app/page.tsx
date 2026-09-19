// app/page.tsx
// Визуальный профиль университета.
//
// Устройство экрана подчинено одному правилу: главное здесь — фотография.
// Поэтому снимок нигде не лежит в карточке с рамкой и списком свойств под ней.
// Кадр занимает столько места, сколько заслуживает по силе, под ним остаётся
// только хайрлайн с уровнем доверия и местом, а весь разбор — происхождение,
// расстояние, лицензия, автор, проверки — открывается в просмотрщике, где
// фотографию наконец видно целиком.
//
// Разделение по происхождению снимков сохранено: это разные виды доказательства,
// а не разные вкладки.
//   • официальные — опубликованы на домене вуза; провенанс доказан доменом;
//   • глазами людей — загружены посетителями в Google Places; провенанс
//     доказан расстоянием до якоря кампуса;
//   • вокруг кампуса — окружение в пешей доступности, не объекты вуза.
//
// Ни одна подпись здесь не утверждает того, чего не проверял код: бейдж
// показывает уровень доверия и измеренное расстояние, панель доказательств —
// список реально выполненных проверок из evidence.reasons.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import styles from "./page.module.css";
import { cachedProfile, PROFILE_CACHE_TTL_MS, saveProfile } from "@/lib/profile-cache";
import {
  aspect,
  buildPlates,
  missingCategories,
  pickCover,
  pickSupporting,
  plateNote,
  ratioBounds,
  type Plate,
  type PlateLayout,
} from "@/lib/layout";
import {
  ALL_CATEGORIES,
  QUICK_CATEGORIES,
  CATEGORY_LABELS,
  type Category,
  type CollectionStats,
  type PhotoItem,
  type PlaceReview,
  type Profile,
  type ProgressEvent,
  type TrustTier,
  type UniversityCandidate,
} from "@/lib/types";

const CampusMap = dynamic(() => import("./CampusMap"), { ssr: false });

const TRUST_LABELS: Record<TrustTier, string> = {
  verified: "Подтверждено",
  probable: "Вероятно",
  unverified: "Не подтверждено",
};

const TRUST_CLASS: Record<TrustTier, string> = {
  verified: styles.trustVerified,
  probable: styles.trustProbable,
  unverified: styles.trustUnverified,
};

const ANCHOR_LABELS: Record<string, string> = {
  "wikidata+places+2gis": "Wikidata + Google Places + 2ГИС",
  "wikidata+places": "Wikidata + Google Places",
  "wikidata+2gis": "Wikidata + 2ГИС",
  wikidata: "Wikidata",
  places: "Google Places (без подтверждения)",
  "places+2gis": "Google Places, подтверждено 2ГИС",
  none: "не найдены",
};

const EXAMPLES: Array<{ name: string; where: string }> = [
  { name: "Harvard University", where: "Кембридж · США" },
  { name: "Назарбаев Университет", where: "Астана · Казахстан" },
  { name: "КазНУ имени аль-Фараби", where: "Алматы · Казахстан" },
];

const METHOD: string[] = [
  "Координаты кампуса сводятся из нескольких независимых источников — расхождения не прячутся, а показываются.",
  "Каждому снимку измеряется расстояние до этой точки, а содержимое кадра проверяется отдельно от запроса, которым он найден.",
  "У всякой фотографии остаётся источник, происхождение и уровень доверия. Того, что не проверено, профиль не утверждает.",
];

const recentSearches = new Map<string, { candidates: UniversityCandidate[]; savedAt: number }>();

/** Дата получения снимка: требование 6 кейса допускает дату публикации ИЛИ получения. */
function formatRetrieved(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("ru-RU");
}

/** Метры до километров: «8.6 км» и «107 м» читаются как разные порядки величины,
 *  и это снимает путаницу, не добавляя утверждений сверх измеренного. */
function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} км` : `${m} м`;
}

function progressText(e: ProgressEvent): string {
  switch (e.stage) {
    case "photo":
      return `Проверено фото: ${CATEGORY_LABELS[e.photo.category]}`;
    case "stats":
      return `Найдено ${e.discovered} · проверено ${e.checked} · добавлено ${e.accepted}`;
    case "anchor":
      return e.source === "none" ? "Координаты кампуса не найдены" : `Якорь координат: ${ANCHOR_LABELS[e.source] ?? e.source}`;
    case "places":
      return `Google Places: ${e.found} снимков`;
    case "official":
      return e.error ? `Официальный сайт: ${e.error}` : `Официальный сайт: ${e.found} кандидатов`;
    case "download":
      return `Загружаю ${e.total} изображений…`;
    case "prefilter": {
      // Каждая причина названа отдельно. Раньше здесь ничего не было, и потеря
      // снимков между «загружаю 54» и «осталось 40» выглядела как результат
      // дедупликации, хотя дублей среди них не было ни одного.
      const lost = [
        e.failedDownload > 0 ? `${e.failedDownload} не загрузилось` : null,
        e.tooSmall > 0 ? `${e.tooSmall} мельче минимального размера` : null,
        e.blurry > 0 ? `${e.blurry} размытых` : null,
        e.overSiteLimit > 0 ? `${e.overSiteLimit} сверх лимита на один сайт` : null,
      ].filter(Boolean);
      return lost.length > 0
        ? `Отсеяно до сравнения: ${lost.join(", ")} — осталось ${e.kept}`
        : `К сравнению принято ${e.kept} изображений`;
    }
    case "dedupe":
      return `Дубликаты убраны: ${e.duplicates}, осталось ${e.kept}`;
    case "vision":
      return e.batches ? `Проверяю содержимое: ${e.batches} запрос(ов) к модели…` : "Проверяю лучшие изображения для незаполненных категорий…";
    case "done":
      return "Готово";
  }
}

/** Для снимка с сайта вуза полезнее адрес страницы, а не голый домен: видно, что
 *  фотография взята из раздела «Библиотека», а не с главной. */
function placeLine(p: PhotoItem): string {
  if (p.source !== "official_site" || !p.sourceUrl) return p.evidence.placeName;
  try {
    const u = new URL(p.sourceUrl);
    return u.hostname.replace(/^www\./, "") + (u.pathname === "/" ? "" : decodeURIComponent(u.pathname));
  } catch {
    return p.evidence.placeName;
  }
}

/** У снимка города проверяется другое утверждение, и бейдж обязан говорить именно
 *  о нём: не «это объект вуза», а «это тот город, где вуз находится». */
const CITY_TRUST_LABELS: Record<TrustTier, string> = {
  verified: "Тот же город",
  probable: "Вероятно тот же город",
  unverified: "Город не подтверждён",
};

function trustLabel(p: PhotoItem): string {
  return p.category === "citywide" ? CITY_TRUST_LABELS[p.trust] : TRUST_LABELS[p.trust];
}

/** Короткая строка доверия под кадром. Длинный разбор ушёл в просмотрщик,
 *  но уровень и расстояние видны всегда — скрывать их нельзя ни на одном экране. */
function trustLine(p: PhotoItem): string {
  const parts = [trustLabel(p)];
  if (p.evidence.distanceM !== null) parts.push(formatDistance(p.evidence.distanceM));
  if (!p.evidence.vision) parts.push("содержимое не проверено");
  return parts.join(" · ");
}

/** Пропорция кадра отдаётся в CSS переменной: рамка подстраивается под снимок,
 *  а не режет его по фиксированному соотношению. Значение зажато, чтобы
 *  сверхузкая панорама или очень вытянутый портрет не ломали сетку. */
function ratioStyle(p: PhotoItem, bounds: [number, number] = [0.75, 2.2]): React.CSSProperties {
  const value = Math.min(bounds[1], Math.max(bounds[0], aspect(p)));
  return { "--ratio": String(value) } as React.CSSProperties;
}

type OpenShot = (photo: PhotoItem, set: PhotoItem[]) => void;

/** Пять шагов из кейса: название → поиск → проверка → категории → профиль.
 *  Показываем, на каком из них сборка сейчас, — это и есть заявленный сценарий. */
const STEPS = ["Название", "Поиск", "Проверка", "Категории", "Профиль"] as const;

function stepOf(stage: ProgressEvent["stage"] | null): number {
  switch (stage) {
    case null:
      return 0;
    case "anchor":
    case "places":
    case "official":
      return 1;
    case "download":
    case "prefilter":
    case "dedupe":
      return 2;
    case "vision":
    case "photo":
      return 3;
    case "stats":
      return 2;
    case "done":
      return 4;
  }
}

/* ========================================================================== */
/*  Снимок                                                                     */
/* ========================================================================== */

function Shot({
  photo, set, onOpen, index = 0, bounds,
}: { photo: PhotoItem; set: PhotoItem[]; onOpen: OpenShot; index?: number; bounds?: [number, number] }) {
  return (
    <figure className={styles.shot} style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}>
      <button
        type="button"
        className={styles.shotFrame}
        style={ratioStyle(photo, bounds)}
        onClick={() => onOpen(photo, set)}
        aria-label={`Открыть снимок: ${photo.evidence.vision?.caption ?? photo.evidence.placeName}`}
      >
        {/* next/image здесь не подходит: адреса снимков внешние, короткоживущие и
            заранее неизвестны, а оптимизация чужих URL ничего не даёт. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={styles.shotImage}
          src={photo.imageUrl}
          alt={photo.evidence.vision?.caption ?? photo.evidence.placeName}
          loading="lazy"
        />
        <span className={styles.shotHint}>Доказательства</span>
      </button>
      <figcaption className={styles.shotCaption}>
        <span className={`${styles.shotTrust} ${TRUST_CLASS[photo.trust]}`}>{trustLine(photo)}</span>
        <span className={styles.shotPlace}>{photo.evidence.vision?.caption ?? placeLine(photo)}</span>
      </figcaption>
    </figure>
  );
}

/**
 * Галерея одной серии.
 *
 * Раскладка не задаётся вручную, а выводится из количества снимков (lib/layout.ts).
 * Один кадр получает разворот, два — смещённую пару, три-четыре — триптих,
 * до девяти — мозаику с ведущим кадром, больше — мозаику и ленту с остатком.
 * Благодаря этому любая категория любого вуза верстается сама и не превращается
 * в бесконечную одинаковую сетку.
 */
function Gallery({ photos, layout, onOpen }: { photos: PhotoItem[]; layout: PlateLayout; onOpen: OpenShot }) {
  if (photos.length === 0) return null;
  const bounds = ratioBounds(layout);

  if (layout === "stream") {
    const lead = photos.slice(0, 7);
    const tail = photos.slice(7);
    return (
      <>
        <div className={styles.layoutMosaic}>
          {lead.map((p, i) => <Shot key={p.id} photo={p} set={photos} onOpen={onOpen} index={i} bounds={bounds} />)}
        </div>
        <div className={styles.strip}>
          {tail.map((p, i) => <Shot key={p.id} photo={p} set={photos} onOpen={onOpen} index={i} bounds={bounds} />)}
        </div>
      </>
    );
  }

  const className =
    layout === "solo" ? styles.layoutSolo
    : layout === "pair" ? styles.layoutPair
    : layout === "triptych" ? styles.layoutTriptych
    : styles.layoutMosaic;

  return (
    <div className={className}>
      {photos.map((p, i) => <Shot key={p.id} photo={p} set={photos} onOpen={onOpen} index={i} bounds={bounds} />)}
    </div>
  );
}

/**
 * Пояснения к двум категориям, у которых проверяется другое утверждение.
 * Они стоят рядом со своей серией, а не в общем примечании: путать окружение
 * кампуса с самим городом нельзя, и различие нужно объяснить там, где смотрят.
 */
const CATEGORY_NOTES: Partial<Record<Category, string>> = {
  city: "Не объекты вуза, а то, что рядом: парки, кафе, улицы в пешей доступности. Всё, что дальше двух километров, сюда не попадает — это уже другой район города.",
  citywide: "Сам город, в котором находится университет: общие виды — панорамы, перспективы улиц, силуэт города. Крупные планы памятников и вывесок сюда не попадают. Проверяется здесь другое утверждение: не «это объект вуза», а «это тот же город» — по городу из структурного адреса места и по расстоянию от кампуса.",
};

/** Движение профиля: одна категория с боковой подписью, прилипающей при прокрутке. */
function Movement({ plate, onOpen }: { plate: Plate; onOpen: OpenShot }) {
  return (
    <section
      id={`cat-${plate.category}`}
      className={`${styles.plate} ${plate.align === "right" ? styles.plateRight : ""}`}
    >
      <header className={styles.plateHead}>
        <span className={styles.plateIndex}>{String(plate.index).padStart(2, "0")}</span>
        <h3 className={styles.plateTitle}>{CATEGORY_LABELS[plate.category]}</h3>
        <span className={styles.plateNote}>{plateNote(plate.photos.length)}</span>
        {CATEGORY_NOTES[plate.category] && (
          <p className={styles.plateAbout}>{CATEGORY_NOTES[plate.category]}</p>
        )}
      </header>
      <div className={styles.plateBody}>
        <Gallery photos={plate.photos} layout={plate.layout} onOpen={onOpen} />
      </div>
    </section>
  );
}

/* ========================================================================== */
/*  Обложка                                                                    */
/* ========================================================================== */

function Cover({
  university,
  photos,
  mode,
  meta,
  onOpen,
}: {
  university: UniversityCandidate;
  photos: PhotoItem[];
  mode: "quick" | "deep";
  meta: React.ReactNode;
  onOpen: OpenShot;
}) {
  const cover = useMemo(() => pickCover(photos), [photos]);
  const supporting = useMemo(
    () => (mode === "deep" && cover ? pickSupporting(photos, cover, 2) : []),
    [photos, cover, mode],
  );

  const longName = university.label.length > 34;
  const place = [university.city, university.country].filter(Boolean).join(" · ");

  // Ни одного снимка — рамку показывать нечем. Вместо пустого прямоугольника
  // остаётся типографика: имя вуза читается так же крупно, честность сохраняется.
  if (!cover) {
    return (
      <section className={styles.coverBlank}>
        <div className={styles.inner}>
          <span className={`${styles.eyebrow} ${styles.eyebrowOnInk}`}>{place || "Расположение неизвестно"}</span>
          <h1 className={`${styles.coverTitle} ${longName ? styles.coverTitleLong : ""}`}>{university.label}</h1>
          <div className={styles.coverMeta}>{meta}</div>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.cover}>
      <div className={`${styles.coverFrame} ${supporting.length > 0 ? styles.coverMosaic : ""}`}>
        <button
          type="button"
          className={styles.coverTile}
          onClick={() => onOpen(cover, photos)}
          aria-label={`Открыть обложку: ${cover.evidence.vision?.caption ?? cover.evidence.placeName}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className={styles.coverImage} src={cover.imageUrl} alt={cover.evidence.vision?.caption ?? cover.evidence.placeName} />
        </button>
        {supporting.map((p) => (
          <button
            key={p.id}
            type="button"
            className={styles.coverTile}
            onClick={() => onOpen(p, photos)}
            aria-label={`Открыть снимок: ${p.evidence.vision?.caption ?? p.evidence.placeName}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={styles.coverImage} src={p.imageUrl} alt={p.evidence.vision?.caption ?? p.evidence.placeName} />
          </button>
        ))}
        <div className={styles.coverScrim} />
      </div>
      <div className={styles.coverCaption}>
        <span className={`${styles.eyebrow} ${styles.eyebrowOnInk}`}>{place || "Расположение неизвестно"}</span>
        <h1 className={`${styles.coverTitle} ${longName ? styles.coverTitleLong : ""}`}>{university.label}</h1>
        <div className={styles.coverMeta}>{meta}</div>
      </div>
    </section>
  );
}

/* ========================================================================== */
/*  Глава полного профиля                                                      */
/* ========================================================================== */

/**
 * Происхождение снимков — три разных вида доказательства.
 *
 * Раньше архив был разрезан на три главы по источнику, и внутри каждой заново
 * повторялись все категории: «Библиотека» встречалась на странице трижды.
 * Теперь источник — это фильтр и отдельный разбор, а архив построен по
 * категориям: искать идут «библиотеку», а не «официальные снимки библиотеки».
 * Ни одно утверждение при этом не потерялось — у каждого кадра источник виден
 * в просмотрщике, а различие между видами доказательства объяснено ниже.
 */
const SOURCE_LENSES = [
  {
    key: "official_site" as const,
    label: "Официальные",
    note: "Опубликованы на сайте вуза. Провенанс доказан доменом: снимок лежит на странице самого университета. Про то, кем и когда сделан кадр, сайт ничего не сообщает.",
  },
  {
    key: "google_places" as const,
    label: "Глазами людей",
    note: "Загружены посетителями в Google Places. Провенанс проверяется географически: у каждого снимка измерено расстояние от места до якоря кампуса, и оно указано под кадром.",
  },
  {
    key: "wikimedia_commons" as const,
    label: "Wikimedia Commons",
    note: "Файлы из категории, связанной с карточкой выбранного вуза. У каждого указаны автор, лицензия и страница файла. Категория не доказывает место съёмки, поэтому географическое доверие остаётся неподтверждённым.",
  },
];

/* ========================================================================== */
/*  Отзывы                                                                     */
/* ========================================================================== */

function ageNote(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const years = (Date.now() - t) / (365.25 * 24 * 3600 * 1000);
  if (years < 1) return "меньше года назад";
  const whole = Math.floor(years);
  const word = whole === 1 ? "год" : whole < 5 ? "года" : "лет";
  return `${whole} ${word} назад`;
}

function Quotes({ reviews, placeName }: { reviews: PlaceReview[]; placeName: string | null }) {
  return (
    <section className={styles.chapter}>
      <header className={styles.chapterHead}>
        <div>
          <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>Голоса</span>
          <h2 className={styles.chapterTitle}>
            Отзывы посетителей
            <span className={styles.chapterCount}>{reviews.length}</span>
          </h2>
        </div>
        <p className={styles.chapterNote}>
          Отзывы о месте «{placeName ?? "кампус"}» из Google Places, с датой публикации. Кто их автор — студент,
          сотрудник или гость — платформа не сообщает, поэтому студенческими мы их не называем.
          Из предоставленной сервисом выборки отзывы упорядочены по дате.{" "}
          <span className={styles.googleAttribution} translate="no">Google Maps</span>
        </p>
      </header>
      <ul className={styles.quotes}>
        {reviews.map((r, i) => (
          <li key={i} className={styles.quote}>
            <p className={styles.quoteText}>«{r.text}»</p>
            <div className={styles.quoteBy}>
              {r.authorPhotoUri && (
                // eslint-disable-next-line @next/next/no-img-element
                <img className={styles.avatar} src={r.authorPhotoUri} alt="" />
              )}
              {r.authorUri ? (
                <a className={styles.link} href={r.authorUri} target="_blank" rel="noreferrer">{r.author}</a>
              ) : (
                <span>{r.author}</span>
              )}
              {r.rating !== null && <span className={styles.rating}>{r.rating} / 5</span>}
              {r.publishedAt && <span>{formatRetrieved(r.publishedAt)} · {ageNote(r.publishedAt)}</span>}
              {r.visitDate && <span>посещение {r.visitDate}</span>}
              {r.sourceUrl && <a className={styles.link} href={r.sourceUrl} target="_blank" rel="noreferrer">Оригинал ↗</a>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ========================================================================== */
/*  Просмотрщик                                                                */
/* ========================================================================== */

function Lightbox({
  photo,
  set,
  onSelect,
  onClose,
}: {
  photo: PhotoItem;
  set: PhotoItem[];
  onSelect: (p: PhotoItem) => void;
  onClose: () => void;
}) {
  const index = Math.max(0, set.findIndex((p) => p.id === photo.id));
  const step = useCallback(
    (delta: number) => {
      if (set.length < 2) return;
      onSelect(set[(index + delta + set.length) % set.length]);
    },
    [set, index, onSelect],
  );

  // Панель открывают десятки раз подряд, и каждый раз тянуться мышью неудобно:
  // Esc закрывает, стрелки листают серию, в которой снимок был открыт.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, step]);

  // Фон не должен прокручиваться под раскрытым на весь экран снимком.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, []);

  return (
    <div className={styles.lightbox} role="dialog" aria-modal="true" aria-label="Снимок и доказательства">
      <div className={styles.lightboxStage}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={photo.id}
          className={styles.lightboxImage}
          src={photo.imageUrl}
          alt={photo.evidence.vision?.caption ?? photo.evidence.placeName}
        />
        {set.length > 1 && (
          <>
            <button type="button" className={`${styles.lightboxNav} ${styles.lightboxPrev}`} onClick={() => step(-1)} aria-label="Предыдущий снимок">←</button>
            <button type="button" className={`${styles.lightboxNav} ${styles.lightboxNext}`} onClick={() => step(1)} aria-label="Следующий снимок">→</button>
            <span className={styles.lightboxCount}>{index + 1} / {set.length}</span>
          </>
        )}
      </div>

      <aside className={styles.evidence}>
        <div className={styles.evidenceHead}>
          <div>
            <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>{CATEGORY_LABELS[photo.category]}</span>
            <h2 className={styles.evidenceTitle}>Почему это фото здесь</h2>
          </div>
          <button type="button" className={styles.close} onClick={onClose}>Esc</button>
        </div>

        <p className={`${styles.evidenceTrust} ${TRUST_CLASS[photo.trust]}`}>{trustLabel(photo)}</p>

        <ul className={styles.reasons}>
          {photo.evidence.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>

        <div className={styles.factList}>
          <div className={styles.factRow}>
            <span className={styles.factKey}>Источник</span>
            <span className={styles.factValue}>
              {photo.source === "official_site" ? "сайт вуза"
                : photo.source === "wikimedia_commons" ? "Wikimedia Commons"
                : <span className={styles.googleAttribution} translate="no">Google Maps</span>}
            </span>
          </div>
          {photo.sourceUrl && (
            <div className={styles.factRow}>
              <span className={styles.factKey}>Ссылка</span>
              <span className={styles.factValue}>
                <a className={styles.link} href={photo.sourceUrl} target="_blank" rel="noreferrer">Открыть оригинал ↗</a>
              </span>
            </div>
          )}
          {photo.attribution.map((author, i) => (
            <div className={styles.factRow} key={`${author.name}-${i}`}>
              <span className={styles.factKey}>Автор</span>
              <span className={styles.factValue}>
                {author.uri ? <a className={styles.link} href={author.uri} target="_blank" rel="noreferrer">{author.name}</a> : author.name}
              </span>
            </div>
          ))}
          {photo.license && (
            <div className={styles.factRow}>
              <span className={styles.factKey}>Лицензия</span>
              <span className={styles.factValue}>
                <a className={styles.link} href={photo.license.url} target="_blank" rel="noreferrer">{photo.license.name}</a>
              </span>
            </div>
          )}
          <div className={styles.factRow}>
            <span className={styles.factKey}>
              {photo.source === "official_site" ? "Страница" : photo.source === "wikimedia_commons" ? "Файл" : "Место"}
            </span>
            <span className={styles.factValue}>{placeLine(photo)}</span>
          </div>
          {photo.evidence.address && (
            <div className={styles.factRow}>
              <span className={styles.factKey}>Адрес</span>
              <span className={styles.factValue}>{photo.evidence.address}</span>
            </div>
          )}
          <div className={styles.factRow}>
            <span className={styles.factKey}>Расстояние</span>
            <span className={styles.factValue}>
              {photo.evidence.distanceM === null ? "не измерялось" : `${formatDistance(photo.evidence.distanceM)} от кампуса`}
            </span>
          </div>
          <div className={styles.factRow}>
            <span className={styles.factKey}>Категория</span>
            <span className={styles.factValue}>
              {CATEGORY_LABELS[photo.category]} {photo.evidence.vision ? "(по содержимому)" : "(по запросу)"}
            </span>
          </div>
          <div className={styles.factRow}>
            <span className={styles.factKey}>Размер</span>
            <span className={styles.factValue}>{photo.widthPx}×{photo.heightPx}</span>
          </div>
          <div className={styles.factRow}>
            <span className={styles.factKey}>Получено</span>
            <span className={styles.factValue}>{formatRetrieved(photo.retrievedAt)}</span>
          </div>
          <div className={styles.factRow}>
            <span className={styles.factKey}>Публикация</span>
            <span className={styles.factValue}>
              {photo.publishedAt ? formatRetrieved(photo.publishedAt) : "неизвестна"}
            </span>
          </div>
          {photo.hash && (
            <div className={styles.factRow}>
              <span className={styles.factKey}>dHash</span>
              <span className={`${styles.factValue} ${styles.mono}`}>{photo.hash}</span>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

/* ========================================================================== */
/*  Страница                                                                   */
/* ========================================================================== */

export default function Home() {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<UniversityCandidate[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [workingUniversity, setWorkingUniversity] = useState<UniversityCandidate | null>(null);
  const [quickPhotos, setQuickPhotos] = useState<PhotoItem[]>([]);
  const [catFilter, setCatFilter] = useState<Category | "all">("all");
  // Источник — это линза поверх архива, а не отдельный раздел: одна и та же
  // категория не должна встречаться на странице трижды.
  const [srcFilter, setSrcFilter] = useState<PhotoItem["source"] | "all">("all");
  const [selected, setSelected] = useState<{ photo: PhotoItem; set: PhotoItem[] } | null>(null);
  const [loading, setLoading] = useState<"idle" | "resolve" | "profile">("idle");
  const [progress, setProgress] = useState<string[]>([]);
  const [stage, setStage] = useState<ProgressEvent["stage"] | null>(null);
  const [collectionStats, setCollectionStats] = useState<CollectionStats | null>(null);
  const [quickDeadlineAt, setQuickDeadlineAt] = useState<number | null>(null);
  const [quickSecondsLeft, setQuickSecondsLeft] = useState(30);
  const [lastQid, setLastQid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openShot: OpenShot = useCallback((photo, set) => setSelected({ photo, set }), []);

  useEffect(() => {
    if (!quickDeadlineAt) return;
    const tick = () => setQuickSecondsLeft(Math.max(0, Math.ceil((quickDeadlineAt - Date.now()) / 1000)));
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [quickDeadlineAt]);

  async function runSearch(text: string) {
    setError(null);
    setProfile(null);
    setWorkingUniversity(null);
    setQuickPhotos([]);
    setCandidates([]);
    setSelected(null);
    setLoading("resolve");
    try {
      const searchKey = text.trim().normalize("NFKC").toLocaleLowerCase();
      const previous = recentSearches.get(searchKey);
      let candidates: UniversityCandidate[];
      if (previous && Date.now() - previous.savedAt < PROFILE_CACHE_TTL_MS) {
        candidates = previous.candidates;
      } else {
        const res = await fetch(`/api/resolve?q=${encodeURIComponent(text)}`);
        const json = (await res.json()) as { candidates: UniversityCandidate[]; error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        candidates = json.candidates;
        recentSearches.delete(searchKey);
        recentSearches.set(searchKey, { candidates, savedAt: Date.now() });
        if (recentSearches.size > 24) recentSearches.delete(recentSearches.keys().next().value!);
      }
      if (candidates.length === 0) {
        setError("Университет не найден. Попробуйте другое написание или название на английском.");
      } else if (candidates.length === 1 &&
        !/^[A-Z]{2,5}$/.test(text.trim()) &&
        candidates[0].resolvedVia !== "places" &&
        (candidates[0].officialWebsite ||
          (candidates[0].lat !== null && candidates[0].lon !== null))) {
        await loadProfile(candidates[0].qid, "quick");
      } else {
        setCandidates(candidates);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading("idle");
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    await runSearch(query);
  }

  async function loadProfile(qid: string, mode: "quick" | "deep" = "quick") {
    setError(null);
    setCandidates([]);
    setProgress([]);
    setStage(null);
    setCollectionStats(null);
    setLoading("profile");
    setLastQid(qid);
    // При углублении уже показанный профиль остаётся на экране: пользователь нажал
    // «подробнее», а не «начать заново», и терять картинку на двадцать секунд незачем.
    if (mode === "quick") { setProfile(null); setQuickPhotos([]); setWorkingUniversity(null); }
    try {
      const cached = cachedProfile(qid, mode);
      if (cached) {
        setProfile({ ...cached.profile, timingMs: 0, cacheAgeMs: cached.ageMs });
        setCatFilter("all");
        setSrcFilter("all");
        return;
      }
      const res = await fetch(`/api/profile?qid=${qid}&mode=${mode}`);
      if (!res.ok || !res.body) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      if (mode === "quick") setQuickDeadlineAt(Date.now() + 30_000);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        done = chunk.done;
        buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as { type: string } & Record<string, unknown>;
          if (msg.type === "progress") {
            const event = msg as unknown as ProgressEvent;
            if (event.stage === "stats") {
              setCollectionStats({
                discovered: event.discovered,
                downloaded: event.downloaded,
                checked: event.checked,
                accepted: event.accepted,
              });
            } else {
              setStage(event.stage);
            }
            if (event.stage === "photo") {
              setQuickPhotos((prev) => prev.some((p) => p.id === event.photo.id) ? prev : [...prev, event.photo]);
              if (mode === "deep") {
                setProfile((prev) => prev && !prev.photos.some((photo) => photo.id === event.photo.id)
                  ? { ...prev, photos: [...prev.photos, event.photo] }
                  : prev);
              }
            } else if (event.stage !== "stats") {
              setProgress((prev) => [...prev, progressText(event)]);
            }
          } else if (msg.type === "university") {
            setWorkingUniversity(msg.university as UniversityCandidate);
          } else if (msg.type === "profile") {
            // Поле type — служебное для потока NDJSON; на профиль оно не влияет.
            const nextProfile = msg as unknown as Profile;
            saveProfile(nextProfile);
            setProfile(nextProfile);
            setCatFilter("all");
            setSrcFilter("all");
          } else if (msg.type === "error") {
            throw new Error(String(msg.error));
          }
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setQuickDeadlineAt(null);
      setLoading("idle");
    }
  }

  function reset() {
    setProfile(null);
    setCandidates([]);
    setQuickPhotos([]);
    setWorkingUniversity(null);
    setSelected(null);
    setError(null);
    setQuery("");
  }

  const visible = profile
    ? profile.photos.filter((p) => catFilter === "all" || p.category === catFilter)
    : [];
  // Архив полного профиля: категория и источник — две независимые линзы над
  // одним и тем же набором. «Вокруг кампуса» и «Город» остаются отдельными
  // категориями: у них другое утверждение, и мешать их с кампусом нельзя.
  const deepPhotos = visible.filter((p) => srcFilter === "all" || p.source === srcFilter);
  const countIn = (c: Category) => (profile ? profile.photos.filter((p) => p.category === c).length : 0);

  // Быстрый взгляд ограничен по длине серии: его задача — показать вуз за
  // секунды. Всё найденное целиком ждёт в полном архиве.
  const QUICK_LIMIT = 6;

  const quickPlates = useMemo(
    () => (profile && profile.mode === "quick" ? buildPlates(visible, QUICK_CATEGORIES, { limit: QUICK_LIMIT }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile, catFilter],
  );

  // Чего не нашлось — одной строкой, а не семью одинаковыми заглушками подряд.
  const quickMissing = useMemo(
    () => (profile && profile.mode === "quick" ? missingCategories(visible, QUICK_CATEGORIES) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile, catFilter],
  );

  const livePlates = useMemo(
    () => buildPlates(quickPhotos, QUICK_CATEGORIES, { limit: QUICK_LIMIT }),
    [quickPhotos],
  );

  const deepPlates = useMemo(
    () => (profile && profile.mode === "deep" ? buildPlates(deepPhotos, ALL_CATEGORIES) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile, catFilter, srcFilter],
  );

  const deepMissing = useMemo(
    () => (profile && profile.mode === "deep" ? missingCategories(profile.photos, ALL_CATEGORIES) : []),
    [profile],
  );

  // Описание разбивается на лид и остаток: первая фраза набирается антиквой
  // крупно, дальше — обычным текстом. Работает и с одной фразой, и с абзацем.
  const [lede, ledeTail] = useMemo(() => {
    const text = profile?.description?.trim() ?? "";
    if (!text) return ["", ""] as const;
    const cut = text.search(/(?<=[.!?])\s/);
    if (cut === -1 || cut > 220) return [text, ""] as const;
    return [text.slice(0, cut + 1), text.slice(cut + 1).trim()] as const;
  }, [profile?.description]);

  const coverMeta = profile && (
    <>
      <span>{profile.photos.length} фото</span>
      <span>{profile.mode === "quick" ? "Быстрый взгляд" : "Полный архив"}</span>
      {profile.university.officialWebsite && (
        <a href={profile.university.officialWebsite} target="_blank" rel="noreferrer">Официальный сайт ↗</a>
      )}
      {profile.cityCenter && <span>До центра {formatDistance(profile.cityCenter.distanceM)}</span>}
      <span>
        {profile.cacheAgeMs !== undefined ? "Из кэша" : `Собрано за ${(profile.timingMs / 1000).toFixed(1)} с`}
      </span>
    </>
  );

  return (
    <div className={styles.page}>
      <header className={styles.masthead}>
        <div className={styles.mastheadInner}>
          <button type="button" className={styles.brand} onClick={reset} aria-label="Shyngan — на главную">
            <span className={styles.brandMark}>Shyngan</span>
            <span className={styles.brandNote}>Визуальный атлас университетов</span>
          </button>
          <form className={styles.search} onSubmit={onSubmit}>
            <input
              id="university-query"
              className={styles.searchInput}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Название университета"
              aria-label="Название университета"
            />
            <button
              type="submit"
              className={styles.searchSubmit}
              disabled={loading !== "idle"}
              aria-label={loading === "idle" ? "Найти университет" : "Идёт поиск"}
            >
              <span className={styles.searchSubmitLabel}>{loading === "idle" ? "Найти" : "Ищу…"}</span>
              <span className={styles.searchSubmitIcon} aria-hidden="true">{loading === "idle" ? "→" : "…"}</span>
            </button>
          </form>
        </div>
      </header>

      <main className={styles.main}>
        {/* --- стартовый экран --- */}
        {!profile && loading === "idle" && candidates.length === 0 && !error && (
          <div className={styles.inner}>
            <section className={styles.landing}>
              <div>
                <span className={styles.eyebrow}>Визуальный атлас университетов</span>
                <h1 className={styles.landingTitle}>Увидеть университет <em>по-настоящему</em></h1>
                <p className={styles.landingText}>
                  Кампусы, аудитории, библиотеки, общежития и повседневная жизнь — настоящие фотографии
                  из открытых источников. У каждого кадра проверено происхождение, измерено расстояние
                  до кампуса и указан уровень доверия.
                </p>

                <div className={styles.indexHead}>
                  <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>Начните отсюда</span>
                  <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>{String(EXAMPLES.length).padStart(2, "0")}</span>
                </div>
                {EXAMPLES.map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    className={styles.indexRow}
                    onClick={() => { setQuery(item.name); void runSearch(item.name); }}
                  >
                    <span className={styles.indexName}>{item.name}</span>
                    <span className={styles.pickMeta}>{item.where}</span>
                    <span className={styles.indexArrow} aria-hidden="true">→</span>
                  </button>
                ))}
              </div>

              <aside className={styles.landingAside}>
                <div>
                  <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>Что вы увидите</span>
                  <ul className={styles.vocabList}>
                    {ALL_CATEGORIES.map((c, i) => (
                      <li key={c}>
                        <span>{CATEGORY_LABELS[c]}</span>
                        <span>{String(i + 1).padStart(2, "0")}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>Как это проверяется</span>
                  <ol className={styles.method}>
                    {METHOD.map((text, i) => (
                      <li key={i}>
                        <span className={styles.methodNum}>{i + 1}</span>
                        <span>{text}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              </aside>
            </section>
          </div>
        )}

        {error && (
          <div className={styles.inner}>
            <section className={styles.error}>
              <span className={styles.eyebrow}>Не получилось</span>
              <h2 className={styles.errorTitle}>Профиль не собрался</h2>
              <p className={styles.errorText}>{error}</p>
            </section>
          </div>
        )}

        {/* --- выбор вуза --- */}
        {candidates.length > 0 && (
          <div className={styles.inner}>
            <section className={styles.pick}>
              <span className={styles.eyebrow}>Уточнение</span>
              <h2 className={styles.pickTitle}>Какой именно?</h2>
              <p className={styles.pickNote}>
                При неоднозначном написании стоит проверить название до того, как начнётся сбор фотографий.
              </p>
              <div className={styles.pickList}>
                {candidates.map((c) => (
                  <button key={c.qid} className={styles.pickRow} onClick={() => loadProfile(c.qid)}>
                    <span className={styles.pickName}>{c.label}</span>
                    <span className={styles.pickMeta}>
                      {[c.city, c.country, c.instanceOf].filter(Boolean).join(" · ") || "расположение неизвестно"} · {c.qid}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* --- сбор профиля --- */}
        {loading === "profile" && (
          <section className={styles.collect}>
            <div className={styles.collectInner}>
              <span className={`${styles.eyebrow} ${styles.eyebrowOnInk}`}>
                {profile ? "Собираю полный архив" : "Быстрый взгляд"}
              </span>
              {workingUniversity || profile ? (
                <h2 className={styles.collectName}>{(workingUniversity ?? profile!.university).label}</h2>
              ) : (
                <h2 className={styles.collectName}>Ищу университет</h2>
              )}
              <p className={styles.collectStatus}>
                {profile
                  ? "Больше категорий, больше снимков, карта кампуса и контекст города. Уже показанный профиль остаётся на экране."
                  : quickPhotos.length > 0
                    ? `${quickPhotos.length} проверенных фото уже доступно. Продолжаем ещё до ${quickSecondsLeft} с.`
                    : `Проверяю фотографии в нескольких источниках — ещё до ${quickSecondsLeft} с.`}
              </p>

              <div className={styles.collectBar}>
                <span
                  className={styles.collectBarFill}
                  style={{ width: `${(stepOf(stage) / (STEPS.length - 1)) * 100}%` }}
                />
              </div>

              <ol className={styles.steps}>
                {STEPS.map((label, i) => {
                  const current = stepOf(stage);
                  return (
                    <li
                      key={label}
                      className={`${styles.step} ${i < current ? styles.stepDone : ""} ${i === current ? styles.stepNow : ""}`}
                    >
                      <span className={styles.stepNum}>{String(i + 1).padStart(2, "0")}</span>
                      {label}
                    </li>
                  );
                })}
              </ol>

              {collectionStats && (
                <div className={styles.counters}>
                  <div className={styles.counter}>
                    <span className={styles.counterNum}>{collectionStats.discovered}</span>
                    <span className={styles.counterKey}>Найдено</span>
                  </div>
                  <div className={styles.counter}>
                    <span className={styles.counterNum}>{collectionStats.downloaded}</span>
                    <span className={styles.counterKey}>Загружено</span>
                  </div>
                  <div className={styles.counter}>
                    <span className={styles.counterNum}>{collectionStats.checked}</span>
                    <span className={styles.counterKey}>Проверено</span>
                  </div>
                  <div className={styles.counter}>
                    <span className={styles.counterNum}>{collectionStats.accepted}</span>
                    <span className={styles.counterKey}>Принято</span>
                  </div>
                </div>
              )}

              {progress.length > 0 && (
                <ul className={styles.log}>
                  {progress.slice(-4).map((line, i) => <li key={i}>{line}</li>)}
                </ul>
              )}
            </div>
          </section>
        )}

        {/* --- живой борд во время быстрого сбора --- */}
        {!profile && workingUniversity && loading === "profile" && quickPhotos.length > 0 && (
          <div className={styles.inner}>
            {livePlates.map((plate) => (
              <Movement key={plate.category} plate={plate} onOpen={openShot} />
            ))}
          </div>
        )}

        {/* --- профиль --- */}
        {profile && (
          <>
            <Cover
              university={profile.university}
              photos={profile.photos}
              mode={profile.mode}
              meta={coverMeta}
              onOpen={openShot}
            />

            <div className={styles.inner}>
              {/* Без описания двухколоночный лид оставил бы половину полосы пустой,
                  поэтому факты разворачиваются в разлинованную ленту во всю ширину. */}
              <section className={lede ? styles.lede : styles.ledeBare}>
                {lede && (
                  <div>
                    <p className={styles.ledeText}>{lede}</p>
                    {ledeTail && <p className={styles.ledeTail}>{ledeTail}</p>}
                  </div>
                )}
                  <div className={lede ? styles.factList : styles.colophonGrid}>
                    <div className={styles.factRow}>
                      <span className={styles.factKey}>Город</span>
                      <span className={styles.factValue}>{profile.university.city ?? "неизвестен"}</span>
                    </div>
                    <div className={styles.factRow}>
                      <span className={styles.factKey}>Страна</span>
                      <span className={styles.factValue}>{profile.university.country ?? "неизвестна"}</span>
                    </div>
                    <div className={styles.factRow}>
                      <span className={styles.factKey}>Официальные</span>
                      <span className={styles.factValue}>{profile.sources.official}</span>
                    </div>
                    <div className={styles.factRow}>
                      <span className={styles.factKey}>Глазами людей</span>
                      <span className={styles.factValue}>{profile.sources.visitors}</span>
                    </div>
                    <div className={styles.factRow}>
                      <span className={styles.factKey}>Commons</span>
                      <span className={styles.factValue}>{profile.sources.commons}</span>
                    </div>
                    <div className={styles.factRow}>
                      <span className={styles.factKey}>Сбор</span>
                      <span className={styles.factValue}>
                        {profile.stopReason === "deadline_reached" ? "по лимиту времени" : "источники исчерпаны"}
                      </span>
                    </div>
                  </div>
              </section>
            </div>

            {/* --- быстрый взгляд --- */}
            {profile.mode === "quick" ? (
              <>
                <div className={styles.inner}>
                  {quickPlates.map((plate) => <Movement key={plate.category} plate={plate} onOpen={openShot} />)}

                  {quickMissing.length > 0 && (
                    <div className={styles.absent}>
                      <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>Не нашлось за отведённое время</span>
                      <p className={styles.absentLine}>
                        {quickMissing.map((c) => CATEGORY_LABELS[c]).join(" · ")}
                        {". "}
                        Пустое место честнее выдуманного: профиль показывает только то, что действительно
                        нашлось и прошло проверку. В полном архиве поиск идёт дольше и глубже.
                      </p>
                    </div>
                  )}
                </div>

                <section className={styles.invite}>
                  <div className={styles.inviteInner}>
                    <div>
                      <span className={`${styles.eyebrow} ${styles.eyebrowOnInk}`}>Это был быстрый взгляд</span>
                      <h2 className={styles.inviteTitle}>Открыть архив целиком</h2>
                    </div>
                    <div>
                      <p className={styles.inviteText}>
                        Больше фотографий и категорий, разбор по происхождению снимков, отзывы посетителей,
                        карта кампуса с измеренными расстояниями и контекст города — климат, транспорт, цены.
                      </p>
                      <button
                        type="button"
                        className={styles.inviteAction}
                        disabled={loading !== "idle" || !lastQid}
                        onClick={() => lastQid && loadProfile(lastQid, "deep")}
                      >
                        {loading === "profile" ? "Собираю…" : "Deep Dive"}
                        <span aria-hidden="true">→</span>
                      </button>
                    </div>
                  </div>
                </section>
              </>
            ) : (
              <>
                {/* --- навигация по категориям полного архива --- */}
                <nav className={styles.catNav} aria-label="Категории">
                  <div className={styles.catNavInner}>
                    <button
                      type="button"
                      className={`${styles.catLink} ${catFilter === "all" ? styles.catLinkActive : ""}`}
                      onClick={() => setCatFilter("all")}
                    >
                      Всё<span className={styles.catCount}>{profile.photos.length}</span>
                    </button>
                    {ALL_CATEGORIES.map((cat) => {
                      const n = countIn(cat);
                      return (
                        <button
                          key={cat}
                          type="button"
                          disabled={n === 0}
                          className={`${styles.catLink} ${catFilter === cat ? styles.catLinkActive : ""}`}
                          onClick={() => setCatFilter(cat)}
                        >
                          {CATEGORY_LABELS[cat]}<span className={styles.catCount}>{n}</span>
                        </button>
                      );
                    })}
                  </div>
                </nav>

                <div className={styles.inner}>
                  <header className={styles.chapterHead}>
                    <div>
                      <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>Полный архив</span>
                      <h2 className={styles.chapterTitle}>
                        {CATEGORY_LABELS[catFilter as Category] ?? "Всё, что нашлось"}
                        <span className={styles.chapterCount}>{deepPhotos.length}</span>
                      </h2>
                    </div>
                    <div>
                      <p className={styles.chapterNote}>
                        Архив собран по категориям: смотреть идут «библиотеку», а не «официальные снимки
                        библиотеки». Происхождение каждого кадра видно в просмотрщике, а отобрать снимки
                        одного вида доказательства можно здесь.
                      </p>
                      <div className={styles.lenses}>
                        <button
                          type="button"
                          className={`${styles.lens} ${srcFilter === "all" ? styles.lensActive : ""}`}
                          onClick={() => setSrcFilter("all")}
                        >
                          Все источники<span className={styles.catCount}>{visible.length}</span>
                        </button>
                        {SOURCE_LENSES.map((lens) => {
                          const n = visible.filter((p) => p.source === lens.key).length;
                          return (
                            <button
                              key={lens.key}
                              type="button"
                              disabled={n === 0}
                              className={`${styles.lens} ${srcFilter === lens.key ? styles.lensActive : ""}`}
                              onClick={() => setSrcFilter(lens.key)}
                            >
                              {lens.label}<span className={styles.catCount}>{n}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </header>

                  {deepPlates.length > 0 ? (
                    deepPlates.map((plate) => <Movement key={plate.category} plate={plate} onOpen={openShot} />)
                  ) : (
                    <p className={styles.chapterEmpty}>
                      По этому сочетанию категории и источника снимков нет. Снимите фильтр, чтобы увидеть
                      остальной архив.
                    </p>
                  )}

                  {deepMissing.length > 0 && catFilter === "all" && (
                    <div className={styles.absent}>
                      <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>Не нашлось</span>
                      <p className={styles.absentLine}>
                        {deepMissing.map((c) => CATEGORY_LABELS[c]).join(" · ")}
                        {". "}
                        Эти категории остались пустыми даже при глубоком сборе: подходящих снимков
                        не нашлось в источниках либо они не прошли проверку.
                      </p>
                    </div>
                  )}

                  {/* Разбор происхождения: три вида доказательства, объяснённые один раз,
                      а не повторённые в каждой категории. */}
                  <section className={styles.chapter}>
                    <header className={styles.chapterHead}>
                      <div>
                        <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>Происхождение</span>
                        <h2 className={styles.chapterTitle}>Три вида доказательства</h2>
                      </div>
                      <p className={styles.chapterNote}>
                        Снимки попадают в профиль разными путями, и доказывают они разное. Ниже — чем
                        именно подтверждён каждый вид и сколько таких кадров в этом профиле.
                      </p>
                    </header>
                    <div className={styles.context}>
                      {SOURCE_LENSES.map((lens) => {
                        const n = profile.photos.filter((p) => p.source === lens.key).length;
                        return (
                          <div className={styles.contextCol} key={lens.key}>
                            <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>{lens.label}</span>
                            <span className={styles.contextFigure}>{n}</span>
                            <p>{lens.note}</p>
                          </div>
                        );
                      })}
                    </div>
                  </section>

                  {profile.anchor && (
                    <section className={styles.chapter}>
                      <header className={styles.chapterHead}>
                        <div>
                          <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>Глава 06</span>
                          <h2 className={styles.chapterTitle}>
                            Кампус на карте
                            <span className={styles.chapterCount}>{profile.mapPoints.length} мест</span>
                          </h2>
                        </div>
                        <p className={styles.chapterNote}>
                          Реальная точка кампуса, места с найденными фотографиями и расстояния по прямой.
                          Центр города отмечен отдельно.
                        </p>
                      </header>
                      <div style={{ paddingTop: "clamp(20px,2.5vw,40px)" }}>
                        <CampusMap anchor={profile.anchor} points={profile.mapPoints} cityCenter={profile.cityCenter} />
                        {profile.cityCenter && (
                          <p className={styles.chapterNote} style={{ paddingTop: 12 }}>
                            Координаты центра города — <a className={styles.link} href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© участники OpenStreetMap</a>, лицензия ODbL.
                          </p>
                        )}
                      </div>
                    </section>
                  )}

                  {profile.deepContext && (
                    <section className={styles.chapter}>
                      <header className={styles.chapterHead}>
                        <div>
                          <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>Глава 07</span>
                          <h2 className={styles.chapterTitle}>Город для жизни</h2>
                        </div>
                        <p className={styles.chapterNote}>
                          Ориентиры из открытых данных. Расстояния до остановок измерены по прямой;
                          расписание и маршруты здесь не проверяются.
                        </p>
                      </header>
                      <div className={styles.context}>
                        <div className={styles.contextCol}>
                          <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>Климат</span>
                          {profile.deepContext.climate ? (
                            <>
                              <span className={styles.contextFigure}>
                                Зима {profile.deepContext.climate.winterC}° · лето {profile.deepContext.climate.summerC}°
                              </span>
                              <p>
                                Средняя температура за {profile.deepContext.climate.years}; осадки около{" "}
                                {profile.deepContext.climate.annualPrecipitationMm} мм в год.
                              </p>
                              <a className={styles.link} href={profile.deepContext.climate.sourceUrl} target="_blank" rel="noreferrer">
                                Исторические данные Open-Meteo ↗
                              </a>
                            </>
                          ) : <p>Данные о климате пока недоступны.</p>}
                        </div>

                        <div className={styles.contextCol}>
                          <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>Транспорт</span>
                          {profile.deepContext.transport.length > 0 ? (
                            <>
                              <span className={styles.contextFigure}>Остановки рядом</span>
                              <ul className={styles.contextList}>
                                {profile.deepContext.transport.slice(0, 5).map((stop, i) => (
                                  <li key={`${stop.name}-${i}`}>
                                    <span>{stop.name} · {stop.kind}</span>
                                    <small>{formatDistance(stop.distanceM)}</small>
                                  </li>
                                ))}
                              </ul>
                              {profile.deepContext.transportSourceUrl && (
                                <a className={styles.link} href={profile.deepContext.transportSourceUrl} target="_blank" rel="noreferrer">
                                  Данные {profile.deepContext.transportSourceUrl.includes("google.com") ? "Google Maps" : "OpenStreetMap"} ↗
                                </a>
                              )}
                            </>
                          ) : <p>Остановки не найдены или картографический источник не ответил.</p>}
                        </div>

                        <div className={styles.contextCol}>
                          <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>Стоимость жизни</span>
                          {profile.deepContext.livingCosts ? (
                            <>
                              <span className={styles.contextFigure}>{profile.deepContext.livingCosts.city}</span>
                              <ul className={styles.contextList}>
                                {profile.deepContext.livingCosts.items.map((item) => (
                                  <li key={item.label}>
                                    <span>{item.label}</span>
                                    <small>≈ {Math.round(item.average)} {profile.deepContext!.livingCosts!.currency} {item.unit}</small>
                                  </li>
                                ))}
                              </ul>
                              <a className={styles.link} href="https://www.numbeo.com/cost-of-living/" target="_blank" rel="noreferrer">
                                Источник: Numbeo{profile.deepContext.livingCosts.updated ? ` · обновлено ${profile.deepContext.livingCosts.updated}` : ""} ↗
                              </a>
                            </>
                          ) : <p>Проверенная оценка для этого города недоступна. Цены не рассчитываются без лицензированного источника.</p>}
                        </div>
                      </div>
                    </section>
                  )}

                  {profile.reviews.length > 0 && (
                    <Quotes reviews={profile.reviews} placeName={profile.reviewsPlaceName} />
                  )}

                  {/* --- колофон: как собран профиль --- */}
                  <section className={styles.colophon}>
                    <header className={styles.chapterHead}>
                      <div>
                        <span className={`${styles.eyebrow} ${styles.eyebrowMuted}`}>Колофон</span>
                        <h2 className={styles.chapterTitle}>Как собран этот профиль</h2>
                      </div>
                      <p className={styles.chapterNote}>
                        Что было найдено, что отсеяно и по какой причине. Ни одна из этих цифр
                        не выводится задним числом: все они получены во время сбора.
                      </p>
                    </header>
                    <div className={styles.colophonGrid}>
                      <div className={`${styles.colRow} ${styles.colophonWide}`}>
                        <span className={styles.colKey}>Якорь координат</span>
                        <span className={styles.colVal}>{ANCHOR_LABELS[profile.anchor?.source ?? "none"]}</span>
                      </div>
                      {profile.anchor?.observations.map((point) => (
                        <div className={`${styles.colRow} ${styles.colophonWide}`} key={point.source}>
                          <span className={styles.colKey}>
                            {point.source === "places" ? "Google Places" : point.source === "2gis" ? "2ГИС" : "Wikidata"}
                          </span>
                          <span className={styles.colVal}>
                            {point.name}{point.address ? `, ${point.address}` : ""} · {point.lat.toFixed(5)}, {point.lon.toFixed(5)}
                            {point.distanceM > 0 ? ` · ${formatDistance(point.distanceM)} до якоря` : ""}
                          </span>
                        </div>
                      ))}
                      {([
                        ["С сайта вуза", profile.sources.official],
                        ["Из Google Places", profile.sources.visitors],
                        ["Из Wikimedia Commons", profile.sources.commons],
                        ["Дубликатов убрано", profile.removed.duplicates],
                        ["Не по теме", profile.removed.irrelevant],
                        ["Размытых", profile.removed.blurry],
                        ["Мельче минимума", profile.removed.tooSmall],
                        ["Не загрузилось", profile.removed.failedDownload],
                        ["Сверх лимита на сайт", profile.removed.overSiteLimit],
                        ["Сверх лимита категории", profile.removed.overCategoryLimit],
                        ["Дальше пешей доступности", profile.removed.farFromCampus],
                        ["Город крупным планом", profile.removed.cityNotWide],
                      ] as const).map(([key, value]) => (
                        <div className={styles.colRow} key={key}>
                          <span className={styles.colKey}>{key}</span>
                          <span className={styles.colVal}>{value}</span>
                        </div>
                      ))}
                      {!profile.visionAvailable && (
                        <div className={`${styles.colRow} ${styles.colophonWide}`}>
                          <span className={styles.colKey}>Vision</span>
                          <span className={styles.colVal}>содержимое снимков не проверялось</span>
                        </div>
                      )}
                    </div>

                    {profile.warnings.length > 0 && (
                      <ul className={styles.warnings}>
                        {profile.warnings.map((w, i) => <li key={i}>{w}</li>)}
                      </ul>
                    )}
                  </section>
                </div>
              </>
            )}
          </>
        )}
      </main>

      {selected && (
        <Lightbox
          photo={selected.photo}
          set={selected.set}
          onSelect={(p) => setSelected((prev) => (prev ? { ...prev, photo: p } : prev))}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
