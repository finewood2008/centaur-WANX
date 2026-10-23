"""Application settings with project-local path and secret boundaries."""
from __future__ import annotations

from functools import lru_cache
import json
from ipaddress import ip_address
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    """Load the project .env without inheriting settings from another project."""

    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8-sig",
        case_sensitive=False,
        extra="ignore",
        hide_input_in_errors=True,
    )

    app_host: str = "127.0.0.1"
    app_port: int = Field(default=8090, ge=1, le=65535)
    app_public_url: str = ""
    knowledge_auto_pipeline: bool = True
    # Enabled by default. Retain explicit false only for existing deployments.
    reasoning_skills_enabled: bool = True
    reasoning_skill_admin_token: SecretStr = SecretStr("")
    reasoning_resource_retention_hours: int = Field(default=24, ge=1, le=720)
    reasoning_resource_cleanup_seconds: int = Field(default=300, ge=30, le=3600)
    reasoning_bundle_max_chars: int = Field(default=48000, ge=1000, le=512000)
    reasoning_preparation_retention_days: int = Field(default=7, ge=1, le=90)
    mcp_enabled: bool = True
    mcp_host: str = Field(default="0.0.0.0", min_length=1, max_length=255)
    mcp_port: int = Field(default=8091, ge=1, le=65535)
    mcp_path: str = Field(default="/mcp", pattern=r"^/[A-Za-z0-9._~/-]*$")
    mcp_request_timeout_seconds: int = Field(default=180, ge=1, le=3600)
    mcp_elicitation_timeout_seconds: float = Field(default=15, ge=0, le=30, allow_inf_nan=False)
    integration_mode: Literal["standalone", "managed"] = "standalone"
    integration_service_token: SecretStr = SecretStr("")
    integration_application_tokens: SecretStr = SecretStr("")
    integration_box_id: str = ""
    integration_application_id: str = ""
    data_dir: Path = Path("data")
    sqlite_path: Path = Path("data/app.sqlite3")
    qdrant_path: Path = Path("data/qdrant")
    qdrant_collection: str = "semantica_chunks_v1"
    originals_dir: Path = Path("data/originals")
    derived_dir: Path = Path("data/derived")
    previews_dir: Path = Path("data/previews")
    log_dir: Path = Path("data/logs")
    backup_dir: Path = Path("backups")
    backup_hmac_key: SecretStr = SecretStr("")
    storage_min_free_bytes: int = Field(default=256 * 1024 * 1024, ge=16 * 1024 * 1024)
    temp_retention_hours: int = Field(default=24, ge=1, le=720)
    job_history_retention_days: int = Field(default=7, ge=1, le=365)
    job_auto_retry_enabled: bool = True
    job_auto_retry_delays_seconds: list[int] = Field(default_factory=lambda: [60, 300, 900], min_length=1, max_length=5)
    job_auto_retry_poll_seconds: int = Field(default=30, ge=5, le=300)

    @model_validator(mode="after")
    def validate_auto_retry_delays(self):
        if any(delay < 5 or delay > 86400 for delay in self.job_auto_retry_delays_seconds):
            raise ValueError("Auto retry delays must be between 5 and 86400 seconds")
        return self
    log_max_bytes: int = Field(default=10 * 1024 * 1024, ge=1024 * 1024)
    log_backup_count: int = Field(default=5, ge=1, le=50)
    document_max_bytes: int = Field(
        default=1024 * 1024 * 1024, ge=1024, le=1024 * 1024 * 1024
    )
    document_max_pdf_pages: int = Field(default=300, ge=1, le=5000)
    document_max_docx_expanded_bytes: int = Field(
        default=256 * 1024 * 1024, ge=1024, le=2 * 1024 * 1024 * 1024
    )
    document_max_image_pixels: int = Field(
        default=40_000_000, ge=1_000_000, le=200_000_000
    )
    ocr_render_dpi: int = Field(default=144, ge=72, le=300)
    ocr_min_confidence: float = Field(default=0.55, ge=0, le=1)
    ocr_pdf_text_min_chars: int = Field(default=12, ge=1, le=1000)

    llm_provider: Literal["openai_compatible", "ollama"] = "openai_compatible"
    llm_profile_path: Path = Path("config/llm_profiles.json")
    openai_base_url: str = ""
    openai_api_key: SecretStr = SecretStr("")
    openai_model: str = ""
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = ""
    ollama_embed_model: str = ""
    model_timeout_seconds: int = Field(default=180, gt=0)
    extraction_strategy: Literal["two_stage", "joint"] = "two_stage"
    knowledge_cross_page_batches: bool = True
    llm_concurrency: int = Field(default=1, ge=1, le=4)
    llm_context_tokens: int = Field(default=4096, ge=2048, le=131072)
    llm_extraction_input_tokens: int = Field(default=1024, ge=256, le=16000)
    llm_extraction_output_tokens: int = Field(default=768, ge=128, le=8192)
    llm_sensitive_input_tokens: int = Field(default=1536, ge=256, le=16000)
    llm_sensitive_output_tokens: int = Field(default=512, ge=128, le=8192)
    llm_sensitive_batch_size: int = Field(default=3, ge=1, le=8)
    openai_sensitive_batch_size: int = Field(default=8, ge=1, le=16)
    openai_sensitive_input_tokens: int = Field(default=4096, ge=256, le=16000)
    openai_sensitive_context_tokens: int = Field(default=16384, ge=2048, le=131072)
    ollama_keep_alive: str = Field(default="10m", pattern=r"^(?:0|[1-9][0-9]{0,4}[smh])$")
    ollama_think: Literal["auto", "off", "on"] = "off"
    openai_think: Literal["auto", "off", "on"] = "off"
    openai_thinking_format: Literal["auto", "thinking", "enable_thinking", "reasoning_effort"] = "auto"
    openai_structured_output: Literal["text", "json_object", "json_schema"] = "text"

    embedding_provider: Literal[
        "none", "openai_compatible", "ollama", "local"
    ] = "none"
    embedding_base_url: str = ""
    embedding_api_key: SecretStr = SecretStr("")
    embedding_model: str = ""
    embedding_local_path: Path = Path("models/embedding/bge-small-zh-v1.5")
    embedding_device: Literal["cpu", "cuda"] = "cpu"
    embedding_normalize: bool = True
    embedding_batch_size: int = Field(default=8, ge=1, le=256)
    embedding_query_instruction: str = "为这个句子生成表示以用于检索相关文章："
    embedding_chunk_target_tokens: int = Field(default=384, ge=64, le=4096)
    embedding_chunk_max_tokens: int = Field(default=480, ge=64, le=8192)
    embedding_chunk_overlap_tokens: int = Field(default=64, ge=0, le=1024)

    search_vector_min_score: float = Field(
        default=0.50, ge=0, le=1, allow_inf_nan=False
    )

    knowledge_chunk_target_chars: int = Field(default=1800, ge=256, le=12000)
    knowledge_chunk_max_chars: int = Field(default=2200, ge=256, le=16000)
    knowledge_chunk_overlap_chars: int = Field(default=250, ge=0, le=4000)

    ocr_provider: Literal["rapidocr"] = "rapidocr"
    ocr_model_dir: Path = Path("models/ocr/rapidocr")
    asr_provider: Literal["faster_whisper"] = "faster_whisper"
    asr_model_dir: Path = Path("models/asr/faster-whisper-small")
    asr_device: Literal["cpu", "cuda"] = "cpu"
    asr_compute_type: str = "int8"
    asr_language: str = Field(default="zh", pattern=r"^(auto|[a-z]{2,3})$")
    asr_beam_size: int = Field(default=5, ge=1, le=10)
    asr_vad_filter: bool = True
    asr_chunk_length_seconds: int = Field(default=30, ge=5, le=60)
    asr_max_duration_seconds: int = Field(default=7200, ge=1, le=86400)
    asr_timeout_seconds: int = Field(default=1800, ge=30, le=86400)
    asr_min_avg_logprob: float = Field(default=-1.0, ge=-10, le=0)
    asr_max_no_speech_probability: float = Field(default=0.6, ge=0, le=1)

    wanx_model_url: str = "http://127.0.0.1:18089"
    model_local_only: bool = True
    xingtu_local_only: bool = False
    model_cpu_threads: int = Field(default=2, ge=1, le=64)
    job_concurrency: int = Field(default=1, ge=1, le=1)

    neo4j_uri: str = ""
    neo4j_user: str = ""
    neo4j_password: SecretStr = SecretStr("")
    neo4j_database: str = "neo4j"
    neo4j_namespace: str = Field(default="", max_length=120, pattern=r"^[A-Za-z0-9_-]*$")

    def application_tokens(self) -> dict[str, str]:
        """Private application credentials; an empty map preserves single-app wire v1."""
        raw = self.integration_application_tokens.get_secret_value()
        if not raw:
            return {}
        def object_pairs(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("duplicate integration application")
                result[key] = value
            return result
        try:
            tokens = json.loads(raw, object_pairs_hook=object_pairs)
            if (not isinstance(tokens, dict) or not tokens
                    or set(tokens) - {"omnia", "zhijun"}
                    or any(not isinstance(token, str) or len(token) < 32
                           for token in tokens.values())
                    or len(set(tokens.values())) != len(tokens)
                    or tokens.get(self.integration_application_id)
                    != self.integration_service_token.get_secret_value()):
                raise ValueError("invalid integration application credentials")
            return tokens
        except (ValueError, TypeError):
            raise ValueError("invalid integration application credentials") from None

    @model_validator(mode="after")
    def resolve_local_paths(self) -> "Settings":
        self.app_host = self.app_host.strip()
        loopback = self.app_host == "localhost"
        if not loopback:
            try:
                loopback = ip_address(self.app_host).is_loopback
            except ValueError as exc:
                raise ValueError("app_host must be an IP address or localhost") from exc
        self.app_public_url = self.app_public_url.strip().rstrip("/")
        if self.app_public_url:
            public = urlsplit(self.app_public_url)
            if (public.scheme not in ("http", "https") or not public.hostname
                    or public.username or public.password or public.query or public.fragment or public.path):
                raise ValueError("app_public_url must be an HTTP(S) origin without credentials or a path")
            try:
                public.port
            except ValueError as exc:
                raise ValueError("app_public_url has an invalid port") from exc
        if not loopback and not self.app_public_url:
            raise ValueError("external app_host requires app_public_url")
        if self.integration_mode == "managed":
            self.application_tokens()
            if len(self.integration_service_token.get_secret_value()) < 32:
                raise ValueError("managed integration requires a service token of at least 32 characters")
            if not self.integration_box_id.strip() or not self.integration_application_id.strip():
                raise ValueError("managed integration requires box and application identities")
            try:
                mcp_loopback = self.mcp_host == "localhost" or ip_address(self.mcp_host).is_loopback
            except ValueError:
                mcp_loopback = False
            if not loopback or not mcp_loopback:
                raise ValueError("managed workbench and MCP must bind loopback")
        if self.xingtu_local_only:
            if self.llm_provider != "ollama" or not self._loopback_model_url(self.ollama_base_url):
                raise ValueError("星图本地模式需要本机 Ollama 服务")
            if not self.ollama_model or "cloud" in self.ollama_model.lower():
                raise ValueError("星图本地模式需要已安装的本地模型")
            if self.embedding_provider not in {"local", "ollama"}:
                raise ValueError("星图本地模式需要本地向量模型")
            if self.embedding_provider == "ollama" and (not self._loopback_model_url(self.embedding_base_url or self.ollama_base_url)
                    or "cloud" in self.embedding_model.lower()):
                raise ValueError("星图本地模式的向量模型必须运行在本机")
        if not (
            self.embedding_chunk_overlap_tokens < self.embedding_chunk_target_tokens
            <= self.embedding_chunk_max_tokens
        ):
            raise ValueError(
                "embedding chunk sizes must satisfy overlap < target <= max"
            )
        if not (
            self.knowledge_chunk_overlap_chars < self.knowledge_chunk_target_chars
            <= self.knowledge_chunk_max_chars
        ):
            raise ValueError(
                "knowledge chunk sizes must satisfy overlap < target <= max"
            )
        if max(self.llm_extraction_input_tokens + self.llm_extraction_output_tokens,
               self.llm_sensitive_input_tokens + self.llm_sensitive_output_tokens) + 1024 > self.llm_context_tokens:
            raise ValueError("LLM context must include input, output and at least 1024 prompt tokens")
        if self.openai_sensitive_input_tokens + self.llm_sensitive_output_tokens + 1024 > self.openai_sensitive_context_tokens:
            raise ValueError("External sensitive context must include input, output and at least 1024 prompt tokens")
        if self.mcp_enabled and self.mcp_port == self.app_port:
            raise ValueError("mcp_port must differ from app_port")
        if self.mcp_path != "/" and self.mcp_path.endswith("/"):
            self.mcp_path = self.mcp_path.rstrip("/")
        for field_name in (
            "data_dir",
            "sqlite_path",
            "qdrant_path",
            "originals_dir",
            "derived_dir",
            "previews_dir",
            "log_dir",
            "backup_dir",
            "llm_profile_path",
            "embedding_local_path",
            "ocr_model_dir",
            "asr_model_dir",
        ):
            value = Path(getattr(self, field_name))
            resolved = (PROJECT_ROOT / value).resolve() if not value.is_absolute() else value.resolve()
            if resolved.drive.casefold() == "c:":
                raise ValueError(f"{field_name} must not be stored on C:")
            if not resolved.is_relative_to(PROJECT_ROOT):
                raise ValueError(f"{field_name} must stay inside the project directory")
            setattr(self, field_name, resolved)
        if not self.sqlite_path.is_relative_to(self.data_dir):
            raise ValueError("sqlite_path must stay inside data_dir")
        if not self.qdrant_path.is_relative_to(self.data_dir) or self.qdrant_path == self.data_dir:
            raise ValueError("qdrant_path must be a subdirectory of data_dir")
        for field_name in ("originals_dir", "derived_dir", "previews_dir"):
            path = getattr(self, field_name)
            if not path.is_relative_to(self.data_dir) or path == self.data_dir:
                raise ValueError(f"{field_name} must be a subdirectory of data_dir")
        storage_directories = {
            "qdrant_path": self.qdrant_path,
            "originals_dir": self.originals_dir,
            "derived_dir": self.derived_dir,
            "previews_dir": self.previews_dir,
            "log_dir": self.log_dir,
        }
        for left_name, left in storage_directories.items():
            for right_name, right in storage_directories.items():
                if left_name < right_name and (
                    left == right or left.is_relative_to(right) or right.is_relative_to(left)
                ):
                    raise ValueError(f"{left_name} and {right_name} must not overlap")
        if any(self.sqlite_path.is_relative_to(path) for path in storage_directories.values()):
            raise ValueError("sqlite_path must not be inside another storage directory")
        if self.backup_dir == self.data_dir or self.backup_dir.is_relative_to(self.data_dir):
            raise ValueError("backup_dir must stay outside data_dir")
        model_root = (PROJECT_ROOT / "models").resolve()
        for field_name in ("embedding_local_path", "ocr_model_dir", "asr_model_dir"):
            if not getattr(self, field_name).is_relative_to(model_root):
                raise ValueError(f"{field_name} must stay inside models/")
        return self

    def model_api_config(self) -> dict[str, object]:
        """Return the legacy adapter shape without exposing secrets publicly."""
        return {
            "LLM_PROVIDER": self.llm_provider,
            "OPENAI_BASE_URL": self.openai_base_url,
            "OPENAI_API_KEY": self.openai_api_key.get_secret_value(),
            "OPENAI_MODEL": self.openai_model,
            "OLLAMA_BASE_URL": self.ollama_base_url,
            "OLLAMA_MODEL": self.ollama_model,
            "OLLAMA_EMBED_MODEL": self.ollama_embed_model,
            "EMBEDDING_PROVIDER": self.embedding_provider,
            "EMBEDDING_BASE_URL": self.embedding_base_url,
            "EMBEDDING_API_KEY": self.embedding_api_key.get_secret_value(),
            "EMBEDDING_MODEL": self.embedding_model,
            "MODEL_TIMEOUT_SECONDS": self.model_timeout_seconds,
            "LLM_CONCURRENCY": self.llm_concurrency,
            "LLM_CONTEXT_TOKENS": self.llm_context_tokens,
            "LLM_EXTRACTION_OUTPUT_TOKENS": self.llm_extraction_output_tokens,
            "LLM_SENSITIVE_OUTPUT_TOKENS": self.llm_sensitive_output_tokens,
            "OLLAMA_KEEP_ALIVE": self.ollama_keep_alive,
            "OLLAMA_THINK": self.ollama_think,
            "OPENAI_THINK": self.openai_think,
            "OPENAI_THINKING_FORMAT": self.openai_thinking_format,
            "OPENAI_STRUCTURED_OUTPUT": self.openai_structured_output,
        }

    def public_status(self) -> dict[str, object]:
        def configured(value: str) -> bool:
            cleaned = value.strip()
            return bool(cleaned and not cleaned.upper().startswith("REPLACE_"))

        llm_configured = (
            all(
                configured(value)
                for value in (
                    self.openai_base_url,
                    self.openai_api_key.get_secret_value(),
                    self.openai_model,
                )
            )
            if self.llm_provider == "openai_compatible"
            else all(configured(value) for value in (self.ollama_base_url, self.ollama_model))
        )
        if self.embedding_provider == "local":
            embedding_configured = self._local_model_status()["embedding"]
        elif self.embedding_provider == "openai_compatible":
            embedding_configured = all(
                configured(value)
                for value in (
                    self.embedding_base_url,
                    self.embedding_api_key.get_secret_value(),
                    self.embedding_model,
                )
            )
        elif self.embedding_provider == "ollama":
            embedding_configured = all(
                configured(value)
                for value in (self.ollama_base_url, self.ollama_embed_model)
            )
        else:
            embedding_configured = False
        return {
            "llm_provider": self.llm_provider,
            "local_processing_only": self.xingtu_local_only,
            "local_llm_model": self.ollama_model if self.xingtu_local_only else None,
            "llm_configured": llm_configured,
            "embedding_provider": self.embedding_provider,
            "embedding_configured": embedding_configured,
            "embedding_model": (
                self.embedding_local_path.name
                if self.embedding_provider == "local"
                else self.embedding_model
                if self.embedding_provider == "openai_compatible"
                else self.ollama_embed_model
                if self.embedding_provider == "ollama"
                else None
            ),
            "local_models": self._local_model_status(),
            "qdrant_mode": "local",
            "neo4j_configured": all(
                configured(value)
                for value in (
                    self.neo4j_uri,
                    self.neo4j_user,
                    self.neo4j_password.get_secret_value(),
                )
            ),
            "knowledge_auto_pipeline": self.knowledge_auto_pipeline,
            "job_history_retention_days": self.job_history_retention_days,
            "job_auto_retry_enabled": self.job_auto_retry_enabled,
            "job_auto_retry_delays_seconds": self.job_auto_retry_delays_seconds,
            "mcp_enabled": self.mcp_enabled,
            "mcp_host": self.mcp_host,
            "mcp_port": self.mcp_port,
            "mcp_path": self.mcp_path,
            "mcp_authentication": self.integration_mode == "managed",
            "integration_mode": self.integration_mode,
        }

    @staticmethod
    def _loopback_model_url(value: str) -> bool:
        parsed = urlsplit(value)
        try:
            local = parsed.hostname == "localhost" or ip_address(parsed.hostname or "").is_loopback
        except ValueError:
            local = False
        return bool(local and parsed.scheme == "http" and not parsed.username
                    and not parsed.password and not parsed.query and not parsed.fragment
                    and parsed.path in {"", "/"})

    def _local_model_status(self) -> dict[str, bool]:
        embedding_weights = (
            self.embedding_local_path / "model.safetensors"
        ).is_file() or (self.embedding_local_path / "pytorch_model.bin").is_file()
        return {
            "embedding": embedding_weights
            and (self.embedding_local_path / "config.json").is_file()
            and (self.embedding_local_path / "tokenizer.json").is_file(),
            "ocr": all(
                (self.ocr_model_dir / name).is_file()
                for name in (
                    "ch_PP-OCRv4_det_infer.onnx",
                    "ch_PP-OCRv4_rec_infer.onnx",
                    "ch_ppocr_mobile_v2.0_cls_infer.onnx",
                )
            ),
            "asr": all(
                (self.asr_model_dir / name).is_file()
                for name in (
                    "model.bin",
                    "config.json",
                    "tokenizer.json",
                    "vocabulary.txt",
                )
            ),
        }


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
