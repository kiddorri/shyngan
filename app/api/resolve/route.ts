// app/api/resolve/route.ts
// GET /api/resolve?q=<название> → { candidates: UniversityCandidate[] }

import { resolveUniversity } from "@/lib/wikidata";

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
    const candidates = await resolveUniversity(q);
    return Response.json({ candidates });
  } catch (e) {
    return Response.json(
      { candidates: [], error: `Wikidata недоступна: ${(e as Error).message}` },
      { status: 502 },
    );
  }
}
