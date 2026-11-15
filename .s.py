import json,io,time
p='/root/.dsh/phone-bridge/inbox-state.json'
for i in range(3):
    d=json.load(io.open(p,encoding='utf-8'))
    w=d.get('lastWake') or {}
    print('sample%d cursor=%s at=%s prev=%s' % (i, d.get('cursor'), w.get('at'), str(w.get('preview'))[:26].replace('\n',' ')))
    time.sleep(4)
