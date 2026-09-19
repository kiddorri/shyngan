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

/** Таймауты разные по назначению. Главная страница — единственная обязательная, ей
 *  времени не жалко. Внутренние — приятное дополнение, и ждать каждую по восемь
 *  секунд нельзя: их до семи, и в сумме это больше всего бюджета профиля. */
const HOME_TIMEOUT_MS = 8000;
const INNER_TIMEOUT_MS = 5000;
const ROBOTS_TIMEOUT_MS = 4000;
/** Общий потолок на чтение внутренних страниц. Дальше обход прекращается, сколько бы
 *  страниц ни осталось: 30-секундный бюджет профиля важнее полноты обхода, а
 *  непрочитанное честно попадает в оговорки. */
const INNER_PAGES_BUDGET_MS = 9000;
const MAX_HTML_BYTES = 3_000_000;
/** Общий бюджет кандидатов. Больше загрузок — дольше сборка профиля. */
const MAX_CANDIDATES = 32;
/** Сколько внутренних страниц открываем сверх главной. Верхняя граница мягкая:
 *  реальный ограничитель — потолок времени, а не это число. */
const MAX_INNER_PAGES = 9;
/** Сколько из них отдаём общим галереям; остальное — под разделы по категориям. */
const MAX_GENERAL_PAGES = 3;
/** Страниц новостей и событий: у них есть дата публикации, которой больше взять негде. */
const MAX_NEWS_PAGES = 3;
/** Быстрый взгляд читает главную и до трёх тематических страниц. Они загружаются
 *  одной параллельной пачкой, поэтому это даёт библиотеку, спорт и общежитие без
 *  трёх последовательных ожиданий. */
const MAX_QUICK_INNER_PAGES = 3;
/** Сколько страниц сайта запрашиваем одновременно: у вузовских серверов бывает
 *  немного ресурсов, и восемь одновременных запросов — заметная для них нагрузка.
 *  Три — компромисс между вежливостью и числом последовательных кругов ожидания. */
const PAGE_CONCURRENCY = 3;
/** Сколько времени готовы потратить на паузы, если сайт задал Crawl-delay.
 *  Дальше этого лимита внутренние страницы просто не читаются: 30-секундный бюджет
 *  профиля важнее, а пауза, которую попросил сайт, не обсуждается. */
const CRAWL_DELAY_BUDGET_MS = 6000;
const MAX_ROBOTS_BYTES = 200_000;

export type OfficialCandidate = {
  url: string;
  pageUrl: string;
  /** Дата публикации СТРАНИЦЫ, на которой лежит снимок, если страница её сообщает.
   *  Это единственный источник настоящей даты во всём проекте: ни Google Places, ни
   *  главные страницы сайтов дат не отдают. Про сам кадр она говорит только одно —
   *  он опубликован не позже этой даты; когда он снят, страница не сообщает. */
  publishedAt: string | null;
};

export type OfficialResult = {
  candidates: OfficialCandidate[];
  /** Страницы, которые удалось прочитать: главная и внутренние. */
  pagesVisited: string[];
  /** Адреса, которые не читались, потому что их закрывает robots.txt сайта. */
  blockedByRobots: string[];
  /** Что известно про robots.txt сайта: прочитан, отсутствует, недоступен. */
  robotsNote: string | null;
  /** Сколько разделов не прочитано из-за потолка времени на обход. */
  skippedForTime: number;
  /** null — сайт открылся; иначе причина, почему сбор не удался. */
  error: string | null;
};

/** Правила из robots.txt для нашего агента. */
type RobotsRules = {
  allow: string[];
  disallow: string[];
  /** Crawl-delay в миллисекундах, если сайт его указал. */
  crawlDelayMs: number | null;
  /** Как получены правила — от этого зависит текст оговорки. */
  source: "file" | "missing" | "unreadable";
};

