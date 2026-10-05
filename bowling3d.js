/* ══════════════════════════════════════════════════════════════════════════
   bowling3d.js — Three.js 3D 볼링 렌더러 / 카메라 / 입력

   · 물리는 bowling3d-physics.js (Rapier 3D) 가 담당한다. 이 파일은 "보여주는"
     일만 한다.
   · 결과 계약: socuri-wheel 은 가중치 추첨으로 핀 수를 먼저 정하고, 그 핀 수가
     실제로 나오는 투구를 찾아 재생한다. 그래서 roll() 은 목표 핀 수를 받는다.
     조준을 플레이어에게 맡기면 추첨 결과를 보장할 수 없으므로, 드래그 입력은
     "둘러보기 + 투구 트리거" 로만 쓰고 결과를 바꾸는 조준은 두지 않는다.
   · 물리는 실시간으로 한 번 돌려 녹화하고, 그 녹화를 재생한다. 프레임 드랍이나
     느린 기기에서도 화면과 발표되는 결과가 어긋나지 않게 하기 위함이다.

   createBowling3D({ root, sounds, debug }) → 핸들
     handle.roll({ n, gutter })  목표 핀 수로 한 판. Promise<{down, mask, strike}>
     handle.reset()              READY 상태로 (카메라·공·핀 전부 초기화)
     handle.resize()             컨테이너 크기 반영
     handle.dispose()            RAF·리스너·GPU 자원·물리 월드 전부 정리
   ══════════════════════════════════════════════════════════════════════════ */

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';
import * as RAPIER from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js';
import * as PHYS from './bowling3d-physics.js';

var D = PHYS.DIM;
var LANE_END = D.PIT_END + 0.4;

/* ── 연출 상수 ── */
var SETUP_MS = 900;          /* 공을 내려놓는 셋업 (이 사이에 물리를 나눠 돌린다) */
var SETUP_MS_REDUCED = 380;
var SLOMO_RATE = 0.42;       /* 첫 착탄 직후 */
var SLOMO_HOLD = 0.45;       /* 초 (재생 시간 기준) */
var SLOMO_BACK = 0.30;       /* 원속으로 돌아오는 시간 */
var SOLVE_BUDGET_MS = 6;     /* 프레임당 물리 탐색 예산 */
var SOLVE_MAX_TRIES = 26;

/* ── 카메라 포즈 ── */
var CAM = {
  READY:  { pos: [0, 1.55, -2.90], tgt: [0, 0.55, 9.00], fov: 45 },
  FOLLOW: { dPos: [0, 1.15, -2.90], dTgt: [0, 0.05, 4.00], fov: 45 },
  IMPACT: { pos: [0, 1.62, D.HEADPIN_Z - 3.00], tgt: [0, 0.28, D.HEADPIN_Z + 0.33], fov: 42 }
};
var FOLLOW_Z0 = 1.2, FOLLOW_Z1 = 7.0;                       /* READY → FOLLOW */
var IMPACT_Z0 = D.HEADPIN_Z - 6.2, IMPACT_Z1 = D.HEADPIN_Z - 1.6;  /* → IMPACT */

function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
function smooth(v) { v = clamp01(v); return v * v * (3 - 2 * v); }
function easeInOut(v) { v = clamp01(v); return v < 0.5 ? 2 * v * v : 1 - Math.pow(-2 * v + 2, 2) / 2; }

/* ══════════════════════════════════════════════════════════════════════════
   절차적 텍스처 — 외부 이미지를 쓰지 않는다 (네트워크 의존 최소화)
   ══════════════════════════════════════════════════════════════════════════ */

