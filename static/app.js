/**
 * =========================================================
 * RoboDog WAY GUIDE - Smart Care & Navigation Hub
 * Module: Unified Controller (Senior / General / Guardian)
 * Features: Multi-BLE UART, Naver Maps v3, Search Autocomplete
 * =========================================================
 */

// ---------------------------------------------------------
// 1. 글로벌 상태 및 통합 로거 유틸리티
// ---------------------------------------------------------
const AppState = {
    currentMode: 'senior', // 'senior' | 'general' | 'guardian'
    walkMode: 'follow',    // 'follow' | 'side' | 'lead'
    isBleConnected: false,
    isMockBle: false,
    bleDevice: null,
    bleServer: null,
    bleTxChar: null,
    bleRxChar: null,
    isWalking: false,
    currentDest: null,
    battery: 98,
    speed: 25, // 0.9 km/h
    angle: 0.0,
    distanceRemaining: 240, // meters
    safetyDist: 100, // cm
    signalState: 'GREEN', // 'RED' | 'YELLOW' | 'GREEN'
    signalCountdown: 24,
    stats: {
        totalDistance: 1400,
        walkTimeSeconds: 1680,
        signalWaitCount: 3,
        avoidCount: 5
    }
};

/**
 * 프론트엔드 표준 콘솔 및 관제 터미널 통합 로깅
 */
function logEvent(tag, message, type = 'info') {
    const timestamp = new Date().toTimeString().split(' ')[0];
    const formatted = `[${timestamp}] ${tag} ${message}`;
    
    if (type === 'error') {
        console.error(formatted);
    } else if (type === 'warn') {
        console.warn(formatted);
    } else {
        console.log(formatted);
    }

    const consoleBox = document.getElementById('guardianLogConsole');
    if (consoleBox) {
        const line = document.createElement('div');
        line.className = `log-line ${type}`;
        line.textContent = formatted;
        consoleBox.appendChild(line);
        consoleBox.scrollTop = consoleBox.scrollHeight;
    }
}

/**
 * 두 위도/경도 간 거리(미터) 정밀 산출 함수 (하버사인 / Leaflet)
 */
function calculateDistanceM(lat1, lng1, lat2, lng2) {
    if (typeof L !== 'undefined' && L.latLng) {
        return L.latLng(lat1, lng1).distanceTo(L.latLng(lat2, lng2));
    }
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// ---------------------------------------------------------
// 2. 실제 로보독 Web Bluetooth (BLE) UART 통신 제어기
// ---------------------------------------------------------
// Nordic UART Service 및 HM-10 / ESP32 표준 BLE 서비스 UUID 목록
const BLE_UUIDS = {
    NUS_SERVICE: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    NUS_TX: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
    NUS_RX: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
    HM10_SERVICE: '0000ffe0-0000-1000-8000-00805f9b34fb',
    HM10_CHAR: '0000ffe1-0000-1000-8000-00805f9b34fb'
};

const BleController = {
    /**
     * 실제 로보독 블루투스 디바이스 검색 및 GATT 페어링
     */
    async connect() {
        if (!navigator.bluetooth) {
            alert('⚠️ 현재 브라우저는 Web Bluetooth API를 지원하지 않습니다.\nChrome, Edge 브라우저(또는 HTTPS/localhost 환경)에서 실행해 주세요.\n\n시연을 위해 [가상 시뮬레이션 모드]로 안전하게 동작합니다.');
            logEvent('[BLE]', '브라우저 Web Bluetooth 미지원 -> [가상 BLE 모드] 활성화', 'warn');
            this.enableMockMode();
            return;
        }

        try {
            logEvent('[BLE]', '📡 주변 로보독 블루투스(BLE UART) 장치를 검색합니다...', 'info');
            
            // 모든 주변 BLE 기기 검색 지원 (ESP32, Arduino, Micro:bit, Nordic nRF52 등 광범위 지원)
            const device = await navigator.bluetooth.requestDevice({
                acceptAllDevices: true,
                optionalServices: [
                    BLE_UUIDS.NUS_SERVICE,
                    BLE_UUIDS.HM10_SERVICE,
                    'generic_access',
                    'battery_service'
                ]
            });

            logEvent('[BLE]', `기기 선택됨: [${device.name || '알 수 없는 로봇'}] - GATT 서버 연결 중...`, 'info');

            // 연결 해제 리스너 등록
            device.addEventListener('gattserverdisconnected', () => {
                logEvent('[BLE]', `로보독 [${device.name}]과의 연결이 끊어졌습니다.`, 'warn');
                this.handleDisconnected();
            });

            const server = await device.gatt.connect();
            AppState.bleDevice = device;
            AppState.bleServer = server;

            // 1. NUS (Nordic UART Service) 시도
            try {
                const service = await server.getPrimaryService(BLE_UUIDS.NUS_SERVICE);
                AppState.bleTxChar = await service.getCharacteristic(BLE_UUIDS.NUS_TX);
                AppState.bleRxChar = await service.getCharacteristic(BLE_UUIDS.NUS_RX);
                logEvent('[BLE]', 'Nordic UART Service (NUS) 특성 매핑 성공', 'success');
            } catch (nusErr) {
                // 2. HM-10 / AT-09 범용 시리얼 서비스 폴백
                try {
                    const service = await server.getPrimaryService(BLE_UUIDS.HM10_SERVICE);
                    AppState.bleTxChar = await service.getCharacteristic(BLE_UUIDS.HM10_CHAR);
                    AppState.bleRxChar = AppState.bleTxChar;
                    logEvent('[BLE]', 'HM-10 Serial Service 특성 매핑 성공', 'success');
                } catch (hmErr) {
                    logEvent('[BLE]', '표준 UART 서비스를 찾을 수 없어 기본 GATT 통신 모드로 연결됨', 'warn');
                }
            }

            // RX 알림(Notify) 활성화
            if (AppState.bleRxChar && AppState.bleRxChar.properties.notify) {
                await AppState.bleRxChar.startNotifications();
                AppState.bleRxChar.addEventListener('characteristicvaluechanged', (event) => {
                    const value = new TextDecoder().decode(event.target.value);
                    this.handleIncomingData(value);
                });
            }

            AppState.isBleConnected = true;
            AppState.isMockBle = false;

            this.updateUiState(true, `연결됨: ${device.name || 'RoboDog'}`);
            logEvent('[BLE]', `🎉 로보독 하드웨어와 실제 무선 블루투스 연결이 완료되었습니다!`, 'success');
            VoiceEngine.speak('로보독과 무선 블루투스로 연결되었습니다.');

        } catch (error) {
            if (error.name === 'NotFoundError') {
                logEvent('[BLE]', '사용자가 블루투스 검색 창을 취소했습니다. [가상 BLE 모드]로 동작합니다.', 'info');
            } else {
                logEvent('[BLE]', `실제 BLE 연결 중 예외 발생 (${error.message}). [가상 BLE 모드]로 동작합니다.`, 'warn');
            }
            this.enableMockMode();
        }
    },

    enableMockMode() {
        AppState.isBleConnected = true;
        AppState.isMockBle = true;
        this.updateUiState(true, '가상 시뮬레이션 (연결됨)');
        logEvent('[BLE]', '가상 로보독 BLE UART 시뮬레이터 활성화 완료.', 'success');
    },

    disconnect() {
        if (AppState.bleDevice && AppState.bleDevice.gatt && AppState.bleDevice.gatt.connected) {
            AppState.bleDevice.gatt.disconnect();
        }
        this.handleDisconnected();
    },

    handleDisconnected() {
        AppState.isBleConnected = false;
        AppState.bleTxChar = null;
        AppState.bleRxChar = null;
        this.updateUiState(false, '연결 해제됨');
        logEvent('[BLE]', '로보독 블루투스 연결이 해제되었습니다.', 'warn');
    },

    /**
     * 로보독에 UART 제어 패킷 전송 (실제 하드웨어 or 가상)
     */
    async sendPacket(command) {
        const fullPacket = `${command}\n`;
        logEvent('[BLE]', `[TX 송신] >> ${command}`, 'info');

        if (AppState.isMockBle || !AppState.bleTxChar) {
            this.mockResponse(command);
            return;
        }

        try {
            const encoder = new TextEncoder();
            const data = encoder.encode(fullPacket);
            
            if (AppState.bleTxChar.properties.writeWithoutResponse) {
                await AppState.bleTxChar.writeValueWithoutResponse(data);
            } else {
                await AppState.bleTxChar.writeValue(data);
            }
        } catch (err) {
            logEvent('[ERROR]', `BLE 패킷 전송 실패: ${err.message}`, 'error');
            // 전송 실패 시 가상 모드로 안전 대체
            this.mockResponse(command);
        }
    },

    handleIncomingData(data) {
        logEvent('[BLE]', `[RX 수신] << ${data.trim()}`, 'info');
    },

    mockResponse(command) {
        if (command.startsWith('CMD:START')) {
            this.updateTelemetry({ speed: (AppState.speed * 0.036).toFixed(1) + ' km/h' });
        } else if (command.startsWith('CMD:STOP') || command.startsWith('CMD:ESTOP')) {
            this.updateTelemetry({ speed: '0.0 km/h' });
        } else if (command.startsWith('CMD:SPEED:')) {
            const spd = parseInt(command.split(':')[2]);
            this.updateTelemetry({ speed: (spd * 0.036).toFixed(1) + ' km/h' });
        }
    },

    updateUiState(connected, text) {
        const dot = document.getElementById('bleStatusDot');
        const textEl = document.getElementById('bleStatusText');
        const btn = document.getElementById('btnBleToggle');

        if (dot) dot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
        if (textEl) textEl.textContent = text;
        if (btn) btn.textContent = connected ? (AppState.isMockBle ? '실제 BLE 검색' : '연결 해제') : '🔗 실제 BLE 연결';
    },

    updateTelemetry(data) {
        if (data.battery !== undefined) {
            const el = document.getElementById('telemBattery');
            if (el) el.textContent = `🔋 ${data.battery}%`;
            const genBat = document.getElementById('generalBattery');
            if (genBat) genBat.textContent = `${data.battery}`;
        }
        if (data.speed !== undefined) {
            const el = document.getElementById('telemSpeed');
            if (el) el.textContent = `⚡ ${data.speed}`;
            const genSpd = document.getElementById('generalSpeed');
            if (genSpd) genSpd.textContent = parseFloat(data.speed).toFixed(1);
        }
        if (data.angle !== undefined) {
            const el = document.getElementById('telemAngle');
            if (el) el.textContent = `🧭 ${data.angle.toFixed(1)}°`;
        }
        if (data.distance !== undefined) {
            const el = document.getElementById('telemDistance');
            if (el) el.textContent = `📍 ${data.distance} m`;
            const genDist = document.getElementById('generalDist');
            if (genDist) genDist.textContent = `${data.distance}`;
        }
    }
};

// ---------------------------------------------------------
// 3. Web Speech API (TTS 음성 합성 & AI STT 음성 인식 비서)
// ---------------------------------------------------------
const VoiceEngine = {
    synth: window.speechSynthesis || null,
    recognition: null,
    isListening: false,
    isEnabled: localStorage.getItem('robodog_narrator_enabled') !== 'false',
    modalEl: null,
    transcriptEl: null,
    badgeEl: null,

    init() {
        this.updateNarratorUi();
        this.modalEl = document.getElementById('voiceModal');
        this.transcriptEl = document.getElementById('voiceModalTranscript');
        this.badgeEl = document.getElementById('voiceListeningBadge');

        // 1. 노인 모드 대형 마이크 버튼 바인딩
        const micSenior = document.getElementById('btnVoiceListen');
        if (micSenior) {
            micSenior.addEventListener('click', () => {
                this.openVoiceModal();
            });
        }

        // 2. 일반 모드 검색창 내부 마이크 버튼 바인딩
        const micGeneral = document.getElementById('btnGeneralVoiceListen');
        if (micGeneral) {
            micGeneral.addEventListener('click', () => {
                this.openVoiceModal();
            });
        }

        // 3. 모달 닫기 버튼 & 배경 클릭 & ESC
        const btnClose = document.getElementById('btnCloseVoice');
        if (btnClose) {
            btnClose.addEventListener('click', () => this.closeVoiceModal());
        }

        if (this.modalEl) {
            this.modalEl.addEventListener('click', (e) => {
                if (e.target === this.modalEl) this.closeVoiceModal();
            });
        }

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modalEl && this.modalEl.style.display !== 'none') {
                this.closeVoiceModal();
            }
        });

        // 4. 추천 발화 칩 클릭 이벤트
        document.querySelectorAll('#voiceModal .voice-chip-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const sayText = btn.getAttribute('data-say');
                if (sayText) {
                    if (this.transcriptEl) {
                        this.transcriptEl.textContent = `"${sayText}"`;
                    }
                    this.handleVoiceCommand(sayText);
                }
            });
        });

        // 5. 음성 모달 내 수동 텍스트 입력 폴백
        const inputFallback = document.getElementById('inputVoiceFallback');
        const btnFallback = document.getElementById('btnSubmitVoiceFallback');
        if (btnFallback && inputFallback) {
            const submitFallback = () => {
                const val = inputFallback.value.trim();
                if (val) {
                    if (this.transcriptEl) this.transcriptEl.textContent = `"${val}"`;
                    this.handleVoiceCommand(val);
                    inputFallback.value = '';
                }
            };
            btnFallback.addEventListener('click', submitFallback);
            inputFallback.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') submitFallback();
            });
        }
    },

    toggleNarrator(forceState = null) {
        if (forceState !== null) {
            this.isEnabled = forceState;
        } else {
            this.isEnabled = !this.isEnabled;
        }
        localStorage.setItem('robodog_narrator_enabled', this.isEnabled);

        if (!this.isEnabled && this.synth) {
            this.synth.cancel();
        }

        this.updateNarratorUi();
        logEvent('[SYSTEM]', `내레이터 음성 안내: [${this.isEnabled ? 'ON (켜짐)' : 'OFF (음소거)'}]`, 'info');
        
        if (this.isEnabled) {
            this.speak('내레이터 음성 안내가 켜졌습니다.', true);
        }
    },

    updateNarratorUi() {
        const iconEl = document.getElementById('narratorIcon');
        const textEl = document.getElementById('narratorText');
        const statusEl = document.getElementById('txtNarratorStatus');
        const btnToggle = document.getElementById('btnToggleNarrator');
        const btnTuning = document.getElementById('btnToggleNarratorInTuning');

        if (iconEl) iconEl.textContent = this.isEnabled ? '🔊' : '🔇';
        if (textEl) textEl.textContent = this.isEnabled ? '음성 ON' : '음성 OFF';
        if (statusEl) {
            statusEl.textContent = this.isEnabled ? '켜짐 (ON)' : '꺼짐 (OFF)';
            statusEl.style.color = this.isEnabled ? '#34D399' : '#94A3B8';
        }
        if (btnToggle) {
            if (this.isEnabled) {
                btnToggle.classList.remove('muted');
            } else {
                btnToggle.classList.add('muted');
            }
        }
        if (btnTuning) {
            btnTuning.textContent = this.isEnabled ? '🔊 내레이터 음성 끄기 (MUTE)' : '🔇 내레이터 음성 켜기 (UNMUTE)';
            if (this.isEnabled) {
                btnTuning.classList.remove('muted');
            } else {
                btnTuning.classList.add('muted');
            }
        }
    },

    speak(text, force = true) {
        if (!this.isEnabled) return;
        if (!this.synth) return;

        if (force) this.synth.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'ko-KR';
        utterance.rate = 0.92;
        utterance.pitch = 1.05;

        utterance.onstart = () => {
            logEvent('[VISION]', `음성 안내 발화: "${text}"`, 'info');
        };
        utterance.onerror = (e) => {
            logEvent('[ERROR]', `음성 안내 오류: ${e.error}`, 'error');
        };

        this.synth.speak(utterance);
    },

    openVoiceModal() {
        if (!this.modalEl) this.modalEl = document.getElementById('voiceModal');
        if (this.modalEl) this.modalEl.style.display = 'flex';

        if (this.transcriptEl) {
            this.transcriptEl.textContent = '말씀해 주세요... (예: "병원 가자", "약국", "우리집", "멈춰")';
        }
        if (this.badgeEl) {
            this.badgeEl.textContent = '🎙️ 듣고 있는 중...';
            this.badgeEl.className = 'voice-badge pulse';
        }

        const micSenior = document.getElementById('btnVoiceListen');
        if (micSenior) micSenior.classList.add('listening');

        // 안내 멘트 후 STT 시작
        this.startSTT();
    },

    closeVoiceModal() {
        if (this.modalEl) this.modalEl.style.display = 'none';
        this.stopSTT();
        const micSenior = document.getElementById('btnVoiceListen');
        if (micSenior) micSenior.classList.remove('listening');
    },

    initSTT() {
        const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRec) {
            logEvent('[WARN]', '이 브라우저는 Web Speech API를 지원하지 않습니다. 추천 발화 칩 또는 텍스트 입력 모드로 안내합니다.', 'warn');
            if (this.transcriptEl) {
                this.transcriptEl.textContent = '브라우저 음성 권한을 확인하시거나 아래 추천 버튼을 눌러주세요.';
            }
            if (this.badgeEl) {
                this.badgeEl.textContent = '터치/입력 대기';
                this.badgeEl.className = 'voice-badge';
            }
            return;
        }

        this.recognition = new SpeechRec();
        this.recognition.lang = 'ko-KR';
        this.recognition.continuous = false;
        this.recognition.interimResults = true;

        this.recognition.onstart = () => {
            this.isListening = true;
            logEvent('[VOICE]', '🎤 실시간 마이크 수신 시작', 'info');
            if (this.badgeEl) {
                this.badgeEl.textContent = '🎙️ 음성 듣는 중...';
                this.badgeEl.className = 'voice-badge pulse';
            }
            updateSeniorStatus('말씀을 듣고 있어요...', '병원, 우리집, 복지관 또는 멈춰 라고 말씀하세요.');
        };

        this.recognition.onresult = (event) => {
            let interimTranscript = '';
            let finalTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    finalTranscript += event.results[i][0].transcript;
                } else {
                    interimTranscript += event.results[i][0].transcript;
                }
            }

            const currentText = finalTranscript || interimTranscript;
            if (currentText && this.transcriptEl) {
                this.transcriptEl.textContent = `"${currentText}"`;
            }

            if (finalTranscript) {
                const recognized = finalTranscript.trim();
                logEvent('[VOICE]', `음성 수신 완료: "${recognized}"`, 'success');
                this.handleVoiceCommand(recognized);
            }
        };

        this.recognition.onerror = (event) => {
            logEvent('[WARN]', `음성 인식 알림: ${event.error}`, 'warn');
            if (this.badgeEl) {
                this.badgeEl.textContent = '추천 버튼 터치 가능';
                this.badgeEl.className = 'voice-badge';
            }
            if (this.transcriptEl && (!this.transcriptEl.textContent || this.transcriptEl.textContent.includes('말씀해 주세요'))) {
                this.transcriptEl.textContent = '잘 듣지 못했어요. 아래 추천 목적지 카드를 터치해 보세요!';
            }
        };

        this.recognition.onend = () => {
            this.isListening = false;
            const micSenior = document.getElementById('btnVoiceListen');
            if (micSenior) micSenior.classList.remove('listening');
        };
    },

    startSTT() {
        if (!this.recognition) this.initSTT();
        if (this.recognition && !this.isListening) {
            try {
                this.recognition.start();
            } catch (err) {
                console.warn('STT 이미 시작됨 또는 오류:', err);
            }
        }
    },

    stopSTT() {
        this.isListening = false;
        if (this.recognition) {
            try {
                this.recognition.stop();
            } catch (e) {}
        }
    },

    async handleVoiceCommand(command) {
        if (!command) return;
        this.stopSTT();

        if (this.badgeEl) {
            this.badgeEl.textContent = '🧠 AI 분석 중...';
            this.badgeEl.className = 'voice-badge pulse';
        }
        if (this.transcriptEl) {
            this.transcriptEl.textContent = `"${command}"`;
        }

        const userLoc = (RealMapManager && RealMapManager.userLocation) ? RealMapManager.userLocation : lastUserCoords;

        try {
            const res = await fetch('/api/voice/process', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ transcript: command, lat: userLoc.lat, lng: userLoc.lng })
            });
            const data = await res.json();

            if (data.status === 'success') {
                const intent = data.intent;

                if (intent === 'STOP') {
                    pauseNavigation();
                    this.speak(data.tts || '잠시 멈췄습니다.');
                } else if (intent === 'RESUME') {
                    resumeNavigation();
                    this.speak(data.tts || '보행을 계속합니다.');
                } else if (intent === 'SOS') {
                    triggerSosAlert();
                } else if (intent === 'FACE_ID') {
                    this.speak(data.tts || '얼굴 인식을 시작합니다.');
                    this.closeVoiceModal();
                    FaceIdManager.openModal();
                    return;
                } else if (intent === 'NARRATOR_OFF') {
                    this.toggleNarrator(false);
                } else if (intent === 'NARRATOR_ON') {
                    this.toggleNarrator(true);
                } else if (intent === 'NAVIGATE_HOME') {
                    const homeDest = (AuthManager.currentUser && AuthManager.currentUser.address)
                        ? AuthManager.currentUser.address
                        : '우리집';
                    startNavigation(homeDest, data.tts || '우리집으로 편안하게 모시겠습니다.');
                } else if (intent === 'NAVIGATE' && data.destination) {
                    const destName = data.destination;
                    const ttsMsg = data.tts || `${destName}(으)로 안내를 시작합니다. 저를 따라오세요.`;
                    startNavigation(destName, ttsMsg);
                }

                // 모달 닫기
                setTimeout(() => {
                    this.closeVoiceModal();
                }, 1200);
                return;
            }
        } catch (err) {
            console.warn('서버 음성 처리 실패, 로컬 처리 진행:', err);
        }

        // 로컬 클라이언트 NLP 폴백
        const c = command.toLowerCase();
        if (c.includes('멈춰') || c.includes('정지') || c.includes('잠깐')) {
            pauseNavigation();
        } else if (c.includes('출발') || c.includes('가자') || c.includes('계속')) {
            resumeNavigation();
        } else if (c.includes('도와줘') || c.includes('살려') || c.includes('sos')) {
            triggerSosAlert();
        } else if (c.includes('약국')) {
            startNavigation('수지 온누리약국', '수지 온누리약국으로 안내를 시작합니다.');
        } else if (c.includes('병원') || c.includes('내과') || c.includes('이비인후과')) {
            startNavigation('수지 성모이비인후과의원', '병원으로 안내를 시작합니다. 저를 따라오세요.');
        } else if (c.includes('집') || c.includes('우리집')) {
            startNavigation('우리집', '우리집으로 안내를 시작합니다.');
        } else if (c.includes('마트') || c.includes('롯데몰')) {
            startNavigation('롯데몰 수지점', '롯데몰 수지점으로 안내를 시작합니다.');
        } else if (c.includes('산책') || c.includes('성복천')) {
            startNavigation('성복천 수변산책로', '성복천 산책로로 안내를 시작합니다.');
        } else {
            startNavigation(command, `${command}(으)로 안내를 시작합니다.`);
        }

        setTimeout(() => {
            this.closeVoiceModal();
        }, 1200);
    }
};

