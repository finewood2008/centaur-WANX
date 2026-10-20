import pytest
from wanx_clipboard.app import create_app


@pytest.mark.parametrize(
    "target",
    [
        "http://user:secret@localhost",
        "http://localhost/path",
        "http://localhost?url=evil",
        "file:///tmp/root",
    ],
)
def test_service_never_accepts_upstream_credentials_or_caller_selected_paths(tmp_path, target):
    with pytest.raises(ValueError):
        create_app(tmp_path / "metadata", target)