const SKIP_EXT = /\.(svg|gif|ico|bmp|css|js|woff2?|ttf|eot|mp4|webm|pdf)(\?|#|$)/i;

/** Ранг ссылки: чем выше, тем раньше её очередь в обходе.
 *  Осторожно с короткими основами: «тур» совпадает с «абиТУРиент» и «архитекТУРа»,
 *  поэтому виртуальные туры ищем только полными словами. */
const LINK_TIERS: Array<{ score: number; re: RegExp }> = [
  // Прямые указания на фотографии: галереи, альбомы, фотоотчёты, панорамные туры.
  { score: 3, re: /галере|фотоальбом|фотоотч|фотохрон|альбом|gallery|photoalbum|photos?\b|album|виртуальн|virtual.?tour|3d.?tour|3d.?тур|панорам|panorama|фотосурет|суреттер|照片|相册|相冊|图集|圖集|写真|フォト|갤러리|사진|포토/i },
  // Разделы про сами объекты вуза: там фотографии чаще всего есть.
  { score: 2, re: /кампус|campus|студгородок|общежит|dormitor|hostel|библиотек|librar|лаборатор|laborator|инфраструктур|facilities|кітапхана|жатақхана|зертхана|асхана|спорт|校园|校園|宿舍|图书馆|圖書館|实验室|實驗室|食堂|体育|體育|캠퍼스|기숙사|도서관|연구실|체육|キャンパス|学生寮|図書館|研究室/i },
  // Слабый признак: раздел может оказаться текстовым (новости конференций, объявления).
  { score: 1, re: /студенческ|студентам|жизнь|student.?life|student.?activit|медиа|media|学生生活|學生生活|学生活动|學生活動|학생생활|학생활동/i },
];

/** Разделы, где фотографий заведомо нет — не тратим на них запрос. */
const SKIP_LINK = /контакт|ваканс|приём|priem|admission|документ|закуп|тендер|login|search|\.pdf|\.docx?|\.xlsx?/i;

/** Страницы событий и новостей. Раньше они отбрасывались как «текст без фотографий»,
 *  и это стоило нам дат: у новости дата публикации есть в разметке, а у галереи её
 *  нет никогда. Плюс новость показывает вуз сегодняшний, а не десятилетней давности. */
const NEWS_LINK = /новост|жаңалық|news|событи|іс-шара|мероприят|events?\b|新闻|新聞|活动|活動|ニュース|イベント|소식|뉴스|행사/i;
/** Адрес с годом — почти всегда отдельная новость, а не её список. */
const DATED_URL = /\/20\d\d[/-]/;

/** Разделы под конкретные категории профиля. Общая галерея у вуза одна и часто
 *  состоит из фасадов; снимки библиотеки, спортзала и столовой лежат в своих
 *  разделах, и без отдельного запроса до них дело не доходит.
 *
 *  Это выбор СТРАНИЦЫ, а не категории снимка: что изображено на найденных
 *  фотографиях, по-прежнему решает модель, а не текст ссылки. Раздел «Библиотека»
 *  вполне может оказаться списком электронных баз без единой фотографии. */
const CATEGORY_LINKS: Array<{ key: string; re: RegExp }> = [
  { key: "library", re: /библиотек|кітапхана|kitapkhana|librar|图书馆|圖書館|도서관|図書館/i },
  { key: "sport", re: /спорт|спорткомплекс|бассейн|стадион|sport|gym|stadium|体育|體育|체육|スポーツ/i },
  { key: "dorm", re: /общежит|жатақхана|zhatakhana|dormitor|hostel|residen|housing|living.?on.?campus|宿舍|기숙사|学生寮/i },
  { key: "lab", re: /лаборатор|laborator|实验室|實驗室|연구실|研究室/i },
  { key: "canteen", re: /столов|асхана|ashana|буфет|canteen|cafeteria|dining|食堂|학생식당/i },
  { key: "lecture", re: /аудитори|учебн.{0,3}корпус|лекцион|classroom|lecture.?hall|教室|강의실/i },
];

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

type SiteLink = { url: string; haystack: string };

/** Разрешаем только поддомены того же вуза, когда граница вуза ясна из
 * образовательного домена. Для остальных доменов остаёмся на исходном хосте. */
export function institutionHostRoot(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const parts = host.split(".");
  const twoLevel = ["edu.cn", "ac.kr", "ac.jp", "edu.kz", "edu.au", "ac.uk"];
  for (const suffix of twoLevel) {
    if (host.endsWith(`.${suffix}`) && parts.length >= 3) return parts.slice(-3).join(".");
  }
  if (host.endsWith(".edu") && parts.length >= 2) return parts.slice(-2).join(".");
  return null;
}

export function isInstitutionHost(hostname: string, officialHost: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  const official = officialHost.toLowerCase().replace(/^www\./, "");
  if (host === official) return true;
  const root = institutionHostRoot(official);
  return Boolean(root && (host === root || host.endsWith(`.${root}`)));
}

/** Все внутренние ссылки страницы одним проходом: адрес плюс текст ссылки,
 *  по которому дальше решается, за чем эта ссылка ведёт. */
function extractLinks(html: string, pageUrl: string): SiteLink[] {
  const pageHost = new URL(pageUrl).hostname;
  const out: SiteLink[] = [];
  const seen = new Set<string>();

  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)) {
    const href = m[1];
    const text = m[2].replace(/<[^>]*>/g, " ");
    const haystack = `${href} ${text}`;
    if (SKIP_LINK.test(haystack)) continue;
    try {
      const abs = new URL(href, pageUrl);
      if (!(["http:", "https:"].includes(abs.protocol) && isInstitutionHost(abs.hostname, pageHost))) continue;
      abs.hash = "";
      const key = abs.toString();
      if (key === pageUrl || seen.has(key)) continue;
      seen.add(key);
      out.push({ url: key, haystack });
    } catch {
      /* невалидная ссылка */
    }
  }
  return out;
}

