const fs = require('fs');
const path = require('path');
const dir = '/root/.dsh/storages/session_projcache/sessions';
const targets = JSON.parse(process.argv[2] || '{}');
for (const [id, title] of Object.entries(targets)) {
  const f = path.join(dir, id + '.json');
  if (!fs.existsSync(f)) { console.log('MISS', id.slice(8, 16)); continue; }
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const rows = d.record.rows;
  const prev = rows.title;
  rows.title = { ver: (prev && prev.ver) || 1, seq: ((prev && prev.seq) || 0) + 1, val: title };
  fs.writeFileSync(f, JSON.stringify(d));
  console.log('SET', id.slice(8, 16), '->', title);
}
