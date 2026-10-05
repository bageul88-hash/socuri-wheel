/* ══════════════════════════════════════════════════════════════════════════
   bowling3d-physics.js — 3D 볼링 물리 코어 (Rapier 3D)

   · RAPIER 를 인자로 주입받으므로 브라우저와 Node 양쪽에서 같은 코드를 돌린다.
     (tools/bowl3d-test.mjs 로 핀 수 분포·안정성을 실제로 검증한다)
   · 좌표계:  X = 좌우(레인 중앙 0)  ·  Y = 위  ·  Z = 레인 진행 방향
     파울라인 z=0, 1번 핀 z=18.288 (60ft)
   · 단위는 전부 미터/킬로그램/초 — 실제 볼링 규격을 그대로 쓴다.
   ══════════════════════════════════════════════════════════════════════════ */

/* ── 규격 ── */
export var DIM = {
  LANE_W:      1.0566,          /* 레인 폭 41.5in */
  LANE_HALF:   0.5283,
  FOUL_Z:      0,
  HEADPIN_Z:   18.288,          /* 파울라인 → 1번 핀 60ft */
  PIN_SPACING: 0.3048,          /* 핀 간격 12in */
  ROW_D:       0.3048 * Math.sqrt(3) / 2,   /* 줄 간 거리 0.2639 */
  PIN_H:       0.3810,          /* 핀 높이 15in */
  PIN_MAXR:    0.0602,          /* 배 부분 최대 반지름 */
  BALL_R:      0.1086,          /* 공 반지름 (지름 8.55in) */
  BALL_M:      6.35,            /* 14lb */
  PIN_M:       1.55,            /* 3lb 6oz */
  GUTTER_W:    0.2350,
  GUTTER_D:    0.0850,          /* 거터 깊이 */
  DECK_FRONT:  18.288 - 0.470,  /* 핀덱 시작 */
  DECK_END:    18.288 + 1.040,  /* 핀덱 끝 (핏 입구) */
  PIT_Y:      -0.620,           /* 핏 바닥 */
  PIT_END:     18.288 + 2.400,  /* 핏 뒤벽 */
  APPROACH_Z: -4.600            /* 어프로치(파울라인 뒤) 길이 */
};

/* ── 10핀 삼각 배치 (레인 중앙 기준 x, 1번핀 기준 z) ──
         7   8   9   10
           4   5   6
             2   3
               1                                                           */
export var PIN_SPOTS = (function(){
  var S = DIM.PIN_SPACING, R = DIM.ROW_D, a = [];
  a.push([0, 0]);                                                  /* 1 */
  a.push([-S / 2, R]);    a.push([S / 2, R]);                       /* 2 3 */
  a.push([-S, 2 * R]);    a.push([0, 2 * R]);  a.push([S, 2 * R]);  /* 4 5 6 */
  a.push([-1.5 * S, 3 * R]); a.push([-S / 2, 3 * R]);
  a.push([S / 2, 3 * R]);    a.push([1.5 * S, 3 * R]);              /* 7 8 9 10 */
  return a.map(function (p) { return { x: p[0], z: DIM.HEADPIN_Z + p[1] }; });
})();

/* ── 핀 실루엣(회전 단면) — 렌더의 LatheGeometry 와 콜라이더가 같은 프로파일을 쓴다.
      [높이 y, 반지름 r] — USBC 규격 핀을 근사한다. ── */
export var PIN_PROFILE = [
  [0.0000, 0.0254], [0.0127, 0.0292], [0.0254, 0.0330], [0.0432, 0.0432],
  [0.0610, 0.0511], [0.0813, 0.0570], [0.1016, 0.0595], [0.1143, 0.0602],
  [0.1397, 0.0597], [0.1651, 0.0562], [0.1905, 0.0511], [0.2159, 0.0432],
  [0.2413, 0.0343], [0.2667, 0.0260], [0.2794, 0.0238], [0.2921, 0.0241],
  [0.3048, 0.0273], [0.3175, 0.0318], [0.3302, 0.0343], [0.3429, 0.0333],
  [0.3556, 0.0292], [0.3683, 0.0203], [0.3785, 0.0095], [0.3810, 0.0000]
];

