import { haversineM } from "./geo";
import { searchText } from "./places";
import type { Anchor, DeepContext, UniversityCandidate } from "./types";

const TIMEOUT_MS = 8000;

async function climate(anchor: Anchor): Promise<DeepContext["climate"]> {
  const year = new Date().getUTCFullYear() - 1;
  const start = `${year - 2}-01-01`;
  const end = `${year}-12-31`;
  const url = new URL("https://archive-api.open-meteo.com/v1/archive");
  url.search = new URLSearchParams({ latitude: String(anchor.lat), longitude: String(anchor.lon),
    start_date: start, end_date: end, daily: "temperature_2m_mean,precipitation_sum", timezone: "auto" }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) return null;
  const data = await response.json() as { daily?: { time?: string[]; temperature_2m_mean?: Array<number | null>; precipitation_sum?: Array<number | null> } };
  const days = data.daily;
  if (!days?.time?.length || !days.temperature_2m_mean?.length) return null;
  const means = (months: number[]) => {
    const values = days.time!.flatMap((date, i) => months.includes(Number(date.slice(5, 7))) && Number.isFinite(days.temperature_2m_mean![i]) ? [days.temperature_2m_mean![i] as number] : []);
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
  };
  const winterC = means([12, 1, 2]);
  const summerC = means([6, 7, 8]);
  const precipitation = (days.precipitation_sum ?? []).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!Number.isFinite(winterC) || !Number.isFinite(summerC) || precipitation.length < 300) return null;
  return { winterC: Math.round(winterC * 10) / 10, summerC: Math.round(summerC * 10) / 10,
    annualPrecipitationMm: Math.round(precipitation.reduce((a, b) => a + b, 0) / 3), years: `${year - 2}–${year}`, sourceUrl: url.toString() };
}

async function transport(anchor: Anchor): Promise<Pick<DeepContext, "transport" | "transportSourceUrl">> {
  const query = `[out:json][timeout:8];(node(around:1200,${anchor.lat},${anchor.lon})[highway=bus_stop];node(around:1200,${anchor.lat},${anchor.lon})[railway=tram_stop];node(around:1200,${anchor.lat},${anchor.lon})[railway=subway_entrance];);out center 35;`;
  const response = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: new URLSearchParams({ data: query }), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
  const data = await response.json() as { elements?: Array<{ id: number; lat?: number; lon?: number; tags?: Record<string, string> }> };
  const stops = (data.elements ?? []).filter((v) => Number.isFinite(v.lat) && Number.isFinite(v.lon)).map((v) => ({
    name: v.tags?.name ?? "Остановка без названия",
    kind: v.tags?.railway === "tram_stop" ? "трамвай" : v.tags?.railway === "subway_entrance" ? "метро" : "автобус",
    distanceM: Math.round(haversineM(anchor.lat, anchor.lon, v.lat!, v.lon!)), lat: v.lat!, lon: v.lon!,
  })).sort((a, b) => a.distanceM - b.distanceM).slice(0, 8);
  if (!stops.length) throw new Error("Overpass: остановки не найдены");
  return { transport: stops, transportSourceUrl: `https://www.openstreetmap.org/?mlat=${anchor.lat}&mlon=${anchor.lon}#map=15/${anchor.lat}/${anchor.lon}` };
}

async function transportFromPlaces(anchor: Anchor): Promise<Pick<DeepContext, "transport" | "transportSourceUrl">> {
  const places = await searchText("bus stop", { bias: { lat: anchor.lat, lon: anchor.lon, radiusM: 1500 }, pageSize: 8 });
  const stops = places.filter((place) => place.location).map((place) => ({
    name: place.displayName?.text ?? "Остановка",
    kind: "автобус",
    lat: place.location!.latitude,
    lon: place.location!.longitude,
    distanceM: Math.round(haversineM(anchor.lat, anchor.lon, place.location!.latitude, place.location!.longitude)),
  })).filter((stop) => stop.distanceM <= 1500).sort((a, b) => a.distanceM - b.distanceM).slice(0, 8);
  return { transport: stops, transportSourceUrl: stops.length ? `https://www.google.com/maps/search/bus+stop/@${anchor.lat},${anchor.lon},15z` : null };
}

async function livingCosts(university: UniversityCandidate): Promise<DeepContext["livingCosts"]> {
  if (!process.env.NUMBEO_API_KEY || !university.city) return null;
  const url = new URL("https://www.numbeo.com/api/city_prices");
  url.search = new URLSearchParams({ query: [university.city, university.country].filter(Boolean).join(", "), currency: "USD" }).toString();
  const response = await fetch(url, { headers: { "X-Api-Key": process.env.NUMBEO_API_KEY }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) return null;
  const data = await response.json() as { name?: string; currency?: string; monthLastUpdate?: number; yearLastUpdate?: number; prices?: Array<{ average_price?: number; item_name?: string; item_id?: number }> };
  const wanted = [
    { pattern: /Meal, Inexpensive Restaurant/i, label: "Обед в недорогом кафе", unit: "за раз" },
    { pattern: /Monthly Pass/i, label: "Проездной", unit: "в месяц" },
    { pattern: /Apartment \(1 bedroom\) Outside of Centre/i, label: "Квартира вне центра", unit: "в месяц" },
  ];
  const items = wanted.flatMap((w) => {
    const p = data.prices?.find((p) => w.pattern.test(p.item_name ?? ""));
    return p && typeof p.average_price === "number" ? [{ label: w.label, average: p.average_price, unit: w.unit }] : [];
  });
  return items.length ? { currency: data.currency ?? "USD", city: data.name ?? university.city,
    updated: data.monthLastUpdate && data.yearLastUpdate ? `${data.monthLastUpdate}.${data.yearLastUpdate}` : null, items } : null;
}

export async function loadDeepContext(university: UniversityCandidate, anchor: Anchor | null): Promise<DeepContext> {
  const [weather, stops, costs] = await Promise.allSettled([
    anchor ? climate(anchor) : Promise.resolve(null),
    anchor ? transport(anchor).catch(() => transportFromPlaces(anchor)) : Promise.resolve({ transport: [], transportSourceUrl: null }),
    livingCosts(university),
  ]);
  return {
    climate: weather.status === "fulfilled" ? weather.value : null,
    transport: stops.status === "fulfilled" ? stops.value.transport : [],
    transportSourceUrl: stops.status === "fulfilled" ? stops.value.transportSourceUrl : null,
    livingCosts: costs.status === "fulfilled" ? costs.value : null,
  };
}
