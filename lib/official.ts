// lib/official.ts
// Кандидаты в «официальные» фотографии: изображения, опубликованные на сайте вуза
// (домен из Wikidata, свойство P856, либо websiteUri из Google Places).
//
// Обходим главную страницу и до MAX_INNER_PAGES внутренних. Именно там у вузов лежат
// снимки интерьеров и мероприятий, которых нет в Google Places: на главной обычно
// один-два баннера.
//
// Какие внутренние страницы открыть — решает ранг ссылки, а не порядок в вёрстке.
// Бюджет страниц маленький, и его легко потратить на «конференции студентов»: раздел
// совпадает со словом «студенческ», но фотографий кампуса не даёт. Поэтому явные
// галереи и виртуальные туры идут раньше разделов про студенческую жизнь.
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
/** Общий бюджет кандидатов. Держим прежним: больше загрузок — дольше сборка профиля. */
const MAX_CANDIDATES = 24;
/** Сколько внутренних страниц открываем сверх главной. */
const MAX_INNER_PAGES = 4;

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

const SKIP_EXT = /\.(svg|gif|ico|bmp|css|js|woff2?|ttf|eot|mp4|webm|pdf)(\?|#|$)/i;

/** Ранг ссылки: чем выше, тем раньше её очередь в обходе.
 *  Осторожно с короткими основами: «тур» совпадает с «абиТУРиент» и «архитекТУРа»,
 *  поэтому виртуальные туры ищем только полными словами. */
const LINK_TIERS: Array<{ score: number; re: RegExp }> = [
  // Прямые указания на фотографии: галереи, альбомы, фотоотчёты, панорамные туры.
  { score: 3, re: /галере|фотоальбом|фотоотч|фотохрон|альбом|gallery|photoalbum|photos?\b|album|виртуальн|virtual.?tour|3d.?tour|3d.?тур|панорам|panorama/i },
  // Разделы про сами объекты вуза: там фотографии чаще всего есть.
  { score: 2, re: /кампус|campus|студгородок|общежит|dormitor|hostel|библиотек|librar|лаборатор|laborator|инфраструктур|facilities/i },
  // Слабый признак: раздел может оказаться текстовым (новости конференций, объявления).
  { score: 1, re: /студенческ|студентам|жизнь|student.?life|медиа|media/i },
];

/** Разделы, где фотографий заведомо нет — не тратим на них запрос. */
const SKIP_LINK = /контакт|ваканс|приём|priem|admission|документ|закуп|тендер|новост|news|login|search|\.pdf|\.docx?|\.xlsx?/i;

function linkScore(haystack: string): number {
  for (const tier of LINK_TIERS) if (tier.re.test(haystack)) return tier.score;
  return 0;
}

function extractImageUrls(html: string, pageUrl: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string | undefined) => {
    if (!raw) return;
    const v = raw.trim();
    if (!v || v.startsWith("data:")) return;
    try {
      const abs = new URL(v, pageUrl);
      if (abs.protocol !== "http:" && abs.protocol !== "https:") return;
      if (SKIP_EXT.test(abs.pathname + abs.search)) return;
      const key = abs.toString();
      if (seen.has(key)) return;
      seen.add(key);
      found.push(key);
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

  // Фоновые изображения. На сайтах вузов ими выкладывают обложки разделов и плитки
  // галерей, и в <img> такие снимки не попадают вообще. Смотрим только в атрибуты
  // style, в блоки <style> и в data-атрибуты ленивой загрузки: url() из скриптов
  // слишком часто оказывается иконкой интерфейса.
  const styleChunks: string[] = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) styleChunks.push(m[1]);
  for (const m of html.matchAll(/\sstyle=["']([^"']*)["']/gi)) styleChunks.push(m[1]);
  for (const chunk of styleChunks) {
    for (const m of chunk.matchAll(/url\((['"]?)([^'")]+)\1\)/gi)) push(m[2]);
  }
  for (const m of html.matchAll(/\sdata-(?:bg|background|background-image|bg-src)=["']([^"']+)["']/gi)) {
    push(m[1]);
  }

  return found;
}

/** Внутренние ссылки того же домена, за которыми вероятны фотографии.
 *  Возвращаются в порядке убывания ранга; при равном ранге — в порядке появления. */
function extractGalleryLinks(html: string, pageUrl: string): string[] {
  const origin = new URL(pageUrl).origin;
  const out: Array<{ url: string; score: number }> = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    const href = m[1];
    const text = m[2].replace(/<[^>]*>/g, " ");
    const haystack = `${href} ${text}`;
    if (SKIP_LINK.test(haystack)) continue;
    const score = linkScore(haystack);
    if (score === 0) continue;
    try {
      const abs = new URL(href, pageUrl);
      if (abs.origin !== origin) continue;
      abs.hash = "";
      const key = abs.toString();
      if (key === pageUrl || seen.has(key)) continue;
      seen.add(key);
      out.push({ url: key, score });
    } catch {
      /* невалидная ссылка */
    }
  }

  // Array.prototype.sort стабилен: страницы одного ранга сохраняют порядок вёрстки.
  return out.sort((a, b) => b.score - a.score).map((l) => l.url);
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

  // Бюджет кандидатов делим между страницами по кругу. Иначе баннеры и иконки главной
  // занимают его целиком, и до галереи, ради которой обход и затевался, дело не доходит.
  const perPage = pages.map((page) =>
    extractImageUrls(page.html, page.url).map((url) => ({ url, pageUrl: page.url })),
  );
  const seen = new Set<string>();
  const candidates: OfficialCandidate[] = [];
  for (let i = 0; candidates.length < MAX_CANDIDATES; i++) {
    let anyLeft = false;
    for (const list of perPage) {
      const item = list[i];
      if (!item) continue;
      anyLeft = true;
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      candidates.push(item);
      if (candidates.length >= MAX_CANDIDATES) break;
    }
    if (!anyLeft) break;
  }

  const pagesVisited = pages.map((p) => p.url);
  if (candidates.length === 0) {
    return { candidates: [], pagesVisited, error: "на сайте не найдено изображений (возможно, страница рендерится скриптом)" };
  }
  return { candidates, pagesVisited, error: null };
}