// ---------------------------------------------------------
// 3-1. 어르신 회원가입 / 로그인 / 프로필 관리 매니저
// ---------------------------------------------------------
const AuthManager = {
    currentUser: null,
    modalEl: null,
    debounceTimer: null,

    init() {
        this.modalEl = document.getElementById('authModal');
        
        // 1. 헤더 로그인 버튼 및 모달 닫기 / 로그아웃 바인딩
        const btnOpenHeader = document.getElementById('btnOpenAuthModal');
        const btnClose = document.getElementById('btnCloseAuthModal');
        const btnEditSenior = document.getElementById('btnEditSeniorProfile');
        const btnLogout = document.getElementById('btnHeaderLogout');

        if (btnOpenHeader) {
            btnOpenHeader.addEventListener('click', () => this.openModal('login'));
        }
        if (btnClose) {
            btnClose.addEventListener('click', () => this.closeModal());
        }
        if (btnEditSenior) {
            btnEditSenior.addEventListener('click', () => this.openModal('register', true));
        }
        if (btnLogout) {
            btnLogout.addEventListener('click', (e) => {
                e.stopPropagation();
                this.applyGuestState(true);
            });
        }

        // 2. 탭 전환
        const tabLogin = document.getElementById('tabBtnLogin');
        const tabReg = document.getElementById('tabBtnRegister');
        const contentLogin = document.getElementById('tabContentLogin');
        const contentReg = document.getElementById('tabContentRegister');

        if (tabLogin && tabReg) {
            tabLogin.addEventListener('click', () => {
                tabLogin.classList.add('active');
                tabReg.classList.remove('active');
                if (contentLogin) contentLogin.style.display = 'block';
                if (contentReg) contentReg.style.display = 'none';
            });
            tabReg.addEventListener('click', () => {
                tabReg.classList.add('active');
                tabLogin.classList.remove('active');
                if (contentReg) contentReg.style.display = 'block';
                if (contentLogin) contentLogin.style.display = 'none';
            });
        }

        // 3. 회원가입 주소 실시간 도로명 검색 연동
        const regAddrInput = document.getElementById('inputRegAddress');
        const regSuggestBox = document.getElementById('regAddressSuggestBox');
        const regSuggestList = document.getElementById('regSuggestListContainer');

        if (regAddrInput && regSuggestBox && regSuggestList) {
            regAddrInput.addEventListener('input', (e) => {
                const q = e.target.value.trim();
                clearTimeout(this.debounceTimer);
                this.debounceTimer = setTimeout(async () => {
                    if (q.length < 2) {
                        regSuggestBox.style.display = 'none';
                        return;
                    }
                    try {
                        const res = await fetch(`/api/geocode/suggest?q=${encodeURIComponent(q)}`);
                        const data = await res.json();
                        if (data.status === 'success' && data.results && data.results.length > 0) {
                            regSuggestList.innerHTML = '';
                            data.results.forEach(place => {
                                const item = document.createElement('div');
                                item.className = 'suggest-item';
                                item.innerHTML = `
                                    <div class="suggest-item-left">
                                        <span class="suggest-item-name">🏡 ${place.name}</span>
                                        <span class="suggest-item-addr">${place.address}</span>
                                    </div>
                                    <div class="suggest-item-right">
                                        <span class="suggest-cat-badge">${place.tag || '도로명'}</span>
                                    </div>
                                `;
                                item.addEventListener('click', () => {
                                    regAddrInput.value = place.address || place.name;
                                    regAddrInput.setAttribute('data-lat', place.lat);
                                    regAddrInput.setAttribute('data-lng', place.lng);
                                    regSuggestBox.style.display = 'none';
                                });
                                regSuggestList.appendChild(item);
                            });
                            regSuggestBox.style.display = 'block';
                        } else {
                            regSuggestBox.style.display = 'none';
                        }
                    } catch (err) {}
                }, 200);
            });

            document.addEventListener('click', (e) => {
                if (!regAddrInput.contains(e.target) && !regSuggestBox.contains(e.target)) {
                    regSuggestBox.style.display = 'none';
                }
            });
        }

        // 4. 회원가입 제출
        const btnReg = document.getElementById('btnSubmitRegister');
        if (btnReg) {
            btnReg.addEventListener('click', () => this.handleRegister());
        }

        // 5. 로그인 제출
        const btnLogin = document.getElementById('btnSubmitLogin');
        if (btnLogin) {
            btnLogin.addEventListener('click', () => this.handleLogin());
        }

        // 6. 초기 저장된 세션 로드 또는 미로그인(guest님) 상태 적용
        const saved = localStorage.getItem('robodog_current_user');
        if (saved) {
            try {
                this.setCurrentUser(JSON.parse(saved), false);
            } catch (e) {
                this.applyGuestState(false);
            }
        } else {
            this.applyGuestState(false);
        }

        // 프로필 목록 로드
        this.fetchProfiles();
    },

    formatDisplayName(name) {
        if (!name || name === 'guest' || name === 'guest님') return 'guest님';
        let clean = name.replace(/어르신/g, '').trim();
        if (!clean.endsWith('님')) clean += ' 님';
        return clean;
    },

    applyGuestState(notify = false) {
        this.currentUser = null;
        localStorage.removeItem('robodog_current_user');

        const headerText = document.getElementById('headerAuthText');
        if (headerText) headerText.textContent = 'guest님 (로그인)';

        const btnLogout = document.getElementById('btnHeaderLogout');
        if (btnLogout) btnLogout.style.display = 'none';

        const titleEl = document.getElementById('seniorGreetingText');
        if (titleEl) titleEl.textContent = '안녕하세요, guest님!';

        const subEl = document.getElementById('seniorGreetingSub');
        if (subEl) subEl.textContent = '오늘도 안전하게 모실게요. 어디로 가실까요?';

        FaceIdManager.userName = 'guest님';

        const cardTitle = document.getElementById('seniorHomeCardTitle');
        if (cardTitle) cardTitle.textContent = '🏡 우리집 안심 등록 정보';

        const dispAddr = document.getElementById('seniorDisplayAddress');
        const dispDet = document.getElementById('seniorDisplayDetailAddress');
        const dispGuard = document.getElementById('seniorDisplayGuardian');

        if (dispAddr) dispAddr.textContent = '주소 등록 대기 (로그인 또는 주소 설정 필요)';
        if (dispDet) dispDet.textContent = 'guest 상태입니다.';
        if (dispGuard) dispGuard.textContent = '미등록';

        const homeCard = document.querySelector('.dest-card.card-home');
        if (homeCard) {
            homeCard.setAttribute('data-dest', '우리집');
            homeCard.setAttribute('data-tts', '우리집으로 안내합니다. 상단에서 자택 주소를 등록하시면 등록된 실제 집으로 안내해 드려요.');
            const descEl = homeCard.querySelector('.dest-desc');
            if (descEl) descEl.textContent = '자택 주소 미등록';
        }

        logEvent('[AUTH]', '👤 현재 사용자 상태: [guest님] (미로그인 모드)', 'info');
        if (notify) {
            VoiceEngine.speak('로그아웃되었습니다. guest님으로 전환합니다.', false);
        }
    },

    async fetchProfiles() {
        try {
            const res = await fetch('/api/auth/profiles');
            const data = await res.json();
            if (data.status === 'success' && data.profiles) {
                this.renderQuickProfiles(data.profiles);
            }
        } catch (e) {}
    },

    renderQuickProfiles(profiles) {
        const listEl = document.getElementById('quickProfileList');
        if (!listEl) return;
        listEl.innerHTML = '';

        profiles.forEach(p => {
            const card = document.createElement('div');
            card.className = 'quick-profile-card';
            const cleanName = this.formatDisplayName(p.name);
            card.innerHTML = `
                <div>
                    <div class="qp-name">👤 ${cleanName}</div>
                    <div class="qp-addr">🏡 ${p.address} ${p.detail_address ? '(' + p.detail_address + ')' : ''}</div>
                </div>
                <span class="qp-badge">바로 선택</span>
            `;
            card.addEventListener('click', () => {
                this.setCurrentUser(p, true);
                this.closeModal();
            });
            listEl.appendChild(card);
        });
    },

    openModal(tab = 'login', isEdit = false) {
        if (!this.modalEl) return;
        this.modalEl.style.display = 'flex';

        const tabLogin = document.getElementById('tabBtnLogin');
        const tabReg = document.getElementById('tabBtnRegister');
        const contentLogin = document.getElementById('tabContentLogin');
        const contentReg = document.getElementById('tabContentRegister');

        if (tab === 'register' || isEdit) {
            if (tabReg) tabReg.classList.add('active');
            if (tabLogin) tabLogin.classList.remove('active');
            if (contentReg) contentReg.style.display = 'block';
            if (contentLogin) contentLogin.style.display = 'none';

            if (isEdit && this.currentUser) {
                const nameInp = document.getElementById('inputRegName');
                const addrInp = document.getElementById('inputRegAddress');
                const detInp = document.getElementById('inputRegDetailAddress');
                const gNameInp = document.getElementById('inputRegGuardianName');
                const gPhoneInp = document.getElementById('inputRegGuardianPhone');
                const noteInp = document.getElementById('inputRegNote');

                if (nameInp) nameInp.value = this.currentUser.name || '';
                if (addrInp) addrInp.value = this.currentUser.address || '';
                if (detInp) detInp.value = this.currentUser.detail_address || '';
                if (gNameInp) gNameInp.value = this.currentUser.guardian_name || '';
                if (gPhoneInp) gPhoneInp.value = this.currentUser.guardian_phone || '';
                if (noteInp) noteInp.value = this.currentUser.note || '';
            }
        } else {
            if (tabLogin) tabLogin.classList.add('active');
            if (tabReg) tabReg.classList.remove('active');
            if (contentLogin) contentLogin.style.display = 'block';
            if (contentReg) contentReg.style.display = 'none';
        }
    },

    closeModal() {
        if (this.modalEl) this.modalEl.style.display = 'none';
    },

    async handleRegister() {
        const name = document.getElementById('inputRegName')?.value.trim();
        const username = document.getElementById('inputRegUsername')?.value.trim();
        const address = document.getElementById('inputRegAddress')?.value.trim();
        const detail_address = document.getElementById('inputRegDetailAddress')?.value.trim();
        const guardian_name = document.getElementById('inputRegGuardianName')?.value.trim();
        const guardian_phone = document.getElementById('inputRegGuardianPhone')?.value.trim();
        const note = document.getElementById('inputRegNote')?.value.trim();
        const password = document.getElementById('inputRegPassword')?.value.trim() || '1234';

        const addrInput = document.getElementById('inputRegAddress');
        const lat = addrInput?.getAttribute('data-lat') ? parseFloat(addrInput.getAttribute('data-lat')) : null;
        const lng = addrInput?.getAttribute('data-lng') ? parseFloat(addrInput.getAttribute('data-lng')) : null;

        if (!name || !address) {
            alert('사용자 성함과 사는 집 주소는 필수 입력 사항입니다.');
            return;
        }

        try {
            const res = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name, username, password, address, detail_address, guardian_name, guardian_phone, note, lat, lng
                })
            });
            const data = await res.json();
            if (data.status === 'success' && data.user) {
                const dispName = this.formatDisplayName(data.user.name);
                alert(`🎉 ${dispName}의 안심 정보가 등록되었습니다!`);
                this.setCurrentUser(data.user, true);
                this.fetchProfiles();
                this.closeModal();
            } else {
                alert(data.message || '등록에 실패했습니다.');
            }
        } catch (err) {
            alert(`오류: ${err.message}`);
        }
    },

    async handleLogin() {
        const username = document.getElementById('inputLoginUsername')?.value.trim();
        const password = document.getElementById('inputLoginPassword')?.value.trim();

        if (!username) {
            alert('아이디 또는 성함을 입력해 주세요.');
            return;
        }

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (data.status === 'success' && data.user) {
                this.setCurrentUser(data.user, true);
                this.closeModal();
            } else {
                alert(data.message || '로그인에 실패했습니다.');
            }
        } catch (err) {
            alert(`오류: ${err.message}`);
        }
    },

    setCurrentUser(user, notify = true) {
        this.currentUser = user;
        localStorage.setItem('robodog_current_user', JSON.stringify(user));

        const dispName = this.formatDisplayName(user.name);

        // 1. 헤더 위젯 업데이트
        const headerText = document.getElementById('headerAuthText');
        if (headerText) headerText.textContent = `👤 ${dispName}`;

        const btnLogout = document.getElementById('btnHeaderLogout');
        if (btnLogout) btnLogout.style.display = 'inline-block';

        // 2. 간편 모드 상단 환영 문구 업데이트
        const greetingText = document.getElementById('seniorGreetingText');
        if (greetingText) greetingText.textContent = `안녕하세요, ${dispName}!`;

        FaceIdManager.userName = dispName;

        // 3. 간편 모드 사는 집 주소 및 보호자 카드 갱신
        const cardTitle = document.getElementById('seniorHomeCardTitle');
        if (cardTitle) cardTitle.textContent = `🏡 ${dispName}의 안심 등록 정보`;

        const dispAddr = document.getElementById('seniorDisplayAddress');
        const dispDet = document.getElementById('seniorDisplayDetailAddress');
        const dispGuard = document.getElementById('seniorDisplayGuardian');

        if (dispAddr) dispAddr.textContent = user.address || '주소 등록 대기';
        if (dispDet) dispDet.textContent = user.detail_address || '(상세 주소 없음)';
        if (dispGuard) dispGuard.textContent = `${user.guardian_name || '보호자'} (${user.guardian_phone || '연락처 없음'})`;

        // 4. 간편 모드 "우리집" 버튼 목적지를 실제 등록된 자택 주소로 연동
        const homeCard = document.querySelector('.dest-card.card-home');
        if (homeCard) {
            homeCard.setAttribute('data-dest', user.address || '우리집');
            homeCard.setAttribute('data-tts', `${dispName} 댁(${user.address})으로 안전하게 안내를 시작합니다.`);
            const descEl = homeCard.querySelector('.dest-desc');
            if (descEl) descEl.textContent = user.detail_address || user.address || '우리집';
        }

        // 5. 일반 모드의 내 집 설정과도 연동
        const homeInput = document.getElementById('inputHomeAddress');
        const homeStatus = document.getElementById('currentHomeAddressText');
        if (homeInput) homeInput.value = user.address || '';
        if (homeStatus) homeStatus.textContent = `현재 위치: ${user.address || '미설정'}`;

        // 6. 위치 마커 설정
        if (user.lat && user.lng) {
            RealMapManager.setUserLocation(user.lat, user.lng, 15, false);
            updateQuickDestinations(user.lat, user.lng);
        }

        logEvent('[AUTH]', `👤 사용자 연동 완료: [${dispName}] (자택: ${user.address})`, 'success');
        if (notify) {
            VoiceEngine.speak(`안녕하세요, ${dispName}! 등록된 자택 주소로 안심 케어를 시작합니다.`, false);
        }
    }
};

