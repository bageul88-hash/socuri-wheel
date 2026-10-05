/* 실제 브라우저(헤드리스 Chrome)에서 3D 볼링을 검증하고 스크린샷을 남긴다.

   사용: node tools/bowl3d-browser.mjs
   필요: puppeteer-core 와 로컬 Chrome. 아래 환경변수로 바꿀 수 있다.
     PUPPETEER_CORE   puppeteer-core 모듈 경로
     CHROME_PATH      Chrome 실행 파일 경로
   산출물: artifacts/bowling3d/*.png  +  콘솔 요약                            */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const OUT = path.join(ROOT, 'artifacts', 'bowling3d');
fs.mkdirSync(OUT, { recursive: true });

const PUP = process.env.PUPPETEER_CORE ||
  'C:/Users/USER/AppData/Local/Temp/claude/e--socuri-wheel/7c7f506a-799f-474c-bcd2-8f57057de2d2/scratchpad/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wasm': 'application/wasm'
};

/* ── 정적 서버 ── */
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); res.end('nope'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + server.address().port;
console.log('서버', BASE);

const pupUrl = /^[a-zA-Z]:[\\/]/.test(PUP)
  ? 'file:///' + PUP.replace(/\\/g, '/') : PUP;
const { default: puppeteer } = await import(pupUrl);
let FAILS = 0;
const chk = (name, ok, extra) => {
  console.log((ok ? ' OK   ' : ' FAIL ') + name + (extra ? '  — ' + extra : ''));
  if (!ok) FAILS++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    '--force-device-scale-factor=1']
});

async function session(label, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errs = [], warns = [], netErrs = [];
  /* 이 샌드박스에서는 Supabase 호스트가 DNS 로 안 풀린다. 그건 환경 문제라
     JS 오류와 섞지 않고 따로 센다. (볼링 변경과 무관한 기존 동작) */
  const isNet = (t) => /ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|Failed to load resource|Failed to fetch|NetworkError|spin save error|supabase/i.test(t);
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error') (isNet(t) ? netErrs : errs).push(t);
    else if (m.type() === 'warning') warns.push(t);
  });
  page.on('requestfailed', r => netErrs.push(r.url()));
  page.on('pageerror', e => (isNet(e.message) ? netErrs : errs).push('pageerror: ' + e.message));
  await page.goto(BASE + '/index.html?bowlingDebug=1', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('!!window.__bowl3dTest', { timeout: 20000 });
  await page.evaluate(() => window.__bowl3dTest.soundOff());
  const mounted = await page.evaluate(async () => {
    const h = await window.__bowl3dTest.enter();
    return !!h;
  });
  return { page, errs, warns, netErrs, mounted, label };
}
const shot = (s, name) => s.page.screenshot({ path: path.join(OUT, name) });
const st = (s) => s.page.evaluate(() => window.__bowl3dTest.state());
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ══════════════════ 데스크톱 ══════════════════ */
console.log('\n══ 데스크톱 1440x900 ══');
const dk = await session('desktop', { width: 1440, height: 900 });
chk('3D 모듈 마운트', dk.mounted);
await sleep(600);

/* ── READY ── */
let s = await st(dk);
chk('READY 카메라', s.camState === 'READY', 'cam=' + s.camState);
await shot(dk, '01-ready-desktop.png');

/* READY 구도 — 공이 화면 아래, 핀이 레인 끝, 네 줄이 모두 구분되는지 */
const rp = await dk.page.evaluate(() => window.__bowl3dTest.probe());
console.log(`   공 화면 y ${rp.ball.screen.y} / 1번핀 화면 y ${rp.pins[0].screen.y}`);
console.log(`   공 world z ${rp.ball.world.z} / 1번핀 world z ${rp.pins[0].world.z}`);
console.log('   줄별 화면 y ' + rp.rowY.join(' '));
chk('READY: 공이 화면 아래쪽', rp.ball.screen.y < -0.45, 'ndc y=' + rp.ball.screen.y);
chk('READY: 공이 파울라인 근처(핀 앞 아님)', rp.ball.world.z < 1.0, 'z=' + rp.ball.world.z);
chk('READY: 핀이 레인 끝', rp.pins[0].world.z > 18.0, 'z=' + rp.pins[0].world.z);
chk('READY: 핀이 공보다 화면 위', rp.pins[0].screen.y > rp.ball.screen.y + 0.4);
chk('READY: 레인 대부분이 보임(공↔핀 화면 간격)',
  (rp.pins[0].screen.y - rp.ball.screen.y) > 0.75,
  '간격 ' + (rp.pins[0].screen.y - rp.ball.screen.y).toFixed(3));
