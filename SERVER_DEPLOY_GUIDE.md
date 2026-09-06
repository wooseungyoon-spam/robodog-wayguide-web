# 🐕 로보독 WAY GUIDE - 개인 전용 서버(홈서버) 배포 가이드

`exam-prep-assistant`와 동일하게 **내 개인 홈서버(`wsy5518@100.109.8.92`)**에 올리고, **Cloudflare Tunnel**을 통해 안전한 HTTPS 서브도메인(`https://robodog.wooseungyoon.com`)으로 24시간 서비스하는 전체 과정입니다.

> 🌟 **서버 배포 시 특별한 장점 (HTTPS 필수 기능 활성화)**
> - 스마트폰(아이폰/갤럭시)이나 외부 노트북 브라우저에서는 **보안 HTTPS 환경에서만 카메라(얼굴인식 Face ID)와 마이크(음성인식 STT)** 권한이 허용됩니다.
> - Cloudflare Tunnel로 배포하면 **무료 SSL 보안 인증서(HTTPS)**가 자동 적용되므로, **외부 어디서든 스마트폰 카메라와 마이크로 완벽하게 작동**합니다!

---

## 🏗️ 전체 아키텍처
```text
[스마트폰 / PC 브라우저] (어디서나 접속)
       ⬇️ HTTPS (보안 암호화 통신: 카메라/마이크 완벽 지원)
[Cloudflare] (https://robodog.wooseungyoon.com)
       ⬇️ Cloudflare Tunnel (포트포워딩/공인IP 노출 X, 완벽 보안)
[내 홈서버] (localhost:5001)
       ⬇️
[systemd 서비스: robodog.service] (24시간 상시 자동 실행)
```

---

## 📋 포트 및 도메인 정보
- **서버 계정**: `wsy5518@100.109.8.92`
- **기존 사용 중인 포트**: `5000` (`exam-prep-assistant` 실행 중)
- **로보독 배포 포트**: **`5001`** (충돌 없이 독립 실행)
- **추천 서브도메인**: `robodog.wooseungyoon.com` (또는 `guide`, `dog`)

---

## Step 1. 서버에 코드 가져오기 (2가지 방법 중 택 1)

### [방법 A] 내 PC에서 서버로 직접 전송 (가장 빠르고 간편!)
Git에 올리지 않고 바로 서버로 복사하고 싶다면, **내 PC(Windows) PowerShell**에서 아래 한 줄을 실행합니다:
```powershell
# 내 PC PowerShell에서 실행
scp -r "c:\AI-study\robodog-wayguide-web" wsy5518@100.109.8.92:~/robodog-wayguide-web
```

---

### [방법 B] GitHub를 통해 가져오기 (Git Clone)
1. GitHub에 `robodog-wayguide-web` 저장소 생성 후 로컬 코드 푸시
2. 홈서버 SSH 터미널 접속 후 Clone:
```bash
ssh wsy5518@100.109.8.92
cd ~
git clone git@github.com:wooseungyoon-spam/robodog-wayguide-web.git
cd robodog-wayguide-web
```

---

## Step 2. 서버 가상환경 세팅 & 포트 5001 설정

홈서버 터미널(`wsy5518@100.109.8.92`)에서 다음 명령어를 차례대로 입력합니다:

### 2-1. 가상환경 생성 및 패키지 설치
```bash
cd ~/robodog-wayguide-web
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

### 2-2. 포트 5001 설정 (.env 생성)
```bash
nano .env
```
아래 내용을 붙여넣습니다 (5000번과 겹치지 않게 `5001`로 지정):
```env
FLASK_HOST=0.0.0.0
FLASK_PORT=5001
FLASK_DEBUG=false
HOST=0.0.0.0
PORT=5001
DEBUG=false
```
*(저장: `Ctrl + O` ➔ `Enter`, 나가기: `Ctrl + X`)*

### 2-3. 로컬 테스트 실행
```bash
python3 app.py
```
`* Running on http://0.0.0.0:5001` 메시지가 정상적으로 뜨면 **`Ctrl + C`**를 눌러 종료합니다.

---

## Step 3. 24시간 상시 자동 실행 등록 (systemd)

터미널 창을 닫거나 서버가 재부팅되어도 자동으로 켜지도록 서비스를 등록합니다.

### 3-1. 서비스 파일 생성
```bash
sudo nano /etc/systemd/system/robodog.service
```

### 3-2. 아래 내용 그대로 붙여넣기
```ini
[Unit]
Description=RoboDog WAY GUIDE Service
After=network.target

[Service]
User=wsy5518
WorkingDirectory=/home/wsy5518/robodog-wayguide-web
ExecStart=/home/wsy5518/robodog-wayguide-web/venv/bin/gunicorn -w 2 -b 0.0.0.0:5001 app:app
Restart=always
RestartSec=3
Environment=PORT=5001
Environment=FLASK_PORT=5001

[Install]
WantedBy=multi-user.target
```
*(저장: `Ctrl + O` ➔ `Enter`, 나가기: `Ctrl + X`)*

### 3-3. 서비스 등록 및 시작
```bash
sudo systemctl daemon-reload
sudo systemctl enable robodog
sudo systemctl start robodog

# 정상 작동 확인 (Active: active (running) 이면 완벽 성공!)
sudo systemctl status robodog
```
*(확인 창에서 빠져나올 때는 키보드 `q`를 누릅니다)*

---

## Step 4. Cloudflare 대시보드에서 서브도메인 추가 (30초 컷!)

> 💡 **서버에 프로그램을 추가로 설치할 필요가 전혀 없습니다!** 이미 `cloudflared`가 돌아가고 있으므로 웹 클릭 몇 번으로 끝납니다.

1. 웹 브라우저에서 [Cloudflare Zero Trust](https://dash.cloudflare.com/) 대시보드 접속
2. 좌측 메뉴: **Networks** ➔ **Tunnels** 클릭
3. 기존에 사용 중인 터널 이름 클릭 ➔ **Edit** (또는 Configure)
4. 상단 탭에서 **Public Hostname** 클릭 ➔ 파란색 **Add a public hostname** 클릭
5. 아래와 같이 입력:
   - **Subdomain**: `robodog` (또는 원하는 이름)
   - **Domain**: `wooseungyoon.com` 선택
   - **Path**: 비워둠
   - **Type**: `HTTP`
   - **URL**: `localhost:5001`
6. 우측 하단 **Save hostname** 클릭!

---

## 🎉 배포 완료! 접속 테스트
이제 스마트폰이나 PC 어디서든 브라우저 주소창에 입력하시면 접속됩니다:
👉 **`https://robodog.wooseungyoon.com`**

- 📷 **Face ID 카메라**: 스마트폰 전면 카메라가 보안 HTTPS에서 정상 승인되어 실시간 얼굴인식 가동!
- 🎤 **음성인식 STT**: 마이크 권한이 활성화되어 음성으로 목적지 바로 말하기 가능!
- 🚦 **신호등 실시간 C-ITS**: 120초 주기로 보행 신호등 카운트다운 동기화!

---

## 🛠️ 자주 쓰는 관리 명령어

```bash
# 서비스 상태 확인
sudo systemctl status robodog

# 실시간 로그 확인 (새로고침되는 터미널 로그 보기)
journalctl -u robodog -f

# 서비스 재시작 (코드 또는 .env 수정 후)
sudo systemctl restart robodog

# 서비스 일시 정지
sudo systemctl stop robodog
```
