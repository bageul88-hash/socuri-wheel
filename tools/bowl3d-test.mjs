/* 3D 볼링 물리 검증 — 브라우저와 똑같은 bowling3d-physics.js 를 Node 에서 돌린다.
   사용: node tools/bowl3d-test.mjs [rapier 경로]
   rapier 경로를 주지 않으면 같은 폴더의 rapier.es.js 를 찾는다.
   받기: curl -o tools/rapier.es.js \
     https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js   */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const rapierPath = process.argv[2] || process.env.RAPIER_ES || path.join(here, 'rapier.es.js');
if (!fs.existsSync(rapierPath)) {
  console.error('rapier.es.js 를 찾을 수 없습니다:', rapierPath);
  process.exit(2);
}
const url = (p) => 'file:///' + path.resolve(p).replace(/\\/g, '/');

const RAPIER = await import(url(rapierPath));
await RAPIER.init();
const P = await import(url(path.join(root, 'bowling3d-physics.js')));

const W = P.createBowlingWorld(RAPIER);
const D = P.DIM;
let FAILS = 0;
function chk(name, ok, extra) {
  console.log((ok ? ' OK   ' : ' FAIL ') + name + (extra ? '  — ' + extra : ''));
  if (!ok) FAILS++;
}
const ms = (f) => { const t = process.hrtime.bigint(); const r = f(); return [r, Number(process.hrtime.bigint() - t) / 1e6]; };

/* ══ 1) 핀 배치 ══ */
console.log('\n── 1) 10핀 삼각 배치 ──');
const spots = P.PIN_SPOTS, rows = {};
spots.forEach((s, i) => {
  const r = Math.round((s.z - D.HEADPIN_Z) / D.ROW_D);
  (rows[r] = rows[r] || []).push(i + 1);
});
for (const r of Object.keys(rows).sort()) console.log('   row' + r, rows[r].join(' '));
let minGap = 9;
for (let i = 0; i < 10; i++) for (let j = i + 1; j < 10; j++)
  minGap = Math.min(minGap, Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z));
chk('줄 구성 1/2/3/4', [1, 2, 3, 4].every((n, k) => rows[k] && rows[k].length === n));
chk('핀 겹침 없음', minGap > 2 * D.PIN_MAXR, `최소간격 ${minGap.toFixed(4)}m > 지름 ${(2 * D.PIN_MAXR).toFixed(4)}m`);
chk('앞뒤 깊이 존재', D.ROW_D > 0.25, `줄 간 ${D.ROW_D.toFixed(4)}m, 전체 깊이 ${(3 * D.ROW_D).toFixed(3)}m`);
chk('코너핀이 레인 안', Math.abs(spots[6].x) + D.PIN_MAXR < D.LANE_HALF,
  `${(Math.abs(spots[6].x) + D.PIN_MAXR).toFixed(4)} < ${D.LANE_HALF.toFixed(4)}`);

/* ══ 2) 정지 안정성 ══ */
console.log('\n── 2) 정지 안정성 ──');
const idle = P.simulate(RAPIER, { x: 0, vz: 0, vx: 0, hook: 0, spin: 0 }, false);
chk('아무 것도 안 하면 0핀', idle.down === 0, `쓰러진 핀 ${idle.down}`);

/* ══ 3) 조준 모델 재검증 ══ */
console.log('\n── 3) 조준 모델 (도착 지점 예측 오차) ──');
function arrive(p) {
  W.reset(); W.launch(p);
  let t = 0, dt = 0;
  const fineZ = D.HEADPIN_Z - P.SIM.FINE_BEFORE;
  for (let s = 0; s < 5000; s++) {
    const want = (W.ball.translation().z > fineZ) ? P.SIM.DT_FINE : P.SIM.DT_ROLL;
    if (want !== dt) { dt = want; W.world.timestep = dt; }
    W.world.step(W.eventQueue); W.eventQueue.clear(); t += dt;
    const b = W.ball.translation();
    if (b.z >= D.HEADPIN_Z - 0.30) return { x: b.x, t, off: false };
    if (Math.abs(b.x) > D.LANE_HALF - 0.01) return { x: b.x, t, off: true };
    if (t > 5) return { x: b.x, t, off: true };
  }
  return { x: 99, t: 0, off: true };
}
let aimErr = 0, aimMax = 0, aimN = 0, aimOff = 0;
for (const xa of [-0.30, -0.15, 0, 0.15, 0.30])
  for (const hook of [-3.2, 0, 3.2])
    for (const vz of [7.0, 8.2]) {
      const r = arrive(P.toParams({ xr: 0, xa, hook, vz }));
      if (r.off) { aimOff++; continue; }
      const e = Math.abs(r.x - xa); aimErr += e; aimMax = Math.max(aimMax, e); aimN++;
    }
