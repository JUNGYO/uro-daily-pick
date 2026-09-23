import contextlib
import io
import json
from pathlib import Path
import sys
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request,urlopen
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from review_service import Gateway,ServiceError,Server,handler_for


class FakeClient:
    def __init__(self):self.calls=[];self.editor=True
    def authorize(self,token,project):
        self.calls.append((token,project))
        if project!=10:raise ServiceError(403,'project_denied')
        if token!='synthetic-session-token-not-real-1234567890':raise ServiceError(401,'invalid_token')
        return 'fixture-user',{'can_edit':self.editor}


class ReviewServiceTests(unittest.TestCase):
    def setUp(self):
        self.client=FakeClient();self.gateway=Gateway(self.client,'https://reader.example.test')
        self.server=Server(('127.0.0.1',0),handler_for(self.gateway));self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.url='http://127.0.0.1:'+str(self.server.server_address[1])
    def tearDown(self):self.server.shutdown();self.server.server_close();self.thread.join()
    def call(self,payload=None,headers=None,path='/v1/import'):
        body={'project_id':10,'format':'ris','text':'TY  - JOUR\nTI  - Trial\nER  -'} if payload is None else payload
        h={'Origin':'https://reader.example.test','Authorization':'Bearer synthetic-session-token-not-real-1234567890','Content-Type':'application/json',**(headers or {})}
        try:
            with urlopen(Request(self.url+path,data=json.dumps(body).encode(),headers=h),timeout=3) as r:return r.status,r.read(),r.headers
        except HTTPError as r:return r.code,r.read(),r.headers
    def test_authenticated_import_no_store(self):
        status,raw,h=self.call();self.assertEqual(status,200);self.assertEqual(json.loads(raw)['source_count'],1)
        self.assertEqual(h['Cache-Control'],'no-store');self.assertEqual(h['Access-Control-Allow-Origin'],'https://reader.example.test')
    def test_other_project_and_reader_cannot_import(self):
        self.assertEqual(self.call({'project_id':11,'format':'ris','text':'not read'})[0],403)
        self.client.editor=False;self.assertEqual(self.call()[0],403)
    def test_keys_are_rejected_before_authorization_or_parsing(self):
        marker='synthetic-key-must-not-persist'
        status,body,_=self.call({'project_id':10,'api_key':marker,'format':'ris','text':'value'})
        self.assertEqual(status,400);self.assertNotIn(marker.encode(),body);self.assertEqual(self.client.calls,[])
    def test_origin_and_arbitrary_routes_are_denied(self):
        self.assertEqual(self.call(headers={'Origin':'https://other.example.test'})[0],403)
        self.assertEqual(self.call(path='/v1/../../worker.json')[0],404)
        self.assertEqual(self.call(headers={'Authorization':'Bearer invalid'})[0],401)
        self.assertEqual(self.client.calls,[])
    def test_errors_do_not_log_credentials_or_body(self):
        output=io.StringIO()
        with contextlib.redirect_stderr(output),contextlib.redirect_stdout(output):
            status,raw,_=self.call({'project_id':10,'format':'csl-json','text':'SECRET_INVALID_JSON'})
        self.assertEqual(status,400);self.assertNotIn(b'SECRET_INVALID_JSON',raw);self.assertEqual(output.getvalue(),'')
    def test_unsupported_json_shapes_fail_cleanly(self):
        for value in ([],None,False,'raw'):
            status,_,_=self.call(value if value is not None else {'project_id':None})
            self.assertEqual(status,400)
    def test_expiring_rate_limit(self):
        for _ in range(30):self.gateway.limited('rate-fixture')
        with self.assertRaises(ServiceError) as error:self.gateway.limited('rate-fixture')
        self.assertEqual(error.exception.status,429)


if __name__=='__main__':unittest.main()
