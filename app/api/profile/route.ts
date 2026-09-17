// app/api/profile/route.ts
// GET /api/profile?qid=Q12345 → поток NDJSON: события прогресса, затем итоговый профиль.
// Каждая строка — отдельный JSON. Последняя строка: {"type":"profile", ...Profile}
// или {"type":"error","error":"..."}.

import { buildProfile } from "@/lib/profile";
import { getUniversityByQid } from "@/lib/wikidata";
import type { ProgressEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NDJSON_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Accel-Buffering": "no",
};

export async function GET(req: Request): Promise<Response> {
  const qid = new URL(req.url).searchParams.get("qid") ?? "";

  if (!/^Q\d+$/.test(qid)) {
    return Response.json({ error: "Параметр qid должен иметь вид Q12345" }, { status: 400 });
  }

  let university;
  try {
    university = await getUniversityByQid(qid);
  } catch (e) {
    return Response.json({ error: `Wikidata недоступна: ${(e as Error).message}` }, { status: 502 });
  }
  if (!university) {
    return Response.json({ error: `Университет ${qid} не найден в Wikidata или не является вузом` }, { status: 404 });
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