chk('READY: 핀 줄 순서가 앞→뒤로 올바름 (깊이 정상)',
  rp.rowY.every((y, i) => i === 0 || y > rp.rowY[i - 1]),
  rp.rowY.join(' '));
chk('READY: 모든 핀이 서 있음(최소 변 = 핀 지름 수준)',
  rp.pins.every(p => Math.min(...p.size) > 0.10 && p.size[1] > 0.37),
  JSON.stringify(rp.pins[0].size));

/* ── 한 판: FOLLOW / IMPACT 순간을 잡는다 ── */
console.log('\n-- 투구 (10핀 목표) --');
const t0 = Date.now();
const rollP = dk.page.evaluate(() => window.__bowl3dTest.rollExact(10));
let sawFollow = false, sawImpact = false, gotFollowShot = false, gotImpactShot = false;
let camSeq = [], impactProbe = null;
for (let i = 0; i < 300; i++) {
  const q = await st(dk);
  camSeq.push(q.camState);
  if (q.camState === 'FOLLOW') { sawFollow = true; if (!gotFollowShot) { await shot(dk, '02-follow-desktop.png'); gotFollowShot = true; } }
  if (q.camState === 'IMPACT') {
    sawImpact = true;
    if (!gotImpactShot && q.detail && q.detail.play && q.detail.play.hitAt >= 0) {
      await shot(dk, '03-impact-desktop.png'); gotImpactShot = true;
    }
    if (!impactProbe) impactProbe = await dk.page.evaluate(() => window.__bowl3dTest.probe());
  }
  if (!q.busy && i > 10) break;
  await sleep(60);
}
const res = await rollP;
console.log('   결과', JSON.stringify(res), ((Date.now() - t0) / 1000).toFixed(1) + 's');
chk('10핀 목표 달성 (STRIKE)', res.down === 10, 'down=' + res.down + ' mask=' + res.mask);
chk('카메라 READY→FOLLOW→IMPACT 경유', sawFollow && sawImpact,
  'follow=' + sawFollow + ' impact=' + sawImpact);
chk('FOLLOW 스크린샷', gotFollowShot);
chk('IMPACT 스크린샷', gotImpactShot);
await sleep(300);
await shot(dk, '04-after-strike-desktop.png');

/* 투구가 끝난 뒤에도 쓰러진 핀이 그대로 보여야 한다 (초기 포즈로 되돌아가면 버그) */
const ap = await dk.page.evaluate(() => window.__bowl3dTest.probe());
const minSide = Math.min(...ap.pins.map(p => Math.min(...p.size)));
const onSpot = ap.pins.filter((p, i) =>
  Math.abs(p.world.x - rp.pins[i].world.x) < 1e-3 &&
  Math.abs(p.world.z - rp.pins[i].world.z) < 1e-3 && p.size[1] > 0.37).length;
/* 화면에 보이는 핀 상태가 발표되는 핀 수와 같은지 —
   "본 것과 발표된 것이 다르다" 를 막는 가장 중요한 검사 */
const visiblyDown = (p, i) => p.tilt > 40 || p.world.y < -0.20 ||
  Math.hypot(p.world.x - rp.pins[i].world.x, p.world.z - rp.pins[i].world.z) > 0.085;
