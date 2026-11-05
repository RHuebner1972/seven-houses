import anthropic
import httpx
import pytest

from app.readings.generator import GenerationError, stream_reading
from app.readings.prompts import SYSTEM_PROMPT


def _status_error():
    return anthropic.APIStatusError(
        "boom",
        response=httpx.Response(500, request=httpx.Request("POST", "https://x")),
        body=None,
    )


def _conn_error():
    return anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com"))


def test_yields_chunks_and_returns_usage(fake_anthropic):
    fake_anthropic.chunks = ["Hel", "lo"]
    fake_anthropic.usage = (100, 20)
    gen = stream_reading("m", [], max_tokens=600)
    out = []
    try:
        while True:
            out.append(next(gen))
    except StopIteration as s:
        usage = s.value
    assert out == ["Hel", "lo"]
    assert (usage.input_tokens, usage.output_tokens) == (100, 20)


def test_sdk_error_becomes_generation_error(fake_anthropic):
    fake_anthropic.raise_on_stream = _status_error()
    with pytest.raises(GenerationError) as ei:
        list(stream_reading("m", [], max_tokens=600))
    assert isinstance(ei.value.__cause__, anthropic.APIStatusError)


def test_passes_system_model_max_tokens_and_messages(fake_anthropic):
    msgs = [{"role": "user", "content": "hi"}]
    list(stream_reading("claude-x", msgs, max_tokens=321))
    kw = fake_anthropic.last_kwargs
    assert kw["system"] == SYSTEM_PROMPT
    assert kw["model"] == "claude-x"
    assert kw["max_tokens"] == 321
    assert fake_anthropic.last_messages == msgs


def test_mid_stream_error_after_first_chunk(fake_anthropic):
    fake_anthropic.chunks = ["a", "b"]
    fake_anthropic.raise_after_chunks = 1
    fake_anthropic.error = _conn_error()
    gen = stream_reading("m", [], max_tokens=10)
    assert next(gen) == "a"
    with pytest.raises(GenerationError):
        next(gen)


def test_generator_exit_not_swallowed(fake_anthropic):
    fake_anthropic.chunks = ["a", "b"]
    gen = stream_reading("m", [], max_tokens=10)
    assert next(gen) == "a"
    gen.close()  # must not raise GenerationError
    with pytest.raises(StopIteration):
        next(gen)


def test_client_has_bounded_timeouts_and_one_retry(fake_anthropic):
    fake_anthropic.chunks = ["a"]
    list(stream_reading("m", [], max_tokens=10))
    timeout = fake_anthropic.client_kwargs["timeout"]
    assert isinstance(timeout, anthropic.Timeout)
    assert (timeout.connect, timeout.read, timeout.write, timeout.pool) == (10.0, 60.0, 10.0, 10.0)
    assert fake_anthropic.client_kwargs["max_retries"] == 1


def test_client_timeout_is_accepted_by_the_real_sdk():
    # fake_anthropic replaces the client, so only this catches a timeout type the SDK rejects.
    from app.readings.generator import CLIENT_TIMEOUT

    anthropic.Anthropic(api_key="x", timeout=CLIENT_TIMEOUT, max_retries=1)


def test_truncated_paid_reply_raises(fake_anthropic):
    fake_anthropic.chunks = ["a", "b"]
    fake_anthropic.stop_reason = "max_tokens"
    with pytest.raises(GenerationError, match="truncated"):
        list(stream_reading("m", [], max_tokens=10))


def test_truncated_daily_reply_gets_footer(fake_anthropic):
    from app.readings.prompts import FOOTER

    fake_anthropic.chunks = ["Your card", " invites"]
    fake_anthropic.stop_reason = "max_tokens"
    assert list(stream_reading("m", [], 600, allow_truncation=True)) == [
        "Your card", " invites", f"\n\n{FOOTER}"
    ]
    fake_anthropic.chunks = ["Your card.\n", FOOTER]
    assert list(stream_reading("m", [], 600, allow_truncation=True)) == ["Your card.\n", FOOTER]
