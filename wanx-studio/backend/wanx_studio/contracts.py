from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from .prd import ProductRequirement, prd_missing

CAPABILITIES = {"data", "model", "files", "knowledge", "reports"}
TEXT_EXTENSIONS = {".txt", ".md", ".csv", ".json"}


class StudioError(Exception):
    def __init__(self, code: str, status: int = 400):
        self.code, self.status = code, status
        super().__init__(code)


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def has_credentials(text: str) -> bool:
    return bool(re.search(r"\b(?:sk-|xg_|ghp_)[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9_.-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[\"']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)[\"']?\s*[=:]\s*[\"']?[A-Za-z0-9_.-]{16,}",text,re.I))


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Operation(Input):
    operationId: str = Field(min_length=16, max_length=80, pattern=r"^[A-Za-z0-9_-]+$")


class Dependency(Input):
    id: str
    requirement: str = Field(min_length=1, max_length=1000)
    reason: str = Field(min_length=1, max_length=1000)


class Solution(Input):
    audience: str = Field(default="", max_length=2000)
    workflow: str = Field(default="", max_length=8000)
    inputs: str = Field(default="", max_length=4000)
    outputs: str = Field(default="", max_length=4000)
    fields: list[str] = Field(default_factory=list)
    acceptance: list[str] = Field(default_factory=list)
    capabilities: list[Literal["data", "model", "files", "knowledge", "reports"]] = Field(default_factory=lambda: ["data", "model"])
    dependencies: list[Dependency] = Field(default_factory=list)
    prd: ProductRequirement | None = None


GAPS = [
    (r"公众号|微信.*发布|自动发布", "external-publishing", "外部平台发布", "首版尚无外部发布契约"),
    (r"定时|每天自动|周期执行|每周自动", "scheduling", "定时执行", "首版尚无后台调度契约"),
    (r"连接器|CRM同步|ERP|调用技能|调用专家", "connectors", "外部系统或工具调用", "首版仅提供模型、应用数据与选定文本资料"),
    (r"PDF|Word|Excel|OCR|扫描件", "document-parsing", "非文本资料解析", "首版只读取 UTF-8 文本、Markdown、CSV、JSON"),
]


def complete_dependencies(solution: dict, original: str, messages: list[dict]) -> dict:
    """Known unsupported intents stay visible even if a model omits them."""
    value = Solution.model_validate(solution).model_dump(exclude_none=True)
    text = original + "\n" + "\n".join(m["text"] for m in messages if m["role"] == "user")
    by_id = {d["id"]: d for d in value["dependencies"]}
    for pattern, dep_id, requirement, reason in GAPS:
        clauses=re.split(r"[，,。；;\n]",text)
        positive=any(re.search(pattern,clause,re.IGNORECASE) and not re.search(r"(?:不需要|无需|不要|不设|不引入|不用|不做|不支持).{0,40}(?:"+pattern+")",clause,re.IGNORECASE) for clause in clauses)
        if positive:
            by_id.setdefault(dep_id, {"id": dep_id, "requirement": requirement, "reason": reason})
    value["dependencies"] = list(by_id.values())
    # A historical interview incorrectly treated ordinary frontend styling as
    # an external capability. Keep genuine external requirements under that id.
    value['dependencies']=[d for d in value['dependencies'] if not (
        d['id']=='ui-theme' and re.search(r'配色|品牌色|布局|字体|视觉样式',d['requirement'])
        and not any(re.search(pattern,d['requirement'],re.IGNORECASE) for pattern,*_ in GAPS)
    )]
    return value


def readiness(solution: dict, decisions: dict) -> dict:
    missing = [key for key in ("audience", "workflow", "inputs", "outputs") if not solution[key].strip()]
    if not solution["acceptance"]:
        missing.append("acceptance")
    missing.extend(prd_missing(solution))
    gaps = [d for d in solution["dependencies"] if decisions.get(d["id"], {}).get("choice") not in {"manual", "defer"}]
    return {"ready": not missing and not gaps, "missing": missing, "gaps": gaps}


def check_manifest(value: dict) -> dict:
    allowed = {"schemaVersion", "name", "entry", "capabilities", "collections"}
    if set(value) - allowed or value.get("schemaVersion") != 1 or value.get("entry") != "src/app.js":
        raise StudioError("MANIFEST_INVALID")
    if not isinstance(value.get("name"), str) or not 1 <= len(value["name"]) <= 80:
        raise StudioError("MANIFEST_INVALID")
    caps = value.get("capabilities")
    if not isinstance(caps, list) or not set(caps) <= CAPABILITIES:
        raise StudioError("CAPABILITY_UNSUPPORTED")
    collections = value.get("collections", {})
    if not isinstance(collections, dict) or len(collections) > 20:
        raise StudioError("SCHEMA_INVALID")
    for key, fields in collections.items():
        if not re.fullmatch(r"[a-z][a-z0-9_-]{0,49}", key) or not isinstance(fields, dict) or not 1 <= len(fields) <= 50:
            raise StudioError("SCHEMA_INVALID")
        if any(not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_]{0,49}", f) or t not in {"string", "number", "boolean"} for f, t in fields.items()):
            raise StudioError("SCHEMA_INVALID")
    from .foundation import has_auth_storage
    if has_auth_storage(collections):raise StudioError("WANX_AUTH_REQUIRED",409)
    return value


def compatible(previous: dict | None, candidate: dict) -> bool:
    if not previous:
        return True
    return all(name in candidate["collections"] and all(candidate["collections"][name].get(k) == v for k, v in fields.items()) for name, fields in previous["collections"].items())