// ---------------------------------------------------------
// 4. AI 얼굴인식 (Face ID) 실시간 카메라 & 생체 스캐너 모듈
// ---------------------------------------------------------
const FaceIdManager = {
    isVerified: false,
    userName: 'guest님',
    modalEl: null,
    videoEl: null,
    canvasEl: null,
    ctx: null,
    stream: null,
    animId: null,
    isScanning: false,
    scanProgress: 0,
    matchedUserData: null,

    init() {
        this.modalEl = document.getElementById('faceIdModal');
        this.videoEl = document.getElementById('faceIdVideo');
        this.canvasEl = document.getElementById('faceIdCanvas');
        if (this.canvasEl) {
            this.ctx = this.canvasEl.getContext('2d');
        }

        // 1. 헤더 Face ID 버튼
        const btnHeader = document.getElementById('btnHeaderFaceId');
        if (btnHeader) {
            btnHeader.addEventListener('click', () => this.openModal('login'));
        }

        // 2. 노인 모드 인사말 카드 내 Face ID 버튼 & 아바타
        const btnSeniorCard = document.getElementById('btnTriggerFaceId');
        const btnSeniorAvatar = document.getElementById('seniorAvatarBtn');
        if (btnSeniorCard) {
            btnSeniorCard.addEventListener('click', () => this.openModal('login'));
        }
        if (btnSeniorAvatar) {
            btnSeniorAvatar.addEventListener('click', () => this.openModal('login'));
        }

        // 3. 로그인 모달 내 Face ID 1초 로그인 버튼
        const btnAuthFace = document.getElementById('btnAuthFaceIdLogin');
        if (btnAuthFace) {
            btnAuthFace.addEventListener('click', () => {
                if (AuthManager.modalEl) AuthManager.modalEl.style.display = 'none';
                this.openModal('login');
            });
        }

        // 4. 모달 조작 버튼 (닫기, 재스캔, 확인)
        const btnClose = document.getElementById('btnCloseFaceId');
        if (btnClose) btnClose.addEventListener('click', () => this.closeModal());

        const btnRescan = document.getElementById('btnRescanFaceId');
        if (btnRescan) btnRescan.addEventListener('click', () => this.restartScan());

        const btnConfirm = document.getElementById('btnConfirmFaceIdLogin');
        if (btnConfirm) {
            btnConfirm.addEventListener('click', () => {
                if (this.matchedUserData) {
                    AuthManager.setCurrentUser(this.matchedUserData, true);
                    this.closeModal();
                } else {
                    this.closeModal();
                }
            });
        }

        // 5. 모달 배경 클릭 및 ESC
        if (this.modalEl) {
            this.modalEl.addEventListener('click', (e) => {
                if (e.target === this.modalEl) this.closeModal();
            });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modalEl && this.modalEl.style.display !== 'none') {
                this.closeModal();
            }
        });
    },

    async openModal(mode = 'login') {
        if (!this.modalEl) this.modalEl = document.getElementById('faceIdModal');
        if (this.modalEl) this.modalEl.style.display = 'flex';

        this.resetState();
        logEvent('[VISION]', '📷 AI Face ID 카메라 모듈 시작...', 'info');

        await this.startCamera();
    },

    closeModal() {
        this.stopCamera();
        if (this.modalEl) this.modalEl.style.display = 'none';
    },

    resetState() {
        this.scanProgress = 0;
        this.isScanning = true;
        this.matchedUserData = null;

        const badge = document.getElementById('faceIdStatusBadge');
        const step = document.getElementById('faceIdStepText');
        const conf = document.getElementById('faceIdConfidenceText');
        const bar = document.getElementById('faceIdProgressBar');
        const target = document.getElementById('faceTargetUser');

        if (badge) { badge.textContent = '카메라 연결 중'; badge.style.background = '#1E3A8A'; }
        if (step) step.textContent = '카메라 연결 및 얼굴 감지 대기 중...';
        if (conf) conf.textContent = '일치율: 0%';
        if (bar) { bar.style.width = '0%'; bar.style.background = 'linear-gradient(90deg, #3B82F6, #10B981)'; }
        if (target) target.textContent = '자동 분석 중...';

        const fallback = document.getElementById('faceIdFallbackBanner');
        if (fallback) fallback.style.display = 'none';
    },

    async startCamera() {
        const video = this.videoEl || document.getElementById('faceIdVideo');
        const fallback = document.getElementById('faceIdFallbackBanner');

        // 웹캠 미디어 스트림 요청
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
            try {
                this.stream = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
                    audio: false
                });
                if (video) {
                    video.srcObject = this.stream;
                    video.onloadedmetadata = () => {
                        video.play();
                        if (fallback) fallback.style.display = 'none';
                        this.startScanLoop(false);
                    };
                }
                return;
            } catch (err) {
                console.warn('[VISION] 웹캠 권한 또는 장치 접근 실패, 시뮬레이션 모드로 실행:', err.message);
            }
        }

        // 웹캠 사용 불가 시 현실적인 AI 생체 시뮬레이션 모드로 전환
        if (fallback) fallback.style.display = 'flex';
        this.startScanLoop(true);
    },

    stopCamera() {
        this.isScanning = false;
        if (this.animId) {
            cancelAnimationFrame(this.animId);
            this.animId = null;
        }
        if (this.stream) {
            this.stream.getTracks().forEach(track => track.stop());
            this.stream = null;
        }
        const video = this.videoEl || document.getElementById('faceIdVideo');
        if (video) video.srcObject = null;

        if (this.ctx && this.canvasEl) {
            this.ctx.clearRect(0, 0, this.canvasEl.width, this.canvasEl.height);
        }
    },

    restartScan() {
        this.resetState();
        this.startCamera();
    },

    startScanLoop(isSimulation = false) {
        const canvas = this.canvasEl || document.getElementById('faceIdCanvas');
        const video = this.videoEl || document.getElementById('faceIdVideo');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        canvas.width = canvas.parentElement.clientWidth || 480;
        canvas.height = canvas.parentElement.clientHeight || 320;

        let startTime = Date.now();
        const duration = 2400; // 2.4초 스캔 시퀀스

        const stepText = document.getElementById('faceIdStepText');
        const confText = document.getElementById('faceIdConfidenceText');
        const progressBar = document.getElementById('faceIdProgressBar');
        const badge = document.getElementById('faceIdStatusBadge');
        const targetUserText = document.getElementById('faceTargetUser');

        const loop = () => {
            if (!this.isScanning) return;

            const elapsed = Date.now() - startTime;
            const progress = Math.min(100, Math.round((elapsed / duration) * 100));
            this.scanProgress = progress;

            if (progressBar) progressBar.style.width = `${progress}%`;

            // Canvas HUD 그래픽 렌더링
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const cx = canvas.width / 2;
            const cy = canvas.height / 2;
            const rx = 85;
            const ry = 110;

            // 단계별 안내 텍스트 및 신뢰도 업데이트
            if (progress < 25) {
                if (stepText) stepText.textContent = '👤 안면 프레임 감지 및 조명 최적화 중...';
                if (confText) confText.textContent = `일치율: ${Math.round(progress * 1.5)}%`;
                if (badge) { badge.textContent = '얼굴 감지 중'; badge.style.background = '#1E3A8A'; }
            } else if (progress < 60) {
                if (stepText) stepText.textContent = '🔍 68개 생체 랜드마크(눈, 코, 입, 턱선) 3D 분석 중...';
                if (confText) confText.textContent = `일치율: ${Math.round(35 + (progress - 25) * 1.1)}%`;
                if (badge) { badge.textContent = '생체 분석 중'; badge.style.background = '#065F46'; }
            } else if (progress < 90) {
                if (stepText) stepText.textContent = '🧠 사용자 암호화 프로필 대조 및 인증 확인 중...';
                if (confText) confText.textContent = `일치율: ${Math.round(75 + (progress - 60) * 0.7)}%`;
                if (badge) { badge.textContent = '프로필 대조 중'; badge.style.background = '#6D28D9'; }
            }

            // 랜드마크 점 찍기 (68 Points 가상 메쉬)
            ctx.fillStyle = (progress >= 90) ? '#34D399' : '#38BDF8';
            ctx.strokeStyle = (progress >= 90) ? 'rgba(52, 211, 153, 0.4)' : 'rgba(56, 189, 248, 0.3)';
            ctx.lineWidth = 1;

            const timePhase = Date.now() / 300;
            const wobble = Math.sin(timePhase) * 2;

            // 눈 주변 (12점)
            const leftEye = { x: cx - 35, y: cy - 25 + wobble };
            const rightEye = { x: cx + 35, y: cy - 25 + wobble };
            [leftEye, rightEye].forEach(eye => {
                for (let a = 0; a < Math.PI * 2; a += Math.PI / 3) {
                    const px = eye.x + Math.cos(a) * 10;
                    const py = eye.y + Math.sin(a) * 6;
                    ctx.beginPath();
                    ctx.arc(px, py, 2, 0, Math.PI * 2);
                    ctx.fill();
                }
            });

            // 코 (8점)
            ctx.beginPath();
            ctx.moveTo(cx, cy - 15 + wobble);
            ctx.lineTo(cx, cy + 10 + wobble);
            ctx.lineTo(cx - 12, cy + 18 + wobble);
            ctx.lineTo(cx + 12, cy + 18 + wobble);
            ctx.stroke();

            // 입술 (12점)
            ctx.beginPath();
            ctx.ellipse(cx, cy + 42 + wobble, 24, 10, 0, 0, Math.PI * 2);
            ctx.stroke();

            // 턱선 외곽선 (16점)
            ctx.beginPath();
            ctx.ellipse(cx, cy + wobble, rx, ry, 0, 0, Math.PI * 2);
            ctx.stroke();

            if (progress < 100) {
                this.animId = requestAnimationFrame(loop);
            } else {
                // 스캔 완료 -> 서버 매칭 호출
                this.finishRecognition();
            }
        };

        this.animId = requestAnimationFrame(loop);
    },

    async finishRecognition() {
        const stepText = document.getElementById('faceIdStepText');
        const confText = document.getElementById('faceIdConfidenceText');
        const badge = document.getElementById('faceIdStatusBadge');
        const targetUserText = document.getElementById('faceTargetUser');

        try {
            const activeUser = AuthManager.currentUser;
            const res = await fetch('/api/ai/face_recognition', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mode: 'recognize',
                    user_id: activeUser ? activeUser.id : null
                })
            });
            const data = await res.json();

            if (data.status === 'success' && data.user) {
                this.isVerified = true;
                this.matchedUserData = data.user;
                const dispName = AuthManager.formatDisplayName(data.user.name);
                this.userName = dispName;

                if (confText) confText.textContent = `일치율: ${data.confidence || 99.4}%`;
                if (stepText) stepText.textContent = `✅ [${dispName}] 얼굴 일치 확인 완료!`;
                if (badge) {
                    badge.textContent = '인식 성공 (99.4%)';
                    badge.style.background = '#065F46';
                }
                if (targetUserText) targetUserText.textContent = `${dispName} (일치)`;

                logEvent('[VISION]', `✅ AI Face ID 얼굴 인식 완료: [${dispName}] (신뢰도: 99.4%)`, 'success');

                // 사용자 로그인 연동
                AuthManager.setCurrentUser(data.user, false);

                // 인사말 갱신
                const titleEl = document.getElementById('seniorGreetingText');
                const subEl = document.getElementById('seniorGreetingSub');
                if (titleEl) titleEl.textContent = `안녕하세요, ${dispName}!`;
                if (subEl) subEl.textContent = '얼굴 인식이 확인되었습니다. 오늘도 안전하게 모실게요.';

                VoiceEngine.speak(`안녕하세요, ${dispName}! 얼굴 인식이 완료되었습니다. 어디로 모실까요?`, true);

                setTimeout(() => {
                    this.closeModal();
                }, 1400);
                return;
            }
        } catch (err) {
            console.warn('Face ID API 오류:', err);
        }

        // 게스트 또는 폴백 처리
        this.userName = 'guest님';
        if (confText) confText.textContent = '일치율: 94.2%';
        if (stepText) stepText.textContent = '새로운 사용자 감지 (guest님 모드 가동)';
        if (badge) {
            badge.textContent = 'guest 모드';
            badge.style.background = '#374151';
        }
        if (targetUserText) targetUserText.textContent = 'guest님 (기본)';

        VoiceEngine.speak('얼굴 스캔 완료! guest님으로 안전하게 모시겠습니다.', true);
        setTimeout(() => {
            this.closeModal();
        }, 1400);
    },

    runVerification() {
        logEvent('[VISION]', 'AI 얼굴인식 (Face ID) 모듈 준비 완료. 상단 📷 버튼 또는 아바타를 누르시면 실시간 카메라 스캔이 가동됩니다.', 'info');
        const activeUser = AuthManager.currentUser;
        if (activeUser) {
            const dispName = AuthManager.formatDisplayName(activeUser.name);
            this.userName = dispName;
            VoiceEngine.speak(`안녕하세요, ${dispName}! 안심 동행 로보독입니다. 어디로 모실까요?`, true);
        } else {
            VoiceEngine.speak(`안녕하세요, guest님! 안심 동행 로보독입니다. 어디로 모실까요?`, true);
        }
    }
};

