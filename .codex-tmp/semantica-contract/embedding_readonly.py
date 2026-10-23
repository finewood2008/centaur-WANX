"""Explain local model preparation metadata without loading model weights."""
import json
from pathlib import Path
import sys

root = Path('D:/项目文件/semantica')
sys.path.insert(0, str(root))
from app.config import Settings
from app.services.managed_readiness import prepared_model

settings = Settings()
path = settings.embedding_local_path
manifest = json.loads((root / 'models/manifest.json').read_text(encoding='utf-8'))
record = manifest['models']['embedding']
entries = {entry['path']: entry for entry in record['files']}
actual = {item.relative_to(path).as_posix() for item in path.rglob('*') if item.is_file()}
declared = set(entries)
report = {
    'source': 'local configuration and filesystem metadata; no model inference',
    'prepared_model': prepared_model(settings, 'embedding'),
    'selected_path': str(path),
    'manifest_path_matches': (root / record['project_path']).resolve() == path.resolve(),
    'missing_files': sorted(declared - actual),
    'extra_files': sorted(actual - declared),
    'size_mismatches': [name for name in sorted(actual & declared)
                        if (path / name).stat().st_size != entries[name]['bytes']],
}
Path(__file__).with_name('embedding-readonly-report.json').write_text(
    json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, ensure_ascii=True, indent=2))
