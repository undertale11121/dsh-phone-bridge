import json, io, time
tp = '/root/.dsh/phone-bridge/thread.jsonl'
rows = []
for line in io.open(tp, encoding='utf-8'):
    line = line.strip()
    if not line: continue
    try: rows.append(json.loads(line))
    except: pass
print('thread rows=%d, max seq=%s' % (len(rows), rows[-1].get('seq') if rows else None))
for r in rows[-8:]:
    print(' ', r.get('seq'), r.get('from'), '->', r.get('to'), '|', str(r.get('text'))[:36].replace('\n',' '))
ip = '/root/.dsh/phone-bridge/inbox-state.json'
for i in range(3):
    d = json.load(io.open(ip, encoding='utf-8'))
    print('sample%d cursor=%s at=%s' % (i, d.get('cursor'), (d.get('lastWake') or {}).get('at')))
    time.sleep(4)