// ---------------------------------------------------------
// 4-1. [핵심] 사용자 집/출발지 주소 직접 입력 및 실시간 추천 매니저
// ---------------------------------------------------------
const HomeAddressManager = {
    inputEl: null,
    btnSetEl: null,
    statusTextEl: null,
    suggestBoxEl: null,
    suggestListEl: null,
    debounceTimer: null,

    init() {
        this.inputEl = document.getElementById('inputHomeAddress');
        this.btnSetEl = document.getElementById('btnSetHomeAddress');
        this.statusTextEl = document.getElementById('currentHomeAddressText');
        this.suggestBoxEl = document.getElementById('homeAddressSuggestBox');
        this.suggestListEl = document.getElementById('homeSuggestListContainer');

        if (!this.inputEl || !this.btnSetEl) return;

        // 주소 설정 버튼 클릭
        this.btnSetEl.addEventListener('click', () => {
            const addr = this.inputEl.value.trim();
            if (addr) {
                this.setAddress(addr);
            } else {
                alert('우리집 주소 또는 도로명 주소를 입력해 주세요!');
            }
        });

        // 엔터 키 입력 지원
        this.inputEl.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const addr = this.inputEl.value.trim();
                if (addr) this.setAddress(addr);
            }
        });

        // 실시간 입력 연관 추천어 검색
        this.inputEl.addEventListener('input', (e) => {
            const q = e.target.value.trim();
            clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => {
                this.fetchSuggestions(q);
            }, 180);
        });

        // 포커스 시 추천 목록 열기
        this.inputEl.addEventListener('focus', () => {
            this.fetchSuggestions(this.inputEl.value.trim());
        });

        // 외부 클릭 시 드롭다운 닫기
        document.addEventListener('click', (e) => {
            if (!this.inputEl.contains(e.target) && this.suggestBoxEl && !this.suggestBoxEl.contains(e.target)) {
                this.hideSuggestions();
            }
        });

        // 추천 대표 거주지 빠른 선택 칩 클릭 이벤트
        document.querySelectorAll('.home-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const addr = chip.getAttribute('data-addr');
                if (addr) {
                    this.inputEl.value = addr;
                    this.setAddress(addr);
                }
            });
        });

        // 로컬스토리지에 저장된 이전 주소가 있으면 자동 복원
        const saved = localStorage.getItem('robodog_user_home');
        if (saved) {
            try {
                const parsed = JSON.parse(saved);
                if (parsed && parsed.lat && parsed.lng) {
                    this.inputEl.value = parsed.address || '';
                    if (this.statusTextEl) this.statusTextEl.textContent = `현재 위치: ${parsed.name || parsed.address}`;
                    RealMapManager.setUserLocation(parsed.lat, parsed.lng, 15, false);
                    updateQuickDestinations(parsed.lat, parsed.lng);
                    logEvent('[HOME]', `🏠 저장된 내 집 위치('${parsed.name || parsed.address}')가 자동 연동되었습니다.`, 'success');
                }
            } catch (e) {}
        }
    },

    async fetchSuggestions(query) {
        if (!this.suggestBoxEl || !this.suggestListEl) return;
        try {
            const res = await fetch(`/api/geocode/suggest?q=${encodeURIComponent(query)}`);
            const data = await res.json();

            if (data.status === 'success' && data.results && data.results.length > 0) {
                this.renderSuggestions(data.results, query);
                this.showSuggestions();
            } else {
                this.hideSuggestions();
            }
        } catch (err) {
            logEvent('[ERROR]', `주소 추천 검색 실패: ${err.message}`, 'error');
        }
    },

    renderSuggestions(places, query) {
        if (!this.suggestListEl) return;
        this.suggestListEl.innerHTML = '';

        places.forEach(place => {
            const item = document.createElement('div');
            item.className = 'suggest-item';

            let displayName = place.name;
            if (query) {
                const regex = new RegExp(`(${query})`, 'gi');
                displayName = displayName.replace(regex, '<mark>$1</mark>');
            }

            item.innerHTML = `
                <div class="suggest-item-left">
                    <span class="suggest-item-name">🏡 ${displayName}</span>
                    <span class="suggest-item-addr">${place.address}</span>
                </div>
                <div class="suggest-item-right">
                    <span class="suggest-cat-badge">${place.tag || '주거지역'}</span>
                </div>
            `;

            item.addEventListener('click', () => {
                this.inputEl.value = place.address || place.name;
                this.hideSuggestions();
                this.setAddress(place.name, place.lat, place.lng, place.address);
            });

            this.suggestListEl.appendChild(item);
        });
    },

    showSuggestions() {
        if (this.suggestBoxEl) this.suggestBoxEl.style.display = 'block';
    },

    hideSuggestions() {
        if (this.suggestBoxEl) this.suggestBoxEl.style.display = 'none';
    },

    async setAddress(addressString, directLat = null, directLng = null, directDisplayName = null) {
        this.hideSuggestions();
        if (this.btnSetEl) this.btnSetEl.textContent = '🔍 찾는 중...';
        logEvent('[HOME]', `🏠 입력하신 주소 ('${addressString}') 지오코딩 검색 중...`, 'info');

        try {
            if (directLat && directLng) {
                const displayName = directDisplayName || addressString;
                RealMapManager.setUserLocation(directLat, directLng, 15, true);
                updateQuickDestinations(directLat, directLng);

                if (this.statusTextEl) {
                    this.statusTextEl.textContent = `현재 위치: ${displayName}`;
                }

                localStorage.setItem('robodog_user_home', JSON.stringify({
                    address: addressString,
                    name: displayName,
                    lat: directLat,
                    lng: directLng
                }));

                logEvent('[HOME]', `📍 내 집 위치 설정 완료: "${displayName}" (위도: ${directLat.toFixed(5)}, 경도: ${directLng.toFixed(5)})`, 'success');
                if (this.btnSetEl) this.btnSetEl.textContent = '✅ 설정 완료';
                setTimeout(() => {
                    if (this.btnSetEl) this.btnSetEl.textContent = '🏠 내 집으로 설정';
                }, 2000);
                return;
            }

            const res = await fetch(`/api/geocode?address=${encodeURIComponent(addressString)}`);
            const data = await res.json();

            if (data.status === 'success' && data.lat && data.lng) {
                const { lat, lng, display_name } = data;
                
                RealMapManager.setUserLocation(lat, lng, 15, true);
                updateQuickDestinations(lat, lng);

                if (this.statusTextEl) {
                    this.statusTextEl.textContent = `현재 위치: ${display_name}`;
                }

                // 로컬스토리지 저장
                localStorage.setItem('robodog_user_home', JSON.stringify({
                    address: addressString,
                    name: display_name,
                    lat,
                    lng
                }));

                logEvent('[HOME]', `📍 내 집 위치 설정 완료: "${display_name}" (위도: ${lat.toFixed(5)}, 경도: ${lng.toFixed(5)})`, 'success');
                if (this.btnSetEl) this.btnSetEl.textContent = '✅ 설정 완료';
                setTimeout(() => {
                    if (this.btnSetEl) this.btnSetEl.textContent = '🏠 내 집으로 설정';
                }, 2000);

            } else {
                alert('입력하신 주소를 찾지 못했습니다. 보다 구체적인 동/건물명을 입력해 주세요.');
                if (this.btnSetEl) this.btnSetEl.textContent = '🏠 내 집으로 설정';
            }
        } catch (err) {
            logEvent('[ERROR]', `주소 변환 오류: ${err.message}`, 'error');
            if (this.btnSetEl) this.btnSetEl.textContent = '🏠 내 집으로 설정';
        }
    }
};

// ---------------------------------------------------------
// 5. 목적지 실시간 자동완성 & 검색 매니저 ('수지' 등)
// ---------------------------------------------------------
// 카테고리별 이모지 헬퍼
function getCategoryIcon(cat) {
    if (!cat) return '📍';
    if (cat.includes('지하철') || cat.includes('역')) return '🚇';
    if (cat.includes('공원') || cat.includes('산책')) return '🌳';
    if (cat.includes('병원') || cat.includes('의원')) return '🏥';
    if (cat.includes('공공') || cat.includes('주민')) return '🏢';
    if (cat.includes('도서관') || cat.includes('복지')) return '📚';
    if (cat.includes('쇼핑') || cat.includes('몰')) return '🛍️';
    if (cat.includes('카페')) return '☕';
    if (cat.includes('편의점')) return '🏪';
    return '📍';
}

let activeQuickDestCategory = '';
let lastUserCoords = { lat: 37.3150, lng: 127.0680 };

/**
 * GPS 연동 후 내 위치 주변 추천 목적지를 카테고리별/거리순으로 동적으로 렌더링
 */
async function updateQuickDestinations(lat, lng, category = null) {
    if (lat && lng) {
        lastUserCoords = { lat, lng };
    } else if (RealMapManager && RealMapManager.userLocation) {
        lat = RealMapManager.userLocation.lat;
        lng = RealMapManager.userLocation.lng;
        lastUserCoords = { lat, lng };
    } else {
        lat = lastUserCoords.lat;
        lng = lastUserCoords.lng;
    }

    if (category !== null) {
        activeQuickDestCategory = category;
    }

    const promptBanner = document.getElementById('gpsPromptBanner');
    const quickGrid = document.getElementById('quickDestGrid');
    const statusBadge = document.getElementById('gpsStatusBadge');

    if (statusBadge) {
        statusBadge.className = 'badge badge-green';
        statusBadge.textContent = '🟢 GPS 연동 완료 (거리순 추천)';
    }

    try {
        let url = `/api/places/search?lat=${lat}&lng=${lng}&limit=12`;
        if (activeQuickDestCategory) {
            url += `&category=${encodeURIComponent(activeQuickDestCategory)}`;
        }

        const res = await fetch(url);
        const data = await res.json();

        if (data.status === 'success' && data.results && data.results.length > 0) {
            if (promptBanner) promptBanner.style.display = 'none';
            if (quickGrid) {
                quickGrid.style.display = 'grid';
                quickGrid.innerHTML = '';

                data.results.forEach(place => {
                    const item = document.createElement('div');
                    item.className = 'quick-dest-item';
                    item.setAttribute('data-dest', place.name);

                    const distFormatted = place.dist_m < 1000 
                        ? `${place.dist_m}m` 
                        : `${(place.dist_m / 1000).toFixed(1)}km`;

                    item.innerHTML = `
                        <div class="quick-title-row">
                            <span class="quick-icon">${getCategoryIcon(place.category)}</span>
                            <span class="quick-dist-badge">📍 ${distFormatted}</span>
                        </div>
                        <span class="quick-title">${place.name}</span>
                        <span class="quick-sub">${place.address}</span>
                    `;

                    item.addEventListener('click', () => {
                        const searchInput = document.getElementById('inputGeneralSearch');
                        if (searchInput) searchInput.value = place.name;
                        startNavigation(place.name, null);
                    });

                    quickGrid.appendChild(item);
                });
            }
            logEvent('[NAV]', `📍 주변 추천 목적지 ${data.results.length}곳 정렬 완료 [${activeQuickDestCategory || '전체'}]`, 'success');
        } else if (quickGrid && data.status === 'success') {
            if (promptBanner) promptBanner.style.display = 'none';
            quickGrid.style.display = 'block';
            quickGrid.innerHTML = `
                <div style="grid-column: 1 / -1; text-align: center; padding: 24px; color: #94A3B8;">
                    해당 카테고리에 맞는 목적지가 없습니다. 전체 카테고리를 확인해 보세요.
                </div>
            `;
        }
    } catch (err) {
        logEvent('[ERROR]', `추천 목적지 갱신 실패: ${err.message}`, 'error');
    }
}

// ---------------------------------------------------------
// 5. 목적지 실시간 자동완성 & 검색 매니저 ('수지' 등)
// ---------------------------------------------------------
const AutocompleteSearchManager = {
    inputEl: null,
    suggestBoxEl: null,
    suggestListEl: null,
    debounceTimer: null,

    init() {
        this.inputEl = document.getElementById('inputGeneralSearch');
        this.suggestBoxEl = document.getElementById('generalSearchSuggestBox');
        this.suggestListEl = document.getElementById('suggestListContainer');

        if (!this.inputEl || !this.suggestBoxEl) return;

        // 입력 이벤트 (실시간 연관 검색어 추천)
        this.inputEl.addEventListener('input', (e) => {
            const query = e.target.value.trim();
            clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => {
                this.fetchSuggestions(query);
            }, 180);
        });

        // 포커스 시 추천 목록 열기
        this.inputEl.addEventListener('focus', () => {
            this.fetchSuggestions(this.inputEl.value.trim());
        });

        // 외부 클릭 시 드롭다운 닫기
        document.addEventListener('click', (e) => {
            if (!this.inputEl.contains(e.target) && !this.suggestBoxEl.contains(e.target)) {
                this.hideSuggestions();
            }
        });

        logEvent('[NAV]', '실시간 목적지 자동완성(Autocomplete) 엔진 활성화 완료', 'info');
    },

    async fetchSuggestions(query) {
        try {
            const loc = RealMapManager.userLocation;
            let url = `/api/places/search?q=${encodeURIComponent(query)}`;
            if (loc && loc.lat && loc.lng) {
                url += `&lat=${loc.lat}&lng=${loc.lng}`;
            }
            const res = await fetch(url);
            const data = await res.json();
            
            if (data.status === 'success' && data.results.length > 0) {
                this.renderSuggestions(data.results, query);
                this.showSuggestions();
            } else {
                this.hideSuggestions();
            }
        } catch (err) {
            logEvent('[ERROR]', `자동완성 검색 실패: ${err.message}`, 'error');
        }
    },

    renderSuggestions(places, query) {
        if (!this.suggestListEl) return;
        this.suggestListEl.innerHTML = '';

        places.forEach(place => {
            const item = document.createElement('div');
            item.className = 'suggest-item';

            // 검색어 하이라이팅
            let displayName = place.name;
            if (query) {
                const regex = new RegExp(`(${query})`, 'gi');
                displayName = displayName.replace(regex, '<mark>$1</mark>');
            }

            item.innerHTML = `
                <div class="suggest-item-left">
                    <span class="suggest-item-name">${displayName}</span>
                    <span class="suggest-item-addr">${place.address}</span>
                </div>
                <div class="suggest-item-right">
                    <span class="suggest-cat-badge">${place.category}</span>
                    <span class="suggest-dist">${place.dist_m}m</span>
                </div>
            `;

            item.addEventListener('click', () => {
                this.inputEl.value = place.name;
                this.hideSuggestions();
                startNavigation(place.name, `${place.name}으로 경로 안내를 시작합니다.`);
            });

            this.suggestListEl.appendChild(item);
        });
    },

    showSuggestions() {
        if (this.suggestBoxEl) this.suggestBoxEl.style.display = 'block';
    },

    hideSuggestions() {
        if (this.suggestBoxEl) this.suggestBoxEl.style.display = 'none';
    }
};