const seenDown = ap.pins.filter(visiblyDown).length;
console.log('   투구 후 기울기(도) ' + ap.pins.map(p => p.tilt.toFixed(0)).join(' '));
console.log(`   화면상 쓰러진 핀 ${seenDown} / 발표 ${ap.down} / 제자리 직립 ${onSpot} / AABB 최소변 ${minSide.toFixed(4)}m`);
chk('스트라이크 후 결과 포즈 유지(초기 포즈로 안 돌아감)', onSpot === 0, '제자리 직립 ' + onSpot);
chk('화면에 보이는 핀 상태 = 발표되는 핀 수', seenDown === ap.down,
  '화면 ' + seenDown + ' vs 발표 ' + ap.down);
chk('스트라이크는 10핀 전부 쓰러짐', seenDown === 10, seenDown + '/10');
chk('넘어진 핀도 부피 유지(종이처럼 얇지 않음)', minSide > 0.10,
  '최소변 ' + minSide.toFixed(4) + 'm (핀 지름 0.1204m)');
chk('넘어진 핀 길이가 핀 높이만큼 남아있음',
  ap.pins.every(p => Math.max(...p.size) > 0.33),
  '최대변 최소값 ' + Math.min(...ap.pins.map(p => Math.max(...p.size))).toFixed(3));

/* IMPACT 구도에서 네 줄이 식별되는지 (확대해도 한 줄로 겹치면 실패) */
if (impactProbe) {
  const gaps = impactProbe.rowY.slice(1).map((y, i) => y - impactProbe.rowY[i]);
  console.log('   IMPACT 줄별 화면 y ' + impactProbe.rowY.join(' '));
  console.log('   줄 간격(ndc) ' + gaps.map(g => g.toFixed(4)).join(' ') +
    '  ≈ ' + gaps.map(g => Math.abs(g * 450).toFixed(0) + 'px').join(' '));
  chk('IMPACT: 네 줄이 앞→뒤 순서대로', gaps.every(g => g > 0), gaps.join(' '));
  chk('IMPACT: 줄 간격이 화면에서 식별 가능(>12px)',
    gaps.every(g => Math.abs(g * 450) > 12), gaps.map(g => Math.abs(g * 450).toFixed(0)).join('/'));
  chk('IMPACT: 핀이 화면 안에 들어옴',
    impactProbe.pins.every(p => Math.abs(p.screen.x) < 1.15 && Math.abs(p.screen.y) < 1.15));
} else { chk('IMPACT 측정 확보', false); }

/* ── 연속 프레임 — 한 판을 끊김 없이 훑어 실제로 굴러가는지 확인 ── */
console.log('\n-- 연속 프레임 캡처 --');
const SEQ = path.join(OUT, 'seq');
fs.mkdirSync(SEQ, { recursive: true });
fs.readdirSync(SEQ).forEach(f => fs.unlinkSync(path.join(SEQ, f)));
{
  const canvasBox = await dk.page.evaluate(() => {
    const r = document.getElementById('bowling3dRoot').getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
  });
  const seqRoll = dk.page.evaluate(() => window.__bowl3dTest.rollExact(8));
  const track = [];
  for (let i = 0; i < 60; i++) {
    const pr3 = await dk.page.evaluate(() => window.__bowl3dTest.probe());
    if (pr3.state === 'play' || pr3.state === 'setup') {
      const idx = String(track.length).padStart(2, '0');
      await dk.page.screenshot({ path: path.join(SEQ, `f${idx}.png`), clip: canvasBox });
      track.push({ z: pr3.ball.world.z, x: pr3.ball.world.x, cam: pr3.camState });
    }
    const q = await st(dk);
    if (!q.busy && i > 6) break;
  }
  const rr = await seqRoll;
  const zs = track.map(t => t.z);
  const advanced = zs.filter((z, i) => i === 0 || z >= zs[i - 1] - 1e-6).length;
  console.log(`   ${track.length}프레임 / 공 z ${Math.min(...zs).toFixed(2)} → ${Math.max(...zs).toFixed(2)}`);
  console.log('   카메라 ' + [...new Set(track.map(t => t.cam))].join('→'));
  chk('연속 프레임 캡처', track.length >= 8, track.length + '장');
  chk('공이 레인을 따라 전진', Math.max(...zs) - Math.min(...zs) > 15,
    (Math.max(...zs) - Math.min(...zs)).toFixed(2) + 'm');
  chk('공이 뒤로 가지 않음', advanced === zs.length, advanced + '/' + zs.length);
  chk('연속 프레임 투구도 목표 달성', rr.down === 8, 'down=' + rr.down);
}

