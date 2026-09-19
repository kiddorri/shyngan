// Живой контроль поиска перед демонстрацией: запустите приложение и npm run test:search.
// Проверяем первый результат, поскольку именно его пользователь видит главным.
import assert from "node:assert/strict";

const baseUrl = process.env.SEARCH_BASE_URL ?? "http://localhost:3000";
const cases = [
  ["harward", "Q13371"],
  ["Harvard", "Q13371"],
  ["MIT", "Q49108"],
  ["北京大学", "Q16952"],
  ["清华大学", "Q16955"],
  ["서울대학교", "Q39913"],
  ["KAIST", "Q39949"],
  ["Назарбаев Университет", "Q2783344"],
];

for (const [query, expectedQid] of cases) {
  const started = Date.now();
  const response = await fetch(`${baseUrl}/api/resolve?q=${encodeURIComponent(query)}`, {
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, `${query}: HTTP ${response.status}`);
  const body = await response.json();
  const actualQid = body.candidates?.[0]?.qid;
  assert.equal(actualQid, expectedQid, `${query}: первый результат ${actualQid ?? "пусто"}`);
  console.log(`${query}: ${actualQid} (${Date.now() - started} мс)`);
}
console.log("Поиск: все контрольные запросы прошли.");
