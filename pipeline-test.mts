// Оффлайн-тест пайплайна блока B: все сетевые вызовы подменены.
// Проверяет: dHash/hamming, парсинг сайта, форму запроса к Gemini и 2ГИС,
// дедупликацию, применение вердиктов, статистику, покрытие, описание, NDJSON-роут.

import sharp from "sharp";
import assert from "node:assert/strict";

process.env.GOOGLE_PLACES_API_KEY = "test-places";
process.env.GEMINI_API_KEY = "test-gemini";
process.env.TWOGIS_API_KEY = "test-2gis";

// ---- тестовые картинки ----
async function svgJpeg(w: number, h: number, inner: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${inner}</svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}
async function jpeg(w: number, h: number, color: string): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
}

// Структурно разные картинки: dHash сравнивает форму, не цвет.
const IMG_A = await svgJpeg(1200, 800, `<rect width="1200" height="800" fill="#dfe6ee"/><rect x="150" y="250" width="900" height="450" fill="#334"/><rect x="200" y="300" width="120" height="120" fill="#fff"/><rect x="400" y="300" width="120" height="120" fill="#fff"/><rect x="600" y="300" width="120" height="120" fill="#fff"/><rect x="800" y="300" width="120" height="120" fill="#fff"/>`); // «здание»
const IMG_A_COPY = await sharp(IMG_A).resize(600).jpeg({ quality: 60 }).toBuffer(); // пережатая копия A → дубль
const IMG_B = await svgJpeg(1000, 700, `<rect width="1000" height="700" fill="#222"/><circle cx="500" cy="350" r="300" fill="#eee"/>`); // «другое»
const IMG_C = await svgJpeg(900, 700, `<rect width="900" height="700" fill="#fff"/>${Array.from({length: 9}, (_, i) => `<rect x="${i * 100}" y="0" width="50" height="700" fill="#000"/>`).join("")}`); // «город»
const IMG_LOGO = await jpeg(200, 100, "#ffffff");       // мелкая иконка на сайте
const IMG_OFF = await svgJpeg(1400, 900, `<rect width="1400" height="900" fill="#c9d6df"/><polygon points="700,100 1300,800 100,800" fill="#553"/>`); // официальное фото
const IMG_OFF3 = await svgJpeg(1200, 800, `<rect width="1200" height="800" fill="#eee"/><rect x="0" y="400" width="1200" height="400" fill="#246"/><circle cx="300" cy="200" r="120" fill="#fc0"/>`); // снимок из внутренней галереи
const IMG_OFF2 = await svgJpeg(1300, 900, `<rect width="1300" height="900" fill="#fff"/><rect x="100" y="100" width="1100" height="700" fill="none" stroke="#000" stroke-width="60"/>`); // второе официальное

// ---- 1. dHash / hamming ----
const { dHash, hamming } = await import("./lib/image.ts");
const hA = await dHash(IMG_A);
const hAc = await dHash(IMG_A_COPY);
const hB = await dHash(IMG_B);
assert.equal(hA.length, 16);
assert.ok(hamming(hA, hAc) <= 10, `copy should be near-duplicate, got ${hamming(hA, hAc)}`);
assert.ok(hamming(hA, hB) > 10, `different images should differ, got ${hamming(hA, hB)}`);
console.log("dHash ok:", { copy: hamming(hA, hAc), different: hamming(hA, hB) });

// ---- 2. мок сети ----
const captured: { gemini: any[]; twogis: string[]; places: any[] } = { gemini: [], twogis: [], places: [] };

const OFFICIAL_HTML = `<html><head>
<meta property="og:image" content="/img/hero.jpg">
</head><body>
<img src="/img/logo.png">
<img data-src="https://cdn.example.edu/campus.jpg" src="data:image/gif;base64,R0lGOD">
<img srcset="/img/hero.jpg 1200w, /img/hero-small.jpg 600w">
<img src="/icons/i.svg">
<a href="/dlya-inostrannyh-abiturientov/">Для иностранных абитуриентов</a>
<a href="/fakultet-arhitektury/">Факультет архитектуры</a>
<a href="/gallery">Фотогалерея кампуса</a>
<a href="/virtualnyj-tur">Виртуальный тур по кампусу</a>
<a href="/contacts">Контакты</a>
<a href="https://other.example.com/gallery">Чужая галерея</a>
</body></html>`;

