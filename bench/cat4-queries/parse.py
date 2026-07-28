#!/usr/bin/env python
"""Parse postgres stderr log slice between two markers; count queries + durations."""
import re, sys, collections

start_mark, end_mark, path = sys.argv[1], sys.argv[2], sys.argv[3]
raw = open(path, encoding='utf-8', errors='replace').read().splitlines()

ENTRY = re.compile(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+ \w+ \[(\d+)\] (\w+):\s\s?(.*)$')

# group continuation lines
entries = []  # (pid, level, text)
for line in raw:
    m = ENTRY.match(line)
    if m:
        entries.append([m.group(1), m.group(2), m.group(3)])
    elif entries:
        entries[-1][2] += '\n' + line

# slice between markers
s = e = None
for i, (pid, lvl, txt) in enumerate(entries):
    if start_mark in txt and 'statement:' in txt:
        s = i
    if end_mark in txt and 'statement:' in txt and s is not None and e is None and i > s:
        e = i
if s is None:
    sys.exit('start marker not found')
if e is None:
    e = len(entries)
sl = entries[s+1:e]

DUR_SQL = re.compile(r'^duration: ([\d.]+) ms\s+(parse|bind|execute) [^:]*: (.*)$', re.S)
DUR_STMT = re.compile(r'^duration: ([\d.]+) ms\s+statement: (.*)$', re.S)
BARE = re.compile(r'^duration: ([\d.]+) ms$')
EXEC = re.compile(r'^(execute|statement:)\s*(?:[^:]*: )?(.*)$', re.S)

def norm(sql):
    sql = re.sub(r'\s+', ' ', sql).strip()
    return sql

queries = []          # dicts: sql, parse, bind, exec
pending = {}          # pid -> current query dict awaiting bare duration
for pid, lvl, txt in sl:
    if lvl != 'LOG':
        continue
    m = DUR_SQL.match(txt)
    if m:
        dur, phase, sql = float(m.group(1)), m.group(2), norm(m.group(3))
        if phase == 'parse':
            pending[pid] = {'sql': sql, 'parse': dur, 'bind': 0.0, 'exec': 0.0, 'pid': pid}
        elif phase == 'bind':
            q = pending.get(pid)
            if q is None or q['sql'] != sql:
                q = {'sql': sql, 'parse': 0.0, 'bind': 0.0, 'exec': 0.0, 'pid': pid}
                pending[pid] = q
            q['bind'] += dur
        continue
    if txt.startswith('execute'):
        sql = norm(txt.split(': ', 1)[1]) if ': ' in txt else ''
        q = pending.get(pid)
        if q is None or q['sql'] != sql:
            q = {'sql': sql, 'parse': 0.0, 'bind': 0.0, 'exec': 0.0, 'pid': pid}
            pending[pid] = q
        q['_awaiting'] = True
        continue
    if txt.startswith('statement:'):
        sql = norm(txt.split(':', 1)[1])
        q = {'sql': sql, 'parse': 0.0, 'bind': 0.0, 'exec': 0.0, 'pid': pid, '_awaiting': True}
        pending[pid] = q
        continue
    m = BARE.match(txt.strip())
    if m:
        q = pending.get(pid)
        if q is not None and q.get('_awaiting'):
            q['exec'] = float(m.group(1))
            q.pop('_awaiting')
            queries.append(q)
            pending.pop(pid, None)
        continue

for q in queries:
    q['total'] = q['parse'] + q['bind'] + q['exec']

print(f'QUERY COUNT: {len(queries)}')
print(f'TOTAL DB TIME (parse+bind+exec): {sum(q["total"] for q in queries):.2f} ms')
print()
print('--- all queries, slowest first (total ms | exec ms) ---')
for q in sorted(queries, key=lambda x: -x['total']):
    print(f'{q["total"]:8.2f} | {q["exec"]:8.2f} | {q["sql"][:220]}')
print()
print('--- duplicate shapes (N+1 candidates) ---')
c = collections.Counter(q['sql'] for q in queries)
for sql, n in c.most_common():
    if n > 1:
        print(f'  x{n}  {sql[:200]}')
