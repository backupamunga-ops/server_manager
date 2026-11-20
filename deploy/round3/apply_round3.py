#!/usr/bin/env python3
"""Apply the Drevanta round-3 changes to /opt/cloudlane-src on the VPS.
Idempotent: safe to run repeatedly. Steps:
  1. Drop in the rebuilt tool pages (static/tools/*).
  2. Replace the mail module (controller + stack controller + module).
  3. Patch storage controller: allow empty files, hide .mail/ prefix, walk filter.
Run on the VPS: python3 apply_round3.py
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else '/opt/cloudlane-src')
STATIC = ROOT / 'apps/dashboard/static/tools'
API = ROOT / 'apps/api/src/modules'
ok = True


def run(cmd):
    global ok
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if r.returncode != 0:
        ok = False
        print(f'!! FAILED: {cmd}\n{r.stdout[-400:]}\n{r.stderr[-400:]}')
    return r


def anchor_patch(path, old, new, count=1):
    s = path.read_text()
    if new in s and old not in s:
        print(f'  already applied: {path.name}')
        return
    c = s.count(old)
    if c != count:
        print(f'!! anchor mismatch in {path.name}: x{c} (want {count}) for {old[:60]!r}')
        global ok
        ok = False
        return
    path.write_text(s.replace(old, new))
    print(f'  patched: {path.name}')


HERE = Path(__file__).parent

print('1. tool pages → static/tools')
for name in ['theme.css', 'theme.js']:
    shutil.copy(HERE / 'tools' / name, STATIC / name)
for name in ['index.html', 'styles.css', 'app.js', 'logo.png']:
    shutil.copy(HERE / 'tools' / 'mail' / name, STATIC / 'mail' / name)
for name in ['index.html', 'logo.png']:
    shutil.copy(HERE / 'tools' / 'files' / name, STATIC / 'files' / name)
print('  copied theme.css, theme.js, mail/*, files/*')

print('2. mail module → api')
shutil.copy(HERE / 'api' / 'mail.controller.ts', API / 'mail' / 'mail.controller.ts')
shutil.copy(HERE / 'api' / 'mail-stack.controller.ts', API / 'mail' / 'mail-stack.controller.ts')
shutil.copy(HERE / 'api' / 'mail.module.ts', API / 'mail' / 'mail.module.ts')
print('  wrote mail.controller.ts, mail-stack.controller.ts, mail.module.ts')

print('3. storage controller patches')
sc = API / 'storage' / 'storage.controller.ts'
anchor_patch(sc,
    "          if (nodes.length >= 1200) break;\n          nodes.push({ key: f.key, name: f.name, type: 'folder', size: 0, lastModified: null });",
    "          if (nodes.length >= 1200 || f.key.startsWith('.mail/')) continue;\n          nodes.push({ key: f.key, name: f.name, type: 'folder', size: 0, lastModified: null });")
anchor_patch(sc,
    "        for (const f of lvl.files) {\n          if (nodes.length >= 1200) break;\n          nodes.push({ key: f.key, name: f.name, type: 'file', size: f.size, lastModified: f.lastModified });\n        }",
    "        for (const f of lvl.files) {\n          if (nodes.length >= 1200 || f.key.startsWith('.mail/')) continue;\n          nodes.push({ key: f.key, name: f.name, type: 'file', size: f.size, lastModified: f.lastModified });\n        }")
anchor_patch(sc,
    "    const listing = await this.objects.list(bucket.name, prefix);\n    if (deepRaw === '1') {",
    "    const listing = await this.objects.list(bucket.name, prefix);\n    listing.folders = listing.folders.filter((f) => !f.key.startsWith('.mail/'));\n    listing.files = listing.files.filter((f) => !f.key.startsWith('.mail/'));\n    if (deepRaw === '1') {")

print('4. allow empty-file creation (New file)')
anchor_patch(sc,
    "    if (!file?.buffer?.length) throw new BadRequestException('No file in request.');",
    "    if (!file) throw new BadRequestException('No file in request.');")

print('5. commit')
run('cd /opt/cloudlane-src && git add -A && git -c user.email=z@container -c user.name="Z User" commit -q -m "feat(tools): round 3 — design-system theme bridge for tool windows, mail sidebar rework + attachments, files fixes, mail-stack API" || true')

print('OK' if ok else 'DONE WITH ERRORS')
sys.exit(0 if ok else 1)
