"""Exercise the actual candidate on Windows with collection always denied.

The loopback fixture is a protocol test, NOT a staging/backend acceptance test.
No enrollment succeeds, no Credential Manager entries are written, no screens
or foreground applications are collected. All DBs belong to this audit.
"""
import ctypes
import hashlib
import http.server
import json
import os
import pathlib
import socket
import sqlite3
import subprocess
import threading
import time

root = pathlib.Path(__file__).resolve().parents[1]
evidence = root / 'artifacts/windows-exe-audit-20261108'
exe = evidence / 'target/release/dp-user-agent.exe'
launch_hash = hashlib.sha256(exe.read_bytes()).hexdigest()
out = evidence / ('runtime-' + time.strftime('%Y%m%d-%H%M%S'))
out.mkdir()
env = {k:v for k,v in os.environ.items() if not k.startswith('DP_')}
env['DP_LOG']='info'
results=[]
requests=[]
state={'mode':'denied'}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self): self.respond()
    def do_POST(self): self.respond()
    def respond(self):
        body=self.rfile.read(int(self.headers.get('Content-Length','0')))
        code=200
        payload={'monitoring':{'allowed':False,'reason':'CONSENT_REQUIRED'},'policy':{'allowed':False,'reason':'CONSENT_REQUIRED'}}
        if state['mode']=='unavailable':
            code=503; payload={'error':{'code':'STORAGE_UNAVAILABLE'}}
        elif state['mode'] in ('DEVICE_REVOKED','DEVICE_ARCHIVED'):
            code=403; payload={'error':{'code':state['mode']}}
        elif self.path.endswith('/enroll'):
            code=401; payload={'error':{'code':'INVALID_TOKEN'}}
        requests.append({'time':time.time(),'method':self.command,'path':self.path,'status':code,
                         'authenticated':bool(self.headers.get('X-Device-Secret')),'request_bytes':len(body)})
        data=json.dumps(payload).encode()
        self.send_response(code);self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)

server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}'

def start(name,args,extra=None,db='runtime.db'):
    current=env | {'DP_DB_PATH':str(out/db)} | (extra or {})
    stdout=open(out/f'{name}.stdout.log','w',encoding='utf-8')
    stderr=open(out/f'{name}.stderr.log','w',encoding='utf-8')
    tick=time.monotonic()
    proc=subprocess.Popen([str(exe),*args],cwd=out,env=current,stdout=stdout,stderr=stderr,
                          creationflags=subprocess.CREATE_NO_WINDOW)
    return proc,stdout,stderr,tick

def finish(name,run,expected=0):
    proc,stdout,stderr,tick=run
    timedout=False
    try: code=proc.wait(timeout=45)
    except subprocess.TimeoutExpired:
        timedout=True;proc.kill();code=proc.wait()
    stdout.close();stderr.close()
    row={'name':name,'pid':proc.pid,'exit_code':code,'elapsed_seconds':round(time.monotonic()-tick,3),
         'timeout':timedout,'expected_exit':expected,'pass':not timedout and code==expected}
    results.append(row);return row

def run(name,args,extra=None,expected=0,db='runtime.db'):
    return finish(name,start(name,args,extra,db),expected)

run('version',['--version'])
run('unenrolled',['--run-duration','2'])
run('status-first',['--status'])
run('status-restart',['--status'])
run('unenrolled-oneshot',['--oneshot'],expected=1)
run('unenrolled-sync',['--sync-now'],expected=1)
run('missing-token',['enroll'],expected=1)
synthetic={'DP_DEVICE_SECRET':'audit-only-invalid-credential','DP_BACKEND_URL':base,'DP_SYNC_INTERVAL_SECS':'5'}
run('invalid-token',['enroll','--token','audit-invalid-token','--server',base],expected=1)
run('zero-interval',['--run-duration','2'],synthetic|{'DP_SYNC_INTERVAL_SECS':'0'},expected=1)
run('invalid-url',['--run-duration','2'],synthetic|{'DP_BACKEND_URL':'file:///invalid'},expected=1)
with sqlite3.connect(out/'corrupt.db') as db:
    db.execute('CREATE TABLE agent_state (key TEXT PRIMARY KEY,value TEXT NOT NULL)')
    db.execute("INSERT INTO agent_state VALUES ('device_id','corrupt-identity')")
run('corrupt-identity',['--status'],synthetic,expected=1,db='corrupt.db')

active=start('denied-monitor',['--run-duration','15'],synthetic)
time.sleep(2)
run('duplicate-monitor',['--run-duration','1'],synthetic,expected=1)
sample=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',
    f'Get-Process -Id {active[0].pid} | Select-Object Id,CPU,WorkingSet64,PeakWorkingSet64,HandleCount,@{{Name="ThreadCount";Expression={{$_.Threads.Count}}}} | ConvertTo-Json -Compress'],capture_output=True,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
(out/'process-sample.json').write_text(sample.stdout,encoding='utf-8')
finish('denied-monitor',active)
run('restart-monitor',['--run-duration','2'],synthetic)
state['mode']='DEVICE_REVOKED'
run('revoked-protocol',['--run-duration','2'],synthetic)
state['mode']='DEVICE_ARCHIVED'
run('archived-protocol',['--run-duration','2'],synthetic)
state['mode']='unavailable'
recover=start('recovery-protocol',['--run-duration','12'],synthetic)
time.sleep(6);state['mode']='denied'
finish('recovery-protocol',recover)

with socket.socket() as probe:
    probe.bind(('127.0.0.1',0));unused=probe.getsockname()[1]
run('offline-monitor',['--run-duration','3'],synthetic|{'DP_BACKEND_URL':f'http://127.0.0.1:{unused}'})
crash=start('terminated-monitor',['--run-duration','30'],synthetic)
time.sleep(2);crash[0].terminate();finish('terminated-monitor',crash,expected=1)
run('restart-after-termination',['--run-duration','2'],synthetic)
server.shutdown()
with sqlite3.connect(out/'runtime.db') as db:
    db_evidence={'device_id':db.execute("SELECT value FROM agent_state WHERE key='device_id'").fetchone()[0],
              'activity_sessions':db.execute('SELECT COUNT(*) FROM activity_sessions').fetchone()[0],
              'tables':[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]}
(out/'runtime-database-evidence.json').write_text(json.dumps(db_evidence,indent=2))
(out/'protocol-requests.json').write_text(json.dumps(requests,indent=2))
(out/'runtime-results.json').write_text(json.dumps({'sha256':launch_hash,'unchanged_during_run':launch_hash == hashlib.sha256(exe.read_bytes()).hexdigest(),'results':results},indent=2))
(evidence/'latest-runtime.txt').write_text(out.name)
print(json.dumps({'passed':sum(r['pass'] for r in results),'failed':sum(not r['pass'] for r in results),'database':db_evidence}))