/**
 * Какие внутренние страницы открыть. Бюджет делится на две части.
 *
 * Сначала общие галереи — по убыванию ранга ссылки: там лежит основная масса
 * снимков. Затем по одной странице на категорию: библиотека, спорт, общежитие,
 * лаборатории, столовая, аудитории. Без второй части обход упирался в фасады —
 * общая галерея вуза почти всегда состоит из видов главного корпуса.
 *
 * Порядок внутри категорий — порядок списка CATEGORY_LINKS, а не вёрстки:
 * при нехватке бюджета отбрасываются последние, а не случайные.
 */
function selectInnerLinks(html: string, pageUrl: string, deep: boolean): string[] {
  const links = extractLinks(html, pageUrl);

  const general = links
    .map((l) => ({ url: l.url, score: linkScore(l.haystack) }))
    .filter((l) => l.score > 0)
    // Array.prototype.sort стабилен: страницы одного ранга сохраняют порядок вёрстки.
    .sort((a, b) => b.score - a.score)
    .map((l) => l.url);

  const picked: string[] = [];
  const seen = new Set<string>();
  const take = (url: string) => {
    if (seen.has(url) || picked.length >= MAX_INNER_PAGES) return;
    seen.add(url);
    picked.push(url);
  };

  if (!deep) {
    // Сначала страницы конкретных объектов. Общий раздел «Campus services» часто
    // стоит раньше библиотеки и общежития, но почти не даёт полезных кадров.
    for (const { re } of CATEGORY_LINKS) {
      const hit = links.find((l) => re.test(l.haystack) && !seen.has(l.url));
      if (hit) take(hit.url);
    }
    // Если тематических разделов мало, добираем галереями и campus life.
    for (const url of general) take(url);
    return picked.slice(0, MAX_QUICK_INNER_PAGES);
  }

  for (const url of general.slice(0, MAX_GENERAL_PAGES)) take(url);
  for (const { re } of CATEGORY_LINKS) {
    const hit = links.find((l) => re.test(l.haystack) && !seen.has(l.url));
    if (hit) take(hit.url);
  }
  // Свежие материалы: сначала отдельные новости (в адресе есть год), потом разделы
  // новостей и событий. Ради даты публикации и ради сегодняшнего вида кампуса.
  const news = links.filter((l) => NEWS_LINK.test(l.haystack) || DATED_URL.test(l.url));
  for (const l of news.filter((x) => DATED_URL.test(x.url)).slice(0, MAX_NEWS_PAGES)) take(l.url);
  for (const l of news.slice(0, MAX_NEWS_PAGES)) take(l.url);
  // Остаток бюджета — обратно общим галереям, если категорийных разделов на сайте нет.
  for (const url of general) take(url);

  return picked;
}

