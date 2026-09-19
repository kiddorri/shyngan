"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Map as LeafletMap } from "leaflet";
import type { Anchor, CityCenter, MapPoint } from "@/lib/types";

type Props = { anchor: Anchor; points: MapPoint[]; cityCenter: CityCenter | null };

function distance(m: number) { return m >= 1000 ? `${(m / 1000).toFixed(1)} км` : `${m} м`; }

function popup(title: string, subtitle: string): HTMLDivElement {
  const element = document.createElement("div");
  const heading = document.createElement("strong");
  const detail = document.createElement("div");
  heading.textContent = title;
  detail.textContent = subtitle;
  element.append(heading, detail);
  return element;
}

export default function CampusMap({ anchor, points, cityCenter }: Props) {
  const [focusCity, setFocusCity] = useState(false);
  const [tileFailures, setTileFailures] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markers = useMemo(() => points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)), [points]);
  const osmUrl = `https://www.openstreetmap.org/?mlat=${anchor.lat}&mlon=${anchor.lon}#map=15/${anchor.lat}/${anchor.lon}`;

  useEffect(() => {
    let disposed = false;
    let instance: LeafletMap | null = null;
    void import("leaflet").then((L) => {
      if (disposed || !containerRef.current) return;
      const map = L.map(containerRef.current, { scrollWheelZoom: false, zoomControl: true });
      instance = map;
      mapRef.current = map;
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>',
      }).on("tileerror", () => setTileFailures((n) => n + 1))
        .on("tileload", () => setTileFailures(0)).addTo(map);
      L.circleMarker([anchor.lat, anchor.lon], { radius: 11, color: "#fff", weight: 3, fillColor: "#6b212c", fillOpacity: 1 })
        .bindPopup(popup("Кампус", `${anchor.lat.toFixed(5)}, ${anchor.lon.toFixed(5)}`)).addTo(map);
      for (const point of markers) {
        L.circleMarker([point.lat, point.lon], { radius: 7, color: "#fff", weight: 2, fillColor: "#27363f", fillOpacity: 1 })
          .bindPopup(popup(point.name, `${distance(point.distanceM)} от кампуса · ${point.photos} фото`)).addTo(map);
      }
      if (cityCenter) {
        L.circleMarker([cityCenter.lat, cityCenter.lon], { radius: 8, color: "#fff", weight: 2, fillColor: "#8ea1ae", fillOpacity: 1 })
          .bindPopup(popup(`Центр города · ${cityCenter.name}`, `${distance(cityCenter.distanceM)} по прямой от кампуса`)).addTo(map);
      }
      // Keep the first view useful for the campus. City scenes remain clickable
      // markers but should not zoom the entire university down to a speck.
      const campusMarkers = markers.filter((p) => p.category !== "city" && p.category !== "citywide" && p.distanceM <= 3000);
      const coordinates: Array<[number, number]> = [[anchor.lat, anchor.lon], ...campusMarkers.map((p): [number, number] => [p.lat, p.lon])];
      if (focusCity && cityCenter) coordinates.push([cityCenter.lat, cityCenter.lon]);
      map.fitBounds(L.latLngBounds(coordinates).pad(0.18), { maxZoom: focusCity ? 13 : 16, animate: false });
      requestAnimationFrame(() => { if (!disposed) map.invalidateSize(); });
    }).catch(() => setTileFailures(3));
    return () => { disposed = true; if (instance) instance.remove(); if (mapRef.current === instance) mapRef.current = null; };
  }, [anchor, markers, cityCenter, focusCity]);

  return (
    <div className="campusMapShell">
      <div className="campusMapBar">
        <span>Кампус и найденные места</span>
        {cityCenter && <button type="button" onClick={() => setFocusCity((v) => !v)}>{focusCity ? "Показать кампус" : "Показать центр города"}</button>}
      </div>
      <div className="campusMapCanvas">
        <div ref={containerRef} style={{ height: "100%", width: "100%" }} aria-label="Интерактивная карта кампуса" />
        {tileFailures >= 3 && <div className="campusMapFallback" role="status">
          <strong>Карта временно недоступна</strong>
          <span>Координаты кампуса: {anchor.lat.toFixed(5)}, {anchor.lon.toFixed(5)}</span>
          <a href={osmUrl} target="_blank" rel="noreferrer">Открыть в OpenStreetMap ↗</a>
        </div>}
      </div>
      <ul className="campusMapPlaces">
        <li><span className="campusMapSwatch campusMapSwatchCampus" />Кампус <small>точка отсчёта</small></li>
        {markers.map((point) => <li key={point.placeId}><span className="campusMapSwatch" />{point.name}<small>{distance(point.distanceM)}</small></li>)}
        {cityCenter && <li><span className="campusMapSwatch campusMapSwatchCity" />Центр города · {cityCenter.name}<small>{distance(cityCenter.distanceM)} по прямой</small></li>}
      </ul>
    </div>
  );
}
