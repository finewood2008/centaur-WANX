"""Read the final structured result without treating tool narration as JSON."""

from __future__ import annotations

from octop.infra.loops.models import RoundDecision


def parse_round_decision(text: str) -> RoundDecision:
    text = text.strip()
    if text.endswith("```"):
        blocks = text.rsplit("```", 2)
        if len(blocks) == 3:
            text = blocks[1].strip()
            language, newline, content = text.partition("\n")
            if language.lower() == "json" and newline:
                text = content.strip()
    # Only unwrap a terminal fenced result. Never salvage an inner object from
    # malformed JSON or accept a result followed by a model failure.
    return RoundDecision.model_validate_json(text)