/* 핀 red band 두 줄 (렌더용, 높이 구간) */
export var PIN_BANDS = [[0.2730, 0.2870], [0.3000, 0.3140]];

/* ── 콜라이더 구성 — 프로파일을 5조각으로 근사한다.
      질량을 조각마다 직접 주어 무게중심을 실제 핀처럼 아래(≈0.145m)에 둔다. ── */
/* 검증 스크립트가 같은 모양으로 겹침을 재도록 내보낸다 */
export var PIN_PARTS = [
  { k: 'cyl',  y: 0.030, h: 0.030, r: 0.0355, m: 0.40 },   /* 밑동 */
  { k: 'cyl',  y: 0.115, h: 0.055, r: 0.0592, m: 0.58 },   /* 배 */
  { k: 'cyl',  y: 0.212, h: 0.042, r: 0.0400, m: 0.32 },   /* 어깨 */
  { k: 'cyl',  y: 0.280, h: 0.026, r: 0.0250, m: 0.10 },   /* 목 */
  { k: 'ball', y: 0.330,           r: 0.0340, m: 0.15 }    /* 머리 */
];

/* ── 물리 계수 ── */
export var TUNE = {
  gravity:        -9.81,
  laneFriction:    0.085,       /* 오일 먹은 레인 — 낮지만 0 은 아니다 */
  ballFriction:    0.160,
  ballRest:        0.050,
  /* 바닥이 한 덩어리라 핀덱만 따로 마찰을 줄 수 없다. Rapier 의 기본 결합은
     평균이므로, 핀↔바닥 마찰이 예전 핀덱 값(≈0.22)과 같아지게 핀 쪽을 올린다.
     (0.085 + 0.355) / 2 = 0.22 */
  pinFriction:     0.355,
  pinRest:         0.420,
  pinLinDamp:      0.080,
  pinAngDamp:      0.260,       /* 공중에서 영원히 돌지 않게 */
  ballLinDamp:     0.010,
  ballAngDamp:     0.030,
  wallRest:        0.280,
  wallFriction:    0.320,
  forceThreshold:  22.0,        /* 이 이상의 접촉력만 소리 이벤트로 */
  solverIters:     6
};

/* 핀 넘어짐 판정 — 기울기 40° 초과, 또는 핀덱/레인 밖, 또는 자리에서 크게 이탈 */
export var DOWN_TILT = 40 * Math.PI / 180;
export var DOWN_SHIFT = 0.085;        /* 제 자리에서 이만큼 밀려나면 down */

/* 쿼터니언에서 "핀의 위쪽 축" 의 y 성분 */
function upY(q) { return 1 - 2 * (q.x * q.x + q.z * q.z); }

