// app/page.tsx
// UI блока B: переключатель «Официальные / Глазами людей», прогресс сборки,
// описание кампуса, статистика отсева, карточка провенанса с вердиктом vision.
// Стили inline; светлая схема задана явно, чтобы не зависеть от globals.css.

"use client";

import { useState } from "react";
import {
  ALL_CATEGORIES,
  CATEGORY_LABELS,
  SOURCE_LABELS,
  type Category,
  type PhotoItem,
  type PhotoSource,
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

const TRUST_COLORS: Record<TrustTier, string> = {
  verified: "#0C6B69",
  probable: "#A94E15",
  unverified: "#98182C",
};

type SourceFilter = "all" | PhotoSource;

const ANCHOR_LABELS: Record<string, string> = {
  wikidata: "Wikidata",
  places: "Google Places (без подтверждения)",
  "places+2gis": "Google Places, подтверждено 2ГИС",
  none: "не найдены",
};

/** Дата получения снимка: требование 6 кейса допускает дату публикации ИЛИ получения. */
function formatRetrieved(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("ru-RU");
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
    case "dedupe":
      return `Дубликаты убраны: ${e.duplicates}, осталось ${e.kept}`;
    case "vision":
      return `Проверяю содержимое: ${e.batches} запрос(ов) к модели…`;
    case "done":
      return "Готово";
  }
}

/** Метры до километров: «8.6 км» и «107 м» читаются как разные порядки величины,
 *  и это снимает путаницу, не добавляя утверждений сверх измеренного. */
