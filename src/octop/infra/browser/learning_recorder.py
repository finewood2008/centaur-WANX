"""Adapt the shared recorder to cleanly detach after a demonstration."""

from __future__ import annotations

import contextlib
import json
from typing import Any


def make_recorder(client: Any, store: Any, manifest: Any, target_id: str) -> Any:
    from octop_browser.record.recorder import RecordSession

    class LearningRecorder(RecordSession):
        script_ids: list[str]

        async def _install_on_client(self, client: Any, target_id: str) -> None:
            self.script_ids = []
            for domain in ("Runtime", "Page", "DOM"):
                await client.enable_domain(domain)
            await client.send("Runtime.addBinding", {"name": self.binding_name})
            source = self._recorder_source(target_id)
            # Keep the upstream event/target extraction, but track listeners so
            # repeated learning leaves neither stale handlers nor a red badge.
            # CDP reports same-document navigation; don't patch page history.
            if "  patchHistory();" not in source:
                raise RuntimeError("Unsupported browser recorder version")
            source = source.replace(
                "const inputTimers = new WeakMap();",
                "const inputTimers = new Map(); const editedFields = new Set();",
            )
            # Read the whole editable document, preserving paragraphs. Upstream
            # text() collapses whitespace and truncates values at 300 characters.
            source = source.replace(
                'text(el.textContent || "")', 'String(el.innerText ?? el.textContent ?? "")'
            )
            source = source.replace(
                "const name = accessibleName(el);",
                """const name = el.isContentEditable
                  ? text(el.getAttribute('aria-label') || labelledBy(el) || labelOf(el)
                    || el.getAttribute('data-placeholder') || el.getAttribute('placeholder')
                    || el.id || '编辑内容') : accessibleName(el);""",
            )
            source = source.replace(
                'text: text(el.innerText || el.textContent || "", 500),',
                'text: el.isContentEditable ? "" : text(el.innerText || el.textContent || "", 500),',
            )
            source = source.replace(
                "  function onClick(event) {",
                """  function editableRoot(node) {
                  let el = node?.nodeType === 1 ? node : node?.parentElement;
                  if (el?.isContentEditable)
                    while (el.parentElement?.isContentEditable) el = el.parentElement;
                  return el;
                }
                function flushEditedFields() {
                  for (const timer of inputTimers.values()) clearTimeout(timer);
                  inputTimers.clear();
                  for (const el of editedFields) if (el.isConnected) flushInput(el);
                  editedFields.clear();
                }
                function onClick(event) {
                  flushEditedFields();""",
            )
            source = source.replace(
                "    const el = event.target;\n    const old = inputTimers.get(el);",
                "    const el = editableRoot(event.target);\n    editedFields.add(el);\n    const old = inputTimers.get(el);",
            )
            source = source.replace(
                "    const v = readValue(el);",
                "    el = editableRoot(el);\n    if (!el || !visible(el, el.getBoundingClientRect())) return;\n    const v = readValue(el);",
            )
            source = source.replace(
                '    flushInput(event.target, "change");',
                '    editedFields.add(editableRoot(event.target));\n    flushInput(event.target, "change");',
            )
            source = source.replace(
                'setTimeout(() => flushInput(el, "input"), 300)',
                'setTimeout(() => { inputTimers.delete(el); flushInput(el, "input"); }, 300)',
            )
            source = source.replace(
                "  patchHistory();",
                """
              globalThis.__wanx_learning_flush = () => {
                flushEditedFields();
              };
              globalThis.__wanx_learning_dispose = () => {
                for (const timer of inputTimers.values()) clearTimeout(timer);
                inputTimers.clear();
                editedFields.clear();
              };
            """,
            )
            source = """(() => {
              globalThis.__wanx_learning_cleanup?.();
              const removers = [], originals = [];
              for (const object of [document, globalThis]) {
                const previous = object.addEventListener;
                originals.push(() => { object.addEventListener = previous; });
                object.addEventListener = function(type, handler, options) {
                  removers.push(() => object.removeEventListener(type, handler, options));
                  return previous.call(this, type, handler, options);
                };
              }
              try { SOURCE } finally { originals.forEach(restore => restore()); }
              document.getElementById('__hbr_recording_overlay')?.remove();
              globalThis.__wanx_learning_cleanup = () => {
                globalThis.__wanx_learning_dispose?.();
                delete globalThis.__wanx_learning_flush;
                delete globalThis.__wanx_learning_dispose;
                delete globalThis.__HBR_RECORDER_CONFIG__;
                removers.forEach(remove => remove());
                document.getElementById('__hbr_recording_overlay')?.remove();
                delete globalThis.__hbrRecorderInstalled;
              };
            })();""".replace("SOURCE", source)
            result = await client.send("Page.addScriptToEvaluateOnNewDocument", {"source": source})
            self.script_ids.append(str(result["identifier"]))
            client.on("Runtime.bindingCalled", self._on_binding_called)
            await client.send("Runtime.evaluate", {"expression": source, "returnByValue": True})
            for event in ("Page.frameNavigated", "Page.navigatedWithinDocument"):
                client.on(
                    event,
                    lambda params, tid=target_id: self._on_frame_navigated(
                        params if "frame" in params else {"frame": params}, tid
                    ),
                )

        async def stop(
            self, *, generate_steps: bool = True, skill_name: str | None = None
        ) -> dict[str, Any]:
            with contextlib.suppress(Exception):
                await self.client.send(
                    "Runtime.evaluate", {"expression": "globalThis.__wanx_learning_flush?.()"}
                )
            return await super().stop(generate_steps=generate_steps, skill_name=skill_name)

        async def close(self) -> None:
            for script_id in getattr(self, "script_ids", []):
                with contextlib.suppress(Exception):
                    await self.client.send(
                        "Page.removeScriptToEvaluateOnNewDocument", {"identifier": script_id}
                    )
            with contextlib.suppress(Exception):
                await self.client.send(
                    "Runtime.evaluate",
                    {
                        "expression": "globalThis.__wanx_learning_cleanup?.(); delete globalThis.__wanx_learning_cleanup; "
                        f"delete globalThis[{json.dumps(self.binding_name)}];",
                        "returnByValue": True,
                    },
                )
                await self.client.send("Runtime.removeBinding", {"name": self.binding_name})
            await super().close()

    return LearningRecorder(client, store, manifest, initial_target_id=target_id)
