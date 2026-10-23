"""Output-only PTY for the original Codex CLI; never accepts user keystrokes."""
import base64
import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios

COLS,ROWS=96,32


def emit(value):
    print(json.dumps(value),flush=True)


def main():
    config=json.loads(sys.stdin.readline())
    session=config['sessionId']
    if not re.fullmatch(r'[a-f0-9-]{36}',session):
        raise ValueError('CODEX_SESSION_INVALID')
    endpoint=config['socket']
    if not endpoint.startswith('/private/') and not endpoint.startswith('/var/') and not endpoint.startswith('/tmp/'):
        raise ValueError('CODEX_SOCKET_INVALID')
    args=[config['binary'],'--remote','unix://'+endpoint,'resume',session,
          '--no-alt-screen','-C',config['cwd']]
    settings=config['config']
    settings['tui']={**settings.get('tui',{}),'animations':False}
    def toml(item):
        if isinstance(item,dict):return '{'+','.join(json.dumps(k)+'='+toml(v) for k,v in item.items())+'}'
        if isinstance(item,list):return '['+','.join(toml(v) for v in item)+']'
        return json.dumps(item,separators=(',',':'))
    def arguments(value):
        for key,item in value.items():
            yield from ['-c',key+'='+toml(item)]
    args+=list(arguments(settings))
    args+=['-c','projects.'+json.dumps(config['cwd'])+'.trust_level="trusted"']
    pid,fd=pty.fork()
    if pid==0:
        os.chdir(config['cwd'])
        os.environ.update(TERM='xterm-256color',COLORTERM='truecolor')
        os.execvpe(args[0],args,os.environ)
    fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack('HHHH',ROWS,COLS,0,0))
    stopping=False
    def stop(*_):
        nonlocal stopping
        stopping=True
        try:
            ended,_=os.waitpid(pid,os.WNOHANG)
            if ended:return
        except ChildProcessError:return
        try:os.killpg(pid,signal.SIGTERM)
        except (ProcessLookupError,PermissionError):
            try:os.kill(pid,signal.SIGTERM)
            except (ProcessLookupError,PermissionError):pass
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    tail=b''
    try:
        while not stopping:
            ready,_,_=select.select([fd,sys.stdin],[],[],.2)
            if sys.stdin in ready:
                line=sys.stdin.readline()
                if not line:break
                # No input, paste, key, shell command or signal transport exists.
                emit({'kind':'input_rejected'})
            if fd in ready:
                try:data=os.read(fd,65536)
                except OSError as error:
                    if error.errno==errno.EIO:break
                    raise
                if not data:break
                # Only answer terminal capability queries; these aren't user input.
                joined=tail+data
                for query,response in [(b'\x1b[6n',b'\x1b[1;1R'),(b'\x1b[c',b'\x1b[?1;2c'),
                                       (b'\x1b[?u',b'\x1b[?0u'),(b'\x1b]10;?',b'\x1b]10;rgb:dddd/dddd/dddd\x1b\\'),
                                       (b'\x1b]11;?',b'\x1b]11;rgb:2222/2222/2222\x1b\\')]:
                    index=joined.find(query)
                    if index>=0 and index+len(query)>len(tail):os.write(fd,response)
                tail=joined[-20:]
                emit({'kind':'bytes','data':base64.b64encode(data).decode()})
        emit({'kind':'exit'})
    finally:
        stop();os.close(fd)
        try:os.waitpid(pid,0)
        except ChildProcessError:pass


if __name__=='__main__':main()
