import json, io, time, os
p = '/root/.dsh/phone-bridge/inbox-state.json'
d = json.load(io.open(p, encoding='utf-8'))
before = d.get('cursor')
d['cursor'] = 300
io.open(p, 'w', encoding='utf-8', newline='').write(json.dumps(d, ensure_ascii=False, indent=2))
print('set cursor 300 (was %s)' % before)
time.sleep(8)
d2 = json.load(io.open(p, encoding='utf-8'))
print('after 8s cursor=%s lastWake=%s' % (d2.get('cursor'), (d2.get('lastWake') or {}).get('at')))
