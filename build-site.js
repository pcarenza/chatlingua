import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
const files = [
  ['/', 'index.html', 'text/html'],
  ['/style.css', 'style.css', 'text/css'],
  ['/app.js', 'app.js', 'text/javascript'],
  ['/i18n.js', 'i18n.js', 'text/javascript'],
  ['/android-bridge.js', 'android-bridge.js', 'text/javascript'],
];
const assets = Object.fromEntries(await Promise.all(files.map(async ([path, name, type]) => [
  path, { type, body: await readFile(name, 'utf8') },
])));
await mkdir('dist/server', { recursive: true });
const worker = (await readFile('worker.js', 'utf8')).replace("import { assets } from './assets.js';", 'const assets = ' + JSON.stringify(assets) + ';');
await writeFile('dist/server/index.js', worker);
