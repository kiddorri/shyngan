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
const BATCH_SIZE = 4;
/** Сколько батчей отправляем одновременно. Держим низко, чтобы не упереться в RPM. */
const CONCURRENCY = 3;
const REQUEST_TIMEOUT_MS = 30000;

const CATEGORY_ENUM = ["campus", "dorm", "library", "lab", "sport", "life", "city", "other"] as const;
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
    `- relevant: true if the image plausibly shows a university facility (building, campus grounds, dormitory, library, laboratory, sports facility, lecture hall), campus student life (events, students on campus), or the public surroundings near a campus (park, square, cafe, street). false for logos, documents, screenshots, text-only graphics, food close-ups, selfies without campus context, unrelated interiors, promotional collages, maps.`,
    `- category: exactly one of campus, dorm, library, lab, sport, life, city, other. Use "city" for the public surroundings a student would walk in — parks, squares, cafes, streets near campus — that are not university facilities themselves. Use "other" when relevant is false.`,
    `- caption: up to 8 words in Russian, a factual description of what is visible. No guesses about which university it is.`,
    `- confidence: high, medium or low — how sure you are about relevant and category.`,
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
    },
    required: ["index", "relevant", "category", "caption", "confidence"],
  },
};

type RawVerdict = {
  index: number;
  relevant: boolean;
  category: string;
  caption: string;
  confidence: string;
};

function isCategory(s: string): s is Category | "other" {
  return (CATEGORY_ENUM as readonly string[]).includes(s);
}

function isConfidence(s: string): s is VisionVerdict["confidence"] {
  return (CONFIDENCE_ENUM as readonly string[]).includes(s);
}

async function classifyBatch(batch: VisionInput[], ctx: VisionContext): Promise<Map<string, VisionVerdict>> {
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      // Одна повторная попытка: таймаут или 429 на одном батче не должны
      // оставлять снимки без вердикта — иначе они молча теряют категорию.
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const partial = await classifyBatch(batch, ctx);
          partial.forEach((v, k) => verdicts.set(k, v));
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
        }
      }
      if (lastError) errors.push((lastError as Error).message);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  return { verdicts, errors };
}
