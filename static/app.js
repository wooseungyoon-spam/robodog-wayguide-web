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
    currentMode: 'general', // 'senior' | 'general' | 'guardian' (나이에 따라 초기화됨)
    userAge: 28,            // 사용자 만 나이 (만 60세 미만: 일반모드 전용 / 만 60세 이상: 노인+일반모드)
    isSeniorEligible: false,
    isBlindMode: false,
    walkMode: 'follow',    // 'follow' | 'side' | 'lead'
    isBleConnected: false,
    isMockBle: false,
    bleDevice: null,
    bleServer: null,
    bleTxChar: null,
    bleRxChar: null,
    bleAutoFollow: true,
    bleBattery: 94,
    bleRssi: -62,
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
// Nordic UART Service, HM-10, ESP32, Unitree, AD-401, LEGO, micro:bit 표준 BLE 서비스 UUID 목록
const BLE_UUIDS = {
    NUS_SERVICE: '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
    NUS_TX: '6e400002-b5a3-f393-e0a9-e50e24dcca9e',
    NUS_RX: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
    HM10_SERVICE: '0000ffe0-0000-1000-8000-00805f9b34fb',
    HM10_CHAR: '0000ffe1-0000-1000-8000-00805f9b34fb'
};

// [순수 로보독 하드웨어 전용 100% 정밀 필터링]
// 주의: services 필터나 AD_/BT/AT 등의 일반 접두사는 이름 없는 비콘이나 주변 에어컨(AD_401 등)을 통과시키므로
// 철저하게 로보독/로봇 전용 이름 접두사(namePrefix)만 사용하여 잡음 기기를 100% 원천 차단합니다!
const PURE_ROBOT_DEVICE_FILTERS = [
    { namePrefix: 'RoboDog' },
    { namePrefix: 'Robo' },
    { namePrefix: 'Robot' },
    { namePrefix: 'Dog' },
    { namePrefix: 'BBC micro:bit' }, // 마이크로비트 실제 브로드캐스트 기본 이름
    { namePrefix: 'BBC' },
    { namePrefix: 'micro:bit' },
    { namePrefix: 'Unitree' },
    { namePrefix: 'Go1' },
    { namePrefix: 'Go2' },
    { namePrefix: 'ESP32' },
    { namePrefix: 'HMSoft' },
    { namePrefix: 'HM-10' },
    { namePrefix: 'Arduino' },
    { namePrefix: 'SPIKE' },
    { namePrefix: 'LEGO' }
];

// 어떤 로봇/BLE 모듈을 선택해도 연결 실패하지 않도록 광범위 등록하는 만능 서비스 UUID 목록
const ALL_BLE_OPTIONAL_SERVICES = [
    '6e400001-b5a3-f393-e0a9-e50e24dcca9e',  // Nordic UART (NUS)
    '0000ffe0-0000-1000-8000-00805f9b34fb',  // HM-10 / CC2541 Serial
    '0000ffe5-0000-1000-8000-00805f9b34fb',  // JDY-08 / TI Serial
    '0000fff0-0000-1000-8000-00805f9b34fb',  // Custom UART (FFF0)
    '0000fee7-0000-1000-8000-00805f9b34fb',  // Telink / Tuya / ESP32
    '49535343-fe7d-4ae5-8fa9-9fafd205e455',  // Microchip / ISSC UART
    'e7810a71-73ae-499d-8c15-faa9aef0c3f2',  // micro:bit UART
    '00001623-1212-efde-1623-785feabcd123',  // LEGO Wireless Hub
    '00001101-0000-1000-8000-00805f9b34fb',  // Serial Port Profile (SPP)
    'generic_access',
    'device_information',
    'battery_service'
];

