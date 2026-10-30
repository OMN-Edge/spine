// Compare a site's web app with a build of the same commit: `node scripts/verify-build.mjs https://spine.example.com [web/dist]`.
//
// It fetches the site's hashes.txt and then every file it lists, and checks each served file against its line. With a second argument, a folder
// you built yourself (`npm ci && npm run build`, at the commit the operator says they run), it also checks that your hashes.txt is the same
// file. The first check says the site is consistent; only the second says it is the code you can read. Exit 0 only when everything matches.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [site, built] = process.argv.slice(2);
if (!site || !/^https?:\/\//.test(site)) {
  console.error('usage: node scripts/verify-build.mjs <https://site> [folder of your own build, e.g. web/dist]');
  process.exit(2);
}
const base = site.replace(/\/+$/, '');
const get = async url => {
  const reply = await fetch(url, { redirect: 'error' });
  if (!reply.ok) throw new Error(`${url}: ${reply.status}`);
  return Buffer.from(await reply.arrayBuffer());
};

const served = (await get(`${base}/hashes.txt`)).toString('utf8');
const lines = served.split('\n').filter(Boolean).map(line => {
  const match = line.match(/^([0-9a-f]{64}) {2}(\S+)$/);
  if (!match) throw new Error(`not a line of hashes.txt: ${line}`);
  return { hash: match[1], file: match[2] };
});

const problems = [];
for (const { hash, file } of lines) {
  const actual = crypto.createHash('sha256').update(await get(`${base}/${file.split('/').map(encodeURIComponent).join('/')}`)).digest('hex');
  if (actual !== hash) problems.push(`${file}: the site serves ${actual}, its hashes.txt says ${hash}`);
}
if (built) {
  const own = fs.readFileSync(path.join(built, 'hashes.txt'), 'utf8');
  if (own !== served) {
    const mine = new Map(own.split('\n').filter(Boolean).map(l => [l.slice(66), l.slice(0, 64)]));
    const theirs = new Map(lines.map(l => [l.file, l.hash]));
    for (const [file, hash] of theirs) if (mine.get(file) !== hash) problems.push(`${file}: ${mine.has(file) ? 'differs from your build' : 'is not in your build'}`);
    for (const file of mine.keys()) if (!theirs.has(file)) problems.push(`${file}: is in your build and not on the site`);
  }
}
if (problems.length > 0) {
  console.error(`FAIL ${base} does not match:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`ok: ${lines.length} files served by ${base} match its hashes.txt${built ? ` and your build in ${built}` : ' (not compared with a build of your own)'}`);
