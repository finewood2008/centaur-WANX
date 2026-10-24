import base64
import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

import pytest


@pytest.mark.skipif(os.name!='posix',reason='PTY is a macOS/Linux runtime capability')
def test_native_terminal_worker_never_forwards_supplied_input(tmp_path):
    fake=tmp_path/'fake-codex'
    fake.write_text('#!'+sys.executable+'\nimport select,sys\nprint("SYNTHETIC CLI",flush=True)\nready,_,_=select.select([sys.stdin],[],[],.5)\nprint("UNEXPECTED_INPUT" if ready else "NO_USER_INPUT",flush=True)\n')
    fake.chmod(0o700)
    worker=Path(__file__).resolve().parents[2]/'codex/terminal.py'
    config={'sessionId':str(uuid4()),'socket':'/tmp/synthetic-unused.sock','binary':str(fake),'cwd':str(tmp_path),'config':{}}
    proc=subprocess.Popen([sys.executable,str(worker)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        proc.stdin.write(json.dumps(config)+'\n');proc.stdin.flush()
        # Wait for the native child to start instead of racing buffered bootstrap input.
        first=json.loads(proc.stdout.readline())
        proc.stdin.write(json.dumps({'type':'input','data':'malicious command\n'})+'\n');proc.stdin.flush()
        proc.wait(timeout=5)
        events=[first]+[json.loads(line) for line in proc.stdout.read().splitlines()]
    finally:
        if proc.poll() is None:proc.kill();proc.wait()
        proc.stdin.close();proc.stdout.close();proc.stderr.close()
    output=b''.join(base64.b64decode(event['data']) for event in events if event['kind']=='bytes')
    assert any(event['kind']=='input_rejected' for event in events)
    assert b'NO_USER_INPUT' in output and b'UNEXPECTED_INPUT' not in output and b'malicious command' not in output
