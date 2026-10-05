/* 실제 GPU 로 3D 볼링의 프레임레이트를 잰다.

   헤드리스 Chrome 은 SwiftShader(소프트웨어 렌더)로 떨어져 성능 수치가 의미 없다.
   그래서 이 스크립트는 창을 띄워(headful) 실제 GPU 로 측정한다.

   사용: node tools/bowl3d-fps.mjs [반복수=3]
   환경변수: PUPPETEER_CORE, CHROME_PATH                                        */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const ROUNDS = parseInt(process.argv[2] || '3', 10);
const PUP = process.env.PUPPETEER_CORE ||
  'C:/Users/USER/AppData/Local/Temp/claude/e--socuri-wheel/7c7f506a-799f-474c-bcd2-8f57057de2d2/scratchpad/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:' + server.address().port;

const pupUrl = /^[a-zA-Z]:[\\/]/.test(PUP) ? 'file:///' + PUP.replace(/\\/g, '/') : PUP;
const { default: puppeteer } = await import(pupUrl);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function measure(label, viewport, extraArgs) {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    args: ['--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
      `--window-size=${viewport.width},${viewport.height + 120}`].concat(extraArgs || [])
  });
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto(BASE + '/index.html?bowlingDebug=1', { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction('!!window.__bowl3dTest', { timeout: 30000 });
  await page.evaluate(() => window.__bowl3dTest.soundOff());
  await page.evaluate(() => window.__bowl3dTest.enter());
  await sleep(2500);

  const gpu = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return 'no-webgl';
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });

  /* rAF 간격을 직접 수집한다 */
  async function sample(ms) {
    return page.evaluate((ms) => new Promise(res => {
      const dts = []; let last = performance.now();
      const t0 = last;
      (function tick(now) {
        dts.push(now - last); last = now;
        if (now - t0 < ms) requestAnimationFrame(tick); else res(dts.slice(1));
      })(last);
    }), ms);
  }

  const rows = [];
  for (let r = 0; r < ROUNDS; r++) {
    const idle = await sample(1000);
    const rollP = page.evaluate(() => window.__bowl3dTest.rollExact(10));
    await sleep(900);                       /* 셋업 + 탐색 구간을 지난 뒤 */
    const during = await sample(2600);      /* 굴러가는 동안 */
    await rollP;
    const stat = (a) => {
      const s = a.slice().sort((x, y) => x - y);
      const mean = a.reduce((p, c) => p + c, 0) / a.length;
      return { fps: 1000 / mean, p95: 1000 / s[Math.floor(s.length * 0.95)],
               worstMs: s[s.length - 1], over50: a.filter(x => x > 50).length, n: a.length };
    };
    const i = stat(idle), d = stat(during);
    rows.push({ idle: i, during: d });
    console.log(`   ${label} ${r + 1}회차  대기 ${i.fps.toFixed(0)}fps  투구중 ${d.fps.toFixed(0)}fps ` +
      `(p95 ${d.p95.toFixed(0)}, 최장프레임 ${d.worstMs.toFixed(0)}ms, 50ms초과 ${d.over50}/${d.n})`);
    await sleep(500);
  }
  const solve = await page.evaluate(() => {
    const d = window.__bowl3dTest.state().detail;
    return d ? d.dbg : { tries: -1, solveMs: 0 };
  });
  await browser.close();
  const avg = (f) => rows.reduce((p, r) => p + f(r), 0) / rows.length;
  return {
    label, gpu,
    idle: avg(r => r.idle.fps), idleP95: avg(r => r.idle.p95),
    during: avg(r => r.during.fps), duringP95: avg(r => r.during.p95),
    solveTries: solve.tries, solveMs: solve.solveMs
  };
}

console.log('실제 GPU 프레임레이트 측정 (창이 잠깐 열립니다)\n');
const out = [];
out.push(await measure('데스크톱 1440x900', { width: 1440, height: 900 }));
out.push(await measure('모바일   390x844 ', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }));
server.close();

console.log('\n════ 요약 ════');
out.forEach(o => {
  console.log(`${o.label}  GPU: ${o.gpu}`);
  console.log(`   대기   ${o.idle.toFixed(0)} fps  (p95 ${o.idleP95.toFixed(0)})`);
  console.log(`   투구중 ${o.during.toFixed(0)} fps  (p95 ${o.duringP95.toFixed(0)})`);
  console.log(`   마지막 투구 물리 탐색 ${o.solveTries}회 / ${o.solveMs.toFixed(0)}ms`);
});
const worst = Math.min(...out.map(o => o.during));
console.log('\n최저 투구중 평균 ' + worst.toFixed(0) + ' fps');
