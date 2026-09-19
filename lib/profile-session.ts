export type ProfileSession = {
  qid: string;
  touchedAt: number;
  processedIds: Set<string>;
  processedUrls: Set<string>;
};

const TTL_MS = 10 * 60_000;
const MAX_SESSIONS = 24;
const sessions = new Map<string, ProfileSession>();

export function profileSession(qid: string, reset = false): ProfileSession {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.touchedAt > TTL_MS) sessions.delete(key);
  }

  if (reset) sessions.delete(qid);
  let session = sessions.get(qid);
  if (!session) {
    session = { qid, touchedAt: now, processedIds: new Set(), processedUrls: new Set() };
    sessions.set(qid, session);
  }
  session.touchedAt = now;
  sessions.delete(qid);
  sessions.set(qid, session);
  if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  return session;
}
