"""Fixed-size, overlapping character chunking for knowledge documents."""

from __future__ import annotations


def chunk_text(text: str, *, size: int = 800, overlap: int = 120) -> list[str]:
    """Split non-empty text into stable overlapping character windows."""
    return [part for _, _, part in chunk_text_with_offsets(text, size=size, overlap=overlap)]


def chunk_text_with_offsets(
    text: str, *, size: int = 800, overlap: int = 120
) -> list[tuple[int, int, str]]:
    """Return ranges in the canonical stripped text, using Unicode characters."""
    if size <= 0:
        raise ValueError("size must be positive")
    if overlap < 0 or overlap >= size:
        raise ValueError("overlap must be non-negative and smaller than size")
    content = text.strip()
    if not content:
        return []
    step = size - overlap
    chunks: list[tuple[int, int, str]] = []
    for start in range(0, len(content), step):
        end = min(start + size, len(content))
        chunks.append((start, end, content[start:end]))
        if start + size >= len(content):
            break
    return chunks
