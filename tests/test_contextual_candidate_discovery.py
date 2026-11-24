"""Regression tests for context-aware candidate discovery."""
from score_clips import _is_contextual_continuation, build_candidates, sentenceize


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



def test_sentenceize_keeps_first_word_with_next_overlapping_segment():
    words = [
        {"word": "First.", "start": 0.0, "end": 0.35},
        {"word": "And", "start": 1.0, "end": 1.3},
        {"word": "we", "start": 1.35, "end": 1.65},
        {"word": "continued.", "start": 1.7, "end": 2.05},
    ]
    segments = [
        {"start": 0.0, "end": 1.15, "text": "First."},
        {"start": 1.0, "end": 2.1, "text": "And we continued."},
    ]

    groups = sentenceize(words, segments=segments)

    assert len(groups) == 2
    assert groups[1]["text"] == "And we continued."


def test_context_can_reconnect_to_topic_from_recent_sentence():
    groups = [
        _group(0, "The company changed its hiring policy for engineers."),
        _group(9, "That surprised almost everybody on the team."),
        _group(18, "The change affected experienced professionals."),
        _group(27, "Engineers had already built the product."),
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

    candidates = build_candidates(groups, min_len=60, max_len=120, max_clips=2, pool_size=16)
    assert len(candidates) > 2
    assert all(60 <= item["end"] - item["start"] <= 120 for item in candidates)



def test_unrelated_adjacent_sentence_does_not_connect():
    groups = [
        _group(0, "The company changed its hiring policy."),
        _group(9, "The weather was beautiful over the weekend."),
    ]
    assert not _is_contextual_continuation(groups, 0, 1)
