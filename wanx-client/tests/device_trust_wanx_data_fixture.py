"""Actual native schema and private objects used only by the temporary HTTPS fixture."""
import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path

WORKSPACE = Path(__file__).resolve().parents[3]
for source in (WORKSPACE / "centuarai-wanx/src", WORKSPACE / "centuarai-wanx/services/super-clipboard"):
    sys.path.insert(0, str(source))

from deployment import local_trust_backup_crypto as wire  # noqa: E402
from deployment import local_trust_profiles as profiles  # noqa: E402
from deployment import local_trust_wanx_profile as profile  # noqa: E402
from wanx_clipboard.service import initialize  # noqa: E402

from octop.infra.db.migrate import run_migrations  # noqa: E402
from octop.infra.db.pool import SqlitePool  # noqa: E402
from octop.infra.db.repos.local_data_principals import LocalDataPrincipalRepo  # noqa: E402
from octop.infra.personal_space.local_scope import ClipboardSpace  # noqa: E402


class WanxData:
    def __init__(self, root, descriptor):
        self.paths = profile.WanxPaths(root / profiles.WANX_HOME.lstrip("/"), root / profiles.CLIPBOARD_ROOT.lstrip("/"))
        self.paths.octop_home.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.paths.clipboard_root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.pool = SqlitePool(self.paths.octop_home / "octop.db")
        run_migrations(self.pool)
        self.repo = LocalDataPrincipalRepo(self.pool)
        self.descriptor = descriptor

    def authorization(self, principal):
        return {"boxId": self.descriptor["boxId"], "boxKeyThumbprint": wire.digest(wire.canonical(self.descriptor["boxKey"])),
                "ownershipEpoch": 1, "principalId": principal}

    def ensure(self, principal):
        authorization = self.authorization(principal)
        namespace = profile.principal_namespace(authorization)
        uid = self.repo.resolve(namespace, authorization["boxKeyThumbprint"], 1, principal)
        space = ClipboardSpace(self.paths.octop_home / ".wanx-personal-space", uid, clipboard_scope={}, live=lambda: None)
        clip = self.paths.clipboard_root / hashlib.sha256(("centuarai.local-data.clipboard.v1:" + namespace).encode()).hexdigest()
        clip.mkdir(mode=0o700, exist_ok=True)
        with sqlite3.connect(clip / "clipboard.sqlite3") as db:
            db.row_factory = sqlite3.Row
            initialize(db)
        os.chmod(clip / "clipboard.sqlite3", 0o600)
        return space, profile.resolve_scope(self.paths, authorization)

    @staticmethod
    def add_file(space, identifier, content, parent=""):
        with sqlite3.connect(space.database) as db:
            db.execute("INSERT INTO entries(id,parent,name,kind,size,modified,digest) VALUES(?,?,?,'file',?,1,?)",
                       (identifier, parent, identifier + ".bin", len(content), hashlib.sha256(content).hexdigest()))
        target = space.objects / (identifier + ".blob")
        target.write_bytes(content)
        target.chmod(0o600)

    def seed(self, principal, *, other_only=False):
        space, scope = self.ensure(principal)
        other, _ = self.ensure("principal:fixture-other")
        self.add_file(other, "f" * 32, b"independent member private bytes")
        if not other_only:
            folder, item, note, image = (char * 32 for char in "acde")
            with sqlite3.connect(space.database) as db:
                db.execute("INSERT INTO entries(id,parent,name,kind,modified) VALUES(?,'','clipboard','folder',1)", (folder,))
                db.execute("INSERT INTO app_folders VALUES('wanx.clipboard',?)", (folder,))
                db.execute("INSERT INTO agent_links(id,token_hash,root,created) VALUES('synthetic-link','must-not-transfer',?,1)", (folder,))
            content = b"synthetic WANX personal document\x00\xff" * 42000
            self.add_file(space, "b" * 32, content)
            image_content = b"\x89PNG\r\nsynthetic image"
            self.add_file(space, item, b"clipboard text", folder)
            self.add_file(space, image, image_content, folder)
            note_content = json.dumps([{"type": "text", "text": "synthetic private note"}, {"type": "image", "item": image}], separators=(",", ":")).encode()
            self.add_file(space, note, note_content, folder)
            with sqlite3.connect(scope.databases[1]) as db:
                for identifier, kind, value in ((item, "text", b"clipboard text"), (image, "image", image_content)):
                    db.execute("INSERT INTO clipboard_items(id,batch,kind,name,original_name,mime,size,digest,device,created,state,offset) VALUES(?,'batch',?,'item','item','application/octet-stream',?,?,'fixture',1,'ready',?)",
                               (identifier, kind, len(value), hashlib.sha256(value).hexdigest(), len(value)))
                db.execute("UPDATE clipboard_meta SET revision=3")
                db.execute("UPDATE clipboard_note SET revision=1,current=?,updated=1", (json.dumps({"id": note, "size": len(note_content), "digest": hashlib.sha256(note_content).hexdigest()}),))
                db.execute("INSERT INTO clipboard_note_assets VALUES(?)", (image,))
                db.execute("INSERT INTO clipboard_batches VALUES('batch','must-not-transfer','[]')")
        return self.inspect(principal)

    def inspect(self, principal):
        space, scope = self.ensure(principal)
        other, _ = self.ensure("principal:fixture-other")
        with sqlite3.connect(space.database) as db:
            entries = {row[0]: row[1] for row in db.execute("SELECT id,digest FROM entries WHERE kind='file'")}
            links = db.execute("SELECT count(*) FROM agent_links").fetchone()[0]
        with sqlite3.connect(scope.databases[1]) as db:
            items = [row[0] for row in db.execute("SELECT id FROM clipboard_items ORDER BY id")]
            note = json.loads(db.execute("SELECT current FROM clipboard_note").fetchone()[0] or "null")
            batches = db.execute("SELECT count(*) FROM clipboard_batches").fetchone()[0]
        files = {identifier: hashlib.sha256((space.objects / (identifier + ".blob")).read_bytes()).hexdigest() for identifier in entries}
        other_file = other.objects / ("f" * 32 + ".blob")
        return {"type": "wanx-data", "namespace": profile.principal_namespace(self.authorization(principal)), "nativeUserId": scope.native_user_id, "files": files, "items": items, "note": note,
                "agentLinks": links, "replayBatches": batches, "otherSha256": hashlib.sha256(other_file.read_bytes()).hexdigest() if other_file.exists() else None}
