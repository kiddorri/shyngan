/* eslint-disable @typescript-eslint/no-explicit-any -- в тестовом стенде моки JSON намеренно допускают разные формы ответов API */
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
const IMG_C2 = await svgJpeg(1100, 800, `<rect width="1100" height="800" fill="#bcd"/><rect x="0" y="560" width="1100" height="240" fill="#363"/><circle cx="880" cy="180" r="140" fill="#ffd"/>`); // «городская сцена» вдали от кампуса
const IMG_OFF7 = await svgJpeg(1300, 800, `<rect width="1300" height="800" fill="#fff"/><rect x="0" y="0" width="380" height="800" fill="#1b1b1b"/><rect x="430" y="180" width="280" height="420" fill="#a5522a"/><circle cx="1060" cy="380" r="170" fill="#0a7ea4"/>`); // ещё один вид корпуса — седьмой кандидат в «кампус»
const IMG_LIB = await svgJpeg(1200, 800, `<rect width="1200" height="800" fill="#f6f1e7"/>${Array.from({length: 5}, (_, i) => `<rect x="${60 + i * 230}" y="120" width="170" height="560" fill="#7a5230"/>`).join("")}`); // читальный зал
const IMG_CANTEEN = await svgJpeg(1200, 800, `<rect width="1200" height="800" fill="#eef4f7"/><rect x="80" y="420" width="1040" height="60" fill="#345"/>${Array.from({length: 6}, (_, i) => `<circle cx="${140 + i * 180}" cy="330" r="70" fill="#c33"/>`).join("")}`); // столовая
const IMG_CITY = await svgJpeg(1200, 800, `<rect width="1200" height="800" fill="#dfe7f0"/><rect x="60" y="300" width="200" height="500" fill="#546"/><rect x="330" y="180" width="240" height="620" fill="#435"/><rect x="640" y="380" width="180" height="420" fill="#657"/><rect x="900" y="240" width="240" height="560" fill="#354"/>`); // городская площадь
const IMG_MONUMENT = await svgJpeg(900, 1200, `<rect width="900" height="1200" fill="#cdd6de"/><rect x="330" y="240" width="240" height="800" fill="#6b6257"/><circle cx="450" cy="190" r="110" fill="#8c8375"/>`); // памятник крупным планом
const IMG_CAMPUS2 = await svgJpeg(1200, 800, `<rect width="1200" height="800" fill="#e9eef2"/><rect x="120" y="180" width="300" height="560" fill="#2f4858"/><rect x="520" y="360" width="240" height="380" fill="#86a3b8"/><rect x="860" y="120" width="220" height="620" fill="#41525e"/><circle cx="640" cy="180" r="60" fill="#f0c14b"/>`); // второй корпус
const IMG_NEWS = await svgJpeg(1200, 800, `<rect width="1200" height="800" fill="#f3efe6"/><rect x="0" y="560" width="1200" height="240" fill="#4a5d3a"/><rect x="180" y="200" width="300" height="360" fill="#b5651d"/><circle cx="820" cy="300" r="150" fill="#2c3e50"/>`); // снимок с новости
const IMG_LOGO = await jpeg(200, 100, "#ffffff");       // мелкая иконка на сайте
// Расфокусированный кадр: размер нормальный, смотреть нечего.
const IMG_BLUR = await sharp(await svgJpeg(1200, 800, `<rect width="1200" height="800" fill="#cfd8dc"/><rect x="200" y="200" width="800" height="400" fill="#607d8b"/>`)).blur(18).jpeg({ quality: 80 }).toBuffer();
const IMG_OFF = await svgJpeg(1400, 900, `<rect width="1400" height="900" fill="#c9d6df"/><polygon points="700,100 1300,800 100,800" fill="#553"/>`); // официальное фото
const IMG_OFF3 = await svgJpeg(1200, 800, `<rect width="1200" height="800" fill="#eee"/><rect x="0" y="400" width="1200" height="400" fill="#246"/><circle cx="300" cy="200" r="120" fill="#fc0"/>`); // снимок из внутренней галереи
const IMG_OFF2 = await svgJpeg(1300, 900, `<rect width="1300" height="900" fill="#fff"/><rect x="100" y="100" width="1100" height="700" fill="none" stroke="#000" stroke-width="60"/>`); // второе официальное
const IMG_OFF4 = await svgJpeg(1200, 900, `<rect width="1200" height="900" fill="#fff"/>${Array.from({length: 8}, (_, i) => `<polygon points="${i * 150},900 ${i * 150 + 80},900 ${i * 150 + 220},0 ${i * 150 + 140},0" fill="#135"/>`).join("")}`); // снимок из фотоальбома
const IMG_OFF5 = await svgJpeg(1100, 800, `<rect width="1100" height="800" fill="#eee"/>${Array.from({length: 16}, (_, i) => (i % 4 + Math.floor(i / 4)) % 2 === 0 ? `<rect x="${(i % 4) * 275}" y="${Math.floor(i / 4) * 200}" width="275" height="200" fill="#420"/>` : "").join("")}`); // фон раздела «Кампус»
const IMG_OFF6 = await svgJpeg(1000, 900, `<rect width="1000" height="900" fill="#9ab"/><circle cx="250" cy="250" r="230" fill="#fff"/><rect x="520" y="500" width="440" height="360" fill="#000"/>`); // фон из блока <style> на главной

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
<style>.cover{background:url('/img/bg-hall.jpg') no-repeat center}</style>
</head><body>
<img src="/img/logo.png">
<img data-src="https://cdn.example.edu/campus.jpg" src="data:image/gif;base64,R0lGOD">
<img srcset="/img/hero.jpg 1200w, /img/hero-small.jpg 600w">
<img src="/icons/i.svg">
<a href="/dlya-inostrannyh-abiturientov/">Для иностранных абитуриентов</a>
<a href="/fakultet-arhitektury/">Факультет архитектуры</a>
<a href="/studencheskaya-zhizn">Студенческая жизнь</a>
<a href="/gallery">Фотогалерея кампуса</a>
<a href="/virtualnyj-tur">Виртуальный тур по кампусу</a>
<a href="/fotoalbom">Фотоальбом выпуска</a>
<a href="/kampus">Наш кампус</a>
<a href="/biblioteka">Научная библиотека</a>
<a href="/stolovaya">Столовая и буфеты</a>
<a href="/sportkompleks">Спорткомплекс университета</a>
<a href="/news/2026/03/den-otkrytyh-dverej">День открытых дверей 2026</a>
<a href="/contacts">Контакты</a>
<a href="https://other.example.com/gallery">Чужая галерея</a>
</body></html>`;

const GALLERY_HTML = `<html><body>
<a href="/img/inner.jpg">полный размер</a>
<img src="/img/inner2.jpg">
<img src="/img/private/secret.jpg">
</body></html>`;

// Страница тура: плеер панорам, отдельных файлов-снимков нет.
const TOUR_HTML = `<html><body><div id="pano"></div></body></html>`;

// В альбоме рядом с нормальным снимком лежит расфокусированный кадр.
const ALBUM_HTML = `<html><body><img src="/img/album1.jpg"><img src="/img/blurry.jpg"></body></html>`;
// Плитка раздела задана CSS-фоном: в <img> такого снимка нет вообще.
const KAMPUS_HTML = `<html><body><div class="tile" style="background-image:url(/img/yard.jpg)"></div></body></html>`;
// Разделы под категории: общая галерея вуза состоит из фасадов, а читальный зал и
// столовая лежат здесь — без целевого обхода до них дело не доходило.
const LIB_HTML = `<html><body><img src="/img/lib.jpg"></body></html>`;
// Новость: единственный источник во всём проекте, у которого есть дата публикации.
const NEWS_HTML = `<html><head>
<meta property="article:published_time" content="2026-03-12T09:00:00Z">
</head><body><img src="/img/news1.jpg"></body></html>`;
const CANTEEN_HTML = `<html><body><img src="/img/canteen.jpg"></body></html>`;
// Слабая ссылка: текстовый раздел без единой фотографии. Открывать её не запрещено —
// важно, что она идёт после галерей и категорийных разделов, а не вместо них.
const STUD_HTML = `<html><body><h1>Конференции студентов</h1><p>Расписание.</p></body></html>`;

const placeCampus = {
  id: "P_CAMPUS", displayName: { text: "Тестовый Университет" }, formattedAddress: "просп. Тестовый, 1, Астана",
  addressComponents: [{ longText: "Астана", types: ["locality"] }],
  location: { latitude: 51.0900, longitude: 71.4000 },
  googleMapsUri: "https://maps.google.com/?cid=1",
  // Ровно два снимка: с одного места больше не берём — третий кадр того же здания
  // профилю ничего не добавляет.
  photos: [
    { name: "places/P_CAMPUS/photos/a", widthPx: 1200, heightPx: 800, authorAttributions: [{ displayName: "User A", uri: "https://maps.google.com/contrib/1" }] },
    { name: "places/P_CAMPUS/photos/a2", widthPx: 600, heightPx: 400 },   // копия A → дубль
  ],
};
// Учебный корпус: по запросу это «аудитории», а на снимке — городская улица.
// Проверяем, что категорию определяет содержимое, а не текст запроса.
const placeLecture = {
  id: "P_LECTURE", displayName: { text: "Учебный корпус №2" },
  location: { latitude: 51.0970, longitude: 71.4010 }, // ~780 м: порог окружения проходит
  googleMapsUri: "https://maps.google.com/?cid=4",
  photos: [{ name: "places/P_LECTURE/photos/c", widthPx: 900, heightPx: 700 }],
};
const placeDorm = {
  id: "P_DORM", displayName: { text: "Общежитие №1" },
  location: { latitude: 51.0930, longitude: 71.4050 }, // ~450 м
  googleMapsUri: "https://maps.google.com/?cid=2",
  photos: [{ name: "places/P_DORM/photos/b", widthPx: 1000, heightPx: 700 }],
};

// Парк в 3 км от кампуса: место настоящее, расстояние в пределах порога «вероятно»
// (6 км), но для категории «вокруг кампуса» это уже другой район города.
// Центр города: другой конец города, но тот же город — адрес это подтверждает.
const placeCityCenter = {
  id: "P_CITY", displayName: { text: "Площадь Независимости" }, formattedAddress: "просп. Мангилик Ел, Астана, Казахстан",
  addressComponents: [{ longText: "Астана", types: ["locality"] }],
  location: { latitude: 51.1500, longitude: 71.4700 }, // ~8 км от якоря
  googleMapsUri: "https://maps.google.com/?cid=5",
  photos: [{ name: "places/P_CITY/photos/e", widthPx: 1200, heightPx: 800 }],
};
// Памятник в том же городе: место настоящее, адрес верный — но кадр крупный план,
// и городом он не является.
const placeMonument = {
  id: "P_MONUMENT", displayName: { text: "Монумент" }, formattedAddress: "ул. Центральная, Астана, Казахстан",
  addressComponents: [{ longText: "Астана", types: ["locality"] }],
  location: { latitude: 51.1480, longitude: 71.4650 },
  googleMapsUri: "https://maps.google.com/?cid=6",
  photos: [{ name: "places/P_MONUMENT/photos/f", widthPx: 900, heightPx: 1200 }],
};
// Второй корпус того же вуза на другом конце города: расстояние за порогом, но
// название совпадает — профиль обязан это назвать, а не молча писать «не подтверждено».
const placeSecondCampus = {
  id: "P_CAMPUS2", displayName: { text: "Тестовый Университет, второй корпус" },
  formattedAddress: "ул. Дальняя 7, Астана", addressComponents: [{ longText: "Астана", types: ["locality"] }],
  location: { latitude: 51.1700, longitude: 71.4900 }, // ~10 км
  googleMapsUri: "https://maps.google.com/?cid=7",
  photos: [{ name: "places/P_CAMPUS2/photos/g", widthPx: 1200, heightPx: 800 }],
};
const placeFarPark = {
  id: "P_PARK_FAR", displayName: { text: "Центральный парк" }, formattedAddress: "просп. Дальний, 100, Астана",
  location: { latitude: 51.1170, longitude: 71.4000 }, // ~3 км на север от якоря
  googleMapsUri: "https://maps.google.com/?cid=3",
  photos: [{ name: "places/P_PARK_FAR/photos/d", widthPx: 1100, heightPx: 800 }],
};

const imageByName: Record<string, Buffer> = {
  "places/P_CAMPUS/photos/a": IMG_A,
  "places/P_CAMPUS/photos/a2": IMG_A_COPY,
  "places/P_LECTURE/photos/c": IMG_C,
  "places/P_DORM/photos/b": IMG_B,
  "places/P_PARK_FAR/photos/d": IMG_C2,
  "places/P_CITY/photos/e": IMG_CITY,
  "places/P_MONUMENT/photos/f": IMG_MONUMENT,
  "places/P_CAMPUS2/photos/g": IMG_CAMPUS2,
};

globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === "string" ? input : input.url;
  const u = new URL(url);
  if (u.hostname === "www.wikidata.org" && u.pathname === "/w/api.php") {
    return Response.json({ entities: { Q1: { id: "Q1", claims: {} } } });
  }

  // Place Details: GET /v1/places/{place_id} — без двоеточий и вложенных сегментов,
  // поэтому ни searchText, ни .../photos/.../media сюда не попадают.
  if (u.hostname === "places.googleapis.com" && /^\/v1\/places\/[^/:]+$/.test(u.pathname)) {
    const mask = init.headers["X-Goog-FieldMask"] as string;
    assert.equal(mask.includes("places."), false, "в Place Details поля идут без префикса places.");
    // Отзывы запрашиваются отдельным вызовом с минимальной маской: поле дороже
    // остальной карточки, и тянуть его вместе со всем подряд нельзя.
    if (mask === "reviews") {
      return Response.json({
        reviews: [
          {
            authorAttribution: { displayName: "Айгерим К.", uri: "https://maps.google.com/contrib/9" },
            rating: 5,
            text: { text: "Отличный кампус, большая библиотека.", languageCode: "ru" },
            publishTime: "2026-04-12T08:30:00Z",
          },
          { authorAttribution: { displayName: "Пустой отзыв" }, rating: 4, text: { text: "   " }, publishTime: "2026-05-01T10:00:00Z" },
        ],
      });
    }
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
    if (body.textQuery.includes("учебный корпус")) return Response.json({ places: [placeLecture, placeSecondCampus] });
    if (body.textQuery.includes("смотровая площадка")) {
      assert.equal(body.locationBias.circle.radius, 20000, "город ищем в широком радиусе");
      return Response.json({ places: [placeCityCenter] });
    }
    if (body.textQuery.includes("центр города")) return Response.json({ places: [placeMonument] });
    if (body.textQuery === "парк") {
      assert.equal(body.locationBias.circle.radius, 2000, "окружение ищется в узком радиусе");
      // Узкий радиус — это смещение выдачи, а не фильтр: Places вправе вернуть место
      // и за его пределами. Отбрасывать такое — работа профиля, а не поиска.
      return Response.json({ places: [placeFarPark] });
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
  if (u.hostname === "example.edu" && u.pathname === "/fotoalbom") {
    return new Response(ALBUM_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (u.hostname === "example.edu" && u.pathname === "/kampus") {
    return new Response(KAMPUS_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  // robots.txt: раздел «Спорткомплекс» и папка /img/private закрыты для всех агентов.
  // Группа для BadBot к нам не относится — её правила применяться не должны.
  if (u.hostname === "example.edu" && u.pathname === "/robots.txt") {
    return new Response(
      ["User-agent: BadBot", "Disallow: /", "", "User-agent: *", "Disallow: /sportkompleks", "Disallow: /img/private/", "Allow: /"].join("\n"),
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  if (u.hostname === "example.edu" && u.pathname === "/sportkompleks") throw new Error("раздел закрыт robots.txt — запрашивать нельзя");
  if (u.hostname === "example.edu" && u.pathname.startsWith("/img/private/")) throw new Error("файл закрыт robots.txt — запрашивать нельзя");
  if (u.hostname === "example.edu" && u.pathname === "/news/2026/03/den-otkrytyh-dverej") {
    return new Response(NEWS_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (u.hostname === "example.edu" && u.pathname === "/biblioteka") {
    return new Response(LIB_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (u.hostname === "example.edu" && u.pathname === "/stolovaya") {
    return new Response(CANTEEN_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (u.hostname === "example.edu" && u.pathname === "/contacts") throw new Error("контакты не должны запрашиваться");
  // Ранг ссылки важнее порядка в вёрстке: «Студенческая жизнь» стоит в HTML первой,
  // но бюджет должен сначала уйти на галереи и категорийные разделы. Страница
  // отдаётся пустой — проверяется её место в очереди, а не факт запроса.
  if (u.hostname === "example.edu" && u.pathname === "/studencheskaya-zhizn") {
    return new Response(STUD_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  // Основа «тур» раньше совпадала с «абиТУРиент» и «архитекТУРа» — обход тратил
  // бюджет страниц на разделы без фотографий.
  if (u.hostname === "example.edu" && u.pathname === "/dlya-inostrannyh-abiturientov/") throw new Error("«абитуриенты» не должны запрашиваться");
  if (u.hostname === "example.edu" && u.pathname === "/fakultet-arhitektury/") throw new Error("«архитектура» не должна запрашиваться");
  if (u.hostname === "other.example.com") throw new Error("чужой домен не должен запрашиваться");
  if (u.hostname === "example.edu" && u.pathname === "/img/inner.jpg") return new Response(IMG_OFF3, { headers: { "content-type": "image/jpeg" } });
  if (u.hostname === "example.edu" && u.pathname === "/img/album1.jpg") return new Response(IMG_OFF4, { headers: { "content-type": "image/jpeg" } });
  if (u.hostname === "example.edu" && u.pathname === "/img/yard.jpg") return new Response(IMG_OFF5, { headers: { "content-type": "image/jpeg" } });
  if (u.hostname === "example.edu" && u.pathname === "/img/bg-hall.jpg") return new Response(IMG_OFF6, { headers: { "content-type": "image/jpeg" } });
  if (u.hostname === "example.edu" && u.pathname === "/img/blurry.jpg") return new Response(IMG_BLUR, { headers: { "content-type": "image/jpeg" } });
  if (u.hostname === "example.edu" && u.pathname === "/img/inner2.jpg") return new Response(IMG_OFF7, { headers: { "content-type": "image/jpeg" } });
  if (u.hostname === "example.edu" && u.pathname === "/img/lib.jpg") return new Response(IMG_LIB, { headers: { "content-type": "image/jpeg" } });
  if (u.hostname === "example.edu" && u.pathname === "/img/news1.jpg") return new Response(IMG_NEWS, { headers: { "content-type": "image/jpeg" } });
  if (u.hostname === "example.edu" && u.pathname === "/img/canteen.jpg") return new Response(IMG_CANTEEN, { headers: { "content-type": "image/jpeg" } });
  if (u.hostname === "example.edu" && u.pathname === "/img/hero.jpg") return new Response(IMG_OFF, { headers: { "content-type": "image/jpeg" } });
  if (u.hostname === "example.edu" && u.pathname === "/img/logo.png") return new Response(IMG_LOGO, { headers: { "content-type": "image/png" } });
  if (u.hostname === "example.edu" && u.pathname === "/img/hero-small.jpg") return new Response(IMG_OFF, { headers: { "content-type": "image/jpeg" } });
  if (u.hostname === "cdn.example.edu") return new Response(IMG_OFF2, { headers: { "content-type": "image/jpeg" } });
  // Nominatim (OpenStreetMap): центр города для расстояния «кампус — центр».
  if (u.hostname === "nominatim.openstreetmap.org") {
    assert.ok((init?.headers?.["User-Agent"] ?? "").includes("shyngan"), "Nominatim требует осмысленный User-Agent");
    return Response.json([
      { lat: "51.1600", lon: "71.4700", name: "Астана", display_name: "Астана, Казахстан", class: "place", type: "city" },
    ]);
  }
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
        category: kind === "logo" ? "other" : (KIND_CATEGORY[kind] ?? kind),
        caption: CAPTIONS[kind],
        confidence: "high",
        // Крупным планом в моке считается только «памятник»: на нём проверяется,
        // что в категорию «Город» попадают общие виды, а не предметы в городе.
        wideView: kind !== "monument",
      };
    });
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(verdicts) }] } }] });
  }
  throw new Error("unexpected fetch: " + url);
}) as any;

// Мок модели: «что изображено» определяем по длине нормализованного буфера —
// у всех тестовых картинок она разная. Всё незарегистрированное считаем кампусом.
type Kind = "campus" | "city" | "dorm" | "logo" | "sport" | "library" | "life" | "monument";
const CAPTIONS: Record<Kind, string> = {
  campus: "учебный корпус",
  city: "городская улица",
  dorm: "жилой корпус",
  logo: "логотип",
  sport: "спортивная площадка",
  library: "читальный зал",
  life: "столовая",
  monument: "памятник крупным планом",
};
/** Памятник модель относит к городу, но это крупный план — в профиль он попасть не должен. */
const KIND_CATEGORY: Partial<Record<Kind, string>> = { monument: "city" };
function sizeKind(bytes: Buffer): Kind {
  const n = bytes.length;
  if (n < 3000) return "logo"; // logo — очень маленькая
  return kindByKey.get(n) ?? "campus";
}
const kindByKey = new Map<number, Kind>();
// заранее прогоним нормализацию, чтобы знать длины
const { loadImage } = await import("./lib/image.ts");
const kinds: Array<[string, Kind]> = [
  ["https://lh3.test/" + encodeURIComponent("places/P_LECTURE/photos/c"), "city"],
  ["https://lh3.test/" + encodeURIComponent("places/P_DORM/photos/b"), "dorm"],
  ["https://lh3.test/" + encodeURIComponent("places/P_PARK_FAR/photos/d"), "city"],
  // Снимки из целевых разделов сайта: ради них обход и стал категорийным.
  ["https://example.edu/img/lib.jpg", "library"],
  ["https://example.edu/img/canteen.jpg", "life"],
  ["https://example.edu/img/yard.jpg", "sport"],
  ["https://lh3.test/" + encodeURIComponent("places/P_CITY/photos/e"), "city"],
  ["https://lh3.test/" + encodeURIComponent("places/P_MONUMENT/photos/f"), "monument"],
];
for (const [url, kind] of kinds) {
  const li = await loadImage(url, "t");
  kindByKey.set(li!.bytes.length, kind);
}

// ---- 3. official.ts ----
const { collectOfficialImages } = await import("./lib/official.ts");
const off = await collectOfficialImages("https://example.edu", "t");
assert.equal(off.error, null);
const offUrls = off.candidates.map((c) => c.url);
// Бюджет кандидатов идёт по кругу: первая картинка каждой страницы, потом вторая и так
// далее. Иначе изображения главной занимают начало списка целиком.
const firstFourPages = off.candidates.slice(0, 4).map((c) => c.pageUrl);
assert.equal(new Set(firstFourPages).size, 4, `первые кандидаты должны быть с разных страниц: ${firstFourPages.join(", ")}`);
for (const url of [
  "https://example.edu/img/hero.jpg",          // og:image с главной
  "https://example.edu/img/inner.jpg",         // галерея
  "https://example.edu/img/album1.jpg",        // фотоальбом
  "https://example.edu/img/yard.jpg",          // CSS-фон в разделе «Кампус»
  "https://example.edu/img/lib.jpg",           // целевой раздел «Библиотека»
  "https://example.edu/img/canteen.jpg",       // целевой раздел «Столовая»
  "https://cdn.example.edu/campus.jpg",        // data-src, data: пропущен
  "https://example.edu/img/bg-hall.jpg",       // фон из блока <style> на главной
]) {
  assert.ok(offUrls.includes(url), `кандидат потерян: ${url}`);
}
// «Абитуриенты» и «архитектура» не открываются вообще (иначе мок бросит ошибку),
// «контакты» — тоже. Категорийные разделы обязаны быть прочитаны.
for (const page of ["https://example.edu/biblioteka", "https://example.edu/stolovaya"]) {
  assert.ok(off.pagesVisited.includes(page), `категорийный раздел не прочитан: ${page}`);
}
// Слабая ссылка открывается только после галерей и категорийных разделов.
const order = off.pagesVisited;
const weak = order.indexOf("https://example.edu/studencheskaya-zhizn");
for (const strong of ["https://example.edu/gallery", "https://example.edu/biblioteka", "https://example.edu/stolovaya"]) {
  assert.ok(weak === -1 || weak > order.indexOf(strong), `слабая ссылка обогнала ${strong}`);
}
// robots.txt: закрытый раздел не запрашивается, а попадает в список пропущенного.
// Файл под закрытым путём не становится кандидатом и потому не скачивается.
assert.ok(off.robotsNote?.includes("robots.txt прочитан"), `robots.txt не прочитан: ${off.robotsNote}`);
assert.ok(off.blockedByRobots.some((u) => u.endsWith("/sportkompleks")), `закрытый раздел не отмечен: ${off.blockedByRobots.join(", ")}`);
assert.equal(off.pagesVisited.some((u) => u.endsWith("/sportkompleks")), false);
assert.equal(offUrls.some((u) => u.includes("/img/private/")), false, "файл из закрытой папки не должен попадать в кандидаты");
console.log("robots.txt ok:", off.robotsNote, "| пропущено:", off.blockedByRobots.length);
// Даты публикации: единственный источник настоящей даты во всём проекте.
const { pageDate } = await import("./lib/official.ts");
assert.equal(pageDate('<meta property="article:published_time" content="2026-03-12T09:00:00Z">', "https://x/"), new Date("2026-03-12T09:00:00Z").toISOString());
assert.equal(pageDate("<html></html>", "https://x/news/2026/03/12/dver"), new Date(Date.UTC(2026, 2, 12)).toISOString());
assert.equal(pageDate("<html></html>", "https://x/about"), null, "без даты — null, а не сегодняшнее число");
const newsCandidate = off.candidates.find((c) => c.url.endsWith("/img/news1.jpg"));
assert.ok(newsCandidate, "снимок с новости не найден");
assert.equal(newsCandidate!.publishedAt, new Date("2026-03-12T09:00:00Z").toISOString());
console.log("даты публикации ok:", newsCandidate!.publishedAt);
console.log("обход второго уровня ok:", off.pagesVisited);

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

// ---- 4c. распределение бюджета снимков между местами ----
const { buildProfile, interleave } = await import("./lib/profile.ts");
// Место с тремя снимками не должно съедать бюджет: хвост плана (столовая, музей)
// обязан получить свою долю, иначе категория пустует не из-за отсутствия снимков.
assert.deepEqual(interleave([["a1", "a2", "a3"], ["b1"], ["c1", "c2"]], 4), ["a1", "b1", "c1", "a2"]);
assert.deepEqual(interleave([["a1", "a2"], ["b1"]], 10), ["a1", "b1", "a2"]);
assert.deepEqual(interleave([], 5), []);
console.log("распределение бюджета ok");

// ---- 5. полный профиль ----
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
// Потери между загрузкой и дедупликацией называются отдельным событием: раньше они
// молча растворялись, и «осталось N» читалось как результат отсева дублей.
const prefilter = events.find((e) => e.stage === "prefilter");
assert.ok(prefilter, "события prefilter нет");
assert.equal(prefilter.kept + prefilter.failedDownload + prefilter.tooSmall + prefilter.blurry + prefilter.overSiteLimit, events.find((e) => e.stage === "download")!.total, "потери между загрузкой и сравнением должны сходиться с числом загруженных");

// Якорь: Wikidata нет → Places + 2ГИС сошлись (расхождение ~30 м)
assert.equal(profile.anchor?.source, "places+2gis");
// Gemini: заголовок ключа и структурный вывод
assert.equal(captured.gemini[0].headers["x-goog-api-key"], "test-gemini");
assert.equal(captured.gemini[0].body.generationConfig.response_mime_type, "application/json");
assert.equal(captured.gemini[0].body.generationConfig.response_schema.type, "ARRAY");
// Мелкий логотип отсеян по размеру, копии — как дубли
assert.equal(profile.removed.tooSmall, 1);
assert.equal(profile.removed.duplicates, 1); // a2 — пережатая копия a
// Расфокусированный кадр отсеян по резкости, а не по «похоже на мусор».
assert.equal(profile.removed.blurry, 1, "размытый снимок должен отсеиваться");
assert.equal(profile.photos.some((p) => p.imageUrl.endsWith("/img/blurry.jpg")), false);
// С одного места берём не больше двух снимков, из окружения — один.
for (const placeId of ["P_CAMPUS", "P_DORM", "P_LECTURE", "P_PARK_FAR"]) {
  const n = profile.photos.filter((p) => p.evidence.placeId === placeId).length;
  assert.ok(n <= 2, `с места ${placeId} взято ${n} снимков`);
}
// Снимки из целевых разделов сайта дошли до профиля.
for (const url of ["/img/lib.jpg", "/img/canteen.jpg"]) {
  assert.ok(profile.photos.some((p) => p.imageUrl.endsWith(url)), `снимок из целевого раздела потерян: ${url}`);
}
// Потолок на категорию: в «кампусе» кандидатов больше шести, лишние посчитаны.
for (const c of profile.coverage) {
  const total = c.verified + c.probable + c.unverified;
  assert.ok(total <= (c.category === "city" ? 3 : 6), `категория ${c.category}: ${total} снимков сверх потолка`);
}
assert.ok(profile.removed.overCategoryLimit >= 1, "лишние снимки категории должны быть посчитаны");
const queries: string[] = captured.places.map((b) => b.textQuery);
for (const part of ["учебный корпус", "актовый зал", "столовая"]) {
  assert.ok(queries.some((q: string) => q.includes(part)), `в плане поиска нет запроса «${part}»: ${queries.join(" | ")}`);
}
// «Музей» и «коворкинг» уводят Places к известным городским заведениям: по «<вуз> музей»
// возвращался главный музей города за несколько километров от кампуса.
for (const part of ["музей", "коворкинг"]) {
  assert.ok(!queries.some((q: string) => q.includes(part)), `запрос «${part}» не должен быть в плане: ${queries.join(" | ")}`);
}
console.log("план запросов ok:", queries.length, "запросов");
// Парк в 3 км: место найдено, содержимое подтверждено, но для «вокруг кампуса» далеко.
assert.equal(profile.removed.farFromCampus, 1, "далёкое окружение должно отсеиваться");
assert.equal(profile.photos.some((p) => p.id === "places/P_PARK_FAR/photos/d"), false, "далёкий парк не должен попасть в профиль");
assert.equal(profile.removed.overSiteLimit, 0, "лимит на один сайт здесь не срабатывает: кандидатов меньше десяти");
// Ни один снимок «вокруг кампуса» не может оказаться дальше порога пешей доступности.
for (const p of profile.photos.filter((p) => p.category === "city")) {
  assert.ok(p.evidence.distanceM === null || p.evidence.distanceM <= 2000, `окружение дальше порога: ${p.evidence.distanceM} м`);
}
console.log("порог окружения ok: отсеяно", profile.removed.farFromCampus);

// Требование 2 кейса: фотографии города, в котором расположен университет.
// Город — отдельная категория: у неё другое проверяемое утверждение.
const cityWide = profile.photos.find((p) => p.id === "places/P_CITY/photos/e");
assert.ok(cityWide, "снимок города не попал в профиль");
assert.equal(cityWide!.category, "citywide", "снимок города не должен становиться окружением кампуса");
assert.equal(cityWide!.trust, "verified", "адрес содержит город и расстояние в пределах города — уровень «тот же город»");
assert.ok(cityWide!.evidence.reasons.some((r) => r.includes("совпадает с городом кампуса")), JSON.stringify(cityWide!.evidence.reasons));
assert.ok(cityWide!.evidence.reasons.some((r) => r.includes("не объекта вуза")), "утверждение про город должно быть названо явно");
// Порог пешей доступности к городу не применяется: это разные категории.
assert.ok(cityWide!.evidence.distanceM! > 2000, "тестовый центр города дальше двух километров");
assert.ok(cityWide!.evidence.reasons.some((r) => r.includes("общий вид")), "у снимка города должна быть отметка про общий вид");
// Памятник крупным планом — это фотография предмета, а не города.
assert.equal(profile.photos.some((p) => p.id === "places/P_MONUMENT/photos/f"), false, "крупный план не должен попадать в категорию «Город»");
assert.equal(profile.removed.cityNotWide, 1, "крупный план города должен быть посчитан");
console.log("город ok:", cityWide!.evidence.distanceM, "м,", cityWide!.trust, "| крупных планов отсеяно:", profile.removed.cityNotWide);

// Дополнительная функция: расстояние до центра города по данным OpenStreetMap.
assert.ok(profile.cityCenter, "центр города не определён");
assert.equal(profile.cityCenter!.source, "openstreetmap");
assert.ok(profile.cityCenter!.distanceM > 5000, `расстояние до центра: ${profile.cityCenter!.distanceM}`);
console.log("центр города ok:", profile.cityCenter!.name, profile.cityCenter!.distanceM, "м");

// Дополнительная функция: план кампуса строится по местам, давшим снимки.
assert.ok(profile.mapPoints.length >= 3, `точек на плане: ${profile.mapPoints.length}`);
for (const p of profile.mapPoints) {
  assert.ok(p.photos > 0, `на плане место без снимков: ${p.name}`);
  assert.ok(Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.distanceM >= 0);
}
console.log("план кампуса ok:", profile.mapPoints.length, "мест");

// Второй корпус: за порогом расстояния, но с совпадающим названием — «вероятно»,
// и в причинах прямо сказано, что географического подтверждения нет.
const second = profile.photos.find((p) => p.id === "places/P_CAMPUS2/photos/g");
assert.ok(second, "снимок второго корпуса потерян");
assert.equal(second!.trust, "probable", "дальний корпус с совпадающим названием — «вероятно»");
assert.ok(second!.evidence.reasons.some((r) => r.includes("Название места совпадает с названием вуза")), JSON.stringify(second!.evidence.reasons));
console.log("второй корпус ok:", second!.evidence.distanceM, "м,", second!.trust);

// Дополнительная функция: отзывы с настоящей датой публикации.
assert.equal(profile.reviews.length, 1, "пустой отзыв не должен попадать в профиль");
assert.equal(profile.reviews[0].author, "Айгерим К.");
assert.ok(profile.reviews[0].publishedAt && !Number.isNaN(Date.parse(profile.reviews[0].publishedAt)), "у отзыва должна быть дата публикации");
console.log("отзывы ok:", profile.reviews.length, profile.reviews[0].publishedAt);

// Снимок с новости доносит дату до профиля, и причина говорит, что именно она значит.
const newsPhoto = profile.photos.find((p) => p.imageUrl.endsWith("/img/news1.jpg"));
assert.ok(newsPhoto, "снимок с новости не дошёл до профиля");
assert.equal(newsPhoto!.publishedAt, new Date("2026-03-12T09:00:00Z").toISOString());
assert.ok(newsPhoto!.evidence.reasons.some((r) => r.includes("Страница опубликована")), JSON.stringify(newsPhoto!.evidence.reasons));
assert.ok(profile.photos.every((p) => p.source === "official_site" || p.publishedAt === null), "у снимков Places даты публикации быть не может");
console.log("дата у снимка профиля ok:", newsPhoto!.publishedAt);
const fromCss = profile.photos.find((p) => p.imageUrl.endsWith("/img/yard.jpg"));
assert.ok(fromCss && fromCss.source === "official_site", "снимок из CSS-фона дошёл до профиля");
// Ради этого обход и стал категорийным: библиотека, столовая и спорт наполняются
// с сайта вуза, а не из Places, где лежат одни фасады.
for (const [url, category] of [["/img/lib.jpg", "library"], ["/img/canteen.jpg", "life"], ["/img/yard.jpg", "sport"]] as const) {
  const p = profile.photos.find((p) => p.imageUrl.endsWith(url));
  assert.ok(p && p.category === category, `категория ${category} не наполнена с сайта: ${url}`);
}
// Конкретный кадр может не пройти потолок категории — важно, что страница галереи
// вообще доносит снимки до профиля.
const fromGallery = profile.photos.find((p) => p.sourceUrl?.endsWith("/gallery"));
assert.ok(fromGallery && fromGallery.source === "official_site", "ни один снимок из внутренней галереи не дошёл до профиля");
console.log("снимок из галереи в профиле:", fromGallery!.evidence.reasons[0]);
// Снимок «город», найденный запросом про учебный корпус, переразмечен по содержимому
const cityPhoto = profile.photos.find((p) => p.id === "places/P_LECTURE/photos/c");
assert.ok(cityPhoto && cityPhoto.category === "city", "city photo should be recategorized");
assert.ok(cityPhoto!.evidence.reasons.some((r) => r.includes("Категория по содержимому")));
// Официальное фото: verified, provenance по домену, vision применён
const offPhoto = profile.photos.find((p) => p.source === "official_site");
assert.ok(offPhoto && offPhoto.trust === "verified" && offPhoto.evidence.vision);
assert.ok(offPhoto!.evidence.reasons[0].includes("example.edu"));
// Общежитие рядом с вузом, но без совпадения имени/домена → probable.
const dorm = profile.photos.find((p) => p.id === "places/P_DORM/photos/b");
assert.ok(dorm && dorm.trust === "probable" && dorm.category === "dorm", JSON.stringify(dorm?.evidence));
// Кампус (источник якоря) при подтверждении 2ГИС → probable
const campus = profile.photos.find((p) => p.id === "places/P_CAMPUS/photos/a");
assert.ok(campus && campus.trust === "probable", JSON.stringify(campus?.evidence));
// Описание собрано из данных
assert.ok(profile.description.includes("Тестовый Университет") && profile.description.includes("независимых картографических источников"));
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
  if (url.startsWith("https://www.wikidata.org/w/api.php")) {
    const params = new URL(url).searchParams;
    const entities: Record<string, unknown> = {};
    for (const id of (params.get("ids") ?? "").split("|")) {
      if (id === "Q1") entities[id] = {
        id, labels: { ru: { value: "Тестовый Университет" } },
        descriptions: { ru: { value: "университет" } },
        claims: {
          P31: [{ mainsnak: { datavalue: { value: { id: "Q3918" } } } }],
          P17: [
            { qualifiers: { P582: [{}] }, mainsnak: { datavalue: { value: { id: "Q4" } } } },
            { mainsnak: { datavalue: { value: { id: "Q2" } } } },
          ],
          P131: [{ mainsnak: { datavalue: { value: { id: "Q3" } } } }],
          P856: [{ mainsnak: { datavalue: { value: "https://example.edu" } } }],
        },
      };
      if (id === "Q2") entities[id] = { labels: { ru: { value: "Казахстан" } } };
      if (id === "Q3") entities[id] = { labels: { ru: { value: "Астана" } } };
      if (id === "Q4") entities[id] = { labels: { ru: { value: "СССР" } } };
      if (id === "Q3918") entities[id] = { labels: { ru: { value: "университет" } } };
    }
    return Response.json({ entities });
  }
  if (url.startsWith("https://query.wikidata.org/")) {
    return Response.json({ results: { bindings: [{
      item: { value: "http://www.wikidata.org/entity/Q1" }, itemLabel: { value: "Тестовый Университет" },
      website: { value: "https://example.edu" }, countryLabel: { value: "Казахстан" }, cityLabel: { value: "Астана" }, instanceLabel: { value: "университет" },
    }] } });
  }
  return realFetch(input, init);
}) as any;
const res = await GET(new Request("http://localhost/api/profile?qid=Q1&mode=deep"));
assert.equal(res.headers.get("content-type")?.startsWith("application/x-ndjson"), true);
const text = await res.text();
const lines = text.trim().split("\n").map((l) => JSON.parse(l));
assert.equal(lines[0].type, "university");
assert.equal(lines[0].university.country, "Казахстан", "историческая страна с P582 не должна подменить действующую");
assert.ok(lines.some((l) => l.type === "progress" && l.stage === "vision"));
assert.equal(lines[lines.length - 1].type, "profile");
assert.equal(lines[lines.length - 1].mode, "deep");
assert.equal(lines[lines.length - 1].photos.length, profile.photos.length);
console.log("route ok:", lines.length, "lines;", lines.filter((l) => l.type === "progress").length, "progress events");

// Повторный запрос к тому же QID и режиму должен прийти из кэша без нового обхода.
const cachedRes = await GET(new Request("http://localhost/api/profile?qid=Q1&mode=deep"));
const cachedLines = (await cachedRes.text()).trim().split("\n").map((l) => JSON.parse(l));
assert.equal(cachedLines.length, 2);
assert.equal(cachedLines[1].type, "profile");
assert.equal(cachedLines[1].photos.length, profile.photos.length);
assert.equal(typeof cachedLines[1].cacheAgeMs, "number");
console.log("profile cache ok");

// Без параметра режим — быстрый взгляд: он дешевле, и профиль обязан это сообщать.
const quickRes = await GET(new Request("http://localhost/api/profile?qid=Q1"));
const quickLines = quickRes.headers.get("content-type")?.startsWith("application/x-ndjson")
  ? (await quickRes.text()).trim().split("\n").map((line) => JSON.parse(line))
  : [];
const quickProfile = quickLines.at(-1);
assert.ok(quickProfile && quickProfile.type === "profile");
assert.equal(quickProfile.mode, "quick");
const streamedPhotos = quickLines.filter((line) => line.type === "progress" && line.stage === "photo");
assert.ok(streamedPhotos.length > 0, "быстрый борд должен передавать проверенные снимки до итогового профиля");
assert.ok(streamedPhotos.every((line) => line.photo?.evidence?.vision), "каждое фото в потоке прошло проверку содержимого");
assert.ok(quickProfile.photos.every((photo: { evidence: { vision: unknown } }) => photo.evidence.vision), "непроверенный снимок не должен попасть в быстрый профиль");
assert.ok(quickProfile.photos.every((photo: { category: string }) => ["campus", "lecture", "library", "sport", "canteen", "dorm", "outdoor"].includes(photo.category)));
assert.ok(
  quickProfile.photos.length < profile.photos.length,
  `быстрый взгляд должен быть короче полного: ${quickProfile.photos.length} против ${profile.photos.length}`,
);
// Небольшой потолок на категорию: это доска, а не галерея.
for (const c of quickProfile.coverage) {
  const total = c.verified + c.probable + c.unverified;
  assert.ok(total <= 2, `в быстром взгляде категория ${c.category}: ${total} снимков`);
}
// И он не должен уходить вглубь сайта: одна страница сверх главной.
const quickPages = quickProfile.warnings.find((w: string) => w.includes("прочитано страниц"));
assert.ok(!quickPages || /страниц — [12] /.test(quickPages), `быстрый взгляд читает слишком много: ${quickPages}`);
console.log("быстрый взгляд ok:", quickProfile.photos.length, "фото против", profile.photos.length);

const bad = await GET(new Request("http://localhost/api/profile?qid=abc"));
assert.equal(bad.status, 400);

console.log("\nALL PIPELINE CHECKS PASSED");