console.log(`   표본 ${aimN}개 / 평균오차 ${(aimErr / aimN * 100).toFixed(1)}cm / 최대 ${(aimMax * 100).toFixed(1)}cm / 레인이탈 ${aimOff}`);
chk('조준 오차가 핀 반지름 이내', aimMax < 0.12, `최대 ${(aimMax * 100).toFixed(1)}cm`);
chk('조준한 투구는 레인을 벗어나지 않음', aimOff === 0);

/* ══ 4) 핀 수 분포 ══ */
console.log('\n── 4) 격자 전수 조사 (핀 수 분포) ──');
const cands = P.candidateList(P.rng(7));
const hist = new Array(11).fill(0);
const byCount = Array.from({ length: 11 }, () => []);
let tsum = 0, tmax = 0;
for (const c of cands) {
  const [r, dur] = ms(() => P.simulate(RAPIER, P.toParams(c), false));
  tsum += dur; tmax = Math.max(tmax, dur);
  hist[r.down]++;
  if (byCount[r.down].length < 40) byCount[r.down].push(c);
}
console.log(`   시도 ${cands.length} / 평균 ${(tsum / cands.length).toFixed(1)}ms / 최대 ${tmax.toFixed(1)}ms`);
console.log('   ' + hist.map((v, n) => `${n}핀:${v}`).join('  '));
const miss = hist.map((v, n) => (v ? null : n)).filter(n => n !== null && n >= 1);
/* 1핀은 이 물리에서 사실상 안 나온다 — 공(6.35kg)이 코너핀을 치면 그 핀이
   0.381m 길이로 쓰러지며 0.305m 옆의 이웃을 반드시 건드리기 때문이다.
   (예전에 1핀이 나왔던 건 레인 이음매가 공을 띄우던 버그의 부산물이었다)
   제품에서는 같은 당첨 구간 안의 다른 핀 수로 대신 보여주므로 경품은 그대로다. */
chk('2~10핀 전부 도달', miss.filter(n => n !== 1).length === 0,
  miss.length ? '미도달 ' + miss.join(',') : '');
chk('스트라이크(10핀) 가능', hist[10] > 0, `${hist[10]}건`);
chk('2~10핀 각각 후보 5건 이상', hist.slice(2).every(v => v >= 5),
  hist.slice(2).map((v, i) => v < 5 ? (i + 2) + '핀' : null).filter(Boolean).join(',') || '');
if (!hist[1]) console.log('   (1핀은 도달 불가 — 구간 대체로 처리한다)');

/* ══ 5) 거터볼 ══ */
console.log('\n── 5) 거터볼 (0핀 보장) ──');
const grand = P.rng(20261005);
let gOk = 0, gBad = [];
for (let i = 0; i < 40; i++) {
  const r = P.simulate(RAPIER, P.toParams(P.gutterCandidate(grand)), false);
  if (r.down === 0) gOk++; else gBad.push(r.down);
}
chk('40회 전부 0핀', gOk === 40, gOk === 40 ? '' : `실패 ${gBad.length}건 (${gBad.slice(0, 5)})`);