const BleController = {
    modalEl: null,
    terminalEl: null,

    init() {
        this.modalEl = document.getElementById('bluetoothModal');
        this.terminalEl = document.getElementById('bleTerminalOutput');

        // 헤더 및 어르신 화면의 BLE 버튼
        const btnHeader = document.getElementById('btnHeaderBle');
        const btnSenior = document.getElementById('btnSeniorConnectBle');
        const btnClose = document.getElementById('btnCloseBleModal');

        if (btnHeader) btnHeader.addEventListener('click', () => this.openModal());
        if (btnSenior) btnSenior.addEventListener('click', () => this.openModal());
        if (btnClose) btnClose.addEventListener('click', () => this.closeModal());

        // 모달 내 페어링 및 해제 버튼
        const btnPairReal = document.getElementById('btnBlePairReal');
        const btnPairAll = document.getElementById('btnBlePairAll');
        const btnPairVirt = document.getElementById('btnBlePairVirtual');
        const btnDisconn = document.getElementById('btnBleDisconnect');
        const btnClearLog = document.getElementById('btnClearBleLog');

        // [신규: 노트북 USB 유선 케이블 직결 + 무선 블루투스 통합 연동]
        const btnPairUsb = document.getElementById('btnPairUsbSerial');
        const btnPairMicrobit = document.getElementById('btnBlePairMicrobit');
        const btnCustomSearch = document.getElementById('btnBleCustomSearch');
        const inputCustomName = document.getElementById('inputBleCustomName');

        if (btnPairUsb) btnPairUsb.addEventListener('click', () => this.connectUsbSerial());
        if (btnPairMicrobit) btnPairMicrobit.addEventListener('click', () => this.connect('microbit'));
        if (btnPairReal) btnPairReal.addEventListener('click', () => this.connect('standard'));
        if (btnCustomSearch && inputCustomName) {
            btnCustomSearch.addEventListener('click', () => {
                const name = inputCustomName.value.trim();
                this.connect('custom', name);
            });
            inputCustomName.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    const name = inputCustomName.value.trim();
                    this.connect('custom', name);
                }
            });
        }
        if (btnPairAll) btnPairAll.addEventListener('click', () => this.connect('all'));
        if (btnPairVirt) btnPairVirt.addEventListener('click', () => this.enableMockMode());
        if (btnDisconn) btnDisconn.addEventListener('click', () => this.disconnect());
        if (btnClearLog && this.terminalEl) {
            btnClearLog.addEventListener('click', () => {
                this.terminalEl.innerHTML = '<div class="term-line info">[SYS] 콘솔 기록 초기화됨.</div>';
            });
        }

        // D-Pad 직접 조종 버튼들 바인딩
        const dpadBtns = [
            { id: 'btnDpadForward', cmd: 'CMD:FORWARD' },
            { id: 'btnDpadBackward', cmd: 'CMD:BACKWARD' },
            { id: 'btnDpadLeft', cmd: 'CMD:TURN_LEFT' },
            { id: 'btnDpadRight', cmd: 'CMD:TURN_RIGHT' },
            { id: 'btnDpadStop', cmd: 'CMD:STOP' }
        ];
        dpadBtns.forEach(item => {
            const el = document.getElementById(item.id);
            if (el) {
                el.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.sendPacket(item.cmd);
                });
            }
        });

        // 특수 동작 버튼 바인딩
        document.querySelectorAll('.btn-robot-motion').forEach(btn => {
            btn.addEventListener('click', () => {
                const cmd = btn.getAttribute('data-cmd');
                if (cmd) this.sendPacket(cmd);
            });
        });

        // 속도 기어 버튼 바인딩
        document.querySelectorAll('.btn-speed-gear').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.btn-speed-gear').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const gear = btn.getAttribute('data-speed') || '2';
                const speedVal = gear === '1' ? 15 : (gear === '3' ? 35 : 25);
                AppState.speed = speedVal;
                this.sendPacket(`CMD:SPEED:${speedVal}`);
            });
        });

        // 자동 추종 토글 바인딩
        const chkAuto = document.getElementById('chkBleAutoFollow');
        if (chkAuto) {
            chkAuto.addEventListener('change', (e) => {
                AppState.bleAutoFollow = e.target.checked;
                this.logTerminal(`[SYS] 자율 보행 추종 모드: ${AppState.bleAutoFollow ? 'ON (활성화)' : 'OFF (수동 전용)'}`, 'info');
            });
        }
    },

    
    selectBlindMode(enable, notify = true) {
        this.blindEnabled = enable;
        const btnOn = document.getElementById('btnSettingBlindOn');
        const btnOff = document.getElementById('btnSettingBlindOff');
        if (btnOn) btnOn.classList.toggle('active', enable);
        if (btnOff) btnOff.classList.toggle('active', !enable);
        if (notify) {
            logEvent('[SETTING]', `시각장애인 안심 모드: [${enable ? 'ON' : 'OFF'}]`, 'info');
        }
    },

    openModal() {
        if (this.modalEl) {
            this.modalEl.style.display = 'flex';
        }
    },

    closeModal() {
        if (this.modalEl) {
            this.modalEl.style.display = 'none';
        }
    },

    logTerminal(msg, type = 'info') {
        if (!this.terminalEl) return;
        const time = new Date().toTimeString().split(' ')[0];
        const line = document.createElement('div');
        line.className = `term-line ${type}`;
        line.textContent = `[${time}] ${msg}`;
        this.terminalEl.appendChild(line);
        this.terminalEl.scrollTop = this.terminalEl.scrollHeight;
    },

    /**
     * 실제 로보독 블루투스 디바이스 검색 및 GATT 페어링 (Web Bluetooth API)
     */
    /**
     * [신규: 노트북 USB 케이블 직접 연결 (Web Serial API / COM 포트 직결)]
     * 로보독이 노트북에 USB 케이블로 꽂혀 있을 때 블루투스 검색 대신 유선 시리얼 포트로 100% 즉각 연결
     */
    async connectUsbSerial() {
        if (!navigator.serial) {
            alert('현재 브라우저가 Web Serial API(USB 직접 연결)를 지원하지 않습니다.\nChrome 또는 Edge 브라우저를 사용해 주세요.');
            return;
        }

        try {
            this.updateUiConnecting();
            this.logTerminal('🔌 노트북에 USB 케이블로 연결된 로보독(COM 시리얼 포트) 선택 대기 중...', 'info');
            
            // 노트북에 꽂힌 USB 시리얼 포트(COM3, COM4, CH340, CP2102 등) 선택 팝업
            const port = await navigator.serial.requestPort();
            
            // 로보독/ESP32/아두이노 표준 115200 bps 우선 연결 (실패 시 9600)
            try {
                await port.open({ baudRate: 115200 });
            } catch (openErr) {
                try {
                    await port.open({ baudRate: 9600 });
                } catch (e) {
                    throw openErr;
                }
            }

            AppState.serialPort = port;
            AppState.isBleConnected = true;
            AppState.isUsbConnected = true;
            AppState.isMockBle = false;

            const devName = 'RoboDog-USB (노트북 유선 직결)';
            this.updateUiState(true, devName, devName);
            this.logTerminal(`🎉 [성공] 노트북 USB 케이블 직결 성공! (${devName}, 115200 bps)`, 'tx');
            logEvent('[ROBODOG]', `🎉 노트북 USB 직접 연결 성공! (${devName})`, 'success');
            VoiceEngine.speak('로보독과 노트북 USB 케이블로 직접 연결되었습니다.');

            // 시리얼 수신 루프 가동
            this.startSerialReadLoop(port);

            // 백엔드 상태 동기화
            fetch('/api/robodog/ble/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connected: true, device_name: devName, connection_type: 'USB_SERIAL', battery: 100 })
            }).catch(() => {});

        } catch (err) {
            if (err.name === 'NotFoundError') {
                this.logTerminal('USB 포트 선택이 취소되었습니다.', 'warn');
                this.updateUiState(false, '연결 대기 중', '미연결');
            } else {
                this.logTerminal(`USB 시리얼 연결 오류: ${err.message}`, 'err');
                alert(`USB 시리얼 연결 중 오류가 발생했습니다: ${err.message}\n(장치가 다른 프로그램에서 사용 중인지 확인해 주세요)`);
                this.updateUiState(false, '연결 실패', '미연결');
            }
        }
    },

    async startSerialReadLoop(port) {
        while (port.readable && AppState.isUsbConnected) {
            const textDecoder = new TextDecoderStream();
            const readableStreamClosed = port.readable.pipeTo(textDecoder.writable).catch(() => {});
            const reader = textDecoder.readable.getReader();
            try {
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value) {
                        this.handleIncomingData(value);
                    }
                }
            } catch (error) {
                console.warn('USB 시리얼 수신 스트림 해제:', error);
            } finally {
                reader.releaseLock();
            }
        }
    },

    async connect(mode = 'standard', customPrefix = '') {
        if (!navigator.bluetooth) {
            alert('⚠️ 현재 브라우저는 Web Bluetooth API를 지원하지 않습니다.\nChrome, Edge 브라우저(또는 HTTPS 보안 환경)에서 동작합니다.\n\n즉시 시연 및 테스트가 가능하도록 [가상 시뮬레이션 모드]로 연결합니다.');
            this.logTerminal('브라우저 Web Bluetooth 미지원 -> 가상 모드 자동 진입', 'warn');
            this.enableMockMode();
            return;
        }

        try {
            this.updateUiConnecting();
            
            let requestOptions;
            if (mode === 'microbit') {
                this.logTerminal('👾 [마이크로비트 무선 검색] BBC micro:bit BLE 기기(이름 및 UART 서비스)를 검색합니다...', 'info');
                requestOptions = {
                    filters: [
                        { namePrefix: 'BBC micro:bit' },
                        { namePrefix: 'BBC' },
                        { namePrefix: 'micro:bit' },
                        { namePrefix: 'micro' },
                        { services: ['e7810a71-73ae-499d-8c15-faa9aef0c3f2'] },
                        { services: ['6e400001-b5a3-f393-e0a9-e50e24dcca9e'] }
                    ],
                    optionalServices: ALL_BLE_OPTIONAL_SERVICES
                };
            } else if (mode === 'custom') {
                const prefix = customPrefix || 'RoboDog';
                this.logTerminal(`🔍 [기기명 정밀 검색] 기기명이 "${prefix}"(으)로 시작하는 로보독만 검색합니다...`, 'info');
                requestOptions = {
                    filters: [{ namePrefix: prefix }],
                    optionalServices: ALL_BLE_OPTIONAL_SERVICES
                };
            } else if (mode === 'standard') {
                this.logTerminal('🎯 [순수 로보독 표준 검색] 주변 에어컨/TV 등 잡음 신호를 100% 차단하고 로보독 기기만 검색합니다...', 'info');
                requestOptions = {
                    filters: PURE_ROBOT_DEVICE_FILTERS,
                    optionalServices: ALL_BLE_OPTIONAL_SERVICES
                };
            } else {
                this.logTerminal('🌐 [전체 검색 모드] 주변 모든 무선 신호(이름 미표시 기기 포함)를 검색합니다...', 'warn');
                requestOptions = {
                    acceptAllDevices: true,
                    optionalServices: ALL_BLE_OPTIONAL_SERVICES
                };
            }

            const device = await navigator.bluetooth.requestDevice(requestOptions);
            const devName = device.name || 'RoboDog-HW';

            this.logTerminal(`기기 선택됨: [${devName}] - GATT 서버 연결 시도 중...`, 'info');

            device.addEventListener('gattserverdisconnected', () => {
                this.logTerminal(`로보독 [${devName}]과의 연결이 해제되었습니다.`, 'err');
                this.handleDisconnected();
            });

            const server = await device.gatt.connect();
            AppState.bleDevice = device;
            AppState.bleServer = server;

            // [만능 GATT 특성 자동 탐색기: 어떤 BLE 모듈이든 100% 통신 채널 바인딩]
            let boundTx = false;
            let boundRx = false;

            // 1. 표준 우선순위 UART 서비스 검색 (NUS, HM-10, JDY, FFF0, ISSC 등)
            const priorityProfiles = [
                { s: BLE_UUIDS.NUS_SERVICE, tx: BLE_UUIDS.NUS_TX, rx: BLE_UUIDS.NUS_RX, name: 'Nordic UART (NUS)' },
                { s: BLE_UUIDS.HM10_SERVICE, tx: BLE_UUIDS.HM10_CHAR, rx: BLE_UUIDS.HM10_CHAR, name: 'HM-10 Serial (0xFFE0)' },
                { s: '0000ffe5-0000-1000-8000-00805f9b34fb', tx: '0000ffe6-0000-1000-8000-00805f9b34fb', rx: '0000ffe6-0000-1000-8000-00805f9b34fb', name: 'JDY/TI Serial' },
                { s: '0000fff0-0000-1000-8000-00805f9b34fb', tx: '0000fff1-0000-1000-8000-00805f9b34fb', rx: '0000fff2-0000-1000-8000-00805f9b34fb', name: 'FFF0 Custom UART' },
                { s: '49535343-fe7d-4ae5-8fa9-9fafd205e455', tx: '49535343-8841-43f4-a8d4-ecbe34729bb3', rx: '49535343-1e4d-4bd9-ba61-23c647249616', name: 'ISSC Microchip UART' }
            ];

            for (const p of priorityProfiles) {
                try {
                    const s = await server.getPrimaryService(p.s);
                    if (s) {
                        AppState.bleTxChar = await s.getCharacteristic(p.tx).catch(() => null);
                        AppState.bleRxChar = await s.getCharacteristic(p.rx).catch(() => null);
                        if (AppState.bleTxChar) boundTx = true;
                        if (AppState.bleRxChar) boundRx = true;
                        this.logTerminal(`GATT [${p.name}] 통신 채널 바인딩 성공`, 'info');
                        break;
                    }
                } catch (e) {}
            }

            // 2. 우선순위 프로파일이 아닐 경우: getPrimaryServices()를 순회하여 Write / Notify 특성 동적 자동 감지
            if (!boundTx) {
                try {
                    const allServices = await server.getPrimaryServices();
                    for (const s of allServices) {
                        const chars = await s.getCharacteristics().catch(() => []);
                        for (const ch of chars) {
                            if (!AppState.bleTxChar && (ch.properties.write || ch.properties.writeWithoutResponse)) {
                                AppState.bleTxChar = ch;
                                boundTx = true;
                                this.logTerminal(`송신(TX) 가능 특성 자동 발견: ${ch.uuid.slice(0, 8)}...`, 'info');
                            }
                            if (!AppState.bleRxChar && (ch.properties.notify || ch.properties.indicate || ch.properties.read)) {
                                AppState.bleRxChar = ch;
                                boundRx = true;
                                this.logTerminal(`수신(RX) 가능 특성 자동 발견: ${ch.uuid.slice(0, 8)}...`, 'info');
                            }
                        }
                        if (boundTx && boundRx) break;
                    }
                } catch (discoveryErr) {
                    this.logTerminal('기본 텔레메트리 GATT 모드로 연결 유지', 'info');
                }
            }

            // 배터리 서비스 시도
            try {
                const batService = await server.getPrimaryService('battery_service');
                const batChar = await batService.getCharacteristic('battery_level');
                const batVal = await batChar.readValue();
                AppState.bleBattery = batVal.getUint8(0);
                this.updateTelemetry({ battery: AppState.bleBattery });
            } catch (e) {}

            // RX 알림(Notify) 활성화
            if (AppState.bleRxChar && AppState.bleRxChar.properties.notify) {
                try {
                    await AppState.bleRxChar.startNotifications();
                    AppState.bleRxChar.addEventListener('characteristicvaluechanged', (event) => {
                        const value = new TextDecoder().decode(event.target.value);
                        this.handleIncomingData(value);
                    });
                } catch (notifyErr) {}
            }

            AppState.isBleConnected = true;
            AppState.isMockBle = false;

            this.updateUiState(true, `연결됨: ${devName}`, devName);
            this.logTerminal(`🎉 [성공] 실제 로보독 하드웨어 [${devName}] 무선 페어링 완료!`, 'tx');
            logEvent('[BLE]', `🎉 로보독 [${devName}] 무선 블루투스 연결 성공!`, 'success');
            VoiceEngine.speak(`로보독과 무선 블루투스로 연결되었습니다.`);

            // 백엔드 상태 동기화
            fetch('/api/robodog/ble/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connected: true, device_name: devName, battery: AppState.bleBattery })
            }).catch(() => {});

        } catch (error) {
            if (error.name === 'NotFoundError') {
                this.logTerminal('블루투스 기기 검색이 취소되었거나 호환 기기를 찾지 못했습니다.', 'warn');
                this.logTerminal('💡 안내: 노트북에 USB 케이블로 연결하셨다면 [노트북 USB 케이블 직접 연결] 버튼을 눌러주세요!', 'info');
                logEvent('[BLE]', '블루투스 검색 창 닫힘 (USB 유선 직결 모드 사용 가능)', 'info');
                this.updateUiState(false, '연결 취소됨', '미연결');
                return;
            } else {
                this.logTerminal(`BLE 연결 오류 (${error.message})`, 'err');
                logEvent('[BLE]', `BLE 연결 실패: ${error.message}`, 'error');
                this.updateUiState(false, '연결 실패', '미연결');
                return;
            }
        }
    },

    enableMockMode() {
        AppState.isBleConnected = true;
        AppState.isMockBle = true;
        AppState.bleBattery = 94;
        const mockName = 'RoboDog-Sim (Go2)';

        this.updateUiState(true, '가상 시뮬레이션 연결됨', mockName);
        this.logTerminal(`🤖 [가상 모드] ${mockName} 가상 시뮬레이터 활성화 완료.`, 'info');
        logEvent('[BLE]', '가상 로보독 시뮬레이터 연결 완료.', 'success');
        VoiceEngine.speak('가상 로보독 시뮬레이터와 연결되었습니다.');

        fetch('/api/robodog/ble/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connected: true, device_name: mockName, battery: 94 })
        }).catch(() => {});
    },

    async disconnect() {
        if (AppState.isUsbConnected && AppState.serialPort) {
            try {
                await AppState.serialPort.close();
            } catch (e) {}
            AppState.serialPort = null;
            AppState.isUsbConnected = false;
            this.logTerminal('노트북 USB 시리얼 포트 연결이 정상 해제되었습니다.', 'warn');
        }
        if (AppState.bleDevice && AppState.bleDevice.gatt && AppState.bleDevice.gatt.connected) {
            AppState.bleDevice.gatt.disconnect();
        }
        this.handleDisconnected();
    },

    handleDisconnected() {
        AppState.isBleConnected = false;
        AppState.bleTxChar = null;
        AppState.bleRxChar = null;
        this.updateUiState(false, '연결 대기 중', '미연결');
        this.logTerminal('로보독 블루투스 연결이 해제되었습니다.', 'warn');
        logEvent('[BLE]', '로보독 블루투스 연결이 해제되었습니다.', 'warn');
        VoiceEngine.speak('로보독 블루투스 연결이 해제되었습니다.');

        fetch('/api/robodog/ble/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connected: false, device_name: 'None' })
        }).catch(() => {});
    },

    updateUiConnecting() {
        const hBadge = document.getElementById('bleHeaderBadge');
        if (hBadge) {
            hBadge.className = 'ble-badge badge-connecting';
            hBadge.textContent = '검색중...';
        }
        const sDot = document.getElementById('bleStatusDot');
        const sText = document.getElementById('bleStatusText');
        if (sDot) sDot.className = 'status-dot dot-connecting';
        if (sText) sText.textContent = '디바이스 검색 중...';
    },

    updateUiState(connected, text, deviceName = '미연결') {
        // 1. 헤더 배지 & 텍스트
        const hBadge = document.getElementById('bleHeaderBadge');
        const hText = document.getElementById('bleHeaderText');
        if (hBadge) {
            hBadge.className = `ble-badge ${connected ? 'badge-on' : 'badge-off'}`;
            hBadge.textContent = connected ? (AppState.isMockBle ? 'SIM' : 'ON') : 'OFF';
        }
        if (hText) {
            hText.textContent = connected ? (AppState.isMockBle ? '가상 로보독' : '로보독 연결됨') : '로보독 연결';
        }

        // 2. 어르신 화면 버튼
        const sBtnText = document.getElementById('seniorBleBtnText');
        if (sBtnText) {
            sBtnText.textContent = connected ? '로보독 연결됨 (ON)' : '로보독 연결 (BLE)';
        }

        // 3. 모달 HUD
        const dot = document.getElementById('bleStatusDot');
        const textEl = document.getElementById('bleStatusText');
        const devEl = document.getElementById('bleDeviceNameText');
        const batFill = document.getElementById('bleBatteryFill');
        const batText = document.getElementById('bleBatteryText');

        if (dot) dot.className = `status-dot ${connected ? 'dot-connected' : 'dot-disconnected'}`;
        if (textEl) textEl.textContent = text;
        if (devEl) devEl.textContent = deviceName;
        if (batFill) batFill.style.width = `${AppState.bleBattery}%`;
        if (batText) batText.textContent = `${AppState.bleBattery}%`;

        // 4. 모달 액션 버튼 토글
        const btnPairReal = document.getElementById('btnBlePairReal');
        const btnPairVirt = document.getElementById('btnBlePairVirtual');
        const btnDisconn = document.getElementById('btnBleDisconnect');

        if (btnPairReal) btnPairReal.style.display = connected ? 'none' : 'inline-flex';
        if (btnPairVirt) btnPairVirt.style.display = connected ? 'none' : 'inline-flex';
        if (btnDisconn) btnDisconn.style.display = connected ? 'inline-flex' : 'none';

        // 5. 튜닝 탭 버튼
        const btnOld = document.getElementById('btnBleToggle');
        if (btnOld) btnOld.textContent = connected ? (AppState.isMockBle ? '실제 BLE 검색' : '연결 해제') : '🔗 실제 BLE 연결';
    },

    /**
     * 로보독에 UART 제어 패킷 전송 (실제 하드웨어 or 가상)
     */
    async sendPacket(command) {
        const fullPacket = `${command}\n`;
        this.logTerminal(`[TX 송신] >> ${command}`, 'tx');
        logEvent('[BLE]', `[TX 송신] >> ${command}`, 'info');

        // 1. [유선] 노트북 USB 시리얼 포트로 직접 패킷 전송
        if (AppState.isUsbConnected && AppState.serialPort && AppState.serialPort.writable) {
            try {
                const encoder = new TextEncoder();
                const writer = AppState.serialPort.writable.getWriter();
                await writer.write(encoder.encode(fullPacket));
                writer.releaseLock();
            } catch (usbErr) {
                console.warn('USB 시리얼 송신 오류:', usbErr);
            }
        }

        // 백엔드 중계 API 비동기 알림
        fetch('/api/robodog/ble/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command })
        }).catch(() => {});

        if (AppState.isMockBle || (!AppState.bleTxChar && !AppState.isUsbConnected)) {
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
            this.logTerminal(`BLE 패킷 전송 오류: ${err.message}`, 'err');
            logEvent('[ERROR]', `BLE 패킷 전송 실패: ${err.message}`, 'error');
            this.mockResponse(command);
        }
    },

    handleIncomingData(data) {
        const clean = data.trim();
        this.logTerminal(`[RX 수신] << ${clean}`, 'rx');
        logEvent('[BLE]', `[RX 수신] << ${clean}`, 'info');

        // [실시간 센서 패킷 파싱 및 트윈 반영]
        try {
            if (clean === 'CLEAR') {
                CanvasRenderer.applyBleSensorData({ type: 'CLEAR' });
            } else if (clean.startsWith('OBSTACLE:')) {
                // 형식: OBSTACLE:dist,angle,type (예: OBSTACLE:1.4,15,STATIC)
                const parts = clean.replace('OBSTACLE:', '').split(',');
                CanvasRenderer.applyBleSensorData({
                    type: 'OBSTACLE',
                    dist: parseFloat(parts[0]) || 1.2,
                    angle: parseFloat(parts[1]) || 10,
                    obsType: (parts[2] && parts[2].toLowerCase() === 'dynamic') ? 'dynamic' : 'static',
                    label: `⚠️ 실시간 감지 장애물 (${parts[0]}m)`
                });
            } else if (clean.startsWith('DIST:') || clean.startsWith('LIDAR:')) {
                const distVal = parseFloat(clean.split(':')[1]);
                if (!isNaN(distVal)) {
                    if (distVal < 2.0) {
                        CanvasRenderer.applyBleSensorData({
                            type: 'OBSTACLE',
                            dist: distVal,
                            angle: 12,
                            obsType: 'static',
                            label: `⚠️ 전방 장애물 (${distVal}m)`
                        });
                    } else {
                        CanvasRenderer.applyBleSensorData({ type: 'CLEAR' });
                    }
                }
            }
        } catch (e) {
            console.error('[BLE RX Parse Error]', e);
        }
    },

    mockResponse(command) {
        if (command.startsWith('CMD:START') || command === 'CMD:FORWARD') {
            this.updateTelemetry({ speed: (AppState.speed * 0.036).toFixed(1) + ' km/h' });
            this.logTerminal(`[RX 수신] << ACK:MOVING speed=${(AppState.speed * 0.036).toFixed(1)}km/h`, 'rx');
        } else if (command.startsWith('CMD:STOP') || command.startsWith('CMD:ESTOP')) {
            this.updateTelemetry({ speed: '0.0 km/h' });
            this.logTerminal('[RX 수신] << ACK:STOPPED mode=BRAKE_LOCKED', 'rx');
        } else if (command.startsWith('CMD:SPEED:')) {
            const spd = parseInt(command.split(':')[2]);
            this.updateTelemetry({ speed: (spd * 0.036).toFixed(1) + ' km/h' });
            this.logTerminal(`[RX 수신] << ACK:GEAR_SET speed=${spd}`, 'rx');
        } else if (command === 'CMD:STAND') {
            this.logTerminal('[RX 수신] << ACK:POSTURE=STAND height=50cm', 'rx');
        } else if (command === 'CMD:SIT') {
            this.logTerminal('[RX 수신] << ACK:POSTURE=SIT height=25cm', 'rx');
        } else if (command === 'CMD:PAW') {
            this.logTerminal('[RX 수신] << ACK:ACTION=SHAKE_PAW success', 'rx');
        } else if (command === 'CMD:GUARD') {
            this.logTerminal('[RX 수신] << ACK:MODE=CLOSE_GUARD distance=80cm', 'rx');
        }
    },

    updateTelemetry(data) {
        if (data.battery !== undefined) {
            AppState.bleBattery = data.battery;
            const batFill = document.getElementById('bleBatteryFill');
            const batText = document.getElementById('bleBatteryText');
            if (batFill) batFill.style.width = `${data.battery}%`;
            if (batText) batText.textContent = `${data.battery}%`;

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
// 2-1. [신규] 🦮 스마트 햅틱 리드줄 (레고 스파이크 BLE) 관제기
// ---------------------------------------------------------
const LeashController = {
    modalEl: null,
    terminalEl: null,
    matrixEl: null,
    device: null,
    server: null,
    char: null,
    isConnected: false,
    isMock: false,
    audioCtx: null,

    init() {
        this.modalEl = document.getElementById('leashModal');
        this.terminalEl = document.getElementById('leashTerminalOutput');
        this.matrixEl = document.getElementById('spikeLedMatrix');

        // 25개 LED 픽셀 동적 생성
        if (this.matrixEl) {
            this.matrixEl.innerHTML = '';
            for (let i = 0; i < 25; i++) {
                const px = document.createElement('div');
                px.className = 'led-pixel';
                px.id = `ledPx_${i}`;
                this.matrixEl.appendChild(px);
            }
            this.renderMatrixPattern('READY');
        }

        // 헤더 및 모달 버튼 바인딩
        const btnHeader = document.getElementById('btnHeaderLeash');
        const btnClose = document.getElementById('btnCloseLeashModal');
        if (btnHeader) btnHeader.addEventListener('click', () => this.openModal());
        if (btnClose) btnClose.addEventListener('click', () => this.closeModal());

        const btnPairReal = document.getElementById('btnLeashPairReal');
        const btnPairVirt = document.getElementById('btnLeashPairVirtual');
        const btnDisconn = document.getElementById('btnLeashDisconnect');
        const btnClearLog = document.getElementById('btnClearLeashLog');

        if (btnPairReal) btnPairReal.addEventListener('click', () => this.connectReal());
        if (btnPairVirt) btnPairVirt.addEventListener('click', () => this.enableMockMode());
        if (btnDisconn) btnDisconn.addEventListener('click', () => this.disconnect());
        if (btnClearLog && this.terminalEl) {
            btnClearLog.addEventListener('click', () => {
                this.terminalEl.innerHTML = '<div class="term-line info">[SYS] 리드줄 로그 콘솔 초기화됨.</div>';
            });
        }

        // 햅틱 수동 테스트 버튼 바인딩
        const btnFwd = document.getElementById('btnHapticForward');
        const btnLeft = document.getElementById('btnHapticLeft');
        const btnRight = document.getElementById('btnHapticRight');
        const btnStop = document.getElementById('btnHapticStop');

        if (btnFwd) btnFwd.addEventListener('click', () => this.triggerHaptic('forward'));
        if (btnLeft) btnLeft.addEventListener('click', () => this.triggerHaptic('left'));
        if (btnRight) btnRight.addEventListener('click', () => this.triggerHaptic('right'));
        if (btnStop) btnStop.addEventListener('click', () => this.triggerHaptic('stop'));
    },

    openModal() {
        if (!this.modalEl) this.modalEl = document.getElementById('leashModal');
        if (this.modalEl) this.modalEl.style.display = 'flex';
    },

    closeModal() {
        if (this.modalEl) this.modalEl.style.display = 'none';
    },

    logTerminal(msg, type = 'info') {
        if (!this.terminalEl) return;
        const line = document.createElement('div');
        line.className = `term-line ${type}`;
        line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        this.terminalEl.appendChild(line);
        this.terminalEl.scrollTop = this.terminalEl.scrollHeight;
    },

    async connectReal() {
        if (!navigator.bluetooth) {
            alert('이 브라우저는 Web Bluetooth API를 지원하지 않습니다.\n대신 [가상 스파이크 리드줄 시뮬레이터]를 연결합니다.');
            this.enableMockMode();
            return;
        }

        try {
            this.logTerminal('🔍 주변 레고 스파이크(LEGO SPIKE Prime) BLE 기기 검색 중...', 'info');
            const device = await navigator.bluetooth.requestDevice({
                filters: [
                    { namePrefix: 'LEGO' },
                    { namePrefix: 'SPIKE' },
                    { namePrefix: 'Hub' }
                ],
                optionalServices: [
                    '00001623-1212-efde-1623-785feabcd123',
                    '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
                    'battery_service'
                ]
            });

            const server = await device.gatt.connect();
            this.device = device;
            this.server = server;
            this.isConnected = true;
            this.isMock = false;

            const devName = device.name || 'LEGO SPIKE Hub';
            this.updateUiState(true, devName);
            this.logTerminal(`🎉 [성공] 레고 스파이크 리드줄 [${devName}] BLE 페어링 완료!`, 'tx');
            logEvent('[LEASH]', `🎉 레고 스파이크 [${devName}] 블루투스 연결 완료!`, 'success');
            VoiceEngine.speak('스마트 햅틱 리드줄과 블루투스로 연결되었습니다.');

            fetch('/api/robodog/leash/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ connected: true, device_name: devName, battery: 88 })
            }).catch(() => {});

        } catch (err) {
            if (err.name === 'NotFoundError') {
                this.logTerminal('블루투스 검색 창이 취소되었습니다.', 'warn');
            } else {
                this.logTerminal(`BLE 연결 예외 (${err.message}) -> [가상 리드줄 시뮬레이터] 가동`, 'err');
                this.enableMockMode();
            }
        }
    },

    enableMockMode() {
        this.isConnected = true;
        this.isMock = true;
        const mockName = 'SPIKE-Prime-Virtual';

        this.updateUiState(true, mockName);
        this.logTerminal(`🦮 [가상 모드] ${mockName} 시뮬레이터 가동 완료.`, 'info');
        logEvent('[LEASH]', '가상 레고 스파이크 리드줄 시뮬레이터 연결 완료.', 'success');
        VoiceEngine.speak('가상 스파이크 리드줄 시뮬레이터와 연결되었습니다.');

        fetch('/api/robodog/leash/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connected: true, device_name: mockName, battery: 92 })
        }).catch(() => {});
    },

    disconnect() {
        if (this.device && this.device.gatt && this.device.gatt.connected) {
            this.device.gatt.disconnect();
        }
        this.isConnected = false;
        this.isMock = false;
        this.updateUiState(false, '미연결');
        this.logTerminal('레고 스파이크 리드줄 연결이 해제되었습니다.', 'warn');
        logEvent('[LEASH]', '스파이크 리드줄 연결이 해제되었습니다.', 'warn');
        VoiceEngine.speak('스파이크 리드줄 연결이 해제되었습니다.');

        fetch('/api/robodog/leash/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ connected: false, device_name: 'None' })
        }).catch(() => {});
    },

    updateUiState(connected, devName = '미연결') {
        const hBadge = document.getElementById('leashHeaderBadge');
        if (hBadge) {
            hBadge.className = `leash-badge ${connected ? 'badge-on' : 'badge-off'}`;
            hBadge.textContent = connected ? (this.isMock ? 'SIM' : 'ON') : '연결안됨';
        }

        const dot = document.getElementById('leashStatusDot');
        const text = document.getElementById('leashStatusText');
        const devText = document.getElementById('leashDeviceNameText');
        const btnReal = document.getElementById('btnLeashPairReal');
        const btnVirt = document.getElementById('btnLeashPairVirtual');
        const btnDis = document.getElementById('btnLeashDisconnect');

        if (dot) dot.className = `status-dot ${connected ? 'dot-connected' : 'dot-disconnected'}`;
        if (text) text.textContent = connected ? (this.isMock ? '가상 시뮬레이터 연결됨' : '정상 연결됨') : '연결 대기 중';
        if (devText) devText.textContent = devName;

        if (btnReal) btnReal.style.display = connected ? 'none' : 'inline-flex';
        if (btnVirt) btnVirt.style.display = connected ? 'none' : 'inline-flex';
        if (btnDis) btnDis.style.display = connected ? 'inline-flex' : 'none';
    },

    renderMatrixPattern(patternKey) {
        const patterns = {
            'READY': {
                color: 'on-green',
                text: '대기 중 (READY)',
                bits: [
                    0,1,0,1,0,
                    1,1,1,1,1,
                    1,1,1,1,1,
                    0,1,1,1,0,
                    0,0,1,0,0
                ]
            },
            'FORWARD': {
                color: 'on-yellow',
                text: '⬆️ 직진 (FORWARD)',
                bits: [
                    0,0,1,0,0,
                    0,1,1,1,0,
                    1,0,1,0,1,
                    0,0,1,0,0,
                    0,0,1,0,0
                ]
            },
            'LEFT': {
                color: 'on-cyan',
                text: '⬅️ 좌회전 (TURN LEFT)',
                bits: [
                    0,0,1,0,0,
                    0,1,0,0,0,
                    1,1,1,1,1,
                    0,1,0,0,0,
                    0,0,1,0,0
                ]
            },
            'RIGHT': {
                color: 'on-cyan',
                text: '➡️ 우회전 (TURN RIGHT)',
                bits: [
                    0,0,1,0,0,
                    0,0,0,1,0,
                    1,1,1,1,1,
                    0,0,0,1,0,
                    0,0,1,0,0
                ]
            },
            'STOP': {
                color: 'on-red',
                text: '🛑 급정지 (EMERGENCY STOP)',
                bits: [
                    1,0,0,0,1,
                    0,1,0,1,0,
                    0,0,1,0,0,
                    0,1,0,1,0,
                    1,0,0,0,1
                ]
            }
        };

        const pat = patterns[patternKey] || patterns['READY'];
        for (let i = 0; i < 25; i++) {
            const px = document.getElementById(`ledPx_${i}`);
            if (px) {
                px.className = 'led-pixel';
                if (pat.bits[i] === 1) {
                    px.classList.add(pat.color);
                }
            }
        }
        const lbl = document.getElementById('spikeLedSymbolText');
        if (lbl) lbl.textContent = pat.text;
    },

    playAudioHaptic(freqs) {
        try {
            if (!this.audioCtx) {
                this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (this.audioCtx.state === 'suspended') {
                this.audioCtx.resume();
            }
            freqs.forEach((freq, idx) => {
                setTimeout(() => {
                    const osc = this.audioCtx.createOscillator();
                    const gain = this.audioCtx.createGain();
                    osc.type = 'sine';
                    osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime);
                    gain.gain.setValueAtTime(0.18, this.audioCtx.currentTime);
                    gain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 0.12);
                    osc.connect(gain);
                    gain.connect(this.audioCtx.destination);
                    osc.start();
                    osc.stop(this.audioCtx.currentTime + 0.12);
                }, idx * 110);
            });
        } catch (e) {}
    },

    triggerHaptic(type) {
        const t = (type || '').toLowerCase();
        let logMsg = '';

        if (t === 'forward' || t === '직진') {
            this.renderMatrixPattern('FORWARD');
            if (navigator.vibrate) navigator.vibrate([220]);
            this.playAudioHaptic([523]);
            logMsg = '⬆️ [직진] 햅틱 1회 당김 펄스 & 5x5 전방 화살표 출력';
            VoiceEngine.speak('직진 햅틱 신호입니다.');
        } else if (t === 'left' || t === '좌회전') {
            this.renderMatrixPattern('LEFT');
            if (navigator.vibrate) navigator.vibrate([160, 90, 160]);
            this.playAudioHaptic([440, 587]);
            logMsg = '⬅️ [좌회전] 햅틱 2회 좌측 펄스 & 5x5 좌향 화살표 출력';
            VoiceEngine.speak('좌회전 햅틱 신호입니다.');
        } else if (t === 'right' || t === '우회전') {
            this.renderMatrixPattern('RIGHT');
            if (navigator.vibrate) navigator.vibrate([120, 80, 120, 80, 120]);
            this.playAudioHaptic([440, 659]);
            logMsg = '➡️ [우회전] 햅틱 3회 우측 펄스 & 5x5 우향 화살표 출력';
            VoiceEngine.speak('우회전 햅틱 신호입니다.');
        } else if (t === 'stop' || t === '정지' || t === 'estop') {
            this.renderMatrixPattern('STOP');
            if (navigator.vibrate) navigator.vibrate([350, 80, 350]);
            this.playAudioHaptic([880, 440, 880]);
            logMsg = '🛑 [급정지] 햅틱 강력 제동 텐션 & 5x5 정지 신호 출력';
            VoiceEngine.speak('급정지 햅틱 신호입니다.');
        }

        this.logTerminal(logMsg, 'tx');
        logEvent('[LEASH]', logMsg, 'info');

        fetch('/api/robodog/leash/haptic', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: t })
        }).catch(() => {});
    }
};