/* ── 목표 핀 수 전부 ── */
console.log('\n-- 목표 핀 수 0~10 전수 --');
const exact = [];
for (let n = 0; n <= 10; n++) {
  await dk.page.evaluate(() => window.__bowl3dTest.state());
  const r = await dk.page.evaluate((n) => window.__bowl3dTest.rollExact(n), n);
  const pr2 = await dk.page.evaluate(() => window.__bowl3dTest.probe());
  const seen = pr2.pins.filter((p, i) => p.tilt > 40 || p.world.y < -0.20 ||
    Math.hypot(p.world.x - rp.pins[i].world.x, p.world.z - rp.pins[i].world.z) > 0.085).length;
  exact.push({ n, got: r.down, seen, fail: !!r.fail });
  console.log(`   목표 ${String(n).padStart(2)} → 발표 ${r.fail ? '실패' : r.down} / 화면 ${seen}`);
  if (n === 0) await shot(dk, '05-gutter-desktop.png');
  if (n === 4) await shot(dk, '06-four-pins-desktop.png');
}
/* 1핀은 이 물리에서 도달 불가(물리 검증 4번 참고) — 제품은 구간 대체로 처리한다 */
const want = exact.filter(e => e.n !== 1);
chk('0·2~10핀 전부 정확히 재생', want.every(e => !e.fail && e.got === e.n),
  want.filter(e => e.fail || e.got !== e.n).map(e => e.n + '→' + (e.fail ? 'fail' : e.got)).join(' ') || '');
chk('0·2~10핀 전부 화면 = 발표', want.every(e => e.seen === e.n),
  want.filter(e => e.seen !== e.n).map(e => e.n + '→화면' + e.seen).join(' ') || '');
if (exact[1].fail) console.log('   (1핀은 예상대로 도달 불가 — 아래 구간 대체 검사로 이어진다)');

/* ── 구간 대체: 1핀을 뽑아도 같은 구간(1~3핀) 안에서 보여준다 ── */
console.log('\n-- 구간 대체 (1핀 → 1~3핀 구간) --');
const subs = [];
for (let k = 0; k < 4; k++) {
  const r = await dk.page.evaluate(() => window.__bowl3dTest.rollExact(1, [2, 3]));
  const pr4 = await dk.page.evaluate(() => window.__bowl3dTest.probe());
  const seen = pr4.pins.filter((p, i) => p.tilt > 40 || p.world.y < -0.20 ||
    Math.hypot(p.world.x - rp.pins[i].world.x, p.world.z - rp.pins[i].world.z) > 0.085).length;
  subs.push({ down: r.down, seen, fail: !!r.fail });
  console.log(`   ${k + 1}회: 발표 ${r.fail ? '실패' : r.down} / 화면 ${seen}`);
}
chk('1핀 추첨도 3D 로 재생됨 (2D 로 안 떨어짐)', subs.every(x => !x.fail),
  subs.filter(x => x.fail).length + '건 실패');
chk('대체된 핀 수가 구간(1~3) 안에 있음', subs.every(x => x.down >= 1 && x.down <= 3),
  subs.map(x => x.down).join(','));
chk('대체돼도 화면 = 발표', subs.every(x => x.seen === x.down),
  subs.map(x => x.seen + '/' + x.down).join(' '));

/* ── 3판 연속: READY 복귀 / 초기 위치 / 리스너 중복 ── */
console.log('\n-- 3판 연속 리셋 --');
const resets = [];
for (let g = 0; g < 3; g++) {
  const r = await dk.page.evaluate(() => window.__bowl3dTest.rollExact(7));
  await sleep(200);
  const q = await st(dk);
  const after = await dk.page.evaluate(() => {
    const d = window.__bowl3dTest.state().detail;
    return { state: d.state, cam: d.camState };
  });
  resets.push({ down: r.down, cam: q.camState, state: after.state });
  console.log(`   ${g + 1}판: down=${r.down} state=${after.state} cam=${q.camState}`);
}
chk('3판 연속 전부 목표 달성', resets.every(r => r.down === 7),
  resets.map(r => r.down).join(','));