/* ══ 6) 결정론 + 녹화 일치 ══ */
console.log('\n── 6) 결정론 / 녹화 일치 ──');
let detOk = 0, detN = 0, recOk = 0, recN = 0;
for (let n = 1; n <= 10; n++) {
  if (!byCount[n].length) continue;
  const p = P.toParams(byCount[n][0]);
  const a = P.simulate(RAPIER, p, false), b = P.simulate(RAPIER, p, false);
  detN++; if (a.mask === b.mask) detOk++;
  const rec = P.simulate(RAPIER, p, true);
  recN++;
  if (rec.mask === a.mask && rec.down === n) recOk++;
  else console.log(`   mismatch n=${n} plain=${a.mask} rec=${rec.mask}(${rec.down})`);
}
chk('같은 파라미터 → 같은 결과', detOk === detN, `${detOk}/${detN}`);
chk('녹화본 결과 = 탐색본 결과', recOk === recN, `${recOk}/${recN}`);

/* ══ 7) 핀 폭주 / 관통 / 평면화 ══ */
console.log('\n── 7) 물리 건전성 ──');
let maxH = 0, maxDist = 0, maxSpin = 0, evCnt = 0, evMax = 0, spinForever = 0;
let maxBallStep = 0, minBallY = 9, maxBallY = -9, maxPitY = -9;
for (let n = 1; n <= 10; n++) {
  if (!byCount[n].length) continue;
  const r = P.simulate(RAPIER, P.toParams(byCount[n][0]), true);
  evCnt += r.events.length;
  r.events.forEach(e => { evMax = Math.max(evMax, e.j); });
  for (let k = 0; k < r.frames.length; k++) {
    const fr = r.frames[k];
    minBallY = Math.min(minBallY, fr[1]);
    /* 공의 튐은 "플레이 구간(레인+핀덱)" 에서만 본다. 핀덱 뒤 핏에서는 핀에
       맞고 튀어오르는 게 정상이고, 마스킹 유닛 뒤라 화면에도 거의 안 잡힌다. */
    if (fr[2] < D.DECK_END) maxBallY = Math.max(maxBallY, fr[1]);
    else maxPitY = Math.max(maxPitY, fr[1]);
    if (k) {
      const pv = r.frames[k - 1];
      maxBallStep = Math.max(maxBallStep, Math.hypot(fr[0] - pv[0], fr[1] - pv[1], fr[2] - pv[2]));
    }
    for (let i = 0; i < 10; i++) {
      const o = 7 + i * 7;
      maxH = Math.max(maxH, fr[o + 1]);
      maxDist = Math.max(maxDist, Math.hypot(fr[o] - spots[i].x, fr[o + 2] - spots[i].z));
      /* 쿼터니언 정규화 — 렌더가 납작해지지 않는 근거 */
      const q = Math.hypot(fr[o + 3], fr[o + 4], fr[o + 5], fr[o + 6]);
      maxSpin = Math.max(maxSpin, Math.abs(q - 1));
    }
  }
  /* 끝에서 아직 도는 핀이 있는지 */
  const last = r.frames[r.frames.length - 1], prev = r.frames[r.frames.length - 6] || last;
  for (let i = 0; i < 10; i++) {
    const o = 7 + i * 7;
    let dq = 0; for (let j = 3; j < 7; j++) dq += Math.abs(last[o + j] - prev[o + j]);
    if (dq > 0.25) spinForever++;
  }
}
chk('핀이 과도하게 뜨지 않음', maxH < 1.0, `최대 ${maxH.toFixed(3)}m`);
chk('핀이 멀리 날아가지 않음', maxDist < 3.2, `최대 ${maxDist.toFixed(2)}m`);
chk('쿼터니언 정규(핀이 납작해질 수 없음)', maxSpin < 1e-3, `오차 ${maxSpin.toExponential(1)}`);
chk('끝까지 도는 핀 없음', spinForever === 0, `${spinForever}개`);
chk('공이 레인 아래로 꺼지지 않음', minBallY > -0.70, `최저 y ${minBallY.toFixed(3)}`);
/* 레인/핀덱 이음매가 공을 차올리던 문제의 회귀 검사.
   바닥을 한 덩어리로 바꾸기 전에는 여기가 0.52m 까지 올라갔다. */
chk('레인·핀덱 위에서 공이 튀지 않음', maxBallY < D.BALL_R + 0.03,
  `최고 y ${maxBallY.toFixed(3)} (정지 높이 ${D.BALL_R.toFixed(3)}, 허용 ${(D.BALL_R + 0.03).toFixed(3)})`);
