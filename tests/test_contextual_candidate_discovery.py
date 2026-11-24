"""Regression tests for context-aware candidate discovery."""
from score_clips import _is_contextual_continuation, build_candidates


def _group(start, text):
    words = text.split()
    return {
        "start": float(start),
        "end": float(start + 8),
        "text": text,
        "complete": True,
        "words": [
            {"word": word, "start": float(start + i * 0.5),
             "end": float(start + i * 0.5 + 0.3)}
            for i, word in enumerate(words)
        ],
    }


def test_context_can_reconnect_to_topic_from_recent_sentence():
    groups = [
        _group(0, "The company changed its hiring policy."),
        _group(9, "That surprised almost everybody on the team."),
        _group(18, "The hiring policy meant experienced engineers were rejected."),
        _group(27, "Those engineers had already built the product."),
    ]
    assert _is_contextual_continuation(groups, 2, 3)


def test_question_can_keep_its_immediate_answer():
    groups = [
        _group(0, "Why did you leave the company?"),
        _group(9, "Because the leadership ignored every warning."),
    ]
    assert _is_contextual_continuation(groups, 0, 1)


def test_candidate_builder_keeps_a_pool_larger_than_requested_clip_count():
    groups = []
    for index in range(36):
        start = float(index * 9)
        topic = "The business decision changed customer growth"
        groups.append(_group(start, f"{topic} number {index}."))

    candidates = build_candidates(groups, min_len=60, max_len=120, max_clips=2)
    assert len(candidates) > 2
    assert all(60 <= item["end"] - item["start"] <= 120 for item in candidates)