// ---- robots.txt ----
//
// Файл в корне сайта, которым владелец сообщает автоматическим программам, какие
// разделы читать не нужно. Юридической силы у него нет, но это общепринятая
// договорённость, и сервис, который построен на добросовестности, обязан её
// соблюдать. Пропущенные из-за него адреса показываются в оговорках профиля:
// «не нашли» и «не смотрели, потому что попросили не смотреть» — разные ответы.

/** Токен нашего агента из User-Agent: «shyngan/0.2 (…)» → «shyngan». */
function agentToken(userAgent: string): string {
  return (userAgent.split("/")[0] ?? userAgent).trim().toLowerCase();
}

/**
 * Разбор robots.txt. Берём группу для нашего агента, если она есть, иначе группу
 * «User-agent: *». Остальные группы адресованы не нам.
 */
function parseRobots(text: string, token: string): Omit<RobotsRules, "source"> {
  const groups = new Map<string, { allow: string[]; disallow: string[]; crawlDelayMs: number | null }>();
  let current: string[] = [];
  let sawRuleInGroup = false;

  const groupFor = (agent: string) => {
    let g = groups.get(agent);
    if (!g) {
      g = { allow: [], disallow: [], crawlDelayMs: null };
      groups.set(agent, g);
    }
    return g;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      // Подряд идущие User-agent относятся к одной группе правил.
      if (sawRuleInGroup) {
        current = [];
        sawRuleInGroup = false;
      }
      current.push(value.toLowerCase());
      groupFor(value.toLowerCase());
      continue;
    }
    if (current.length === 0) continue;

    if (field === "disallow" || field === "allow") {
      sawRuleInGroup = true;
      for (const agent of current) {
        // Пустой Disallow означает «ничего не запрещено» — не правило, а его отсутствие.
        if (value === "") continue;
        groupFor(agent)[field === "allow" ? "allow" : "disallow"].push(value);
      }
    } else if (field === "crawl-delay") {
      sawRuleInGroup = true;
      const seconds = Number.parseFloat(value.replace(",", "."));
      if (Number.isFinite(seconds) && seconds > 0) {
        for (const agent of current) groupFor(agent).crawlDelayMs = Math.round(seconds * 1000);
      }
    }
  }

  const mine = groups.get(token) ?? groups.get("*");
  return mine ?? { allow: [], disallow: [], crawlDelayMs: null };
}

async function fetchRobots(origin: string, userAgent: string): Promise<RobotsRules> {
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": userAgent, Accept: "text/plain" },
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
      redirect: "follow",
    });
    // 404 и прочие 4xx означают «правил нет» — это штатный ответ, а не сбой.
    if (res.status >= 400 && res.status < 500) {
      return { allow: [], disallow: [], crawlDelayMs: null, source: "missing" };
    }
    if (!res.ok) return { allow: [], disallow: [], crawlDelayMs: null, source: "unreadable" };
    const text = (await res.text()).slice(0, MAX_ROBOTS_BYTES);
    return { ...parseRobots(text, agentToken(userAgent)), source: "file" };
  } catch {
    return { allow: [], disallow: [], crawlDelayMs: null, source: "unreadable" };
  }
}

/** Шаблон пути из robots.txt в регулярное выражение: поддерживаются * и завершающий $. */
function robotsPatternToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") out += ".*";
    else if (ch === "$" && i === pattern.length - 1) out += "$";
    else out += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + out);
}

function matchLength(pattern: string, path: string): number {
  return robotsPatternToRegExp(pattern).test(path) ? pattern.replace(/[*$]/g, "").length : -1;
}

/**
 * Разрешает ли robots.txt читать этот адрес. Правило с более длинным совпадением
 * побеждает; при равной длине выигрывает Allow — так это работает у поисковиков.
 */
function isAllowedByRobots(rules: RobotsRules, url: string): boolean {
  if (rules.disallow.length === 0) return true;
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname + u.search;
  } catch {
    return true;
  }
  let bestAllow = -1;
  let bestDisallow = -1;
  for (const p of rules.allow) bestAllow = Math.max(bestAllow, matchLength(p, path));
  for (const p of rules.disallow) bestDisallow = Math.max(bestDisallow, matchLength(p, path));
  if (bestDisallow < 0) return true;
  return bestAllow >= bestDisallow;
}

type FetchedPage = { url: string; html: string };