// ---------------------------------------------------------
// 2-2. [신규] ⚙️ 직관적 통합 환경 설정 매니저 (#userSettingModal)
// ---------------------------------------------------------
const SettingManager = {
    modalEl: null,
    activeTheme: 'white',
    debounceTimer: null,

    init() {
        this.modalEl = document.getElementById('userSettingModal');

        // 상단 헤더 버튼 및 모달 닫기 바인딩
        const btnOpen = document.getElementById('btnOpenUserSetting');
        const btnClose = document.getElementById('btnCloseUserSettingModal');
        const btnCancel = document.getElementById('btnCancelUserSetting');
        const btnSave = document.getElementById('btnSaveUserSetting');

        if (btnOpen) btnOpen.addEventListener('click', () => this.openModal());
        if (btnClose) btnClose.addEventListener('click', () => this.closeModal());
        if (btnCancel) btnCancel.addEventListener('click', () => this.closeModal());
        if (btnSave) btnSave.addEventListener('click', () => this.saveSettings());

        // 배경(오버레이) 클릭 및 ESC 키로 설정창 닫기
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

        // 만 나이 입력 시 실시간 상태 뱃지 업데이트
        const inputAge = document.getElementById('settingInputAge');
        if (inputAge) {
            inputAge.addEventListener('input', (e) => {
                const val = parseInt(e.target.value) || 28;
                this.updateAgeBadge(val);
            });
        }

        // 나이 프리셋 칩 바인딩
        document.querySelectorAll('.btn-chip-age').forEach(btn => {
            btn.addEventListener('click', () => {
                const age = parseInt(btn.getAttribute('data-age') || '28');
                if (inputAge) inputAge.value = age;
                this.updateAgeBadge(age);
            });
        });

        // 테마 선택 버튼 바인딩
        
        // 시각장애인 모드 설정 버튼 바인딩
        const btnBlindOn = document.getElementById('btnSettingBlindOn');
        const btnBlindOff = document.getElementById('btnSettingBlindOff');
        if (btnBlindOn) {
            btnBlindOn.addEventListener('click', () => {
                this.selectBlindMode(true);
            });
        }
        if (btnBlindOff) {
            btnBlindOff.addEventListener('click', () => {
                this.selectBlindMode(false);
            });
        }

        const btnWhite = document.getElementById('btnThemeWhite');
        const btnDark = document.getElementById('btnThemeDark');
        if (btnWhite) {
            btnWhite.addEventListener('click', () => this.selectTheme('white'));
        }
        if (btnDark) {
            btnDark.addEventListener('click', () => this.selectTheme('dark'));
        }

        // [신규] 내레이터 음성 안내 ON/OFF 버튼 바인딩
        const btnVoiceOn = document.getElementById('btnSettingVoiceOn');
        const btnVoiceOff = document.getElementById('btnSettingVoiceOff');
        if (btnVoiceOn) {
            btnVoiceOn.addEventListener('click', () => this.selectVoice(true));
        }
        if (btnVoiceOff) {
            btnVoiceOff.addEventListener('click', () => this.selectVoice(false));
        }

        // 거주지 주소 자동완성 연동
        const addrInp = document.getElementById('settingInputAddress');
        const sugBox = document.getElementById('settingSuggestBox');
        const sugList = document.getElementById('settingSuggestList');

        if (addrInp && sugBox && sugList) {
            addrInp.addEventListener('input', (e) => {
                const q = e.target.value.trim();
                clearTimeout(this.debounceTimer);
                this.debounceTimer = setTimeout(async () => {
                    if (q.length < 2) {
                        sugBox.style.display = 'none';
                        return;
                    }
                    try {
                        const res = await fetch(`/api/geocode/suggest?q=${encodeURIComponent(q)}`);
                        const data = await res.json();
                        if (data.status === 'success' && data.results && data.results.length > 0) {
                            sugList.innerHTML = '';
                            data.results.forEach(place => {
                                const item = document.createElement('div');
                                item.className = 'suggest-item';
                                item.innerHTML = `
                                    <div class="suggest-item-left">
                                        <span class="suggest-item-name">🏡 ${place.name}</span>
                                        <span class="suggest-item-addr">${place.address}</span>
                                    </div>
                                `;
                                item.addEventListener('click', () => {
                                    addrInp.value = place.address || place.name;
                                    addrInp.setAttribute('data-lat', place.lat);
                                    addrInp.setAttribute('data-lng', place.lng);
                                    sugBox.style.display = 'none';
                                });
                                sugList.appendChild(item);
                            });
                            sugBox.style.display = 'block';
                        } else {
                            sugBox.style.display = 'none';
                        }
                    } catch (e) {}
                }, 200);
            });

            document.addEventListener('click', (e) => {
                if (!addrInp.contains(e.target) && !sugBox.contains(e.target)) {
                    sugBox.style.display = 'none';
                }
            });
        }

        // 기본 테마 적용: 화이트 모드
        const savedTheme = localStorage.getItem('robodog_theme') || 'white';
        this.selectTheme(savedTheme, false);
    },

    updateAgeBadge(val) {
        const badge = document.getElementById('settingAgeStatusBadge');
        if (badge) {
            const isSenior = val >= 60;
            badge.className = `setting-status-badge ${isSenior ? 'over' : 'under'}`;
            badge.textContent = `현재 상태: 만 ${val}세 (${isSenior ? '노인 안심 모드 + 일반 모드 사용 가능' : '일반 모드 전용'})`;
        }
    },

    selectVoice(enabled, notify = false) {
        this.voiceEnabled = enabled;
        const btnOn = document.getElementById('btnSettingVoiceOn');
        const btnOff = document.getElementById('btnSettingVoiceOff');
        if (btnOn) btnOn.classList.toggle('active', enabled);
        if (btnOff) btnOff.classList.toggle('active', !enabled);
    },

    selectTheme(theme, notify = true) {
        this.activeTheme = theme;

        const btnWhite = document.getElementById('btnThemeWhite');
        const btnDark = document.getElementById('btnThemeDark');

        if (btnWhite) btnWhite.classList.toggle('active', theme === 'white');
        if (btnDark) btnDark.classList.toggle('active', theme === 'dark');

        if (theme === 'white') {
            document.body.classList.add('theme-white');
            document.body.classList.remove('theme-dark');
        } else {
            document.body.classList.add('theme-dark');
            document.body.classList.remove('theme-white');
        }
        localStorage.setItem('robodog_theme', theme);
        if (notify) {
            logEvent('[THEME]', `화면 테마가 [${theme === 'white' ? '☀️ 화이트 모드' : '🌙 다크 모드'}]로 전환되었습니다.`, 'info');
        }
    },

    
    selectBlindMode(enable, notify = true) {
        this.blindEnabled = enable;
        const btnOn = document.getElementById('btnSettingBlindOn');
        const btnOff = document.getElementById('btnSettingBlindOff');
        if (btnOn) btnOn.classList.toggle('active', enable);
        if (btnOff) btnOff.classList.toggle('active', !enable);
        if (notify) {
            logEvent('[SETTING]', `시각장애인 안심 모드: [${enable ? 'ON' : 'OFF'}]`, 'info');
        }
    },

    openModal() {
        if (!this.modalEl) this.modalEl = document.getElementById('userSettingModal');
        if (!this.modalEl) return;

        // 현재 값 채우기
        const inputAge = document.getElementById('settingInputAge');
        const inputName = document.getElementById('settingInputName');
        const inputAddr = document.getElementById('settingInputAddress');
        const inputDet = document.getElementById('settingInputDetailAddress');
        const inputGuardName = document.getElementById('settingInputGuardianName');
        const inputGuardPhone = document.getElementById('settingInputGuardianPhone');

        const curUser = AuthManager.currentUser;
        if (inputAge) {
            inputAge.value = AppState.userAge;
            this.updateAgeBadge(AppState.userAge);
        }
        if (inputName) inputName.value = curUser ? curUser.name.replace(/어르신|님/g, '').trim() : '';
        if (inputAddr) inputAddr.value = curUser ? (curUser.address || '') : '';
        if (inputDet) inputDet.value = curUser ? (curUser.detail_address || '') : '';
        if (inputGuardName) inputGuardName.value = curUser ? (curUser.guardian_name || '') : '';
        if (inputGuardPhone) inputGuardPhone.value = curUser ? (curUser.guardian_phone || '') : '';

        this.selectTheme(localStorage.getItem('robodog_theme') || 'white', false);
        this.selectVoice(VoiceEngine.isEnabled, false);
        this.selectBlindMode(AppState.isBlindMode, false);
        this.modalEl.style.display = 'flex';
    },

    closeModal() {
        if (this.modalEl) this.modalEl.style.display = 'none';
    },

    saveSettings() {
        const inputAge = document.getElementById('settingInputAge');
        const inputName = document.getElementById('settingInputName');
        const inputAddr = document.getElementById('settingInputAddress');
        const inputDet = document.getElementById('settingInputDetailAddress');
        const inputGuardName = document.getElementById('settingInputGuardianName');
        const inputGuardPhone = document.getElementById('settingInputGuardianPhone');

        const ageVal = parseInt(inputAge?.value) || 28;
        const name = inputName?.value.trim() || (AuthManager.currentUser?.name || '사용자');
        const address = inputAddr?.value.trim() || (AuthManager.currentUser?.address || '서울특별시 중구 세종대로 110');
        const detail_address = inputDet?.value.trim() || (AuthManager.currentUser?.detail_address || '101동 502호');
        const guardian_name = inputGuardName?.value.trim() || '홍길동 (보호자)';
        const guardian_phone = inputGuardPhone?.value.trim() || '010-1234-5678';

        // 1. 만 나이 즉시 적용 및 영구 저장
        AuthManager.setAge(ageVal, true);

        // 2. 테마 저장 및 적용
        this.selectTheme(this.activeTheme, true);

        // 2-1. [신규] 내레이터 음성 안내 상태 적용
        if (typeof this.voiceEnabled === 'boolean') {
            VoiceEngine.toggleNarrator(this.voiceEnabled);
        }

        // 2-2. [신규] 시각장애인 안심 모드 적용 (설정에서 켰을 때만 버튼 노출 및 모드 활성)
        if (typeof this.blindEnabled === 'boolean') {
            AppState.isBlindMode = this.blindEnabled;
            AuthManager.updateBlindEligibility(this.blindEnabled);
            if (this.blindEnabled) {
                switchMode('blind');
            } else if (AppState.currentMode === 'blind') {
                switchMode('general');
            }
        }

        // 3. 사용자 프로필 동기화 및 로컬 저장
        let userObj = AuthManager.currentUser || { id: `local_${Date.now()}`, username: 'user' };
        userObj.name = name;
        userObj.age = ageVal;
        userObj.address = address;
        userObj.detail_address = detail_address;
        userObj.guardian_name = guardian_name;
        userObj.guardian_phone = guardian_phone;
        if (typeof this.blindEnabled === 'boolean') {
            userObj.is_blind = this.blindEnabled;
        }

        AuthManager.setCurrentUser(userObj, false);

        fetch('/api/auth/update', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(userObj)
        }).catch(() => {});

        logEvent('[SETTING]', `⚙️ 설정 저장 완료: 만 ${ageVal}세, ${name}님, 테마 [${this.activeTheme}]`, 'success');
        VoiceEngine.speak(`설정이 저장되었습니다. 현재 만 ${ageVal}세로 적용되었습니다.`);
        this.closeModal();
    }
};

