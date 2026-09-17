// lib/official.ts
// Кандидаты в «официальные» фотографии: картинки, опубликованные на главной странице
// сайта вуза (домен из Wikidata, свойство P856). Здесь только сбор URL —
// загрузка, проверка размера и содержимого делаются в lib/profile.ts.
//
// Честная граница: мы утверждаем «опубликовано вузом на его сайте», а не «снято вузом».
// Один запрос к главной странице, с описательным User-Agent.

const REQUEST_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 3_000_000;
const MAX_CANDIDATES = 15;

export type OfficialCandidate = {
  url: string;
  pageUrl: string;
};

export type OfficialResult = {
  candidates: OfficialCandidate[];
  /** null — страница загружена; иначе причина, почему сбор не удался. */
  error: string | null;
};

const SKIP_EXT = /\.(svg|gif|ico|bmp|webp\?.*sprite|css|js)(\?|#|$)/i;

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
    const c = m[0].match(/content=["']([^"']+)["']/i);
    push(c?.[1]);
  }

  // <img src> и ленивые варианты.
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = tag.match(/\ssrc=["']([^"']+)["']/i)?.[1];
    const dataSrc = tag.match(/\sdata-(?:src|lazy-src|original)=["']([^"']+)["']/i)?.[1];
    const srcset = tag.match(/\s(?:data-)?srcset=["']([^"']+)["']/i)?.[1];
    push(dataSrc);
    push(src);
    if (srcset) push(srcset.split(",")[0]?.trim().split(/\s+/)[0]);
  }

  // Дедупликация с сохранением порядка: og:image идёт первым.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const u of found) {
    if (seen.has(u)) continue;
    seen.add(u);
    unique.push(u);
    if (unique.length >= MAX_CANDIDATES) break;
  }
  return unique;
}

export async function collectOfficialImages(
  officialWebsite: string,
  userAgent: string,
): Promise<OfficialResult> {
  let pageUrl: string;
  try {
    pageUrl = new URL(officialWebsite).toString();
  } catch {
    return { candidates: [], error: "некорректный адрес официального сайта" };
  }

  let html: string;
  try {
    const res = await fetch(pageUrl, {
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ru,kk,en",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return { candidates: [], error: `сайт ответил HTTP ${res.status}` };

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("html")) return { candidates: [], error: "главная страница не HTML" };

    const raw = await res.arrayBuffer();
    if (raw.byteLength > MAX_HTML_BYTES) return { candidates: [], error: "главная страница слишком большая" };
    html = Buffer.from(raw).toString("utf8");
    // Если после редиректов адрес сменился — относительные ссылки считаем от него.
    pageUrl = res.url || pageUrl;
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
    return { candidates: [], error: `сайт недоступен: ${reason}` };
  }

  const urls = extractImageUrls(html, pageUrl);
  if (urls.length === 0) {
    return { candidates: [], error: "на главной странице не найдено изображений (возможно, сайт рендерится скриптом)" };
  }

  return { candidates: urls.map((url) => ({ url, pageUrl })), error: null };
}
