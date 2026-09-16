// app/api/profile/route.ts
// GET /api/profile?qid=Q12345 → Profile

import { buildProfile } from "@/lib/profile";
import { getUniversityByQid } from "@/lib/wikidata";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  const qid = new URL(req.url).searchParams.get("qid") ?? "";

  if (!/^Q\d+$/.test(qid)) {
    return Response.json({ error: "Параметр qid должен иметь вид Q12345" }, { status: 400 });
  }

  let university;
  try {
    university = await getUniversityByQid(qid);
  } catch (e) {
    return Response.json(
      { error: `Wikidata недоступна: ${(e as Error).message}` },
      { status: 502 },
    );
  }

  if (!university) {
    return Response.json(
      { error: `Университет ${qid} не найден в Wikidata или не является вузом` },
      { status: 404 },
    );
  }

  try {
    const profile = await buildProfile(university);
    return Response.json(profile);
  } catch (e) {
    return Response.json(
      { error: `Не удалось собрать профиль: ${(e as Error).message}` },
      { status: 500 },
    );
  }
}
