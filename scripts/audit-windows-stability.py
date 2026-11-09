"""Two-minute offline smoke test; synthetic credential and isolated database."""
import ctypes
import json
import os
import pathlib
import socket
import subprocess
import time
from ctypes import wintypes

root=pathlib.Path(__file__).resolve().parents[1]
out=root/'artifacts/windows-exe-audit-20261108'
class Memory(ctypes.Structure):
    _fields_=[('cb',wintypes.DWORD),('faults',wintypes.DWORD)]+[(name,ctypes.c_size_t) for name in
        ('peak_working_set','working_set','peak_paged','paged','peak_nonpaged','nonpaged','pagefile','peak_pagefile')]
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
env={k:v for k,v in os.environ.items() if not k.startswith('DP_')}
env.update(DP_DB_PATH=str(out/'stability.db'),DP_BACKEND_URL=f'http://127.0.0.1:{port}',DP_DEVICE_SECRET='audit-invalid-credential')
samples=[]
with open(out/'stability.stdout.log','w') as stdout,open(out/'stability.stderr.log','w') as stderr:
    start=time.monotonic()
    proc=subprocess.Popen([str(out/'target/release/dp-user-agent.exe'),'--run-duration','120'],env=env,cwd=out,
                          stdout=stdout,stderr=stderr,creationflags=subprocess.CREATE_NO_WINDOW)
    handle=wintypes.HANDLE(int(proc._handle))
    while proc.poll() is None and time.monotonic()-start<170:
        mem=Memory();mem.cb=ctypes.sizeof(mem)
        handles=wintypes.DWORD()
        times=[ctypes.c_ulonglong() for _ in range(4)]
        if (ctypes.windll.psapi.GetProcessMemoryInfo(handle,ctypes.byref(mem),mem.cb)
            and ctypes.windll.kernel32.GetProcessHandleCount(handle,ctypes.byref(handles))
            and ctypes.windll.kernel32.GetProcessTimes(handle,*[ctypes.byref(value) for value in times])):
            samples.append(dict(seconds=round(time.monotonic()-start,3),working_set=mem.working_set,
                                handles=handles.value,cpu_seconds=(times[2].value+times[3].value)/10_000_000))
        time.sleep(5)
    timedout=proc.poll() is None
    if timedout:proc.kill()
    code=proc.wait()
(out/'stability.json').write_text(json.dumps(dict(pid=proc.pid,exit_code=code,timeout=timedout,samples=samples),indent=2))
print(json.dumps(dict(pid=proc.pid,exit_code=code,timeout=timedout,samples=len(samples))))
