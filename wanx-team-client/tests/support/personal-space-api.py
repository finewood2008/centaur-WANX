"""Loopback-only fixture for the real client/HTTP transfer seam; never a deployment."""
import sys
from pathlib import Path
from types import SimpleNamespace

import uvicorn
from fastapi import FastAPI
from octop.api.deps import current_user, get_server
from octop.api.routers.personal_space import router
from octop.api.routers.space_links import router as links_router

app = FastAPI()
app.include_router(router, prefix="/api/personal-space")
app.include_router(links_router, prefix="/api/personal-space")
app.dependency_overrides[current_user] = lambda: SimpleNamespace(id=1, application_id="wanx")
app.dependency_overrides[get_server] = lambda: SimpleNamespace(paths=SimpleNamespace(root=Path(sys.argv[1])))
uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[2]), log_level="warning")
