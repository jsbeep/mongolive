// 빌드에 함께 묶여 나가는 라이브러리(node_modules)의 라이선스 문구를 모아 THIRD-PARTY-LICENSES.txt로 내보낸다.
// MIT·ISC 같은 라이선스는 '배포할 때 원래 저작권·라이선스 문구를 같이 넣을 것'이 조건이라,
// 데모(GitHub Pages)와 서버가 내주는 dist에 이 파일을 함께 둔다. 실제로 번들에 들어간 패키지만 센다.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/i;
const NODE_MODULES = '/node_modules/';

// 모듈 경로 → 그 모듈이 든 패키지 폴더. pnpm(.pnpm/…/node_modules/이름)도 마지막 node_modules를 기준으로 본다
const packageRoot = (id: string): string | null => {
  const path = id.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
  const at = path.lastIndexOf(NODE_MODULES);
  if (at < 0) return null;
  const parts = path.slice(at + NODE_MODULES.length).split('/');
  const name = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return path.slice(0, at + NODE_MODULES.length) + name;
};

interface Entry {
  name: string;
  version: string;
  license: string;
  text: string;
}

const readEntry = (root: string): Entry | null => {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; version?: string; license?: string };
    const file = readdirSync(root).find((f) => LICENSE_FILE.test(f));
    const license = pkg.license ?? 'UNKNOWN';
    const text = file ? readFileSync(join(root, file), 'utf8').trim() : `(No license file in the package — declared license: ${license})`;
    return { name: pkg.name ?? root, version: pkg.version ?? '', license, text };
  } catch {
    return null;
  }
};

export function thirdPartyLicenses(fileName = 'THIRD-PARTY-LICENSES.txt'): Plugin {
  return {
    name: 'mongolive-third-party-licenses',
    apply: 'build',
    generateBundle(_options, bundle) {
      const roots = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of Object.keys(output.modules)) {
          const root = packageRoot(id);
          if (root) roots.add(root);
        }
      }
      const entries = new Map<string, Entry>();
      for (const root of Array.from(roots)) {
        const entry = readEntry(root);
        if (entry) entries.set(`${entry.name}@${entry.version}`, entry);
      }
      const sorted = Array.from(entries.values()).sort((a, b) => a.name.localeCompare(b.name));
      const header = [
        'mongolive — third-party software bundled into this web app',
        '',
        `${sorted.length} packages. Each section below is the package's own license text.`,
        'mongolive itself is MIT-licensed — see LICENSE in https://github.com/jsbeep/mongolive',
      ].join('\n');
      const sections = sorted.map((e) => [`${'='.repeat(72)}`, `${e.name}@${e.version} (${e.license})`, '', e.text].join('\n'));
      this.emitFile({ type: 'asset', fileName, source: `${[header, ...sections].join('\n\n')}\n` });
    },
  };
}