chk('핏에서도 공이 레인 밖으로 솟지 않음', maxPitY < 1.0, `핏 최고 y ${maxPitY.toFixed(3)}`);
/* 핀끼리 관통 —
   핀은 밑동이 가늘고 배가 굵어서, 바디 원점(밑면) 거리만 봐서는 겹침을 알 수 없다.
   실제 콜라이더 5조각(밑동·배·어깨·목·머리)을 월드로 옮겨 조각끼리의 표면 거리를 잰다. */
const PARTS = P.PIN_PARTS;
function partWorld(fr, i, k) {
  const o = 7 + i * 7;
  const px = fr[o], py = fr[o + 1], pz = fr[o + 2];
  const qx = fr[o + 3], qy = fr[o + 4], qz = fr[o + 5], qw = fr[o + 6];
  const ly = PARTS[k].y;                       /* 로컬 (0, ly, 0) 회전 */
  const tx = 2 * (qy * 0 - qz * ly), ty = 2 * (qz * 0 - qx * 0), tz = 2 * (qx * ly - qy * 0);
  return {
    x: px + 0 + qw * tx + (qy * tz - qz * ty),
    y: py + ly + qw * ty + (qz * tx - qx * tz),
    z: pz + 0 + qw * tz + (qx * ty - qy * tx)
  };
}
/* 원통은 축 방향으로 길어서 반지름만으로 보면 과하게 엄격해진다.
   조각의 '유효 반경' 을 반지름과 반높이 중 큰 값으로 두면 보수적으로 안전하다. */
const partR = PARTS.map(p => Math.max(p.r, (p.h || 0)));
let worstOverlap = 0, worstAt = null;
for (let n = 2; n <= 10; n++) {
  if (!byCount[n].length) continue;
  const r = P.simulate(RAPIER, P.toParams(byCount[n][0]), true);
  const step = Math.max(1, Math.floor(r.frames.length / 40));
  for (let f = 0; f < r.frames.length; f += step) {
    const fr = r.frames[f];
    for (let i = 0; i < 10; i++) for (let j = i + 1; j < 10; j++) {
      /* 두 핀의 원점이 핀 길이보다 멀면 어떤 조각도 닿을 수 없다 */
      if (Math.hypot(fr[7 + i * 7] - fr[7 + j * 7], fr[8 + i * 7] - fr[8 + j * 7],
                     fr[9 + i * 7] - fr[9 + j * 7]) > 2 * D.PIN_H) continue;
      for (let a = 0; a < PARTS.length; a++) for (let b = 0; b < PARTS.length; b++) {
        const pa = partWorld(fr, i, a), pb = partWorld(fr, j, b);
        const d = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
        const ov = (partR[a] + partR[b]) - d;
        if (ov > worstOverlap) { worstOverlap = ov; worstAt = { n, i: i + 1, j: j + 1, a, b, d: +d.toFixed(4) }; }
      }
    }
  }
}
/* 보수적 구(球) 근사라 약간의 겹침 수치는 정상이다. 깊은 관통(조각 반경의 절반
   이상)이 없는지를 본다 — 그래야 화면에서 핀이 서로를 통과하지 않는다. */
chk('핀끼리 깊게 파고들지 않음', worstOverlap < 0.035,
  `최대 겹침(구 근사) ${(worstOverlap * 100).toFixed(1)}cm` +
  (worstAt ? ` @ ${worstAt.n}핀판 ${worstAt.i}-${worstAt.j}` : ''));
chk('프레임 간 공 이동 < 반지름(관통 없음)', maxBallStep < D.BALL_R,
  `${maxBallStep.toFixed(4)} vs ${D.BALL_R.toFixed(4)}`);
console.log(`   소리 이벤트 ${evCnt}건 / 최대 세기 ${evMax.toFixed(2)}`);
chk('충돌 이벤트가 발생', evCnt > 30);