const GALLERY_HTML = `<html><body>
<a href="/img/inner.jpg">полный размер</a>
</body></html>`;

// Страница тура: плеер панорам, отдельных файлов-снимков нет.
const TOUR_HTML = `<html><body><div id="pano"></div></body></html>`;

const placeCampus = {
  id: "P_CAMPUS", displayName: { text: "Тестовый Университет" }, formattedAddress: "просп. Тестовый, 1, Астана",
  location: { latitude: 51.0900, longitude: 71.4000 },
  googleMapsUri: "https://maps.google.com/?cid=1",
  photos: [
    { name: "places/P_CAMPUS/photos/a", widthPx: 1200, heightPx: 800, authorAttributions: [{ displayName: "User A", uri: "https://maps.google.com/contrib/1" }] },
    { name: "places/P_CAMPUS/photos/a2", widthPx: 600, heightPx: 400 },   // копия A → дубль
    { name: "places/P_CAMPUS/photos/c", widthPx: 900, heightPx: 700 },    // на самом деле город
  ],
};
const placeDorm = {
  id: "P_DORM", displayName: { text: "Общежитие №1" },
  location: { latitude: 51.0930, longitude: 71.4050 }, // ~450 м
  googleMapsUri: "https://maps.google.com/?cid=2",
  photos: [{ name: "places/P_DORM/photos/b", widthPx: 1000, heightPx: 700 }],
};

