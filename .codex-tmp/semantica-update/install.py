"""Install only reviewed source files, refusing concurrent changes."""
import hashlib
import json
from pathlib import Path

stage = Path(__file__).resolve().parent
target = Path('D:/项目文件/semantica').resolve()
originals = json.loads((stage / 'originals.json').read_text(encoding='utf-8'))
for name, expected in originals.items():
    path = (target / name).resolve()
    assert path.is_relative_to(target), name
    actual = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
    assert actual == expected, f'Concurrent change: {name}'
    assert (stage / 'files' / name).is_file(), name
for name in originals:
    (target / name).write_bytes((stage / 'files' / name).read_bytes())
    print('Updated:', name)
