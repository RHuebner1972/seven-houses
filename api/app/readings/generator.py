from collections.abc import Generator
from dataclasses import dataclass

import anthropic

from app.config import get_settings
from app.readings.prompts import SYSTEM_PROMPT


class GenerationError(Exception):
    pass


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int


def stream_reading(model: str, messages: list[dict], max_tokens: int) -> Generator[str, None, Usage]:
    try:
        client = anthropic.Anthropic(
            api_key=get_settings().anthropic_api_key, timeout=120.0, max_retries=2
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
