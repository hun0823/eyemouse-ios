# 아이마우스 iOS

WebGazer wg10 테스트 페이지를 Capacitor WKWebView로 감싼 **Xcode iOS 프로젝트**입니다.

번들 ID: `com.zio.eyemouse`  
표시 이름: 아이마우스  
원본 웹: [https://jolly-gecko-arcade.s-h.day/?v=wg10](https://jolly-gecko-arcade.s-h.day/?v=wg10)  
로컬 웹 자산: `www/` (`eyemouse-web-wg10` 첨부 파일)

이 앱은 **앱 안 숏츠 시뮬레이션**입니다. YouTube·Instagram 위에 뜨는 오버레이가 아닙니다. WebGazer는 검증된 Eye Tracking API가 아닙니다.

---

## IPA는 이 저장소에 없습니다

이 환경은 **Linux**입니다. Xcode / Apple 코드서명이 없어 **IPA를 빌드하거나 서명하지 않았습니다.**

- iOS 바이너리는 **macOS + Xcode** (또는 **GitHub Actions `macos-*`** 같은 클라우드 Mac)에서만 컴파일됩니다.
- **맥이 없을 때 추천:** [`docs/MAC없이-배포.md`](docs/MAC없이-배포.md) — `git push` → **Actions**에서 미서명 IPA 다운로드 → **Sideloadly**(Windows) / SideStore(iPhone).
- Workflow: [`.github/workflows/ios-sideload.yml`](.github/workflows/ios-sideload.yml) (`main` push 또는 Actions에서 수동 실행).

`scripts/mac-archive.sh`는 **로컬 Mac**에서 서명 IPA를 만들 때만 씁니다.

---

## Mac에서 Xcode로 열기

필요: macOS, [Xcode](https://developer.apple.com/xcode/) 16 이상, 무료 Apple ID.

```bash
git clone <이-저장소>
cd eyemouse-ios   # 또는 클론한 폴더
npm install
npx cap sync ios
open ios/App/App.xcodeproj
```

CocoaPods는 쓰지 않습니다. iOS 의존성은 **Swift Package Manager**(CapApp-SPM)입니다. Xcode가 처음 열 때 `capacitor-swift-pm` 패키지를 받습니다.

1. 왼쪽에서 타깃 **App** → **Signing & Capabilities**
2. **Team**에 본인 Apple ID(Personal Team)를 고릅니다.
3. Bundle Identifier가 `com.zio.eyemouse`인지 확인합니다. 무료 계정에서 “Failed to register bundle identifier”가 나면 뒤에 `.이름`을 잠시 붙인 뒤, 가능하면 다시 `com.zio.eyemouse`로 맞추세요.
4. 기기를 USB로 연결하고 상단 scheme을 **App**, destination을 아이폰으로 둡니다.
5. ▶ Run

첫 실행 후 아이폰에서 **설정 → 일반 → VPN 및 기기 관리**(또는 프로파일)에서 개발자 앱을 신뢰하세요. iOS 16+는 **설정 → 개인정보 보호 및 보안 → 개발자 모드**도 켜야 합니다.

앱을 연 뒤 **앞 카메라 시작**을 누르면 시스템 카메라 허용 창이 뜹니다. 거절하면 설정 → 아이마우스 → 카메라에서 다시 켤 수 있습니다.

---

## 무료 Apple ID · 7일 설치

유료 Apple Developer Program($99/년) 없이 Personal Team으로 설치할 수 있습니다.

| 제한 | 내용 |
| --- | --- |
| 유효 기간 | **7일**. 지나면 홈 화면 아이콘을 눌러도 열리지 않습니다. |
| 다시 설치 | Mac에서 Xcode ▶ Run, 또는 아래에서 만든 IPA를 Sideloadly/AltStore로 다시 넣습니다. |
| 앱 개수 | 무료 계정은 기기에 동시에 **약 3개** 개발자 앱만 유지되는 경우가 많습니다. |
| 기기 수 | Apple이 등록 기기 수를 제한할 수 있습니다. |
| App Store | 무료 계정으로는 스토어 배포가 불가능합니다. |

7일이 지나기 전에 같은 Apple ID로 다시 서명하면 기간이 연장됩니다.

---

## Sideloadly (Windows 또는 Mac)

Sideloadly는 **이미 만들어진 `.ipa`** 에 Apple ID로 다시 서명해서 아이폰에 넣습니다.  
**이 저장소만으로는 Windows에서 IPA를 만들 수 없습니다.** 먼저 Mac(또는 macOS CI)에서 IPA를 만든 뒤, 그 파일을 Windows로 복사하세요.

1. Mac에서 아래 “IPA 만들기”를 따라 `.ipa`를 받습니다.
2. [Sideloadly](https://sideloadly.io/)를 설치하고 iTunes/Apple Devices가 있는지 확인합니다.
3. 아이폰을 USB로 연결하고 신뢰합니다.
4. IPA를 Sideloadly 창에 넣고 Apple ID로 로그인합니다.
5. Bundle ID는 `com.zio.eyemouse`를 유지하는 것을 권장합니다.
6. Start. 설치 후 기기 관리에서 해당 Apple ID를 신뢰합니다.

무료 Apple ID로 넣은 앱은 **7일 후 만료**됩니다. 같은 IPA를 다시 넣으면 됩니다.

---

## AltStore

1. Mac 또는 PC에 [AltServer](https://altstore.io/)를 설치합니다.
2. 아이폰에 AltStore를 설치합니다(같은 Wi-Fi, Mail 플러그인 또는 안내에 따른 방식).
3. Mac에서 만든 `.ipa`를 아이폰의 AltStore → **My Apps → +** 로 설치합니다.
4. 무료 계정은 **7일마다** AltStore가 켜진 상태에서 갱신해야 합니다. 백그라운드 갱신이 실패하면 직접 Refresh 하세요.

---

## Mac에서 IPA 만들기

Xcode GUI:

1. 메뉴 **Product → Destination → Any iOS Device**
2. **Product → Archive**
3. Organizer에서 **Distribute App**
4. **Development**(같은 Apple ID 기기) 또는 **Ad Hoc**(등록된 기기) 또는 **Custom**
5. 자동 서명을 고르고 IPA를 보냅니다.

터미널 (Team ID 필요):

```bash
DEVELOPMENT_TEAM=여기에TeamID ./scripts/mac-archive.sh
```

Team ID는 Xcode → Signing & Capabilities 또는 [Apple Developer](https://developer.apple.com/account) Membership에서 봅니다.

유료 프로그램이 있으면 Ad Hoc / Development IPA를 Sideloadly에 넣거나, TestFlight로 배포할 수 있습니다.  
**App Store Connect 업로드와 스토어 심사는 이 README 범위 밖입니다.**

---

## 카메라 · 네트워크

`Info.plist`에 다음이 들어 있습니다.

- `NSCameraUsageDescription` — 전면 카메라로 시선 추정. 영상은 기기 안에서만 처리.
- `NSMicrophoneUsageDescription` — iOS `getUserMedia`가 카메라와 함께 요구하는 경우가 있어 넣었습니다. 앱은 녹음하지 않습니다.

WebGazer 얼굴 모델(약 10MB)과 스크립트는 `cdn.jsdelivr.net`에서 받습니다. **첫 실행에 네트워크가 필요**합니다. 맞춤 데이터는 기기의 localStorage / localforage에만 남습니다.

---

## 프로젝트 구조

```
www/                         첨부 wg10 웹 (index.html, app.js, style.css, mp.html, mp.js)
capacitor.config.json        appId com.zio.eyemouse, iOS scheme https (getUserMedia용)
ios/App/App.xcodeproj        Mac에서 여는 Xcode 프로젝트
ios/App/App/Info.plist       카메라/마이크 사용 설명
ios/App/App/EyeMouseViewController.swift
ios/App/CapApp-SPM           Capacitor SPM 래퍼
scripts/mac-archive.sh       Mac 전용 IPA 아카이브 (Linux에서 실패)
scripts/preview-www.py       웹 페이지만 브라우저로 미리보기
```

웹을 고친 뒤:

```bash
npx cap sync ios
```

---

## 웹만 미리보기 (이 Linux/개발 PC)

아이폰 앱이 아니라 **번들된 웹 페이지**입니다. HTTPS가 아니면 일부 브라우저에서 카메라가 막힐 수 있습니다. `localhost`는 보통 허용됩니다.

```bash
npm run preview
# http://127.0.0.1:43127/?v=wg10
```

---

## 요구 사항 요약

| 하고 싶은 일 | 가능한 곳 |
| --- | --- |
| 소스 보고 Xcode 프로젝트 열기 | Mac |
| 무료 Apple ID로 7일 설치 | Mac + Xcode + 아이폰 |
| Sideloadly / AltStore에 넣을 IPA | Mac 또는 유료 macOS CI로 먼저 빌드 |
| 이 Linux VM에서 IPA 출력 | **불가. 만들지 않았습니다.** |
| Windows만으로 미서명 IPA 생성 | **불가.** Sideloadly는 이미 있는 IPA를 서명합니다. |
