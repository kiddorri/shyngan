// app/api/resolve/route.ts
// GET /api/resolve?q=<название> → { candidates: UniversityCandidate[] }

import { resolveAny } from "@/lib/resolve";
import { WikidataUnavailableError } from "@/lib/wikidata";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams.get("q") ?? "";

  if (q.trim().length < 2) {
    return Response.json(
      { candidates: [], error: "Введите название университета (минимум 2 символа)" },
      { status: 400 },
    );
  }

  try {
    const candidates = await resolveAny(q);
    return Response.json({ candidates });
  } catch (e) {
    const unavailable = e instanceof WikidataUnavailableError;
    return Response.json(
      {
        candidates: [],
        error: unavailable
          ? "Справочник Wikidata временно не отвечает — это не значит, что университета нет. Повторите через несколько секунд."
          : `Ошибка резолва: ${(e as Error).message}`,
      },
      { status: unavailable ? 503 : 502 },
    );
  }
}
