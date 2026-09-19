// Файлы Wikimedia Commons из категории, прямо указанной в карточке вуза Wikidata.
// Лицензия файла и принадлежность изображённого вузу — разные проверки.

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT = "shyngan/0.2 (https://github.com/kiddorri/shyngan)";
const TIMEOUT_MS = 6000;

type Meta = { value?: string };
type FileInfo = {
  url?: string;
  thumburl?: string;
  descriptionurl?: string;
  width?: number;
  height?: number;
  mime?: string;
  extmetadata?: Record<string, Meta>;
};

export type CommonsPhoto = {
  title: string;
  imageUrl: string;
  sourceUrl: string;
  categoryUrl: string;
  author: string;
  licenseName: string;
  licenseUrl: string;
  width: number;
  height: number;
};

async function apiJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function plainText(value: string | undefined): string {
  return (value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function secureUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value?.startsWith("//") ? `https:${value}` : value);
    if (url.protocol === "http:" && url.hostname === "creativecommons.org") url.protocol = "https:";
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

async function categoryFor(qid: string): Promise<string | null> {
  const url = new URL(WIKIDATA_API);
  url.search = new URLSearchParams({ action: "wbgetentities", ids: qid,
    props: "claims|sitelinks", format: "json" }).toString();
  const json = await apiJson(url.toString()) as { entities?: Record<string, {
    claims?: { P373?: Array<{ mainsnak?: { datavalue?: { value?: unknown } } }> };
    sitelinks?: { commonswiki?: { title?: string } };
  }> };
  const entity = json.entities?.[qid];
  const sitelink = entity?.sitelinks?.commonswiki?.title;
  if (sitelink?.startsWith("Category:")) return sitelink;
  const claim = entity?.claims?.P373?.[0]?.mainsnak?.datavalue?.value;
  return typeof claim === "string" && claim.trim() ? `Category:${claim.trim()}` : null;
}

async function members(category: string, kind: "file" | "subcat"): Promise<Array<{ title: string; ns: number }>> {
  const url = new URL(COMMONS_API);
  url.search = new URLSearchParams({ action: "query", list: "categorymembers",
    cmtitle: category, cmtype: kind, cmlimit: "150", format: "json",
    formatversion: "2" }).toString();
  const json = await apiJson(url.toString()) as {
    query?: { categorymembers?: Array<{ title: string; ns: number }> };
  };
  return json.query?.categorymembers ?? [];
}

function subcategoryScore(title: string): number {
  if (/alumni|faculty|president|history|logo|flag|school|personnel|staff|校友|校长|校長|교수|동문/i.test(title)) return -1;
  if (/librar|dorm|sport|student|life|图书馆|圖書館|宿舍|体育|體育|학생|기숙사|도서관|図書館/i.test(title)) return 3;
  if (/campus|building|facilit|gallery|校园|校園|建筑|建築|キャンパス|캠퍼스/i.test(title)) return 2;
  if (/event|activit|活动|活動|행사/i.test(title)) return 1;
  return -1;
}

function fileScore(title: string): number {
  if (/logo|flag|map|portrait|meeting|president|signature|poster|seal|emblem|校徽|地图|地圖|校长|校長|지도|로고/i.test(title)) return -3;
  if (/librar|dorm|sport|student|classroom|lecture|laborator|图书馆|圖書館|宿舍|体育|體育|学生|學生|도서관|기숙사|학생|図書館/i.test(title)) return 3;
  if (/campus|building|gate|street|garden|university|大学|大學|校园|校園|건물|캠퍼스|大学/i.test(title)) return 2;
  return 0;
}

async function fileInfo(titles: string[]): Promise<CommonsPhoto[]> {
  if (titles.length === 0) return [];
  const url = new URL(COMMONS_API);
  url.search = new URLSearchParams({ action: "query", prop: "imageinfo", titles: titles.join("|"),
    iiprop: "url|size|mime|extmetadata", iiurlwidth: "1200",
    iiextmetadatafilter: "LicenseShortName|LicenseUrl|Artist", format: "json",
    formatversion: "2" }).toString();
  const json = await apiJson(url.toString()) as {
    query?: { pages?: Array<{ title: string; imageinfo?: FileInfo[] }> };
  };
  const out: CommonsPhoto[] = [];
  for (const page of json.query?.pages ?? []) {
    const info = page.imageinfo?.[0];
    const meta = info?.extmetadata;
    const licenseName = plainText(meta?.LicenseShortName?.value);
    const licenseUrl = secureUrl(meta?.LicenseUrl?.value);
    // Не выдаём отсутствие машиночитаемой лицензии за разрешение на повторный показ.
    if (!/^(CC0|CC BY(?:-SA)?\s*\d|Public domain)/i.test(licenseName) || !licenseUrl) continue;
    const imageUrl = secureUrl(info?.thumburl ?? info?.url);
    const sourceUrl = secureUrl(info?.descriptionurl);
    if (!imageUrl || !sourceUrl || !info?.width || !info.height ||
      info.width < 500 || info.height < 300 || !info.mime?.startsWith("image/")) continue;
    out.push({ title: page.title, imageUrl, sourceUrl, categoryUrl: "", author:
      plainText(meta?.Artist?.value) || "Автор в описании файла", licenseName, licenseUrl,
      width: info.width, height: info.height });
  }
  return out;
}

/** Без QID или связанной категории ничего не подбираем по одному лишь имени. */
export async function findCommonsPhotos(qid: string, limit: number): Promise<CommonsPhoto[]> {
  if (!/^Q\d+$/.test(qid) || limit <= 0) return [];
  const category = await categoryFor(qid);
  if (!category) return [];
  const [direct, categoryChildren] = await Promise.all([
    members(category, "file"),
    limit > 3 ? members(category, "subcat") : Promise.resolve([]),
  ]);
  const directTitles = direct.filter((m) => m.ns === 6 && fileScore(m.title) >= 0)
    .sort((a, b) => fileScore(b.title) - fileScore(a.title)).map((m) => m.title);
  const subcategories = categoryChildren.filter((m) => m.ns === 14 && subcategoryScore(m.title) > 0)
    .sort((a, b) => subcategoryScore(b.title) - subcategoryScore(a.title)).slice(0, 2);
  const sublists = await Promise.all(subcategories.map(async (sub) =>
    (await members(sub.title, "file")).filter((m) => m.ns === 6 && fileScore(m.title) >= 0)
      .sort((a, b) => fileScore(b.title) - fileScore(a.title)).map((m) => m.title)));
  const lists = [directTitles, ...sublists];
  const titles: string[] = [];
  const seen = new Set<string>();
  const candidateLimit = Math.max(limit * 3, 6);
  for (let i = 0; titles.length < candidateLimit; i++) {
    let any = false;
    for (const list of lists) {
      const title = list[i];
      if (!title) continue;
      any = true;
      if (!seen.has(title)) { seen.add(title); titles.push(title); }
      if (titles.length >= candidateLimit) break;
    }
    if (!any) break;
  }
  const found = await fileInfo(titles);
  const categoryUrl = `https://commons.wikimedia.org/wiki/${encodeURIComponent(category.replaceAll(" ", "_"))}`;
  return found.slice(0, limit).map((file) => ({ ...file, categoryUrl }));
}