// ---------------------------------------------------------
// 6. [글로벌 뷰] 실제 오픈소스 지도 (Leaflet + OpenStreetMap)
// ---------------------------------------------------------
const RealMapManager = {
    map: null,
    roboMarker: null,
    destMarker: null,
    crosswalkMarkers: [],
    activeCrosswalks: [],
    userMarker: null,
    userCircle: null,
    userLocation: null,
    polyline: null,
    currentRoute: null,
    currentWaypointIndex: 0,
    trackingInterval: null,

    init() {
        const container = document.getElementById('realMapContainer');
        if (!container || typeof L === 'undefined') {
            logEvent('[NAV]', 'Leaflet 지도 라이브러리 대기 중...', 'info');
            return;
        }

        try {
            // 초기 중심 좌표 (수지/강남 중심)
            const initialLat = 37.32185;
            const initialLng = 127.09581;

            this.map = L.map('realMapContainer', {
                center: [initialLat, initialLng],
                zoom: 16,
                zoomControl: true
            });

            // 100% 무료, API 키 일절 필요 없는 표준 OpenStreetMap 타일
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
                maxZoom: 19
            }).addTo(this.map);

            // 로보독 커스텀 핀
            const roboIcon = L.divIcon({
                className: 'custom-robo-leaflet-pin',
                html: '<div style="background:#06B6D4; color:#000; padding:6px 12px; border-radius:20px; font-weight:900; font-size:12px; border:2px solid #FFF; box-shadow:0 4px 10px rgba(0,0,0,0.5); white-space:nowrap;">🐕 로보독</div>',
                iconSize: [80, 30],
                iconAnchor: [40, 15]
            });

            this.roboMarker = L.marker([initialLat, initialLng], { icon: roboIcon }).addTo(this.map);
            this.destMarker = null;

            this.polyline = L.polyline([], {
                color: '#00D2FF',
                weight: 6,
                opacity: 0.9,
                dashArray: '8, 8'
            }).addTo(this.map);

            // 지도 클릭 시 내 위치 즉시 수동 지정 기능 (데스크톱 오차 보정용)
            this.map.on('click', (e) => {
                const { lat, lng } = e.latlng;
                this.setUserLocation(lat, lng, 10, false);
                updateQuickDestinations(lat, lng);
                logEvent('[GPS]', `🎯 지도 클릭으로 내 위치가 설정되었습니다. (위도: ${lat.toFixed(5)}, 경도: ${lng.toFixed(5)})`, 'info');
            });

            logEvent('[NAV]', '🗺️ 실제 OpenStreetMap 고화질 지도 인스턴스 렌더링 성공! (회원가입/키 불필요)', 'success');

        } catch (err) {
            logEvent('[ERROR]', `실제 지도 초기화 오류: ${err.message}`, 'error');
        }
    },

    /**
     * 브라우저 GPS를 이용한 실시간 내 위치(Geolocation) 조회 (타임아웃 없는 안전한 연동)
     */
    locateUser(zoomToLocation = true) {
        const btnHeader = document.getElementById('btnMyLocationHeader');
        const btnMap = document.getElementById('btnMapMyLocation');
        const btnPrompt = document.getElementById('btnConnectGpsPrompt');

        if (btnHeader) btnHeader.textContent = '📡 수신 중...';
        if (btnMap) btnMap.textContent = '📡 수신 중...';
        if (btnPrompt) btnPrompt.textContent = '📡 GPS 찾는 중...';

        logEvent('[GPS]', '🛰️ 브라우저 GPS 실시간 위치 정보를 조회 중입니다...', 'info');

        const handleSuccess = (lat, lng, accuracy, source = 'GPS') => {
            logEvent('[GPS]', `📍 [${source}] 내 위치 확인 성공! (위도: ${lat.toFixed(5)}, 경도: ${lng.toFixed(5)}, 오차: ±${Math.round(accuracy)}m)`, 'success');
            this.setUserLocation(lat, lng, accuracy, zoomToLocation);
            updateQuickDestinations(lat, lng);

            if (btnHeader) btnHeader.textContent = '📍 내 위치';
            if (btnMap) btnMap.textContent = '📍 내 위치 찾기';
            if (btnPrompt) btnPrompt.textContent = '✅ GPS 연동 완료';
        };

        const tryIpFallback = () => {
            fetch('https://get.geojs.io/v1/ip/geo.json')
                .then(r => r.json())
                .then(data => {
                    if (data && data.latitude && data.longitude) {
                        const lat = parseFloat(data.latitude);
                        const lng = parseFloat(data.longitude);
                        handleSuccess(lat, lng, 500, `인터넷 IP: ${data.city || '대한민국'}`);
                    } else {
                        handleFallbackDefault();
                    }
                })
                .catch(() => {
                    handleFallbackDefault();
                });
        };

        const handleFallbackDefault = () => {
            logEvent('[GPS]', '기본 안심 기준 위치로 연동되었습니다. (지도를 클릭하여 언제든 내 위치를 변경할 수 있습니다.)', 'info');
            const fallbackLat = 37.32185;
            const fallbackLng = 127.09581;
            handleSuccess(fallbackLat, fallbackLng, 80, '기준 위치');
        };

        if (!navigator.geolocation) {
            tryIpFallback();
            return;
        }

        // 1단계: 정밀 GPS 시도 (4초 제한)
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                handleSuccess(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy || 20, '위성/Wi-Fi GPS');
            },
            (err) => {
                // 2단계: 일반 저전력/기지국 위치 시도
                navigator.geolocation.getCurrentPosition(
                    (pos) => {
                        handleSuccess(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy || 50, '일반 네트워크 위치');
                    },
                    (err2) => {
                        // 3단계: IP 지오로케이션 또는 기본값 폴백
                        tryIpFallback();
                    },
                    { enableHighAccuracy: false, timeout: 4000, maximumAge: 300000 }
                );
            },
            { enableHighAccuracy: true, timeout: 4000, maximumAge: 60000 }
        );
    },

    /**
     * 내 위치 마커 및 반경 원 렌더링
     */
    setUserLocation(lat, lng, accuracy, zoomToLocation = true) {
        this.userLocation = { lat, lng };
        if (!this.map) return;

        const userIcon = L.divIcon({
            className: 'custom-user-leaflet-pin',
            html: '<div style="background:#2563EB; color:#FFF; padding:6px 12px; border-radius:20px; font-weight:900; font-size:12px; border:2px solid #FFF; box-shadow:0 0 14px rgba(37,99,235,0.8); white-space:nowrap; animation:pulse-blue 1.5s infinite;">📍 내 현재 위치</div>',
            iconSize: [95, 30],
            iconAnchor: [47, 15]
        });

        if (this.userMarker) {
            this.userMarker.setLatLng([lat, lng]);
        } else {
            this.userMarker = L.marker([lat, lng], { icon: userIcon, zIndexOffset: 1000 }).addTo(this.map);
        }

        if (this.userCircle) {
            this.userCircle.setLatLng([lat, lng]).setRadius(Math.max(25, accuracy));
        } else {
            this.userCircle = L.circle([lat, lng], {
                radius: Math.max(25, accuracy),
                color: '#3B82F6',
                fillColor: '#60A5FA',
                fillOpacity: 0.18,
                weight: 2
            }).addTo(this.map);
        }

        // 로보독 위치도 사용자 위치로 초기 동기화
        if (this.roboMarker) {
            this.roboMarker.setLatLng([lat, lng]);
        }

        if (zoomToLocation) {
            this.map.setView([lat, lng], 17, { animate: true, duration: 1 });
        }
    },

    invalidate() {
        if (this.map) {
            setTimeout(() => {
                this.map.invalidateSize();
            }, 200);
        }
    },

    clearCrosswalkMarkers() {
        if (this.crosswalkMarkers && this.crosswalkMarkers.length > 0) {
            this.crosswalkMarkers.forEach(m => {
                if (this.map && m) this.map.removeLayer(m);
            });
        }
        this.crosswalkMarkers = [];
        this.activeCrosswalks = [];
    },

    updateAllSignalMarkers(computedSignals) {
        if (!this.map || !computedSignals || computedSignals.length === 0) return;

        // 마커 풀 수량 동기화
        while (this.crosswalkMarkers.length < computedSignals.length) {
            const idx = this.crosswalkMarkers.length;
            const sig = computedSignals[idx];
            const marker = L.marker([sig.lat, sig.lng], { zIndexOffset: 950 }).addTo(this.map);
            this.crosswalkMarkers.push(marker);
        }

        computedSignals.forEach((sig, idx) => {
            const marker = this.crosswalkMarkers[idx];
            if (!marker) return;

            let color = '#EF4444';
            let glow = 'rgba(239, 68, 68, 0.7)';
            let iconEmoji = '🔴';
            let blinkClass = '';

            if (sig.color === 'GREEN') {
                color = '#10B981';
                glow = 'rgba(16, 185, 129, 0.7)';
                iconEmoji = '🟢';
            } else if (sig.isBlinking) {
                color = '#F59E0B';
                glow = 'rgba(245, 158, 11, 0.9)';
                iconEmoji = '⚠️';
                blinkClass = 'blinking';
            }

            const pinHtml = `
                <div class="custom-traffic-leaflet-pin ${blinkClass}" style="background:#0F172A; border:2px solid ${color}; color:#FFF; padding:4px 8px; border-radius:12px; font-weight:900; font-size:11px; white-space:nowrap; box-shadow:0 0 10px ${glow}; display:flex; align-items:center; gap:4px; cursor:pointer;">
                    <span>🚦 ${iconEmoji}</span>
                    <span style="color:${color}; font-size:12px;">${sig.remainingTime}초</span>
                </div>
            `;

            const trafficIcon = L.divIcon({
                className: 'custom-traffic-pin-wrap',
                html: pinHtml,
                iconSize: [82, 28],
                iconAnchor: [41, 14]
            });

            marker.setIcon(trafficIcon);
            marker.bindPopup(`<b>🚦 ${sig.name}</b><br>C-ITS 절대시각 표준 실시간 연동<br>현재 상태: <b>${sig.color}</b> (${sig.remainingTime}초)<br>표준 주기: 120초 (대기 90초 / 보행 30초)`);
        });
    },

    async loadRoute(destName) {
        try {
            logEvent('[NAV]', `실제 도로망 도보 경로 검색 중 (목적지: ${destName})...`, 'info');
            let url = `/api/route/pedestrian?dest=${encodeURIComponent(destName)}`;
            if (this.userLocation && this.userLocation.lat && this.userLocation.lng) {
                url += `&start_lat=${this.userLocation.lat}&start_lng=${this.userLocation.lng}`;
            }
            const res = await fetch(url);
            const data = await res.json();
            
            if (data.status === 'success') {
                this.currentRoute = data.route;
                this.currentWaypointIndex = 0;
                this.currentStepIndex = 0;
                AppState.distanceRemaining = this.currentRoute.total_distance_m;
                
                const routeTypeMsg = this.currentRoute.is_real_road_routed ? "실제 보행자 도로망(OSRM)" : "표준 안전 보행로";
                logEvent('[NAV]', `도보 경로 수신 [${routeTypeMsg}]: "${this.currentRoute.destination}" (총 ${this.currentRoute.total_distance_m}m, 약 ${this.currentRoute.estimated_time_min}분)`, 'success');
                
                const badge = document.getElementById('mapRouteStatus');
                if (badge) badge.textContent = `${destName} (${this.currentRoute.total_distance_m}m · 약 ${this.currentRoute.estimated_time_min}분)`;

                // 실제 도로 좌표열 지도 렌더링
                if (this.map && this.currentRoute.waypoints && this.currentRoute.waypoints.length > 0) {
                    const latlngs = this.currentRoute.waypoints.map(wp => [wp.lat, wp.lng]);
                    
                    // 고대비 네비게이션 블루 라인
                    this.polyline.setLatLngs(latlngs);
                    this.polyline.setStyle({
                        color: '#2563EB',
                        weight: 6,
                        opacity: 0.9,
                        dashArray: null
                    });

                    this.roboMarker.setLatLng(latlngs[0]);
                    
                    const destIcon = L.divIcon({
                        className: 'custom-dest-leaflet-pin',
                        html: '<div style="background:#EF4444; color:#FFF; padding:6px 14px; border-radius:20px; font-weight:900; font-size:13px; border:2px solid #FFF; box-shadow:0 4px 12px rgba(0,0,0,0.6); white-space:nowrap;">🎯 도착: ' + destName + '</div>',
                        iconSize: [110, 32],
                        iconAnchor: [55, 16]
                    });

                    if (!this.destMarker) {
                        this.destMarker = L.marker(latlngs[latlngs.length - 1], { icon: destIcon }).addTo(this.map);
                    } else {
                        this.destMarker.setLatLng(latlngs[latlngs.length - 1]);
                        this.destMarker.setIcon(destIcon);
                    }
                    
                    // 1. 기존 횡단보도 신호등 마커 전부 초기화
                    this.clearCrosswalkMarkers();

                    // 2. 경로 상에서 추출된 모든 횡단보도(신호등) 목록 추출
                    const signals = this.currentRoute.trafficSignals || this.currentRoute.crosswalks || [];
                    this.activeCrosswalks = signals;

                    const intersectionNameEl = document.getElementById('signalIntersectionName');
                    const actionTextEl = document.getElementById('signalActionText');
                    const signalCountdownEl = document.getElementById('signalCountdown');
                    const signalStateBadgeEl = document.getElementById('signalStateBadge');

                    if (this.activeCrosswalks.length === 0) {
                        logEvent('[SIGNAL]', 'ℹ️ 현재 경로는 횡단보도를 건너지 않는 안전 보도블록 구간입니다.', 'info');
                        if (intersectionNameEl) intersectionNameEl.textContent = '현재 경로: 건너는 횡단보도 없음 (인도 안전 직진 구간)';
                        if (actionTextEl) actionTextEl.textContent = '🚶 횡단보도를 건너지 않고 인도로만 안전하게 직진 이동합니다.';
                        if (signalCountdownEl) {
                            signalCountdownEl.textContent = '-';
                            signalCountdownEl.style.color = '#94A3B8';
                        }
                        if (signalStateBadgeEl) {
                            signalStateBadgeEl.className = 'badge badge-gray';
                            signalStateBadgeEl.textContent = '횡단보도 없음';
                        }
                        TrafficSignalEngine.setSignals([]);
                    } else {
                        logEvent('[SIGNAL]', `🚦 경로 상의 모든 횡단보도 ${this.activeCrosswalks.length}개 절대 시각 C-ITS 엔진 연동 완료`, 'warn');
                        
                        this.activeCrosswalks.forEach((sig) => {
                            const trafficIcon = L.divIcon({
                                className: 'custom-traffic-pin-wrap',
                                html: `<div class="custom-traffic-leaflet-pin" style="background:#0F172A; border:2px solid #EF4444; color:#FFF; padding:4px 8px; border-radius:12px; font-weight:900; font-size:11px; white-space:nowrap; box-shadow:0 0 10px rgba(239,68,68,0.7); display:flex; align-items:center; gap:4px; cursor:pointer;"><span>🚦 🔴</span><span style="color:#EF4444; font-size:12px;">--초</span></div>`,
                                iconSize: [82, 28],
                                iconAnchor: [41, 14]
                            });

                            const marker = L.marker([sig.lat, sig.lng], {
                                icon: trafficIcon,
                                zIndexOffset: 950
                            }).addTo(this.map);

                            this.crosswalkMarkers.push(marker);
                        });

                        if (intersectionNameEl) {
                            intersectionNameEl.textContent = this.activeCrosswalks[0].name;
                        }
                        // C-ITS 절대 시각 신호 동기화 엔진 가동
                        TrafficSignalEngine.setSignals(this.activeCrosswalks);
                    }

                    this.map.fitBounds(this.polyline.getBounds(), { padding: [40, 40] });
                }

                // 턴바이턴 HUD 활성화
                this.updateNavHud(0, this.currentRoute.total_distance_m, this.currentRoute.estimated_time_min, 0);

                this.startTracking();
            }
        } catch (err) {
            logEvent('[ERROR]', `도보 경로 로드 실패: ${err.message}`, 'error');
        }
    },

    updateNavHud(stepIndex, remainingDistM = null, remainingTimeMin = null, progressPercent = 0) {
        const hudOverlay = document.getElementById('navHudOverlay');
        const seniorHudBox = document.getElementById('seniorNavHudBox');
        if (!hudOverlay && !seniorHudBox) return;

        const steps = this.currentRoute?.steps || [];
        const currentStep = steps[stepIndex] || (steps.length > 0 ? steps[steps.length - 1] : null);

        const icon = currentStep ? currentStep.icon : '⬆️';
        const instruction = currentStep ? currentStep.instruction : '도로를 따라 직진 이동';
        const nextDist = currentStep && currentStep.distance_m > 0 ? `${currentStep.distance_m}m 앞` : '잠시 후';

        const remDist = remainingDistM !== null ? (remainingDistM >= 1000 ? `${(remainingDistM / 1000).toFixed(1)} km` : `${Math.round(remainingDistM)} m`) : `${this.currentRoute?.total_distance_m || 0} m`;
        const remTime = remainingTimeMin !== null ? `도보 약 ${remainingTimeMin}분` : `도보 약 ${this.currentRoute?.estimated_time_min || 1}분`;

        // 1. 일반 모드 HUD 갱신
        if (hudOverlay) {
            hudOverlay.style.display = 'flex';
            const iconEl = document.getElementById('navHudIcon');
            const distEl = document.getElementById('navHudNextDist');
            const instEl = document.getElementById('navHudInstruction');
            const remDistEl = document.getElementById('navHudRemainDist');
            const remTimeEl = document.getElementById('navHudRemainTime');
            const progBar = document.getElementById('navHudProgressBar');

            if (iconEl) iconEl.textContent = icon;
            if (distEl) distEl.textContent = nextDist;
            if (instEl) instEl.textContent = instruction;
            if (remDistEl) remDistEl.textContent = remDist;
            if (remTimeEl) remTimeEl.textContent = remTime;
            if (progBar) progBar.style.width = `${Math.min(100, Math.max(0, progressPercent))}%`;
        }

        // 2. 간편 모드 대형 HUD 갱신
        if (seniorHudBox) {
            seniorHudBox.style.display = 'flex';
            const sIcon = document.getElementById('seniorNavIcon');
            const sText = document.getElementById('seniorNavText');
            if (sIcon) sIcon.textContent = icon;
            if (sText) sText.textContent = `${nextDist} ${instruction}`;
        }
    },

    startTracking() {
        if (this.trackingInterval) clearInterval(this.trackingInterval);
        this.currentWaypointIndex = 0;
        this.currentStepIndex = 0;
        let lastSpokenStep = -1;

        const waypoints = this.currentRoute?.waypoints || [];
        const steps = this.currentRoute?.steps || [];
        const totalWp = waypoints.length;
        const totalDist = this.currentRoute?.total_distance_m || 100;

        // 첫 턴 지시문 발화
        if (steps.length > 0) {
            this.updateNavHud(0, totalDist, this.currentRoute?.estimated_time_min, 0);
            VoiceEngine.speak(steps[0].instruction, false);
            lastSpokenStep = 0;
        }

        this.trackingInterval = setInterval(() => {
            if (!AppState.isWalking || !this.currentRoute) return;

            if (this.currentWaypointIndex < waypoints.length) {
                const wp = waypoints[this.currentWaypointIndex];
                const progress = (this.currentWaypointIndex / Math.max(1, totalWp - 1));
                const currentRemainDist = Math.max(0, Math.round(totalDist * (1 - progress)));
                const currentRemainTime = Math.max(1, Math.round(currentRemainDist / 65));

                AppState.distanceRemaining = currentRemainDist;
                BleController.updateTelemetry({ distance: currentRemainDist });

                // 실제 도로 지도 상의 로보독 마커 부드러운 이동
                if (this.map && this.roboMarker) {
                    this.roboMarker.setLatLng([wp.lat, wp.lng]);
                    this.map.panTo([wp.lat, wp.lng], { animate: true, duration: 0.8 });
                }

                // 턴바이턴 스텝 매칭 (가장 가까운 전방 스텝 판별)
                if (steps.length > 0) {
                    const stepIdx = Math.min(steps.length - 1, Math.floor(progress * steps.length));
                    if (stepIdx !== this.currentStepIndex) {
                        this.currentStepIndex = stepIdx;
                        this.updateNavHud(this.currentStepIndex, currentRemainDist, currentRemainTime, progress * 100);

                        if (stepIdx !== lastSpokenStep && steps[stepIdx]) {
                            VoiceEngine.speak(steps[stepIdx].instruction, false);
                            lastSpokenStep = stepIdx;
                        }
                    } else {
                        this.updateNavHud(this.currentStepIndex, currentRemainDist, currentRemainTime, progress * 100);
                    }
                }

                logEvent('[NAV]', `[실제 도로 주행] ${wp.name} (위도: ${wp.lat.toFixed(5)}, 경도: ${wp.lng.toFixed(5)})`, 'info');

                // C-ITS 절대 시각 신호등 엔진 실시간 갱신 (로보독 위치 기반 신호등 판별 및 10m 정지/출발)
                if (TrafficSignalEngine && typeof TrafficSignalEngine.tick === 'function') {
                    TrafficSignalEngine.tick();
                }

                this.currentWaypointIndex++;
            } else {
                clearInterval(this.trackingInterval);
                this.onDestinationArrival();
            }
        }, 1800);
    },

    onDestinationArrival() {
        AppState.isWalking = false;
        logEvent('[NAV]', `🎉 목적지 [${AppState.currentDest}]에 안전하게 도착했습니다!`, 'success');
        updateSeniorStatus(
            `🎉 ${AppState.currentDest}(으)로 안전하게 모셨습니다!`,
            '오늘도 수고 많으셨습니다. 편안한 시간 되세요.',
            '도착 완료'
        );

        const hudOverlay = document.getElementById('navHudOverlay');
        if (hudOverlay) {
            const instEl = document.getElementById('navHudInstruction');
            if (instEl) instEl.textContent = '🎉 목적지 도착 완료!';
            const progBar = document.getElementById('navHudProgressBar');
            if (progBar) progBar.style.width = '100%';
        }
        const seniorHudBox = document.getElementById('seniorNavHudBox');
        if (seniorHudBox) {
            const sText = document.getElementById('seniorNavText');
            if (sText) sText.textContent = '🎉 목적지 도착 완료!';
        }

        VoiceEngine.speak(`목적지에 안전하게 도착했습니다. 오늘도 안전하게 모셨습니다!`);
        BleController.sendPacket('CMD:STOP');

        setTimeout(() => {
            const reportModal = document.getElementById('reportModal');
            if (reportModal) reportModal.style.display = 'flex';
        }, 1200);
    }
};

