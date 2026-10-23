"""Read the existing WANX model catalog inside a trusted WANX process.

No credentials are printed, returned over an API, copied into a new database,
written into task files, or inherited by DSH. The source DB is opened read-only.
"""
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
import sqlite3


class ReadOnlyPool:
    def __init__(self,path:Path):
        self.path=path.resolve(strict=True)

    @contextmanager
    def connect(self):
        connection=sqlite3.connect(self.path.as_uri()+'?mode=ro',uri=True)
        connection.row_factory=sqlite3.Row
        connection.execute('PRAGMA query_only=ON')
        try:
            yield connection
        finally:
            connection.close()


def catalog(path:Path):
    from octop.infra.db.repos.providers import ProviderRepo
    from octop.infra.db.repos.settings import SettingsRepo
    pool=ReadOnlyPool(path)
    return SimpleNamespace(provider_repo=ProviderRepo(pool),settings_repo=SettingsRepo(pool))
