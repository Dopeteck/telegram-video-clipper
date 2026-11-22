from score_clips import build_candidates, is_arc_complete, sentenceize


def test_cjk_sentence_terminators_are_complete():
    for text in ("これは文です。", "本当です！", "そうですか？", "完了です。」"):
        assert is_arc_complete(text)


def test_sentenceize_splits_on_japanese_full_stop():
    words = [
        {"word": "第一文。", "start": 0.0, "end": 1.0},
        {"word": "第二文。", "start": 1.5, "end": 2.5},
    ]

    sentences = sentenceize(words)

    assert len(sentences) == 2
    assert all(is_arc_complete(sentence["text"]) for sentence in sentences)


def test_candidate_builder_can_select_multiple_cjk_clips():
    # Thirty short Japanese sentences spread across the source. With CJK
    # punctuation recognized, the complete-thought rule can form several
    # independent windows instead of rejecting every window after the first.
    words = [
        {"word": f"文{i}。", "start": float(i * 7), "end": float(i * 7 + 1)}
        for i in range(30)
    ]
    sentences = sentenceize(words)

    candidates = build_candidates(
        sentences,
        min_len=20,
        max_len=30,
        max_clips=3,
    )

    assert len(candidates) == 3
    assert all(candidate["end"] - candidate["start"] >= 20 for candidate in candidates)