/* 3판 뒤에도 초기 위치가 정확히 복원되는지 */
const rp2 = await dk.page.evaluate(() => {
  window.__bowl3dTest.switchTo('bowling');
  return new Promise(r => setTimeout(() => r(window.__bowl3dTest.probe()), 500));
});
const rp0 = rp;
chk('3판 뒤 공 초기 위치 동일', Math.abs(rp2.ball.world.z - rp0.ball.world.z) < 1e-3 &&
  Math.abs(rp2.ball.world.x - rp0.ball.world.x) < 1e-3,
  JSON.stringify(rp2.ball.world));
chk('3판 뒤 핀 10개 초기 위치 동일',
  rp2.pins.every((p, i) => Math.abs(p.world.x - rp0.pins[i].world.x) < 1e-3 &&
    Math.abs(p.world.z - rp0.pins[i].world.z) < 1e-3 && p.size[1] > 0.37));
chk('3판 뒤 카메라 포즈 동일', JSON.stringify(rp2.camera) === JSON.stringify(rp0.camera),
  JSON.stringify(rp2.camera) + ' vs ' + JSON.stringify(rp0.camera));

/* reset() 후 READY 복귀 + 공·핀 초기 위치 */
const afterReset = await dk.page.evaluate(() => {
  window.__bowl3dTest.switchTo('bowling');
  return new Promise(res => setTimeout(() => res(window.__bowl3dTest.state()), 400));
});
chk('리셋 후 READY 복귀', afterReset.camState === 'READY', 'cam=' + afterReset.camState);
await shot(dk, '07-ready-after-3games-desktop.png');

/* ── 게임 전환 회귀 + 리스너/캔버스 누수 ── */
console.log('\n-- 게임 전환 (회귀) --');
const swap = await dk.page.evaluate(async () => {
  const canvases = () => document.querySelectorAll('#bowling3dRoot canvas').length;
  const out = { start: canvases() };
  window.__bowl3dTest.switchTo('roulette');
  await new Promise(r => setTimeout(r, 300));
  out.afterRoulette = canvases();
  out.rouletteVisible = document.getElementById('stageWheel') &&
    !document.getElementById('stageWheel').classList.contains('hide');
  window.__bowl3dTest.switchTo('yut');
  await new Promise(r => setTimeout(r, 300));
  out.yutVisible = document.getElementById('stageYut').classList.contains('show');
  window.__bowl3dTest.switchTo('bowling');
  await new Promise(r => setTimeout(r, 2500));
  out.afterBack = canvases();
  out.state = window.__bowl3dTest.state();
  return out;
});
chk('다른 게임으로 가면 3D 캔버스 제거', swap.afterRoulette === 0, 'canvas=' + swap.afterRoulette);
chk('원반 무대 복귀', !!swap.rouletteVisible);
chk('윷 무대 복귀', !!swap.yutVisible);
chk('볼링 재진입 시 캔버스 1개 (중복 없음)', swap.afterBack === 1, 'canvas=' + swap.afterBack);
chk('재진입 후 3D 재가동', !!swap.state.mode3d);
const reRoll = await dk.page.evaluate(() => window.__bowl3dTest.rollExact(9));
chk('재진입 후에도 정상 투구', reRoll.down === 9, 'down=' + reRoll.down);

/* ── 기존 게임 회귀: 원반 / 윷 / 결과 모달 / 볼링 결과 계약 ── */
console.log('\n-- 기존 게임 회귀 --');
const closeModal = async () => {
  await dk.page.evaluate(() => {
    const m = document.getElementById('modal');
    if (m && m.classList.contains('show')) document.getElementById('nextBtn').click();
  });
  await sleep(400);
  /* nextBtn 은 가입 화면으로 되돌린다(= 다음 손님). 그때 activeGame 이 원반으로
     돌아가면서 3D 가 내려가므로, 다시 들어간 뒤 '마운트가 끝날 때까지' 기다린다.
     고정 대기로는 느린 기기에서 아직 안 올라온 상태로 투구하게 된다. */
  await dk.page.evaluate(() => window.__bowl3dTest.enter());
  await waitMounted();
};
const waitMounted = async (ms = 40000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const q = await st(dk);
    if (q.mode3d && !q.busy) return true;
    await sleep(300);
  }
  return false;
};

