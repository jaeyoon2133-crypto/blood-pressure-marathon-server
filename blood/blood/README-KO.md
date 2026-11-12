# 혈압 마라톤 온라인 배포 키트

이 ZIP은 **온라인 서버 프로젝트**입니다. itch.io에 올리는 게임 ZIP과 별개입니다.

## 포함된 구성
- `server/server.js`: 방/접속/실시간 게임 상태를 처리하는 Node.js + WebSocket 서버
- `render.yaml`: Render Blueprint 배포 설정 (한국 접속 지연을 줄이도록 Singapore 리전 선택)
- `package.json`: Node.js 의존성 및 실행 명령
- `public/index.html`: 서버 루트 미리보기용 최신 3인칭 클라이언트
- `itch-build/index.html`: itch.io 업로드용 최신 3인칭 클라이언트 원본
- `scripts/`: 정적 검사와 서버 스모크 테스트

## 배포 순서

### A. GitHub에 서버 코드 올리기
1. 이 ZIP을 PC에서 압축 해제합니다.
2. GitHub에서 새 저장소(Repository)를 만듭니다. 예: `blood-pressure-marathon-server`.
3. 압축을 푼 폴더 안의 **파일과 폴더 전체**를 저장소 최상위(root)에 업로드합니다.
   - 저장소 첫 화면에 `render.yaml`, `package.json`, `server/`, `public/`, `itch-build/`, `scripts/`가 바로 보여야 합니다.
   - `blood-pressure-marathon-deploy-kit/blood-pressure-marathon-deploy-kit/...`처럼 ZIP의 바깥 폴더가 한 겹 더 들어가면 안 됩니다.
4. GitHub에 업로드/커밋합니다.

### B. Render에 서버 배포하기
1. https://render.com 에 가입/로그인하고 GitHub 계정을 연결합니다.
2. Render Dashboard에서 **New → Blueprint**를 선택합니다.
3. 방금 만든 GitHub 저장소를 선택하고 연결합니다.
4. 저장소 최상위의 `render.yaml`을 읽어 서비스 설정이 잡히는지 확인하고 배포를 진행합니다.
5. 배포가 성공하면 서비스의 주소가 `https://서비스이름.onrender.com` 형태로 나옵니다.
6. 브라우저에서 `https://서비스이름.onrender.com/health`를 엽니다. JSON에 `"ok":true`가 나오면 서버가 켜진 것입니다.

`render.yaml`은 Node 웹 서비스로 배포하도록 설정되어 있습니다. 서버는 Render가 제공하는 `PORT` 환경변수와 `0.0.0.0`에 바인딩합니다. WebSocket 경로는 `/ws`입니다.

### C. 게임 클라이언트에 서버 주소 연결하기
Render 배포 주소를 받은 뒤 아래 파일의 같은 설정 줄을 찾아 실제 주소로 바꿉니다.

- `itch-build/index.html`
- `public/index.html` (Render 루트에서 게임 미리보기도 쓸 경우)

찾을 줄:
```js
const BUILT_IN_NET_SERVER_URL = '';
```
예를 들어 Render 주소가 `https://blood-pressure-marathon-server.onrender.com`이라면:
```js
const BUILT_IN_NET_SERVER_URL = 'https://blood-pressure-marathon-server.onrender.com';
```

주의:
- `https://`부터 `.com`까지 서비스 기본 주소를 넣습니다.
- 끝에 `/ws`를 붙이지 마세요. 게임이 자동으로 `wss://.../ws`로 연결합니다.
- 주소의 따옴표를 유지해야 합니다.
- 이 주소는 제작자가 게임 파일에 한 번 설정하는 값입니다. 일반 플레이어에게 서버 주소를 입력시키지 않습니다.
- 수정한 뒤 GitHub 저장소에 다시 커밋하면 Render 서버 쪽 파일도 갱신됩니다. 단, itch.io에 올린 HTML ZIP은 별도로 다시 만들어 업로드해야 합니다.

### D. itch.io 게임 ZIP 만들기/업데이트
1. `itch-build` 폴더 안의 `index.html`을 사용합니다. 위 C 단계에서 서버 주소를 설정한 파일이어야 합니다.
2. `itch-build` 폴더 **안으로 들어가서** `index.html` 하나를 선택해 ZIP으로 압축합니다. ZIP을 열었을 때 최상위에 `index.html`이 바로 보여야 합니다.
3. itch.io Dashboard에서 게임 프로젝트를 편집합니다.
4. `Kind of Game`을 **HTML**로 설정합니다.
5. HTML5 업로드 영역에 ZIP을 업로드하고 저장합니다.
6. Embed options에서 화면 크기/전체 화면을 설정합니다. 모바일 플레이를 원하면 `Mobile Friendly`를 켭니다.

공식 안내: https://itch.io/docs/creators/html5

## 플레이어가 실제로 방에 들어가는 법

1. 모든 플레이어가 같은 itch.io 게임 페이지를 엽니다.
2. 게임에서 닉네임을 입력합니다.
3. 방장은 `방 만들기`에서 방 이름을 정하고, 공개방은 비밀번호를 비워 두고, 비밀번호 방은 비밀번호를 입력한 뒤 생성합니다.
4. 대기실의 6자리 방 코드를 친구에게 보냅니다. 비밀번호 방이면 비밀번호도 따로 전달합니다.
5. 친구는 `방 목록`을 열고 방 코드와 비밀번호(해당 시)를 입력해 `코드 입장`을 누릅니다. 공개방은 방 목록에서 바로 입장해도 됩니다.
6. 실제 플레이어 2명 이상이 들어오고 전원이 `준비 완료`를 누르면 방장이 `레이스 시작`을 누릅니다.
7. 온라인 게임은 실제 플레이어만 참가합니다. 남은 자리는 AI로 채워지지 않습니다.

## 빠른 확인
- `https://서비스이름.onrender.com/health` → 서버 상태 JSON
- 게임 안에서 방 만들기 → 6자리 코드 표시
- 다른 브라우저/휴대폰에서 같은 itch.io 페이지 접속 → 코드 입장
- 두 플레이어 모두 준비 → 방장이 시작

## 현재 한계 및 주의
- 아직 계정/로그인, 영구 전적/랭킹, 재접속 복구, 고급 지연 보정, 부정행위 방지 기능은 없습니다.
- 방과 경기 상태는 서버 메모리에 저장됩니다. Render 서버가 재시작되면 진행 중인 방은 사라집니다.
- Render 무료 웹 서비스는 일정 시간 유휴 상태에서 잠들 수 있어 다음 접속 때 서버가 깨어나는 시간이 걸릴 수 있고, 무료 인스턴스는 운영용 안정성을 보장하지 않습니다. 여러 명이 상시 이용할 게임이면 유료 인스턴스 또는 별도 안정적인 호스팅을 고려하세요.
- 서버 코드는 Node.js 20 이상을 요구합니다.
