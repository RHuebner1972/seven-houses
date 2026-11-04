import type { SseEvent } from "./types";

const KNOWN = new Set(["cards", "delta", "done", "error"]);

function parseFrame(frame: string): SseEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? "" : line.slice(i + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!KNOWN.has(event) || data.length === 0) return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) } as SseEvent;
  } catch {
    return null;
  }
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let raw = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      // hold a trailing \r back: it may be the first half of a \r\n split across chunks
      const hold = raw.endsWith("\r") ? 1 : 0;
      buf += raw.slice(0, raw.length - hold).replace(/\r\n?/g, "\n");
      raw = raw.slice(raw.length - hold);
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseFrame(frame);
        if (ev) yield ev;
      }
    }
  } finally {
    reader.releaseLock();
  }
  // trailing partial frame (no terminating blank line) is discarded
}