/* 원반 돌리기 */
await dk.page.evaluate(() => window.__bowl3dTest.switchTo('roulette'));
await sleep(400);
await dk.page.evaluate(() => document.getElementById('hub').click());
await sleep(1800);
const spinning = await dk.page.evaluate(() =>
  !document.getElementById('stopBtn').disabled);
chk('원반: 돌기 시작하고 STOP 활성화', spinning);
await dk.page.evaluate(() => document.getElementById('stopBtn').click());
for (let i = 0; i < 120; i++) {
  const done = await dk.page.evaluate(() =>
    document.getElementById('modal').classList.contains('show'));
  if (done) break;
  await sleep(150);
}
const rouletteOut = await dk.page.evaluate(() => ({
  shown: document.getElementById('modal').classList.contains('show'),
  prize: document.getElementById('prizeText').textContent
}));
chk('원반: 결과 모달 + 당첨 문구', rouletteOut.shown && !!rouletteOut.prize,
  JSON.stringify(rouletteOut));
await dk.page.screenshot({ path: path.join(OUT, '14-regression-roulette.png') });
await closeModal();

/* 윷 던지기 */
await dk.page.evaluate(() => window.__bowl3dTest.switchTo('yut'));
await sleep(400);
await dk.page.evaluate(() => document.getElementById('spinBtn').click());
for (let i = 0; i < 160; i++) {
  const done = await dk.page.evaluate(() =>
    document.getElementById('modal').classList.contains('show'));
  if (done) break;
  await sleep(150);
}
const yutOut = await dk.page.evaluate(() => ({
  shown: document.getElementById('modal').classList.contains('show'),
  prize: document.getElementById('prizeText').textContent,
  name: document.getElementById('yutName').textContent
}));
chk('윷: 결과 모달 + 당첨 문구', yutOut.shown && !!yutOut.prize, JSON.stringify(yutOut));
await dk.page.screenshot({ path: path.join(OUT, '15-regression-yut.png') });
await closeModal();

/* 볼링 — 실제 추첨 경로(rollBall)를 그대로 타 결과 계약까지 확인 */
await dk.page.evaluate(() => window.__bowl3dTest.switchTo('bowling'));
chk('볼링 재진입 시 3D 가 다시 올라옴', await waitMounted());
await dk.page.evaluate(() => window.__bowl3dTest.roll());
for (let i = 0; i < 260; i++) {
  const done = await dk.page.evaluate(() =>
    document.getElementById('modal').classList.contains('show'));
  if (done) break;
  await sleep(150);
}
const bowlOut = await dk.page.evaluate(() => ({
  shown: document.getElementById('modal').classList.contains('show'),
  prize: document.getElementById('prizeText').textContent,
  head: document.getElementById('bowlName').textContent,
  headShown: document.getElementById('bowlName').classList.contains('show')
}));
console.log('   볼링 결과: ' + JSON.stringify(bowlOut));
chk('볼링: 추첨 → 결과 모달 (기존 계약 유지)', bowlOut.shown && !!bowlOut.prize,
  JSON.stringify(bowlOut));
chk('볼링: 핀 수 머리글 표시', bowlOut.headShown && /STRIKE!|거터…|\d+핀!/.test(bowlOut.head),
  bowlOut.head);
await dk.page.screenshot({ path: path.join(OUT, '16-bowling-result-modal.png') });
await closeModal();

/* ── 디버그 오버레이는 debug 플래그에서만 ── */
const dbgShown = await dk.page.evaluate(() =>
  !!document.querySelector('#bowling3dRoot div'));
chk('디버그 오버레이 존재 (debug 플래그)', dbgShown);

