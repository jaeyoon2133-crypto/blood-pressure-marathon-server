# 혈압 마라톤 멀티플레이 서버

이 폴더는 Render에 배포할 Node.js + WebSocket 서버와 itch.io에 업로드할 최적화된 게임 HTML을 함께 포함합니다.

## Render 배포

1. 이 폴더의 **내용 전체**를 GitHub 저장소 루트에 올립니다.
2. Render에서 **New → Blueprint**를 선택하고 해당 저장소를 연결합니다.
3. Blueprint가 `blood-pressure-marathon-server-9dc6` 서비스를 만들거나 기존 서비스를 업데이트하는지 확인합니다.
4. 배포 후 `https://blood-pressure-marathon-server-9dc6.onrender.com/health`가 JSON으로 `ok:true`를 반환하는지 확인합니다.
5. WebSocket 주소는 `wss://blood-pressure-marathon-server-9dc6.onrender.com/ws`입니다.

설정은 싱가포르 리전(`singapore`)입니다. Render는 서울 리전을 제공하지 않으므로 한국 접속자에게 가까운 싱가포르를 사용합니다. 현재 플랜은 무료이며, 무료 인스턴스는 유휴 시 절전될 수 있어 첫 연결은 늦어질 수 있습니다. 상시 가동은 유료 상시 실행 플랜이 필요합니다.

## itch.io 배포

- `itch-client/index.html`을 itch.io HTML5 프로젝트에 업로드합니다.
- 이 HTML은 위 Render 서버 주소로 연결되도록 설정되어 있습니다.
- 로비에서는 3D 장면 렌더링을 초당 24회로 제한해 브라우저 메인 스레드와 GPU 부하를 줄입니다.
- 방 생성/입장/준비/시작 요청은 중복 클릭이 쌓이지 않도록 요청 중 버튼을 잠급니다.

## 실행 및 확인

```bash
npm install
npm start
```

헬스체크: `http://localhost:3000/health`
로컬 WebSocket: `ws://localhost:3000/ws`

서버는 Node.js 20 이상과 `ws` 패키지를 사용합니다. 방/플레이어 상태는 메모리에 저장되므로 서버 재시작 시 초기화됩니다.

## 검증 범위

- 서버 JavaScript 문법 검사: 통과
- itch.io 클라이언트 JavaScript 문법 검사: 통과
- 실제 Render 배포, 실제 브라우저에서의 입력 반응, 2명 이상 동시 접속은 이 환경에서 계정/브라우저 실험을 수행하지 못했으므로 미검증입니다.
