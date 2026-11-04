from collections.abc import Generator
from dataclasses import dataclass

import anthropic
import httpx

from app.config import get_settings
from app.readings.prompts import SYSTEM_PROMPT

# read= bounds the gap between streamed chunks; the overall wall clock is bounded by
# run_generation's deadline.
CLIENT_TIMEOUT = httpx.Timeout(connect=10.0, read=60.0, write=10.0, pool=10.0)


class GenerationError(Exception):
    pass


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int


def stream_reading(model: str, messages: list[dict], max_tokens: int) -> Generator[str, None, Usage]:
    try:
        client = anthropic.Anthropic(
            api_key=get_settings().anthropic_api_key, timeout=CLIENT_TIMEOUT, max_retries=1
        )
        with client.messages.stream(
            model=model, max_tokens=max_tokens, system=SYSTEM_PROMPT, messages=messages
        ) as stream:
            for text in stream.text_stream:
                yield text
            final = stream.get_final_message()
        return Usage(final.usage.input_tokens, final.usage.output_tokens)
    except (anthropic.APIError, anthropic.AnthropicError) as e:
        raise GenerationError(str(e)) from e
