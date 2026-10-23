"""Add Builder to an existing WANX process without creating another local box."""
from __future__ import annotations

import argparse
from contextlib import asynccontextmanager
import os
from pathlib import Path
import runpy
import sys

from .wanx import mount_wanx


def attach_factory(factory, home: Path, project_root: Path):
    home, project_root = home.resolve(strict=True), project_root.resolve(strict=True)

    def build(server):
        if server.paths.root.resolve() != home:
            raise RuntimeError('WANX_HOME_MISMATCH')
        if server.services is None:
            raise RuntimeError('EXISTING_WANX_SETUP_REQUIRED')
        app = factory(server)
        if getattr(app.state, 'app_studio', None) is not None:
            # WANX 1.0 registers and closes this component through its own lifecycle.
            return app
        previous_routes = list(app.router.routes)
        service = mount_wanx(app, server, project_root)
        # The existing dashboard has a catch-all GET route; keep the new API reachable.
        app.router.routes[:] = app.router.routes[len(previous_routes):] + previous_routes
        previous = app.router.lifespan_context

        @asynccontextmanager
        async def lifespan(application):
            try:
                async with previous(application) as state:
                    yield state
            finally:
                await service.close()

        app.router.lifespan_context = lifespan
        return app

    return build


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', required=True)
    parser.add_argument('--project-root', required=True)
    parser.add_argument('wanx_args', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.wanx_args
    if command[:1] == ['--']:
        command = command[1:]
    if command[:1] != ['run'] or '--reload' in command or '--workers' in command:
        parser.error('Only the existing single-process WANX run command is supported')
    home = Path(args.home).resolve(strict=True)
    if not (home / 'octop.db').is_file():
        parser.error('An existing local WANX database is required')
    os.environ['OCTOP_HOME'] = str(home)
    import octop.api.app as api
    api.build_app = attach_factory(api.build_app, home, Path(args.project_root))
    sys.argv = ['octop', *command]
    runpy.run_module('octop', run_name='__main__')


if __name__ == '__main__':
    main()
