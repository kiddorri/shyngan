// lib/official.ts
// Кандидаты в «официальные» фотографии: изображения, опубликованные на сайте вуза
// (домен из Wikidata, свойство P856, либо websiteUri из Google Places).
//
// Обходим главную страницу и до двух внутренних, чьи ссылки похожи на галерею,
// фотоальбом, виртуальный тур, раздел о студенческой жизни или кампусе. Именно там
// у вузов лежат снимки интерьеров и мероприятий, которых нет в Google Places:
// на главной обычно один-два баннера.
//
// Отбор по тексту ссылки — догадка, а не гарантия: страница может оказаться не той.
// Поэтому pagesVisited возвращает адреса, которые действительно были прочитаны,
// и профиль показывает их как есть, не выдавая догадку за факт.
//
// Здесь только сбор URL. Загрузка, отсев мелких изображений и проверка содержимого
// делаются в lib/profile.ts.
//
// Честная граница: мы утверждаем «опубликовано вузом на его сайте», а не «снято вузом».

const REQUEST_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 3_000_000;
const MAX_CANDIDATES = 24;
/** Сколько внутренних страниц открываем сверх главной. */
const MAX_INNER_PAGES = 2;

export type OfficialCandidate = {
  url: string;
  pageUrl: string;
};

export type OfficialResult = {
  candidates: OfficialCandidate[];
  /** Страницы, которые удалось прочитать: главная и внутренние. */
  pagesVisited: string[];
  /** null — сайт открылся; иначе причина, почему сбор не удался. */
  error: string | null;
};

const SKIP_EXT = /\.(svg|gif|ico|bmp|css|js)(\?|#|$)/i;

/** Ссылки, за которыми у вузов лежат фотографии.
 *  Осторожно с короткими основами: «тур» совпадает с «абиТУРиент» и «архитекТУРа»,
 *  поэтому виртуальные туры ищем только полными словами. */
const GALLERY_LINK = /галере|фотоальбом|фотогалере|фотоотч|альбом|кампус|студенческ|студентам|жизнь|виртуальн|3d.?тур|панорам|медиа|gallery|photos?|campus|student.?life|virtual.?tour|3d.?tour|panorama|media/i;
/** Разделы, где фотографий заведомо нет — не тратим на них запрос. */
const SKIP_LINK = /контакт|ваканс|приём|priem|admission|документ|закуп|тендер|новост|news|login|search|\.pdf|\.docx?|\.xlsx?/i;

function extractImageUrls(html: string, pageUrl: string): string[] {
  const found: string[] = [];

  const push = (raw: string | undefined) => {
    if (!raw) return;
    const v = raw.trim();
    if (!v || v.startsWith("data:")) return;
    try {
      const abs = new URL(v, pageUrl);
      if (abs.protocol !== "http:" && abs.protocol !== "https:") return;
      if (SKIP_EXT.test(abs.pathname + abs.search)) return;
      found.push(abs.toString());
    } catch {
      /* невалидный URL — пропускаем */
    }
  };

  // og:image / twitter:image — то, что сайт сам считает своим главным изображением.
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/gi)) {
    push(m[0].match(/content=["']([^"']+)["']/i)?.[1]);
  }

  // <img src> и ленивые варианты.
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    push(tag.match(/\sdata-(?:src|lazy-src|original|large_image)=["']([^"']+)["']/i)?.[1]);
    push(tag.match(/\ssrc=["']([^"']+)["']/i)?.[1]);
    const srcset = tag.match(/\s(?:data-)?srcset=["']([^"']+)["']/i)?.[1];
    if (srcset) push(srcset.split(",")[0]?.trim().split(/\s+/)[0]);
  }

  // Ссылки на полноразмерные снимки в галереях: <a href="...jpg">
  for (const m of html.matchAll(/<a\b[^>]+href=["']([^"']+\.(?:jpe?g|png|webp))["']/gi)) {
    push(m[1]);
  }

  return found;
}

/** Внутренние ссылки того же домена, за которыми вероятны фотографии. */
function extractGalleryLinks(html: string, pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin;
  const out: string[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    const href = m[1];
    const text = m[2].replace(/<[^>]*>/g, " ");
    const haystack = `${href} ${text}`;
    if (!GALLERY_LINK.test(haystack) || SKIP_LINK.test(haystack)) continue;
    try {
      const abs = new URL(href, pageUrl);
      if (abs.origin !== origin) continue;
      abs.hash = "";
      const key = abs.toString();
      if (key === pageUrl || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    } catch {
      /* невалидная ссылка */
    }
  }
  return out;
}

type FetchedPage = { url: string; html: string };

async function fetchPage(url: string, userAgent: string): Promise<FetchedPage | { error: string }> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ru,kk,en",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return { error: `сайт ответил HTTP ${res.status}` };
    if (!(res.headers.get("content-type") ?? "").includes("html")) return { error: "страница не HTML" };

    const raw = await res.arrayBuffer();
    if (raw.byteLength > MAX_HTML_BYTES) return { error: "страница слишком большая" };
    return { url: res.url || url, html: Buffer.from(raw).toString("utf8") };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const code = err.cause?.code;
    let reason: string;
    if (err.name === "TimeoutError") reason = "таймаут загрузки";
    else if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "CERT_HAS_EXPIRED" || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "SELF_SIGNED_CERT_IN_CHAIN") reason = `сертификат сайта не проходит проверку (${code})`;
    else if (code === "ENOTFOUND") reason = "домен не найден";
    else if (code === "ECONNREFUSED") reason = "соединение отклонено";
    else if (code === "ECONNRESET") reason = "соединение разорвано";
    else reason = code ?? err.message;
    return { error: `сайт недоступен: ${reason}` };
  }
}

export async function collectOfficialImages(
  officialWebsite: string,
  userAgent: string,
): Promise<OfficialResult> {
  let homeUrl: string;
  try {
    homeUrl = new URL(officialWebsite).toString();
  } catch {
    return { candidates: [], pagesVisited: [], error: "некорректный адрес официального сайта" };
  }

  const home = await fetchPage(homeUrl, userAgent);
  if ("error" in home) return { candidates: [], pagesVisited: [], error: home.error };

  const pages: FetchedPage[] = [home];

  // Внутренние страницы с галереями — параллельно, ошибки отдельных страниц не важны.
  const links = extractGalleryLinks(home.html, home.url).slice(0, MAX_INNER_PAGES);
  if (links.length > 0) {
    const inner = await Promise.all(links.map((l) => fetchPage(l, userAgent)));
    for (const page of inner) if (!("error" in page)) pages.push(page);
  }

  // Дедупликация с сохранением порядка: сначала главная, затем галереи.
  const seen = new Set<string>();
  const candidates: OfficialCandidate[] = [];
  for (const page of pages) {
    for (const url of extractImageUrls(page.html, page.url)) {
      if (seen.has(url)) continue;
      seen.add(url);
      candidates.push({ url, pageUrl: page.url });
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  const pagesVisited = pages.map((p) => p.url);
  if (candidates.length === 0) {
    return { candidates: [], pagesVisited, error: "на сайте не найдено изображений (возможно, страница рендерится скриптом)" };
  }
  return { candidates, pagesVisited, error: null };
}