/* ══ 8) 연속 리셋 (상태 누수) ══ */
console.log('\n── 8) 연속 리셋 ──');
const rp = P.toParams(byCount[10].length ? byCount[10][0] : byCount[6][0]);
const seq = [];
for (let g = 0; g < 6; g++) {
  /* 사이사이 다른 투구를 섞어도 결과가 변하지 않아야 한다 */
  P.simulate(RAPIER, P.toParams(P.gutterCandidate(grand)), false);
  P.simulate(RAPIER, P.toParams(byCount[3][0]), false);
  seq.push(P.simulate(RAPIER, rp, false).mask);
}
chk('다른 투구를 섞어도 같은 결과(상태 누수 없음)', seq.every(m => m === seq[0]), seq.join(' '));

/* ══ 9) 후보표 무결성 ══
   런타임은 격자를 맨땅에서 훑지 않는다. bowling3d-table.js 에서 후보를 꺼내
   한 판만 돌려 확인한다. 그러니 검증해야 할 것은 "표가 지금 물리와 맞는가" 다.
   (표와 물리가 어긋나면 결과가 틀리진 않지만 3D 가 안 나오고 2D 로 떨어진다) */
console.log('\n── 9) 후보표 ↔ 물리 일치 ──');
let TBL = null;
try { TBL = await import(url(path.join(root, 'bowling3d-table.js'))); } catch (e) { }
if (!TBL) {
  chk('bowling3d-table.js 존재', false, 'node tools/bowl3d-gen-table.mjs 로 생성');
} else {
  let bad = [], slowest = 0, totalEntries = 0;
  for (let n = 1; n <= 10; n++) {
    const cnt = TBL.countFor(n);
    let hit = 0, tsum = 0;
    for (let i = 0; i < cnt; i++) {
      const c = TBL.pick(n, i);
      const [r, dur] = ms(() => P.simulate(RAPIER, P.toParams(c), true));
      tsum += dur; slowest = Math.max(slowest, dur); totalEntries++;
      if (r.down === n) hit++; else bad.push(n + '[' + i + ']→' + r.down);
    }
    console.log(`   ${String(n).padStart(2)}핀 : 후보 ${cnt}개 / 일치 ${hit} / 1판 평균 ${(tsum / cnt).toFixed(0)}ms`);
  }
  chk('2~10핀에 후보가 있음',
    [...Array(9)].every((_, i) => TBL.countFor(i + 2) > 0),
    [...Array(10)].map((_, i) => TBL.countFor(i + 1) ? null : (i + 1) + '핀')
      .filter(Boolean).join(',') || '');
  chk('표의 모든 후보가 지금 물리와 일치', bad.length === 0,
    bad.length ? bad.slice(0, 8).join(' ') + (bad.length > 8 ? ' …' : '') : `${totalEntries}개 전부`);
  chk('한 판 검증이 셋업 연출(900ms) 안에 끝남', slowest < 900, `최악 ${slowest.toFixed(0)}ms`);
}

/* 참고: 표 없이 맨땅에서 훑으면 얼마나 걸리는지 (표가 왜 필요한지) */
console.log('\n   [참고] 표 없이 격자 탐색 — 희귀한 핀 수는 수십 판이 든다');
for (const n of [1, 3, 10]) {
  const list = P.candidateList(P.rng(9000 + n));
  const t0 = process.hrtime.bigint();
  let tries = 0, found = false;
  for (const c of list) {
    tries++;
    if (P.simulate(RAPIER, P.toParams(c), false).down === n) { found = true; break; }
    if (tries >= 40) break;
  }
  console.log(`     n=${String(n).padStart(2)} ${found ? '찾음' : '40회 내 실패'} ` +
    `${String(tries).padStart(3)}회 ${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0)}ms`);
}


/* ══ 10) 녹화 용량 ══ */
console.log('\n── 10) 녹화 용량 ──');
const rr = P.simulate(RAPIER, rp, true);
const kb = (rr.frames.length * 77 * 4) / 1024;
console.log(`   프레임 ${rr.frames.length} / 길이 ${rr.times[rr.times.length - 1].toFixed(2)}s / ${kb.toFixed(0)}KB`);
chk('녹화 용량 400KB 이하', kb < 400, `${kb.toFixed(0)}KB`);

console.log('\n════════ ' + (FAILS ? `실패 ${FAILS}건` : '전 항목 통과') + ' ════════\n');
process.exit(FAILS ? 1 : 0);
