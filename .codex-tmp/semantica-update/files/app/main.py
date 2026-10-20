"""FastAPI application entry point."""
from __future__ import annotations

from contextlib import asynccontextmanager
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import tempfile
import time
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app import __phase__, __version__
from app.access_logging import install_health_access_filter, successful_health_probe
from app.api.routes import router
from app.api.integration import router as integration_router
from app.api.warehouses import router as warehouse_router, public_router
from app.api.skills import router as skills_router
from app.api.reasoning import router as reasoning_router
from app.integration.auth import ManagedAuthMiddleware
from app.integration.uploads import StagedUploads
from app.config import PROJECT_ROOT, get_settings
from app.db import JobRepository
from app.instance_lock import ApplicationInstanceLock
from app.startup_upgrade import initialize_with_backup
from app.services.documents import DocumentService
from app.services.knowledge import KnowledgeService
from app.services.llm_config import LLMConfigService
from app.services.managed_readiness import ManagedProcessingReadiness
from app.services.search import SearchService
from app.services.sensitive import SensitiveService
from app.services.warehouses import WarehouseService, WarehouseError
from app.services.processing_models import ProcessingModels
from app.api.processing import router as processing_router
from app.services.warehouse_transfers import WarehouseTransfers
from app.services.skills import SkillService
from app.services.reasoning import ReasoningService
from app.services.reasoning_preparations import PreparationService
from app.workers.documents import DocumentWorker
from app.workers.skill_resources import SkillResourceMaintenance


