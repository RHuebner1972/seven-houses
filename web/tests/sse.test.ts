import { describe, expect, test, vi } from "vitest";
import { ApiError } from "@/lib/errors";
import { parseSse } from "@/lib/sse";
import { collect, streamOf } from "./helpers/stream";

describe("parseSse", () => {
  test("reassembles events split across chunks", async () => {
    const chunks = [
      'event: cards\ndata: {"reading_id":"r1","cost":1,"ca',
      'rds":[]}\n\nevent: delta\ndata: {"text":"Hi"}\n\nevent: do',
      'ne\ndata: {"reading_id":"r1"}\n\n',
    ];
    const events = await collect(parseSse(streamOf(chunks)));
    expect(events.map((e) => e.event)).toEqual(["cards", "delta", "done"]);
    expect(events[1].data).toEqual({ text: "Hi" });
  });

  test("ignores comment and blank keep-alive lines", async () => {
    const events = await collect(
      parseSse(streamOf([": ping\n\n", 'event: done\ndata: {"reading_id":"r"}\n\n'])),
    );
    expect(events).toHaveLength(1);
  });

  test("handles CRLF framing, including CRLF split across chunks", async () => {
    const events = await collect(
      parseSse(
        streamOf([
          'event: delta\r\ndata: {"text":"a"}\r',
          '\n\r',
          '\nevent: done\r\ndata: {"reading_id":"r"}\r\n\r\n',
        ]),
      ),
    );
    expect(events.map((e) => e.event)).toEqual(["delta", "done"]);
    expect(events[0].data).toEqual({ text: "a" });
  });

  test("joins multi-line data with newline", async () => {
    const events = await collect(
      parseSse(streamOf(['event: delta\ndata: {"text":\ndata: "x"}\n\n'])),
    );
    expect(events).toEqual([{ event: "delta", data: { text: "x" } }]);
  });

  test("ignores events without an event name or with unknown names", async () => {
    const events = await collect(
      parseSse(
        streamOf([
          'data: {"x":1}\n\n',
          'event: other\ndata: {"x":1}\n\n',
          'event: done\ndata: {"reading_id":"r"}\n\n',
        ]),
      ),
    );
    expect(events.map((e) => e.event)).toEqual(["done"]);
  });

  test("discards a trailing partial frame at stream end", async () => {
    const events = await collect(
      parseSse(
        streamOf(['event: delta\ndata: {"text":"a"}\n\n', 'event: done\ndata: {"reading_id":"r"}\n']),
      ),
    );
    expect(events.map((e) => e.event)).toEqual(["delta"]);
  });

  test("data: without a space after the colon", async () => {
    const events = await collect(parseSse(streamOf(['event:done\ndata:{"reading_id":"r"}\n\n'])));
    expect(events).toEqual([{ event: "done", data: { reading_id: "r" } }]);
  });

  test("early exit cancels the underlying stream", async () => {
    const cancel = vi.fn();
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('event: delta\ndata: {"text":"a"}\n\n'));
      },
      cancel,
    });
    for await (const ev of parseSse(body)) {
      expect(ev.event).toBe("delta");
      break;
    }
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  test("mid-stream read failure becomes ApiError(0, network)", async () => {
    const enc = new TextEncoder();
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (n++ === 0) c.enqueue(enc.encode('event: delta\ndata: {"text":"a"}\n\n'));
        else return Promise.reject(new TypeError("terminated"));
      },
    });
    const gen = parseSse(body);
    expect((await gen.next()).value?.event).toBe("delta");
    const err = await gen.next().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: "network", message: "terminated" });
  });

  test("mid-stream AbortError is rethrown unchanged", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return Promise.reject(new DOMException("aborted", "AbortError"));
      },
    });
    await expect(collect(parseSse(body))).rejects.toMatchObject({ name: "AbortError" });
  });
});
