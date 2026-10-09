"""Compile a closed meeting's recorded findings and owner ruling into a report."""

from datetime import UTC, datetime
from io import BytesIO
from zoneinfo import ZoneInfo

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

from octop.i18n import tr
from octop.infra.agents.teams.brainstorm_types import BrainstormSession, MeetingReport
from octop.infra.utils.doc_edit import get_doc_converter


def compile_report(
    state: BrainstormSession,
    *,
    owner: str,
    locale: str,
    timezone: str,
    excerpts: list[tuple[str, str]],
) -> MeetingReport:
    generated = datetime.now(UTC)
    draft = state.report_draft
    lines = [
        "# " + tr("brainstorm.report.title", locale),
        state.title,
        tr(
            "brainstorm.report.metadata",
            locale,
            owner=owner,
            time=generated.astimezone(ZoneInfo(timezone)).strftime("%Y-%m-%d %H:%M"),
            timezone=timezone,
        ),
        tr("brainstorm.report.adopted" if state.ruling else "brainstorm.report.unresolved", locale),
    ]

    def section(key: str, paragraphs: list[str]) -> None:
        lines.extend(["", "## " + tr(f"brainstorm.report.{key}", locale), "", *paragraphs])

    section("ruling", [state.ruling or tr("brainstorm.report.no_ruling", locale)])
    section(
        "scope",
        [state.goal or state.title, state.agenda, *["- " + c for c in state.constraints]],
    )
    section(
        "overview",
        [
            (draft.overview if draft else "")
            or state.brief
            or state.summary
            or tr("brainstorm.report.no_findings", locale)
        ],
    )
    points = draft.key_points if draft and draft.key_points else state.ideas
    section(
        "key_points", ["- " + p for p in points] or [tr("brainstorm.report.not_recorded", locale)]
    )
    section(
        "disagreements",
        ["- " + p for p in draft.disagreements]
        if draft and draft.disagreements
        else [tr("brainstorm.report.no_disagreements", locale)],
    )
    actions = [tr("brainstorm.report.actions_note", locale)]
    if draft and draft.actions:
        for action in draft.actions:
            actions.append(
                "- "
                + tr(
                    "brainstorm.report.action",
                    locale,
                    task=action.task,
                    owner=action.owner or tr("brainstorm.report.to_confirm", locale),
                    timing=action.timing or tr("brainstorm.report.to_confirm", locale),
                )
            )
    else:
        actions.extend(["- " + d for d in state.directions])
        if not state.directions:
            actions.append(tr("brainstorm.report.not_recorded", locale))
    section("actions", actions)
    questions = list(dict.fromkeys([*(draft.open_questions if draft else []), *state.questions]))
    section(
        "open_questions",
        ["- " + q for q in questions] or [tr("brainstorm.report.not_recorded", locale)],
    )
    section(
        "judgments",
        [f"{j.question}\n\n{j.answer}\n" for j in state.judgments]
        or [tr("brainstorm.report.not_recorded", locale)],
    )
    section(
        "participants",
        [
            ", ".join(
                [owner, tr("brainstorm.host_name", locale), *[m.name for m in state.participants]]
            )
        ],
    )
    section(
        "sources",
        [
            f"- {s.title} ({s.id}) {s.version} {s.provenance}"
            for s in state.context.sources
            if s.id not in state.excluded_source_ids and state.context_enabled
        ]
        or [tr("brainstorm.report.no_sources", locale)],
    )
    if excerpts:
        section("excerpts", [f"### {name}\n\n{text}\n" for name, text in excerpts])
    return MeetingReport(
        thread_id=state.thread_id,
        title=state.title,
        generated_at=generated,
        outcome="adopted" if state.ruling else "unresolved",
        markdown="\n\n".join(line for line in lines if line),
    )


def report_document(report: MeetingReport) -> bytes:
    """Use WANX's existing DOCX converter, with a readable report style."""
    converter = get_doc_converter("report.docx")
    assert converter is not None
    document = Document(BytesIO(converter.from_markdown(report.markdown)))
    page = document.sections[0]
    page.page_width, page.page_height = Inches(8.5), Inches(11)
    page.top_margin = page.bottom_margin = Inches(0.8)
    page.left_margin = page.right_margin = Inches(0.9)
    for name, size in [
        ("Normal", 11),
        ("Title", 22),
        ("Heading 1", 16),
        ("Heading 2", 14),
        ("Heading 3", 12),
    ]:
        style = document.styles[name]
        style.font.name = "Arial"
        style.font.size = Pt(size)
        style.font.color.rgb = RGBColor(0, 0, 0)
        fonts = style.element.get_or_add_rPr().get_or_add_rFonts()
        for attribute in ("asciiTheme", "eastAsiaTheme", "hAnsiTheme", "cstheme"):
            fonts.attrib.pop(qn("w:" + attribute), None)
        fonts.set(qn("w:eastAsia"), "Songti SC")
        style.paragraph_format.space_after = Pt(8)
        style.paragraph_format.line_spacing = 1.3
    document.paragraphs[0].style = document.styles["Title"]
    title_properties = document.styles["Title"].element.get_or_add_pPr()
    border = title_properties.find(qn("w:pBdr"))
    if border is not None:
        title_properties.remove(border)
    document.core_properties.title = report.title
    document.core_properties.subject = "Super Advisory meeting report"
    buffer = BytesIO()
    document.save(buffer)
    return buffer.getvalue()
