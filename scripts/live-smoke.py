"""Readiness + real inference for memory/model services; not an edge-agent proof."""
import argparse,json,urllib.request
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--connection-file',required=True);args=p.parse_args()
c=json.loads(Path(args.connection_file).read_text())
def call(path,body=None):
    req=urllib.request.Request(c['server']+path,data=json.dumps(body).encode() if body is not None else None,headers={'Authorization':'Bearer '+c['token'],**({'Content-Type':'application/json'} if body is not None else {})})
    with urllib.request.urlopen(req,timeout=130) as r:return json.load(r)
assert call('/edge/v1/identity')['device']['id']==c['device_id']
assert call('/model/v1/models')['data'][0]['id']=='deepseek-flash'
assert 'global' in call('/edge/v1/context')
r=call('/model/v1/chat/completions',{'model':'deepseek-flash','messages':[{'role':'user','content':'请只回复：服务正常'}],'max_tokens':32})
assert '服务正常' in r['choices'][0]['message']['content']
print(json.dumps({'passed':True,'role':'memory-and-model-services','checks':4,'edge_agent_verified':False}))
