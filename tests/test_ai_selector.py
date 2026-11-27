"""Tests for the model-backed, context-aware clip selector."""
import json
import re
import sys
import urllib.error
from io import BytesIO
from pathlib import Path

import pytest

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


def _candidate(start, end, score=6.0, hook="A useful moment"):
    return {
        "start": float(start),
        "end": float(end),
        "hook": hook,
        "overall": float(score),
        "signals": {"transcript": float(score)},
    }


def _fake_response(body):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return json.dumps({
                "message": {"content": json.dumps(body)}
            }).encode("utf-8")

    return FakeResponse()


def test_ai_window_accepts_a_complete_moment_without_lexical_sentence_links():
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


def test_ai_selector_uses_one_global_comparison_and_preserves_candidate_boundaries(monkeypatch):
    groups = [
        _group("The founder explains the difficult decision.", 0, 15),
        _group("Customers reacted in a way nobody expected.", 15.2, 31),
        _group("The team discovered the real cause.", 31.2, 47),
        _group("One small change solved the problem.", 47.2, 63),
        _group("That is why the lesson matters today.", 63.2, 79),
    ]
    words = [word for group in groups for word in group["words"]]
    calls = []

    def fake_urlopen(request, timeout):
        payload = json.loads(request.data.decode("utf-8"))
        calls.append(payload)
        assert payload["model"] == "qwen3:4b-instruct-2507-q4_K_M"
        assert payload["options"]["num_ctx"] == 8192
        assert "final editorial selection" in payload["messages"][0]["content"]
        prompt = payload["messages"][1]["content"]
        assert "C1 | 0.0-79.0s" in prompt
        assert "The founder explains the difficult decision." in prompt
        return _fake_response({
            "evaluated": [{
                "id": "C1",
                "overall": 8.7,
                "selected": True,
                "hook": "The decision that changed everything",
                "reason": "A complete cause, consequence and payoff.",
            }]
        })

    monkeypatch.setattr(score_clips.urllib.request, "urlopen", fake_urlopen)
    selected = score_clips.ollama_select(
        {"words": words, "segments": [], "duration": 80},
        "qwen3:4b-instruct-2507-q4_K_M",
        "http://127.0.0.1:11434",
        min_score=5.5,
        max_clips=3,
        min_len=60,
        max_len=180,
    )

    assert len(calls) == 1
    assert len(selected) == 1
    assert selected[0]["start"] == 0.0
    assert selected[0]["end"] == 79.0
    assert 60 <= selected[0]["end"] - selected[0]["start"] <= 180
    assert selected[0]["hook"]
    assert selected[0]["signals"]["ai_score"] == 8.7
    assert selected[0]["selection_reasons"]


def test_ai_discovery_finds_time_balanced_windows_in_a_long_varied_transcript():
    # 1,439 sentence groups approximates the failed 48-minute job. Vocabulary
    # intentionally changes from sentence to sentence; adjacent sentences do
    # not need to pass the old lexical-overlap continuation heuristic.
    groups = []
    for index in range(1439):
        start = index * 2.02
        groups.append(_group(
            f"At chapter {index}, the speaker explains a separate detail number {index}.",
            start,
            start + 1.8,
        ))

    candidates = score_clips._build_ai_discovery_candidates(
        groups, min_len=60, max_len=180, pool_size=48
    )
    review_pool = score_clips._balanced_ai_review_pool(
        candidates, duration=groups[-1]["end"], limit=9
    )

    assert len(candidates) >= 100
    assert len(review_pool) == 9
    durations = [item["end"] - item["start"] for item in candidates]
    assert all(60 <= duration <= 180 for duration in durations)
    # Discovery must offer materially different lengths so Qwen can retain
    # more context when a story needs it instead of being locked to ~90s.
    assert min(durations) <= 70
    assert max(durations) >= 175
    assert candidates[0]["start"] < 10
    assert candidates[-1]["end"] > groups[-1]["end"] * 0.85
    for index, candidate in enumerate(review_pool):
        assert all(
            candidate["end"] <= other["start"] - 10
            or candidate["start"] >= other["end"] + 10
            for other in review_pool[index + 1:]
        )


def test_ai_discovery_does_not_join_windows_across_a_long_pause():
    groups = []
    for index in range(90):
        start = index * 2.02 + (8.0 if index >= 35 else 0.0)
        groups.append(_group(
            f"Sentence {index} describes a new part of the discussion.",
            start,
            start + 1.8,
        ))

    candidates = score_clips._build_ai_discovery_candidates(
        groups, min_len=60, max_len=180, pool_size=48
    )
    pause_start = groups[34]["end"]
    pause_end = groups[35]["start"]

    assert candidates
    assert all(
        not (item["start"] < pause_start and item["end"] > pause_end)
        for item in candidates
    )


def test_ai_review_pool_spreads_candidates_across_the_timeline_and_avoids_overlap():
    starts = [0, 100, 250, 350, 500, 600, 750, 850]
    candidates = [
        _candidate(start, start + 70, score=9.0 - index * 0.1)
        for index, start in enumerate(starts)
    ]
    pool = score_clips._balanced_ai_review_pool(candidates, duration=1000, limit=4)

    assert len(pool) == 4
    selected_starts = [item["start"] for item in pool]
    assert selected_starts == [0.0, 250.0, 500.0, 750.0]
    for index, candidate in enumerate(pool):
        assert all(
            candidate["end"] <= other["start"] - 10
            or candidate["start"] >= other["end"] + 10
            for other in pool[index + 1:]
        )


