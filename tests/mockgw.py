import json, http.server, re
MOCK = None
class H(http.server.BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin','*'); self.send_header('Access-Control-Allow-Headers','*'); self.send_header('Access-Control-Allow-Methods','POST, OPTIONS')
    def do_OPTIONS(self): self.send_response(204); self._cors(); self.end_headers()
    def do_POST(self):
        n=int(self.headers.get('content-length',0)); body=json.loads(self.rfile.read(n)); prompt=body['messages'][0]['content']
        open('/tmp/cprs4cc_gw_last_prompt.txt','w').write(prompt); open('/tmp/cprs4cc_gw_headers.txt','w').write(str(dict(self.headers)))
        if self.headers.get('x-api-key')!='test-key': self.send_response(401); self._cors(); self.end_headers(); return
        items=[{"type":"lab","page":1,"line":10,"name":"SODIUM","value":"141","unit":"mmol/L","refRange":"136 - 145","flag":"","specimen":"SERUM","date":"08/11/2026","time":"07:40"},
               {"type":"lab","page":2,"line":5,"name":"GLUCOSE","value":"212","unit":"mg/dL","refRange":"70 - 99","flag":"H","specimen":"SERUM","date":"08/11/2026","time":"07:40"},
               {"type":"document","docType":"progress","title":"DIABETES FOLLOW-UP","author":"OYELARAN,PATRICK J","date":"AUG 18, 2026","time":"10:05","startPage":2,"startLine":10,"endPage":3,"endLine":7}]
        out={"content":[{"type":"text","text":"```json\n"+json.dumps({"patient":{"family":"GARCIA","given":"MARIA L","dob":"1958-11-02","sex":"female"},"items":items,"unmapped":[]})+"\n```"}],"stop_reason":"end_turn"}
        b=json.dumps(out).encode(); self.send_response(200); self._cors(); self.send_header('content-type','application/json'); self.end_headers(); self.wfile.write(b)
    def log_message(self,*a): pass
http.server.ThreadingHTTPServer(('127.0.0.1',8766),H).serve_forever()
