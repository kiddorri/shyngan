// app/page.tsx
// Минимальный UI блока A. Задача — доказать сквозняк, а не выглядеть красиво.
// Стили inline намеренно: никаких новых зависимостей и CSS-фреймворков в блоке A.

"use client";

import { useState } from "react";
import {
  CATEGORY_LABELS,
  type Category,
  type PhotoItem,
  type Profile,
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

export default function Home() {
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<UniversityCandidate[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [filter, setFilter] = useState<Category | "all">("all");
  const [selected, setSelected] = useState<PhotoItem | null>(null);
  const [loading, setLoading] = useState<"idle" | "resolve" | "profile">("idle");
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
    setLoading("profile");
    try {
      const res = await fetch(`/api/profile?qid=${qid}`);
      const json = (await res.json()) as Profile & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setProfile(json);
      setFilter("all");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading("idle");
    }
  }

  const visible = profile
    ? profile.photos.filter((p) => filter === "all" || p.category === filter)
    : [];

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 24, margin: "0 0 12px" }}>Shyngan — визуальный профиль университета</h1>

      <form onSubmit={onSearch} style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <input
          id="university-query"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Название университета, например: КазНУ"
          style={{ flex: 1, padding: 10, fontSize: 16 }}
        />
        <button type="submit" disabled={loading !== "idle"} style={{ padding: "10px 16px", fontSize: 16 }}>
          {loading === "resolve" ? "Ищу…" : "Найти"}
        </button>
      </form>

      {error && <p style={{ color: "#98182C" }}>{error}</p>}
      {loading === "profile" && <p>Собираю профиль… обычно до 30 секунд.</p>}

      {candidates.length > 1 && (
        <section style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 18 }}>Уточните, какой университет</h2>
          <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
            {candidates.map((c) => (
              <li key={c.qid}>
                <button
                  onClick={() => loadProfile(c.qid)}
                  style={{ width: "100%", textAlign: "left", padding: 10, cursor: "pointer" }}
                >
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
          <section style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 20, margin: "0 0 4px" }}>{profile.university.label}</h2>
            <p style={{ margin: 0, color: "#555" }}>
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

          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
            <button onClick={() => setFilter("all")} style={{ fontWeight: filter === "all" ? 700 : 400 }}>Все</button>
            {(Object.keys(CATEGORY_LABELS) as Category[]).map((cat) => (
              <button key={cat} onClick={() => setFilter(cat)} style={{ fontWeight: filter === cat ? 700 : 400 }}>
                {CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
            {visible.map((p) => (
              <figure key={p.id} style={{ margin: 0, border: "1px solid #ddd", padding: 8 }}>
                <img
                  src={p.imageUrl}
                  alt={p.evidence.placeName}
                  style={{ width: "100%", aspectRatio: "4 / 3", objectFit: "cover", cursor: "pointer" }}
                  onClick={() => setSelected(p)}
                />
                <figcaption style={{ fontSize: 12, marginTop: 6 }}>
                  <div style={{ color: TRUST_COLORS[p.trust], fontWeight: 600 }}>
                    {TRUST_LABELS[p.trust]}
                    {p.evidence.distanceM !== null ? ` · ${p.evidence.distanceM} м` : ""}
                  </div>
                  <div>{CATEGORY_LABELS[p.category]} · {p.evidence.placeName}</div>
                  <div>
                    {p.sourceUrl ? <a href={p.sourceUrl} target="_blank" rel="noreferrer">Источник</a> : "источник недоступен"}
                    {p.attribution[0] && (
                      <>
                        {" · Фото: "}
                        {p.attribution[0].uri
                          ? <a href={p.attribution[0].uri} target="_blank" rel="noreferrer">{p.attribution[0].name}</a>
                          : p.attribution[0].name}
                      </>
                    )}
                  </div>
                  <div style={{ color: "#777" }}>дата публикации: неизвестна</div>
                </figcaption>
              </figure>
            ))}
          </div>

          {selected && (
            <aside
              style={{ position: "fixed", right: 16, bottom: 16, width: 360, maxWidth: "calc(100% - 32px)", background: "#fff", border: "1px solid #999", padding: 12, fontSize: 13 }}
            >
              <strong>Почему это фото здесь</strong>
              <ul style={{ paddingLeft: 18, margin: "6px 0" }}>
                {selected.evidence.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
              <div>Тир: <span style={{ color: TRUST_COLORS[selected.trust] }}>{TRUST_LABELS[selected.trust]}</span></div>
              <div>Категория: {CATEGORY_LABELS[selected.category]} (по запросу)</div>
              <button onClick={() => setSelected(null)} style={{ marginTop: 8 }}>Закрыть</button>
            </aside>
          )}
        </>
      )}
    </main>
  );
}