console.log('\n   콘솔 error ' + dk.errs.length + ' / warning ' + dk.warns.length);
dk.errs.slice(0, 6).forEach(e => console.log('     ! ' + e.slice(0, 160)));
chk('콘솔 에러 없음', dk.errs.length === 0);
await dk.page.close();

/* ══════════════════ 일반 사용자 화면에 디버그가 안 보이는지 ══════════════════ */
console.log('\n══ 디버그 플래그 없이 ══');
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errs = [];
  const isNet = (t) => /ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|Failed to load resource|Failed to fetch|NetworkError|supabase/i.test(t);
  page.on('pageerror', e => { if (!isNet(e.message)) errs.push(e.message); });
  page.on('console', m => { if (m.type() === 'error' && !isNet(m.text())) errs.push(m.text()); });
  await page.goto(BASE + '/index.html', { waitUntil: 'load', timeout: 60000 });
  await sleep(1200);
  const hook = await page.evaluate(() => !!window.__bowl3dTest);
  const overlay = await page.evaluate(() => !!document.querySelector('#bowling3dRoot div'));
  chk('테스트 훅이 노출되지 않음', hook === false);
  chk('디버그 오버레이가 없음', overlay === false);
  chk('JS 에러 없음(가입 화면)', errs.length === 0, errs.slice(0, 3).join(' | '));
  await page.close();
}

/* ══════════════════ 모바일 ══════════════════ */
console.log('\n══ 모바일 390x844 ══');
const mb = await session('mobile', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
chk('모바일 3D 마운트', mb.mounted);
await sleep(600);
await shot(mb, '08-ready-mobile.png');
const ms1 = await st(mb);
chk('모바일 READY 카메라', ms1.camState === 'READY');

const mRoll = mb.page.evaluate(() => window.__bowl3dTest.rollExact(10));
let mImpact = false;
for (let i = 0; i < 240; i++) {
  const q = await st(mb);
  if (q.camState === 'IMPACT' && q.detail && q.detail.play && q.detail.play.hitAt >= 0 && !mImpact) {
    await shot(mb, '09-impact-mobile.png'); mImpact = true;
  }
  if (!q.busy && i > 10) break;
  await sleep(60);
}
const mr = await mRoll;
chk('모바일 투구 결과', mr.down === 10, 'down=' + mr.down);
chk('모바일 IMPACT 스크린샷', mImpact);

/* 터치 스와이프로 투구 (onSwipeThrow) */
console.log('\n-- 모바일 스와이프 투구 --');
await sleep(400);
const box = await mb.page.evaluate(() => {
  const r = document.getElementById('bowling3dRoot').getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height * 0.78, h: r.height };
});
const before = await st(mb);
await mb.page.mouse.move(box.x, box.y);
await mb.page.mouse.down();
for (let k = 1; k <= 6; k++) { await mb.page.mouse.move(box.x, box.y - k * 30); await sleep(20); }
await mb.page.mouse.up();
await sleep(500);
const afterSwipe = await st(mb);
chk('스와이프로 투구 시작', afterSwipe.busy || afterSwipe.bowling,
  'busy=' + afterSwipe.busy + ' bowling=' + afterSwipe.bowling);
/* 끝나길 기다린다 */
for (let i = 0; i < 250; i++) { const q = await st(mb); if (!q.busy && !q.bowling) break; await sleep(80); }
await shot(mb, '10-after-swipe-mobile.png');

/* 가로 모드 / 리사이즈 */
console.log('\n-- 뷰포트 변화 --');
await mb.page.setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
await sleep(700);
await shot(mb, '11-landscape-mobile.png');
const land = await mb.page.evaluate(() => {
  const c = document.querySelector('#bowling3dRoot canvas');
  const r = document.getElementById('bowling3dRoot').getBoundingClientRect();
  return { cw: c.clientWidth, ch: c.clientHeight, rw: Math.round(r.width), rh: Math.round(r.height) };
});
chk('가로 모드에서 캔버스가 컨테이너를 채움',
  Math.abs(land.cw - land.rw) <= 2 && Math.abs(land.ch - land.rh) <= 2, JSON.stringify(land));
