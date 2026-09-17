// app/api/profile/route.ts
// GET /api/profile?qid=Q12345 → поток NDJSON: события прогресса, затем итоговый профиль.
// Каждая строка — отдельный JSON. Последняя строка: {"type":"profile", ...Profile}
// или {"type":"error","error":"..."}.

import { buildProfile } from "@/lib/profile";
import { getUniversityByAnyId } from "@/lib/resolve";
import { WikidataUnavailableError } from "@/lib/wikidata";
import type { ProgressEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
/** Hobby-план Vercel допускает до 300 с. Потолок с запасом: обычная сборка укладывается в 30 с,
 *  но у вуза с большим числом мест лучше отдать медленный ответ, чем оборвать поток. */
export const maxDuration = 180;

const NDJSON_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Accel-Buffering": "no",
};

export async function GET(req: Request): Promise<Response> {
  const qid = new URL(req.url).searchParams.get("qid") ?? "";

  // Идентификатор вуза: QID из Wikidata либо places:<place_id> для вузов вне Wikidata.
  if (!/^Q\d+$/.test(qid) && !/^places:[\w-]+$/.test(qid)) {
    return Response.json({ error: "Параметр qid должен иметь вид Q12345 или places:<id>" }, { status: 400 });
  }

  let university;
  try {
    university = await getUniversityByAnyId(qid);
  } catch (e) {
    const unavailable = e instanceof WikidataUnavailableError;
    return Response.json(
      {
        error: unavailable
          ? "Справочник Wikidata временно не отвечает. Повторите через несколько секунд."
          : `Ошибка резолва: ${(e as Error).message}`,
      },
      { status: unavailable ? 503 : 502 },
    );
  }
  if (!university) {
    return Response.json({ error: `Университет ${qid} не найден или не является вузом` }, { status: 404 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      send({ type: "university", university });
      try {
        const profile = await buildProfile(university, (e: ProgressEvent) => send({ type: "progress", ...e }));
        send({ type: "profile", ...profile });
      } catch (e) {
        send({ type: "error", error: `Не удалось собрать профиль: ${(e as Error).message}` });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: NDJSON_HEADERS });
}
