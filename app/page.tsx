// app/page.tsx
// Визуальный профиль университета.
//
// Профиль разделён по происхождению снимков, потому что это разные виды
// доказательства, а не разные вкладки:
//   • официальные — опубликованы на домене вуза; провенанс доказан доменом;
//   • глазами людей — загружены посетителями в Google Places; провенанс
//     доказан расстоянием до якоря кампуса;
//   • вокруг кампуса — окружение в пешей доступности, не объекты вуза.
//
// Ни одна подпись здесь не утверждает того, чего не проверял код: бейдж
// показывает уровень доверия и измеренное расстояние, панель доказательств —
// список реально выполненных проверок из evidence.reasons.

"use client";

import { useEffect, useState } from "react";
import styles from "./page.module.css";
import {
  ALL_CATEGORIES,
  CATEGORY_LABELS,
  type Anchor,
  type Category,
  type CityCenter,
  type MapPoint,
  type PhotoItem,
  type PlaceReview,
  type Profile,
  type ProgressEvent,
  type TrustTier,
  type UniversityCandidate,
} from "@/lib/types";

const TRUST_LABELS: Record<TrustTier, string> = {
  verified: "Подтверждено",
  probable: "Вероятно",
  unverified: "Не подтверждено",
};

const TRUST_CLASS: Record<TrustTier, string> = {
  verified: styles.badgeVerified,
  probable: styles.badgeProbable,
  unverified: styles.badgeUnverified,
};

const ANCHOR_LABELS: Record<string, string> = {
  wikidata: "Wikidata",
  places: "Google Places (без подтверждения)",
  "places+2gis": "Google Places, подтверждено 2ГИС",
  none: "не найдены",
};

const EXAMPLES = ["Назарбаев Университет", "КазНУ имени аль-Фараби", "Казахская национальная академия искусств"];

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
      return `Проверяю содержимое: ${e.batches} запрос(ов) к модели…`;
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

function badgeText(p: PhotoItem): string {
  const parts = [p.category === "citywide" ? CITY_TRUST_LABELS[p.trust] : TRUST_LABELS[p.trust]];
  if (p.evidence.distanceM !== null) parts.push(`${formatDistance(p.evidence.distanceM)} от кампуса`);
  if (!p.evidence.vision) parts.push("содержимое не проверено");
  return parts.join(" · ");
}

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
      return 3;
    case "done":
      return 4;
  }
}

