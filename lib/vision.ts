// lib/vision.ts
// Проверка содержимого снимков через Gemini API (generateContent, structured output).
// Один вызов = батч до 4 изображений с одной повторной попыткой. Строгий JSON по схеме.
//
// Честная граница: модель определяет, ЧТО изображено (здание вуза, общежитие, город,
// логотип, документ…) и какая это категория. Она НЕ может подтвердить, что это именно
// данный университет — это делает географический слой (lib/profile.ts).

import type { Category, VisionVerdict } from "./types";

const GEMINI_MODEL = "gemini-3.8-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
/** Экспортируется, чтобы прогресс показывал настоящее число запросов к модели. */
export const BATCH_SIZE = 4;
/** Сколько батчей отправляем одновременно. Пять укладывается в лимиты платного тира. */
const CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 30000;

const CATEGORY_ENUM = ["campus", "lecture", "dorm", "library", "lab", "sport", "canteen", "outdoor", "life", "city", "other"] as const;
const CONFIDENCE_ENUM = ["high", "medium", "low"] as const;

function apiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  return key;
}

export type VisionInput = {
  id: string;
  bytes: Buffer;
  mime: "image/jpeg";
};

export type VisionContext = {
  universityName: string;
  city: string | null;
};

function buildPrompt(ctx: VisionContext, count: number): string {
  return [
    `You are checking candidate photos for a visual profile of a university.`,
    `University: ${ctx.universityName}. City: ${ctx.city ?? "unknown"}.`,
    `You will receive ${count} images, numbered 1..${count} in order.`,
    ``,
    `For EACH image return one entry with:`,
    `- index: the image number (1-based, in the order given).`,
    `- relevant: true if the image plausibly shows a university facility (building, campus grounds, dormitory, library, laboratory, sports facility, lecture hall, canteen), campus student life (events, students on campus), or the public surroundings near a campus (park, square, cafe, street). false for logos, documents, screenshots, text-only graphics, food close-ups, selfies without campus context, unrelated interiors, promotional collages, maps.`,
    `- category: exactly one of campus, lecture, dorm, library, lab, sport, canteen, outdoor, life, city, other. Use "canteen" for a campus cafeteria or dining hall, not for food close-ups. Use "outdoor" for university grounds, paths, green areas and courtyards; "city" for public parks or streets outside the campus. Use "lecture" for classrooms and auditoriums. Use "other" when relevant is false.`,
    `- caption: up to 8 words in Russian, a factual description of what is visible. No guesses about which university it is.`,
    `- confidence: high, medium or low — how sure you are about relevant and category.`,
    `- wideView: true if the frame is a wide view — a city skyline, a panorama, a long street or square perspective, a group of buildings seen from a distance, a campus seen as a whole. false if it is a close-up — one object filling the frame, an interior, a sign, a statue, food, a person, a detail of a facade.`,
    ``,
    `Do not assume an image belongs to this university just because you were told the name. Judge only what is visible.`,
  ].join("\n");
}

const RESPONSE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      index: { type: "INTEGER" },
      relevant: { type: "BOOLEAN" },
      category: { type: "STRING", enum: [...CATEGORY_ENUM] },
      caption: { type: "STRING" },
      confidence: { type: "STRING", enum: [...CONFIDENCE_ENUM] },
      wideView: { type: "BOOLEAN" },
    },
    required: ["index", "relevant", "category", "caption", "confidence", "wideView"],
  },
};

type RawVerdict = {
  index: number;
  relevant: boolean;
  category: string;
  caption: string;
  confidence: string;
  wideView?: boolean;
};

function isCategory(s: string): s is Category | "other" {
  return (CATEGORY_ENUM as readonly string[]).includes(s);
}

function isConfidence(s: string): s is VisionVerdict["confidence"] {
  return (CONFIDENCE_ENUM as readonly string[]).includes(s);
}

async function classifyBatch(batch: VisionInput[], ctx: VisionContext, signal?: AbortSignal): Promise<Map<string, VisionVerdict>> {
  const parts: Array<Record<string, unknown>> = [{ text: buildPrompt(ctx, batch.length) }];
  batch.forEach((img, i) => {
    parts.push({ text: `Image ${i + 1}:` });
    parts.push({ inline_data: { mime_type: img.mime, data: img.bytes.toString("base64") } });
  });

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0,
      response_mime_type: "application/json",
      response_schema: RESPONSE_SCHEMA,
    },
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey(),
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini: empty response");

  const raw = JSON.parse(text) as RawVerdict[];
  if (!Array.isArray(raw)) throw new Error("Gemini: response is not an array");

  const out = new Map<string, VisionVerdict>();
  for (const r of raw) {
    const img = batch[r.index - 1];
    if (!img) continue;
    if (!isCategory(r.category) || !isConfidence(r.confidence)) continue;
    out.set(img.id, {
      relevant: Boolean(r.relevant),
      category: r.category,
      caption: String(r.caption ?? "").slice(0, 120),
      confidence: r.confidence,
      wideView: Boolean(r.wideView),
    });
  }
  return out;
}

/**
 * Классифицирует все снимки батчами. Возвращает Map id → вердикт.
 * Снимки, для которых батч упал, в Map отсутствуют — вызывающий код трактует это как «vision недоступен».
 * Ошибки батчей собираются в errors, а не роняют весь профиль.
 */
export async function classifyImages(
  inputs: VisionInput[],
  ctx: VisionContext,
  options: { concurrency?: number; retry?: boolean; signal?: AbortSignal } = {},
): Promise<{ verdicts: Map<string, VisionVerdict>; errors: string[] }> {
  const verdicts = new Map<string, VisionVerdict>();
  const errors: string[] = [];
  if (inputs.length === 0) return { verdicts, errors };

  const batches: VisionInput[][] = [];
  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    batches.push(inputs.slice(i, i + BATCH_SIZE));
  }

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < batches.length && !options.signal?.aborted) {
      const batch = batches[cursor++];
      // Одна повторная попытка: таймаут или 429 на одном батче не должны
      // оставлять снимки без вердикта — иначе они молча теряют категорию.
      let lastError: unknown = null;
      for (let attempt = 0; attempt < (options.retry === false ? 1 : 2); attempt++) {
        try {
          const partial = await classifyBatch(batch, ctx, options.signal);
          partial.forEach((v, k) => verdicts.set(k, v));
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          if (attempt === 0 && options.retry !== false) await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (lastError) errors.push((lastError as Error).message);
    }
  }

  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? CONCURRENCY, batches.length) }, worker));
  return { verdicts, errors };
}
