// lib/image.ts
// Загрузка картинки по URL, нормализация под vision и перцептивный хэш (dHash).
// Только серверный код: sharp нельзя импортировать из клиентских компонентов.

import sharp from "sharp";

const MAX_BYTES = 8_000_000;
const REQUEST_TIMEOUT_MS = 8000;
/** Ширина, до которой ужимаем копию для vision и хэша. Оригинальные размеры сохраняем отдельно. */
const NORMALIZED_WIDTH = 1024;

export type LoadedImage = {
  url: string;
  /** JPEG ≤ 1024 px по ширине — то, что уходит в vision. */
  bytes: Buffer;
  mime: "image/jpeg";
  /** Размеры оригинала. */
  width: number;
  height: number;
};

/**
 * Скачивает картинку и приводит к JPEG ≤ 1024 px. Возвращает null при любой ошибке:
 * таймаут, не-изображение, слишком большой файл, нечитаемый формат.
 */
export async function loadImage(url: string, userAgent: string): Promise<LoadedImage | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": userAgent, Accept: "image/*" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return null;

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType && !contentType.startsWith("image/")) return null;

    const raw = Buffer.from(await res.arrayBuffer());
    if (raw.length === 0 || raw.length > MAX_BYTES) return null;

    const meta = await sharp(raw).metadata();
    if (!meta.width || !meta.height) return null;
    // SVG и анимации не нужны: это иконки и баннеры, а не фотографии.
    if (meta.format === "svg" || meta.format === "gif") return null;

    const bytes = await sharp(raw)
      .rotate()
      .resize({ width: NORMALIZED_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    return { url, bytes, mime: "image/jpeg", width: meta.width, height: meta.height };
  } catch {
    return null;
  }
}

/**
 * dHash: картинка → 9×8 в градациях серого → 64 бита «пиксель ярче соседа справа».
 * Устойчив к пережатию и изменению размера. Возвращает 16 hex-символов.
 */
export async function dHash(bytes: Buffer): Promise<string> {
  const px = await sharp(bytes)
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer();

  let hex = "";
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) {
      const left = px[y * 9 + x];
      const right = px[y * 9 + x + 1];
      byte = (byte << 1) | (left > right ? 1 : 0);
    }
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Резкость снимка: дисперсия лапласиана в градациях серого.
 *
 * Лапласиан — вторая производная яркости: на границах объектов он большой, на
 * гладкой размытой картинке близок к нулю. Дисперсия этих значений и есть
 * стандартная мера «есть ли в кадре чёткие детали». Чем меньше число, тем
 * сильнее размытие; у пустых и расфокусированных снимков оно падает в разы.
 *
 * Картинка приводится к 256×256, иначе большие снимки получают преимущество
 * просто за размер и пороги становятся несравнимыми.
 *
 * Это измерение, а не суждение о содержимом: метрика не отличает размытый кадр
 * от намеренно гладкого (туман, однотонная стена). Поэтому порог в профиле
 * берётся с запасом, а всё отсеянное считается отдельной строкой статистики.
 */
export async function sharpness(bytes: Buffer): Promise<number> {
  const side = 256;
  const px = await sharp(bytes).grayscale().resize(side, side, { fit: "fill" }).raw().toBuffer();

  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < side - 1; y++) {
    for (let x = 1; x < side - 1; x++) {
      const i = y * side + x;
      const lap = 4 * px[i] - px[i - 1] - px[i + 1] - px[i - side] - px[i + side];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/** Число различающихся битов между двумя dHash. 0 — одинаковые, ≤10 — визуально похожие. */
export function hamming(a: string, b: string): number {
  let dist = 0;
  for (let i = 0; i < 16; i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}
