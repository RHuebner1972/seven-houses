import { describe, expect, test } from "vitest";
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
});
