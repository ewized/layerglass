"""Check portable documentation links, vault JSON, and release version alignment."""

import json
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent.parent
documents = [ROOT / 'README.md', ROOT / 'AGENTS.md', *sorted((ROOT / 'docs').rglob('*.md')),
             *sorted((ROOT / '.agents').rglob('SKILL.md'))]
failures = []
for document in documents:
    if not document.is_file():
        failures.append(f'Missing {document.relative_to(ROOT)}')
        continue
    # Ignore example links inside fenced code; allow normal inline code labels.
    text = re.sub(r'^```[^\n]*\n.*?^```\s*$', '', document.read_text(), flags=re.M | re.S)
    for target in re.findall(r'!?\[[^\]]*\]\(([^)]+)\)', text):
        target = target.strip().split(' "', 1)[0].strip('<>')
        parsed = urlsplit(target)
        if parsed.scheme or parsed.netloc or not parsed.path:
            continue
        path = (document.parent / unquote(parsed.path)).resolve()
        if not path.is_relative_to(ROOT) or not path.exists():
            failures.append(f'{document.relative_to(ROOT)}: broken local link {target}')

for path in sorted((ROOT / 'docs/.obsidian').glob('*.json')):
    json.loads(path.read_text())
version = (ROOT / 'VERSION').read_text().strip()
if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?', version):
    failures.append('VERSION must be a release version without a v prefix')
package = json.loads((ROOT / 'package.json').read_text())
lock = json.loads((ROOT / 'package-lock.json').read_text())
if any(value != version for value in [package.get('version'), lock.get('version'), lock['packages'][''].get('version')]):
    failures.append('VERSION, package.json and package-lock.json must agree')
if failures:
    raise SystemExit('\n'.join(failures))
print(f'Validated {len(documents)} linked Markdown documents, Obsidian settings and version {version}.')