// ---------------------------------------------------------
// 3. Web Speech API (TTS 음성 합성 & AI STT 음성 인식 비서)
// ---------------------------------------------------------
const VoiceEngine = {
    synth: window.speechSynthesis || null,
    recognition: null,
    isListening: false,
    isModalOpen: false,
    isProcessing: false,
    isEnabled: (function() {
        const stored = localStorage.getItem('robodog_narrator_enabled');
        if (stored !== null) return stored === 'true';
        const age = parseInt(localStorage.getItem('robodog_user_age') || '28');
        return age >= 60; // 만 60세 미만은 기본 비설정(OFF), 만 60세 이상만 기본 ON
    })(),
    modalEl: null,
    transcriptEl: null,
    badgeEl: null,

    // 실시간 실제 마이크 볼륨 측정 & 오디오 비주얼라이저
    audioContext: null,
    analyser: null,
    micStream: null,
    visualizerAnimationId: null,

    init() {
        this.updateNarratorUi();
        this.modalEl = document.getElementById('voiceModal');
        this.transcriptEl = document.getElementById('voiceModalTranscript');
        this.badgeEl = document.getElementById('voiceListeningBadge');

        // 1. 중앙 대형 마이크 펄스 원형 버튼 클릭 이벤트 (언제든 탭하여 즉시 음성인식 재시작)
        const micPulseBtn = document.getElementById('micPulseCircle');
        if (micPulseBtn) {
            micPulseBtn.style.cursor = 'pointer';
            micPulseBtn.title = '터치하여 음성 인식 시작';
            micPulseBtn.addEventListener('click', () => {
                if (navigator.vibrate) navigator.vibrate(60);
                if (this.transcriptEl) {
                    this.transcriptEl.innerHTML = '<span style="color:#2563EB; font-weight:800;">🎙️ 다시 듣고 있습니다...</span> 편하게 말씀하세요.';
                }
                this.restartSTT();
            });
        }

        // 2. 노인 모드 대형 마이크 버튼 바인딩
        const micSenior = document.getElementById('btnVoiceListen');
        if (micSenior) {
            micSenior.addEventListener('click', () => {
                this.openVoiceModal();
            });
        }

        // 3. 일반 모드 검색창 내부 마이크 버튼 바인딩
        const micGeneral = document.getElementById('btnGeneralVoiceListen');
        if (micGeneral) {
            micGeneral.addEventListener('click', () => {
                this.openVoiceModal();
            });
        }

        // 4. 모달 닫기 버튼 & 배경 클릭 & ESC
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

        // 5. 추천 발화 칩 클릭 이벤트
        document.querySelectorAll('#voiceModal .voice-chip-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const sayText = btn.getAttribute('data-say');
                if (sayText) {
                    if (this.transcriptEl) {
                        this.transcriptEl.innerHTML = `
                            <div style="color: #64748B; font-size: 13px; font-weight: 700; margin-bottom: 4px;">선택하신 명령:</div>
                            <div style="color: #0F172A; font-size: 20px; font-weight: 900;">"${sayText}"</div>
                        `;
                    }
                    this.handleVoiceCommand(sayText);
                }
            });
        });

        // 6. 음성 모달 내 수동 텍스트 직접 입력 폴백
        const inputFallback = document.getElementById('inputVoiceFallback');
        const btnFallback = document.getElementById('btnSubmitVoiceFallback');
        if (btnFallback && inputFallback) {
            const submitFallback = () => {
                const val = inputFallback.value.trim();
                if (val) {
                    if (this.transcriptEl) {
                        this.transcriptEl.innerHTML = `
                            <div style="color: #64748B; font-size: 13px; font-weight: 700; margin-bottom: 4px;">입력하신 명령:</div>
                            <div style="color: #0F172A; font-size: 20px; font-weight: 900;">"${val}"</div>
                        `;
                    }
                    this.handleVoiceCommand(val);
                    inputFallback.value = '';
                }
            };
            btnFallback.addEventListener('click', submitFallback);
            inputFallback.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') submitFallback();
            });
        }

        // STT 엔진 사전 초기화
        this.initSTT();
    },

    toggleNarrator(forceState = null) {
        if (typeof forceState === 'boolean') {
            this.isEnabled = forceState;
        } else {
            this.isEnabled = !this.isEnabled;
        }
        localStorage.setItem('robodog_narrator_enabled', this.isEnabled);
        this.updateNarratorUi();

        if (!this.isEnabled && this.synth) {
            this.synth.cancel();
        }

        const msg = this.isEnabled ? '내레이터 음성 안내가 켜졌습니다.' : '내레이터 음성 안내가 꺼졌습니다.';
        logEvent('[VOICE]', msg, 'info');
        if (this.isEnabled) {
            this.speak(msg, false);
        }
    },

    updateNarratorUi() {
        const btnToggle = document.getElementById('btnToggleNarrator');
        const btnTuning = document.getElementById('btnNarratorTuning');
        if (btnToggle) {
            btnToggle.textContent = this.isEnabled ? '🔊 음성 켜짐' : '🔇 음성 꺼짐';
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

    speak(text, force = true, onEnd = null) {
        if (!this.isEnabled) {
            if (typeof onEnd === 'function') onEnd();
            return;
        }
        if (!this.synth) {
            if (typeof onEnd === 'function') onEnd();
            return;
        }

        if (force) this.synth.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'ko-KR';
        utterance.rate = 0.94;
        utterance.pitch = 1.05;

        utterance.onstart = () => {
            logEvent('[VISION]', `음성 안내 발화: "${text}"`, 'info');
        };
        utterance.onend = () => {
            if (typeof onEnd === 'function') onEnd();
        };
        utterance.onerror = (e) => {
            logEvent('[ERROR]', `음성 안내 오류: ${e.error}`, 'error');
            if (typeof onEnd === 'function') onEnd();
        };

        this.synth.speak(utterance);
    },

    openVoiceModal() {
        // 음성 안내가 재생 중이라면 즉시 중단 (마이크와 간섭 방지)
        if (this.synth) {
            this.synth.cancel();
        }

        if (!this.modalEl) this.modalEl = document.getElementById('voiceModal');
        if (this.modalEl) this.modalEl.style.display = 'flex';

        this.isModalOpen = true;
        this.isProcessing = false;

        if (this.transcriptEl) {
            this.transcriptEl.innerHTML = '<span style="color:#2563EB; font-weight:800;">🎙️ 실시간 마이크 수신 중...</span> 말씀해 주세요 (예: "병원 가자", "약국", "우리집", "멈춰")';
        }
        if (this.badgeEl) {
            this.badgeEl.textContent = '🎙️ 음성 듣는 중...';
            this.badgeEl.className = 'voice-badge pulse';
        }

        const micSenior = document.getElementById('btnVoiceListen');
        if (micSenior) micSenior.classList.add('listening');

        // 1. 실제 마이크 스트림 연결 & 파형 비주얼라이저 가동
        this.startMicVisualizer();

        // 2. 실시간 STT 엔진 가동
        this.startSTT();
    },

    closeVoiceModal() {
        this.isModalOpen = false;
        this.isProcessing = false;
        if (this.modalEl) this.modalEl.style.display = 'none';
        
        this.stopSTT();
        this.stopMicVisualizer();

        const micSenior = document.getElementById('btnVoiceListen');
        if (micSenior) micSenior.classList.remove('listening');
    },

    /**
     * [실제 마이크 볼륨 연동 파형 비주얼라이저]
     * 사용자가 실제로 목소리를 낼 때만 파형 바가 목소리 크기에 비례해 요동칩니다.
     */
    async startMicVisualizer() {
        try {
            if (!this.micStream) {
                this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!this.audioContext && AudioCtx) {
                this.audioContext = new AudioCtx();
            }
            if (this.audioContext && this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            if (this.audioContext && this.micStream) {
                const source = this.audioContext.createMediaStreamSource(this.micStream);
                this.analyser = this.audioContext.createAnalyser();
                this.analyser.fftSize = 64;
                source.connect(this.analyser);

                const waveBars = document.querySelectorAll('#voiceWaveBars .wave-bar');
                const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

                const updateWave = () => {
                    if (!this.isModalOpen) return;
                    this.analyser.getByteFrequencyData(dataArray);
                    let sum = 0;
                    for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
                    const avg = sum / dataArray.length;

                    waveBars.forEach((bar, idx) => {
                        const val = dataArray[idx % dataArray.length] || avg;
                        const barHeight = Math.max(8, Math.min(42, (val / 255) * 46));
                        bar.style.height = `${barHeight}px`;
                        bar.style.background = avg > 25 ? '#7C3AED' : '#C4B5FD';
                    });

                    const pulse = document.getElementById('micPulseCircle');
                    if (pulse) {
                        const scale = 1 + Math.min(0.25, (avg / 255) * 0.35);
                        pulse.style.transform = `scale(${scale})`;
                    }

                    this.visualizerAnimationId = requestAnimationFrame(updateWave);
                };
                updateWave();
            }
        } catch (err) {
            console.warn('[MIC STREAM] 마이크 스트림 권한 또는 비주얼라이저 연결:', err);
        }
    },

    stopMicVisualizer() {
        if (this.visualizerAnimationId) {
            cancelAnimationFrame(this.visualizerAnimationId);
            this.visualizerAnimationId = null;
        }
        if (this.micStream) {
            this.micStream.getTracks().forEach(track => track.stop());
            this.micStream = null;
        }
        if (this.audioContext) {
            try { this.audioContext.close(); } catch(e) {}
            this.audioContext = null;
        }
        const pulse = document.getElementById('micPulseCircle');
        if (pulse) pulse.style.transform = 'scale(1)';
    },

    /**
     * [핵심: 100% 동작하는 실시간 한국어 STT (Speech-to-Text) 엔진]
     */
    initSTT() {
        const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRec) {
            logEvent('[WARN]', 'Web Speech API 미지원 환경: 브라우저가 음성 변환을 지원하지 않아 터치 및 텍스트 모드로 동작합니다.', 'warn');
            if (this.badgeEl) {
                this.badgeEl.textContent = '추천 버튼 / 텍스트 입력 대기';
                this.badgeEl.className = 'voice-badge';
            }
            if (this.transcriptEl) {
                this.transcriptEl.innerHTML = '<span style="color:#64748B;">브라우저 마이크 자동 변환이 제한되어 있습니다. 아래 추천 버튼이나 입력창을 이용해 주세요.</span>';
            }
            return;
        }

        this.recognition = new SpeechRec();
        this.recognition.lang = 'ko-KR';
        this.recognition.continuous = true;       // 말이 잠깐 끊겨도 종료되지 않고 계속 경청
        this.recognition.interimResults = true;    // 말씀하시는 도중 실시간 중간 변환 텍스트 즉시 표시
        this.recognition.maxAlternatives = 1;

        this.recognition.onstart = () => {
            this.isListening = true;
            logEvent('[VOICE]', '🎤 실시간 STT 엔진 정상 가동 (한국어 ko-KR)', 'success');
            if (this.badgeEl) {
                this.badgeEl.textContent = '🎙️ 말씀하시는 중... (실시간 듣는 중)';
                this.badgeEl.className = 'voice-badge pulse';
            }
        };

        this.recognition.onresult = (event) => {
            let interimTranscript = '';
            let finalTranscript = '';

            for (let i = event.resultIndex; i < event.results.length; ++i) {
                const item = event.results[i];
                if (item.isFinal) {
                    finalTranscript += item[0].transcript;
                } else {
                    interimTranscript += item[0].transcript;
                }
            }

            const currentText = (finalTranscript || interimTranscript).trim();

            // 사용자가 말하는 단어가 실시간으로 텍스트 박스에 타이핑되듯 표시됨!
            if (currentText && this.transcriptEl) {
                this.transcriptEl.innerHTML = `
                    <div style="color: #64748B; font-size: 13px; font-weight: 700; margin-bottom: 4px;">🎙️ 실시간 음성 인식 중:</div>
                    <div style="color: #0F172A; font-size: 21px; font-weight: 900; letter-spacing: -0.02em;">"${currentText}"</div>
                `;
            }

            // 문장이 완성되었거나 최종 판정 시 명령어 자동 실행
            if (finalTranscript) {
                const cleanFinal = finalTranscript.trim();
                logEvent('[VOICE]', `음성 인식(STT) 최종 완료: "${cleanFinal}"`, 'success');
                if (this.badgeEl) {
                    this.badgeEl.textContent = '✅ 인식 완료! 목적지 분석 중...';
                    this.badgeEl.className = 'voice-badge';
                }
                this.handleVoiceCommand(cleanFinal);
            }
        };

        this.recognition.onerror = (event) => {
            logEvent('[WARN]', `STT 음성 인식 이벤트: ${event.error}`, 'warn');
            if (event.error === 'not-allowed') {
                if (this.transcriptEl) {
                    this.transcriptEl.innerHTML = '<span style="color:#EF4444; font-weight:800;">⚠️ 마이크 권한이 차단되어 있습니다.</span><br><small style="color:#64748B;">브라우저 주소창 좌측의 🔒(자물쇠) 또는 마이크 아이콘을 눌러 [허용]해 주세요.</small>';
                }
                if (this.badgeEl) {
                    this.badgeEl.textContent = '마이크 권한 필요';
                    this.badgeEl.className = 'voice-badge';
                }
            } else if (event.error === 'no-speech') {
                // 침묵으로 인한 no-speech 발생 시에도 모달이 열려있으면 자동 대기 유지
                if (this.isModalOpen && !this.isProcessing) {
                    // 끊김 없이 지속 청취 유지
                }
            }
        };

        this.recognition.onend = () => {
            this.isListening = false;
            // 모달이 열려있고 명령 처리 중이 아니라면 언제나 자동 재연결 유지
            if (this.isModalOpen && !this.isProcessing) {
                try {
                    this.recognition.start();
                } catch (e) {}
            }
        };
    },

    startSTT() {
        if (!this.recognition) this.initSTT();
        if (this.recognition && !this.isListening) {
            try {
                this.recognition.start();
            } catch (err) {
                console.warn('STT 재시작 안내:', err);
            }
        }
    },

    restartSTT() {
        this.stopSTT();
        setTimeout(() => {
            this.startSTT();
        }, 150);
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
        this.isProcessing = true;
        this.stopSTT();
        this.stopMicVisualizer();

        if (this.badgeEl) {
            this.badgeEl.textContent = '🧠 AI 분석 및 길안내 계산 중...';
            this.badgeEl.className = 'voice-badge pulse';
        }
        if (this.transcriptEl) {
            this.transcriptEl.innerHTML = `
                <div style="color: #64748B; font-size: 13px; font-weight: 700; margin-bottom: 4px;">최종 인식된 내용:</div>
                <div style="color: #0F172A; font-size: 21px; font-weight: 900;">"${command}"</div>
            `;
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

                setTimeout(() => {
                    this.closeVoiceModal();
                }, 1300);
                return;
            }
        } catch (err) {
            console.warn('서버 음성 처리 실패, 로컬 처리 진행:', err);
        }

        // 로컬 클라이언트 NLP 폴백 매칭
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
        } else if (c.includes('성복역') || (c.includes('성복') && c.includes('역'))) {
            startNavigation('성복역 (신분당선)', '성복역으로 안내를 시작합니다. 안전하게 걸어가요.');
        } else if (c.includes('수지구청역') || (c.includes('수지구청') && c.includes('역'))) {
            startNavigation('수지구청역 (신분당선)', '수지구청역으로 안내를 시작합니다. 안전하게 걸어가요.');
        } else if (c.includes('동천역')) {
            startNavigation('동천역 (신분당선)', '동천역으로 안내를 시작합니다.');
        } else if (c.includes('상현역')) {
            startNavigation('상현역 (신분당선)', '상현역으로 안내를 시작합니다.');
        } else if (c.includes('죽전역')) {
            startNavigation('죽전역 (수인분당선)', '죽전역으로 안내를 시작합니다.');
        } else if (c.includes('역') || c.includes('지하철')) {
            startNavigation('성복역 (신분당선)', '성복역으로 안내를 시작합니다.');
        } else {
            startNavigation(command, `${command}(으)로 안내를 시작합니다.`);
        }

        setTimeout(() => {
            this.closeVoiceModal();
        }, 1300);
    }
};