async function fetchPage(
  url: string,
  userAgent: string,
  timeoutMs: number,
  canFetch: (url: string) => Promise<boolean>,
): Promise<FetchedPage | { error: string }> {
  try {
    let current = url;
    for (let hop = 0; hop < 4; hop++) {
      if (!await canFetch(current)) return { error: "адрес закрыт robots.txt или не принадлежит вузу" };
      const res = await fetch(current, {
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "ru,kk,en,zh,ko,ja",
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location) return { error: "перенаправление без адреса" };
        current = new URL(location, current).toString();
        continue;
      }
      if (!res.ok) return { error: `сайт ответил HTTP ${res.status}` };
      if (!(res.headers.get("content-type") ?? "").includes("html")) return { error: "страница не HTML" };

      const raw = await res.arrayBuffer();
      if (raw.byteLength > MAX_HTML_BYTES) return { error: "страница слишком большая" };
      return { url: current, html: Buffer.from(raw).toString("utf8") };
    }
    return { error: "слишком много перенаправлений" };
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

/**
 * Дата публикации страницы. Три источника по убыванию надёжности: разметка статьи,
 * элемент <time datetime>, год и месяц в адресе. Всё это опубликованные данные, а не
 * догадка: если ничего нет — null, и профиль честно пишет «дата неизвестна».
 */
export function pageDate(html: string, pageUrl: string): string | null {
  const meta = html.match(/<meta[^>]+property=["'](?:article:published_time|article:modified_time)["'][^>]*content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']article:published_time["']/i);
  const iso = meta?.[1] ?? html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1];
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime()) && d.getFullYear() > 1990) return d.toISOString();
  }
  // Адреса вида /news/2026/03/12/ или /2026-03-12-den-otkrytyh-dverej
  const fromUrl = pageUrl.match(/(?:^|[/\-])(20\d\d)[/\-](\d{1,2})(?:[/\-](\d{1,2}))?(?:[/\-]|$)/);
  if (fromUrl) {
    const [, y, m, day] = fromUrl;
    const d = new Date(Date.UTC(Number(y), Number(m) - 1, Number(day ?? 1)));
    if (!Number.isNaN(d.getTime()) && d.getUTCFullYear() >= 2000 && Number(m) >= 1 && Number(m) <= 12) {
      return d.toISOString();
    }
  }
  return null;
}

