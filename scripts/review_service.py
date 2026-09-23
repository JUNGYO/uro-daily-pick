"""Loopback research service. No request logging, uploaded files, or API-key storage.

The browser uses its existing Supabase session. Numerical jobs use the existing
enrolled worker credential and a separate, bounded CPU process, never Spark.
"""
from __future__ import annotations
import argparse
import ctypes
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPSHandler, HTTPRedirectHandler

sys.path.insert(0,str(Path(__file__).resolve().parent))
from review_documents import parse_import, reproducible_archive

MAX_BODY=20_000_000
MAX_RESPONSE=24_000_000
UUID=re.compile(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\Z")


class ServiceError(Exception):
    def __init__(self,status,code): self.status,self.code=status,code


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None


def https_origin(value):
    p=urlsplit(value)
    if p.scheme!='https' or not p.hostname or p.username or p.password or p.path not in ('','/') or p.query or p.fragment:
        raise ValueError('An HTTPS origin is required')
    return value.rstrip('/')


class ServiceClient:
    def __init__(self,url,public_key):
        self.url=https_origin(url)
        if not public_key.startswith('sb_publishable_'): raise ValueError('A public publishable key is required')
        self.public_key=public_key
        self.opener=build_opener(NoRedirect(),HTTPSHandler(context=ssl.create_default_context()))

    def request(self,path,payload=None,token=None):
        headers={'apikey':self.public_key,'Accept':'application/json','Content-Type':'application/json'}
        if token: headers['Authorization']='Bearer '+token
        request=Request(self.url+path,data=json.dumps(payload,allow_nan=False).encode() if payload is not None else None,headers=headers)
        try:
            with self.opener.open(request,timeout=20) as response:
                raw=response.read(MAX_RESPONSE+1)
                if len(raw)>MAX_RESPONSE: raise ServiceError(413,'response_too_large')
                return json.loads(raw)
        except HTTPError as error:
            status=error.code;error.close()
            raise ServiceError(status if status in (400,401,403,409,429) else 503,'request_rejected') from None
        except (URLError,OSError,ValueError): raise ServiceError(503,'service_unavailable') from None

    def authorize(self,token,project):
        user=self.request('/auth/v1/user',token=token)
        if not isinstance(user,dict) or not user.get('id') or not user.get('email_confirmed_at') or user.get('is_anonymous'):
            raise ServiceError(403,'account_required')
        workspace=self.request('/rest/v1/rpc/review_workspace',{'p_project':project},token)
        return user['id'],workspace

    def analysis(self,token,project,run):
        return self.request('/rest/v1/rpc/review_analysis',{'p_project':project,'p_id':run},token)


class Gateway:
    def __init__(self,client,origin,engine_dir=None):
        self.client=client;self.origin=https_origin(origin);self.engine_dir=Path(engine_dir) if engine_dir else None
        self.slots=threading.BoundedSemaphore(4);self.lock=threading.Lock();self.rates={}

    def limited(self,user):
        # Bounded, expiring hashes only; no token/request retention.
        key=hashlib.sha256(user.encode()).hexdigest();now=time.monotonic()
        with self.lock:
            self.rates={k:v for k,v in self.rates.items() if v[0]>now-60}
            since,count=self.rates.get(key,(now,0))
            if count>=30 or len(self.rates)>10000: raise ServiceError(429,'rate_limit')
            self.rates[key]=(since,count+1)

    def handle(self,path,token,body):
        if not isinstance(body,dict) or isinstance(body.get('project_id'),bool) or not isinstance(body.get('project_id'),int) or body['project_id']<=0:
            raise ServiceError(400,'invalid_project')
        expected={'/v1/import':{'project_id','format','text','mapping'},'/v1/export':{'project_id','run_id'},'/v1/figure':{'project_id','run_id'}}
        if path not in expected: raise ServiceError(404,'not_found')
        if set(body)-expected[path]: raise ServiceError(400,'unexpected_field')
        user,workspace=self.client.authorize(token,body['project_id']);self.limited(user)
        if path=='/v1/import':
            if not workspace.get('can_edit'): raise ServiceError(403,'editor_required')
            try: result=parse_import(body.get('text'),body.get('format'),body.get('mapping'))
            except (ValueError,TypeError,KeyError,AttributeError): raise ServiceError(400,'invalid_import') from None
            return 'application/json',json.dumps(result,ensure_ascii=False,allow_nan=False).encode()
        if not isinstance(body.get('run_id'),str) or not UUID.fullmatch(body['run_id']): raise ServiceError(400,'invalid_run')
        run=self.client.analysis(token,body['project_id'],body['run_id'])
        if run.get('status') not in ('succeeded','needs_review'): raise ServiceError(409,'run_not_finished')
        if path=='/v1/figure':
            from review_figures import forest
            plot=forest(run.get('result') or {})
            if not plot:raise ServiceError(409,'no_estimable_rows')
            return 'image/svg+xml',plot.encode('utf-8')
        digest=(run.get('result') or {}).get('engine',{}).get('code_sha256','')
        code=Path(__file__).with_name('review_analysis.py').read_bytes()
        if hashlib.sha256(code).hexdigest()!=digest:
            if not self.engine_dir or not re.fullmatch(r'[a-f0-9]{64}',digest): raise ServiceError(409,'engine_archive_required')
            path=self.engine_dir/(digest+'.py')
            if path.is_symlink(): raise ServiceError(409,'engine_archive_required')
            try: code=path.read_bytes()
            except OSError: raise ServiceError(409,'engine_archive_required') from None
            if hashlib.sha256(code).hexdigest()!=digest: raise ServiceError(409,'engine_archive_required')
        reports={r['report_id']:{'id':r['report_id'],'bibliography':r['bibliography']} for r in run['input_manifest']['observations']}
        try: archive=reproducible_archive(run,list(reports.values()),engine_source=code)
        except (ValueError,KeyError,TypeError): raise ServiceError(409,'export_contract_mismatch') from None
        return 'application/zip',archive


class Server(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self,*args,**kwargs):
        self.connections=threading.BoundedSemaphore(24)
        super().__init__(*args,**kwargs)
    def process_request(self,request,client_address):
        if not self.connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:super().process_request(request,client_address)
        except BaseException:
            self.connections.release()
            raise
    def process_request_thread(self,request,client_address):
        try:super().process_request_thread(request,client_address)
        finally:self.connections.release()
    def handle_error(self,request,client_address): pass # Never emit headers/body or a traceback.


def handler_for(gateway):
    class Handler(BaseHTTPRequestHandler):
        server_version='ResearchService';sys_version=''
        def log_message(self,*args): pass
        @property
        def route_path(self):
            return self.path[7:] if self.path.startswith('/review/') else self.path
        def setup(self):
            super().setup();self.connection.settimeout(30)
        def reply(self,status,payload,content='application/json'):
            self.send_response(status)
            self.send_header('Content-Type',content);self.send_header('Content-Length',str(len(payload)))
            self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Referrer-Policy','no-referrer');self.send_header('Connection','close')
            if self.headers.get('Origin')==gateway.origin:
                self.send_header('Access-Control-Allow-Origin',gateway.origin);self.send_header('Vary','Origin')
            self.end_headers();self.wfile.write(payload);self.close_connection=True
        def do_GET(self):
            if self.route_path=='/health': self.reply(200,b'{"status":"ok","service":"review","version":1}')
            else:self.reply(404,b'{"error":"not_found"}')
        def do_OPTIONS(self):
            if self.headers.get_all('Origin')!=[gateway.origin] or self.route_path not in ('/v1/import','/v1/export','/v1/figure'):
                self.reply(403,b'{"error":"origin_denied"}');return
            self.send_response(204);self.send_header('Access-Control-Allow-Origin',gateway.origin)
            self.send_header('Access-Control-Allow-Methods','POST');self.send_header('Access-Control-Allow-Headers','Authorization, Content-Type')
            self.send_header('Access-Control-Max-Age','600');self.send_header('Vary','Origin');self.send_header('Content-Length','0');self.end_headers()
        def do_POST(self):
            acquired=False
            try:
                if self.headers.get_all('Origin')!=[gateway.origin]: raise ServiceError(403,'origin_denied')
                if self.route_path not in ('/v1/import','/v1/export','/v1/figure'): raise ServiceError(404,'not_found')
                if len(self.headers.get_all('Authorization',[]))!=1: raise ServiceError(401,'sign_in_required')
                auth=self.headers.get('Authorization','')
                if not re.fullmatch(r'Bearer [A-Za-z0-9_.-]{40,8000}',auth): raise ServiceError(401,'sign_in_required')
                if self.headers.get('Transfer-Encoding') or len(self.headers.get_all('Content-Length',[]))!=1: raise ServiceError(400,'invalid_length')
                try: length=int(self.headers['Content-Length'])
                except (ValueError,TypeError): raise ServiceError(400,'invalid_length') from None
                if not 1<=length<=MAX_BODY: raise ServiceError(413,'request_too_large')
                if self.headers.get_content_type()!='application/json': raise ServiceError(400,'json_required')
                acquired=gateway.slots.acquire(blocking=False)
                if not acquired: raise ServiceError(429,'busy')
                raw=self.rfile.read(length)
                if len(raw)!=length: raise ServiceError(400,'incomplete_request')
                body=json.loads(raw,parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
                content,result=gateway.handle(self.route_path,auth[7:],body)
                if len(result)>MAX_RESPONSE: raise ServiceError(413,'response_too_large')
                self.reply(200,result,content)
            except ServiceError as error:self.reply(error.status,json.dumps({'error':error.code}).encode())
            except (ValueError,TypeError,UnicodeError):self.reply(400,b'{"error":"invalid_request"}')
            except (OSError,TimeoutError):pass
            except Exception:self.reply(503,b'{"error":"service_unavailable"}')
            finally:
                if acquired:gateway.slots.release()
    return Handler


def unprotect(data):
    # Read an existing user-bound enrollment. Never create or export credentials.
    if os.name!='nt':raise RuntimeError('Windows enrollment required')
    from ctypes import wintypes
    class Blob(ctypes.Structure):
        _fields_=[('size',wintypes.DWORD),('data',ctypes.POINTER(ctypes.c_ubyte))]
    buf=ctypes.create_string_buffer(data);source=Blob(len(data),ctypes.cast(buf,ctypes.POINTER(ctypes.c_ubyte)));output=Blob()
    crypt=ctypes.WinDLL('crypt32',use_last_error=True)
    crypt.CryptUnprotectData.argtypes=[ctypes.POINTER(Blob),ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,wintypes.DWORD,ctypes.POINTER(Blob)]
    if not crypt.CryptUnprotectData(ctypes.byref(source),None,None,None,None,1,ctypes.byref(output)):raise RuntimeError('Enrollment unavailable')
    try:return ctypes.string_at(output.data,output.size).decode()
    finally:
        free=ctypes.WinDLL('kernel32').LocalFree;free.argtypes=[ctypes.c_void_p];free(ctypes.cast(output.data,ctypes.c_void_p))


class AnalysisWorker:
    def __init__(self,directory,python=sys.executable):
        config=json.loads((Path(directory)/'worker.json').read_text(encoding='utf-8'))
        self.client=ServiceClient(config['url'],config['public_key']);self.worker_id=config['id']
        self.token=unprotect((Path(directory)/'worker-token.dpapi').read_bytes());self.python=python
    def rpc(self,name,values=None):
        if name not in ('claim_review_analysis','finish_review_analysis'):raise ValueError('Unsupported worker call')
        return self.client.request('/rest/v1/rpc/'+name,{'p_worker_id':self.worker_id,'p_token':self.token,**(values or {})})
    def once(self):
        job=self.rpc('claim_review_analysis')
        if job is None:return False
        if not isinstance(job,dict) or set(job)!={'id','lease_token','input_hash','input','config'} or not UUID.fullmatch(job.get('id','')) or not UUID.fullmatch(job.get('lease_token','')):raise ValueError('Invalid job')
        # Fixed executable and source; only typed data enters stdin, never a shell.
        environment={**os.environ,'OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','MKL_NUM_THREADS':'1'}
        try:
            child=subprocess.run([self.python,'-I','-B',str(Path(__file__).with_name('review_analysis.py'))],input=json.dumps(job,allow_nan=False).encode(),
                stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=600,check=True,env=environment,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
            if len(child.stdout)>4_000_000:raise ValueError('Result too large')
            result=json.loads(child.stdout)
        except (subprocess.SubprocessError,ValueError):
            result={'schema_version':1,'status':'failed','input_hash':job['input_hash'],'error_code':'worker_calculation_failed',
                    'engine':{'name':'uro-review-python'},'config':job['config'],'rows':[],'pooled':None,'diagnostics':{},'warnings':[],'sensitivity':[],'artifacts':{}}
        self.rpc('finish_review_analysis',{'p_id':job['id'],'p_lease_token':job['lease_token'],'p_input_hash':job['input_hash'],'p_result':result})
        return True
    def loop(self,stop):
        while not stop.is_set():
            try:delay=1 if self.once() else 15
            except Exception:delay=60
            stop.wait(delay)


def main():
    p=argparse.ArgumentParser();p.add_argument('--url');p.add_argument('--public-key');p.add_argument('--origin')
    p.add_argument('--worker-only',action='store_true')
    p.add_argument('--port',type=int,default=18452);p.add_argument('--worker-dir');p.add_argument('--engine-dir');args=p.parse_args()
    stop=threading.Event()
    if args.worker_only:
        if not args.worker_dir:p.error('--worker-dir required')
        AnalysisWorker(args.worker_dir).loop(stop)
        return
    if not args.url or not args.public_key or not args.origin:p.error('--url, --public-key and --origin required')
    gateway=Gateway(ServiceClient(args.url,args.public_key),args.origin,args.engine_dir)
    if args.worker_dir:
        worker=AnalysisWorker(args.worker_dir);threading.Thread(target=worker.loop,args=(stop,),daemon=True).start()
    server=Server(('127.0.0.1',args.port),handler_for(gateway))
    try:server.serve_forever()
    finally:stop.set();server.server_close()


if __name__=='__main__':main()
