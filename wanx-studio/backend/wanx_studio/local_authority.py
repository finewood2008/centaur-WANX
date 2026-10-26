"""Request and bounded background authority for the embedded team workbench."""

from __future__ import annotations

import asyncio
from contextvars import ContextVar, copy_context
from dataclasses import dataclass, replace
import logging

from .contracts import StudioError

logger = logging.getLogger(__name__)
_actor = ContextVar("wanx_studio_local_actor", default=None)


@dataclass(frozen=True)
class Actor:
    authority: object
    user: object
    context: object
    job: object = None


class Job:
    def __init__(self, lease, project_id, purpose):
        self.lease, self.project_id, self.purpose = lease, project_id, purpose
        self.tasks = set()
        self.watcher = None
        self.closing = False
        self.outcome = "completed"
        self.physical_close_uncertain = False


class LocalStudioAuthority:
    def __init__(self, services, required):
        self.services, self.required = services, required

    def enter(self, user):
        if not self.required():
            return _actor.set(None)
        from octop.infra.users.team_authority import team_context

        try:
            context = team_context(user)
        except Exception:
            raise StudioError("STUDIO_IDENTITY_FORBIDDEN", 403) from None
        return _actor.set(Actor(self, user, context))

    @staticmethod
    def reset(token):
        _actor.reset(token)

    def identity(self, owner):
        if not self.required():
            return None
        actor = _actor.get()
        if actor is None or actor.authority is not self or owner != "wanx:" + str(actor.user.id):
            raise StudioError("STUDIO_IDENTITY_FORBIDDEN", 403)
        try:
            actor.context.check_cached()
        except Exception:
            raise StudioError("STUDIO_AUTHORIZATION_EXPIRED", 403) from None
        return actor

    def can_manage(self, owner):
        actor = self.identity(owner)
        return (
            actor is not None
            and actor.context.claims["resourceId"] == "team:management"
            and "applications.manage" in actor.context.claims["team"]["permissions"]
        )

    def context(self, owner):
        actor = self.identity(owner)
        return actor.context if actor is not None else None

    async def resources(self, owner, grants):
        actor = self.identity(owner)
        if actor is None or not grants:
            return
        try:
            if actor.job is None:
                await actor.context.authorize_resources(grants)
            else:
                frozen = {
                    g["resourceId"]: set(g["actions"]) for g in actor.context.authorized_resources
                }
                if any(not set(g["actions"]) <= frozen.get(g["resourceId"], set()) for g in grants):
                    raise StudioError("STUDIO_RESOURCE_FORBIDDEN", 403)
                await actor.context.check()
        except StudioError:
            raise
        except Exception:
            raise StudioError("STUDIO_RESOURCE_FORBIDDEN", 403) from None

    async def prepare(self, service, owner, project_id):
        actor = self.identity(owner)
        if actor is None:
            return
        project = service.store.get(owner, project_id)
        preparation = project.get("preparation", {})
        resources = {}
        for ref in preparation.get("references", []):
            if ref["kind"] == "space":
                resource = "wanx"
            elif ref["kind"] == "xingtu" and ref["id"].startswith("team-"):
                resource = "team:knowledge:" + ref["id"][5:].split("__", 1)[0]
            elif ref["kind"] == "xingtu":
                resource = "semantica"
            else:
                raise StudioError("CONTEXT_KIND_INVALID")
            resources.setdefault(resource, set()).add("read")
        if preparation.get("launchConfiguration", {}).get("storage"):
            resources.setdefault("wanx", set()).update({"read", "write"})
        await self.resources(
            owner,
            [
                {"resourceId": key, "actions": sorted(actions)}
                for key, actions in sorted(resources.items())
            ],
        )

    def application(self, owner, application_id):
        actor = self.identity(owner)
        if actor is None:
            return
        team = actor.context.claims["team"]
        row = self.services.team_application_repo.get(application_id)
        if row is None or (row["box_id"], row["ownership_epoch"]) != (
            team["boxId"],
            team["ownershipEpoch"],
        ):
            raise StudioError("TEAM_APPLICATION_UNAVAILABLE", 404)
        resource = actor.context.claims["resourceId"]
        if resource != "team:application:" + application_id and not (
            resource == "team:management" and self.can_manage(owner)
        ):
            raise StudioError("TEAM_APPLICATION_UNAVAILABLE", 404)
        actor.context.check_cached()

    async def spawn(self, owner, project_id, task_id, purpose, factory):
        actor = self.identity(owner)
        if actor is None:
            return asyncio.create_task(factory())
        if not self.can_manage(owner):
            raise StudioError("STUDIO_ADMIN_REQUIRED", 403)
        if actor.job is not None:
            # A queued continuation or edit's build stays in the same logical
            # project operation. No new authority/lease or child hop is minted.
            job = actor.job
            allowed = {job.purpose} | ({"build"} if job.purpose == "edit" else set())
            if job.closing or job.project_id != project_id or purpose not in allowed:
                raise StudioError("STUDIO_TASK_SCOPE_DENIED", 403)
            job.lease.check_cached()
        else:
            lease = await actor.context.start_task(
                project_id=project_id, task_id=task_id, purpose=purpose
            )
            job = Job(lease, project_id, purpose)
        task_actor = replace(actor, context=job.lease, job=job)

        async def watch():
            try:
                while job.tasks:
                    await asyncio.sleep(0.25)
                    await job.lease.check()
            except asyncio.CancelledError:
                raise
            except Exception:
                job.outcome = "denied"
                for running in tuple(job.tasks):
                    running.cancel()

        async def finish(task):
            job.tasks.discard(task)
            if job.tasks or job.closing:
                return
            job.closing = True
            if job.watcher is not None:
                job.watcher.cancel()
                await asyncio.gather(job.watcher, return_exceptions=True)
            if job.physical_close_uncertain:
                logger.warning("Studio worker closure unconfirmed; retaining unknown operation")
                return
            try:
                await job.lease.closed(job.outcome)
            except Exception:
                logger.warning("Studio task closure acknowledgement unavailable")

        async def run():
            token = _actor.set(task_actor)
            try:
                job.lease.check_cached()
                return await factory()
            except asyncio.CancelledError:
                if job.outcome == "completed":
                    job.outcome = "cancelled"
                raise
            except BaseException:
                if job.outcome == "completed":
                    job.outcome = "outcome-unknown"
                raise
            finally:
                _actor.reset(token)
                # Every wrapped coroutine has finished its subprocess, stream
                # and shielded-thread cleanup before this report.
                await finish(asyncio.current_task())

        task = asyncio.create_task(run())
        job.tasks.add(task)

        def never_started(done):
            # Cancellation before the coroutine's first instruction skips its
            # finally block; no factory/effect started, but its lease must close.
            if done in job.tasks:
                if job.outcome == "completed":
                    job.outcome = "cancelled"
                asyncio.create_task(finish(done))

        task.add_done_callback(never_started)
        if job.watcher is None:
            job.watcher = asyncio.create_task(watch())
        return task


async def start_background(service, owner, project_id, task_id, purpose, factory):
    authority = getattr(service, "local_authority", None)
    if authority is None:
        return asyncio.create_task(factory())
    await authority.prepare(service, owner, project_id)
    return await authority.spawn(owner, project_id, task_id, purpose, factory)


async def to_thread(function, /, *args, **kwargs):
    """A cancelled native operation cannot report closure before its I/O drains."""
    actor = _actor.get()
    if actor is None:
        return await asyncio.to_thread(function, *args, **kwargs)

    def guarded():
        actor.context.require_live()
        result = function(*args, **kwargs)
        actor.context.require_live()
        return result

    # A separate asyncio Task would also be cancelled by loop teardown, marking
    # it done while its OS thread still runs. Keep the executor Future directly;
    # shielding then defers caller cancellation until the real thread returns.
    task = asyncio.get_running_loop().run_in_executor(None, copy_context().run, guarded)
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if task.cancelled():
            physical_close_uncertain()
        else:
            task.exception()
        raise


def requires_physical_close():
    return _actor.get() is not None


def physical_close_uncertain():
    actor = _actor.get()
    if actor is not None:
        actor.context.mark_physical_close_uncertain()
        if actor.job is not None:
            actor.job.physical_close_uncertain = True