/* 레인 목재 — u 방향에 39개 보드 경계선, v 방향으로 반복되는 나뭇결 */
function makeLaneTexture(boards) {
  var W = 512, H = 512;
  var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  var c = cv.getContext('2d');
  var g = c.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#b07c40'); g.addColorStop(0.5, '#c89356'); g.addColorStop(1, '#b07c40');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  /* 나뭇결 — v 로 이어지도록 세로 방향 긴 줄 */
  var i, j;
  for (i = 0; i < 520; i++) {
    var x = Math.random() * W;
    c.strokeStyle = 'rgba(' + (90 + Math.random() * 60 | 0) + ',' +
      (58 + Math.random() * 40 | 0) + ',22,' + (0.05 + Math.random() * 0.10).toFixed(3) + ')';
    c.lineWidth = 0.6 + Math.random() * 1.8;
    c.beginPath(); c.moveTo(x, 0);
    for (j = 0; j <= 8; j++) c.lineTo(x + Math.sin(j * 0.9 + i) * 2.2, H * j / 8);
    c.stroke();
  }
  /* 보드 경계선 */
  for (i = 0; i <= boards; i++) {
    var bx = Math.round(i * W / boards);
    c.fillStyle = 'rgba(58,34,12,.30)'; c.fillRect(bx, 0, 1, H);
    c.fillStyle = 'rgba(255,225,180,.10)'; c.fillRect(bx + 1, 0, 1, H);
  }
  var t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

/* 어프로치(파울라인 뒤) — 더 어두운 목재 */
function makeApproachTexture() {
  var W = 256, H = 256;
  var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  var c = cv.getContext('2d');
  c.fillStyle = '#6b4a24'; c.fillRect(0, 0, W, H);
  for (var i = 0; i < 260; i++) {
    c.fillStyle = 'rgba(40,24,8,' + (0.04 + Math.random() * 0.08).toFixed(3) + ')';
    c.fillRect(Math.random() * W, 0, 0.8 + Math.random() * 1.6, H);
  }
  var t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/* 핀 표면 — 흰 광택 + 목 부분 빨간 띠 두 줄.
   LatheGeometry 의 v 는 프로파일 "점 번호" 기준이라 높이→v 로 환산해 칠한다. */
function makePinTexture() {
  var P = PHYS.PIN_PROFILE, n = P.length;
  function vOf(y) {
    for (var i = 1; i < n; i++) {
      if (P[i][0] >= y) {
        var y0 = P[i - 1][0], y1 = P[i][0];
        var f = (y1 > y0) ? (y - y0) / (y1 - y0) : 0;
        return (i - 1 + f) / (n - 1);
      }
    }
    return 1;
  }
  var W = 64, H = 512;
  var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  var c = cv.getContext('2d');
  c.fillStyle = '#f7f4ee'; c.fillRect(0, 0, W, H);
  /* 아주 옅은 크림 그라데이션 — 완전 백색보다 입체로 보인다 */
  var g = c.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(226,216,198,.55)');
  g.addColorStop(0.35, 'rgba(255,255,255,0)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  PHYS.PIN_BANDS.forEach(function (b) {
    /* LatheGeometry 는 v=0 이 프로파일 첫 점(밑동) → 텍스처 위쪽이 밑동 */
    var v0 = vOf(b[0]), v1 = vOf(b[1]);
    c.fillStyle = '#d4232e';
    c.fillRect(0, v0 * H, W, Math.max(2, (v1 - v0) * H));
  });
  var t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = THREE.RepeatWrapping;
  return t;
}

/* 공 — 마블 소용돌이 + 손가락 구멍 세 개 (회전이 눈에 보이게 하는 핵심) */
function makeBallTexture() {
  var W = 512, H = 256;
  var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  var c = cv.getContext('2d');
  c.fillStyle = '#3a1f7a'; c.fillRect(0, 0, W, H);
  var i;
  for (i = 0; i < 26; i++) {
    var x = Math.random() * W, y = Math.random() * H;
    var r = 30 + Math.random() * 90;
    var g = c.createRadialGradient(x, y, 0, x, y, r);
    var hue = 255 + Math.random() * 30;
    g.addColorStop(0, 'rgba(' + (140 + Math.random() * 90 | 0) + ',70,' + (hue | 0) + ',.62)');
    g.addColorStop(1, 'rgba(58,31,122,0)');
    c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, 6.3); c.fill();
  }
  for (i = 0; i < 10; i++) {
    c.strokeStyle = 'rgba(214,186,255,.26)';
    c.lineWidth = 2 + Math.random() * 8;
    c.beginPath();
    c.moveTo(Math.random() * W, 0);
    c.bezierCurveTo(Math.random() * W, H / 3, Math.random() * W, H * 2 / 3, Math.random() * W, H);
    c.stroke();
  }
  /* 손가락 구멍 — 적도 근처에 세 개 모아둔다 */
  [[0.46, 0.40, 15], [0.54, 0.40, 15], [0.50, 0.52, 19]].forEach(function (h) {
    var x = h[0] * W, y = h[1] * H, r = h[2];
    var g2 = c.createRadialGradient(x, y - r * 0.3, 1, x, y, r);
    g2.addColorStop(0, '#000'); g2.addColorStop(0.72, '#06040f'); g2.addColorStop(1, 'rgba(6,4,15,0)');
    c.fillStyle = g2; c.beginPath(); c.ellipse(x, y, r, r * 1.15, 0, 0, 6.3); c.fill();
  });
  var t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/* ══════════════════════════════════════════════════════════════════════════
   본체
   ══════════════════════════════════════════════════════════════════════════ */
var _rapierReady = null;
function initRapier() {
  if (!_rapierReady) _rapierReady = RAPIER.init().then(function () { return RAPIER; });
  return _rapierReady;
}

var _table = null, _tableTried = false;
function loadTable() {
  if (_tableTried) return Promise.resolve(_table);
  _tableTried = true;
  return import('./bowling3d-table.js')
    .then(function (m) { _table = m; return m; })
    .catch(function () { _table = null; return null; });   /* 없으면 격자 탐색으로 */
}

export async function createBowling3D(opts) {
  opts = opts || {};
  var root = opts.root;
  var sounds = opts.sounds || {};
  var debugOn = !!opts.debug;
  if (!root) throw new Error('bowling3d: root 가 필요합니다');

  await initRapier();
  await loadTable();

  var small = Math.min(window.innerWidth, window.innerHeight) < 760;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── 렌더러 ── */
  var renderer = new THREE.WebGLRenderer({ antialias: !small, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.04;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = small ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;';
  root.appendChild(renderer.domElement);

  var scene = new THREE.Scene();
  scene.background = new THREE.Color(0x120d1c);
  scene.fog = new THREE.Fog(0x120d1c, 20, 52);

  var camera = new THREE.PerspectiveCamera(CAM.READY.fov, 1, 0.1, 120);

  /* ── 폐기 목록 ── */
  var junk = [];
  function keep(o) { junk.push(o); return o; }

  /* ══ 조명 ══ */
  var hemi = new THREE.HemisphereLight(0xcfdcff, 0x5a4128, 0.90);
  scene.add(hemi);
  var amb = new THREE.AmbientLight(0xfff0dd, 0.34);
  scene.add(amb);
  /* 반대쪽 채움 — 그림자를 만들지 않고 어두운 면만 들어올린다 */
  var fill = new THREE.DirectionalLight(0xc9d6ff, 0.42);
  fill.position.set(-4, 3.2, -2);
  scene.add(fill);

  /* 메인 — 공 주변만 비추는 그림자 카메라를 들고 따라다닌다.
     19m 레인을 한 섀도맵으로 덮으면 해상도가 남지 않기 때문이다. */
  var sun = new THREE.DirectionalLight(0xfff4e2, 1.55);
  sun.castShadow = true;
  sun.shadow.mapSize.set(small ? 512 : 1024, small ? 512 : 1024);
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 16;
  sun.shadow.camera.left = -3.2; sun.shadow.camera.right = 3.2;
  sun.shadow.camera.top = 3.2; sun.shadow.camera.bottom = -3.2;
  sun.shadow.bias = -0.0012;
  sun.shadow.normalBias = 0.02;
  var sunOff = new THREE.Vector3(2.6, 6.0, -2.2);
  scene.add(sun); scene.add(sun.target);

  /* 핀덱 조명 — 거기만 조금 더 밝게 */
  var deckLight = new THREE.SpotLight(0xffffff, 26, 9.5, 0.62, 0.45, 1.6);
  deckLight.position.set(0, 3.5, D.HEADPIN_Z - 0.15);
  deckLight.target.position.set(0, 0.16, D.HEADPIN_Z + 0.34);
  scene.add(deckLight); scene.add(deckLight.target);

  /* 천장 조명 줄 — 한 개짜리 스포트는 레인 한가운데만 밝아 보이므로
     일정 간격으로 나눠 레인 전체가 고르게 읽히게 한다 */
  var ceilLights = [];
  [2.0, 6.0, 10.0, 14.0, 17.4].forEach(function (z) {
    var pl = new THREE.PointLight(0xffe9cc, 5.2, 15, 2);
    pl.position.set(0, 2.9, z);
    scene.add(pl); ceilLights.push(pl);
  });

  /* ══ 레인 ══ */
  var laneTex = keep(makeLaneTexture(39));
  laneTex.repeat.set(1, (D.DECK_END - D.FOUL_Z) / 1.6);
  laneTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  var laneMat = keep(new THREE.MeshPhysicalMaterial({
    map: laneTex, roughness: 0.22, metalness: 0.0,
    clearcoat: 0.85, clearcoatRoughness: 0.14
  }));
  var laneGeo = keep(new THREE.BoxGeometry(D.LANE_W, 0.10, D.DECK_END - D.FOUL_Z));
  var lane = new THREE.Mesh(laneGeo, [laneMat, laneMat, laneMat, laneMat, laneMat, laneMat]);
  lane.position.set(0, -0.05, (D.FOUL_Z + D.DECK_END) / 2);
  lane.receiveShadow = true;
  scene.add(lane);

  /* 핀덱 — 살짝 밝은 단판 느낌 */
  var deckTex = keep(makeLaneTexture(39));
  deckTex.repeat.set(1, 0.8);
  deckTex.anisotropy = laneTex.anisotropy;
  var deckMat = keep(new THREE.MeshPhysicalMaterial({
    map: deckTex, roughness: 0.18, metalness: 0, clearcoat: 0.9, clearcoatRoughness: 0.1,
    color: 0xfff0dc
  }));
  var deckGeo = keep(new THREE.BoxGeometry(D.LANE_W, 0.104, D.DECK_END - D.DECK_FRONT));
  var deck = new THREE.Mesh(deckGeo, deckMat);
  deck.position.set(0, -0.049, (D.DECK_FRONT + D.DECK_END) / 2);
  deck.receiveShadow = true;
  scene.add(deck);

  /* 어프로치 */
  var apTex = keep(makeApproachTexture());
  apTex.repeat.set(1, 3);
  var apMat = keep(new THREE.MeshStandardMaterial({ map: apTex, roughness: 0.42 }));
  var apGeo = keep(new THREE.BoxGeometry(D.LANE_W + 2 * D.GUTTER_W + 0.3, 0.10, -D.APPROACH_Z));
  var approach = new THREE.Mesh(apGeo, apMat);
  approach.position.set(0, -0.051, D.APPROACH_Z / 2);
  approach.receiveShadow = true;
  scene.add(approach);

  /* 파울라인 */
  var foulGeo = keep(new THREE.BoxGeometry(D.LANE_W, 0.004, 0.030));
  var foulMat = keep(new THREE.MeshStandardMaterial({ color: 0x2a1708, roughness: 0.5 }));
  var foul = new THREE.Mesh(foulGeo, foulMat);
  foul.position.set(0, 0.0025, 0);
  scene.add(foul);

  /* 조준 화살표 7개 (보드 5·10·15·20·25·30·35 / 12~15ft) + 7ft 점 */
  var BOARD = D.LANE_W / 39;
  function boardX(n) { return -D.LANE_HALF + (n - 0.5) * BOARD; }
  var arrowMat = keep(new THREE.MeshStandardMaterial({
    color: 0x5d3a16, roughness: 0.35, transparent: true, opacity: 0.92
  }));
  /* rotation.x=-90° 는 도형의 +y 를 월드 -z 로 보낸다.
     화살표 촉은 핀 쪽(+z)을 향해야 하므로 도형에서 미리 뒤집어 둔다. */
  var arrowGeo = keep((function () {
    var s = new THREE.Shape();
    s.moveTo(0, -0.20); s.lineTo(0.036, 0.10); s.lineTo(-0.036, 0.10); s.closePath();
    return new THREE.ShapeGeometry(s);
  })());
  var markers = new THREE.Group();
  [[20, 4.572], [15, 4.267], [25, 4.267], [10, 3.962], [30, 3.962], [5, 3.658], [35, 3.658]]
    .forEach(function (a) {
      var m = new THREE.Mesh(arrowGeo, arrowMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(boardX(a[0]), 0.0032, a[1]);
      markers.add(m);
    });
  var dotGeo = keep(new THREE.CircleGeometry(0.019, 12));
  [5, 10, 15, 20, 25, 30, 35].forEach(function (b) {
    var m = new THREE.Mesh(dotGeo, arrowMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(boardX(b), 0.0032, 2.134);
    markers.add(m);
  });
  scene.add(markers);

  /* ══ 거터 / 벽 / 핏 ══ */
  var gutMat = keep(new THREE.MeshStandardMaterial({
    color: 0x343a47, roughness: 0.28, metalness: 0.66
  }));
  var gutLen = D.DECK_END - D.APPROACH_Z;
  var gutGeo = keep(new THREE.BoxGeometry(D.GUTTER_W, 0.26, gutLen));
  var gutWallGeo = keep(new THREE.BoxGeometry(0.12, 0.42, gutLen));
  var gutWallMat = keep(new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.6 }));
  [-1, 1].forEach(function (s) {
    var g = new THREE.Mesh(gutGeo, gutMat);
    g.position.set(s * (D.LANE_HALF + D.GUTTER_W / 2), -D.GUTTER_D - 0.13,
      (D.APPROACH_Z + D.DECK_END) / 2);
    g.receiveShadow = true; scene.add(g);
    var w = new THREE.Mesh(gutWallGeo, gutWallMat);
    w.position.set(s * (D.LANE_HALF + D.GUTTER_W + 0.06), 0.09,
      (D.APPROACH_Z + D.DECK_END) / 2);
    scene.add(w);
  });

  /* 킥백 — 핀덱 좌우 패널 */
  var kickMat = keep(new THREE.MeshStandardMaterial({
    color: 0x2b3040, roughness: 0.32, metalness: 0.55
  }));
  var kickZ0 = D.HEADPIN_Z - 0.55;
  var kickGeo = keep(new THREE.BoxGeometry(0.03, 0.66, D.DECK_END - kickZ0));
  [-1, 1].forEach(function (s) {
    var k = new THREE.Mesh(kickGeo, kickMat);
    k.position.set(s * (D.LANE_HALF + 0.015), 0.33, (kickZ0 + D.DECK_END) / 2);
    k.receiveShadow = true; scene.add(k);
  });

  /* 핏 */
  var pitMat = keep(new THREE.MeshStandardMaterial({ color: 0x13141a, roughness: 0.9 }));
  var pitW = D.LANE_W + 2 * D.GUTTER_W + 0.24;
  var pitFloor = new THREE.Mesh(keep(new THREE.BoxGeometry(pitW, 0.12, D.PIT_END - D.DECK_END)), pitMat);
  pitFloor.position.set(0, D.PIT_Y - 0.06, (D.DECK_END + D.PIT_END) / 2);
  pitFloor.receiveShadow = true; scene.add(pitFloor);
  var pitBack = new THREE.Mesh(keep(new THREE.BoxGeometry(pitW, 1.5, 0.16)), pitMat);
  pitBack.position.set(0, D.PIT_Y + 0.75, D.PIT_END + 0.08);
  scene.add(pitBack);
  /* 마스킹 유닛 — 핀 위를 덮는 패널. 깊이감의 핵심.
     IMPACT 카메라(y≈1.6)가 올려다보므로 충분히 높이 달아 화면을 먹지 않게 한다. */
  var maskMat = keep(new THREE.MeshStandardMaterial({ color: 0x4a1630, roughness: 0.55 }));
  var maskUnit = new THREE.Mesh(keep(new THREE.BoxGeometry(pitW + 0.5, 1.15, 0.12)), maskMat);
  /* IMPACT 카메라(y≈1.6, 핀덱을 내려다봄)의 화면 윗부분을 채워 주는 높이.
     더 올리면 화면 위가 통째로 검게 비고, 더 내리면 핀을 가린다. */
  maskUnit.position.set(0, 1.28, D.HEADPIN_Z + 1.38);
  scene.add(maskUnit);
  /* 핏 안쪽 약한 조명 — 핀이 떨어지는 게 검은 구멍으로만 보이지 않게 */
  var pitLight = new THREE.PointLight(0xffd9b0, 2.6, 4.2, 2);
  pitLight.position.set(0, 0.10, D.DECK_END + 0.55);
  scene.add(pitLight);
  /* 핀덱 뒤 어두운 배경판 — 흰 핀의 윤곽이 또렷하게 읽히도록.
     핀이 날아가는 핏 구간을 가리지 않게 핏 뒤쪽에 세운다. */
  var backMat = keep(new THREE.MeshStandardMaterial({ color: 0x16111c, roughness: 0.9 }));
  var backdrop = new THREE.Mesh(keep(new THREE.BoxGeometry(pitW + 0.5, 2.2, 0.1)), backMat);
  backdrop.position.set(0, 1.05, D.PIT_END + 0.02);
  scene.add(backdrop);

  /* 양옆 벽 + 조명 띠 — 깊이감용 최소 배경 */
  var wallMat = keep(new THREE.MeshStandardMaterial({ color: 0x2d2440, roughness: 0.85 }));
  var wallGeo = keep(new THREE.BoxGeometry(0.2, 3.2, LANE_END - D.APPROACH_Z));
  [-1, 1].forEach(function (s) {
    var w = new THREE.Mesh(wallGeo, wallMat);
    w.position.set(s * (D.LANE_HALF + D.GUTTER_W + 0.75), 1.4, (D.APPROACH_Z + LANE_END) / 2);
    scene.add(w);
  });
  var stripMat = keep(new THREE.MeshBasicMaterial({ color: 0x6f4dd8 }));
  var stripGeo = keep(new THREE.BoxGeometry(0.05, 0.05, LANE_END - D.APPROACH_Z));
  [-1, 1].forEach(function (s) {
    var st = new THREE.Mesh(stripGeo, stripMat);
    st.position.set(s * (D.LANE_HALF + D.GUTTER_W + 0.63), 1.05, (D.APPROACH_Z + LANE_END) / 2);
    scene.add(st);
  });

  /* ══ 핀 10개 — 하나의 LatheGeometry·Material 을 공유한다 ══ */
  var pinPts = PHYS.PIN_PROFILE.map(function (p) { return new THREE.Vector2(p[1], p[0]); });
  var pinGeo = keep(new THREE.LatheGeometry(pinPts, small ? 20 : 30));
  pinGeo.computeVertexNormals();
  var pinTex = keep(makePinTexture());
  var pinMat = keep(new THREE.MeshPhysicalMaterial({
    map: pinTex, roughness: 0.16, metalness: 0.0,
    clearcoat: 1.0, clearcoatRoughness: 0.08
  }));
  var pinMeshes = [];
  for (var pi = 0; pi < 10; pi++) {
    var pm = new THREE.Mesh(pinGeo, pinMat);
    pm.castShadow = true; pm.receiveShadow = true;
    pm.matrixAutoUpdate = false;
    scene.add(pm);
    pinMeshes.push(pm);
  }

  /* ══ 공 ══ */
  var ballGeo = keep(new THREE.SphereGeometry(D.BALL_R, small ? 28 : 44, small ? 20 : 32));
  var ballTex = keep(makeBallTexture());
  var ballMat = keep(new THREE.MeshPhysicalMaterial({
    map: ballTex, roughness: 0.075, metalness: 0.08,
    clearcoat: 1.0, clearcoatRoughness: 0.04
  }));
  var ball = new THREE.Mesh(ballGeo, ballMat);
  ball.castShadow = true;
  ball.matrixAutoUpdate = false;
  scene.add(ball);

  /* ══ 물리 핸들 ══ */
  var rand = PHYS.rng((Date.now() ^ 0x5f3a) | 1);

  /* ══ 상태 ══ */
  var state = 'ready';        /* ready | setup | play | done */
  var camState = 'READY';
  var play = null;            /* { frames, times, events, firstHit, evIdx, pt, rate } */
  var solving = null;         /* 진행 중인 탐색 */
  var setupT0 = 0, setupX = 0, readyAt = -1;
  var raf = null, lastT = 0, disposed = false;
  var pending = null;         /* roll() 의 resolve */
  var dbg = { fps: 0, frames: 0, fpsT0: 0, tries: 0, solveMs: 0 };

  /* 재사용 임시 객체 — 매 프레임 new 금지 */
  var _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  var _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
  var _m1 = new THREE.Matrix4(), _s1 = new THREE.Vector3(1, 1, 1);
  var camPos = new THREE.Vector3(), camTgt = new THREE.Vector3();
  var wantPos = new THREE.Vector3(), wantTgt = new THREE.Vector3();

  /* ══ 핀/공 포즈 적용 ══ */
  function poseFromFrame(fr) {
    ball.matrix.compose(_v1.set(fr[0], fr[1], fr[2]),
      _q1.set(fr[3], fr[4], fr[5], fr[6]), _s1);
    ball.matrixWorldNeedsUpdate = true;
    for (var i = 0; i < 10; i++) {
      var o = 7 + i * 7, m = pinMeshes[i];
      m.matrix.compose(_v1.set(fr[o], fr[o + 1], fr[o + 2]),
        _q1.set(fr[o + 3], fr[o + 4], fr[o + 5], fr[o + 6]), _s1);
      m.matrixWorldNeedsUpdate = true;
    }
  }
  /* 두 프레임 사이 보간 — 60fps 보다 촘촘한 녹화를 부드럽게 잇는다 */
  function poseLerp(a, b, f) {
    ball.matrix.compose(
      _v1.set(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f),
      _q1.set(a[3], a[4], a[5], a[6]).slerp(_q2.set(b[3], b[4], b[5], b[6]), f), _s1);
    ball.matrixWorldNeedsUpdate = true;
    for (var i = 0; i < 10; i++) {
      var o = 7 + i * 7, m = pinMeshes[i];
      m.matrix.compose(
        _v1.set(a[o] + (b[o] - a[o]) * f, a[o + 1] + (b[o + 1] - a[o + 1]) * f,
          a[o + 2] + (b[o + 2] - a[o + 2]) * f),
        _q1.set(a[o + 3], a[o + 4], a[o + 5], a[o + 6])
          .slerp(_q2.set(b[o + 3], b[o + 4], b[o + 5], b[o + 6]), f), _s1);
      m.matrixWorldNeedsUpdate = true;
    }
  }

  /* 초기 포즈(셋업/READY) — 공은 파울라인 근처, 핀은 전부 제자리 */
  function poseIdle(ballY, ballZ, ballX) {
    ball.matrix.compose(_v1.set(ballX || 0, ballY, ballZ), _q1.identity(), _s1);
    ball.visible = true; ball.matrixWorldNeedsUpdate = true;
    for (var i = 0; i < 10; i++) {
      var sp = PHYS.PIN_SPOTS[i], m = pinMeshes[i];
      m.matrix.compose(_v1.set(sp.x, 0, sp.z), _q1.identity(), _s1);
      m.visible = true; m.matrixWorldNeedsUpdate = true;
    }
  }

  /* ══ 카메라 ══ */
  function camWant(bx, by, bz) {
    var fFollow = smooth((bz - FOLLOW_Z0) / (FOLLOW_Z1 - FOLLOW_Z0));
    var fImpact = easeInOut((bz - IMPACT_Z0) / (IMPACT_Z1 - IMPACT_Z0));
    camState = fImpact > 0.55 ? 'IMPACT' : (fFollow > 0.45 ? 'FOLLOW' : 'READY');

    /* READY → FOLLOW */
    wantPos.set(
      CAM.READY.pos[0] + (bx + CAM.FOLLOW.dPos[0] - CAM.READY.pos[0]) * fFollow,
      CAM.READY.pos[1] + (by + CAM.FOLLOW.dPos[1] - CAM.READY.pos[1]) * fFollow,
      CAM.READY.pos[2] + (bz + CAM.FOLLOW.dPos[2] - CAM.READY.pos[2]) * fFollow);
    wantTgt.set(
      CAM.READY.tgt[0] + (bx * 0.6 + CAM.FOLLOW.dTgt[0] - CAM.READY.tgt[0]) * fFollow,
      CAM.READY.tgt[1] + (by + CAM.FOLLOW.dTgt[1] - CAM.READY.tgt[1]) * fFollow,
      CAM.READY.tgt[2] + (bz + CAM.FOLLOW.dTgt[2] - CAM.READY.tgt[2]) * fFollow);

    /* → IMPACT */
    if (fImpact > 0) {
      _v2.set(CAM.IMPACT.pos[0] + bx * 0.22, CAM.IMPACT.pos[1], CAM.IMPACT.pos[2]);
      _v3.set(CAM.IMPACT.tgt[0], CAM.IMPACT.tgt[1], CAM.IMPACT.tgt[2]);
      wantPos.lerp(_v2, fImpact);
      wantTgt.lerp(_v3, fImpact);
    }
    var fov = CAM.READY.fov + (CAM.IMPACT.fov - CAM.READY.fov) * fImpact;
    if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  }
  function camApply(dt, snapNow) {
    /* 지수 감쇠 — 프레임레이트와 무관하게 같은 느낌 */
    var k = snapNow ? 1 : (1 - Math.exp(-dt * 7.5));
    camPos.lerp(wantPos, k);
    camTgt.lerp(wantTgt, k);
    camera.position.copy(camPos);
    camera.lookAt(camTgt);
  }
  function camReset() {
    camState = 'READY';
    camera.fov = CAM.READY.fov; camera.updateProjectionMatrix();
    camWant(0, D.BALL_R, 0.45);
    camPos.copy(wantPos); camTgt.copy(wantTgt);
    camera.position.copy(camPos);
    camera.lookAt(camTgt);
  }

  /* ══ 리셋 ══ */
  function reset() {
    state = 'ready';
    play = null;
    if (solving) { if (solving.world) PHYS.disposeWorld(solving.world); solving = null; }
    poseIdle(D.BALL_R, 0.45);
    camReset();
    if (sounds.rollStop) try { sounds.rollStop(); } catch (e) { }
  }

  /* ══ 목표 핀 수를 내는 투구 탐색 ══
     ① 표(bowling3d-table.js)에서 후보를 꺼내고
     ② 한 판 녹화하면서 돌려 핀 수를 확인한다 (프레임 예산만큼 나눠서)
     ③ 어긋나면 다음 후보. 표가 없으면 격자 탐색으로 떨어진다.               */
  /* 목표 핀 수 하나에 대한 후보 목록을 만든다 */
  function buildList(target, gutter) {
    var list = [];
    if (gutter) {
      for (var g = 0; g < 8; g++) list.push(PHYS.gutterCandidate(rand));
    } else if (_table && _table.countFor(target) > 0) {
      var cnt = _table.countFor(target), off = Math.floor(rand() * cnt);
      for (var i = 0; i < cnt; i++) {
        var c = _table.pick(target, off + i);
        /* 첫 후보는 살짝 흔들어 매 판 다른 구질로 — 어긋나면 원본으로 되돌린다 */
        if (i === 0) { list.push(PHYS.jitter(c, rand, 1)); list.push(c); }
        else list.push(c);
      }
      /* 표가 전부 어긋나는 일은 없어야 하지만, 최후 보루로 격자도 붙인다 */
      list = list.concat(PHYS.candidateList(rand).slice(0, SOLVE_MAX_TRIES));
    } else {
      list = PHYS.candidateList(rand).slice(0, SOLVE_MAX_TRIES * 3);
    }
    return list;
  }

  /* 목표 핀 수 여러 개를 순서대로 시도한다.
     앞의 것이 물리적으로 안 나오면 (예: 1핀은 이 물리에서 사실상 불가능) 다음 것으로.
     targets 는 같은 당첨 구간 안의 핀 수들이라 경품은 그대로다. */
  function solveBegin(targets, gutter) {
    solving = {
      targets: targets, ti: 0, gutter: !!gutter,
      target: targets[0], list: buildList(targets[0], gutter), idx: 0,
      run: null, world: null, tries: 0, t0: performance.now(), bestDown: -1, result: null
    };
  }
  /* 예산만큼 진행. 끝나면 solving.result 를 채운다. */
  function solveStep(budgetMs) {
    var s = solving;
    if (!s || s.result) return;
    var t0 = performance.now();
    while (performance.now() - t0 < budgetMs) {
      if (!s.run) {
        if (s.idx >= s.list.length) {
          /* 이 핀 수는 못 만들었다 — 같은 구간의 다음 핀 수로 넘어간다 */
          if (s.ti + 1 < s.targets.length) {
            s.ti++;
            s.target = s.targets[s.ti];
            s.list = buildList(s.target, s.gutter);
            s.idx = 0;
            continue;
          }
          /* 구간 전체가 안 되면 "비슷한 것" 으로 때우지 않고 실패로 넘긴다
             → 호출측이 추첨 결과를 그대로 들고 2D 로 떨어진다. */
          s.result = { fail: true, near: s.bestDown };
          return;
        }
        s.world = PHYS.createBowlingWorld(RAPIER);
        s.cand = s.list[s.idx++];
        s.run = PHYS.beginRun(s.world, PHYS.toParams(s.cand), true);
        s.tries++;
      }
      var left = budgetMs - (performance.now() - t0);
      if (left <= 0.3) return;
      if (!PHYS.advance(s.run, left)) return;        /* 아직 더 돌려야 한다 */

      var r = s.run, ok = (r.down === s.target);
      var rec = {
        frames: r.frames, times: r.times, events: r.events,
        firstHit: r.firstHit, down: r.down, mask: r.mask, cand: s.cand
      };
      if (ok) { s.result = rec; PHYS.disposeWorld(s.world); s.world = null; s.run = null; return; }
      /* 실패본은 녹화를 통째로 들고 있지 않는다 — 진단용 숫자만 남긴다 */
      if (s.bestDown < 0 || Math.abs(r.down - s.target) < Math.abs(s.bestDown - s.target)) s.bestDown = r.down;
      PHYS.disposeWorld(s.world); s.world = null; s.run = null;
    }
  }

  /* ══ 한 판 ══ */
  function roll(req) {
    if (state !== 'ready' && state !== 'done') return Promise.reject(new Error('busy'));
    req = req || {};
    var target = (req.gutter || req.n === 0) ? 0 : Math.max(1, Math.min(10, req.n | 0));
    var gutter = (target === 0);
    /* 같은 당첨 구간 안의 다른 핀 수들 — 첫 번째가 물리적으로 안 나올 때의 대안 */
    var targets = [target];
    if (!gutter && req.alts) {
      for (var ai = 0; ai < req.alts.length; ai++) {
        var a = req.alts[ai] | 0;
        if (a >= 1 && a <= 10 && targets.indexOf(a) < 0) targets.push(a);
      }
    }

    reset();
    state = 'setup';
    setupT0 = performance.now();
    setupX = 0; readyAt = -1;
    dbg.tries = 0; dbg.solveMs = 0;
    solveBegin(targets, gutter);
    if (sounds.set) try { sounds.set(); } catch (e) { }

    return new Promise(function (resolve) { pending = { resolve: resolve, target: target }; });
  }

  function startPlayback(rec) {
    play = {
      frames: rec.frames, times: rec.times, events: rec.events,
      firstHit: rec.firstHit, down: rec.down, mask: rec.mask,
      pt: 0, idx: 0, evIdx: 0, rate: 1, hitAt: -1, rolling: false
    };
    state = 'play';
    var dur = rec.times[rec.times.length - 1];
    if (sounds.roll) try { sounds.roll(dur * 1000); } catch (e) { }
    play.rolling = true;
  }

  function finishPlayback() {
    state = 'done';
    if (sounds.rollStop) try { sounds.rollStop(); } catch (e) { }
    var out = { down: play ? play.down : 0, mask: play ? play.mask : 0 };
    out.strike = (out.down === 10);
    var p = pending; pending = null;
    if (p) p.resolve(out);
  }

  /* ══ 프레임 루프 ══ */
  function frame(now) {
    if (disposed) return;
    raf = requestAnimationFrame(frame);
    /* 아주 느린 기기에서 한 프레임이 길어져도 재생이 통째로 건너뛰지 않게 막는다.
       다만 상한이 너무 작으면 저프레임에서 재생이 늘어져 보여서 0.1s 로 둔다. */
    var dt = Math.min(0.10, (now - lastT) / 1000); lastT = now;

    if (debugOn) {
      dbg.frames++;
      if (now - dbg.fpsT0 > 500) {
        dbg.fps = dbg.frames * 1000 / (now - dbg.fpsT0);
        dbg.frames = 0; dbg.fpsT0 = now;
      }
    }

    var bx = 0, by = D.BALL_R, bz = 0.45, speed = 0;

    if (state === 'setup') {
      /* 셋업 연출 — 이 사이에 물리를 나눠 돌린다 */
      var st0 = performance.now();
      solveStep(SOLVE_BUDGET_MS);
      dbg.solveMs += performance.now() - st0;
      if (solving) dbg.tries = solving.tries;

      var ms = reduced ? SETUP_MS_REDUCED : SETUP_MS;
      var q = clamp01((now - setupT0) / ms);
      by = D.BALL_R + 0.085 * (1 - easeInOut(q));

      /* 릴리스 지점이 레인 중앙이 아닐 수 있다. 탐색이 끝나는 순간부터 공을
         그 지점으로 부드럽게 옮겨둬야, 재생이 시작될 때 옆으로 튀지 않는다. */
      var ready = solving && solving.result;
      if (ready && readyAt < 0) readyAt = now;
      var aimX = (ready && solving.result.frames) ? solving.result.frames[0][0] : 0;
      setupX += (aimX - setupX) * (1 - Math.exp(-dt * 9));
      poseIdle(by, 0.45, setupX);
      bx = setupX; bz = 0.45;

      var settled = readyAt >= 0 && (now - readyAt) > (reduced ? 120 : 260);
      if (q >= 1 && ready && settled) {
        var rec = solving.result;
        if (solving.world) { PHYS.disposeWorld(solving.world); solving.world = null; }
        solving = null;
        if (rec.fail || !rec.frames) {
          /* 목표 핀 수를 내는 투구를 못 찾았다 — 재생하지 않고 실패를 알린다 */
          state = 'done';
          if (sounds.rollStop) try { sounds.rollStop(); } catch (e) { }
          var pf = pending; pending = null;
          if (pf) pf.resolve({ fail: true, near: rec.near, down: 0, mask: 0, strike: false });
        } else startPlayback(rec);
      }
    } else if ((state === 'play' || state === 'done') && play) {
      /* done 이어도 마지막 프레임을 계속 붙잡는다.
         여기서 초기 포즈로 돌려버리면 쓰러진 핀을 한 프레임도 못 보고
         결과 화면이 "핀이 다 서 있는 그림" 이 된다. 리셋은 reset() 이 한다. */
      if (state === 'play') {
        /* 슬로모션 — 첫 착탄 직후 짧게 */
        var rate = 1;
        if (!reduced && play.firstHit >= 0 && play.pt >= play.firstHit) {
          var er = play.pt - play.firstHit;
          if (er < SLOMO_HOLD) rate = SLOMO_RATE;
          else if (er < SLOMO_HOLD + SLOMO_BACK)
            rate = SLOMO_RATE + (1 - SLOMO_RATE) * ((er - SLOMO_HOLD) / SLOMO_BACK);
        }
        play.rate = rate;
        play.pt += dt * rate;
      }

      var T = play.times, F = play.frames, last = T.length - 1;
      while (play.idx < last && T[play.idx + 1] <= play.pt) play.idx++;
      var i0 = play.idx, i1 = Math.min(last, i0 + 1);
      var span = T[i1] - T[i0];
      var f = span > 1e-6 ? clamp01((play.pt - T[i0]) / span) : 0;
      if (i0 === i1) poseFromFrame(F[i0]); else poseLerp(F[i0], F[i1], f);

      var fr = F[i0];
      bx = fr[0]; by = fr[1]; bz = fr[2];
      if (i1 !== i0 && span > 1e-6) {
        speed = Math.hypot(F[i1][0] - fr[0], F[i1][1] - fr[1], F[i1][2] - fr[2]) / span;
      }

      /* 소리 이벤트 */
      var due = null, EV = play.events;
      while (state === 'play' && play.evIdx < EV.length && EV[play.evIdx].t <= play.pt) {
        (due || (due = [])).push(EV[play.evIdx]); play.evIdx++;
      }
      if (due) {
        if (play.hitAt < 0) {
          for (var k = 0; k < due.length; k++) {
            if (due[k].k === 'first' || due[k].k === 'pin') {
              play.hitAt = play.pt;
              if (play.rolling && sounds.rollStop) { try { sounds.rollStop(); } catch (e) { } play.rolling = false; }
              break;
            }
          }
        }
        if (sounds.fire) try { sounds.fire(due); } catch (e) { }
      }
      if (state === 'play' && play.rolling && sounds.rollUpdate) {
        try { sounds.rollUpdate(clamp01(bz / D.HEADPIN_Z), bx / D.LANE_HALF); } catch (e) { }
      }

      if (state === 'play' && play.pt >= T[last]) finishPlayback();
    } else {
      poseIdle(D.BALL_R, 0.45);
    }

    /* 카메라 */
    camWant(bx, by, bz);
    camApply(dt, state === 'setup' || state === 'ready');

    /* 그림자 카메라를 공과 함께 옮긴다 (방향은 그대로) */
    _v1.set(bx, 0, Math.min(bz, D.HEADPIN_Z + 0.3));
    sun.target.position.copy(_v1);
    sun.position.copy(_v1).add(sunOff);

    renderer.render(scene, camera);
    if (debugOn) paintDebug(bx, by, bz, speed);
  }

  /* ══ 디버그 오버레이 (?bowlingDebug=1 에서만) ══ */
  var dbgEl = null;
  if (debugOn) {
    dbgEl = document.createElement('div');
    dbgEl.style.cssText = 'position:absolute;left:6px;top:6px;z-index:9;pointer-events:none;' +
      'font:11px/1.45 ui-monospace,Menlo,Consolas,monospace;color:#9effa8;' +
      'background:rgba(0,0,0,.62);padding:6px 8px;border-radius:6px;white-space:pre;';
    root.appendChild(dbgEl);
  }
  function paintDebug(bx, by, bz, speed) {
    var downs = '';
    if (play) for (var i = 0; i < 10; i++) downs += (play.mask & (1 << i)) ? '×' : 'I';
    dbgEl.textContent =
      'fps    ' + dbg.fps.toFixed(0) + '  dpr ' + renderer.getPixelRatio().toFixed(2) + '\n' +
      'state  ' + state + '  cam ' + camState + '\n' +
      'ball   ' + bx.toFixed(3) + ' ' + by.toFixed(3) + ' ' + bz.toFixed(2) + '\n' +
      'speed  ' + speed.toFixed(2) + ' m/s  rate ' + (play ? play.rate.toFixed(2) : '-') + '\n' +
      'solve  ' + dbg.tries + '회 ' + dbg.solveMs.toFixed(0) + 'ms' +
      (_table ? '' : ' (표없음)') + '\n' +
      'pins   ' + (downs || '----------') + '  down ' + (play ? play.down : 0) + '\n' +
      'frames ' + (play ? (play.idx + '/' + play.frames.length) : '-');
  }

  /* ══ 크기 ══ */
  function resize() {
    var w = root.clientWidth || 1, h = root.clientHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, small ? 1.5 : 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  var ro = null;
  if (window.ResizeObserver) { ro = new ResizeObserver(resize); ro.observe(root); }
  window.addEventListener('resize', resize);

  /* ══ 입력 ══
     데스크톱: 캔버스 드래그로 READY 시점을 살짝 둘러보고, 위로 스와이프하면 투구
     모바일  : 같은 제스처. 캔버스 안에서만 처리해 스크롤과 싸우지 않는다.
     ※ 조준으로 결과를 바꾸지는 않는다 — 핀 수는 가중치 추첨이 먼저 정한다. */
  var look = { x: 0, y: 0 };
  var drag = null;
  var el = renderer.domElement;
  function onDown(e) {
    if (state !== 'ready' && state !== 'done') return;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: 0 };
    try { el.setPointerCapture(e.pointerId); } catch (err) { }
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    drag.moved = Math.max(drag.moved, Math.hypot(dx, dy));
    look.x = Math.max(-1, Math.min(1, dx / 260));
    look.y = Math.max(-1, Math.min(1, dy / 320));
    e.preventDefault();
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    var dy = e.clientY - drag.y0, dx = e.clientX - drag.x0;
    var fast = performance.now() - drag.t0 < 700;
    drag = null;
    try { el.releasePointerCapture(e.pointerId); } catch (err) { }
    look.x = 0; look.y = 0;
    /* 위로 확실히 밀어올리면 투구 */
    if (fast && dy < -60 && Math.abs(dy) > Math.abs(dx) && opts.onSwipeThrow) {
      try { opts.onSwipeThrow(); } catch (err) { }
    }
  }
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove, { passive: false });
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  /* READY 둘러보기를 카메라에 섞는다 */
  var baseCamWant = camWant;
  camWant = function (bx, by, bz) {
    baseCamWant(bx, by, bz);
    if (state === 'ready' || state === 'done') {
      wantPos.x += look.x * 0.55;
      wantPos.y += -look.y * 0.35;
      wantTgt.x += look.x * 0.22;
    }
  };

  /* ══ 정리 ══ */
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (raf) cancelAnimationFrame(raf); raf = null;
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    el.removeEventListener('pointercancel', onUp);
    window.removeEventListener('resize', resize);
    if (ro) { try { ro.disconnect(); } catch (e) { } ro = null; }
    if (solving && solving.world) PHYS.disposeWorld(solving.world);
    solving = null;
    play = null;
    if (pending) { pending.resolve({ down: 0, mask: 0, strike: false, aborted: true }); pending = null; }
    scene.traverse(function (o) { if (o.isMesh) { o.geometry = null; o.material = null; } });
    junk.forEach(function (o) { try { o.dispose(); } catch (e) { } });
    junk.length = 0;
    renderer.dispose();
    /* WebGL 컨텍스트를 바로 반납한다 — 게임을 오가며 컨텍스트가 쌓이지 않게 */
    try { renderer.forceContextLoss(); } catch (e) { }
    if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    if (dbgEl && dbgEl.parentNode) dbgEl.parentNode.removeChild(dbgEl);
  }

  /* ══ 기동 ══ */
  /* 워밍업 — WASM 과 JIT 를 한 번 달궈둔다. 이걸 안 하면 첫 투구의 탐색이
     두세 배 느려서 셋업 연출 안에 못 들어온다. (거터볼은 가장 싼 판) */
  try { PHYS.simulate(RAPIER, PHYS.toParams(PHYS.gutterCandidate(rand)), false); } catch (e) { }

  resize();
  reset();
  lastT = performance.now();
  dbg.fpsT0 = lastT;
  raf = requestAnimationFrame(frame);

  /* ── 검증용 측정 ── 화면 구도와 핀의 실제 부피를 수치로 뽑는다.
     (tools/bowl3d-browser.mjs 가 쓴다. 일반 동작에는 영향이 없다) */
  var _box = new THREE.Box3(), _sz = new THREE.Vector3(), _pv = new THREE.Vector3();
  function ndc(v) {
    _pv.copy(v).project(camera);
    return { x: +_pv.x.toFixed(4), y: +_pv.y.toFixed(4) };   /* -1(아래/왼쪽) ~ +1 */
  }
  function probe() {
    camera.updateMatrixWorld(true);
    var pins = [], i;
    for (i = 0; i < 10; i++) {
      var m = pinMeshes[i];
      m.updateMatrixWorld(true);
      _box.setFromObject(m);
      _box.getSize(_sz);
      /* 핀의 위쪽 축이 월드 up 과 이루는 각 — 물리의 넘어짐 판정과 같은 기준 */
      _q1.setFromRotationMatrix(m.matrix);
      var up = _v3.set(0, 1, 0).applyQuaternion(_q1);
      var tilt = Math.acos(Math.max(-1, Math.min(1, up.y))) * 180 / Math.PI;
      _pv.set(0, 0, 0).applyMatrix4(m.matrix);
      pins.push({
        n: i + 1, tilt: +tilt.toFixed(1),
        world: { x: +_pv.x.toFixed(4), y: +_pv.y.toFixed(4), z: +_pv.z.toFixed(4) },
        /* 월드 AABB 의 세 변 — 납작해지면 최소변이 0 에 가까워진다 */
        size: [+_sz.x.toFixed(4), +_sz.y.toFixed(4), +_sz.z.toFixed(4)],
        screen: ndc(_pv.set(0, PHYS.DIM.PIN_H * 0.5, 0).applyMatrix4(m.matrix))
      });
    }
    _pv.set(0, 0, 0).applyMatrix4(ball.matrix);
    var bw = { x: +_pv.x.toFixed(4), y: +_pv.y.toFixed(4), z: +_pv.z.toFixed(4) };
    return {
      state: state, camState: camState,
      mask: play ? play.mask : 0, down: play ? play.down : 0,
      camera: {
        pos: [+camera.position.x.toFixed(3), +camera.position.y.toFixed(3), +camera.position.z.toFixed(3)],
        fov: camera.fov, aspect: +camera.aspect.toFixed(3)
      },
      ball: { world: bw, screen: ndc(_pv.set(bw.x, bw.y, bw.z)) },
      pins: pins,
      /* 핀 줄별 화면 세로 위치 — 줄이 구분되는지 보는 값 */
      rowY: [0, 1, 2, 3].map(function (r) {
        var idx = r === 0 ? [0] : r === 1 ? [1, 2] : r === 2 ? [3, 4, 5] : [6, 7, 8, 9];
        var sum = 0;
        idx.forEach(function (k) { sum += pins[k].screen.y; });
        return +(sum / idx.length).toFixed(4);
      })
    };
  }

  return {
    roll: roll, reset: reset, resize: resize, dispose: dispose, probe: probe,
    get busy() { return state === 'setup' || state === 'play'; },
    get camState() { return camState; },
    _scene: scene, _camera: camera, _renderer: renderer,
    _debug: function () { return { state: state, camState: camState, dbg: dbg, play: play }; }
  };
}

export var VERSION = '3d-1.0';