def _configure_file_logging(settings):
    settings.log_dir.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(
        settings.log_dir / "semantica.log",
        maxBytes=settings.log_max_bytes,
        backupCount=settings.log_backup_count,
        encoding="utf-8",
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger = logging.getLogger(f"semantica.access.{hash(str(settings.log_dir))}")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    logger.addHandler(handler)
    return logger, handler


def create_app(
    *,
    database_path: Path | None = None,
    data_dir: Path | None = None,
    start_worker: bool = True,
    automatic_pipeline: bool | None = None,
) -> FastAPI:
    project_temp = (PROJECT_ROOT / ".tmp").resolve()
    project_temp.mkdir(parents=True, exist_ok=True)
    tempfile.tempdir = str(project_temp)
    configured = get_settings()
    if database_path is not None or data_dir is not None:
        runtime_data = (data_dir or Path(database_path).parent).resolve()
        runtime_database = (database_path or runtime_data / "app.sqlite3").resolve()
        settings = configured.model_copy(
            update={
                "data_dir": runtime_data,
                "sqlite_path": runtime_database,
                "qdrant_path": runtime_data / "qdrant",
                "originals_dir": runtime_data / "originals",
                "derived_dir": runtime_data / "derived",
                "previews_dir": runtime_data / "previews",
                "log_dir": runtime_data / "logs",
            }
        )
    else:
        settings = configured.model_copy(deep=True)
    use_automatic_pipeline = (
        settings.knowledge_auto_pipeline
        if automatic_pipeline is None
        and database_path is None
        and data_dir is None
        else bool(automatic_pipeline)
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        install_health_access_filter()
        with ApplicationInstanceLock(settings.data_dir / "app.lock") as instance_lock:
            jobs = JobRepository(
                settings.sqlite_path,
                job_history_retention_days=settings.job_history_retention_days,
            )
            initialize_with_backup(settings, jobs, instance_lock=instance_lock)
            llm_config = LLMConfigService(settings)
            access_logger, log_handler = _configure_file_logging(settings)
            documents = DocumentService(jobs, settings)
            knowledge = KnowledgeService(
                jobs, settings, automatic_pipeline=use_automatic_pipeline
            )
            search = SearchService(jobs, settings, knowledge)
            knowledge.document_purger = lambda document_id, job_id: documents.purge_deleted_document(
                document_id, job_id, search.vector
            )
            sensitive = SensitiveService(jobs, settings, search)
            worker = DocumentWorker(jobs, documents, knowledge, search, sensitive)
            app.state.settings = settings
            app.state.llm_config = llm_config
            app.state.jobs = jobs
            app.state.skills = SkillService(jobs, settings)
            preparations = PreparationService(ReasoningService(app.state.skills),
                retention_days=settings.reasoning_preparation_retention_days)
            skill_maintenance = SkillResourceMaintenance(app.state.skills.resources,
                settings.reasoning_resource_cleanup_seconds, preparations)
            app.state.documents = documents
            app.state.integration_uploads = StagedUploads(documents)
            app.state.knowledge = knowledge
            app.state.search = search
            app.state.sensitive = sensitive
            app.state.worker = worker
            app.state.warehouses = WarehouseService(app.state)
            app.state.processing_models = ProcessingModels(app.state)
            knowledge.processing_models = app.state.processing_models
            sensitive.processing_models = app.state.processing_models
            app.state.warehouse_transfers = WarehouseTransfers(app.state)
            app.state.worker_enabled = start_worker
            app.state.automatic_pipeline = use_automatic_pipeline
            app.state.access_logger = access_logger
            if start_worker:
                app.state.warehouses.recover()
                worker.start()
                skill_maintenance.start()
            processing_readiness = ManagedProcessingReadiness(app.state)
            app.state.processing_readiness = processing_readiness
            processing_readiness.start()
            try:
                yield
            finally:
                app.state.warehouse_transfers.close()
                processing_readiness.stop()
                if start_worker:
                    skill_maintenance.stop()
                    worker.stop()
                search.close()
                knowledge.close()
                access_logger.removeHandler(log_handler)
                log_handler.close()

    app = FastAPI(title="星图 STARLINK", version=__version__, lifespan=lifespan)

    @app.exception_handler(WarehouseError)
    async def warehouse_error(_request, exc):
        return JSONResponse({"code": exc.code, "message": str(exc)}, status_code=exc.status,
                            headers={"Cache-Control": "no-store"})
    allowed_origins = {
        f"http://127.0.0.1:{settings.app_port}",
        f"http://localhost:{settings.app_port}",
        f"http://[::1]:{settings.app_port}",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
        "http://[::1]:5173",
    }
    allowed_hosts = ["127.0.0.1", "localhost", "[::1]", "testserver"]
    if settings.app_public_url:
        allowed_origins.add(settings.app_public_url)
        public_host = urlsplit(settings.app_public_url).hostname
        if public_host:
            allowed_hosts.append(f"[{public_host}]" if ":" in public_host else public_host)
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=allowed_hosts,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=sorted(allowed_origins),
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["Content-Type", "X-Skill-Admin-Token"],
    )

    @app.middleware("http")
    async def reject_cross_origin_writes(request: Request, call_next):
        started = time.perf_counter()
        origin = request.headers.get("origin")
        if (
            request.method in {"POST", "PUT", "PATCH", "DELETE"}
            and origin is not None
            and origin not in allowed_origins
        ):
            response = JSONResponse(
                status_code=403,
                content={"detail": "拒绝来自未授权网页来源的写操作"},
            )
        logger = getattr(request.app.state, "access_logger", None)
        try:
            if origin is None or request.method not in {"POST", "PUT", "PATCH", "DELETE"} or origin in allowed_origins:
                response = await call_next(request)
        except Exception as exc:
            if logger is not None:
                logger.error(
                    "method=%s path=%s error_type=%s elapsed_ms=%.1f",
                    request.method,
                    request.url.path,
                    type(exc).__name__,
                    (time.perf_counter() - started) * 1000,
                )
            raise
        if logger is not None and not successful_health_probe(request.method, request.url.path, response.status_code):
            logger.info(
                "method=%s path=%s status=%s elapsed_ms=%.1f",
                request.method,
                request.url.path,
                response.status_code,
                (time.perf_counter() - started) * 1000,
            )
        return response

    app.include_router(router)
    app.include_router(integration_router)
    app.include_router(warehouse_router)
    app.include_router(processing_router)
    app.include_router(public_router)
    app.include_router(skills_router)
    app.include_router(reasoning_router)
    from app.api.managed_reasoning import router as managed_reasoning_router, public_router as public_reasoning_router
    app.include_router(managed_reasoning_router)
    app.include_router(public_reasoning_router)
    app.add_middleware(ManagedAuthMiddleware, settings=settings, surface="workbench")
    frontend = PROJECT_ROOT / "frontend" / "dist"
    if frontend.is_dir():
        app.mount("/", StaticFiles(directory=frontend, html=True), name="frontend")
    else:
        @app.get("/", include_in_schema=False)
        def root():
            return JSONResponse(
                {
                    "name": "星图 STARLINK",
                    "phase": __phase__,
                    "api_docs": "/docs",
                }
            )
    return app
