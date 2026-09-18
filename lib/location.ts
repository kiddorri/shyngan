import { haversineM } from "./geo";
import type { Anchor, AnchorSource } from "./types";

export type LocationObservation = {
  source: "wikidata" | "places" | "2gis";
  name: string;
  address: string | null;
  lat: number;
  lon: number;
};

/** Метки организаций и центры кампусов могут отличаться на несколько кварталов. */
export const AGREEMENT_RADIUS_M = 1500;

/** Сверяем все доступные координаты. Если источники расходятся, сохраняем
 * каждую точку и помечаем выбор спорным, вместо скрытой подстановки. */
export function chooseAnchor(points: LocationObservation[]): Anchor | null {
  const valid = points.filter((p) =>
    Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
    Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180,
  );
  if (!valid.some((p) => p.source === "wikidata" || p.source === "places")) return null;

  const pairs = valid.flatMap((a, i) => valid.slice(i + 1).map((b) => ({
    a, b, distanceM: haversineM(a.lat, a.lon, b.lat, b.lon),
  })));
  const agreement = pairs
    .filter((pair) => pair.distanceM <= AGREEMENT_RADIUS_M)
    .sort((a, b) => a.distanceM - b.distanceM)[0];

  const preferred = agreement
    ? [agreement.a, agreement.b].find((p) => p.source === "wikidata") ??
      [agreement.a, agreement.b].find((p) => p.source === "places") ?? agreement.a
    : valid.find((p) => p.source === "wikidata") ??
      valid.find((p) => p.source === "places") ?? valid[0];

  let source: Exclude<AnchorSource, "none"> = preferred.source === "2gis" ? "places" : preferred.source;
  if (agreement) {
    const members = new Set([agreement.a.source, agreement.b.source]);
    const allAgree = valid.length === 3 && pairs.every((p) => p.distanceM <= AGREEMENT_RADIUS_M);
    if (allAgree) source = "wikidata+places+2gis";
    else if (members.has("wikidata") && members.has("places")) source = "wikidata+places";
    else if (members.has("wikidata") && members.has("2gis")) source = "wikidata+2gis";
    else source = "places+2gis";
  }

  return {
    lat: preferred.lat,
    lon: preferred.lon,
    source,
    disputed: !agreement && valid.length > 1,
    observations: valid.map((p) => ({
      ...p,
      distanceM: haversineM(preferred.lat, preferred.lon, p.lat, p.lon),
    })),
  };
}
