"""Portable image identity: immutable rootfs layers plus complete execution config.

Containerd Docker can report an OCI index as .Id; classic Docker reports config ID.
Do not compare those different namespaces after docker save --platform / load.
"""
import hashlib
import json
import subprocess
import sys

image=json.loads(subprocess.check_output(['docker','image','inspect',sys.argv[1]],text=True))[0]
cfg=image.get('Config') or {}
normalized={
    'os':image['Os'], 'architecture':image['Architecture'],
    'rootfs':image['RootFS']['Layers'],
    'config':{
        'env':cfg.get('Env') or [],'cmd':cfg.get('Cmd') or [],
        'entrypoint':cfg.get('Entrypoint') or [],'user':cfg.get('User') or '',
        'workdir':cfg.get('WorkingDir') or '', 'labels':cfg.get('Labels') or {},
        'ports':cfg.get('ExposedPorts') or {},'volumes':cfg.get('Volumes') or {},
        'healthcheck':cfg.get('Healthcheck') or {},'stop_signal':cfg.get('StopSignal') or '',
    },
}
wire=json.dumps(normalized,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
print('sha256:'+hashlib.sha256(wire).hexdigest())