export async function collectOfficialImages(
  officialWebsite: string,
  userAgent: string,
  opts: { deep: boolean; maxCandidates?: number } = { deep: true },
): Promise<OfficialResult> {
  let homeUrl: string;
  let origin: string;
  try {
    const parsed = new URL(officialWebsite);
    homeUrl = parsed.toString();
    origin = parsed.origin;
  } catch {
    return { candidates: [], pagesVisited: [], blockedByRobots: [], robotsNote: null, skippedForTime: 0, error: "некорректный адрес официального сайта" };
  }

  // robots.txt читаем ДО первой страницы: спрашивать разрешение после того, как уже
  // зашёл, смысла не имеет.
  const robots = await fetchRobots(origin, userAgent);
  const officialHost = new URL(homeUrl).hostname;
  const robotsByOrigin = new Map<string, Promise<RobotsRules>>([[origin, Promise.resolve(robots)]]);
  const rulesFor = (url: string): Promise<RobotsRules> => {
    const targetOrigin = new URL(url).origin;
    let pending = robotsByOrigin.get(targetOrigin);
    if (!pending) {
      pending = fetchRobots(targetOrigin, userAgent);
      robotsByOrigin.set(targetOrigin, pending);
    }
    return pending;
  };
  const canFetch = async (url: string): Promise<boolean> => {
    const target = new URL(url);
    if (!(["http:", "https:"].includes(target.protocol) &&
      isInstitutionHost(target.hostname, officialHost))) return false;
    const rules = await rulesFor(url);
    return isAllowedByRobots(rules, url);
  };
  const robotsNote =
    robots.source === "missing"
      ? "robots.txt на сайте нет — ограничений для обхода не заявлено"
      : robots.source === "unreadable"
        ? "robots.txt прочитать не удалось; обход выполнен по общим правилам вежливости"
        : robots.disallow.length > 0
          ? `robots.txt прочитан: ${robots.disallow.length} запрещённых раздел(ов)${robots.crawlDelayMs ? `, Crawl-delay ${robots.crawlDelayMs / 1000} с` : ""}`
          : "robots.txt прочитан: запретов для нашего агента нет";
  const blockedByRobots: string[] = [];

  if (!isAllowedByRobots(robots, homeUrl)) {
    return {
      candidates: [],
      pagesVisited: [],
      blockedByRobots: [homeUrl],
      robotsNote,
      skippedForTime: 0,
      error: "robots.txt сайта запрещает автоматическое чтение главной страницы — обход не выполнялся",
    };
  }

  const home = await fetchPage(homeUrl, userAgent, HOME_TIMEOUT_MS, canFetch);
  if ("error" in home) return { candidates: [], pagesVisited: [], blockedByRobots, robotsNote, skippedForTime: 0, error: home.error };

  const pages: FetchedPage[] = [home];

  // Внутренние страницы: сначала отбрасываем закрытые в robots.txt, затем читаем
  // небольшими группами, а если сайт просил паузу — по одной с этой паузой.
  const selected = selectInnerLinks(home.html, home.url, opts.deep);
  const links: string[] = [];
  for (const l of selected) {
    if (await canFetch(l)) links.push(l);
    else blockedByRobots.push(l);
  }

  const delay = Math.max(0, ...await Promise.all(links.map(async (l) => (await rulesFor(l)).crawlDelayMs ?? 0)));
  const allowedByBudget = delay > 0 ? Math.max(0, Math.floor(CRAWL_DELAY_BUDGET_MS / delay)) : links.length;
  const toVisit = links.slice(0, allowedByBudget);
  const batchSize = delay > 0 ? 1 : PAGE_CONCURRENCY;

  // Часы включаются здесь: медленный сайт не должен утащить за собой весь профиль.
  const startedAt = Date.now();
  let skippedForTime = 0;
  for (let i = 0; i < toVisit.length; i += batchSize) {
    if (Date.now() - startedAt > INNER_PAGES_BUDGET_MS) {
      skippedForTime = toVisit.length - i;
      break;
    }
    if (delay > 0 && i > 0) await new Promise((r) => setTimeout(r, delay));
    const batch = await Promise.all(toVisit.slice(i, i + batchSize).map((l) => fetchPage(l, userAgent, INNER_TIMEOUT_MS, canFetch)));
    for (const page of batch) if (!("error" in page)) pages.push(page);
  }

  // Бюджет кандидатов делим между страницами по кругу. Иначе баннеры и иконки главной
  // занимают его целиком, и до галереи, ради которой обход и затевался, дело не доходит.
  // Правила robots.txt распространяются и на сами файлы картинок этого домена.
  // Картинки со сторонних хостов (CDN) ими не управляются: у того домена свой файл.
  const perPage = await Promise.all(pages.map(async (page) => {
    const published = pageDate(page.html, page.url);
    const pageRules = await rulesFor(page.url);
    return extractImageUrls(page.html, page.url)
      .filter((url) => new URL(url).origin !== new URL(page.url).origin || isAllowedByRobots(pageRules, url))
      .map((url) => ({ url, pageUrl: page.url, publishedAt: published }));
  }));
  const seen = new Set<string>();
  const candidates: OfficialCandidate[] = [];
  // Кандидатов набираем ровно столько, сколько профиль способен использовать: каждый
  // лишний — это скачанный и выброшенный файл, то есть потраченные секунды.
  const budget = Math.max(1, opts.maxCandidates ?? MAX_CANDIDATES);
  for (let i = 0; candidates.length < budget; i++) {
    let anyLeft = false;
    for (const list of perPage) {
      const item = list[i];
      if (!item) continue;
      anyLeft = true;
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      candidates.push(item);
      if (candidates.length >= budget) break;
    }
    if (!anyLeft) break;
  }

  const pagesVisited = pages.map((p) => p.url);
  if (candidates.length === 0) {
    return {
      candidates: [],
      pagesVisited,
      blockedByRobots,
      robotsNote,
      skippedForTime,
      error: "на сайте не найдено изображений (возможно, страница рендерится скриптом)",
    };
  }
  return { candidates, pagesVisited, blockedByRobots, robotsNote, skippedForTime, error: null };
}
