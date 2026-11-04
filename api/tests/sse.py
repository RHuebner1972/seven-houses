import json
from collections.abc import Iterable


def parse_sse(lines: Iterable[str]) -> list[dict]:
    """Group `event:`/`data:` lines into [{"event": name, "data": {...}}].

    A blank line ends an event.
    """
    events: list[dict] = []
    name: str | None = None
    data: list[str] = []

    def flush():
        if name is not None or data:
            events.append({"event": name, "data": json.loads("\n".join(data)) if data else None})

    for line in lines:
        if line == "":
            flush()
            name, data = None, []
        elif line.startswith("event:"):
            name = line[len("event:"):].strip()
        elif line.startswith("data:"):
            data.append(line[len("data:"):].strip())
    flush()
    return events
