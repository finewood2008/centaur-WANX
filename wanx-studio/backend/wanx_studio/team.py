"""Company publication policy using WANX users and application deployment/access records.

No new HTTP contract: administrators stage deployment.configuration.studio_team,
then use the existing installed receipt to seal the accepted artifact. Enabling the
existing deployment makes that exact sealed version available to authorized users.
"""
from __future__ import annotations

import copy
import json
import re
import time

from .contracts import StudioError, digest


class TeamPublications:
    def __init__(self, studio, services, *, local_authority=None):
        self.studio, self.services = studio, services
        self.local_authority = local_authority
        with studio.store.lock:
            studio.store.db.execute('''CREATE TABLE IF NOT EXISTS team_publications(
                app TEXT PRIMARY KEY, owner TEXT NOT NULL, project TEXT NOT NULL,
                artifact TEXT NOT NULL, policy TEXT NOT NULL, payload TEXT NOT NULL, published REAL NOT NULL)''')

    def user(self, owner):
        if not re.fullmatch(r'wanx:[1-9][0-9]*', owner):
            raise StudioError('STUDIO_IDENTITY_FORBIDDEN', 403)
        if self.local_authority is not None:
            self.local_authority.identity(owner)
        row = self.services.user_repo.get(int(owner.split(':')[1]))
        if row is None or row.disabled:
            raise StudioError('STUDIO_IDENTITY_FORBIDDEN', 403)
        return row

    def is_admin(self, owner):
        user = self.user(owner)
        if self.local_authority is not None and self.local_authority.required():
            return self.local_authority.can_manage(owner)
        return user.role == 'admin'

    def seal(self, owner, project_id, payload):
        """Only an authenticated administrator receipt can seal executable bytes."""
        if not self.is_admin(owner):
            raise StudioError('STUDIO_ADMIN_REQUIRED', 403)
        if self.local_authority is not None:
            self.local_authority.application(owner, payload['applicationId'])
        product = self.services.application_repo.get(payload['applicationId'])
        deployment = self.services.application_repo.deployment(payload['applicationId'])
        policy = (deployment or {}).get('configuration', {}).get('studio_team')
        if policy is None:
            return  # Ordinary personal installation retains its previous behavior.
        expected = {'projectId':project_id, 'artifactHash':payload['artifactHash'], 'audience':policy.get('audience')}
        if (policy != expected or policy['audience'] not in {'all', 'selected'} or
                product is None or product.created_by != self.user(owner).id):
            raise StudioError('TEAM_PUBLICATION_INVALID', 409)
        with self.studio.store.lock:
            self.studio.store.db.execute('''INSERT INTO team_publications VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(app) DO UPDATE SET owner=excluded.owner,project=excluded.project,
                artifact=excluded.artifact,policy=excluded.policy,payload=excluded.payload,published=excluded.published''',
                (payload['applicationId'],owner,project_id,payload['artifactHash'],json.dumps(policy,sort_keys=True),json.dumps(payload,ensure_ascii=False),time.time()))

    def resolve(self, owner, *, app_id=None, project_id=None, artifact_hash=None):
        user = self.user(owner)
        with self.studio.store.lock:
            rows = self.studio.store.db.execute('SELECT * FROM team_publications WHERE app=?' if app_id else
                'SELECT * FROM team_publications WHERE project=?', (app_id or project_id,)).fetchall()
        for row in rows:
            if self.local_authority is not None:
                try:
                    self.local_authority.application(owner, row['app'])
                except StudioError:
                    continue
            if artifact_hash and row['artifact'] != artifact_hash:
                continue
            deployment = self.services.application_repo.deployment(row['app'])
            if not deployment or not deployment['enabled'] or deployment.get('configuration',{}).get('studio_team') != json.loads(row['policy']):
                continue
            payload=json.loads(row['payload'])
            sealed=json.loads(row['policy'])
            if payload['applicationId']!=row['app'] or payload['artifactHash']!=row['artifact'] or sealed['artifactHash']!=row['artifact'] or sealed['projectId']!=row['project']:
                continue
            access = self.services.application_repo.user_access(row['app'], user.id)
            policy = json.loads(row['policy'])
            # Explicit revocation overrides the administrator's all-members policy.
            if access is False or (policy['audience'] == 'selected' and access is not True and row['owner'] != owner):
                continue
            return {**dict(row), 'payload':json.loads(row['payload'])}
        raise StudioError('TEAM_APPLICATION_UNAVAILABLE', 404)

    def catalog(self, owner):
        self.user(owner)
        with self.studio.store.lock:
            ids = [r[0] for r in self.studio.store.db.execute('SELECT app FROM team_publications ORDER BY published DESC')]
        projects = []
        for app_id in ids:
            try:
                p = self.resolve(owner, app_id=app_id)
            except StudioError:
                continue
            projects.append(self.summary(p))
        return projects

    @staticmethod
    def summary(p):
        a = p['payload']
        # Published metadata only: never the author's private draft, chat,
        # selected materials, acceptance notes or identity.
        return {'id':p['project'], 'appId':p['app'], 'name':a['name'], 'goal':'',
            'stage':'installed', 'createdAt':p['published'], 'updatedAt':p['published'],
            'installed':{'artifactHash':a['artifactHash'],'version':a['version'],'createdAt':p['published']},
            'artifacts':[{'hash':a['artifactHash'],'version':a['version']}],
            'versions':[{'hash':a['artifactHash'],'version':a['version'],'status':'current'}],
            'versioning':{'adoptedHash':a['artifactHash']}, 'messages':[], 'events':[]}

    def payload(self, owner, project_id, artifact_hash):
        return copy.deepcopy(self.resolve(owner, project_id=project_id, artifact_hash=artifact_hash)['payload'])

    def assert_session(self, owner, session):
        row = self.resolve(owner, app_id=session['app'], artifact_hash=session['artifact'])
        if digest(row['payload']) != session['publicationDigest']:
            raise StudioError('TEAM_APPLICATION_UNAVAILABLE', 404)