def test_context_limit_retries_with_fewer_whole_candidates(monkeypatch):
    groups = [
        _group(f"Story section {index} explains an important complete point.", index * 10, index * 10 + 9)
        for index in range(81)
    ]
    words = [word for group in groups for word in group["words"]]
    candidates = [
        _candidate(index * 90, index * 90 + 60, score=6.2 + index / 10)
        for index in range(8)
    ]
    monkeypatch.setattr(score_clips, "_build_ai_discovery_candidates",
                        lambda *args, **kwargs: candidates)
    request_sizes = []

    def fake_urlopen(request, timeout):
        payload = json.loads(request.data.decode("utf-8"))
        user_text = payload["messages"][1]["content"]
        candidate_count = len(re.findall(r"(?m)^C\d+ \|", user_text))
        request_sizes.append(candidate_count)
        if candidate_count > 2:
            raise urllib.error.HTTPError(
                request.full_url,
                400,
                "Bad Request",
                hdrs=None,
                fp=BytesIO(b'{"error":"prompt is too long for the available context"}'),
            )
        return _fake_response({
            "evaluated": [{
                "id": "C1",
                "overall": 8.5,
                "selected": True,
                "hook": "The complete explanation",
                "reason": "A clear explanation with a complete payoff.",
            }, {
                "id": "C2",
                "overall": 4.0,
                "selected": False,
                "hook": "A weaker point",
                "reason": "The explanation does not reach a useful payoff.",
            }]
        })

    monkeypatch.setattr(score_clips.urllib.request, "urlopen", fake_urlopen)
    selected = score_clips.ollama_select(
        {"words": words, "segments": [], "duration": 810},
        "qwen3:4b-instruct-2507-q4_K_M",
        "http://127.0.0.1:11434",
        min_score=5.5,
        max_clips=3,
        min_len=60,
        max_len=180,
    )

    assert request_sizes == [4, 2, 4, 2]
    assert len(selected) == 2
    assert all(item["signals"]["ai_score"] == 8.5 for item in selected)


def test_ai_selector_reviews_a_second_timeline_batch_after_zero_selections(monkeypatch, capsys):
    groups = [
        _group(f"Story section {index} explains an important complete point.", index * 10, index * 10 + 9)
        for index in range(81)
    ]
    words = [word for group in groups for word in group["words"]]
    candidates = [
        _candidate(index * 90, index * 90 + 70, score=6.2 + index / 10)
        for index in range(8)
    ]
    monkeypatch.setattr(score_clips, "_build_ai_discovery_candidates",
                        lambda *args, **kwargs: candidates)
    call_count = 0
    second_batch_start = None

    def fake_urlopen(request, timeout):
        nonlocal call_count, second_batch_start
        call_count += 1
        payload = json.loads(request.data.decode("utf-8"))
        user_text = payload["messages"][1]["content"]
        match = re.search(r"(?m)^C1 \| ([0-9.]+)-", user_text)
        assert match
        if call_count == 1:
            return _fake_response({
                "evaluated": [{
                    "id": f"C{index}",
                    "overall": 4.0,
                    "selected": False,
                    "hook": "Weak moment",
                    "reason": "No clear standalone payoff.",
                } for index in range(1, 5)]
            })
        second_batch_start = float(match.group(1))
        return _fake_response({
            "evaluated": [{
                "id": "C1",
                "overall": 8.6,
                "selected": True,
                "hook": "The turning point",
                "reason": "A distinct moment with a complete explanation.",
            }, {
                "id": "C2",
                "overall": 4.2,
                "selected": False,
                "hook": "A weaker moment",
                "reason": "The point repeats earlier material.",
            }, {
                "id": "C3",
                "overall": 4.0,
                "selected": False,
                "hook": "Another weak moment",
                "reason": "The payoff is incomplete.",
            }, {
                "id": "C4",
                "overall": 4.1,
                "selected": False,
                "hook": "A final weak moment",
                "reason": "It lacks a clear takeaway.",
            }]
        })

    monkeypatch.setattr(score_clips.urllib.request, "urlopen", fake_urlopen)
    selected = score_clips.ollama_select(
        {"words": words, "segments": [], "duration": 810},
        "qwen3:4b-instruct-2507-q4_K_M",
        "http://127.0.0.1:11434",
        min_score=5.5,
        max_clips=3,
        min_len=60,
        max_len=180,
    )

    output = capsys.readouterr().out
    assert call_count == 2
    assert second_batch_start is not None
    assert len(selected) == 1
    assert selected[0]["start"] == second_batch_start
    assert "REJECTED BY AI" in output
    assert "model=8.6" in output
    assert "2 request(s)" in output


def test_ollama_http_400_reports_the_response_body_and_returns_none(monkeypatch, capsys):
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


def test_strict_llm_mode_does_not_silently_fall_back_to_heuristics(tmp_path, monkeypatch):
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
    monkeypatch.setattr(score_clips, "ollama_select", lambda *args, **kwargs: None)

    with pytest.raises(SystemExit, match="Required AI clip selector"):
        score_clips.run(
            tmp_path,
            llm="qwen3:4b-instruct-2507-q4_K_M",
            max_clips=3,
            min_len=5,
            max_len=40,
            min_score=0,
            strict_llm=True,
        )
