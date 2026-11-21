"""Explicit live acceptance against the private product API. Makes small paid model calls."""
import argparse
import datetime
import http.cookiejar
import json
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--base-url', default='http://127.0.0.1:3180')
p.add_argument('--owner-token-file', default='/opt/anylink-agent/secrets/owner-token')
p.add_argument('--report', required=True)
args = p.parse_args()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
report = {'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'checks': [], 'devices': [], 'memories': [], 'tasks': [], 'conversations': [], 'requests': [], 'idempotency_keys': []}
suffix = uuid.uuid4().hex[:10]

def api(path, method='GET', body=None, key=None, headers=None, expected=200):
    h = {'Content-Type': 'application/json', **(headers or {})}
    if method != 'GET':
        h['Idempotency-Key'] = key or str(uuid.uuid4())
        report['idempotency_keys'].append(h['Idempotency-Key'])
    req = urllib.request.Request(args.base_url + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
    try:
        with opener.open(req, timeout=130) as r:
            data = json.load(r)
            assert r.status == expected, (path, r.status, expected)
            return data
    except urllib.error.HTTPError as e:
        if e.code == expected:
            return json.load(e)
        raise RuntimeError(f'{method} {path}: HTTP {e.code}') from None

def passed(name):
    report['checks'].append({'name': name, 'passed': True})
    print('PASS: ' + name, flush=True)

def conversation(title):
    c = api('/v1/conversations', 'POST', {'title': title + '-' + suffix})
    report['conversations'].append(c['id'])
    return c['id']

def chat(cid, text, origin=None, target=None):
    rid = str(uuid.uuid4())
    body = {'request_id': rid, 'message': text, 'origin_device_id': origin, 'target_device_id': target}
    accepted = api(f'/v1/conversations/{cid}/messages', 'POST', body, key=rid, expected=202)
    report['requests'].append(rid)
    deltas = 0
    with opener.open(args.base_url + accepted['events_url'], timeout=130) as r:
        assert r.headers.get('Content-Type', '').startswith('text/event-stream')
        for line in r:
            if line.startswith(b'data: '):
                event = json.loads(line[6:])
                deltas += event.get('type') == 'delta'
    result = api('/v1/requests/' + rid)
    assert result['state'] == 'completed', (result['state'], result.get('error_code'))
    return rid, body, result, deltas

try:
    assert api('/healthz')['ok']
    assert api('/readyz')['ok']
    api('/v1/devices', expected=401)
    api('/v1/auth/login', 'POST', {'token': Path(args.owner_token_file).read_text().strip()})
    assert api('/v1/status')['execution_enabled'] is False
    passed('readiness, owner authentication and declared capability boundary')

    mac = api('/v1/devices', 'POST', {'name': '验收 Mac ' + suffix, 'platform': 'macos'})
    android = api('/v1/devices', 'POST', {'name': '验收 Android ' + suffix, 'platform': 'android'})
    report['devices'] = [mac['id'], android['id']]
    assert mac['executor_connected'] is False
    passed('logical devices are explicitly unconnected')

    for scope, device, value in [('global', None, '全局验收事实'), ('device', mac['id'], 'MacOld-' + suffix), ('device', android['id'], 'Android-' + suffix)]:
        m = api('/v1/memories', 'POST', {'title': '验收目录-' + suffix, 'content': value, 'scope': scope, 'applicable_device_id': device})
        report['memories'].append(m['id'])
    memory_id = report['memories'][1]
    edited = api('/v1/memories/' + memory_id, 'PATCH', {'content': 'MacNew-' + suffix, 'expected_revision': 1})
    assert edited['revision'] == 2
    api('/v1/memories/' + memory_id, 'PATCH', {'content': 'stale', 'expected_revision': 1}, expected=409)
    hits = api('/v1/memories/search', 'POST', {'device_id': mac['id']})['items']
    assert any(m['id'] == memory_id and m['revision'] == 2 for m in hits)
    assert not any(m['applicable_device_id'] == android['id'] for m in hits)
    directory = api('/v1/devices/' + mac['id'] + '/memory-directory')
    assert any(m['id'] == memory_id and m['revision'] == 2 for m in directory['entries'])
    passed('device scope, revision conflict and current directory index')

    cid = conversation('真实链路验收')
    _, _, _, deltas = chat(cid, '请只用中文回复：链路正常。', android['id'], mac['id'])
    assert deltas > 0
    passed('product API → OpenClaw → DeepSeek Flash with real SSE deltas')

    marker = 'AL_' + suffix
    rid, body, result, _ = chat(cid, f'请记住一条全局偏好：我的验收标识是 {marker}。请调用记忆保存工具保存，主题为验收标识-{suffix}，适用范围为全局。', android['id'])
    assert result['tool_rounds'] >= 1
    saved = api('/v1/memories/search', 'POST', {'q': marker})['items']
    assert len(saved) == 1 and saved[0]['scope'] == 'global'
    assert saved[0]['source_device_id'] == android['id']
    report['memories'].append(saved[0]['id'])
    replay = api(f'/v1/conversations/{cid}/messages', 'POST', body, key=rid)
    assert replay['replayed'] is True
    assert len(api('/v1/memories/search', 'POST', {'q': marker})['items']) == 1
    passed('real multi-round memory tool, declared source and duplicate request replay')

    other = conversation('新会话召回验收')
    _, _, result, _ = chat(other, '我的验收标识是什么？请使用当前长期记忆回答。', mac['id'])
    assert marker in result['response_text']
    passed('global fact recalled from a separate conversation and device')

    _, _, result, _ = chat(other, f'请为目标设备 {mac["name"]}（ID {mac["id"]}）保存任务：验收任务-{suffix}。只保存待办，不执行。', android['id'], mac['id'])
    assert result['tool_rounds'] >= 1
    items = api('/v1/tasks')['items']
    created = [x for x in items if suffix in x['goal']]
    assert len(created) == 1
    task = created[0]
    report['tasks'].append(task['id'])
    assert task['origin_device_id'] == android['id'] and task['target_device_id'] == mac['id']
    assert task['status'] == 'waiting_device' and task['execution_enabled'] is False
    cancelled = api('/v1/tasks/' + task['id'] + '/cancel', 'POST', {})
    assert cancelled['status'] == 'cancelled'
    passed('real task tool preserves origin/target, waits and cancels without execution')

    removed = report['memories'][0]
    api('/v1/memories/' + removed, 'DELETE', headers={'If-Match': '1'})
    api('/v1/memories/' + removed, expected=404)
    assert not any(m['id'] == removed for m in api('/v1/memories')['items'])
    passed('deleted fact immediately absent from active retrieval')
    api('/v1/auth/logout', 'POST', {})
    report['passed'] = True
except Exception as e:
    report['passed'] = False
    report['error'] = str(e)
finally:
    report['finished_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'passed': report.get('passed'), 'checks': len(report['checks']), 'error': report.get('error'), 'report': args.report}, ensure_ascii=False), flush=True)
if not report.get('passed'):
    raise SystemExit(1)
