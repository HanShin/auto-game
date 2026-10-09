# 랑그릿사 공략과 스타레일 iPad 도구

문 너머 저편 공략, 턴별 칸 좌표 실행표, 실제 업적·보물 검증 기록을 다른 PC에서도 이어 쓰는 저장소입니다. 게임 입력은 **Computer Use로 한 동작씩 수동 조작**합니다. 게임이나 계정 로그인, Computer Use 연결 자체는 이 소스에 포함되어 있지 않습니다.

```sh
git clone https://github.com/HanShin/auto-game.git
cd auto-game
node scripts/portable-check.mjs
```

자료를 읽고 수동 진행하는 데 `npm install`은 필요하지 않습니다. 파일 검사와 좌표 계산 도구는 Node.js 20.19 이상에서 실행하며 외부 패키지가 필요 없습니다.

- [다른 PC에서 연결하고 이어서 진행하기](docs/LANGRISSER-OTHER-PC.md)
- [최신 완료 상태](data/langrisser/current-session.json): 바다 섬의 장Ⅰ 02 **폭풍의 우연**, 3턴 승리·업적2/2·보물1/1. 사용자의 마지막 요청에 따라 여기에서 중지했습니다.
- [최신 PC 검증 기록](data/langrisser/verification/pc-2026-10-08.md#폭풍의-우연-검증-완료--2026-10-09) / [완료 화면](data/langrisser/verification/pc-2026-10-09-storm-complete.jpg)
- [폭풍의 우연 실행표](docs/langrisser-playbooks/sea1-storm-encounter-grid-2026-10-09.md) / [심판의 탑 실행표](docs/langrisser-playbooks/sea1-judgment-tower-grid-2026-10-08.md)
- [공략 요약](docs/LANGRISSER-GUIDES.md) / [칸 좌표 규칙](docs/LANGRISSER-GRID-EXECUTION.md) / [진행 지침](AGENTS.md)

`data/langrisser/current-session.json`은 마지막으로 검증한 계정의 기록입니다. 다른 계정이나 이후 사용자 플레이로 달라진 상태는 게임 상세 화면을 보고 새로 확인해야 합니다. `progress.json`과 [예전 Mac 실행 도구 문서](docs/LANGRISSER-AUTOMATION.md)는 과거 자료이며 현재 진행 지침으로 사용하지 않습니다. 기존 CLI·Langrisser Pilot은 Windows용 제어 프로그램이 아니며, 이번 진행에서 사용하지 않습니다. 다른 PC의 실제 게임 제어는 아직 시험하지 않았습니다.

아래 iPad 도구는 이전 별도 작업의 소스입니다. PC 랑그릿사 진행에는 설치할 필요가 없습니다.

# 스타레일 아이패드 자동 진행

목표는 일반 시뮬레이션 우주와 차분화 우주에서 이동, 축복·기물·이벤트 선택,
다음 구역 진입을 처리하고 최종 결과 화면까지 진행하는 것이다.
전투는 게임 내 자동 전투에 맡기고, 선택은 최적화보다 완주를 우선한다.

아래는 이전 **화폐전쟁** 제어 작업의 구현·검증 기록이다.
아이패드 연결·화면 캡처·버튼 터치·캐릭터와 장비 드래그를 실기기로 검증했다.
화면은 에이전트가 확인하고 다음 동작을 결정한다. 독립 실행하는 화면 인식 루프,
자율 이동 및 자동 완주 프로그램은 아직 구현하지 않았다.

2026-09-25 확인: iPad Pro 13형(M4), iPadOS 27.0, 스타레일 4.5.0.
개발자 모드와 개인 개발팀 서명을 설정하고 WebDriverAgentRunner 설치까지 확인했다.
개발자 인증서 신뢰와 WDA 실행을 완료하고 Appium 세션으로 게임 제어에 성공했다.
화폐전쟁 기본 게임(자본의 제왕 5)의 저장 지점 2-1을 재개했으며,
경험치 구매·후방 배치·장비 장착·출전 후 게임 내 자동 전투까지 확인했다.
사용자가 게임 안에서 적용한 `[5 에너지, 4 낮의 반신] 신발 아글라이아 리세마라`
공략을 기준으로 진행한다. 핵심 장비는 아글라이아의 반중력 신발 2개와
낮·광속 프로펠러, 곽향의 영구 엔진이다. 공략은 V3.7이며 현재 게임이
일부 캐릭터 변경 경고를 표시하므로 실제 상점과 유대 설명을 함께 확인한다.

## 연결 준비

1. 맥에서 Xcode를 실행해 약관 동의와 최초 실행 설정을 마친다.
2. 아이패드를 USB로 연결하고 잠금을 해제한 뒤 이 컴퓨터를 신뢰한다.
3. Xcode에 기기를 연결한 뒤 아이패드의 설정 → 개인정보 보호 및 보안 → 개발자 모드를 켠다.
   재시작과 기기 내 확인이 필요할 수 있다.
4. `npm install` 후 `npm run doctor`로 개발 도구와 기기 목록을 확인한다.
5. Xcode에서 Apple 계정과 개발 서명을 설정해 WebDriverAgentRunner를 기기에 설치한다.
   무료 Apple 계정도 지원하지만 최초 서명 설정은 Xcode에서 수동으로 할 수 있다.
   Apple 계정 비밀번호를 이 프로젝트나 채팅에 저장할 필요는 없다.
6. `device.example.json`을 `device.local.json`으로 복사한다. 연결한 아이패드의 UDID,
   실제 설치된 스타레일의 bundle ID, 개발팀 ID, 서명된 WDA bundle ID를 입력한다.
   설치 지역별 bundle ID를 추측하지 말고 연결한 기기의 설치 앱 목록에서 확인한다.
7. 최초 설치 후 실행이 거부되면 아이패드 설정 → 일반 → VPN 및 기기 관리에서
   개발자 앱에 표시된 본인 Apple 계정을 신뢰한다. 기기가 요구하는 재시동과 확인을 완료한다.

`npm run server`는 프로젝트에 설치된 Appium을 맥의 `127.0.0.1:4723`에서 실행한다.
별도 터미널에서 `npm run device -- connect`를 실행하면 WDA를 통해 제어 세션을 만든다.
개발 인증서와 설치 프로필 생성을 승인한 뒤에만 설정의
`allowProvisioningDeviceRegistration`을 `true`로 설정한다. 이 설정은 Xcode가
테스트 실행용 프로필을 갱신하고 필요한 기기를 개발팀에 등록할 수 있게 한다.
개인 개발팀은 최초 서명 설정을 Xcode에서 먼저 진행한다.
이미 실행 중인 WDA가 있다면 설정의 `webDriverAgentUrl`로 연결할 수 있다.

## 입력 검증

```sh
npm run device -- capture
npm run device -- tap 0.5 0.5
npm run device -- drag 0.15 0.8 0.15 0.65 1000
npm run device -- disconnect
```

사용자가 완료 후 화면 끄기를 요청한 경우 결과와 보상 확인을 마친 뒤
`npm run device -- lock`으로 기기를 잠근다. 자동 잠금 해제 없이 잠금 상태를
조회하여 성공 여부를 확인한다. 아직 진행 중인 전투에서는 실행하지 않는다.

위 좌표는 문법 예시이며 게임 UI 위치를 검증한 값이 아니다. 실제 캡처를 보고 정한다.
좌표는 현재 화면의 왼쪽 위를 `(0, 0)`, 오른쪽 아래를 `(1, 1)`로 하는 비율이다.
기기 스크린샷 픽셀과 터치 좌표의 배율 차이는 Appium의 화면 크기로 변환한다.
연결한 iPad Pro의 가로 화면에서 캡처와 터치 방향이 일치함을 확인했다.
`drag`는 시작점에서 끝점으로 이동하고 정해진 시간 동안 누른 다음 놓는다.
게임이 전면에 있을 때만 입력한다. 캡처와 세션 기록은 `.runtime/`에 보관한다.

## 다음 검증 순서

1. 게임 화면 캡처 → 버튼 터치 → 조이스틱 이동과 카메라 회전 확인.
2. 두 모드에서 축복·기물·이벤트·전투·결과 화면의 실제 예시 수집.
3. 선택 화면은 간단한 우선순위로 처리하고, 전투는 종료까지 대기.
4. 짧은 이동마다 화면을 확인하며 출구로 접근하고 막힘을 감지해 방향 보정.
5. 각 모드에서 한 판 완주를 검증한 뒤 보상 목표까지 반복하도록 확장.

기기 연결과 실제 화면 없이 좌표나 화면 판별 규칙을 가정해서 완주 기능을 만들지는 않는다.
재화 교환·개척력 소비와 주간 보상 수령은 구분해서 구현해야 한다.

## 공식 참고 문서

- [Appium 프로젝트별 드라이버 설치](https://appium.io/docs/en/latest/guides/managing-exts/)
- [XCUITest 기기 설정](https://github.com/appium/appium-xcuitest-driver/blob/master/docs/getting-started/device-setup.md)
- [WDA 개발 서명](https://github.com/appium/appium-xcuitest-driver/blob/master/docs/getting-started/provisioning-profile/index.md)
- [XCUITest 조작 명령](https://github.com/appium/appium-xcuitest-driver/blob/master/docs/reference/execute-methods.md)
