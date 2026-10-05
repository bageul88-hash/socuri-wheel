/* 핀 수별 투구 후보 표를 미리 만들어 bowling3d-table.js 로 떨어뜨린다.

   왜 필요한가: 추첨이 먼저 결과(핀 수)를 정하는 기존 계약 때문에, 런타임은
   "그 핀 수가 나오는 투구" 를 찾아야 한다. 맨땅에서 격자를 훑으면 1·2핀 같은
   희귀한 결과는 80번을 넘게 돌려야 해서 (≈8초) 브라우저에서 쓸 수 없다.
   그래서 후보를 미리 찾아 표로 박아두고, 런타임은 한 판만 돌려 확인한다.

   사용: node tools/bowl3d-gen-table.mjs [per=24] [rapier 경로]                 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const PER = parseInt(process.argv[2] || '24', 10);
const rapierPath = process.argv[3] || path.join(here, 'rapier.es.js');
const url = (p) => 'file:///' + path.resolve(p).replace(/\\/g, '/');

const RAPIER = await import(url(rapierPath));
await RAPIER.init();
const P = await import(url(path.join(root, 'bowling3d-physics.js')));

const r3 = (v) => Math.round(v * 1000) / 1000;
const found = Array.from({ length: 11 }, () => []);
let tries = 0;
const t0 = Date.now();

function tryCand(c) {
  tries++;
  const cc = { xa: r3(c.xa), hook: r3(c.hook), vz: r3(c.vz), xr: r3(c.xr) };
  const n = P.simulate(RAPIER, P.toParams(cc), false).down;
  if (n >= 1 && n <= 10 && found[n].length < PER) {
    /* 반올림한 값 그대로 다시 확인 — 표에 적히는 값이 곧 검증된 값이어야 한다 */
    const again = P.simulate(RAPIER, P.toParams(cc), false).down;
    if (again === n) found[n].push(cc);
  }
  return n;
}
const need = () => found.slice(1).some(a => a.length < PER);
function progress(tag) {
  const el = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`[${el}s ${tries}회] ${tag}  ` +
    found.slice(1).map((a, i) => `${i + 1}:${a.length}`).join(' '));
}

/* ── 1단계: 기본 격자 ── */
for (const c of P.candidateList(P.rng(4242))) {
  if (!need()) break;
  tryCand(c);
  if (tries % 200 === 0) progress('기본격자');
}
progress('기본격자 끝');

/* ── 2단계: 코너핀만 걷어내는 얕은 투구 (1·2핀 전용) ── */
outer:
for (const side of [1, -1])
  for (let xa = 0.425; xa >= 0.345; xa -= 0.004)
    for (const hook of [0, 0.4, -0.4, 0.9, -0.9, 1.5, -1.5])
      for (const vz of [6.6, 7.1, 7.6, 8.1, 8.6, 9.0])
        for (const xr of [0.26 * side, 0, -0.26 * side]) {
          if (found[1].length >= PER && found[2].length >= PER) break outer;
          tryCand({ xa: side * xa, hook: side * hook, vz, xr });
          if (tries % 200 === 0) progress('코너핀');
        }
progress('코너핀 끝');

/* ── 3단계: 아직 모자란 핀 수는 채워진 후보 주변을 흔들어 채운다 ── */
const jr = P.rng(99);
for (let pass = 0; pass < 40 && need(); pass++) {
  for (let n = 1; n <= 10; n++) {
    if (found[n].length >= PER) continue;
    const seeds = found[n].length ? found[n]
      : (found[n - 1] || []).concat(found[n + 1] || []);
    if (!seeds.length) continue;
    for (let k = 0; k < 24 && found[n].length < PER; k++) {
      tryCand(P.jitter(seeds[Math.floor(jr() * seeds.length)], jr, 2.2));
    }
  }
  progress('흔들기 pass' + pass);
}
progress('최종');

/* ── 쓰기 ── */
const lines = [];
lines.push('/* ══════════════════════════════════════════════════════════════════');
lines.push('   bowling3d-table.js — 핀 수별 투구 후보표 (자동 생성)');
lines.push('');
lines.push('   tools/bowl3d-gen-table.mjs 가 Rapier 로 실제 시뮬레이션을 돌려,');
lines.push('   각 핀 수가 나오는 릴리스 후보를 찾아 적어둔 표다.');
lines.push('   한 줄은 [도착x, 훅, 속도, 릴리스x] 이며 toParams() 로 변환해 쓴다.');
lines.push('   런타임은 이 중 하나를 골라 한 판만 돌려 핀 수를 확인한다.');
lines.push('');
lines.push('   재생성:  node tools/bowl3d-gen-table.mjs');
lines.push('   물리 계수(TUNE)나 규격(DIM)을 바꾸면 반드시 다시 생성해야 한다.');
lines.push(`   생성 시각: ${new Date().toISOString().slice(0, 19)}Z / 시도 ${tries}회`);
lines.push('   ══════════════════════════════════════════════════════════════════ */');
lines.push('');
lines.push('export var TABLE = {');
for (let n = 1; n <= 10; n++) {
  const rows = found[n].map(c => `[${c.xa},${c.hook},${c.vz},${c.xr}]`);
  lines.push(`  ${n}: [` + rows.join(', ') + '],');
}
lines.push('};');
lines.push('');
lines.push('/* 후보 하나를 { xa, hook, vz, xr } 꼴로 꺼낸다 */');
lines.push('export function pick(n, i) {');
lines.push('  var a = TABLE[n]; if (!a || !a.length) return null;');
lines.push('  var r = a[((i % a.length) + a.length) % a.length];');
lines.push('  return { xa: r[0], hook: r[1], vz: r[2], xr: r[3] };');
lines.push('}');
lines.push('');
lines.push('export function countFor(n) { var a = TABLE[n]; return a ? a.length : 0; }');
lines.push('');
fs.writeFileSync(path.join(root, 'bowling3d-table.js'), lines.join('\n'), 'utf8');

console.log('\n── 결과 ──');
let short = [];
for (let n = 1; n <= 10; n++) {
  console.log(`  ${String(n).padStart(2)}핀 : ${found[n].length}개`);
  if (!found[n].length) short.push(n);
}
console.log(`\nbowling3d-table.js 기록 완료 (${tries}회 시뮬, ${((Date.now() - t0) / 1000).toFixed(0)}초)`);
if (short.length) {
  console.log('\n※ 후보 없음: ' + short.join(',') + '핀');
  console.log('  이 핀 수는 지금 물리로는 사실상 안 나온다는 뜻이다.');
  console.log('  런타임은 같은 당첨 구간 안의 다른 핀 수로 대신 보여준다');
  console.log('  (경품과 가중치는 구간이 정하므로 그대로다).');
}