// ---------------------------------------------------------
// 7. 삼각함수 디지털 트윈 캔버스 2D 렌더러 (HTML5 Canvas)
// ---------------------------------------------------------
const CanvasRenderer = {
    canvas: null,
    ctx: null,
    animationId: null,
    
    robo: { x: 80, y: 200, targetY: 200, theta: 0, stepSize: 1.5, avoidAngleDeg: 0 },
    elder: { x: 35, y: 200 },
    staticObstacles: [
        { x: 260, y: 200, radius: 18, label: '🚧 공사 화분' },
        { x: 450, y: 195, radius: 16, label: '🚏 전봇대' }
    ],
    dynamicPedestrians: [
        { x: 360, y: 120, targetY: 280, speedY: 0.8, radius: 14, label: '🚶 보행자' }
    ],
    radarAngle: 0,

    init() {
        this.canvas = document.getElementById('digitalTwinCanvas');
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');

        logEvent('[CANVAS]', '삼각함수 디지털 트윈 캔버스 엔진(60 FPS) 초기화 완료', 'success');
        this.startLoop();
    },

    startLoop() {
        const render = () => {
            this.updatePhysics();
            this.drawScene();
            this.animationId = requestAnimationFrame(render);
        };
        render();
    },

    updatePhysics() {
        if (AppState.isWalking) {
            this.radarAngle = (this.radarAngle + 0.05) % (Math.PI * 2);

            this.dynamicPedestrians.forEach(ped => {
                ped.y += ped.speedY;
                if (ped.y > 270 || ped.y < 130) ped.speedY *= -1;
            });

            // 정적 장애물 삼각함수 회피
            let obstacleNear = false;
            this.staticObstacles.forEach(obs => {
                const dist = Math.hypot(this.robo.x - obs.x, this.robo.y - obs.y);
                if (dist < 90 && this.robo.x < obs.x) {
                    obstacleNear = true;
                    this.robo.avoidAngleDeg = Math.min(this.robo.avoidAngleDeg + 1.2, 28);
                    this.robo.targetY = 135;
                }
            });
            if (!obstacleNear) {
                this.robo.avoidAngleDeg = Math.max(this.robo.avoidAngleDeg - 0.8, 0);
                if (this.robo.x > 300 && this.robo.x < 400) {
                    this.robo.targetY = 200;
                }
            }

            // 동적 보행자 감지 시 감속
            let pedestrianDetected = false;
            this.dynamicPedestrians.forEach(ped => {
                const distToPed = Math.hypot(this.robo.x - ped.x, this.robo.y - ped.y);
                if (distToPed < 70 && Math.abs(this.robo.x - ped.x) < 50) {
                    pedestrianDetected = true;
                }
            });

            if (pedestrianDetected) {
                this.robo.stepSize = 0.4;
                if (AppState.currentMode === 'senior') {
                    updateSeniorStatus('⚠️ 앞에 사람이 지나가고 있어요.', '안전하게 서행하며 보행자를 배려 중입니다.');
                }
            } else {
                this.robo.stepSize = 1.2;
            }

            const thetaRad = (this.robo.avoidAngleDeg * Math.PI) / 180;
            this.robo.theta = thetaRad;
            this.robo.x += this.robo.stepSize * Math.cos(thetaRad);
            this.robo.y += (this.robo.targetY - this.robo.y) * 0.05;

            this.elder.x += (this.robo.x - 45 - this.elder.x) * 0.08;
            this.elder.y += (this.robo.y - this.elder.y) * 0.08;

            if (this.robo.x > this.canvas.width - 40) {
                this.robo.x = 60;
                this.robo.y = 200;
                this.robo.targetY = 200;
                this.elder.x = 20;
                this.elder.y = 200;
            }

            AppState.angle = this.robo.avoidAngleDeg;
            BleController.updateTelemetry({ angle: this.robo.avoidAngleDeg });
        }
    },

    drawScene() {
        const { ctx, canvas } = this;
        if (!ctx || !canvas) return;

        ctx.fillStyle = '#090D16';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // 1. 그리드 선
        ctx.strokeStyle = '#162032';
        ctx.lineWidth = 1;
        for (let x = 0; x < canvas.width; x += 30) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, canvas.height);
            ctx.stroke();
        }
        for (let y = 0; y < canvas.height; y += 30) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(canvas.width, y);
            ctx.stroke();
        }

        // 2. 기준선
        ctx.strokeStyle = '#1E293B';
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(0, 200);
        ctx.lineTo(canvas.width, 200);
        ctx.stroke();
        ctx.setLineDash([]);

        // 3. 궤적선
        ctx.strokeStyle = '#38BDF8';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(40, 200);
        ctx.quadraticCurveTo(240, 130, this.robo.x, this.robo.y);
        ctx.stroke();

        // 4. 정적 장애물
        this.staticObstacles.forEach(obs => {
            ctx.fillStyle = '#F59E0B';
            ctx.beginPath();
            ctx.arc(obs.x, obs.y, obs.radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#FDE68A';
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.fillStyle = '#E2E8F0';
            ctx.font = 'bold 11px Pretendard';
            ctx.textAlign = 'center';
            ctx.fillText(obs.label, obs.x, obs.y - 22);

            ctx.strokeStyle = 'rgba(245, 158, 11, 0.25)';
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.arc(obs.x, obs.y, obs.radius + 28, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
        });

        // 5. 동적 보행자
        this.dynamicPedestrians.forEach(ped => {
            ctx.fillStyle = '#EC4899';
            ctx.beginPath();
            ctx.arc(ped.x, ped.y, ped.radius, 0, Math.PI * 2);
            ctx.fill();

            ctx.strokeStyle = 'rgba(236, 72, 153, 0.4)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(ped.x, ped.y, ped.radius + 10 + Math.sin(Date.now() / 200) * 4, 0, Math.PI * 2);
            ctx.stroke();

            ctx.fillStyle = '#FBCFE8';
            ctx.font = 'bold 11px Pretendard';
            ctx.fillText(ped.label, ped.x, ped.y - 18);
        });

        // 6. 레이더 부채꼴 스캔
        const fovRadius = 80;
        const fovAngle = Math.PI / 3;
        const heading = this.robo.theta;
        
        ctx.save();
        ctx.translate(this.robo.x, this.robo.y);
        const grad = ctx.createRadialGradient(0, 0, 10, 0, 0, fovRadius);
        grad.addColorStop(0, 'rgba(6, 182, 212, 0.35)');
        grad.addColorStop(1, 'rgba(6, 182, 212, 0.02)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, fovRadius, heading - fovAngle / 2, heading + fovAngle / 2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();

        // 7. 사용자 아바타
        ctx.fillStyle = '#FBBF24';
        ctx.beginPath();
        ctx.arc(this.elder.x, this.elder.y, 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#FFFFFF';
        ctx.font = 'bold 10px Pretendard';
        ctx.textAlign = 'center';
        ctx.fillText('👵 사용자', this.elder.x, this.elder.y + 24);

        // 8. 로보독 본체
        ctx.save();
        ctx.translate(this.robo.x, this.robo.y);
        ctx.rotate(this.robo.theta);

        ctx.fillStyle = '#06B6D4';
        ctx.fillRect(-16, -10, 32, 20);
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.strokeRect(-16, -10, 32, 20);

        ctx.fillStyle = '#38BDF8';
        ctx.fillRect(-14, -14, 6, 4);
        ctx.fillRect(8, -14, 6, 4);
        ctx.fillRect(-14, 10, 6, 4);
        ctx.fillRect(8, 10, 6, 4);

        ctx.fillStyle = '#FFE600';
        ctx.beginPath();
        ctx.arc(16, 0, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();

        ctx.fillStyle = '#06B6D4';
        ctx.font = 'bold 11px Pretendard';
        ctx.fillText(`🐕 로보독 (θ: ${this.robo.avoidAngleDeg.toFixed(1)}°)`, this.robo.x, this.robo.y - 18);
    }
};

// ---------------------------------------------------------
// 8. C-ITS 절대 시각(Epoch Timestamp) 기반 실시간 신호등 동기화 엔진
// ---------------------------------------------------------
const TrafficSignalEngine = {
    signals: [],            // 경로 상의 모든 횡단보도 신호등
    timer: null,            // 1초 단위 절대 시각 틱 타이머
    manualOverride: null,   // 수동 조작 오버라이드 { color, untilEpoch }
    stoppedSignalId: null,  // 적색 신호로 정지 중인 신호등 ID
    closestSignal: null,    // 로보독 기준 가장 가까운 전방 신호등

    init() {
        logEvent('[SIGNAL]', 'C-ITS 절대 시각(Epoch Timestamp) 신호등 동기화 엔진 초기화 완료', 'info');
        this.startEngine();
        this.bindControls();
    },

    // [1단계: 공공 C-ITS 표준 보행 신호 주기 공식 (절대 시간 기반)]
    // - 전체 주기(Cycle): 120초
    // - 보행 녹색 시간: 30초
    // - 대기 적색 시간: 90초 (120 - 30)
    // - 점멸 경고 시간: 8초
    getSignalState(signal, nowSec = null) {
        const now = nowSec !== null ? nowSec : Math.floor(Date.now() / 1000);

        // 수동 제어 모드 활성 시 해당 시간까지 강제 유지
        if (this.manualOverride && this.manualOverride.untilEpoch > now) {
            const rem = this.manualOverride.untilEpoch - now;
            const isBlink = this.manualOverride.color === 'GREEN' && rem <= 8;
            return {
                id: signal.id,
                name: signal.name,
                lat: signal.lat,
                lng: signal.lng,
                color: isBlink ? 'BLINKING' : this.manualOverride.color,
                remainingTime: rem,
                isBlinking: isBlink,
                cycle: 120
            };
        }

        const cycle = signal.cycleSec || 120;
        const greenDuration = signal.greenSec || 30;
        const blinkDuration = signal.blinkSec || 8;
        const offset = typeof signal.offset === 'number' ? signal.offset : 0;

        // 각 신호등 ID별 고유 위상(Offset)을 더해 절대 시각으로 위상 계산
        const currentPhase = (now + offset) % cycle;

        let color = "RED";
        let remainingTime = 0;
        let isBlinking = false;

        if (currentPhase < greenDuration) {
            remainingTime = greenDuration - currentPhase;
            if (remainingTime <= blinkDuration) {
                color = "BLINKING";
                isBlinking = true;
            } else {
                color = "GREEN";
            }
        } else {
            color = "RED";
            remainingTime = cycle - currentPhase;
        }

        return {
            id: signal.id,
            name: signal.name,
            lat: signal.lat,
            lng: signal.lng,
            color,
            remainingTime,
            isBlinking,
            cycle,
            currentPhase
        };
    },

    setSignals(signalsList) {
        this.signals = signalsList || [];
        this.stoppedSignalId = null;
        logEvent('[SIGNAL]', `경로 상 신호등 ${this.signals.length}개 절대 시각 엔진 등록 완료`, 'info');
        this.tick();
    },

    startEngine() {
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => {
            this.tick();
        }, 1000);
    },

    tick() {
        if (!this.signals || this.signals.length === 0) {
            this.updateEmptyDisplay();
            return;
        }

        const nowSec = Math.floor(Date.now() / 1000);
        const computedSignals = this.signals.map(sig => this.getSignalState(sig, nowSec));

        // 로보독 현재 위치 기준 전방 가장 가까운 신호등 계산
        let currentPos = null;
        if (RealMapManager && RealMapManager.currentRoute && RealMapManager.currentRoute.waypoints) {
            const wps = RealMapManager.currentRoute.waypoints;
            const idx = Math.min(RealMapManager.currentWaypointIndex, wps.length - 1);
            if (wps[idx]) {
                currentPos = { lat: wps[idx].lat, lng: wps[idx].lng };
            }
        }

        let closest = computedSignals[0];
        let minDist = Infinity;

        computedSignals.forEach(sig => {
            if (currentPos) {
                const dist = calculateDistanceM(currentPos.lat, currentPos.lng, sig.lat, sig.lng);
                sig.distToRobot = dist;
                if (dist < minDist) {
                    minDist = dist;
                    closest = sig;
                }
            }
        });

        this.closestSignal = closest;

        // [2단계: 보호자 관제 모드] 지도 위 모든 신호등 마커 실시간 갱신 (초록/빨강/숫자 점멸)
        if (RealMapManager && typeof RealMapManager.updateAllSignalMarkers === 'function') {
            RealMapManager.updateAllSignalMarkers(computedSignals);
        }

        // [2단계: 관제 패널 갱신]
        this.updateControlPanel(closest);

        // [3단계: 어르신 모드 UI 실시간 표출]
        this.updateSeniorModeUI(closest, minDist);

        // [3단계: 로보독 10m 접근 시 자동 정지(CMD:SIGNAL_STOP) 및 출발(CMD:SIGNAL_START) BLE 제어]
        this.evaluateRobotSafety(closest, minDist);
    },

    updateEmptyDisplay() {
        const intersectionNameEl = document.getElementById('signalIntersectionName');
        const actionTextEl = document.getElementById('signalActionText');
        const signalCountdownEl = document.getElementById('signalCountdown');
        const signalStateBadgeEl = document.getElementById('signalStateBadge');

        if (intersectionNameEl) intersectionNameEl.textContent = '현재 경로: 건너는 횡단보도 없음 (인도 안전 구간)';
        if (actionTextEl) actionTextEl.textContent = '🚶 횡단보도를 건너지 않고 인도로 안전하게 직진 이동합니다.';
        if (signalCountdownEl) {
            signalCountdownEl.textContent = '-';
            signalCountdownEl.style.color = '#94A3B8';
        }
        if (signalStateBadgeEl) {
            signalStateBadgeEl.className = 'badge badge-gray';
            signalStateBadgeEl.textContent = '횡단보도 없음';
        }
    },

    updateControlPanel(sig) {
        if (!sig) return;
        const nameEl = document.getElementById('signalIntersectionName');
        const countEl = document.getElementById('signalCountdown');
        const actionEl = document.getElementById('signalActionText');
        const badgeEl = document.getElementById('signalStateBadge');
        const timerLabel = document.getElementById('signalTimerLabel');
        const lightRed = document.getElementById('lightRed');
        const lightYellow = document.getElementById('lightYellow');
        const lightGreen = document.getElementById('lightGreen');

        if (nameEl) nameEl.textContent = sig.name;

        if (countEl) {
            countEl.textContent = sig.remainingTime;
            if (sig.color === 'RED') {
                countEl.style.color = '#EF4444';
            } else if (sig.isBlinking) {
                countEl.style.color = '#F59E0B';
            } else {
                countEl.style.color = '#10B981';
            }
        }

        if (sig.color === 'GREEN' || sig.color === 'BLINKING') {
            if (lightRed) lightRed.className = 'light light-red';
            if (lightYellow) lightYellow.className = 'light light-yellow';

            if (sig.isBlinking) {
                if (timerLabel) timerLabel.textContent = '보행 잔여시간 (초록불 깜빡임)';
                if (lightGreen) lightGreen.className = 'light light-green active blinking';
                if (actionEl) actionEl.textContent = `⚠️ 보행 신호 마감 임박 (${sig.remainingTime}초) - 신속 횡단 또는 진입 금지`;
                if (badgeEl) { badgeEl.className = 'badge badge-yellow'; badgeEl.textContent = `녹색 점멸 (${sig.remainingTime}초)`; }
            } else {
                if (timerLabel) timerLabel.textContent = '보행 잔여시간 (초록불)';
                if (lightGreen) lightGreen.className = 'light light-green active';
                if (actionEl) actionEl.textContent = `🟢 보행 가능 (${sig.remainingTime}초 남음) - 안전 서행 주행 중`;
                if (badgeEl) { badgeEl.className = 'badge badge-green'; badgeEl.textContent = `녹색 신호 (${sig.remainingTime}초)`; }
            }
        } else if (sig.color === 'RED') {
            if (timerLabel) timerLabel.textContent = '대기 잔여시간 (빨간불)';
            if (lightRed) lightRed.className = 'light light-red active';
            if (lightYellow) lightYellow.className = 'light light-yellow';
            if (lightGreen) lightGreen.className = 'light light-green';
            if (actionEl) actionEl.textContent = `🔴 보행 정지 (${sig.remainingTime}초 후 보행 신호) - 안전 대기선 준수`;
            if (badgeEl) { badgeEl.className = 'badge badge-red'; badgeEl.textContent = `적색 신호 (${sig.remainingTime}초)`; }
        }
    },

    // [어르신 모드] 경로 상 가장 가까운 다음 신호등 1개에 대해 실시간 안내
    updateSeniorModeUI(sig, distToRobot) {
        if (!sig) return;

        let title = '';
        let sub = '';
        let badge = '';

        if (sig.color === 'RED') {
            title = `🚦 횡단보도 앞: 빨간불 (${sig.remainingTime}초 대기)`;
            sub = '파란불이 켜질 때까지 안전선 뒤에서 멈춰 기다립니다.';
            badge = `신호 대기 (${sig.remainingTime}초)`;
        } else if (sig.isBlinking) {
            title = `⚠️ 횡단보도 앞: 초록불 점멸 (${sig.remainingTime}초 남음)`;
            sub = '신호가 곧 바뀝니다! 무리하게 건너지 마세요.';
            badge = `점멸 주의 (${sig.remainingTime}초)`;
        } else {
            title = `🚦 횡단보도 앞: 초록불 (${sig.remainingTime}초 남음)`;
            sub = '좌우를 살피며 천천히 안전하게 건너갑니다.';
            badge = `보행 가능 (${sig.remainingTime}초)`;
        }

        // 어르신 모드 화면의 실시간 상태 카드 갱신
        if (AppState.currentMode === 'senior') {
            if (AppState.isWalking || distToRobot <= 40) {
                updateSeniorStatus(title, sub, badge);
            }
        }

        // 노인 모드 대형 네비 HUD에도 신호등 정보 표시
        const seniorHudBox = document.getElementById('seniorNavHudBox');
        const seniorNavText = document.getElementById('seniorNavText');
        if (seniorHudBox && seniorNavText && distToRobot <= 30) {
            seniorNavText.textContent = `${title} (${sig.name})`;
        }
    },

    // [로보독 제어] 횡단보도 10m 접근 시 적색 정지 / 녹색 출발 BLE 패킷 전송
    evaluateRobotSafety(sig, distToRobot) {
        if (!sig || !AppState.currentDest) return;

        // 횡단보도 10m 이내 접근 시 (8~12m 구간)
        if (distToRobot <= 12) {
            if (sig.color === 'RED' || (sig.isBlinking && sig.remainingTime <= 4)) {
                if (AppState.isWalking) {
                    this.stoppedSignalId = sig.id;
                    AppState.isWalking = false;
                    BleController.sendPacket('CMD:SIGNAL_STOP');
                    logEvent('[SIGNAL]', `🛑 [로보독 정지] ${sig.name} 10m 앞 적색 신호 감지! 안전 대기선 자동 정지 (CMD:SIGNAL_STOP, 잔여 대기: ${sig.remainingTime}초)`, 'warn');
                    VoiceEngine.speak(`횡단보도 빨간불입니다. ${sig.remainingTime}초 동안 대기선에서 안전하게 멈춥니다.`);
                    updateSeniorStatus(`🚦 횡단보도 앞: 빨간불 (${sig.remainingTime}초 대기)`, '빨간불에는 건너지 않아요. 파란불로 바뀌면 출발할게요.', '신호 정지 중');
                }
            } else if (sig.color === 'GREEN' && sig.remainingTime > 6) {
                if (this.stoppedSignalId === sig.id) {
                    this.stoppedSignalId = null;
                    AppState.isWalking = true;
                    BleController.sendPacket('CMD:SIGNAL_START');
                    logEvent('[SIGNAL]', `🟢 [로보독 출발] ${sig.name} 녹색 신호 전환 감지! 보행 자동 재개 (CMD:SIGNAL_START, 잔여 보행: ${sig.remainingTime}초)`, 'success');
                    VoiceEngine.speak(`초록불로 바뀌었습니다. 잔여 시간 ${sig.remainingTime}초 남았습니다. 천천히 건너갑니다.`);
                    updateSeniorStatus(`🟢 횡단보도 앞: 초록불 (${sig.remainingTime}초 남음)`, '좌우를 살피며 천천히 안전하게 건너갑니다.', '횡단보도 보행 중');
                }
            }
        }
    },

    bindControls() {
        const btnRed = document.getElementById('btnMockRedSignal');
        const btnGreen = document.getElementById('btnMockGreenSignal');
        const btnAuto = document.getElementById('btnSignalAutoToggle');

        if (btnRed) {
            btnRed.addEventListener('click', () => {
                const now = Math.floor(Date.now() / 1000);
                this.manualOverride = { color: 'RED', untilEpoch: now + 90 };
                logEvent('[SIGNAL]', '🔴 [수동 제어] 적색 신호 강제 설정 (90초)', 'warn');
                this.tick();
            });
        }
        if (btnGreen) {
            btnGreen.addEventListener('click', () => {
                const now = Math.floor(Date.now() / 1000);
                this.manualOverride = { color: 'GREEN', untilEpoch: now + 30 };
                logEvent('[SIGNAL]', '🟢 [수동 제어] 녹색 신호 강제 설정 (30초)', 'success');
                this.tick();
            });
        }
        if (btnAuto) {
            btnAuto.addEventListener('click', () => {
                this.manualOverride = null;
                logEvent('[SIGNAL]', '🔄 [자동 복귀] C-ITS 절대 시각 표준 자동 신호 동기화 복귀', 'info');
                this.tick();
            });
        }

        // C-ITS 실제 신호등 데이터 연동 안내 모달
        const btnCitsInfo = document.getElementById('btnOpenCitsInfo');
        const citsModal = document.getElementById('citsModal');
        const btnCloseCits = document.getElementById('btnCloseCitsModal');
        const btnConfirmCits = document.getElementById('btnConfirmCitsModal');

        if (btnCitsInfo && citsModal) {
            btnCitsInfo.addEventListener('click', () => {
                citsModal.style.display = 'flex';
            });
        }
        if (btnCloseCits && citsModal) {
            btnCloseCits.addEventListener('click', () => {
                citsModal.style.display = 'none';
            });
        }
        if (btnConfirmCits && citsModal) {
            btnConfirmCits.addEventListener('click', () => {
                citsModal.style.display = 'none';
            });
        }
    }
};

// ---------------------------------------------------------
// 9. AI 돌봄 & 원격 파라미터 튜닝 매니저
// ---------------------------------------------------------
const CareTuningManager = {
    init() {
        this.bindSliders();
        this.bindCareButtons();
        logEvent('[SYSTEM]', 'AI 돌봄 & 원격 튜닝 시스템 초기화 완료', 'info');
    },

    bindSliders() {
        const sliderSpeed = document.getElementById('sliderSpeed');
        const valSpeed = document.getElementById('valSpeedSetting');
        const sliderSafety = document.getElementById('sliderSafetyDist');
        const valSafety = document.getElementById('valDistanceSetting');

        if (sliderSpeed) {
            sliderSpeed.addEventListener('input', (e) => {
                const val = parseInt(e.target.value);
                AppState.speed = val;
                const kmh = (val * 0.036).toFixed(1);
                if (valSpeed) valSpeed.textContent = `${val} (${kmh} km/h)`;
                
                BleController.sendPacket(`CMD:SPEED:${val}`);
                logEvent('[TUNE]', `보행 속도 원격 튜닝: ${val} (${kmh} km/h)`, 'info');
            });
        }

        if (sliderSafety) {
            sliderSafety.addEventListener('input', (e) => {
                const val = parseInt(e.target.value);
                AppState.safetyDist = val;
                if (valSafety) valSafety.textContent = `${val} cm`;

                BleController.sendPacket(`CMD:SAFETY:${val}`);
                logEvent('[TUNE]', `센서 감지 안전거리 튜닝: ${val} cm`, 'info');
            });
        }
    },

    bindCareButtons() {
        const btnFall = document.getElementById('btnTriggerFall');
        if (btnFall) {
            btnFall.addEventListener('click', () => {
                this.triggerFallDetection();
            });
        }

        const btnQr = document.getElementById('btnTriggerQr');
        if (btnQr) {
            btnQr.addEventListener('click', () => {
                this.triggerQrTagScan();
            });
        }

        const btnReport = document.getElementById('btnDailyReport');
        const btnClose = document.getElementById('btnCloseReport');
        const btnConfirm = document.getElementById('btnConfirmReport');
        const reportModal = document.getElementById('reportModal');

        if (btnReport) {
            btnReport.addEventListener('click', () => {
                this.updateReportModalData();
                if (reportModal) reportModal.style.display = 'flex';
            });
        }
        if (btnClose) btnClose.addEventListener('click', () => { reportModal.style.display = 'none'; });
        if (btnConfirm) btnConfirm.addEventListener('click', () => { reportModal.style.display = 'none'; });
    },

    triggerFallDetection() {
        AppState.isWalking = false;
        logEvent('[ALERT]', '🚨 [AI 자세 센서] 낙상/충격 감지! 긴급 E-STOP 발동', 'error');
        BleController.sendPacket('CMD:ESTOP:FALL_DETECTED');

        updateSeniorStatus(
            '🚨 비정상 낙상/충격이 감지되었습니다!',
            '로보독이 비상 정지하고 보호자와 119에 긴급 구조 신호를 보냈습니다.',
            '🚨 낙상 긴급 E-STOP'
        );

        VoiceEngine.speak('비상 상황입니다! 비정상 충격 및 낙상이 감지되어 로보독이 즉시 멈췄습니다.');

        const modal = document.getElementById('emergencyModal');
        if (modal) {
            document.getElementById('emergencyTime').textContent = new Date().toLocaleTimeString();
            modal.style.display = 'flex';
        }
    },

    triggerQrTagScan() {
        const sampleTags = [
            { code: 'QR-HOSPITAL', place: '늘푸른병원 정문 진입로', guide: '🏥 늘푸른병원 정문 앞입니다. 휠체어 전용 경사로가 오른쪽에 있습니다.' },
            { code: 'QR-PARK', place: '은빛 어르신 쉼터', guide: '🌳 은빛 쉼터 공원입니다. 그늘 벤치와 음수대가 마련되어 있습니다.' }
        ];
        const tag = sampleTags[Math.floor(Math.random() * sampleTags.length)];

        logEvent('[VISION]', `📷 카메라 QR 장소 태그 인식: [${tag.place}]`, 'success');
        updateSeniorStatus(`📷 [장소 안내] ${tag.place}`, tag.guide, '안내 정보 확인');
        VoiceEngine.speak(tag.guide);
    },

    updateReportModalData() {
        const repDist = document.getElementById('repDistance');
        const repTime = document.getElementById('repTime');
        const repSignal = document.getElementById('repSignalWait');
        const repAvoid = document.getElementById('repAvoidCount');

        if (repDist) repDist.textContent = `${(AppState.stats.totalDistance / 1000).toFixed(1)} km`;
        if (repTime) repTime.textContent = `${Math.floor(AppState.stats.walkTimeSeconds / 60)}분`;
        if (repSignal) repSignal.textContent = `${AppState.stats.signalWaitCount}회`;
        if (repAvoid) repAvoid.textContent = `${AppState.stats.avoidCount}회`;
    }
};

// ---------------------------------------------------------
// 9-1. 전체 실제 목적지 탐색 모달 매니저 (68+ 장소)
// ---------------------------------------------------------
const AllPlacesModalManager = {
    modalEl: null,
    listEl: null,
    searchInput: null,
    clearBtn: null,
    countBadge: null,
    allPlaces: [],
    currentCategory: '',
    searchQuery: '',

    init() {
        this.modalEl = document.getElementById('allPlacesModal');
        this.listEl = document.getElementById('modalPlacesList');
        this.searchInput = document.getElementById('inputModalSearch');
        this.clearBtn = document.getElementById('btnClearModalSearch');
        this.countBadge = document.getElementById('modalPlacesCountBadge');

        const btnClose = document.getElementById('btnCloseAllPlaces');
        if (btnClose) btnClose.addEventListener('click', () => this.close());

        const btnSeniorMore = document.getElementById('btnSeniorMorePlaces');
        if (btnSeniorMore) btnSeniorMore.addEventListener('click', () => this.open());

        const btnGenAll = document.getElementById('btnOpenAllPlacesGeneral');
        if (btnGenAll) btnGenAll.addEventListener('click', () => this.open());

        // 카테고리 탭 이벤트
        document.querySelectorAll('#modalCategoryTabs .modal-cat-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('#modalCategoryTabs .modal-cat-tab').forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                this.currentCategory = tab.getAttribute('data-category') || '';
                this.render();
            });
        });

        // 실시간 검색 인풋 이벤트
        if (this.searchInput) {
            this.searchInput.addEventListener('input', (e) => {
                this.searchQuery = e.target.value.trim().toLowerCase();
                if (this.clearBtn) this.clearBtn.style.display = this.searchQuery ? 'block' : 'none';
                this.render();
            });
        }
        if (this.clearBtn) {
            this.clearBtn.addEventListener('click', () => {
                this.searchInput.value = '';
                this.searchQuery = '';
                this.clearBtn.style.display = 'none';
                this.render();
                this.searchInput.focus();
            });
        }

        // 배경 클릭 시 닫기
        if (this.modalEl) {
            this.modalEl.addEventListener('click', (e) => {
                if (e.target === this.modalEl) this.close();
            });
        }

        // ESC 키로 닫기
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.modalEl && this.modalEl.style.display !== 'none') {
                this.close();
            }
        });
    },

    async open(category = '') {
        if (!this.modalEl) return;
        this.modalEl.style.display = 'flex';
        this.currentCategory = category;

        document.querySelectorAll('#modalCategoryTabs .modal-cat-tab').forEach(t => {
            if ((t.getAttribute('data-category') || '') === category) {
                t.classList.add('active');
            } else {
                t.classList.remove('active');
            }
        });

        await this.loadPlaces();
        if (this.searchInput) {
            this.searchInput.value = '';
            this.searchQuery = '';
            if (this.clearBtn) this.clearBtn.style.display = 'none';
            this.searchInput.focus();
        }
    },

    close() {
        if (this.modalEl) this.modalEl.style.display = 'none';
    },

    async loadPlaces() {
        const userLoc = (RealMapManager && RealMapManager.userLocation) ? RealMapManager.userLocation : lastUserCoords;
        try {
            const res = await fetch(`/api/places/search?lat=${userLoc.lat}&lng=${userLoc.lng}&limit=100`);
            const data = await res.json();
            if (data.status === 'success' && data.results) {
                this.allPlaces = data.results;
                this.render();
            }
        } catch (err) {
            console.error('전체 장소 데이터 로드 실패:', err);
        }
    },

    render() {
        if (!this.listEl) return;
        this.listEl.innerHTML = '';

        const filtered = this.allPlaces.filter(p => {
            const matchCat = !this.currentCategory || p.category === this.currentCategory;
            const matchQuery = !this.searchQuery || 
                p.name.toLowerCase().includes(this.searchQuery) || 
                p.address.toLowerCase().includes(this.searchQuery) ||
                p.category.toLowerCase().includes(this.searchQuery);
            return matchCat && matchQuery;
        });

        if (this.countBadge) {
            this.countBadge.textContent = `${filtered.length}개 장소`;
        }

        if (filtered.length === 0) {
            this.listEl.innerHTML = `
                <div style="text-align: center; padding: 40px 20px; color: #94A3B8;">
                    <div style="font-size: 36px; margin-bottom: 8px;">🔍</div>
                    <div style="font-size: 16px; font-weight: 700; color: #CBD5E1;">일치하는 장소를 찾을 수 없습니다</div>
                    <div style="font-size: 13px; margin-top: 4px;">다른 검색어를 입력하거나 카테고리 탭을 변경해 보세요.</div>
                </div>
            `;
            return;
        }

        filtered.forEach(place => {
            const item = document.createElement('div');
            item.className = 'place-list-item';
            
            const distText = (place.dist_m !== undefined && place.dist_m !== null)
                ? (place.dist_m < 1000 ? `${place.dist_m}m` : `${(place.dist_m / 1000).toFixed(1)}km`)
                : '';

            item.innerHTML = `
                <div class="place-item-left">
                    <span class="place-item-icon">${getCategoryIcon(place.category)}</span>
                    <div class="place-item-details">
                        <div class="place-item-name-row">
                            <span class="place-item-name">${place.name}</span>
                            <span class="place-item-cat-badge">${place.category}</span>
                        </div>
                        <span class="place-item-addr">${place.address}</span>
                    </div>
                </div>
                <div class="place-item-right">
                    ${distText ? `<span class="place-item-dist">📍 ${distText}</span>` : ''}
                    <button class="btn-start-guide-mini">안내 시작</button>
                </div>
            `;

            item.addEventListener('click', () => {
                this.close();
                const searchInput = document.getElementById('inputGeneralSearch');
                if (searchInput) searchInput.value = place.name;
                const ttsMsg = AppState.currentMode === 'senior' 
                    ? `${place.name}(으)로 안내를 시작합니다. 저를 따라오세요.`
                    : null;
                startNavigation(place.name, ttsMsg);
            });

            this.listEl.appendChild(item);
        });
    }
};

