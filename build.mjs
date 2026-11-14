// Compile src/*.ts to dist/*.js with Node's own type stripper. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist');
for (const f of fs.readdirSync('src').filter((f) => f.endsWith('.ts'))) {
  const js = stripTypeScriptTypes(fs.readFileSync(path.join('src', f), 'utf8'), { mode: 'strip' })
    .replace(/(from\s+'\.\/[\w-]+)\.ts'/g, "$1.js'")
    .replace(/import\s*\{\s*([^}]*?)type\s+\w+\s*,?\s*([^}]*)\}/g, (m, a, b) => `import { ${(a + b).replace(/,\s*$/, '')} }`);
  fs.writeFileSync(path.join('dist', f.replace(/\.ts$/, '.js')), js);
}
console.log('built dist/');
