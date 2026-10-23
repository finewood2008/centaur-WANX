"""Capture unittest output without PowerShell treating stderr logs as failures."""
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import sys
import unittest

root = Path('D:/项目文件/semantica').resolve()
sys.path.insert(0, str(root))
modules = [
    'tests.test_standalone_integration', 'tests.test_managed_integration',
    'tests.test_managed_processing_readiness', 'tests.test_config',
    'tests.test_xingtu_warehouses', 'tests.test_processing_models',
    'tests.test_managed_multi_application', 'tests.test_managed_reasoning',
    'tests.test_mcp_server',
]
log = Path(__file__).with_name('regression.log')
with log.open('w', encoding='utf-8') as stream, redirect_stdout(stream), redirect_stderr(stream):
    suite = unittest.defaultTestLoader.loadTestsFromNames(modules)
    result = unittest.TextTestRunner(stream=stream, verbosity=1).run(suite)
print(f'Tests: {result.testsRun}; failures: {len(result.failures)}; errors: {len(result.errors)}; skipped: {len(result.skipped)}')
print(f'Log: {log}')
if not result.wasSuccessful():
    print(log.read_text(encoding='utf-8')[-6000:])
sys.exit(0 if result.wasSuccessful() else 1)
