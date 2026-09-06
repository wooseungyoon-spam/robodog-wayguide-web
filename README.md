# 🐕 RoboDog WAY GUIDE - Smart Care & Navigation Hub

노약자 보행 보조 4족 보행 로봇을 위한 **스마트 모빌리티 통합 관제 웹 애플리케이션**입니다.

---

## 🌟 주요 기능

### 1. 👵 교통약자 안심 간편 모드 (Senior Easy Mode)
- **배리어프리 고대비 UI**: Deep Black(`#121212`), Yellow(`#FFE600`), 24px~28px 초대형 폰트
- **AI 얼굴인식 (Face ID)**: 출발 전 어르신(김순자 어르신) 자동 인식 및 맞춤형 인사
- **초대형 4대 원터치 카드**: `🏥 병원`, `🏢 우리집`, `📚 복지관`, `🚨 긴급 SOS`
- **100% 음성 대화 (Web Speech API)**: 한국어 음성 인식(STT) 및 안내 발화(TTS)
- **자연어 상태 표출**: 복잡한 좌표 대신 "🐕 안전하게 모시는 중", "🚦 신호 대기 중", "⚠️ 앞에 사람이 지나가요"

### 2. 👨‍💼 보호자 실시간 통합 관제 모드 (Guardian Control Mode)
- **하드웨어 실시간 텔레메트리**: 배터리(%), 주행 속도(km/h), 조향 각도($\theta$), 남은 목적지 거리(m)
- **[글로벌 뷰] 보행자 도보 내비게이션**: 실제 테헤란로 보행로 기반 GPS 마커 실시간 추적
- **[로컬 뷰] 삼각함수 디지털 트윈 캔버스 (HTML5 Canvas 2D)**:
  - $x = 20\cos\theta, y = 20\sin\theta$ 물리 궤적 모델링
  - $5^\circ$ 회전 정적 장애물(화분/전봇대) 우회 알고리즘
  - $60^\circ$ 부채꼴 레이더 스캔 및 동적 보행자 감지 시 자동 서행
- **경찰청·도로교통공단 UTIC 규격 실시간 C-ITS 신호등**:
  - 적색 신호 감지 시 로보독 자동 정지(`CMD:SIGNAL_STOP`) 및 카운트다운
  - 녹색 신호 전환 시 자동 보행 재개(`CMD:SIGNAL_START`)
- **AI 돌봄 & 원격 튜닝**:
  - 낙상 감지(Fall-Down) 센서 충격 시 비상 E-STOP(`CMD:ESTOP`) 및 보호자 긴급 팝업
  - 스마트 QR 장소 태그 음성 안내
  - 보행 속도(10~50) 및 센서 감지 안전거리(50~150cm) 원격 조절 슬라이더
  - 일일 보행 종합 리포트 (거리, 시간, 신호대기, 회피 횟수)
- **Web Bluetooth (BLE) 무선 제어**:
  - Nordic UART Service (`6e400001-...`) 기반 다이렉트 통신
  - 하드웨어 미연결 시 자동 가상 시뮬레이터(`Mock BLE`) 안전 폴백

---

## 📁 프로젝트 파일 구조

```
C:\AI-study\robodog-wayguide-web\
├── app.py                   # Flask 백엔드, C-ITS 신호등 중계 및 도보 경로 API 프록시
├── requirements.txt         # 백엔드 의존 라이브러리 (Flask, python-dotenv, requests)
├── .env                     # 환경설정 파일 (Mock 시뮬레이터 및 포트 설정)
├── .env.example             # 환경설정 템플릿
├── templates/
│   └── index.html           # 어르신 안심 뷰 & 보호자 관제 뷰 통합 HTML5
├── static/
│   ├── style.css            # 배리어프리 고대비 테마 및 다크 사이버펑크 관제 CSS
│   └── app.js               # Web Speech, BLE 엔진, 삼각함수 캔버스, 신호등 엔진
└── README.md                # 프로젝트 사용 설명서
```

---

## 🚀 빠른 시작 가이드

### 1. 가상환경 활성화 및 실행
```powershell
cd C:\AI-study\robodog-wayguide-web

# 가상환경 활성화 (필요 시)
.\venv\Scripts\activate

# Flask 웹 서버 실행
python app.py
```

### 2. 브라우저 접속
* **로컬 웹 브라우저**: [http://localhost:5000](http://localhost:5000)
* **모바일 기기 접속**: `http://<내_컴퓨터_IP>:5000` (스마트폰 크롬/사파리 브라우저 접속 지원)