/* 결정론적 LCG — 같은 seed 는 항상 같은 결과 */
export function rng(seed) {
  var s = (seed | 0) || 1;
  return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/* ══════════════════════════════════════════════════════════════════════════
   월드 구성
   ══════════════════════════════════════════════════════════════════════════ */
export function createBowlingWorld(RAPIER) {
  var D = DIM, T = TUNE;
  var world = new RAPIER.World({ x: 0, y: T.gravity, z: 0 });
  world.timestep = 1 / 240;
  try { world.numSolverIterations = T.solverIters; } catch (e) { }

  var kinds = Object.create(null);  /* colliderHandle → lane|pin|ball|gutter|wall|pit */

  function fixedBox(hx, hy, hz, x, y, z, fric, rest, kind) {
    var cd = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z)
      .setFriction(fric).setRestitution(rest);
    var c = world.createCollider(cd);
    kinds[c.handle] = kind;
    return c;
  }

  /* ── 바닥: 어프로치 ~ 핀덱 끝까지 "한 덩어리" ──
     레인과 핀덱을 윗면이 맞닿는 두 상자로 나누면, 그 이음매의 모서리가 굴러오는
     공을 위로 차올린다 (훅이 걸린 공은 9cm 이상 떴다). 마찰을 구간별로 다르게
     주려고 쪼갰던 건데, 그 대가가 너무 크다. 그래서 바닥은 하나로 두고
     핀덱 접지감은 핀 쪽 마찰(TUNE.pinFriction)로 맞춘다. */
  var laneZ0 = D.APPROACH_Z, laneZ1 = D.DECK_END;
  fixedBox(D.LANE_HALF, 0.30, (laneZ1 - laneZ0) / 2, 0, -0.30, (laneZ0 + laneZ1) / 2,
    T.laneFriction, 0.02, 'lane');

  /* ── 좌우 거터 (레인면보다 낮은 홈) ── */
  var gx = D.LANE_HALF + D.GUTTER_W / 2;
  [-1, 1].forEach(function (s) {
    fixedBox(D.GUTTER_W / 2, 0.20, (D.DECK_END - laneZ0) / 2, s * gx, -D.GUTTER_D - 0.20,
      (laneZ0 + D.DECK_END) / 2, 0.040, 0.10, 'gutter');
    /* 거터 바깥 벽 */
    fixedBox(0.06, 0.30, (D.DECK_END - laneZ0) / 2, s * (D.LANE_HALF + D.GUTTER_W + 0.06),
      0.22, (laneZ0 + D.DECK_END) / 2, 0.20, 0.20, 'wall');
  });

  /* ── 킥백 — 핀덱 구간 좌우 벽. 실제 레인처럼 핀이 여기서 튕긴다.
        거터로 빠진 공이 코너핀을 건드리지 못하게 막아주는 역할도 한다. ── */
  [-1, 1].forEach(function (s) {
    var z0 = D.HEADPIN_Z - 0.55;
    fixedBox(0.015, 0.33, (D.DECK_END - z0) / 2,
      s * (D.LANE_HALF + 0.015), 0.33, (z0 + D.DECK_END) / 2,
      T.wallFriction, T.wallRest, 'wall');
  });

  /* ── 핏 (핀덱 뒤 낙하 공간) ── */
  fixedBox(D.LANE_HALF + D.GUTTER_W + 0.12, 0.20, (D.PIT_END - D.DECK_END) / 2,
    0, D.PIT_Y - 0.20, (D.DECK_END + D.PIT_END) / 2, 0.50, 0.05, 'pit');
  fixedBox(D.LANE_HALF + D.GUTTER_W + 0.12, 0.70, 0.08,
    0, D.PIT_Y + 0.70, D.PIT_END + 0.08, 0.60, 0.05, 'pit');

  /* ── 공 ── */
  var ballBody = world.createRigidBody(
    RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, D.BALL_R, 0.4)
      .setLinearDamping(T.ballLinDamp).setAngularDamping(T.ballAngDamp)
      .setCcdEnabled(true).setCanSleep(true));
  var ballCol = world.createCollider(
    RAPIER.ColliderDesc.ball(D.BALL_R).setMass(D.BALL_M)
      .setFriction(T.ballFriction).setRestitution(T.ballRest)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(T.forceThreshold), ballBody);
  kinds[ballCol.handle] = 'ball';

  /* ── 핀 10개 ── */
  var pinBodies = [], pinOfCollider = Object.create(null);
  PIN_SPOTS.forEach(function (sp, i) {
    var b = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(sp.x, 0.0005, sp.z)
        .setLinearDamping(T.pinLinDamp).setAngularDamping(T.pinAngDamp)
        .setCanSleep(true).setCcdEnabled(true));
    PIN_PARTS.forEach(function (pt) {
      var cd = (pt.k === 'ball')
        ? RAPIER.ColliderDesc.ball(pt.r)
        : RAPIER.ColliderDesc.cylinder(pt.h, pt.r);
      cd.setTranslation(0, pt.y, 0).setMass(pt.m)
        .setFriction(T.pinFriction).setRestitution(T.pinRest)
        .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(T.forceThreshold);
      var c = world.createCollider(cd, b);
      kinds[c.handle] = 'pin';
      pinOfCollider[c.handle] = i;
    });
    pinBodies.push(b);
  });

  var eventQueue = new RAPIER.EventQueue(true);

  /* ── 초기화: 공·핀 전부 제자리로, 속도 0 ── */
  function reset() {
    ballBody.setTranslation({ x: 0, y: D.BALL_R, z: 0.4 }, true);
    ballBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    ballBody.setLinvel({ x: 0, y: 0, z: 0 }, true);
    ballBody.setAngvel({ x: 0, y: 0, z: 0 }, true);
    ballBody.wakeUp();
    for (var i = 0; i < 10; i++) {
      var b = pinBodies[i], sp = PIN_SPOTS[i];
      b.setTranslation({ x: sp.x, y: 0.0005, z: sp.z }, true);
      b.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      b.wakeUp();
    }
    eventQueue.clear();
  }

  /* ── 투구: 릴리스 파라미터를 공에 넣는다 ──
     p = { x, z, vz, vx, hook, spin }
       x    릴리스 좌우 위치 (m)
       vz   전진 속도 (m/s)
       vx   좌우 속도 (조준 각)
       hook 축을 기울인 회전 — 레인 마찰이 이 성분을 옆으로 바꿔 훅이 걸린다
       spin 수직축 회전 (핀 액션에 미세하게 기여)                             */
  function launch(p) {
    var vz = p.vz, vx = p.vx || 0;
    ballBody.setTranslation({ x: p.x, y: D.BALL_R + 0.001, z: (p.z == null ? 0.45 : p.z) }, true);
    ballBody.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    ballBody.setLinvel({ x: vx, y: 0, z: vz }, true);
    /* 굴림축은 X. hook 은 Z축(진행축) 성분 → 접지점이 옆으로 미끄러져 훅이 생긴다 */
    ballBody.setAngvel({ x: vz / D.BALL_R * 0.86, y: p.spin || 0, z: p.hook || 0 }, true);
    ballBody.wakeUp();
  }

  /* ── 핀 상태 ──
     바디 원점은 핀의 "밑면" 이다 (세워둔 핀의 y ≈ 0). 그래서 높이로 판정하면 안 되고
     ① 핏으로 떨어졌는지 ② 기울었는지 ③ 제 자리에서 밀려났는지 로 본다. */
  function pinIsDown(i) {
    var b = pinBodies[i], t = b.translation(), q = b.rotation();
    if (t.y < -0.20) return true;                       /* 핏으로 떨어짐 */
    if (t.z > D.DECK_END - 0.02) return true;           /* 핀덱 뒤로 넘어감 */
    if (Math.abs(t.x) > D.LANE_HALF + 0.03) return true;/* 거터/킥백 밖 */
    if (upY(q) < Math.cos(DOWN_TILT)) return true;      /* 기울어짐 */
    var sp = PIN_SPOTS[i];
    var dx = t.x - sp.x, dz = t.z - sp.z;
    return (dx * dx + dz * dz) > DOWN_SHIFT * DOWN_SHIFT;
  }

  /* 핏으로 떨어진 바디는 더 굴리지 않는다 — 결과에 영향이 없고,
     이걸 재워야 "전부 정지" 조기 종료가 실제로 걸린다. */
  function freezeFallen() {
    var i, b, t;
    for (i = 0; i < 10; i++) {
      b = pinBodies[i];
      if (b.isSleeping()) continue;
      t = b.translation();
      if (t.y < -0.30) {
        b.setLinvel({ x: 0, y: 0, z: 0 }, false);
        b.setAngvel({ x: 0, y: 0, z: 0 }, false);
        b.sleep();
      }
    }
    if (!ballBody.isSleeping()) {
      t = ballBody.translation();
      /* 핏 바닥까지 실제로 떨어진 뒤에 재운다. z 만 보고 재우면 공이 핏 위
         허공에 멈춰 떠 있는 그림이 된다. */
      if (t.y < -0.35) {
        ballBody.setLinvel({ x: 0, y: 0, z: 0 }, false);
        ballBody.setAngvel({ x: 0, y: 0, z: 0 }, false);
        ballBody.sleep();
      }
    }
  }
  function downMask() {
    var m = 0;
    for (var i = 0; i < 10; i++) if (pinIsDown(i)) m |= (1 << i);
    return m;
  }
  function downCount() {
    var n = 0, m = downMask();
    for (var i = 0; i < 10; i++) if (m & (1 << i)) n++;
    return n;
  }
  function allAsleep() {
    if (!ballBody.isSleeping()) {
      var t = ballBody.translation();
      if (t.z < D.DECK_END && t.y > D.PIT_Y + 0.4) return false;
    }
    for (var i = 0; i < 10; i++) {
      var b = pinBodies[i];
      if (b.isSleeping()) continue;
      var lv = b.linvel(), av = b.angvel();
      if (lv.x * lv.x + lv.y * lv.y + lv.z * lv.z > 0.0025) return false;
      if (av.x * av.x + av.y * av.y + av.z * av.z > 0.02) return false;
    }
    return true;
  }

  return {
    RAPIER: RAPIER, world: world, ball: ballBody, pins: pinBodies,
    eventQueue: eventQueue, kinds: kinds, pinOfCollider: pinOfCollider,
    reset: reset, launch: launch,
    downMask: downMask, downCount: downCount, pinIsDown: pinIsDown,
    allAsleep: allAsleep, freezeFallen: freezeFallen
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   한 번의 투구를 시뮬레이션한다.
   record=true 면 1/120 간격으로 모든 바디의 pose 와 충돌 이벤트를 녹화한다.
   ══════════════════════════════════════════════════════════════════════════ */
export var SIM = {
  DT_ROLL: 1 / 90,       /* 레인을 굴러오는 구간 — 공 하나뿐이라 거친 스텝으로 충분 */
  DT_FINE: 1 / 240,      /* 핀덱 근처 — 빠른 공·다물체 충돌이라 촘촘하게 */
  FINE_BEFORE: 2.0,      /* 1번 핀 이 거리 앞부터 DT_FINE */
  REC_HZ: 120,           /* 녹화 주기 */
  MAX_T: 8.0,
  SETTLE_T: 2.6          /* 첫 착탄 후 이만큼까지 돌린다 (탐색·녹화 동일) */
};

/* ── 한 판을 "조금씩" 돌릴 수 있는 실행 상태 ──
   투구 연출 중에 프레임 예산만큼 나눠 돌리기 위해 재개 가능한 구조로 만든다.

   ※ 월드는 매 판 새로 만들어야 한다. Rapier 는 접촉 매니폴드와 warm-start
     임펄스를 스텝 사이에 유지하기 때문에, 바디만 제자리로 옮겨 재사용하면
     같은 파라미터가 다른 결과를 내는 경우가 생긴다. (tools/bowl3d-test.mjs 6번)
     월드 생성 비용은 1ms 미만이라 매 판 새로 만드는 쪽이 싸고 안전하다. */
export function beginRun(W, p, record) {
  var run = {
    W: W, p: p, record: !!record,
    t: 0, dt: 0, lastRec: -9, firstHit: -1, pitSaid: -9, slideSaid: -9,
    frames: record ? [] : null, times: record ? [] : null, events: record ? [] : null,
    fineZ: DIM.HEADPIN_Z - SIM.FINE_BEFORE, recStep: 1 / SIM.REC_HZ,
    done: false, down: 0, mask: 0
  };
  W.reset();
  W.launch(p);
  if (run.record) snap(run);
  return run;
}

function snap(run) {
  var W = run.W, a = new Float32Array(77), o, i;
  var bt = W.ball.translation(), bq = W.ball.rotation();
  a[0] = bt.x; a[1] = bt.y; a[2] = bt.z;
  a[3] = bq.x; a[4] = bq.y; a[5] = bq.z; a[6] = bq.w;
  o = 7;
  for (i = 0; i < 10; i++) {
    var pt = W.pins[i].translation(), pq = W.pins[i].rotation();
    a[o] = pt.x; a[o + 1] = pt.y; a[o + 2] = pt.z;
    a[o + 3] = pq.x; a[o + 4] = pq.y; a[o + 5] = pq.z; a[o + 6] = pq.w;
    o += 7;
  }
  run.frames.push(a); run.times.push(run.t); run.lastRec = run.t;
}

var _now = (typeof performance !== 'undefined' && performance.now)
  ? function () { return performance.now(); }
  : function () { return Date.now(); };

/* budgetMs 를 주면 그만큼만 돌리고 반환한다 (run.done 으로 완료 확인).
   주지 않으면 끝까지 돌린다. */
export function advance(run, budgetMs) {
  if (run.done) return true;
  var W = run.W, D = DIM;
  var t0 = (budgetMs != null) ? _now() : 0;
  var guard = 0;

  while (run.t < SIM.MAX_T) {
    /* 스텝 간격 전환 — 탐색본과 녹화본이 반드시 같은 일정을 써야 결과가 일치한다 */
    var want = (W.ball.translation().z > run.fineZ) ? SIM.DT_FINE : SIM.DT_ROLL;
    if (want !== run.dt) { run.dt = want; W.world.timestep = want; }

    W.world.step(W.eventQueue);
    run.t += run.dt;
    W.freezeFallen();

    if (run.record) {
      W.eventQueue.drainContactForceEvents(function (ev) {
        var h1 = ev.collider1(), h2 = ev.collider2();
        var k1 = W.kinds[h1], k2 = W.kinds[h2];
        if (!k1 || !k2) return;
        var f = ev.totalForceMagnitude();
        var isBall = (k1 === 'ball' || k2 === 'ball');
        var isPin = (k1 === 'pin' || k2 === 'pin');
        var pi = (W.pinOfCollider[h1] != null) ? W.pinOfCollider[h1] : W.pinOfCollider[h2];
        var kind = null, px = 0;
        if (isBall && isPin) {
          if (run.firstHit < 0) { run.firstHit = run.t; kind = 'first'; } else kind = 'pin';
          px = W.ball.translation().x;
        } else if (k1 === 'pin' && k2 === 'pin') {
          kind = 'pin';
          px = (pi != null) ? W.pins[pi].translation().x : 0;
        } else if (isPin && (k1 === 'wall' || k2 === 'wall')) {
          kind = 'pin';
          px = (pi != null) ? W.pins[pi].translation().x : 0;
        } else if (isPin && (k1 === 'lane' || k2 === 'lane')) {
          if (run.t - run.slideSaid < 0.16) return;
          run.slideSaid = run.t; kind = 'slide';
          px = (pi != null) ? W.pins[pi].translation().x : 0;
        } else if (k1 === 'pit' || k2 === 'pit') {
          if (run.t - run.pitSaid < 0.12) return;
          run.pitSaid = run.t; kind = isBall ? 'pit' : 'pitpin';
        } else if (isBall && (k1 === 'gutter' || k2 === 'gutter')) {
          kind = 'gutter'; px = W.ball.translation().x;
        }
        if (!kind) return;
        run.events.push({ t: run.t, k: kind, j: f / 900, x: px / D.LANE_W });
      });
      W.eventQueue.clear();
      if (run.t - run.lastRec >= run.recStep) snap(run);
    } else {
      W.eventQueue.clear();
      if (run.firstHit < 0 &&
          W.ball.translation().z > D.HEADPIN_Z - D.BALL_R - D.PIN_MAXR - 0.03) {
        run.firstHit = run.t;
      }
    }

    /* 결과가 굳었으면 조기 종료 — 판정 시점을 탐색/녹화 양쪽에서 똑같이 맞춘다 */
    if (run.firstHit >= 0 && run.t - run.firstHit > SIM.SETTLE_T) break;
    if (run.firstHit >= 0 && run.t - run.firstHit > 0.8 && W.allAsleep()) break;
    if (run.firstHit < 0 && run.t > 1.2 && W.allAsleep()) break;   /* 거터볼 */
    if (run.firstHit < 0 && run.t > 4.6) break;

    /* 프레임 예산 — 8스텝마다 확인한다 */
    if (budgetMs != null && (++guard & 7) === 0 && _now() - t0 >= budgetMs) return false;
  }

  if (run.record) snap(run);
  run.down = W.downCount();
  run.mask = W.downMask();
  run.done = true;
  return true;
}

/* 한 번에 끝까지 — 검증 스크립트와 백그라운드 예열이 쓴다.
   RAPIER 를 주면 전용 월드를 만들어 쓰고 정리까지 한다. */
export function simulate(RAPIER_or_W, p, record) {
  var own = null, W;
  if (RAPIER_or_W && RAPIER_or_W.World) { own = createBowlingWorld(RAPIER_or_W); W = own; }
  else W = RAPIER_or_W;
  var run = beginRun(W, p, record);
  advance(run);
  var out = {
    down: run.down, mask: run.mask, t: run.t, firstHit: run.firstHit,
    frames: run.frames, times: run.times, events: run.events
  };
  if (own) disposeWorld(own);
  return out;
}

export function disposeWorld(W) {
  if (!W || W.disposed) return;
  W.disposed = true;
  try { W.eventQueue.free(); } catch (e) { }
  try { W.world.free(); } catch (e) { }
}


/* ══════════════════════════════════════════════════════════════════════════
   목표 핀 수(n)를 내는 릴리스 파라미터 탐색

   추첨(가중치)이 먼저 결과를 정하는 기존 계약을 지키기 위해,
   "그 결과가 실제로 나오는 물리"를 찾아 재생한다. (기존 2D 볼링과 같은 방식)
   ══════════════════════════════════════════════════════════════════════════ */

/* ── 조준 모델 ──
   레인 18.3m 를 굴러오는 동안 ① 좌우 속도 vx ② 훅(진행축 회전) 두 가지가
   도착 지점을 결정한다. 둘 다 거의 선형이라 측정값으로 역산할 수 있다.
   (tools/bowl3d-test.mjs 의 "조준 모델" 항목이 이 계수를 실제로 재검증한다)

     도착x ≈ 릴리스x + vx·(VXF/vz) − hook·(DEFL/vz)                            */
export var AIM = { DEFL: 0.535, VXF: 13.3 };

export function aimVx(xRelease, xArrive, hook, vz) {
  var defl = -hook * AIM.DEFL / vz;
  return (xArrive - xRelease - defl) * vz / AIM.VXF;
}

/* 후보 하나 → 릴리스 파라미터.
   c = { xr 릴리스 좌우, xa 핀 앞 도착 좌우, hook 훅, vz 속도 }                */
export function toParams(c) {
  return {
    x: c.xr, vz: c.vz, vx: aimVx(c.xr, c.xa, c.hook, c.vz),
    hook: c.hook, spin: 0, c: c
  };
}

/* 거터볼 — 핀을 건드리지 않고 홈으로 빠지는 투구.
   핀덱 구간의 킥백 벽이 코너핀을 막아주므로 0핀이 보장된다. */
export function gutterCandidate(rand) {
  var s = rand() < 0.5 ? -1 : 1;
  return {
    xr: s * (0.10 + rand() * 0.16),
    xa: s * (0.78 + rand() * 0.20),
    hook: s * (0.3 + rand() * 0.8),
    vz: 7.0 + rand() * 0.9,
    gutter: true
  };
}

/* 탐색 격자 — 도착 지점 × 훅(진입 각) × 속도 × 릴리스 위치.
   순서를 seed 로 섞어 같은 핀 수라도 매 판 다른 구질이 나오게 한다. */
export function candidateList(rand) {
  /* ±0.41 까지 — 코너핀만 살짝 걷어내는 1~2핀 투구가 여기서 나온다
     (공 중심 한계: 레인 반폭 0.528 − 공 반지름 0.109 ≈ 0.42) */
  var xas   = [-0.41,-0.38,-0.34,-0.30,-0.25,-0.20,-0.15,-0.10,-0.05,0,
                0.05,0.10,0.15,0.20,0.25,0.30,0.34,0.38,0.41];
  var hooks = [-4.2,-3.2,-2.2,-1.4,-0.6,0,0.6,1.4,2.2,3.2,4.2];
  var vzs   = [6.9, 7.5, 8.1, 8.7];
  var xrs   = [-0.28, 0, 0.28];
  var out = [], a, b, c, d;
  for (a = 0; a < xas.length; a++)
    for (b = 0; b < hooks.length; b++)
      for (c = 0; c < vzs.length; c++)
        for (d = 0; d < xrs.length; d++)
          out.push({ xa: xas[a], hook: hooks[b], vz: vzs[c], xr: xrs[d] });
  /* Fisher–Yates (결정론적) */
  for (var i = out.length - 1; i > 0; i--) {
    var j = Math.floor(rand() * (i + 1)), tmp = out[i]; out[i] = out[j]; out[j] = tmp;
  }
  return out;
}

/* 작은 흔들기 — 캐시된 후보를 그대로 반복하지 않게. 핀 수는 다시 검증한다. */
export function jitter(c, rand, amt) {
  var k = (amt == null) ? 1 : amt;
  return {
    xa:   c.xa   + (rand() - 0.5) * 0.020 * k,
    hook: c.hook + (rand() - 0.5) * 0.200 * k,
    vz:   c.vz   + (rand() - 0.5) * 0.160 * k,
    xr:   c.xr   + (rand() - 0.5) * 0.060 * k
  };
}
