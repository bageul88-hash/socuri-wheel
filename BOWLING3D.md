# 3D 볼링 (Three.js + Rapier 3D)

`index.html` 의 볼링 게임을 실제 3D 공간의 강체 물리로 바꾼 모듈.
기존 원반/윷/관리자/Supabase 는 건드리지 않는다.

## 파일

| 파일 | 역할 |
|---|---|
| `bowling3d-physics.js` | 물리 코어. Rapier 를 **인자로 주입**받아 브라우저와 Node 양쪽에서 같은 코드가 돈다. 레인·거터·킥백·핏 지오메트리, 핀 10개 강체, 투구 시뮬, 녹화 |
| `bowling3d.js` | Three.js 렌더러, 카메라 상태머신, 포인터 입력, 재생, 정리(dispose) |
| `bowling3d-table.js` | **자동 생성.** 핀 수(1~10)별 투구 후보표 |
| `tools/bowl3d-test.mjs` | Node 에서 물리만 검증 (배치·결정론·핀 수 분포·관통·폭주) |
| `tools/bowl3d-gen-table.mjs` | 후보표 재생성 |
| `tools/bowl3d-browser.mjs` | 헤드리스 Chrome 으로 실제 화면 검증 + 스크린샷 + 회귀(원반/윷/관리자) |
| `tools/bowl3d-fps.mjs` | 실제 GPU 프레임레이트 측정 (창을 띄워 측정) |

## 결과 계약 — 왜 "물리를 먼저 돌려보고" 재생하는가

socuri-wheel 의 볼링은 **가중치 추첨이 핀 수를 먼저 정한다**
(Supabase `settings.bowling` 의 5구간). 경품이 걸려 있으므로 이 분포는
물리에 맡길 수 없다.

그래서 흐름은 이렇다.

```
bPickTier() → 목표 핀 수 n
   ↓
bowling3d-table.js 에서 n 이 나오는 후보를 꺼낸다
   ↓
Rapier 로 한 판 실제로 돌려 녹화 (프레임 예산 6ms 씩 나눠서)
   ↓
결과가 n 이면 그 녹화를 재생, 아니면 다음 후보
   ↓
끝까지 못 찾으면 "비슷한 것" 으로 때우지 않고 2D 로 떨어진다
```

- 물리는 **진짜 Rapier 3D 강체 충돌**이다. 미리 돌릴 뿐 결과를 손으로 만들지 않는다.
- 녹화 후 재생이라 프레임 드랍이나 느린 기기에서도
  **화면에 보이는 핀 상태 = 발표되는 핀 수** 가 항상 같다.
  (`tools/bowl3d-browser.mjs` 가 0~10핀 전수로 이걸 검사한다)
- 플레이어 조준으로 결과를 바꾸지 않는다. 드래그는 READY 둘러보기와
  투구 트리거로만 쓴다.

## 좌표계 / 규격

실제 볼링 규격을 미터로 쓴다. `X` 좌우(중앙 0) · `Y` 위 · `Z` 레인 진행 방향.

- 레인 폭 1.0566m, 파울라인 → 1번 핀 18.288m (60ft)
- 핀 간격 0.3048m (12in), 줄 간 0.2640m, 핀 높이 0.381m
- 공 지름 0.2172m / 6.35kg, 핀 1.55kg (무게중심 ≈ 0.145m)

핀 콜라이더는 실루엣을 5조각(밑동·배·어깨·목·머리)으로 근사하고
조각마다 질량을 직접 줘 무게중심을 실제 핀처럼 아래에 둔다.
렌더는 같은 프로파일로 만든 `LatheGeometry` 라 콜라이더와 모양이 일치한다.

## 알아둘 함정 세 가지

1. **월드는 매 판 새로 만든다.** Rapier 는 접촉 매니폴드와 warm-start 임펄스를
   스텝 사이에 유지해서, 바디만 제자리로 옮겨 재사용하면 같은 파라미터가
   다른 결과를 낸다. 월드 생성은 1ms 미만이라 매번 새로 만드는 쪽이 싸고 안전하다.
2. **핀 바디의 원점은 밑면이다.** 세워둔 핀의 `translation().y` 는 0 이므로
   높이로 넘어짐을 판정하면 안 된다. 기울기(40°) · 자리 이탈(8.5cm) · 핏 낙하로 본다.
3. **바닥을 여러 상자로 쪼개지 말 것.** 레인과 핀덱을 윗면이 맞닿는 두 cuboid 로
   나눴더니 그 이음매 모서리가 굴러오는 공을 차올렸다. 훅이 걸린 공은 9cm,
   핀 충돌까지 겹치면 **41cm** 까지 떠올랐다. 지금은 어프로치~핀덱을 한 덩어리로
   두고, 구간별 마찰 대신 핀 쪽 마찰로 핀덱 접지감을 맞춘다
   (`(laneFriction + pinFriction) / 2 ≈ 0.22`).
   회귀 검사: `tools/bowl3d-test.mjs` 의 "레인·핀덱 위에서 공이 튀지 않음".

## 카메라

`READY → FOLLOW → IMPACT` 를 공의 z 로 보간한다. 전환은 지수 감쇠라
프레임레이트와 무관하게 같은 느낌이 나온다. 매 투구 `reset()` 이
위치·타깃·fov 를 명시적으로 되돌린다.

충돌 직후 0.45초 동안 재생 속도를 0.42배로 떨어뜨렸다가 0.3초에 걸쳐 복귀한다
(물리 timestep 이 아니라 **재생 time-scale** 을 건드린다).

## 폴백 / 디버그

| URL | 동작 |
|---|---|
| (기본) | 3D. CDN 로드나 WebGL 초기화가 실패하면 조용히 기존 2D 캔버스로 |
| `?bowling2d=1` | 3D 를 끄고 기존 2D 볼링 (비교·대조용) |
| `?bowlingDebug=1` | FPS/공 좌표/속도/카메라/핀 상태/탐색 횟수 오버레이 + 검증용 훅 |

디버그 플래그가 없으면 오버레이도 `window.__bowl3dTest` 훅도 **만들어지지 않는다.**

## 검증

```bash
# 물리 (Rapier 필요)
curl -o tools/rapier.es.js \
  https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.14.0/rapier.es.js
node tools/bowl3d-test.mjs

# 실제 브라우저 + 스크린샷 (puppeteer-core + 로컬 Chrome, 헤드리스)
node tools/bowl3d-browser.mjs

# 실제 GPU 프레임레이트 (창이 잠깐 열린다 — 헤드리스는 소프트웨어 렌더라 의미 없음)
node tools/bowl3d-fps.mjs
```

`puppeteer-core` 는 프로젝트 의존성이 아니다. 검증할 때만 임시로 설치해 쓰고,
경로는 `PUPPETEER_CORE` / `CHROME_PATH` 환경변수로 바꿀 수 있다.

## 후보표를 다시 만들어야 하는 때

`bowling3d-physics.js` 의 `TUNE`(물리 계수), `DIM`(규격), `SIM`(스텝 일정),
`freezeFallen`, 콜라이더 구성 중 **하나라도 바꾸면** 표가 무효가 된다.

```bash
node tools/bowl3d-gen-table.mjs        # 약 15분 (실제 시뮬 7~8천 판)
node tools/bowl3d-test.mjs             # 분포 재확인
node tools/bowl3d-browser.mjs          # 화면 재확인
```

표가 낡으면 런타임이 후보를 여러 번 헛돌다 2D 로 떨어진다
(결과가 틀리지는 않지만 3D 가 안 나온다).