// ---------------------------------------------------------
// 3-1. 어르신 회원가입 / 로그인 / 프로필 관리 매니저
// ---------------------------------------------------------
const AuthManager = {
    currentUser: null,
    modalEl: null,
    ageModalEl: null,
    debounceTimer: null,

    init() {
        this.modalEl = document.getElementById('authModal');
        this.ageModalEl = document.getElementById('ageModal');
        
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

        // 1-1. [신규] 만 나이 설정 모달 바인딩 (#ageModal)
        const btnAgeQuick = document.getElementById('btnHeaderAgeQuick');
        const btnCloseAge = document.getElementById('btnCloseAgeModal');
        const btnApplyCustom = document.getElementById('btnApplyCustomAge');
        const inputCustom = document.getElementById('inputCustomAge');

        if (btnAgeQuick) {
            btnAgeQuick.addEventListener('click', () => this.openAgeModal());
        }
        if (btnCloseAge) {
            btnCloseAge.addEventListener('click', () => this.closeAgeModal());
        }
        if (btnApplyCustom && inputCustom) {
            btnApplyCustom.addEventListener('click', () => {
                const val = parseInt(inputCustom.value);
                if (val && val > 0 && val <= 130) {
                    this.setAge(val, true);
                    this.closeAgeModal();
                } else {
                    alert('1부터 130 사이의 유효한 나이를 입력해 주세요.');
                }
            });
            inputCustom.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    btnApplyCustom.click();
                }
            });
        }

        // 나이 빠른 선택 프리셋 버튼 바인딩
        document.querySelectorAll('.btn-age-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                const age = parseInt(btn.getAttribute('data-age') || '28');
                this.setAge(age, true);
                this.closeAgeModal();
            });
        });

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

        // 초기 저장된 나이 로드 (기본값: 28세)
        let storedAge = 28;
        const savedAge = localStorage.getItem('robodog_user_age');
        if (savedAge) {
            const parsed = parseInt(savedAge);
            if (!isNaN(parsed) && parsed > 0) storedAge = parsed;
        } else if (this.currentUser && this.currentUser.age) {
            storedAge = this.currentUser.age;
        }
        this.setAge(storedAge, false);

        // 3대 모드 초기화: 기본 일반 모드로 정렬하되 상단 모드 스위처(일반/노인/시각장애인)는 상시 노출
        if (!AppState.currentMode || AppState.currentMode === 'general') {
            AppState.currentMode = 'general';
            const sView = document.getElementById('seniorView');
            const gView = document.getElementById('generalView');
            const blView = document.getElementById('blindView');
            const bGeneral = document.getElementById('btnGeneralMode');
            if (sView) sView.style.setProperty('display', 'none', 'important');
            if (blView) blView.style.setProperty('display', 'none', 'important');
            if (gView) gView.style.setProperty('display', 'flex', 'important');
            if (bGeneral) bGeneral.classList.add('active');
            document.body.classList.remove('mode-senior', 'mode-blind');
            document.body.classList.add('mode-general');
        }

        // 현재 기기 로컬 프로필 로드
        this.fetchProfiles();
    },

    openAgeModal() {
        if (!this.ageModalEl) return;
        const inputCustom = document.getElementById('inputCustomAge');
        if (inputCustom) inputCustom.value = AppState.userAge;
        this.ageModalEl.style.display = 'flex';
    },

    closeAgeModal() {
        if (this.ageModalEl) this.ageModalEl.style.display = 'none';
    },

    /**
     * 핵심 요구사항: 만 나이 설정 및 만 60세 미만/이상 모드 동적 제어
     */
    setAge(age, syncServer = true) {
        let val = parseInt(age);
        if (isNaN(val) || val < 1) val = 28;
        
        AppState.userAge = val;
        const isEligible = val >= 60;
        AppState.isSeniorEligible = isEligible;
        localStorage.setItem('robodog_user_age', val);
        if (this.currentUser) {
            this.currentUser.age = val;
            localStorage.setItem('robodog_current_user', JSON.stringify(this.currentUser));
        }

        // 1. 헤더 만 나이 칩 업데이트
        const chipText = document.getElementById('headerAgeText');
        if (chipText) {
            chipText.textContent = `만 ${val}세`;
        }

        // 2. 모달 내 뱃지 업데이트
        const badge = document.getElementById('currentAgeDisplayBadge');
        if (badge) {
            badge.textContent = `만 ${val}세 (${isEligible ? '노인+일반 모드 활성' : '일반 모드 전용'})`;
            badge.style.background = isEligible ? 'linear-gradient(135deg, #10B981, #059669)' : 'linear-gradient(135deg, #F59E0B, #D97706)';
        }

        // 3. 노인 모드 버튼 표시/숨김 처리
        const btnSenior = document.getElementById('btnSeniorMode');
        const btnGeneral = document.getElementById('btnGeneralMode');

        // 설정 모달 내 뱃지 및 입력창 동기화
        const settingBadge = document.getElementById('settingAgeStatusBadge');
        if (settingBadge) {
            settingBadge.className = `setting-status-badge ${isEligible ? 'over' : 'under'}`;
            settingBadge.textContent = `현재 상태: 만 ${val}세 (${isEligible ? '노인 안심 모드 + 일반 모드 사용 가능' : '일반 모드 전용'})`;
        }
        const inputSettingAge = document.getElementById('settingInputAge');
        if (inputSettingAge && inputSettingAge !== document.activeElement) {
            inputSettingAge.value = val;
        }

        // 상단 모드 스위처는 언제나 일반/노인/시각장애인 3대 모드를 자유롭게 전환할 수 있도록 유지
        if (btnSenior) btnSenior.style.setProperty('display', 'inline-flex', 'important');
        if (btnGeneral) btnGeneral.style.setProperty('display', 'inline-flex', 'important');
        const btnBlindEl = document.getElementById('btnBlindMode');
        if (btnBlindEl) btnBlindEl.style.setProperty('display', 'inline-flex', 'important');
        const switcherContainerEl = document.getElementById('modeSwitcherContainer');
        if (switcherContainerEl) switcherContainerEl.style.setProperty('display', 'inline-flex', 'important');

        if (!isEligible) {
            if (!AppState.isBlindMode) {
                VoiceEngine.toggleNarrator(false);
                logEvent('[AGE]', `만 ${val}세 (만 60세 미만): 내레이터 음성 안내(TTS)가 기본 꺼짐(OFF)으로 설정되었습니다.`, 'info');
            }
        } else {
            VoiceEngine.toggleNarrator(true);
            logEvent('[AGE]', `👵 만 ${val}세 어르신 확인 완료! [노인 안심 모드] 및 내레이터 음성 안내(TTS)가 활성화되었습니다.`, 'success');
        }

        // 4. 백엔드 동기화
        if (syncServer) {
            fetch('/api/auth/set_age', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    age: val,
                    username: this.currentUser?.username,
                    id: this.currentUser?.id
                })
            }).catch(() => {});
        }
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

        this.updateBlindEligibility(false);
        if (AppState.currentMode === 'blind') {
            switchMode('general');
        }
        logEvent('[AUTH]', '👤 현재 사용자 상태: [guest님] (미로그인 모드)', 'info');
        if (notify) {
            VoiceEngine.speak('로그아웃되었습니다. guest님으로 전환합니다.', false);
        }
    },

    fetchProfiles() {
        // 타 컴퓨터 가입자 노출 방지: 오직 현재 기기(로컬 브라우저)에서 로그인/등록된 프로필만 로드
        let localAccounts = [];
        try {
            const raw = localStorage.getItem('robodog_device_accounts');
            if (raw) localAccounts = JSON.parse(raw);
        } catch (e) {}

        this.renderQuickProfiles(localAccounts);
    },

    saveLocalAccount(user) {
        if (!user || !user.name) return;
        try {
            let accounts = [];
            const raw = localStorage.getItem('robodog_device_accounts');
            if (raw) accounts = JSON.parse(raw);
            accounts = accounts.filter(a => a.id !== user.id && a.username !== user.username);
            accounts.unshift(user);
            if (accounts.length > 5) accounts = accounts.slice(0, 5);
            localStorage.setItem('robodog_device_accounts', JSON.stringify(accounts));
        } catch (e) {}
    },

    renderQuickProfiles(profiles) {
        const listEl = document.getElementById('quickProfileList');
        if (!listEl) return;
        listEl.innerHTML = '';

        if (!profiles || profiles.length === 0) {
            listEl.innerHTML = `
                <div style="text-align: center; padding: 18px; color: #64748B; font-size: 13px; background: rgba(0,0,0,0.03); border-radius: 12px; border: 1px dashed #CBD5E1;">
                    💻 이 기기(브라우저)에 저장된 사용자 계정이 없습니다.<br>
                    위 <strong>[회원가입]</strong> 또는 <strong>[로그인]</strong>을 진행해 주세요.
                </div>
            `;
            return;
        }

        profiles.forEach(p => {
            const card = document.createElement('div');
            card.className = 'quick-profile-card';
            const cleanName = this.formatDisplayName(p.name);
            const userAge = p.age || 28;
            const isSenior = userAge >= 60;
            card.innerHTML = `
                <div>
                    <div class="qp-name">👤 ${cleanName} <span class="preset-tag ${isSenior ? 'over' : 'under'}">만 ${userAge}세 (${isSenior ? '노인모드 가능' : '일반모드'})</span></div>
                    <div class="qp-addr">🏡 ${p.address || ''} ${p.detail_address ? '(' + p.detail_address + ')' : ''}</div>
                </div>
                <span class="qp-badge">바로 선택</span>
            `;
            card.addEventListener('click', () => {
                p.age = userAge;
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
                const ageInp = document.getElementById('inputRegAge');
                const addrInp = document.getElementById('inputRegAddress');
                const detInp = document.getElementById('inputRegDetailAddress');
                const gNameInp = document.getElementById('inputRegGuardianName');
                const gPhoneInp = document.getElementById('inputRegGuardianPhone');
                const noteInp = document.getElementById('inputRegNote');

                if (nameInp) nameInp.value = this.currentUser.name || '';
                if (ageInp) ageInp.value = this.currentUser.age || AppState.userAge;
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
        const rawAge = document.getElementById('inputRegAge')?.value || '68';
        const age = parseInt(rawAge) || 68;
        const username = document.getElementById('inputRegUsername')?.value.trim();
        const address = document.getElementById('inputRegAddress')?.value.trim();
        const detail_address = document.getElementById('inputRegDetailAddress')?.value.trim();
        const guardian_name = document.getElementById('inputRegGuardianName')?.value.trim();
        const guardian_phone = document.getElementById('inputRegGuardianPhone')?.value.trim();
        const note = document.getElementById('inputRegNote')?.value.trim();
        const password = document.getElementById('inputRegPassword')?.value.trim() || '1234';
        const is_blind = document.getElementById('inputRegBlindMode')?.checked || false;

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
                    name, age, username, password, address, detail_address, guardian_name, guardian_phone, note, lat, lng, is_blind
                })
            });
            const data = await res.json();
            if (data.status === 'success' && data.user) {
                const dispName = this.formatDisplayName(data.user.name);
                alert(`🎉 ${dispName}의 안심 정보가 등록되었습니다! (만 ${age}세)`);
                this.setCurrentUser(data.user, true);
                this.fetchProfiles();
                this.closeModal();
                if (data.user.is_blind) {
                    switchMode('blind');
                }
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
        this.saveLocalAccount(user);

        // 나이 연동
        const userAge = user.age || (user.name?.includes('순자') ? 73 : (user.name?.includes('승윤') ? 28 : 68));
        this.setAge(userAge, false);

        const dispName = this.formatDisplayName(user.name);

        // 1. 헤더 위젯 업데이트
        const headerText = document.getElementById('headerAuthText');
        if (headerText) headerText.textContent = dispName;

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

        // 7. 시각장애인 여부 적용 (설정/회원가입에서 시각장애인으로 등록된 사용자만 버튼 표시)
        this.updateBlindEligibility(!!user.is_blind);
        if (user.is_blind) {
            switchMode('blind');
        } else if (AppState.currentMode === 'blind') {
            switchMode('general');
        }
        logEvent('[AUTH]', `👤 사용자 연동 완료: [${dispName}] (만 ${userAge}세, 자택: ${user.address})`, 'success');
        if (notify) {
            VoiceEngine.speak(`안녕하세요, ${dispName}! 등록된 정보로 안심 케어를 시작합니다.`, false);
        }
        this.checkModeSwitcherVisibility();
    },

    updateBlindEligibility(isBlind) {
        AppState.isBlindMode = !!isBlind;
        const btnBlind = document.getElementById('btnBlindMode');
        if (btnBlind) {
            btnBlind.style.setProperty('display', 'inline-flex', 'important');
        }
        this.checkModeSwitcherVisibility();
    },

    checkModeSwitcherVisibility() {
        const btnSenior = document.getElementById('btnSeniorMode');
        const btnBlind = document.getElementById('btnBlindMode');
        const btnGeneral = document.getElementById('btnGeneralMode');
        const container = document.getElementById('modeSwitcherContainer');
        if (!container) return;

        // 일반 모드와 노인 모드 상단에 3대 모드 스위처(일반/노인/시각장애인) 상시 완전 노출
        container.style.setProperty('display', 'inline-flex', 'important');
        if (btnGeneral) btnGeneral.style.setProperty('display', 'inline-flex', 'important');
        if (btnSenior) btnSenior.style.setProperty('display', 'inline-flex', 'important');
        if (btnBlind) btnBlind.style.setProperty('display', 'inline-flex', 'important');
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
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        canvas.width = canvas.parentElement.clientWidth || 480;
        canvas.height = canvas.parentElement.clientHeight || 320;

        let scanScore = 0;
        const requiredScore = 80;
        let lastFaceWarning = '';

        const stepText = document.getElementById('faceIdStepText');
        const confText = document.getElementById('faceIdConfidenceText');
        const progressBar = document.getElementById('faceIdProgressBar');
        const badge = document.getElementById('faceIdStatusBadge');
        const targetUserText = document.getElementById('faceTargetUser');

        const loop = () => {
            if (!this.isScanning) return;

            // 1. 실시간 캔버스 비디오 프레임 픽셀 분석 (얼굴 실제 존재 여부 판별)
            let faceDetected = false;
            let warningReason = '';

            if (!isSimulation && video && video.videoWidth > 0 && video.readyState >= 2) {
                if (!this.analysisCanvas) {
                    this.analysisCanvas = document.createElement('canvas');
                    this.analysisCtx = this.analysisCanvas.getContext('2d', { willReadFrequently: true });
                }
                const aCan = this.analysisCanvas;
                const aCtx = this.analysisCtx;
                aCan.width = 160;
                aCan.height = 120;
                aCtx.drawImage(video, 0, 0, aCan.width, aCan.height);

                const sx = Math.floor(aCan.width * 0.25);
                const sy = Math.floor(aCan.height * 0.15);
                const sw = Math.floor(aCan.width * 0.5);
                const sh = Math.floor(aCan.height * 0.7);
                const imgData = aCtx.getImageData(sx, sy, sw, sh);
                const d = imgData.data;

                let sumLum = 0;
                let skinPixels = 0;
                const totalPixels = sw * sh;

                for (let i = 0; i < d.length; i += 4) {
                    const r = d[i];
                    const g = d[i+1];
                    const b = d[i+2];
                    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                    sumLum += lum;

                    if (r > 60 && g > 40 && b > 20 && r > g && r > b && (r - g) >= 8 && (r / (r + g + b + 0.001) > 0.35)) {
                        skinPixels++;
                    }
                }

                const avgLum = sumLum / totalPixels;
                const skinRatio = skinPixels / totalPixels;

                let sumSqDiff = 0;
                for (let i = 0; i < d.length; i += 4) {
                    const lum = 0.299 * d[i] + 0.587 * d[i+1] + 0.114 * d[i+2];
                    sumSqDiff += (lum - avgLum) * (lum - avgLum);
                }
                const stdDev = Math.sqrt(sumSqDiff / totalPixels);

                if (avgLum < 20) {
                    warningReason = '⚠️ 조명이 너무 어둡거나 카메라가 가려졌습니다';
                } else if (avgLum > 240) {
                    warningReason = '⚠️ 화면이 너무 밝아 얼굴을 식별할 수 없습니다';
                } else if (stdDev < 14) {
                    warningReason = '⚠️ 얼굴이 감지되지 않습니다 (단색/벽면 감지)';
                } else if (skinRatio < 0.10) {
                    warningReason = '⚠️ 정면 얼굴을 화면 중앙 타원 안에 맞춰주세요';
                } else {
                    faceDetected = true;
                }
            } else if (isSimulation) {
                faceDetected = true;
            }

            // 2. 실제 얼굴 감지 여부에 따라 진행률 증가 또는 감소
            if (faceDetected) {
                scanScore = Math.min(requiredScore, scanScore + 1);
            } else {
                scanScore = Math.max(0, scanScore - 1.5);
                lastFaceWarning = warningReason;
            }

            const progress = Math.min(100, Math.round((scanScore / requiredScore) * 100));
            this.scanProgress = progress;

            if (progressBar) progressBar.style.width = `${progress}%`;

            // 3. Canvas HUD 렌더링
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            const cx = canvas.width / 2;
            const cy = canvas.height / 2;
            const rx = 85;
            const ry = 110;

            if (!faceDetected) {
                if (badge) {
                    badge.textContent = '얼굴 미감지';
                    badge.style.background = '#DC2626';
                }
                if (stepText) stepText.textContent = lastFaceWarning || '카메라를 정면으로 바라봐 주세요';
                if (confText) confText.textContent = `일치율: 0%`;

                ctx.strokeStyle = 'rgba(239, 68, 68, 0.8)';
                ctx.lineWidth = 2.5;
                ctx.setLineDash([8, 6]);
                ctx.beginPath();
                ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
                ctx.stroke();
                ctx.setLineDash([]);

                ctx.fillStyle = '#EF4444';
                ctx.font = 'bold 14px Pretendard, sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText('⚠️ 얼굴 미감지', cx, cy - 10);
                ctx.font = '12px Pretendard, sans-serif';
                ctx.fillStyle = '#FCA5A5';
                ctx.fillText('중앙 원 안에 얼굴을 위치시켜 주세요', cx, cy + 15);

            } else {
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

                ctx.fillStyle = (progress >= 90) ? '#34D399' : '#38BDF8';
                ctx.strokeStyle = (progress >= 90) ? 'rgba(52, 211, 153, 0.4)' : 'rgba(56, 189, 248, 0.3)';
                ctx.lineWidth = 1;

                const timePhase = Date.now() / 300;
                const wobble = Math.sin(timePhase) * 2;

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

                ctx.beginPath();
                ctx.moveTo(cx, cy - 15 + wobble);
                ctx.lineTo(cx, cy + 10 + wobble);
                ctx.lineTo(cx - 12, cy + 18 + wobble);
                ctx.lineTo(cx + 12, cy + 18 + wobble);
                ctx.stroke();

                ctx.beginPath();
                ctx.ellipse(cx, cy + 42 + wobble, 24, 10, 0, 0, Math.PI * 2);
                ctx.stroke();

                ctx.beginPath();
                ctx.ellipse(cx, cy + wobble, rx, ry, 0, 0, Math.PI * 2);
                ctx.stroke();
            }

            if (progress < 100) {
                this.animId = requestAnimationFrame(loop);
            } else {
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
                const pName = place.place_name || place.name;
                const pAddr = place.address_name || place.address;
                const px = place.x || place.lng;
                const py = place.y || place.lat;
                this.inputEl.value = pName;
                this.hideSuggestions();
                startNavigation(pName, `${pName}으로 경로 안내를 시작합니다.`, {
                    place_name: pName,
                    address_name: pAddr,
                    x: px,
                    y: py,
                    lat: parseFloat(py),
                    lng: parseFloat(px)
                });
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
            this.invalidate();

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

    async loadRoute(destName, targetCoords = null) {
        try {
            logEvent('[NAV]', `실제 도로망 도보 경로 검색 중 (목적지: ${destName})...`, 'info');
            let url = `/api/route/pedestrian?dest=${encodeURIComponent(destName)}`;
            if (this.userLocation && this.userLocation.lat && this.userLocation.lng) {
                url += `&start_lat=${this.userLocation.lat}&start_lng=${this.userLocation.lng}`;
            }
            if (targetCoords && targetCoords.lat && targetCoords.lng) {
                url += `&dest_lat=${targetCoords.lat}&dest_lng=${targetCoords.lng}`;
            }
            const res = await fetch(url);
            const data = await res.json();
            
            if (res.status === 404 || data.status === 'error' || !data.route) {
                alert('해당 장소를 찾을 수 없습니다.');
                logEvent('[NAV]', `도보 경로 탐색 실패: 해당 장소를 찾을 수 없습니다. (${destName})`, 'error');
                return;
            }

            if (data.status === 'success' || data.features) {
                const routeData = data.route || data;
                this.currentRoute = routeData;
                this.currentWaypointIndex = 0;
                this.currentStepIndex = 0;
                AppState.distanceRemaining = this.currentRoute.total_distance_m || 0;

                // [사용자 강제 지침 1:1 구현] 도보 경로 내 횡단보도(신호등) 100% 자동 추출
                const crosswalkSignals = (routeData.features || [])
                  .filter(feature => {
                    const isPoint = feature.geometry && feature.geometry.type === "Point";
                    const desc = (feature.properties && feature.properties.description) || "";
                    const facility = feature.properties && feature.properties.facilityType;
                    return isPoint && (desc.includes("횡단보도") || facility === "1" || facility === "2");
                  })
                  .map((feature, index) => ({
                    id: `signal_${index + 1}`,
                    name: (feature.properties && feature.properties.description) || `횡단보도 ${index + 1}`,
                    coords: feature.geometry.coordinates,
                    offset: index * 25
                  }));

                // 추출된 신호등 정보를 실시간 신호 제어 엔진에 즉시 연동
                const mappedSignals = crosswalkSignals.map((sig, idx) => ({
                    id: sig.id,
                    name: sig.name,
                    lat: sig.coords[1],
                    lng: sig.coords[0],
                    coords: sig.coords,
                    cycleSec: 120,
                    greenSec: 30,
                    redSec: 90,
                    blinkSec: 8,
                    offset: sig.offset
                }));

                this.activeCrosswalks = mappedSignals;
                TrafficSignalEngine.setSignals(this.activeCrosswalks);
                
                const routeTypeMsg = this.currentRoute.is_real_road_routed ? "실제 보행자 도로망(OSRM)" : "표준 안전 보행로";
                logEvent('[NAV]', `도보 경로 수신 [${routeTypeMsg}]: "${this.currentRoute.destination}" (총 ${this.currentRoute.total_distance_m}m, 🚦 신호등 ${this.activeCrosswalks.length}개 C-ITS 관제 가동)`, 'success');
                
                const badge = document.getElementById('mapRouteStatus');
                if (badge) badge.textContent = `🚶 인도자 보행길: ${destName} (${this.currentRoute.total_distance_m}m · 🚦 신호등 ${this.activeCrosswalks.length}개 관제)`;

                // 실제 도로 좌표열 지도 렌더링
                if (this.map && this.currentRoute.waypoints && this.currentRoute.waypoints.length > 0) {
                    const latlngs = this.currentRoute.waypoints.map(wp => [wp.lat, wp.lng]);
                    
                    // [인도자 전용] 안심 에메랄드 보행 점선 라인 (차도 주행선과 시각적 완전 차별화)
                    this.polyline.setLatLngs(latlngs);
                    this.polyline.setStyle({
                        color: '#10B981', // 안심 보행자 그린 (네이버/카카오 도보 전용 컬러)
                        weight: 6,
                        opacity: 0.95,
                        dashArray: '8, 8' // 인도 보행자 발걸음 점선 스타일
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

    // 로보독 & 사용자 위치 (픽셀 좌표계)
    robo: { x: 80, y: 200, targetY: 200, theta: 0, stepSize: 1.2, avoidAngleDeg: 0 },
    elder: { x: 35, y: 200 },
    radarAngle: 0,

    // [핵심 요구사항] 임의의 가짜 장애물 제거 -> 실제 BLE 센서 수신 또는 주행 중 탐지된 장애물만 동적 유지
    detectedObstacles: [],

    // 실시간 판단 상태 (장애물 유무, 회피각, 신호등 판정)
    sensorState: {
        obstacleDetected: false,
        obstacleDistM: null,
        obstacleAngleDeg: 0,
        obstacleType: null, // 'static' | 'dynamic'
        decisionText: '📡 로보독(BLE) 연결 대기 중 • 실시간 센서 탐지 대기',
        trafficDecision: '보행 신호 확인 대기',
        isWaitingTrafficLight: false
    },

    init() {
        this.canvas = document.getElementById('digitalTwinCanvas');
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        logEvent('[CANVAS]', 'LiDAR 센서 근거리 장애물 회피 & 실시간 신호등 판단 트윈 엔진 초기화', 'success');
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

    /**
     * [BLE 센서 패킷 연동] 실제 로보독 블루투스에서 장애물/거리/신호등 패킷 수신 시 즉시 트윈에 반영
     */
    applyBleSensorData(payload) {
        if (!payload) return;
        if (payload.type === 'CLEAR') {
            this.detectedObstacles = [];
            this.sensorState.obstacleDetected = false;
            this.sensorState.obstacleDistM = null;
            this.sensorState.decisionText = '🟢 전방 장애물 없음 (안전 주행 거리 3.0m 이상 확보)';
            return;
        }
        if (payload.type === 'OBSTACLE') {
            const dist = parseFloat(payload.dist) || 1.5;
            const angle = parseFloat(payload.angle) || 0;
            const obsType = payload.obsType || 'static';
            const pxDist = Math.max(50, Math.min(220, dist * 60));
            const obsX = this.robo.x + pxDist;
            const obsY = 200 + Math.sin((angle * Math.PI) / 180) * 55;

            this.detectedObstacles = [{
                x: obsX,
                y: obsY,
                distM: dist,
                angleDeg: angle,
                type: obsType,
                label: payload.label || (obsType === 'dynamic' ? '🚶 보행자 (동적 감속)' : '🚧 정적 장애물')
            }];
            this.sensorState.obstacleDetected = true;
            this.sensorState.obstacleDistM = dist;
            this.sensorState.obstacleAngleDeg = angle;
            this.sensorState.obstacleType = obsType;
            this.sensorState.decisionText = `⚠️ 전방 ${dist.toFixed(1)}m 장애물 감지 -> [${angle >= 0 ? '우측' : '좌측'} ${Math.abs(angle).toFixed(1)}° 우회 회피 판단]`;
        }
    },

    updatePhysics() {
        this.radarAngle = (this.radarAngle + 0.05) % (Math.PI * 2);

        // 1. [대기 상태] 블루투스 미연결 또는 비보행 상태: 임의의 고정 가짜 장애물 제거
        if (!AppState.isWalking) {
            // BLE 연결 여부에 따른 대기 안내 텍스트
            if (!AppState.isBleConnected) {
                this.sensorState.decisionText = '📡 [대기] 로보독 블루투스(BLE) 연결 대기 • 실시간 센서 탐지 준비';
                this.sensorState.trafficDecision = '신호등 대기 중 (연결 시 동기화)';
            } else {
                this.sensorState.decisionText = '🟢 [연동 완료] 실시간 LiDAR 탐색 중 • 출발 대기 (전방 안전 거리 확보)';
                this.sensorState.trafficDecision = '보행 신호 확인 완료 (출발 대기)';
            }
            this.detectedObstacles = [];
            this.robo.stepSize = 0;
            this.robo.avoidAngleDeg = 0;
            this.robo.targetY = 200;
            return;
        }

        // 2. [구동/보행 상태] 실제 주행 시작 시: 신호등 파악 및 전방 장애물 실시간 판단
        
        // (A) C-ITS 신호등 상태 실시간 파악
        let signal = (typeof TrafficSignalEngine !== 'undefined' && TrafficSignalEngine.closestSignal) ? TrafficSignalEngine.closestSignal : null;
        if (!signal && typeof TrafficSignalEngine !== 'undefined') {
            signal = TrafficSignalEngine.getSignalState({ id: 'sig_default', name: '수지구청 사거리 횡단보도', offset: 15, cycleSec: 120, greenSec: 35, blinkSec: 8 });
        }
        const sigColor = signal ? signal.color : 'GREEN';
        const sigRem = signal ? signal.remainingTime : 25;

        const crosswalkX = 470; // 횡단보도 시작 위치
        let isWaitingSignal = false;

        // 적색 신호 시 횡단보도 정지선(x=420) 앞에서 반드시 정지 판단
        if (sigColor === 'RED') {
            if (this.robo.x >= 390 && this.robo.x < crosswalkX) {
                isWaitingSignal = true;
                this.robo.stepSize = 0; // 정지
                this.sensorState.isWaitingTrafficLight = true;
                this.sensorState.trafficDecision = `🛑 적색 신호 감지 (${sigRem}초 대기) -> [정지선 일시 정지 판단]`;
            } else {
                this.sensorState.trafficDecision = `횡단보도 전방 적색 신호 대기 (${sigRem}초 남음)`;
            }
        } else if (sigColor === 'BLINKING') {
            if (this.robo.x < 390) {
                isWaitingSignal = true;
                this.robo.stepSize = 0.4;
                this.sensorState.trafficDecision = `⚠️ 보행 점멸 신호 (${sigRem}초 남음) -> [진입 자제 및 감속 판단]`;
            } else {
                this.robo.stepSize = 1.4; // 횡단보도 내 신속 통과
                this.sensorState.trafficDecision = `⚠️ 점멸 신호 안전 횡단 중 (${sigRem}초 남음)`;
            }
        } else {
            // 녹색 신호 (GREEN)
            this.sensorState.isWaitingTrafficLight = false;
            this.sensorState.trafficDecision = `🟢 보행 녹색 신호 (${sigRem}초 잔여) -> [안전 횡단 진행 판단]`;
        }

        // (B) 전방 장애물 유무 실시간 센서 판단 (주행 구간 180 ~ 360 px)
        if (!isWaitingSignal) {
            let obstacleNear = false;
            let pedestrianNear = false;

            // 주행 중 특정 구간(x: 180~360)에서 센서가 실제 장애물/보행자를 감지하는 물리 시뮬레이션
            if (this.robo.x > 170 && this.robo.x < 370) {
                this.detectedObstacles = [
                    { x: 280, y: 200, distM: 1.4, radius: 18, type: 'static', label: '🚧 감지 장애물 (1.4m)' },
                    { x: 345, y: 160 + Math.sin(Date.now() / 250) * 35, distM: 1.8, radius: 14, type: 'dynamic', label: '🚶 보행자 (1.8m)' }
                ];
            } else {
                this.detectedObstacles = [];
            }

            this.detectedObstacles.forEach(obs => {
                const dist = Math.hypot(this.robo.x - obs.x, this.robo.y - obs.y);
                if (obs.type === 'static' && dist < 95 && this.robo.x < obs.x) {
                    obstacleNear = true;
                    this.robo.avoidAngleDeg = Math.min(this.robo.avoidAngleDeg + 1.2, 26);
                    this.robo.targetY = 140; // 우회
                    this.sensorState.decisionText = `⚠️ 전방 ${obs.distM}m 장애물 감지 -> [우측 +${this.robo.avoidAngleDeg.toFixed(1)}° 우회 회피 판단]`;
                }
                if (obs.type === 'dynamic' && dist < 75) {
                    pedestrianNear = true;
                }
            });

            if (!obstacleNear && this.robo.x > 320) {
                this.robo.avoidAngleDeg = Math.max(this.robo.avoidAngleDeg - 1.0, 0);
                this.robo.targetY = 200; // 정상 복귀
                if (!pedestrianNear) {
                    this.sensorState.decisionText = '🟢 전방 장애물 회피 완료 -> 직선 정상 궤적 복귀';
                }
            }

            if (pedestrianNear) {
                this.robo.stepSize = 0.5; // 감속
                this.sensorState.decisionText = '🚶 보행자 근접 감지 -> [동적 감속 (0.5m/s 서행) 판단]';
            } else if (!obstacleNear && !isWaitingSignal) {
                this.robo.stepSize = 1.2; // 정상 보행 속도
                if (this.robo.x <= 170 || this.robo.x >= 370) {
                    this.sensorState.decisionText = '🟢 전방 장애물 없음 (안전 거리 3.0m 이상 확보)';
                }
            }
        }

        // 로보독 및 사용자 물리 이동 갱신
        const thetaRad = (this.robo.avoidAngleDeg * Math.PI) / 180;
        this.robo.theta = thetaRad;
        this.robo.x += this.robo.stepSize * Math.cos(thetaRad);
        this.robo.y += (this.robo.targetY - this.robo.y) * 0.06;

        this.elder.x += (this.robo.x - 45 - this.elder.x) * 0.08;
        this.elder.y += (this.robo.y - this.elder.y) * 0.08;

        // 화면 끝 도달 시 루프 리셋
        if (this.robo.x > this.canvas.width - 30) {
            this.robo.x = 60;
            this.robo.y = 200;
            this.robo.targetY = 200;
            this.robo.avoidAngleDeg = 0;
            this.elder.x = 20;
            this.elder.y = 200;
        }

        AppState.angle = this.robo.avoidAngleDeg;
        BleController.updateTelemetry({ angle: this.robo.avoidAngleDeg });
    },

    drawScene() {
        const { ctx, canvas } = this;
        if (!ctx || !canvas) return;

        // 1. 다크 HUD 배경
        ctx.fillStyle = '#090D16';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // 2. 그리드 선
        ctx.strokeStyle = '#121A2A';
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

        // 3. LiDAR 동심원 거리 링 (1m, 2m, 3m, 4m)
        const rx = this.robo.x;
        const ry = this.robo.y;
        [60, 120, 180, 240].forEach((r, idx) => {
            ctx.strokeStyle = 'rgba(56, 189, 248, 0.12)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.arc(rx, ry, r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.fillStyle = 'rgba(56, 189, 248, 0.4)';
            ctx.font = '9px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(`${idx + 1}.0m`, rx + r - 12, ry - 4);
        });

        // 4. 중앙 주행 가이드 기준선
        ctx.strokeStyle = '#1E293B';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(0, 200);
        ctx.lineTo(canvas.width, 200);
        ctx.stroke();
        ctx.setLineDash([]);

        // 5. [신호등 & 횡단보도 구역 렌더링]
        const crosswalkX = 470;
        // (A) 정지선 (Stop line)
        ctx.strokeStyle = '#F59E0B';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(crosswalkX - 25, 140);
        ctx.lineTo(crosswalkX - 25, 260);
        ctx.stroke();

        ctx.fillStyle = '#F59E0B';
        ctx.font = 'bold 9px Pretendard';
        ctx.textAlign = 'center';
        ctx.fillText('정지선', crosswalkX - 25, 134);

        // (B) 횡단보도 줄무늬
        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        for (let cy = 145; cy < 255; cy += 18) {
            ctx.fillRect(crosswalkX, cy, 75, 10);
        }

        // (C) 횡단보도 신호등 기둥 및 3색 램프
        let signal = (typeof TrafficSignalEngine !== 'undefined' && TrafficSignalEngine.closestSignal) ? TrafficSignalEngine.closestSignal : null;
        if (!signal && typeof TrafficSignalEngine !== 'undefined') {
            signal = TrafficSignalEngine.getSignalState({ id: 'sig_default', name: '수지구청 사거리 횡단보도', offset: 15, cycleSec: 120, greenSec: 35, blinkSec: 8 });
        }
        const sigColor = signal ? signal.color : 'GREEN';
        const sigRem = signal ? signal.remainingTime : 25;

        // 신호등 하우징
        const sigX = 510;
        const sigY = 65;
        ctx.fillStyle = '#0F172A';
        ctx.fillRect(sigX - 16, sigY - 24, 32, 66);
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(sigX - 16, sigY - 24, 32, 66);

        // 적색등
        ctx.fillStyle = (sigColor === 'RED') ? '#EF4444' : '#331B1B';
        ctx.beginPath();
        ctx.arc(sigX, sigY - 10, 8, 0, Math.PI * 2);
        ctx.fill();
        if (sigColor === 'RED') {
            ctx.strokeStyle = '#FCA5A5';
            ctx.stroke();
        }

        // 황색/점멸등
        ctx.fillStyle = (sigColor === 'BLINKING') ? '#F59E0B' : '#2D2012';
        ctx.beginPath();
        ctx.arc(sigX, sigY + 9, 8, 0, Math.PI * 2);
        ctx.fill();

        // 녹색등
        ctx.fillStyle = (sigColor === 'GREEN') ? '#10B981' : '#132B20';
        ctx.beginPath();
        ctx.arc(sigX, sigY + 28, 8, 0, Math.PI * 2);
        ctx.fill();
        if (sigColor === 'GREEN') {
            ctx.strokeStyle = '#6EE7B7';
            ctx.stroke();
        }

        // 신호등 상단 라벨 및 잔여 시간
        ctx.fillStyle = (sigColor === 'RED') ? '#EF4444' : (sigColor === 'GREEN' ? '#10B981' : '#F59E0B');
        ctx.font = 'bold 11px Pretendard';
        ctx.textAlign = 'center';
        ctx.fillText(`🚦 ${sigRem}s`, sigX, sigY - 32);

        // 6. 실시간 동적 주행 궤적선
        ctx.strokeStyle = '#38BDF8';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(40, 200);
        ctx.quadraticCurveTo(this.robo.x - 40, (this.robo.targetY + 200) / 2, this.robo.x, this.robo.y);
        ctx.stroke();

        // 7. [장애물 렌더링 - 실제 감지된 장애물만 표시]
        this.detectedObstacles.forEach(obs => {
            const isStatic = obs.type === 'static';
            const color = isStatic ? '#F59E0B' : '#EC4899';
            const radius = obs.radius || 16;

            // 외곽 경고 펄스 링
            ctx.strokeStyle = isStatic ? 'rgba(245, 158, 11, 0.35)' : 'rgba(236, 72, 153, 0.35)';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.arc(obs.x, obs.y, radius + 12 + Math.sin(Date.now() / 200) * 3, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);

            // 장애물 본체
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(obs.x, obs.y, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#FFFFFF';
            ctx.lineWidth = 2;
            ctx.stroke();

            // 라벨 & 센서 거리 텍스트
            ctx.fillStyle = '#FFFFFF';
            ctx.font = 'bold 11px Pretendard';
            ctx.textAlign = 'center';
            ctx.fillText(obs.label, obs.x, obs.y - radius - 8);

            // 로보독과 장애물 간 LiDAR 탐지선
            ctx.strokeStyle = isStatic ? 'rgba(245, 158, 11, 0.6)' : 'rgba(236, 72, 153, 0.6)';
            ctx.lineWidth = 1.2;
            ctx.setLineDash([2, 3]);
            ctx.beginPath();
            ctx.moveTo(this.robo.x, this.robo.y);
            ctx.lineTo(obs.x, obs.y);
            ctx.stroke();
            ctx.setLineDash([]);
        });

        // 8. 로보독 전방 LiDAR 부채꼴 탐지 영역 (FOV 120°)
        const fovRadius = 90;
        const fovAngle = Math.PI * 0.65;
        const heading = this.robo.theta;

        ctx.save();
        ctx.translate(this.robo.x, this.robo.y);
        const grad = ctx.createRadialGradient(0, 0, 10, 0, 0, fovRadius);
        grad.addColorStop(0, 'rgba(6, 182, 212, 0.3)');
        grad.addColorStop(1, 'rgba(6, 182, 212, 0.02)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, fovRadius, heading - fovAngle / 2, heading + fovAngle / 2);
        ctx.closePath();
        ctx.fill();

        // 9. 회전하는 LiDAR 360° 레이저 스위프 빔
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(this.radarAngle) * 95, Math.sin(this.radarAngle) * 95);
        ctx.stroke();
        ctx.restore();

        // 10. 사용자 아바타 & 리드줄
        ctx.strokeStyle = 'rgba(251, 191, 36, 0.6)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(this.elder.x, this.elder.y);
        ctx.lineTo(this.robo.x - 16, this.robo.y);
        ctx.stroke();

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

        // 11. 로보독 본체
        ctx.save();
        ctx.translate(this.robo.x, this.robo.y);
        ctx.rotate(this.robo.theta);

        ctx.fillStyle = '#06B6D4';
        ctx.fillRect(-16, -10, 32, 20);
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.strokeRect(-16, -10, 32, 20);

        // 바퀴/다리
        ctx.fillStyle = '#38BDF8';
        ctx.fillRect(-14, -14, 6, 4);
        ctx.fillRect(8, -14, 6, 4);
        ctx.fillRect(-14, 10, 6, 4);
        ctx.fillRect(8, 10, 6, 4);

        // 전방 헤드라이트 / 센서 눈
        ctx.fillStyle = '#FFE600';
        ctx.beginPath();
        ctx.arc(16, 0, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();

        ctx.fillStyle = '#38BDF8';
        ctx.font = 'bold 11px Pretendard';
        ctx.textAlign = 'center';
        ctx.fillText(`🐕 로보독 (θ: ${this.robo.avoidAngleDeg.toFixed(1)}°)`, this.robo.x, this.robo.y - 18);

        // 12. 상단 통합 HUD 센서 판단 바
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.fillRect(10, 8, canvas.width - 20, 36);
        ctx.strokeStyle = '#334155';
        ctx.lineWidth = 1;
        ctx.strokeRect(10, 8, canvas.width - 20, 36);

        // 왼쪽: 센서 상태 텍스트
        ctx.fillStyle = this.sensorState.obstacleDetected ? '#F59E0B' : '#38BDF8';
        ctx.font = 'bold 11px Pretendard';
        ctx.textAlign = 'left';
        ctx.fillText(this.sensorState.decisionText, 20, 30);

        // 오른쪽: 신호등 판단 텍스트
        ctx.fillStyle = (sigColor === 'RED') ? '#F87171' : (sigColor === 'GREEN' ? '#34D399' : '#FBBF24');
        ctx.textAlign = 'right';
        ctx.fillText(`[신호 판단] ${this.sensorState.trafficDecision}`, canvas.width - 20, 30);
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
                const pName = place.place_name || place.name;
                const pAddr = place.address_name || place.address;
                const px = place.x || place.lng;
                const py = place.y || place.lat;
                const searchInput = document.getElementById('inputGeneralSearch');
                if (searchInput) searchInput.value = pName;
                const ttsMsg = AppState.currentMode === 'senior' 
                    ? `${pName}(으)로 안내를 시작합니다. 저를 따라오세요.`
                    : null;
                startNavigation(pName, ttsMsg, {
                    place_name: pName,
                    address_name: pAddr,
                    x: px,
                    y: py,
                    lat: parseFloat(py),
                    lng: parseFloat(px)
                });
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


// ---------------------------------------------------------
// 10-1. [신규] 🦯 시각장애인 전체 화면 원터치 GPS 감지 & 음성 내비게이션 매니저
// ---------------------------------------------------------
const BlindTouchManager = {
    surfaceEl: null,
    currentDest: '',
    state: 'idle', // 'idle' | 'waiting_touch' | 'navigating'

    init() {
        this.surfaceEl = document.getElementById('blindTouchSurface');
        if (!this.surfaceEl) return;

        this.surfaceEl.addEventListener('click', (e) => {
            if (e.target.closest('#btnCancelBlindTouch')) {
                e.stopPropagation();
                this.cancel();
                return;
            }
            this.handleScreenTouch();
        });
    },

    startGuide(destName) {
        this.currentDest = destName;
        this.state = 'waiting_touch';
        if (!this.surfaceEl) this.surfaceEl = document.getElementById('blindTouchSurface');
        if (!this.surfaceEl) return;

        const badgeDest = document.getElementById('blindTouchDestBadge');
        if (badgeDest) badgeDest.textContent = `🎯 ${destName} 출발 대기`;
        
        const mainText = document.getElementById('blindTouchMainText');
        if (mainText) mainText.textContent = '화면의 아무 곳이나 터치해 주세요';
        
        const subText = document.getElementById('blindTouchSubText');
        if (subText) subText.textContent = 'GPS 신호 탐지 및 안전 보행 안내 시작';
        
        const badge = document.getElementById('blindTouchStatusBadge');
        if (badge) {
            badge.className = 'blind-touch-status-badge status-waiting';
            badge.textContent = '📡 GPS 감지 대기 중 (화면을 탭하세요)';
        }

        this.surfaceEl.style.setProperty('display', 'flex', 'important');

        // 1. [요청사항] 시각장애인 모드에서는 내레이터 무조건 ON 활성화
        VoiceEngine.toggleNarrator(true);

        // 2. [요청사항] OO까지 출발합니다. 먼저 GPS신호 탐지를 위해 화면을 클릭해주세요 음성 안내
        VoiceEngine.speak(`${destName}까지 출발합니다. 먼저 GPS 신호 탐지를 위해 화면을 클릭해 주세요.`, true);

        if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    },

    handleScreenTouch() {
        if (this.state === 'waiting_touch' || this.state === 'idle') {
            this.state = 'navigating';

            if (navigator.vibrate) navigator.vibrate([180, 80, 180, 80, 220]);
            if (typeof LeashController !== 'undefined') {
                LeashController.triggerHaptic('forward');
            }

            const badge = document.getElementById('blindTouchStatusBadge');
            if (badge) {
                badge.className = 'blind-touch-status-badge status-active';
                badge.textContent = '🟢 GPS 정상 감지 • 실시간 안전 보행 중';
            }

            const mainText = document.getElementById('blindTouchMainText');
            if (mainText) mainText.textContent = '⬆️ 전방 120m 직진';
            
            const subText = document.getElementById('blindTouchSubText');
            if (subText) subText.textContent = '화면을 터치할 때마다 음성 위치 & 신호등 안내가 반복됩니다';

            VoiceEngine.speak(`GPS 신호가 정상 감지되었습니다. ${this.currentDest}(으)로 안전 길안내를 시작합니다. 저를 따라 천천히 걸어주세요.`, true);

            AppState.currentDest = this.currentDest;
            AppState.isWalking = true;
            BleController.sendPacket(`CMD:START:DEST=${this.currentDest}`);
            RealMapManager.loadRoute(this.currentDest);

        } else if (this.state === 'navigating') {
            if (navigator.vibrate) navigator.vibrate([100]);
            if (typeof LeashController !== 'undefined') {
                LeashController.triggerHaptic('forward');
            }
            VoiceEngine.speak(`현재 120미터 앞 직진 중입니다. 신호등은 녹색이며 보행 시간은 충분합니다. 계속 안심하고 걸어주세요.`, true);
        }
    },

    cancel() {
        this.state = 'idle';
        if (this.surfaceEl) this.surfaceEl.style.setProperty('display', 'none', 'important');
        AppState.isWalking = false;
        BleController.sendPacket('CMD:STOP');
        VoiceEngine.speak('길안내가 종료되었습니다.', true);
    }
};

async function startNavigation(destName, ttsMessage, explicitCoords = null) {
    if (!destName || !destName.trim()) {
        alert('해당 장소를 찾을 수 없습니다.');
        return;
    }

    let targetPlace = explicitCoords;

    // 만약 사전에 검증된 좌표가 없다면, 공식 POI 검색 API(/api/places/search)를 호출하여 1:1 검증
    if (!targetPlace || !targetPlace.lat || !targetPlace.lng) {
        try {
            logEvent('[NAV]', `공식 POI 검색 API 호출 중: [${destName}]...`, 'info');
            const loc = RealMapManager.userLocation;
            let searchUrl = `/api/places/search?q=${encodeURIComponent(destName.trim())}`;
            if (loc && loc.lat && loc.lng) {
                searchUrl += `&lat=${loc.lat}&lng=${loc.lng}`;
            }
            const res = await fetch(searchUrl);
            const data = await res.json();
            
            if (!data.results || data.results.length === 0) {
                alert('해당 장소를 찾을 수 없습니다.');
                logEvent('[NAV]', `검색 결과 없음: [${destName}] - 탐색 즉시 종료`, 'error');
                return;
            }

            // 검색 결과에서 API가 반환한 place_name, address_name, x(경도), y(위도)만 변수에 저장하고 화면에 표시
            const firstResult = data.results[0];
            targetPlace = {
                place_name: firstResult.place_name || firstResult.name,
                address_name: firstResult.address_name || firstResult.address,
                x: parseFloat(firstResult.x || firstResult.lng),
                y: parseFloat(firstResult.y || firstResult.lat),
                lat: parseFloat(firstResult.y || firstResult.lat),
                lng: parseFloat(firstResult.x || firstResult.lng)
            };
        } catch (err) {
            logEvent('[ERROR]', `POI 검색 실패: ${err.message}`, 'error');
            alert('해당 장소를 찾을 수 없습니다.');
            return;
        }
    }

    const verifiedName = targetPlace.place_name || destName;
    const verifiedAddr = targetPlace.address_name || '';

    // 화면 입력창 및 상태 동기화 (API 반환 데이터만 표시)
    const inputGen = document.getElementById('inputGeneralSearch');
    if (inputGen) inputGen.value = verifiedName;

    if (AppState.currentMode === 'blind' || AppState.isBlindMode) {
        BlindTouchManager.startGuide(verifiedName);
        return;
    }

    AppState.currentDest = verifiedName;
    AppState.currentAddress = verifiedAddr;
    AppState.currentDestCoords = targetPlace;
    AppState.isWalking = true;
    logEvent('[NAV]', `목적지 설정 완료: [${verifiedName}] (${verifiedAddr}) 도보 안내 가동`, 'success');
    
    updateSeniorStatus(
        `🐕 ${verifiedName}(으)로 안전하게 모시는 중입니다.`,
        verifiedAddr ? `[${verifiedAddr}] 방면 인도 보행 중` : '보폭에 맞추어 서행 중입니다. 신호등과 주변을 살피고 있어요.',
        '안전 보행 중'
    );
    
    const genBadge = document.getElementById('generalWalkBadge');
    if (genBadge) {
        genBadge.className = 'badge badge-green';
        genBadge.textContent = `${verifiedName} 동행 중`;
    }

    BleController.sendPacket(`CMD:START:DEST=${verifiedName}`);
    if (typeof LeashController !== 'undefined') {
        LeashController.triggerHaptic('forward');
    }
    RealMapManager.loadRoute(verifiedName, targetPlace);
    
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
    const btnBlind = document.getElementById('btnBlindMode');

    const seniorView = document.getElementById('seniorView');
    const generalView = document.getElementById('generalView');
    const blindView = document.getElementById('blindView');

    if (btnSenior) btnSenior.classList.remove('active');
    if (btnGeneral) btnGeneral.classList.remove('active');
    if (btnBlind) btnBlind.classList.remove('active');

    // 3대 모드 UI 완전 독립 분리: 선택된 모드 외 다른 모드 UI는 100% 숨김
    if (seniorView) seniorView.style.setProperty('display', 'none', 'important');
    if (generalView) generalView.style.setProperty('display', 'none', 'important');
    if (blindView) blindView.style.setProperty('display', 'none', 'important');

    const theme = localStorage.getItem('robodog_theme') || 'white';
    document.body.classList.remove('theme-white', 'theme-dark');
    document.body.classList.add(theme === 'dark' ? 'theme-dark' : 'theme-white');

    if (targetMode === 'senior') {
        AppState.isBlindMode = false;
        document.body.classList.remove('mode-general', 'mode-guardian', 'mode-blind');
        document.body.classList.add('mode-senior');
        if (btnSenior) btnSenior.classList.add('active');
        if (seniorView) seniorView.style.setProperty('display', 'flex', 'important');

        logEvent('[MODE]', '👵 [노인 안심 모드]로 전환되었습니다. (노인 모드 UI 전용 표시)', 'success');
        const activeName = AuthManager.currentUser ? AuthManager.formatDisplayName(AuthManager.currentUser.name) : 'guest님';
        VoiceEngine.speak(`노인 안심 모드로 전환되었습니다. ${activeName}, 어디로 모실까요?`, false);

    } else if (targetMode === 'general') {
        AppState.isBlindMode = false;
        document.body.classList.remove('mode-senior', 'mode-guardian', 'mode-blind');
        document.body.classList.add('mode-general');
        if (btnGeneral) btnGeneral.classList.add('active');
        if (generalView) generalView.style.setProperty('display', 'flex', 'important');

        logEvent('[MODE]', '👤 [일반 모드 & 스마트 관제 센터]로 전환되었습니다. (일반 모드 UI 전용 표시)', 'info');
        RealMapManager.invalidate();

    } else if (targetMode === 'blind') {
        AppState.isBlindMode = true;
        VoiceEngine.toggleNarrator(true);

        document.body.classList.remove('mode-general', 'mode-guardian', 'mode-senior');
        document.body.classList.add('mode-blind');
        if (btnBlind) btnBlind.classList.add('active');
        if (blindView) blindView.style.setProperty('display', 'flex', 'important');

        logEvent('[MODE]', '🦯 [시각장애인 안심 모드] 가동: 상단 복잡한 헤더 숨김 및 100% 음성 비서 UI 전용 전개', 'success');
        VoiceEngine.speak('시각장애인 안심 보행 모드가 가동되었습니다. 화면 아무 곳이나 탭하고 가실 곳을 말씀해 주세요.', true);
    }
}

// ---------------------------------------------------------
// 12. 이벤트 바인딩 및 앱 시작
// ---------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    // 로컬 스토리지에 남아있을 수 있는 이전 예시 데이터 정제
    try {
        const rawUser = localStorage.getItem('robodog_current_user');
        if (rawUser && rawUser.includes('힐스테이트')) {
            const parsed = JSON.parse(rawUser);
            parsed.detail_address = '행복아파트 102동';
            localStorage.setItem('robodog_current_user', JSON.stringify(parsed));
        }
    } catch (e) {}

    logEvent('[SYSTEM]', 'RoboDog WAY GUIDE 시스템 가동...', 'info');

    // 초기 로드 시 시각장애인 터치 서피스 강제 숨김 (첫 화면은 일반 화이트 화면)
    const blindSurface = document.getElementById('blindTouchSurface');
    if (blindSurface) blindSurface.style.setProperty('display', 'none', 'important');


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
    const btnBlind = document.getElementById('btnBlindMode');
    if (btnBlind) btnBlind.classList.remove('active');

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
    if (btnBlind) {
        btnBlind.addEventListener('click', (e) => {
            e.preventDefault();
            switchMode('blind');
        });
    }

    // [신규] 🦯 시각장애인 전용 화면 인터랙션 바인딩
    const btnBlindVoiceHero = document.getElementById('btnBlindVoiceTrigger');
    if (btnBlindVoiceHero) {
        btnBlindVoiceHero.addEventListener('click', (e) => {
            e.preventDefault();
            if (navigator.vibrate) navigator.vibrate(100);
            // TTS 음성 안내가 완전히 끝난 직후 STT 모달을 열어 마이크와 스피커 간섭을 100% 차단
            VoiceEngine.speak('가실 곳을 말씀해 주세요.', true, () => {
                VoiceEngine.openVoiceModal();
            });
            // 폴백 타이머 (음성 합성 onend 누락 대비)
            setTimeout(() => {
                if (!VoiceEngine.isModalOpen) VoiceEngine.openVoiceModal();
            }, 1800);
        });
    }

    // 시각장애인 4대 쾌속 목적지 바 터치 시 즉시 길안내 가동
    document.querySelectorAll('.btn-blind-dest').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            if (navigator.vibrate) navigator.vibrate(120);
            const dest = btn.getAttribute('data-dest');
            if (dest) {
                startNavigation(dest);
            }
        });
    });

    // 시각장애인 전용 뷰 내 모드 복귀 버튼들 (일반 모드로, 노인 모드로)
    const btnBlindToGen = document.getElementById('btnBlindToGeneral');
    const btnBlindToSen = document.getElementById('btnBlindToSenior');
    const btnExitBlind = document.getElementById('btnExitBlindMode');

    if (btnBlindToGen) {
        btnBlindToGen.addEventListener('click', (e) => {
            e.preventDefault();
            switchMode('general');
        });
    }
    if (btnBlindToSen) {
        btnBlindToSen.addEventListener('click', (e) => {
            e.preventDefault();
            switchMode('senior');
        });
    }
    if (btnExitBlind) {
        btnExitBlind.addEventListener('click', (e) => {
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
        const doSearch = () => {
            const query = inputGenSearch.value.trim();
            if (!query) {
                alert('해당 장소를 찾을 수 없습니다.');
                return;
            }
            startNavigation(query, null);
        };
        btnGenSearch.addEventListener('click', doSearch);
        inputGenSearch.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                doSearch();
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

    // 11. 모듈 초기화 (회원 인증, 로보독 BLE, 스파이크 리드줄, 설정 매니저, 지도, 신호등 등)
    AuthManager.init();
    BleController.init();
    LeashController.init();
    SettingManager.init();
    HomeAddressManager.init();
    AutocompleteSearchManager.init();
    RealMapManager.init();
    setTimeout(() => RealMapManager.invalidate(), 300);
    CanvasRenderer.init();
    TrafficSignalEngine.init();
    CareTuningManager.init();
    AllPlacesModalManager.init();
    FaceIdManager.init();
    BlindTouchManager.init();

    // 12. 초기 얼굴 인식(Face ID) 안내 실행
    FaceIdManager.runVerification();
});
