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
import dynamic from "next/dynamic";
import styles from "./page.module.css";
import { cachedProfile, PROFILE_CACHE_TTL_MS, saveProfile } from "@/lib/profile-cache";
import {
  ALL_CATEGORIES,
  QUICK_CATEGORIES,
  CATEGORY_LABELS,
  type Category,
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
  verified: styles.badgeVerified,
  probable: styles.badgeProbable,
  unverified: styles.badgeUnverified,
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

const EXAMPLES = ["Harvard University", "Назарбаев Университет", "КазНУ имени аль-Фараби"];
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
    case "photo":
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

function PhotoCard({ photo, onOpen, compact = false }: { photo: PhotoItem; onOpen: (p: PhotoItem) => void; compact?: boolean }) {
  return (
    <figure className={`${styles.card} ${compact ? styles.cardCompact : ""}`}>
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
        {!compact && photo.evidence.address && <span className={styles.dim}>{photo.evidence.address}</span>}
        <span className={styles.captionLinks}>
          {photo.sourceUrl ? (
            <a className={styles.link} href={photo.sourceUrl} target="_blank" rel="noreferrer">
              {photo.source === "google_places" ? "Фото в Google Maps" : "Источник"}
            </a>
          ) : (
            <span className={styles.dim}>источник недоступен</span>
          )}
          {!compact && photo.attribution[0] && (
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
        {!compact && photo.source === "google_places" && <span className={styles.googleAttribution} translate="no">Google Maps</span>}
        {!compact && photo.license && <a className={styles.link} href={photo.license.url} target="_blank" rel="noreferrer">{photo.license.name}</a>}
        {!compact && <span className={styles.dim}>
          {photo.publishedAt
            ? `опубликовано ${formatRetrieved(photo.publishedAt)}`
            : "дата публикации неизвестна"}
          {" · получено "}
          {formatRetrieved(photo.retrievedAt)}
        </span>}
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
        Из предоставленной сервисом выборки отзывы упорядочены по дате.
      </p>
      <span className={styles.googleAttribution} translate="no">Google Maps</span>
      <ul className={styles.reviewList}>
        {reviews.map((r, i) => (
          <li key={i} className={styles.review}>
            <div className={styles.reviewHead}>
              {r.authorPhotoUri && (
                // eslint-disable-next-line @next/next/no-img-element
                <img className={styles.authorAvatar} src={r.authorPhotoUri} alt="" />
              )}
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
              {r.visitDate && <span className={styles.dim}>посещение {r.visitDate}</span>}
            </div>
            <p className={styles.reviewText}>{r.text}</p>
            {r.sourceUrl && <a className={styles.link} href={r.sourceUrl} target="_blank" rel="noreferrer">Отзыв в Google Maps</a>}
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
  const groups = QUICK_CATEGORIES.map((c) => ({ category: c, items: photos.filter((p) => p.category === c) }));
  return (
    <div className={styles.board}>
      {groups.map((g) => (
        <section key={g.category} className={`${styles.boardGroup} ${g.category === "campus" && g.items.length > 0 ? styles.boardFeatured : ""}`}>
          <h3 className={styles.groupLabel}>{CATEGORY_LABELS[g.category]}</h3>
          <div className={styles.boardGrid}>
            {g.items.length > 0
              ? g.items.map((p) => <PhotoCard key={p.id} photo={p} onOpen={onOpen} compact />)
              : <div className={styles.boardEmpty}>Фото пока не найдено</div>}
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
  const [workingUniversity, setWorkingUniversity] = useState<UniversityCandidate | null>(null);
  const [quickPhotos, setQuickPhotos] = useState<PhotoItem[]>([]);
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
    const searchStartedAt = Date.now();
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
        await loadProfile(candidates[0].qid, "quick", searchStartedAt);
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

  async function loadProfile(qid: string, mode: "quick" | "deep" = "quick", startedAt = Date.now()) {
    setError(null);
    setCandidates([]);
    setProgress([]);
    setStage(null);
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
        return;
      }
      const res = await fetch(`/api/profile?qid=${qid}&mode=${mode}&startedAt=${startedAt}`);
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
            if (event.stage === "photo") {
              setQuickPhotos((prev) => prev.some((p) => p.id === event.photo.id) ? prev : [...prev, event.photo]);
            } else {
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
  const commons = visible.filter((p) => p.source === "wikimedia_commons" && isPlace(p));
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
            <div className={styles.heroCopy}>
              <span className={styles.eyebrow}>ВИЗУАЛЬНЫЙ АТЛАС УНИВЕРСИТЕТОВ</span>
              <h1 className={styles.heroTitle}>Увидеть университет <em>по-настоящему.</em></h1>
              <p className={styles.heroText}>Кампусы, аудитории, библиотеки и повседневная жизнь — реальные фотографии из разных источников. У каждого кадра есть проверка и происхождение.</p>
              <p className={styles.heroHint}>Введите название университета в строку поиска выше или начните с примера:</p>
              <div className={styles.examples}>
                {EXAMPLES.map((name) => (
                  <button key={name} type="button" className={styles.example} onClick={() => { setQuery(name); void runSearch(name); }}>
                    {name} <span aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.heroAside} aria-hidden="true">
              <span className={styles.heroAsideTop}>SHYNGAN / 2026</span>
              <div className={styles.heroAsideWord}>Campus<br /><i>in focus.</i></div>
              <div className={styles.heroAsideFoot}><span>01 / 03</span><span>ПОИСК · БОРД · ПРОФИЛЬ</span></div>
            </div>
          </section>
        )}

        {error && <p className={styles.error}>{error}</p>}

        {loading === "profile" && (
          <div className={styles.progress}>
            <div className={styles.progressTitle}>
              {profile ? "Собираю подробный профиль" : "Проверяю фотографии и заполняю визуальный борд"}
            </div>
            <Steps current={stepOf(stage)} />
            <ul className={styles.progressList}>
              {progress.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          </div>
        )}

        {candidates.length > 0 && (
          <section className={styles.candidates}>
            <h2 className={styles.sectionTitle}>Выберите университет</h2>
            <p>При неоднозначном написании проверьте название перед сбором фотографий.</p>
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

        {!profile && workingUniversity && loading === "profile" && (
          <section className={styles.liveBoard}>
            <div className={styles.liveBoardHead}>
              <span className={styles.eyebrow}>QUICK VISUAL BOARD</span>
              <h2 className={styles.sectionTitle}>{workingUniversity.label}</h2>
              <p>{quickPhotos.length > 0 ? `${quickPhotos.length} проверенных фото уже доступно. Остальные категории ещё собираются.` : "Ищем фотографии в нескольких источниках…"}</p>
            </div>
            <QuickBoard photos={quickPhotos} onOpen={setSelected} />
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
                  {profile.photos.length} фото {profile.cacheAgeMs !== undefined
                    ? "из кэша"
                    : `за ${(profile.timingMs / 1000).toFixed(1)} с`}
                </span>
                {profile.cityCenter && (
                  <span className={styles.dot}>
                    до центра города — {formatDistance(profile.cityCenter.distanceM)}
                  </span>
                )}
              </div>
              <p className={styles.description}>{profile.description}</p>

              {profile.mode === "deep" && <details className={styles.audit}>
                <summary className={styles.auditSummary}>Как собран этот профиль</summary>
                <div className={styles.auditGrid}>
                  <span>Якорь координат: {ANCHOR_LABELS[profile.anchor?.source ?? "none"]}</span>
                  {profile.anchor?.observations.map((point) => (
                    <span key={point.source}>
                      {point.source === "places" ? "Google Places" : point.source === "2gis" ? "2ГИС" : "Wikidata"}: {point.name}
                      {point.address ? `, ${point.address}` : ""} · {point.lat.toFixed(5)}, {point.lon.toFixed(5)}
                      {point.distanceM > 0 ? ` · ${formatDistance(point.distanceM)} до якоря` : ""}
                    </span>
                  ))}
                  <span>С сайта вуза: {profile.sources.official}</span>
                  <span>Из Google Places: {profile.sources.visitors}</span>
                  <span>Из Wikimedia Commons: {profile.sources.commons}</span>
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
              </details>}

              {profile.mode === "deep" && profile.warnings.length > 0 && (
                <ul className={styles.warnings}>
                  {profile.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
            </section>

            {profile.mode === "deep" && profile.anchor && (
              <section className={styles.section}>
                <div className={styles.sectionHead}>
                  <h2 className={styles.sectionTitle}>Кампус на карте</h2>
                  <span className={styles.sectionCount}>{profile.mapPoints.length} мест</span>
                </div>
                <p className={styles.sectionNote}>
                  Реальная точка кампуса, места с найденными фотографиями и расстояния по прямой. Центр города отмечен отдельно.
                </p>
                <CampusMap anchor={profile.anchor} points={profile.mapPoints} cityCenter={profile.cityCenter} />
                {profile.cityCenter && (
                  <p className={styles.attribution}>
                    Координаты центра города — <a className={styles.link} href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© участники OpenStreetMap</a>, лицензия ODbL.
                  </p>
                )}
              </section>
            )}

            {profile.mode === "deep" && profile.deepContext && (
              <section className={styles.section}>
                <div className={styles.sectionHead}><h2 className={styles.sectionTitle}>Город для жизни</h2></div>
                <p className={styles.sectionNote}>Ориентиры из открытых данных. Расстояния до остановок измерены по прямой; расписание и маршруты здесь не проверяются.</p>
                <div className={styles.contextGrid}>
                  <div className={styles.contextCard}>
                    <span className={styles.eyebrow}>КЛИМАТ</span>
                    {profile.deepContext.climate ? <>
                      <strong>Зима {profile.deepContext.climate.winterC}° · лето {profile.deepContext.climate.summerC}°</strong>
                      <p>Средняя температура за {profile.deepContext.climate.years}; осадки около {profile.deepContext.climate.annualPrecipitationMm} мм в год.</p>
                      <a className={styles.link} href={profile.deepContext.climate.sourceUrl} target="_blank" rel="noreferrer">Исторические данные Open-Meteo ↗</a>
                    </> : <p>Данные о климате пока недоступны.</p>}
                  </div>
                  <div className={styles.contextCard}>
                    <span className={styles.eyebrow}>ТРАНСПОРТ</span>
                    {profile.deepContext.transport.length > 0 ? <>
                      <strong>Остановки рядом с кампусом</strong>
                      <ul>{profile.deepContext.transport.slice(0, 5).map((stop, i) => <li key={`${stop.name}-${i}`}>{stop.name} · {stop.kind} <small>{formatDistance(stop.distanceM)}</small></li>)}</ul>
                      {profile.deepContext.transportSourceUrl && <a className={styles.link} href={profile.deepContext.transportSourceUrl} target="_blank" rel="noreferrer">Данные {profile.deepContext.transportSourceUrl.includes("google.com") ? "Google Maps" : "OpenStreetMap"} ↗</a>}
                    </> : <p>Остановки не найдены или картографический источник не ответил.</p>}
                  </div>
                  <div className={styles.contextCard}>
                    <span className={styles.eyebrow}>СТОИМОСТЬ ЖИЗНИ</span>
                    {profile.deepContext.livingCosts ? <>
                      <strong>Ориентиры для {profile.deepContext.livingCosts.city}</strong>
                      <ul>{profile.deepContext.livingCosts.items.map((item) => <li key={item.label}>{item.label}<small>≈ {Math.round(item.average)} {profile.deepContext!.livingCosts!.currency} {item.unit}</small></li>)}</ul>
                      <a className={styles.link} href="https://www.numbeo.com/cost-of-living/" target="_blank" rel="noreferrer">Источник: Numbeo{profile.deepContext.livingCosts.updated ? ` · обновлено ${profile.deepContext.livingCosts.updated}` : ""} ↗</a>
                    </> : <p>Проверенная оценка для этого города недоступна. Цены не рассчитываются без лицензированного источника.</p>}
                  </div>
                </div>
              </section>
            )}

            {profile.mode === "deep" && <div className={styles.filters}>
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
            </div>}

            {profile.mode === "quick" ? (
              <>
                <div className={styles.boardIntro}>
                  <span className={styles.eyebrow}>ПЕРВЫЙ ВЗГЛЯД / QUICK VISUAL BOARD</span>
                  <h2 className={styles.sectionTitle}>Семь граней кампуса</h2>
                  <p>Показываем только фотографии, прошедшие проверку содержимого. Источник и уровень доверия открываются у каждого кадра.</p>
                </div>
                <QuickBoard photos={visible} onOpen={setSelected} />
                <section className={styles.deepDive}>
                  <h2 className={styles.sectionTitle}>Это был быстрый взгляд</h2>
                  <p className={styles.sectionNote}>
                    Больше фотографий и категорий, отзывы, карта кампуса и сведения о городе.
                  </p>
                  <button
                    type="button"
                    className={styles.submit}
                    disabled={loading !== "idle" || !lastQid}
                    onClick={() => lastQid && loadProfile(lastQid, "deep")}
                  >
                    {loading === "profile" ? "Собираю…" : "Хочу ещё →"}
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
              title="Wikimedia Commons"
              note="Файлы из категории, связанной с карточкой выбранного вуза. У каждого указаны автор, лицензия и страница файла. Категория не доказывает место съёмки, поэтому географическое доверие остаётся неподтверждённым."
              photos={commons}
              groupByCategory
              emptyText="В итоговый профиль не попали снимки из Commons: их могло не быть в связанной категории, либо они не прошли проверку и лимиты галереи."
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
                <span>{selected.source === "official_site" ? "сайт вуза" : selected.source === "wikimedia_commons" ? "Wikimedia Commons" : <span className={styles.googleAttribution} translate="no">Google Maps</span>}</span>
              </div>
              {selected.sourceUrl && (
                <div className={styles.factRow}>
                  <span className={styles.factKey}>Ссылка</span>
                  <a className={styles.link} href={selected.sourceUrl} target="_blank" rel="noreferrer">Открыть оригинал</a>
                </div>
              )}
              {selected.attribution.map((author, i) => (
                <div className={styles.factRow} key={`${author.name}-${i}`}>
                  <span className={styles.factKey}>Автор</span>
                  {author.uri ? <a className={styles.link} href={author.uri} target="_blank" rel="noreferrer">{author.name}</a> : <span>{author.name}</span>}
                </div>
              ))}
              {selected.license && (
                <div className={styles.factRow}>
                  <span className={styles.factKey}>Лицензия</span>
                  <a className={styles.link} href={selected.license.url} target="_blank" rel="noreferrer">{selected.license.name}</a>
                </div>
              )}
              <div className={styles.factRow}>
                <span className={styles.factKey}>{selected.source === "official_site" ? "Страница" : selected.source === "wikimedia_commons" ? "Файл" : "Место"}</span>
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
