import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .filter(code => code.trim());
assert.ok(scripts.length >= 1, 'No inline game script was found');
for (const [index, code] of scripts.entries()) {
  new vm.Script(code, { filename: `index.html:inline-script-${index + 1}` });
}
for (const required of [
  '방 코드로 입장',
  'netJoinCodeBtn',
  'copyRoomCodeBtn',
  'room:create',
  'room:join',
  'room:ready',
  'room:start',
  'room:quick',
  'room:heartbeat',
  'BUILT_IN_NET_SERVER_URL',
]) {
  assert.ok(html.includes(required), `Expected online client feature missing: ${required}`);
}
console.log(`Client syntax OK (${scripts.length} inline script block(s)); online lobby hooks found.`);
