"""Include the shared Builder policy in both Python distributions."""

from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class FoundationPolicyHook(BuildHookInterface):
    def initialize(self, version, build_data):
        destination = "wanx_studio/wanx-foundation.json"
        policy = Path(self.root) / self.config["foundation-policy"]
        if not policy.is_file():
            # Source distributions already carry the canonical policy here.
            policy = Path(self.root) / destination
        if not policy.is_file():
            raise FileNotFoundError("The canonical WANX foundation policy is required")
        build_data["force_include"][str(policy)] = destination
