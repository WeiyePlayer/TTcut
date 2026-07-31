from __future__ import annotations

import pytest

from ttcut_worker.errors import VideoError
from ttcut_worker.video import _validate_decode_completion


def test_materially_truncated_decode_is_not_reported_as_a_valid_short_video() -> None:
    with pytest.raises(VideoError, match=r"21 of 18624 frames") as error:
        _validate_decode_completion(21, 18_624)

    assert error.value.code == "VIDEO_UNREADABLE"


@pytest.mark.parametrize(
    ("decoded_frame_count", "metadata_frame_count"),
    [(90, 100), (100, 100), (3, None)],
)
def test_complete_or_unknown_length_decode_is_accepted(
    decoded_frame_count: int,
    metadata_frame_count: int | None,
) -> None:
    _validate_decode_completion(decoded_frame_count, metadata_frame_count)
