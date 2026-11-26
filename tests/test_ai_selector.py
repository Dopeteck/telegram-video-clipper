"""Tests for the model-backed, context-aware clip selector."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import score_clips


def _group(text, start, end, complete=True):
    words = text.split()
    return {
        "start": float(start),
        "end": float(end),
        "text": text,
        "complete": complete,
        "words": [
            {"word": word, "start": float(start), "end": float(end)}
            for word in words
        ],
    }


def test_ai_window_accepts_a_complete_moment_without_lexical_sentence_links():
    # The model has judged these unrelated-sounding sentences as one coherent
    # story/explanation. Boundary validation must not re-run the old lexical gate.
    groups = [
        _group("The founder describes the first difficult decision.", 0, 19),
        _group("Customer numbers fell for three consecutive months.", 19.2, 39.2),
        _group("The team discovered a hidden billing problem.", 39.4, 59.4),
        _group("Changing one setting fixed the entire issue.", 59.6, 79.6),
    ]

    assert score_clips._normalize_ai_window(groups, 0, 3, 60, 180) == (0, 3)


def test_ai_window_borrows_a_question_when_it_starts_on_the_answer():
    groups = [
        _group("Why did you decide to leave the company?", 0, 12),
        _group("Because the leadership ignored every warning.", 12.2, 45.2),
        _group("I had already explained the risk several times.", 45.4, 82.4),
    ]

    assert score_clips._normalize_ai_window(groups, 1, 2, 60, 180) == (0, 2)


def test_ai_window_rejects_an_unanswered_question_at_the_end():
    groups = [_group("After all those years, what happened to the project?", 0, 70)]
    assert score_clips._normalize_ai_window(groups, 0, 0, 60, 180) is None


def test_ai_window_enforces_the_requested_duration():
    groups = [
        _group("The complete first part of the story is here.", 0, 25),
        _group("The complete second part brings the explanation.", 25.2, 50.2),
    ]
    assert score_clips._normalize_ai_window(groups, 0, 1, 60, 180) is None


def test_ollama_selector_uses_model_windows_without_calling_heuristic_growth(monkeypatch):
    groups = [
        _group("The founder explains the difficult decision.", 0, 15),
        _group("Customers reacted in a way nobody expected.", 15.2, 31),
        _group("The team discovered the real cause.", 31.2, 47),
        _group("One small change solved the problem.", 47.2, 63),
        _group("That is why the lesson matters today.", 63.2, 79),
    ]
    words = [word for group in groups for word in group["words"]]
    response_body = {
        "message": {
            "content": json.dumps({
                "clips": [{
                    "start_index": 0,
                    "end_index": 4,
                    "hook": "The decision that changed everything",
                    "overall": 8.7,
                    "reason": "A complete cause, consequence and payoff.",
                }]
            })
        }
    }

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return json.dumps(response_body).encode("utf-8")

    def fake_urlopen(request, timeout):
        payload = json.loads(request.data.decode("utf-8"))
        assert payload["model"] == "qwen3:4b-instruct-2507-q4_K_M"
        assert payload["options"]["num_ctx"] == 8192
        assert "Think like an editor, not a keyword scanner" in payload["messages"][0]["content"]
        return FakeResponse()

    monkeypatch.setattr(score_clips.urllib.request, "urlopen", fake_urlopen)

    def forbidden_growth(*args, **kwargs):
        raise AssertionError("AI-selected clips must not be passed through _grow_window")

    monkeypatch.setattr(score_clips, "_grow_window", forbidden_growth)
    selected = score_clips.ollama_select(
        {"words": words, "segments": [], "duration": 80},
        "qwen3:4b-instruct-2507-q4_K_M",
        "http://127.0.0.1:11434",
        min_score=5.5,
        max_clips=3,
        min_len=60,
        max_len=180,
    )

    assert len(selected) == 1
    assert 60 <= selected[0]["end"] - selected[0]["start"] <= 180
    assert selected[0]["hook"]
    assert selected[0]["signals"]["ai_score"] == 8.7
    assert selected[0]["selection_reasons"]



def test_ollama_context_limit_splits_large_sections_and_retries(monkeypatch):
    groups = [
        _group(f"Complete explanation sentence number {index}.", index * 12, index * 12 + 11)
        for index in range(8)
    ]
    words = [word for group in groups for word in group["words"]]
    request_sizes = []

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return json.dumps({
                "message": {
                    "content": json.dumps({
                        "clips": [{
                            "start_index": 0,
                            "end_index": 5,
                            "hook": "The complete explanation",
                            "overall": 8.5,
                            "reason": "A clear explanation with a complete payoff.",
                        }]
                    })
                }
            }).encode("utf-8")

    def fake_urlopen(request, timeout):
        payload = json.loads(request.data.decode("utf-8"))
        user_text = payload["messages"][1]["content"]
        row_count = sum(1 for line in user_text.splitlines() if line.startswith("["))
        request_sizes.append(row_count)
        if row_count > 6:
            import urllib.error
            from io import BytesIO
            raise urllib.error.HTTPError(
                request.full_url,
                400,
                "Bad Request",
                hdrs=None,
                fp=BytesIO(b'{"error":"the input length exceeds the context length"}'),
            )
        return FakeResponse()

    monkeypatch.setattr(score_clips, "AI_CHUNK_GROUPS", 8)
    monkeypatch.setattr(score_clips, "AI_CHUNK_OVERLAP", 2)
    monkeypatch.setattr(score_clips, "AI_CONTEXT_MIN_GROUPS", 2)
    monkeypatch.setattr(score_clips.urllib.request, "urlopen", fake_urlopen)

    selected = score_clips.ollama_select(
        {"words": words, "segments": [], "duration": 96},
        "qwen3:4b-instruct-2507-q4_K_M",
        "http://127.0.0.1:11434",
        min_score=5.5,
        max_clips=3,
        min_len=60,
        max_len=180,
    )

    assert request_sizes == [8, 6, 6]
    # Both chunks returned a candidate, but the global quality gate correctly
    # keeps only one because the two test windows overlap heavily.
    assert len(selected) == 1


def test_ollama_http_400_reports_the_response_body(monkeypatch, capsys):
    import urllib.error
    from io import BytesIO

    groups = [
        _group("A complete first sentence.", 0, 20),
        _group("A complete second sentence.", 20.2, 40.2),
        _group("A complete third sentence.", 40.4, 60.4),
        _group("A complete final sentence.", 60.6, 80.6),
    ]
    words = [word for group in groups for word in group["words"]]

    def fake_urlopen(request, timeout):
        raise urllib.error.HTTPError(
            request.full_url,
            400,
            "Bad Request",
            hdrs=None,
            fp=BytesIO(b'{"error":"unsupported request option"}'),
        )

    monkeypatch.setattr(score_clips.urllib.request, "urlopen", fake_urlopen)
    assert score_clips.ollama_select(
        {"words": words, "segments": [], "duration": 81},
        "qwen3:4b-instruct-2507-q4_K_M",
        "http://127.0.0.1:11434",
        min_score=5.5,
        max_clips=3,
        min_len=60,
        max_len=180,
    ) is None

    output = capsys.readouterr().out
    assert "Ollama HTTP 400" in output
    assert "unsupported request option" in output

def test_strict_llm_mode_does_not_silently_fall_back_to_heuristics(tmp_path):
    import pytest

    words = [
        {"word": "First", "start": 0.0, "end": 0.3},
        {"word": "thought.", "start": 0.4, "end": 0.8},
        {"word": "Second", "start": 2.0, "end": 2.3},
        {"word": "point.", "start": 2.4, "end": 2.8},
        {"word": "Third", "start": 4.0, "end": 4.3},
        {"word": "example.", "start": 4.4, "end": 4.8},
        {"word": "Final", "start": 6.0, "end": 6.3},
        {"word": "thought.", "start": 6.4, "end": 6.8},
    ]
    (tmp_path / "transcript.json").write_text(
        json.dumps({"words": words, "segments": [], "duration": 80, "language": "en"}),
        encoding="utf-8",
    )

    with pytest.raises(SystemExit, match="Required AI clip selector"):
        score_clips.run(
            tmp_path,
            llm="qwen3:4b-instruct-2507-q4_K_M",
            host="http://127.0.0.1:1",
            max_clips=3,
            min_len=5,
            max_len=40,
            min_score=0,
            strict_llm=True,
        )
