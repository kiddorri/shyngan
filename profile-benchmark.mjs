// Показывает, сколько времени заняли этапы сборки профиля из потока NDJSON.
const qid = process.argv[2] ?? "Q16955";
const mode = process.argv[3] ?? "quick";
const baseUrl = process.env.SEARCH_BASE_URL ?? "http://localhost:3000";
const started = Date.now();
const response = await fetch(`${baseUrl}/api/profile?qid=${qid}&mode=${mode}`);
console.log(`HTTP ${response.status} за ${Date.now() - started} мс`);
if (!response.ok || !response.body) process.exit(1);
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
while (true) {
  const { value, done } = await reader.read();
  buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line) continue;
    const item = JSON.parse(line);
    const details = item.type === "profile"
      ? JSON.stringify({ photos: item.photos.length, sources: item.sources,
        timingMs: item.timingMs, cacheAgeMs: item.cacheAgeMs })
      : item.type === "error" ? item.error : item.error ?? "";
    console.log(`${Date.now() - started} мс: ${item.type} ${item.stage ?? ""} ${details}`);
  }
  if (done) break;
}