function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} км` : `${m} м`;
}

function badgeText(p: PhotoItem): string {
  const base = TRUST_LABELS[p.trust];
  const dist = p.evidence.distanceM !== null ? ` · ${formatDistance(p.evidence.distanceM)} от кампуса` : "";
  const content = p.evidence.vision ? "" : " · содержимое не проверено";
  return base + dist + content;
}


export default function Home() {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<UniversityCandidate[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [catFilter, setCatFilter] = useState<Category | "all">("all");
  const [srcFilter, setSrcFilter] = useState<SourceFilter>("all");
  const [selected, setSelected] = useState<PhotoItem | null>(null);
  const [loading, setLoading] = useState<"idle" | "resolve" | "profile">("idle");
  const [progress, setProgress] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setProfile(null);
    setCandidates([]);
    setSelected(null);
    setLoading("resolve");
    try {
      const res = await fetch(`/api/resolve?q=${encodeURIComponent(query)}`);
      const json = (await res.json()) as { candidates: UniversityCandidate[]; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.candidates.length === 0) {
        setError("Университет не найден в Wikidata. Попробуйте другое написание или название на английском.");
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

  async function loadProfile(qid: string) {
    setError(null);
    setCandidates([]);
    setProgress([]);
    setLoading("profile");
    try {
      const res = await fetch(`/api/profile?qid=${qid}`);
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
            setProgress((prev) => [...prev, progressText(msg as unknown as ProgressEvent)]);
          } else if (msg.type === "profile") {
            const { type: _t, ...rest } = msg;
            setProfile(rest as unknown as Profile);
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
      setLoading("idle");
    }
  }

  const visible = profile
    ? profile.photos.filter(
        (p) => (catFilter === "all" || p.category === catFilter) && (srcFilter === "all" || p.source === srcFilter),
      )
    : [];

  return (
    <main
      style={{
        maxWidth: 1100,
        margin: "0 auto",
        padding: 24,
        fontFamily: "system-ui, sans-serif",
        background: "#fff",
        color: "#111",
        colorScheme: "light",
        minHeight: "100vh",
      }}
    >
      <h1 style={{ fontSize: 24, margin: "0 0 12px" }}>Shyngan — визуальный профиль университета</h1>

      <form onSubmit={onSearch} style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input
          id="university-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Название университета, например: Назарбаев Университет"
          style={{ flex: 1, padding: 10, fontSize: 16 }}
        />
        <button type="submit" disabled={loading !== "idle"} style={{ padding: "10px 16px", fontSize: 16 }}>
          {loading === "resolve" ? "Ищу…" : "Найти"}
        </button>
      </form>

      {error && <p style={{ color: "#98182C" }}>{error}</p>}

      {loading === "profile" && (
        <div style={{ marginBottom: 16, fontSize: 14, color: "#555" }}>
          <div>Собираю профиль… обычно менее 30 секунд: поиск мест, загрузка снимков, проверка содержимого.</div>
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {progress.map((line, i) => <li key={i}>{line}</li>)}
          </ul>
        </div>
      )}

      {candidates.length > 1 && (
        <section style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 18 }}>Уточните, какой университет</h2>
          <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
            {candidates.map((c) => (
              <li key={c.qid}>
                <button onClick={() => loadProfile(c.qid)} style={{ width: "100%", textAlign: "left", padding: 10, cursor: "pointer" }}>
                  <strong>{c.label}</strong>
                  {c.city ? ` — ${c.city}` : ""}
                  {c.country ? `, ${c.country}` : ""}
                  {c.instanceOf ? ` (${c.instanceOf})` : ""}
                  <span style={{ color: "#666" }}> · {c.qid}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {profile && (
        <>
          <section style={{ marginBottom: 12 }}>
            <h2 style={{ fontSize: 20, margin: "0 0 4px" }}>{profile.university.label}</h2>
            <p style={{ margin: "0 0 8px", color: "#555" }}>
              {profile.university.city ?? "город неизвестен"}
              {profile.university.country ? `, ${profile.university.country}` : ""}
              {" · "}
              {profile.university.officialWebsite ? (
                <a href={profile.university.officialWebsite} target="_blank" rel="noreferrer">официальный сайт</a>
              ) : (
                "официальный сайт не указан в Wikidata"
              )}
              {" · "}
              {profile.photos.length} фото за {(profile.timingMs / 1000).toFixed(1)} с
            </p>
            <p style={{ margin: 0, maxWidth: 760, lineHeight: 1.5 }}>{profile.description}</p>
          </section>

          <section style={{ marginBottom: 12, fontSize: 13, color: "#555" }}>
            Официальных: {profile.sources.official} · глазами людей: {profile.sources.visitors} · отсеяно: {profile.removed.duplicates} дублей,{" "}
            {profile.removed.irrelevant} нерелевантных, {profile.removed.tooSmall} мелких, {profile.removed.failedDownload} не загрузилось
            {!profile.visionAvailable && " · содержимое снимков не проверялось"}
          </section>

          <section style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 14, margin: "0 0 6px" }}>Покрытие по категориям</h3>
            <table style={{ borderCollapse: "collapse", fontSize: 14 }}>
              <tbody>
                {profile.coverage.map((c) => {
                  const total = c.verified + c.probable + c.unverified;
                  return (
                    <tr key={c.category}>
                      <td style={{ padding: "2px 12px 2px 0" }}>{CATEGORY_LABELS[c.category]}</td>
                      <td style={{ padding: "2px 12px 2px 0" }}>
                        {total === 0
                          ? <span style={{ color: "#98182C" }}>данных недостаточно</span>
                          : `${c.verified} подтв. · ${c.probable} вер. · ${c.unverified} не подтв.`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          {profile.warnings.length > 0 && (
            <ul style={{ fontSize: 13, color: "#A94E15", paddingLeft: 18, marginBottom: 16 }}>
              {profile.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            <button onClick={() => setSrcFilter("all")} style={{ fontWeight: srcFilter === "all" ? 700 : 400 }}>Все источники</button>
            {(Object.keys(SOURCE_LABELS) as PhotoSource[]).map((s) => (
              <button key={s} onClick={() => setSrcFilter(s)} style={{ fontWeight: srcFilter === s ? 700 : 400 }}>
                {SOURCE_LABELS[s]}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
            <button onClick={() => setCatFilter("all")} style={{ fontWeight: catFilter === "all" ? 700 : 400 }}>Все категории</button>
            {ALL_CATEGORIES.map((cat) => (
              <button key={cat} onClick={() => setCatFilter(cat)} style={{ fontWeight: catFilter === cat ? 700 : 400 }}>
                {CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>

          {visible.length === 0 && <p style={{ color: "#98182C" }}>По выбранным фильтрам снимков нет.</p>}

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
            {visible.map((p) => (
              <figure key={p.id} style={{ margin: 0, border: "1px solid #ddd", padding: 8 }}>
                <img
                  src={p.imageUrl}
                  alt={p.evidence.vision?.caption ?? p.evidence.placeName}
                  style={{ width: "100%", aspectRatio: "4 / 3", objectFit: "cover", cursor: "pointer" }}
                  onClick={() => setSelected(p)}
                />
                <figcaption style={{ fontSize: 12, marginTop: 6 }}>
                  <div style={{ color: TRUST_COLORS[p.trust], fontWeight: 600 }}>{badgeText(p)}</div>
                  <div>{CATEGORY_LABELS[p.category]} · {SOURCE_LABELS[p.source]}</div>
                  <div style={{ color: "#333" }}>{p.evidence.placeName}</div>
                  {p.evidence.address && <div style={{ color: "#666" }}>{p.evidence.address}</div>}
                  {p.evidence.vision && <div style={{ color: "#444" }}>{p.evidence.vision.caption}</div>}
                  <div>
                    {p.sourceUrl ? <a href={p.sourceUrl} target="_blank" rel="noreferrer">Источник</a> : "источник недоступен"}
                    {p.attribution[0] && (
                      <>
                        {" · "}
                        {p.attribution[0].uri
                          ? <a href={p.attribution[0].uri} target="_blank" rel="noreferrer">{p.attribution[0].name}</a>
                          : p.attribution[0].name}
                      </>
                    )}
                  </div>
                  <div style={{ color: "#777" }}>дата публикации неизвестна · получено {formatRetrieved(p.retrievedAt)}</div>
                </figcaption>
              </figure>
            ))}
          </div>

          {selected && (
            <aside
              style={{
                position: "fixed",
                right: 16,
                bottom: 16,
                width: 380,
                maxWidth: "calc(100% - 32px)",
                maxHeight: "70vh",
                overflowY: "auto",
                background: "#fff",
                color: "#111",
                border: "1px solid #999",
                padding: 12,
                fontSize: 13,
              }}
            >
              <strong>Почему это фото здесь</strong>
              <ul style={{ paddingLeft: 18, margin: "6px 0" }}>
                {selected.evidence.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
              <div>Тир: <span style={{ color: TRUST_COLORS[selected.trust] }}>{TRUST_LABELS[selected.trust]}</span></div>
              <div>Источник: {SOURCE_LABELS[selected.source]}</div>
              {selected.evidence.address && <div>Адрес: {selected.evidence.address}</div>}
              <div>Категория: {CATEGORY_LABELS[selected.category]}{selected.evidence.vision ? " (по содержимому)" : " (по запросу)"}</div>
              {selected.hash && <div style={{ color: "#777" }}>dHash: {selected.hash}</div>}
              <button onClick={() => setSelected(null)} style={{ marginTop: 8 }}>Закрыть</button>
            </aside>
          )}
        </>
      )}
    </main>
  );
}