await mb.page.setViewport({ width: 360, height: 640, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
await sleep(700);
await shot(mb, '12-small-mobile.png');
const small = await mb.page.evaluate(() => window.__bowl3dTest.rollExact(6));
chk('작은 화면에서도 정상 투구', small.down === 6, 'down=' + small.down);

console.log('\n   콘솔 error ' + mb.errs.length);
mb.errs.slice(0, 6).forEach(e => console.log('     ! ' + e.slice(0, 160)));
chk('모바일 콘솔 에러 없음', mb.errs.length === 0);
await mb.page.close();

/* ══════════════════ 2D 폴백 ══════════════════ */
console.log('\n══ 2D 폴백 (?bowling2d=1) ══');
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  const errs = [];
  page.on('pageerror', e => { if (!/supabase|Failed to fetch|NetworkError/i.test(e.message)) errs.push(e.message); });
  await page.goto(BASE + '/index.html?bowling2d=1&bowlingDebug=1', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('!!window.__bowl3dTest', { timeout: 20000 });
  await page.evaluate(() => window.__bowl3dTest.soundOff());
  await page.evaluate(() => window.__bowl3dTest.enter());
  await sleep(800);
  const q = await page.evaluate(() => window.__bowl3dTest.state());
  chk('3D 가 꺼지고 2D 로 동작', q.mode3d === false);
  const canv = await page.evaluate(() => {
    const c = document.getElementById('bowl');
    return { shown: getComputedStyle(c).display !== 'none', w: c.width, h: c.height };
  });
  chk('2D 캔버스가 보이고 크기가 잡힘', canv.shown && canv.w > 0, JSON.stringify(canv));
  await page.screenshot({ path: path.join(OUT, '13-fallback-2d.png') });
  await page.evaluate(() => window.__bowl3dTest.roll());
  await sleep(4200);
  const after = await page.evaluate(() => window.__bowl3dTest.state());
  chk('2D 투구가 끝까지 진행', after.bowling === false || after.runs > 0,
    'runs=' + after.runs);
  chk('2D 폴백 JS 에러 없음', errs.length === 0, errs.slice(0, 2).join(' | '));
  await page.close();
}

/* ══════════════════ 관리자 화면 회귀 ══════════════════ */
console.log('\n══ 관리자 화면 (admin.html) ══');
{
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errs = [];
  const isNet = (t) => /ERR_NAME_NOT_RESOLVED|Failed to load resource|Failed to fetch|NetworkError|supabase/i.test(t);
  page.on('pageerror', e => { if (!isNet(e.message)) errs.push(e.message); });
  page.on('console', m => { if (m.type() === 'error' && !isNet(m.text())) errs.push(m.text()); });
  const resp = await page.goto(BASE + '/admin.html', { waitUntil: 'load', timeout: 60000 });
  await sleep(1500);
  chk('admin.html 200', resp.status() === 200, 'status=' + resp.status());
  const body = await page.evaluate(() => ({
    hasContent: document.body.innerText.trim().length > 0,
    forms: document.querySelectorAll('input,button').length
  }));
  chk('관리자 화면이 렌더됨', body.hasContent && body.forms > 0, JSON.stringify(body));
  chk('관리자 JS 에러 없음', errs.length === 0, errs.slice(0, 3).join(' | '));
  await page.screenshot({ path: path.join(OUT, '17-regression-admin.png') });
  await page.close();
}

await browser.close();
server.close();

console.log('\n스크린샷: ' + OUT);
fs.readdirSync(OUT).sort().filter(f => f.endsWith('.png')).forEach(f => {
  console.log('   ' + f + '  ' + (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + 'KB');
});
if (fs.existsSync(path.join(OUT, 'seq'))) {
  const n = fs.readdirSync(path.join(OUT, 'seq')).length;
  console.log('   seq/  연속 프레임 ' + n + '장');
}
console.log('\n════════ ' + (FAILS ? `실패 ${FAILS}건` : '전 항목 통과') + ' ════════\n');
process.exit(FAILS ? 1 : 0);
