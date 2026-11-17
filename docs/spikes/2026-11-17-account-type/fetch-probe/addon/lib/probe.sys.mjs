export function globalsReport() {
  const names = ["fetch","Headers","Request","Response","ReadableStream","TextDecoder","TextEncoder","AbortController","URL","URLSearchParams","EventSource","WebSocket","setTimeout","structuredClone","crypto","Blob","atob","btoa","XMLHttpRequest","console"];
  return Object.fromEntries(names.map(n => [n, typeof globalThis[n]]));
}
export async function sseTest(url) {
  const t0 = Date.now();
  const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const chunks = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push({ ms: Date.now() - t0, text: dec.decode(value) });
  }
  return { status: res.status, chunks };
}
export async function jsonTest(url) {
  const res = await fetch(url, { headers: { Authorization: "Basic " + btoa("a:b") } });
  return { status: res.status, body: await res.json() };
}