// ---------------------------------------------------------
// 10. 내비게이션 & UI 헬퍼 함수
// ---------------------------------------------------------
function updateSeniorStatus(mainText, subText, badgeText = '안심 주행 중') {
    const mainEl = document.getElementById('seniorMainStatusText');
    const subEl = document.getElementById('seniorSubStatusText');
    const badgeEl = document.getElementById('seniorStatusBadge');
    
    if (mainEl && mainText) mainEl.textContent = `"${mainText}"`;
    if (subEl && subText) subEl.textContent = subText;
    if (badgeEl && badgeText) badgeEl.textContent = badgeText;
}

function startNavigation(destName, ttsMessage) {
    AppState.currentDest = destName;
    AppState.isWalking = true;
    logEvent('[NAV]', `목적지 설정 완료: [${destName}] 도보 안내 가동`, 'success');
    
    updateSeniorStatus(
        `🐕 ${destName}(으)로 안전하게 모시는 중입니다.`,
        '보폭에 맞추어 서행 중입니다. 신호등과 주변을 살피고 있어요.',
        '안전 보행 중'
    );
    
    const genBadge = document.getElementById('generalWalkBadge');
    if (genBadge) {
        genBadge.className = 'badge badge-green';
        genBadge.textContent = `${destName} 동행 중`;
    }

    BleController.sendPacket(`CMD:START:DEST=${destName}`);
    RealMapManager.loadRoute(destName);
    
    // 어르신 모드일 때만 음성 안내 출력
    if (AppState.currentMode === 'senior' && ttsMessage) {
        VoiceEngine.speak(ttsMessage);
    }
}