const imageByName: Record<string, Buffer> = {
  "places/P_CAMPUS/photos/a": IMG_A,
  "places/P_CAMPUS/photos/a2": IMG_A_COPY,
  "places/P_CAMPUS/photos/c": IMG_C,
  "places/P_DORM/photos/b": IMG_B,
};

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  const u = new URL(url);

  // Place Details: GET /v1/places/{place_id} — без двоеточий и вложенных сегментов,
  // поэтому ни searchText, ни .../photos/.../media сюда не попадают.
  if (u.hostname === "places.googleapis.com" && /^\/v1\/places\/[^/:]+$/.test(u.pathname)) {
    const mask = init.headers["X-Goog-FieldMask"] as string;
    assert.equal(mask.includes("places."), false, "в Place Details поля идут без префикса places.");
    assert.ok(mask.includes("displayName"));
    assert.equal(u.searchParams.get("languageCode"), "ru");
    const id = u.pathname.split("/").pop()!;
    if (id === "P_CAMPUS") return Response.json(placeCampus); // объект Place на верхнем уровне
    // Строка, которая идентификатором быть не может: Places отвечает 400 INVALID_ARGUMENT.
    if (id === "P_BADID") {
      return Response.json({ error: { code: 400, message: "The provided Place ID is not valid.", status: "INVALID_ARGUMENT" } }, { status: 400 });
    }
    // Идентификатор корректный, но места нет: 404 NOT_FOUND.
    return Response.json({ error: { code: 404, message: "Place not found.", status: "NOT_FOUND" } }, { status: 404 });
  }
  // Places text search
  if (u.href.endsWith("/places:searchText")) {
    const body = JSON.parse(init.body);
    captured.places.push(body);
    assert.equal(init.headers["X-Goog-FieldMask"].includes("places.photos"), true);
    if (body.textQuery === "Тестовый Университет") return Response.json({ places: [placeCampus] });
    if (body.textQuery.includes("общежитие")) return Response.json({ places: [placeDorm] });
  if (body.textQuery === "парк") {
    assert.equal(body.locationBias.circle.radius, 2000, "окружение ищется в узком радиусе");
    return Response.json({ places: [] });
  }
    return Response.json({ places: [] });
  }
  // Places photo media → JSON с photoUri на наш "CDN"
  if (u.pathname.includes("/photos/") && u.pathname.endsWith("/media")) {
    const name = u.pathname.slice("/v1/".length, -"/media".length);
    assert.ok(u.searchParams.get("skipHttpRedirect") === "true");
    return Response.json({ name, photoUri: `https://lh3.test/${encodeURIComponent(name)}` });
  }
  if (u.hostname === "lh3.test") {
    const name = decodeURIComponent(u.pathname.slice(1));
    return new Response(imageByName[name], { headers: { "content-type": "image/jpeg" } });
  }
  // Официальный сайт
  if (u.hostname === "example.edu" && u.pathname === "/") {
    return new Response(OFFICIAL_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (u.hostname === "example.edu" && u.pathname === "/gallery") {
    return new Response(GALLERY_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (u.hostname === "example.edu" && u.pathname === "/virtualnyj-tur") {
    return new Response(TOUR_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (u.hostname === "example.edu" && u.pathname === "/contacts") throw new Error("контакты не должны запрашиваться");
  // Основа «тур» раньше совпадала с «абиТУРиент» и «архитекТУРа» — обход тратил
  // бюджет страниц на разделы без фотографий.
  if (u.hostname === "example.edu" && u.pathname === "/dlya-inostrannyh-abiturientov/") throw new Error("«абитуриенты» не должны запрашиваться");
  if (u.hostname === "example.edu" && u.pathname === "/fakultet-arhitektury/") throw new Error("«архитектура» не должна запрашиваться");
  if (u.hostname === "other.example.com") throw new Error("чужой домен не должен запрашиваться");
  if (u.hostname === "example.edu" && u.pathname === "/img/inner.jpg") return new Response(IMG_OFF3, { headers: { "content-type": "image/jpeg" } });
  if (u.hostname === "example.edu" && u.pathname === "/img/hero.jpg") return new Response(IMG_OFF, { headers: { "content-type": "image/jpeg" } });
  if (u.hostname === "example.edu" && u.pathname === "/img/logo.png") return new Response(IMG_LOGO, { headers: { "content-type": "image/png" } });
  if (u.hostname === "example.edu" && u.pathname === "/img/hero-small.jpg") return new Response(IMG_OFF, { headers: { "content-type": "image/jpeg" } });
  if (u.hostname === "cdn.example.edu") return new Response(IMG_OFF2, { headers: { "content-type": "image/jpeg" } });
  // 2ГИС
  if (u.hostname === "catalog.api.2gis.com") {
    captured.twogis.push(u.href);
    assert.equal(u.searchParams.get("location"), "71.4,51.09"); // lon,lat
    return Response.json({ result: { items: [
      { name: "Тестовый Университет", type: "branch", address_name: "ул. Тестовая 1", point: { lat: 51.0902, lon: 71.4003 } },
    ] } });
  }
  // Gemini
  if (u.hostname === "generativelanguage.googleapis.com") {
    const body = JSON.parse(init.body);
    captured.gemini.push({ headers: init.headers, body });
    const parts = body.contents[0].parts;
    const imageParts = parts.filter((p: any) => p.inline_data);
    // вердикты по порядку изображений в батче: определяем по размеру base64 (у нас все разные)
    const verdicts = imageParts.map((p: any, i: number) => {
      const bytes = Buffer.from(p.inline_data.data, "base64");
      const kind = sizeKind(bytes);
      return {
        index: i + 1,
        relevant: kind !== "logo",
        category: kind === "city" ? "city" : kind === "dorm" ? "dorm" : kind === "logo" ? "other" : "campus",
        caption: kind === "city" ? "городская улица" : kind === "dorm" ? "жилой корпус" : "учебный корпус",
        confidence: "high",
      };
    });
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdicts) }] } }] });
  }
  throw new Error("unexpected fetch: " + url);
}) as any;

