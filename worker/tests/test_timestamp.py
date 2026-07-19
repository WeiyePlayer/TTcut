from ttcut_worker.timestamp import TimestampResolver


def test_repeated_decoder_timestamp_falls_back_to_fps():
    resolver = TimestampResolver(50)
    assert resolver.resolve(0, 0).source == "decoder"
    repaired = resolver.resolve(1, 0)
    assert repaired.source == "fps_estimation"
    assert repaired.seconds == 0.02