function Steps({ current }: { current: number }) {
  return (
    <ol className={styles.steps}>
      {STEPS.map((label, i) => (
        <li
          key={label}
          className={`${styles.step} ${i < current ? styles.stepDone : ""} ${i === current ? styles.stepNow : ""}`}
        >
          <span className={styles.stepNum}>{i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

function PhotoCard({ photo, onOpen }: { photo: PhotoItem; onOpen: (p: PhotoItem) => void }) {
  return (
    <figure className={styles.card}>
      <button type="button" className={styles.thumbButton} onClick={() => onOpen(photo)}>
        {/* next/image здесь не подходит: адреса снимков внешние, короткоживущие и
            заранее неизвестны, а оптимизация чужих URL ничего не даёт. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className={styles.thumb}
          src={photo.imageUrl}
          alt={photo.evidence.vision?.caption ?? photo.evidence.placeName}
          loading="lazy"
        />
      </button>
      <figcaption className={styles.caption}>
        <span className={`${styles.badge} ${TRUST_CLASS[photo.trust]}`}>{badgeText(photo)}</span>
        <span className={styles.place}>{placeLine(photo)}</span>
        {photo.evidence.vision && <span>{photo.evidence.vision.caption}</span>}
        {photo.evidence.address && <span className={styles.dim}>{photo.evidence.address}</span>}
        <span className={styles.captionLinks}>
          {photo.sourceUrl ? (
            <a className={styles.link} href={photo.sourceUrl} target="_blank" rel="noreferrer">Источник</a>
          ) : (
            <span className={styles.dim}>источник недоступен</span>
          )}
          {photo.attribution[0] && (
            <>
              {" · "}
              {photo.attribution[0].uri ? (
                <a className={styles.link} href={photo.attribution[0].uri} target="_blank" rel="noreferrer">
                  {photo.attribution[0].name}
                </a>
              ) : (
                photo.attribution[0].name
              )}
            </>
          )}
        </span>
        <span className={styles.dim}>
          {photo.publishedAt
            ? `опубликовано ${formatRetrieved(photo.publishedAt)}`
            : "дата публикации неизвестна"}
          {" · получено "}
          {formatRetrieved(photo.retrievedAt)}
        </span>
      </figcaption>
    </figure>
  );
}

/**
 * План кампуса: места, давшие снимки, относительно якоря координат.
 *
 * Это не карта местности, а изображение самой проверки: кольца — те самые пороги
 * доверия, расстояния — те самые измеренные значения. Поэтому здесь нет подложки с
 * тайлами: чужие плитки потребовали бы отдельной лицензии и ничего бы не доказали.
 */
function MapPlan({ anchor, points, cityCenter }: { anchor: Anchor; points: MapPoint[]; cityCenter: CityCenter | null }) {
  const size = 440;
  const half = size / 2;
  const maxDistance = Math.max(600, ...points.map((p) => p.distanceM));
  const extent = maxDistance * 1.25;
  const scale = (half - 28) / extent;

  // Равнопромежуточная проекция вокруг якоря: на масштабе в километры её искажения
  // меньше размера точки, а зависимостей она не требует.
  const project = (lat: number, lon: number) => {
    const mPerDegLat = 111_320;
    const mPerDegLon = 111_320 * Math.cos((anchor.lat * Math.PI) / 180);
    return { dx: (lon - anchor.lon) * mPerDegLon, dy: -(lat - anchor.lat) * mPerDegLat };
  };

  const rings = [1500, 6000].filter((r) => r <= extent);

  return (
    <div className={styles.mapWrap}>
      <svg viewBox={`0 0 ${size} ${size}`} className={styles.map} role="img" aria-label="План мест вокруг кампуса">
        <rect width={size} height={size} rx="12" className={styles.mapBg} />
        {rings.map((r) => (
          <g key={r}>
            <circle cx={half} cy={half} r={r * scale} className={styles.mapRing} />
            <text x={half} y={half - r * scale - 5} className={styles.mapRingLabel} textAnchor="middle">
              {r >= 1000 ? `${r / 1000} км` : `${r} м`}
            </text>
          </g>
        ))}
        {cityCenter && (() => {
          // Центр города почти всегда дальше края плана: показываем направление на него
          // лучом к границе и подписываем измеренное расстояние.
          const { dx, dy } = project(cityCenter.lat, cityCenter.lon);
          const len = Math.hypot(dx, dy) || 1;
          // Если центр города попадает в масштаб плана — рисуем его на своём месте.
          // Если нет (обычно так и бывает) — упираем луч в край: направление честное,
          // расстояние написано цифрой.
          const maxR = half - 34;
          const r = Math.min(len * scale, maxR);
          const x = half + (dx / len) * r;
          const y = half + (dy / len) * r;
          return (
            <g>
              <line x1={half} y1={half} x2={x} y2={y} className={styles.mapCityLine} />
              <circle cx={x} cy={y} r="4" className={styles.mapCityDot} />
              <text x={x} y={y - 9} className={styles.mapCityLabel} textAnchor="middle">
                центр · {cityCenter.distanceM >= 1000 ? `${(cityCenter.distanceM / 1000).toFixed(1)} км` : `${cityCenter.distanceM} м`}
              </text>
            </g>
          );
        })()}
        {points.map((p) => {
          const { dx, dy } = project(p.lat, p.lon);
          const x = half + dx * scale;
          const y = half + dy * scale;
          return (
            <g key={p.placeId}>
              <circle cx={x} cy={y} r={4 + Math.min(p.photos, 3)} className={styles.mapDot} />
              <title>{`${p.name} — ${p.distanceM} м, снимков: ${p.photos}`}</title>
            </g>
          );
        })}
        <g>
          <circle cx={half} cy={half} r="6" className={styles.mapAnchor} />
          <text x={half} y={half + 20} className={styles.mapAnchorLabel} textAnchor="middle">кампус</text>
        </g>
      </svg>
      <ul className={styles.mapLegend}>
        {points
          .slice()
          .sort((a, b) => a.distanceM - b.distanceM)
          .slice(0, 6)
          .map((p) => (
            <li key={p.placeId}>
              <span className={styles.dim}>{p.distanceM >= 1000 ? `${(p.distanceM / 1000).toFixed(1)} км` : `${p.distanceM} м`}</span> {p.name}
            </li>
          ))}
      </ul>
    </div>
  );
}

/**
 * Отзывы о кампусе из Google Places.
 *
 * Кейс упоминает «отзывы студентов» среди дополнительных функций, но платформа не
 * сообщает, кем является автор. Поэтому заголовок говорит ровно то, что проверено:
 * это отзывы посетителей места. Зато у них есть настоящая дата публикации —
 * единственный материал в профиле, где она вообще существует.
 */
/** Возраст материала словами. Дата сама по себе мало говорит, а «три года назад»
 *  сразу отвечает на вопрос «это про сейчас или про давно». */
function ageNote(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const years = (Date.now() - t) / (365.25 * 24 * 3600 * 1000);
  if (years < 1) return " · меньше года назад";
  const whole = Math.floor(years);
  const word = whole === 1 ? "год" : whole < 5 ? "года" : "лет";
  return ` · ${whole} ${word} назад`;
}

function Reviews({ reviews, placeName }: { reviews: PlaceReview[]; placeName: string | null }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Отзывы посетителей</h2>
        <span className={styles.sectionCount}>{reviews.length}</span>
      </div>
      <p className={styles.sectionNote}>
        Отзывы о месте «{placeName ?? "кампус"}» из Google Places, с датой публикации. Кто их автор — студент,
        сотрудник или гость — платформа не сообщает, поэтому студенческими мы их не называем.
      </p>
      <ul className={styles.reviewList}>
        {reviews.map((r, i) => (
          <li key={i} className={styles.review}>
            <div className={styles.reviewHead}>
              {r.authorUri ? (
                <a className={styles.link} href={r.authorUri} target="_blank" rel="noreferrer">{r.author}</a>
              ) : (
                <span>{r.author}</span>
              )}
              {r.rating !== null && <span className={styles.dim}>{r.rating} из 5</span>}
              {r.publishedAt && (
                <span className={styles.dim}>
                  {formatRetrieved(r.publishedAt)}
                  {ageNote(r.publishedAt)}
                </span>
              )}
            </div>
            <p className={styles.reviewText}>{r.text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Быстрый взгляд: по одному-двум снимкам на категорию, всё на одном экране.
 *
 * Здесь профиль сгруппирован по категориям, а не по источнику: задача этого экрана —
 * показать, как вуз выглядит целиком, за несколько секунд. Разбор по происхождению
 * снимков ждёт в полном профиле, но уровень доверия виден и тут: скрывать его нельзя
 * ни на каком экране.
 */
function QuickBoard({ photos, onOpen }: { photos: PhotoItem[]; onOpen: (p: PhotoItem) => void }) {
  const groups = ALL_CATEGORIES.map((c) => ({ category: c, items: photos.filter((p) => p.category === c) })).filter(
    (g) => g.items.length > 0,
  );
  return (
    <div className={styles.board}>
      {groups.map((g) => (
        <section key={g.category} className={styles.boardGroup}>
          <h3 className={styles.groupLabel}>{CATEGORY_LABELS[g.category]}</h3>
          <div className={styles.boardGrid}>
            {g.items.map((p) => <PhotoCard key={p.id} photo={p} onOpen={onOpen} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Секция профиля: снимки одного происхождения, внутри — группы по категориям. */
function Section({
  title,
  note,
  photos,
  groupByCategory,
  emptyText,
  onOpen,
}: {
  title: string;
  note: string;
  photos: PhotoItem[];
  groupByCategory: boolean;
  emptyText: string;
  onOpen: (p: PhotoItem) => void;
}) {
  const groups = groupByCategory
    ? ALL_CATEGORIES.map((c) => ({ category: c, items: photos.filter((p) => p.category === c) })).filter((g) => g.items.length > 0)
    : [{ category: null, items: photos }];

  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        <span className={styles.sectionCount}>{photos.length}</span>
      </div>
      <p className={styles.sectionNote}>{note}</p>
      {photos.length === 0 ? (
        <p className={styles.empty}>{emptyText}</p>
      ) : (
        groups.map((g) => (
          <div key={g.category ?? "all"}>
            {g.category && <h3 className={styles.groupLabel}>{CATEGORY_LABELS[g.category]} · {g.items.length}</h3>}
            <div className={styles.grid}>
              {g.items.map((p) => <PhotoCard key={p.id} photo={p} onOpen={onOpen} />)}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

export default function Home() {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<UniversityCandidate[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [catFilter, setCatFilter] = useState<Category | "all">("all");
  const [selected, setSelected] = useState<PhotoItem | null>(null);
  const [loading, setLoading] = useState<"idle" | "resolve" | "profile">("idle");
  const [progress, setProgress] = useState<string[]>([]);
  const [stage, setStage] = useState<ProgressEvent["stage"] | null>(null);
  const [lastQid, setLastQid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Панель доказательств закрывается по Esc: её открывают десятки раз подряд,
  // и каждый раз тянуться к кнопке мышью неудобно.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  async function runSearch(text: string) {
    setError(null);
    setProfile(null);
    setCandidates([]);
    setSelected(null);
    setLoading("resolve");
    try {
      const res = await fetch(`/api/resolve?q=${encodeURIComponent(text)}`);
      const json = (await res.json()) as { candidates: UniversityCandidate[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.candidates.length === 0) {
        setError("Университет не найден. Попробуйте другое написание или название на английском.");
      } else if (json.candidates.length === 1) {
        await loadProfile(json.candidates[0].qid);
      } else {
        setCandidates(json.candidates);
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
    setLoading("profile");
    setLastQid(qid);
    // При углублении уже показанный профиль остаётся на экране: пользователь нажал
    // «подробнее», а не «начать заново», и терять картинку на двадцать секунд незачем.
    if (mode === "quick") setProfile(null);
    try {
      const res = await fetch(`/api/profile?qid=${qid}&mode=${mode}`);
      if (!res.ok || !res.body) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
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
            setStage(event.stage);
            setProgress((prev) => [...prev, progressText(event)]);
          } else if (msg.type === "profile") {
            // Поле type — служебное для потока NDJSON; на профиль оно не влияет.
            setProfile(msg as unknown as Profile);
            setCatFilter("all");
          } else if (msg.type === "error") {
            throw new Error(String(msg.error));
          }
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading("idle");
    }
  }

  const visible = profile
    ? profile.photos.filter((p) => catFilter === "all" || p.category === catFilter)
    : [];
  // «Вокруг кампуса» и «Город» выносятся из секций по источнику: у них другое
  // утверждение — это не объекты вуза, и мешать их с кампусом нельзя.
  const isPlace = (p: PhotoItem) => p.category !== "city" && p.category !== "citywide";
  const official = visible.filter((p) => p.source === "official_site" && isPlace(p));
  const visitors = visible.filter((p) => p.source === "google_places" && isPlace(p));
  const around = visible.filter((p) => p.category === "city");
  const cityPhotos = visible.filter((p) => p.category === "citywide");
  const countIn = (c: Category) => (profile ? profile.photos.filter((p) => p.category === c).length : 0);

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <div className={styles.topbarInner}>
          <div className={styles.brand}>
            Shyngan
            <span className={styles.brandNote}>визуальный профиль университета</span>
          </div>
          <form className={styles.search} onSubmit={onSubmit}>
            <input
              id="university-query"
              className={styles.input}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Название университета"
              aria-label="Название университета"
            />
            <button type="submit" className={styles.submit} disabled={loading !== "idle"}>
              {loading === "idle" ? "Найти" : "Ищу…"}
            </button>
          </form>
        </div>
      </header>

      <main className={styles.inner}>
        {!profile && loading === "idle" && candidates.length === 0 && !error && (
          <section className={styles.hero}>
            <h1 className={styles.heroTitle}>Не просто фотографии вуза, а причина им верить</h1>
            <p className={styles.heroText}>
              Сервис собирает снимки кампуса из открытых источников, проверяет каждый — расстояние до кампуса,
              содержимое кадра, дубликаты — и показывает результат проверки рядом с фотографией. Если подтвердить
              снимок нечем, так и написано.
            </p>
            <div className={styles.examples}>
              {EXAMPLES.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={styles.example}
                  onClick={() => {
                    setQuery(name);
                    void runSearch(name);
                  }}
                >
                  {name}
                </button>
              ))}
            </div>
          </section>
        )}

        {error && <p className={styles.error}>{error}</p>}

        {loading === "profile" && (
          <div className={styles.progress}>
            <div className={styles.progressTitle}>
              {profile ? "Собираю полный профиль — это дольше быстрого взгляда" : "Собираю профиль — обычно менее 30 секунд"}
            </div>
            <Steps current={stepOf(stage)} />
            <ul className={styles.progressList}>
              {progress.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          </div>
        )}

        {candidates.length > 1 && (
          <section className={styles.candidates}>
            <h2 className={styles.sectionTitle}>Уточните, какой университет</h2>
            {candidates.map((c) => (
              <button key={c.qid} className={styles.candidate} onClick={() => loadProfile(c.qid)}>
                <strong>{c.label}</strong>
                <span className={styles.candidateMeta}>
                  {[c.city, c.country, c.instanceOf].filter(Boolean).join(", ") || "сведений о расположении нет"} · {c.qid}
                </span>
              </button>
            ))}
          </section>
        )}

        {profile && (
          <>
            <section className={styles.profileHead}>
              <h1 className={styles.uniName}>{profile.university.label}</h1>
              <div className={styles.uniMeta}>
                <span>
                  {profile.university.city ?? "город неизвестен"}
                  {profile.university.country ? `, ${profile.university.country}` : ""}
                </span>
                <span className={styles.dot}>
                  {profile.university.officialWebsite ? (
                    <a className={styles.link} href={profile.university.officialWebsite} target="_blank" rel="noreferrer">
                      официальный сайт
                    </a>
                  ) : (
                    "официальный сайт неизвестен"
                  )}
                </span>
                <span className={styles.dot}>
                  {profile.photos.length} фото за {(profile.timingMs / 1000).toFixed(1)} с
                </span>
                {profile.cityCenter && (
                  <span className={styles.dot}>
                    до центра города — {formatDistance(profile.cityCenter.distanceM)}
                  </span>
                )}
              </div>
              <p className={styles.description}>{profile.description}</p>

              <details className={styles.audit}>
                <summary className={styles.auditSummary}>Как собран этот профиль</summary>
                <div className={styles.auditGrid}>
                  <span>Якорь координат: {ANCHOR_LABELS[profile.anchor?.source ?? "none"]}</span>
                  <span>С сайта вуза: {profile.sources.official}</span>
                  <span>Из Google Places: {profile.sources.visitors}</span>
                  <span>Дубликатов убрано: {profile.removed.duplicates}</span>
                  <span>Не по теме: {profile.removed.irrelevant}</span>
                  <span>Размытых: {profile.removed.blurry}</span>
                  <span>Мельче минимума: {profile.removed.tooSmall}</span>
                  <span>Не загрузилось: {profile.removed.failedDownload}</span>
                  <span>Сверх лимита на сайт: {profile.removed.overSiteLimit}</span>
                  <span>Сверх лимита категории: {profile.removed.overCategoryLimit}</span>
                  <span>Дальше пешей доступности: {profile.removed.farFromCampus}</span>
                  <span>Город крупным планом: {profile.removed.cityNotWide}</span>
                  {!profile.visionAvailable && <span>Содержимое снимков не проверялось</span>}
                </div>
              </details>

              {profile.warnings.length > 0 && (
                <ul className={styles.warnings}>
                  {profile.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </section>

            {profile.anchor && profile.mapPoints.length > 0 && (
              <section className={styles.section}>
                <div className={styles.sectionHead}>
                  <h2 className={styles.sectionTitle}>План кампуса</h2>
                  <span className={styles.sectionCount}>{profile.mapPoints.length} мест</span>
                </div>
                <p className={styles.sectionNote}>
                  Места, давшие снимки, и измеренные до них расстояния. Кольцо — порог подтверждения:
                  внутри 1,5 км снимок считается подтверждённым. Масштаб подстраивается под самое
                  дальнее место, поэтому кольцо в 6 км видно не всегда.
                  {profile.cityCenter && ` Луч показывает направление на центр города (${profile.cityCenter.name}).`}
                </p>
                <MapPlan anchor={profile.anchor} points={profile.mapPoints} cityCenter={profile.cityCenter} />
                {profile.cityCenter && (
                  <p className={styles.attribution}>
                    Координаты центра города — <a className={styles.link} href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© участники OpenStreetMap</a>, лицензия ODbL.
                  </p>
                )}
              </section>
            )}

            <div className={styles.filters}>
              <button
                type="button"
                className={`${styles.chip} ${catFilter === "all" ? styles.chipActive : ""}`}
                onClick={() => setCatFilter("all")}
              >
                Все категории<span className={styles.chipCount}>{profile.photos.length}</span>
              </button>
              {ALL_CATEGORIES.map((cat) => {
                const n = countIn(cat);
                return (
                  <button
                    key={cat}
                    type="button"
                    disabled={n === 0}
                    className={`${styles.chip} ${catFilter === cat ? styles.chipActive : ""} ${n === 0 ? styles.chipEmpty : ""}`}
                    onClick={() => setCatFilter(cat)}
                  >
                    {CATEGORY_LABELS[cat]}<span className={styles.chipCount}>{n}</span>
                  </button>
                );
              })}
            </div>

            {profile.mode === "quick" ? (
              <>
                <QuickBoard photos={visible} onOpen={setSelected} />
                <section className={styles.deepDive}>
                  <h2 className={styles.sectionTitle}>Это был быстрый взгляд</h2>
                  <p className={styles.sectionNote}>
                    Здесь по одному-два снимка на категорию: так профиль собирается за несколько секунд и не тратит
                    лишних запросов. Полный сбор идёт глубже — больше запросов к картам, обход разделов сайта вуза
                    вместе со страницами новостей, где у снимков есть настоящая дата публикации, и больше фотографий
                    в каждой категории. Занимает примерно вдвое дольше.
                  </p>
                  <button
                    type="button"
                    className={styles.submit}
                    disabled={loading !== "idle" || !lastQid}
                    onClick={() => lastQid && loadProfile(lastQid, "deep")}
                  >
                    {loading === "profile" ? "Собираю…" : "Показать подробно"}
                  </button>
                </section>
              </>
            ) : (
              <>
            <Section
              title="Официальные"
              note="Опубликованы на сайте вуза. Провенанс доказан доменом: снимок лежит на странице самого университета. Про то, кем и когда сделан кадр, сайт ничего не сообщает."
              photos={official}
              groupByCategory
              emptyText="С официального сайта в этот профиль не попало ни одного снимка. Причина — в списке оговорок выше: сайт мог быть недоступен, отдавать картинки скриптом или не иметь фотографий нужного размера."
              onOpen={setSelected}
            />

            <Section
              title="Глазами людей"
              note="Загружены посетителями в Google Places. Провенанс проверяется географически: у каждого снимка измерено расстояние от места до якоря кампуса, и оно указано на карточке."
              photos={visitors}
              groupByCategory
              emptyText="Снимков посетителей по этому фильтру нет."
              onOpen={setSelected}
            />

            <Section
              title="Вокруг кампуса"
              note="Не объекты вуза, а то, что рядом: парки, кафе, улицы в пешей доступности. Всё, что дальше двух километров, в эту секцию не попадает — это уже другой район города."
              photos={around}
              groupByCategory={false}
              emptyText="Рядом с кампусом ничего подтверждённого не нашлось."
              onOpen={setSelected}
            />

            <Section
              title={`Город${profile.university.city ? ` — ${profile.university.city}` : ""}`}
              note="Сам город, в котором находится университет: общие виды — панорамы, перспективы улиц, силуэт города. Крупные планы памятников и вывесок сюда не попадают. Проверяется здесь другое утверждение: не «это объект вуза», а «это тот же город» — по городу из структурного адреса места и по расстоянию от кампуса."
              photos={cityPhotos}
              groupByCategory={false}
              emptyText="Снимков города не нашлось: либо город вуза неизвестен, либо места из городских запросов не прошли проверку."
              onOpen={setSelected}
            />

              </>
            )}

            {profile.reviews.length > 0 && (
              <Reviews reviews={profile.reviews} placeName={profile.reviewsPlaceName} />
            )}
          </>
        )}
      </main>

      {selected && (
        <>
          <button className={styles.backdrop} aria-label="Закрыть" onClick={() => setSelected(null)} />
          <aside className={styles.drawer} aria-label="Доказательства снимка">
            <div className={styles.drawerHead}>
              <h2 className={styles.drawerTitle}>Почему это фото здесь</h2>
              <button type="button" className={styles.close} onClick={() => setSelected(null)}>Закрыть</button>
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={styles.drawerImage} src={selected.imageUrl} alt={selected.evidence.vision?.caption ?? selected.evidence.placeName} />
            <ul className={styles.reasons}>
              {selected.evidence.reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
            <div className={styles.facts}>
              <div className={styles.factRow}>
                <span className={styles.factKey}>Уровень</span>
                <span className={TRUST_CLASS[selected.trust]}>{TRUST_LABELS[selected.trust]}</span>
              </div>
              <div className={styles.factRow}>
                <span className={styles.factKey}>Источник</span>
                <span>{selected.source === "official_site" ? "сайт вуза" : "Google Places"}</span>
              </div>
              <div className={styles.factRow}>
                <span className={styles.factKey}>{selected.source === "official_site" ? "Страница" : "Место"}</span>
                <span>{placeLine(selected)}</span>
              </div>
              {selected.evidence.address && (
                <div className={styles.factRow}>
                  <span className={styles.factKey}>Адрес</span>
                  <span>{selected.evidence.address}</span>
                </div>
              )}
              <div className={styles.factRow}>
                <span className={styles.factKey}>Расстояние</span>
                <span>{selected.evidence.distanceM === null ? "не измерялось" : formatDistance(selected.evidence.distanceM)}</span>
              </div>
              <div className={styles.factRow}>
                <span className={styles.factKey}>Категория</span>
                <span>{CATEGORY_LABELS[selected.category]} {selected.evidence.vision ? "(по содержимому)" : "(по запросу)"}</span>
              </div>
              <div className={styles.factRow}>
                <span className={styles.factKey}>Размер</span>
                <span>{selected.widthPx}×{selected.heightPx}</span>
              </div>
              <div className={styles.factRow}>
                <span className={styles.factKey}>Получено</span>
                <span>{formatRetrieved(selected.retrievedAt)}</span>
              </div>
              <div className={styles.factRow}>
                <span className={styles.factKey}>Публикация</span>
                <span>{selected.publishedAt ? formatRetrieved(selected.publishedAt) : "дата публикации неизвестна"}</span>
              </div>
              {selected.hash && (
                <div className={styles.factRow}>
                  <span className={styles.factKey}>dHash</span>
                  <span className={styles.mono}>{selected.hash}</span>
                </div>
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
