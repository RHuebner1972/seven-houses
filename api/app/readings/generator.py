from collections.abc import Generator
from dataclasses import dataclass

import anthropic

from app.config import get_settings
from app.readings.prompts import FOOTER, SYSTEM_PROMPT

# read= bounds the gap between streamed chunks; the overall wall clock is bounded by
# run_generation's deadline.
CLIENT_TIMEOUT = anthropic.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0)


class GenerationError(Exception):
    pass


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int


def stream_reading(
    model: str, messages: list[dict], max_tokens: int, allow_truncation: bool = False
) -> Generator[str, None, Usage]:
    """Yield text chunks; return token usage.

    A reply cut off at max_tokens raises GenerationError("truncated") (the caller
    fails and refunds) unless `allow_truncation` (the short free daily card), in
    which case the footer line is appended if it is missing.
    """
    try:
        client = anthropic.Anthropic(
            api_key=get_settings().anthropic_api_key, timeout=CLIENT_TIMEOUT, max_retries=1
        )
        with client.messages.stream(
            model=model, max_tokens=max_tokens, system=SYSTEM_PROMPT, messages=messages
        ) as stream:
            parts = []
            for text in stream.text_stream:
                parts.append(text)
                yield text
            final = stream.get_final_message()
            if getattr(final, "stop_reason", None) == "max_tokens":
                if not allow_truncation:
                    raise GenerationError("truncated")
                if FOOTER not in "".join(parts):
                    yield f"\n\n{FOOTER}"
        return Usage(final.usage.input_tokens, final.usage.output_tokens)
    except (anthropic.APIError, anthropic.AnthropicError) as e:
        raise GenerationError(str(e)) from e