// картинки после нормализации — определяем «вид» по средней яркости канала (наш мок)
function sizeKind(bytes: Buffer): "campus" | "city" | "dorm" | "logo" | "official" {
  // грубо: по длине буфера различаем наши 5 картинок
  const n = bytes.length;
  // logo — очень маленькая
  if (n < 3000) return "logo";
  return kindByHash.get(n) ?? "campus";
}
const kindByHash = new Map<number, "campus" | "city" | "dorm" | "logo" | "official">();
// заранее прогоним нормализацию, чтобы знать длины
const { loadImage } = await import("./lib/image.ts");
for (const [name, kind] of [["places/P_CAMPUS/photos/c", "city"], ["places/P_DORM/photos/b", "dorm"]] as const) {
  const li = await loadImage(`https://lh3.test/${encodeURIComponent(name)}`, "t");
  kindByHash.set(li!.bytes.length, kind);
}

// ---- 3. official.ts ----
const { collectOfficialImages } = await import("./lib/official.ts");
const off = await collectOfficialImages("https://example.edu", "t");
assert.equal(off.error, null);
const offUrls = off.candidates.map((c) => c.url);
assert.deepEqual(offUrls, [
  "https://example.edu/img/hero.jpg",          // og:image первым
  "https://example.edu/img/logo.png",
  "https://cdn.example.edu/campus.jpg",        // data-src, data: пропущен
  "https://example.edu/img/inner.jpg",         // со второго уровня: галерея
]);
// Прочитаны галерея и тур; «абитуриенты» и «архитектура» отсеяны (иначе мок бросит ошибку).
assert.deepEqual(off.pagesVisited, ["https://example.edu/", "https://example.edu/gallery", "https://example.edu/virtualnyj-tur"]);
console.log("обход второго уровня ok:", off.pagesVisited);
// снимок из галереи должен дойти до профиля, а не потеряться

console.log("official ok:", offUrls);

// ---- 4. twogis.ts ----
const { findInTwoGis } = await import("./lib/twogis.ts");
const hit = await findInTwoGis("Тестовый Университет", { lat: 51.09, lon: 71.4 });
assert.ok(hit && Math.abs(hit.lat - 51.0902) < 1e-6);
console.log("2gis ok:", hit);

// ---- 4b. резолв вуза, которого нет в Wikidata: карточка по place_id ----
const { getUniversityByAnyId } = await import("./lib/resolve.ts");
const byPlace = await getUniversityByAnyId("places:P_CAMPUS");
assert.ok(byPlace, "место по идентификатору должно находиться");
assert.equal(byPlace!.qid, "places:P_CAMPUS");
assert.equal(byPlace!.resolvedVia, "places");
assert.equal(byPlace!.label, "Тестовый Университет");
// Координаты из Places не берём: якорь из того же источника ничего не подтверждает.
assert.equal(byPlace!.lat, null);
// Несуществующее место — null, а не «похожее» место из выдачи.
assert.equal(await getUniversityByAnyId("places:P_NOPE"), null);
// Строка, которая идентификатором быть не может: Places отвечает 400, ответ тот же — null.
assert.equal(await getUniversityByAnyId("places:P_BADID"), null);
console.log("place details ok:", byPlace!.label);

// ---- 5. полный профиль ----
const { buildProfile } = await import("./lib/profile.ts");
const events: any[] = [];
const profile = await buildProfile(
  { qid: "Q1", resolvedVia: "sparql" as const, label: "Тестовый Университет", lat: null, lon: null, officialWebsite: "https://example.edu", country: "Казахстан", city: "Астана", image: null, instanceOf: "университет" },
  (e) => events.push(e),
);

console.log("anchor:", profile.anchor);
console.log("removed:", profile.removed, "sources:", profile.sources, "vision:", profile.visionAvailable);
console.log("coverage:", JSON.stringify(profile.coverage.filter((c) => c.verified + c.probable + c.unverified)));
console.log("description:", profile.description);
console.log("warnings:", profile.warnings);
console.log("stages:", events.map((e) => e.stage).join(" → "));

