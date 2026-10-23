"""Two real processes: unchanged core router and independent business edge. Test only."""

import signal
import json
import socket
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import uvicorn
from fastapi import FastAPI, Request

from octop.api.deps import current_user, get_server
from octop.api.routers.personal_space import router
from octop.api.routers.space_links import router as links_router

root, port = Path(sys.argv[1]), int(sys.argv[2])
if "--core" in sys.argv:
    app = FastAPI()
    app.include_router(router, prefix="/api/personal-space")
    app.include_router(links_router, prefix="/api/personal-space")
    app.dependency_overrides[current_user] = lambda: SimpleNamespace(id=1, application_id="wanx")
    app.dependency_overrides[get_server] = lambda: SimpleNamespace(paths=SimpleNamespace(root=root))

    @app.get("/api/auth/me")
    def me():
        return {"id": 1}

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)
else:
    sys.path.insert(0, str(Path(__file__).parents[3] / "services/super-clipboard"))
    from wanx_clipboard.app import create_app

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        core_port = s.getsockname()[1]
    core = subprocess.Popen(
        [sys.executable, __file__, str(root / "core"), str(core_port), "--core"]
    )
    root.mkdir(parents=True, exist_ok=True)
    (root / "core-port.json").write_text(json.dumps({"port": core_port}))
    try:
        server = uvicorn.Server(
            uvicorn.Config(
                create_app(root / "business", f"http://127.0.0.1:{core_port}"),
                host="127.0.0.1",
                port=port,
                log_level="warning",
                access_log=False,
            )
        )
        signal.signal(signal.SIGTERM, lambda *args: setattr(server, "should_exit", True))
        server.run()
    finally:
        core.terminate()
        core.wait(10)