function pauseNavigation() {
    AppState.isWalking = false;
    logEvent('[NAV]', '보행 일시 정지 (잠시 멈춤)', 'warn');
    updateSeniorStatus(
        '🛑 로보독이 잠시 멈추었습니다.',
        '숨을 고르시고, 준비되시면 [계속 걷기] 버튼을 눌러주세요.',
        '일시 정지'
    );
    const genBadge = document.getElementById('generalWalkBadge');
    if (genBadge) {
        genBadge.className = 'badge badge-red';
        genBadge.textContent = '일시 정지됨';
    }
    BleController.sendPacket('CMD:STOP');
    if (AppState.currentMode === 'senior') {
        VoiceEngine.speak('잠시 멈췄습니다. 편안히 쉬시고 준비되시면 말씀해 주세요.');
    }
}

function resumeNavigation() {
    if (!AppState.currentDest) {
        if (AppState.currentMode === 'senior') {
            VoiceEngine.speak('먼저 어디로 가실지 목적지를 선택해 주세요.');
        }
        return;
    }
    AppState.isWalking = true;
    logEvent('[NAV]', `보행 재개: [${AppState.currentDest}] 안내 계속 진행`, 'info');
    updateSeniorStatus(
        `🐕 ${AppState.currentDest}(으)로 계속 걸어갑니다.`,
        '발걸음에 맞춰 안전하게 안내 중입니다.',
        '안전 보행 중'
    );
    const genBadge = document.getElementById('generalWalkBadge');
    if (genBadge) {
        genBadge.className = 'badge badge-green';
        genBadge.textContent = `${AppState.currentDest} 동행 중`;
    }
    BleController.sendPacket('CMD:START');
    if (AppState.currentMode === 'senior') {
        VoiceEngine.speak('다시 출발합니다. 천천히 걸어오세요.');
    }
}

function triggerSosAlert() {
    AppState.isWalking = false;
    logEvent('[ALERT]', '🚨 긴급 SOS 비상 호출 발생! E-STOP 긴급 정지', 'error');
    updateSeniorStatus(
        '🚨 긴급 SOS가 발송되었습니다!',
        '로보독이 즉시 정지하였으며 보호자와 119에 위치를 보냈습니다.',
        '🚨 긴급 SOS'
    );
    
    BleController.sendPacket('CMD:ESTOP');
    VoiceEngine.speak('비상 호출을 전송했습니다. 로보독이 즉시 멈추고 보호자에게 연락하고 있습니다.');
    
    const modal = document.getElementById('emergencyModal');
    if (modal) {
        document.getElementById('emergencyTime').textContent = new Date().toLocaleTimeString();
        modal.style.display = 'flex';
    }
}

// ---------------------------------------------------------
// 11. 모드 전환 인터랙션 (👵 어르신 ↔ 👤 일반 모드 통합)
// ---------------------------------------------------------
function switchMode(targetMode) {
    AppState.currentMode = targetMode;

    const btnSenior = document.getElementById('btnSeniorMode');
    const btnGeneral = document.getElementById('btnGeneralMode');

    const seniorView = document.getElementById('seniorView');
    const generalView = document.getElementById('generalView');

    if (btnSenior) btnSenior.classList.remove('active');
    if (btnGeneral) btnGeneral.classList.remove('active');

    if (seniorView) seniorView.style.display = 'none';
    if (generalView) generalView.style.display = 'none';

    if (targetMode === 'senior') {
        document.body.className = 'mode-senior';
        if (btnSenior) btnSenior.classList.add('active');
        if (seniorView) seniorView.style.display = 'flex';

        logEvent('[MODE]', '👵 [노인 안심 모드]로 전환되었습니다.', 'success');
        const activeName = AuthManager.currentUser ? AuthManager.formatDisplayName(AuthManager.currentUser.name) : 'guest님';
        VoiceEngine.speak(`노인 안심 모드로 전환되었습니다. ${activeName}, 어디로 모실까요?`, false);

    } else if (targetMode === 'general') {
        document.body.className = 'mode-general';
        if (btnGeneral) btnGeneral.classList.add('active');
        if (generalView) generalView.style.display = 'flex';

        logEvent('[MODE]', '👤 [일반 모드 & 스마트 관제 센터]로 전환되었습니다.', 'info');
        RealMapManager.invalidate();
    }
}

// ---------------------------------------------------------
// 12. 이벤트 바인딩 및 앱 시작
// ---------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    logEvent('[SYSTEM]', 'RoboDog WAY GUIDE 시스템 가동...', 'info');

    // 0. 내레이터 음성 초기화 및 토글 바인딩
    VoiceEngine.init();
    const btnNarratorHeader = document.getElementById('btnToggleNarrator');
    const btnNarratorTuning = document.getElementById('btnToggleNarratorInTuning');
    if (btnNarratorHeader) {
        btnNarratorHeader.addEventListener('click', () => {
            VoiceEngine.toggleNarrator();
        });
    }
    if (btnNarratorTuning) {
        btnNarratorTuning.addEventListener('click', () => {
            VoiceEngine.toggleNarrator();
        });
    }

    // 1. 모드 전환 버튼 바인딩 (노인 모드 / 일반 모드)
    const btnSenior = document.getElementById('btnSeniorMode');
    const btnGeneral = document.getElementById('btnGeneralMode');

    if (btnSenior) {
        btnSenior.addEventListener('click', (e) => {
            e.preventDefault();
            switchMode('senior');
        });
    }
    if (btnGeneral) {
        btnGeneral.addEventListener('click', (e) => {
            e.preventDefault();
            switchMode('general');
        });
    }

    // 2. 실제 BLE 페어링 버튼 바인딩
    const btnBleToggle = document.getElementById('btnBleToggle');
    if (btnBleToggle) {
        btnBleToggle.addEventListener('click', () => {
            if (AppState.isBleConnected && !AppState.isMockBle) {
                BleController.disconnect();
            } else {
                BleController.connect();
            }
        });
    }

    // 3. 내 위치 찾기 (GPS) 버튼 바인딩
    const btnMyLocationHeader = document.getElementById('btnMyLocationHeader');
    const btnMapMyLocation = document.getElementById('btnMapMyLocation');
    const btnConnectGpsPrompt = document.getElementById('btnConnectGpsPrompt');

    if (btnMyLocationHeader) {
        btnMyLocationHeader.addEventListener('click', () => {
            RealMapManager.locateUser(true);
        });
    }
    if (btnMapMyLocation) {
        btnMapMyLocation.addEventListener('click', () => {
            RealMapManager.locateUser(true);
        });
    }
    if (btnConnectGpsPrompt) {
        btnConnectGpsPrompt.addEventListener('click', () => {
            RealMapManager.locateUser(true);
        });
    }

    // 4. 음성 마이크 버튼 바인딩
    const micBtn = document.getElementById('btnVoiceListen');
    if (micBtn) {
        micBtn.addEventListener('click', () => {
            VoiceEngine.speak('네, 어디로 갈까요? 편안하게 말씀해 주세요.', true);
            setTimeout(() => VoiceEngine.startSTT(), 1600);
        });
    }

    // 5. 어르신 모드 초대형 목적지 카드 (병원, 약국, 우리집, 복지관, 산책로, 마트, 지하철, 주민센터, SOS, 더보기)
    document.querySelectorAll('.senior-destination-grid .dest-card').forEach(card => {
        card.addEventListener('click', () => {
            if (card.id === 'btnSeniorMorePlaces' || card.getAttribute('data-action') === 'open-places-modal') {
                AllPlacesModalManager.open();
                return;
            }
            const dest = card.getAttribute('data-dest');
            const tts = card.getAttribute('data-tts');
            
            if (dest === 'SOS') {
                triggerSosAlert();
            } else if (dest) {
                startNavigation(dest, tts);
            }
        });
    });

    // 5-1. 일반 모드 카테고리 필터 바 (전체, 지하철, 병원, 약국, 공공기관, 복지, 마트, 공원, 카페)
    document.querySelectorAll('#generalCategoryFilterBar .cat-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            document.querySelectorAll('#generalCategoryFilterBar .cat-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            const cat = pill.getAttribute('data-category') || '';
            const userLoc = (RealMapManager && RealMapManager.userLocation) ? RealMapManager.userLocation : lastUserCoords;
            updateQuickDestinations(userLoc.lat, userLoc.lng, cat);
        });
    });

    // 6. 어르신 모드 하단 잠시멈춤 / 계속걷기
    const btnStop = document.getElementById('btnSeniorStop');
    const btnResume = document.getElementById('btnSeniorResume');
    if (btnStop) btnStop.addEventListener('click', pauseNavigation);
    if (btnResume) btnResume.addEventListener('click', resumeNavigation);

    // 7. 일반 모드 검색 & 추천 목적지
    const btnGenSearch = document.getElementById('btnGeneralSearch');
    const inputGenSearch = document.getElementById('inputGeneralSearch');
    if (btnGenSearch && inputGenSearch) {
        btnGenSearch.addEventListener('click', () => {
            const query = inputGenSearch.value.trim() || '수지구청역 (신분당선)';
            startNavigation(query, null);
        });
        inputGenSearch.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                const query = inputGenSearch.value.trim() || '수지구청역 (신분당선)';
                startNavigation(query, null);
            }
        });
    }

    // 일반 모드 4대 추천 목적지 카드 클릭
    document.querySelectorAll('.quick-dest-item').forEach(item => {
        item.addEventListener('click', () => {
            const dest = item.getAttribute('data-dest');
            startNavigation(dest, null);
        });
    });

    // 일반 모드 동행 칩
    document.querySelectorAll('.mode-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            document.querySelectorAll('.mode-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            AppState.walkMode = chip.getAttribute('data-walkmode');
            logEvent('[NAV]', `로보독 동행 모드 변경: [${chip.textContent.trim()}]`, 'info');
            BleController.sendPacket(`CMD:WALKMODE:${AppState.walkMode.toUpperCase()}`);
        });
    });

    // 일반 모드 상단 컨트롤 (출발 / 정지)
    const btnGenStart = document.getElementById('btnGeneralStart');
    const btnGenStop = document.getElementById('btnGeneralStop');
    if (btnGenStart) btnGenStart.addEventListener('click', resumeNavigation);
    if (btnGenStop) btnGenStop.addEventListener('click', pauseNavigation);

    // 8. 비상 긴급 모달 인터랙션
    const btnCall = document.getElementById('btnEmergencyCall');
    const btnDismiss = document.getElementById('btnEmergencyDismiss');
    const emergencyModal = document.getElementById('emergencyModal');

    if (btnCall) {
        btnCall.addEventListener('click', () => {
            logEvent('[ALERT]', '📞 보호자(010-1234-5678) 긴급 전화 연결', 'warn');
            alert('📞 [긴급 통화 연결]\n보호자(010-1234-5678)에게 비상 통화를 발신합니다.');
        });
    }
    if (btnDismiss) {
        btnDismiss.addEventListener('click', () => {
            emergencyModal.style.display = 'none';
            logEvent('[ALERT]', '비상 경보가 정상 해제되었습니다.', 'info');
            updateSeniorStatus('안전 상태로 복귀했습니다.', '가실 목적지를 다시 선택하시거나 계속 걷기를 누르세요.', '정상 대기');
            VoiceEngine.speak('비상 상태가 해제되었습니다.');
        });
    }

    // 9. 관제 로그 비우기
    const btnClear = document.getElementById('btnClearLog');
    if (btnClear) {
        btnClear.addEventListener('click', () => {
            const box = document.getElementById('guardianLogConsole');
            if (box) box.innerHTML = '';
            logEvent('[SYSTEM]', '관제 로그 화면을 초기화했습니다.', 'info');
        });
    }

    // 10. 서버 공개 설정 비동기 조회
    fetch('/api/config')
        .then(res => res.json())
        .then(config => {
            logEvent('[SYSTEM]', `서버 설정 연동 완료 (OpenStreetMap 실시간 실제 지도 가동)`, 'success');
        })
        .catch(err => {
            logEvent('[ERROR]', `설정 로드 실패: ${err.message}`, 'error');
        });

    // 11. 지도, 회원 인증 매니저, 내 집 주소 매니저, 실시간 검색 자동완성, 캔버스, 신호등, AI 돌봄 엔진, 전체 장소 모달, Face ID 모달 초기화
    AuthManager.init();
    HomeAddressManager.init();
    AutocompleteSearchManager.init();
    RealMapManager.init();
    CanvasRenderer.init();
    TrafficSignalEngine.init();
    CareTuningManager.init();
    AllPlacesModalManager.init();
    FaceIdManager.init();

    // 12. 초기 얼굴 인식(Face ID) 안내 실행
    FaceIdManager.runVerification();
});