// Якорь: Wikidata нет → Places + 2ГИС сошлись (расхождение ~30 м)
assert.equal(profile.anchor?.source, "places+2gis");
// Gemini: заголовок ключа и структурный вывод
assert.equal(captured.gemini[0].headers["x-goog-api-key"], "test-gemini");
assert.equal(captured.gemini[0].body.generationConfig.response_mime_type, "application/json");
assert.equal(captured.gemini[0].body.generationConfig.response_schema.type, "ARRAY");
// Мелкий логотип отсеян по размеру, копии — как дубли
assert.equal(profile.removed.tooSmall, 1);
assert.equal(profile.removed.duplicates, 1); // a2 — пережатая копия a
const fromGallery = profile.photos.find((p) => p.imageUrl.endsWith("/img/inner.jpg"));
assert.ok(fromGallery && fromGallery.source === "official_site", "снимок из внутренней галереи дошёл до профиля");
console.log("снимок из галереи в профиле:", fromGallery!.evidence.reasons[0]);
// Снимок «город» из места кампуса переразмечен по содержимому
const cityPhoto = profile.photos.find((p) => p.id === "places/P_CAMPUS/photos/c");
assert.ok(cityPhoto && cityPhoto.category === "city", "city photo should be recategorized");
assert.ok(cityPhoto!.evidence.reasons.some((r) => r.includes("Категория по содержимому")));
// Официальное фото: verified, provenance по домену, vision применён
const offPhoto = profile.photos.find((p) => p.source === "official_site");
assert.ok(offPhoto && offPhoto.trust === "verified" && offPhoto.evidence.vision);
assert.ok(offPhoto!.evidence.reasons[0].includes("example.edu"));
// Общежитие: ~450 м от якоря places+2gis → verified без понижения
const dorm = profile.photos.find((p) => p.id === "places/P_DORM/photos/b");
assert.ok(dorm && dorm.trust === "verified" && dorm.category === "dorm", JSON.stringify(dorm?.evidence));
// Кампус (источник якоря) при подтверждении 2ГИС → probable
const campus = profile.photos.find((p) => p.id === "places/P_CAMPUS/photos/a");
assert.ok(campus && campus.trust === "probable", JSON.stringify(campus?.evidence));
// Описание собрано из данных
assert.ok(profile.description.includes("Тестовый Университет") && profile.description.includes("2ГИС"));
assert.equal(campus!.evidence.address, "просп. Тестовый, 1, Астана");
assert.equal(offPhoto!.evidence.address, null);
assert.ok(profile.photos.every((p) => typeof p.retrievedAt === "string" && !Number.isNaN(Date.parse(p.retrievedAt))), "у каждого снимка дата получения");
console.log("retrievedAt ok:", profile.photos[0].retrievedAt);
console.log("address ok:", campus!.evidence.address);

// ---- 6. NDJSON-роут ----
const { GET } = await import("./app/api/profile/route.ts");
// подменим Wikidata для роута
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.startsWith("https://query.wikidata.org/")) {
    return Response.json({ results: { bindings: [{
      item: { value: "http://www.wikidata.org/entity/Q1" }, itemLabel: { value: "Тестовый Университет" },
      website: { value: "https://example.edu" }, countryLabel: { value: "Казахстан" }, cityLabel: { value: "Астана" }, instanceLabel: { value: "университет" },
    }] } });
  }
  return realFetch(input, init);
}) as any;
const res = await GET(new Request("http://localhost/api/profile?qid=Q1"));
assert.equal(res.headers.get("content-type")?.startsWith("application/x-ndjson"), true);
const text = await res.text();
const lines = text.trim().split("\n").map((l) => JSON.parse(l));
assert.equal(lines[0].type, "university");
assert.ok(lines.some((l) => l.type === "progress" && l.stage === "vision"));
assert.equal(lines[lines.length - 1].type, "profile");
assert.equal(lines[lines.length - 1].photos.length, profile.photos.length);
console.log("route ok:", lines.length, "lines;", lines.filter((l) => l.type === "progress").length, "progress events");

const bad = await GET(new Request("http://localhost/api/profile?qid=abc"));
assert.equal(bad.status, 400);

console.log("\nALL PIPELINE CHECKS PASSED");
