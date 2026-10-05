# 맥 없이 아이폰 테스트용 앱 만들기 · 커밋 · 배포

아이마우스는 이미 **Capacitor iOS 프로젝트**(`ios/App/App.xcodeproj`)와 **웹 자산**(`www/`)이 저장소에 있습니다.  
**맥이 없어도** iPhone에 넣을 `.ipa`는 **클라우드 macOS**에서만 만들 수 있습니다. Linux/Windows만으로는 `.app`/`.ipa` 컴파일이 불가능합니다.

---

## 한 줄 요약 (추천 경로)

| 단계 | 어디서 | 무엇을 |
| --- | --- | --- |
| 1. 개발 | Linux / Windows / Cursor | `www/` 수정 → `git commit` → `git push` |
| 2. 빌드 | **GitHub Actions** (`macos-15`) | `.github/workflows/ios-sideload.yml` → **미서명 IPA** 아티팩트 |
| 3. 설치 | Windows + Sideloadly, 또는 iPhone SideStore | 무료 Apple ID로 **재서명** 후 기기 설치 |
| 4. 갱신 | 7일마다 | 같은 IPA 다시 Sideloadly / SideStore 갱신 |

**이 저장소에 IPA 파일을 커밋하지 않습니다.** 바이너리는 Actions **Artifacts**로 받습니다.

---

## 경로 A — GitHub Actions + Sideloadly (무료 Apple ID, $99 불필요)

### 전제

- **Public GitHub:** https://github.com/hun0823/eyemouse-ios (`docs/GITHUB-공개-배포.md`)
- GitHub(또는 Actions를 켤 수 있는 Git 호스팅)에 이 저장소 push
- GitHub **Actions** 사용 가능 (공개 repo는 macOS 분 무료 할당 있음 · [GitHub Actions 요금](https://docs.github.com/en/billing/managing-billing-for-github-actions/about-billing-for-github-actions) 확인)
- 본인 **무료 Apple ID** (Sideloadly/SideStore가 설치 시 서명)

### 1) 코드 커밋 · push

```bash
# 웹/UI 수정은 www/ 에서
git add www/ ios/ capacitor.config.json
git commit -m "wg10 웹 수정"
git push origin main
```

`main`에 `www/**`, `ios/**` 등이 바뀌면 workflow가 **자동 실행**됩니다.  
수동 실행: GitHub → **Actions** → **iOS IPA (Sideload / 무료 Apple ID)** → **Run workflow**.

### 2) IPA 다운로드

1. 완료된 workflow run 클릭  
2. **Artifacts** → `eyemouse-ios-unsigned-<번호>.ipa`  
3. PC 또는 iPhone으로 파일 옮김

### 3) Windows에서 Sideloadly

1. [Sideloadly](https://sideloadly.io/) + Apple 기기 USB 드라이버(Apple Devices / iTunes)  
2. iPhone USB 연결 · **신뢰**  
3. IPA 드래그 · Apple ID 로그인 · Bundle ID `com.zio.eyemouse` 유지  
4. **Start** → iPhone **설정 → 일반 → VPN 및 기기 관리**에서 개발자 신뢰  
5. **개발자 모드** (iOS 16+) 켜기  

**7일** 후 만료 → 같은 IPA로 다시 Sideloadly.

### 4) 맥 없이 갱신만 (SideStore / LiveContainer)

- PC 없이 iPhone만으로 갱신하려면 **SideStore** + (선택) **LiveContainer** 같은 sideload 도구가 필요합니다.  
- GitHub Actions에서 받은 IPA URL/파일을 SideStore로 import하는 방식이 일반적입니다.  
- 무료 Apple ID 한계: 동시 앱 ID **약 3개**, 주간 등록 제한 등 ([Apple sideload 제한](https://developer.apple.com/support/compare-memberships/) — Personal Team).

---

## 경로 B — Codemagic / Bitrise (맥 대신 유료 CI)

맥은 없지만 **Apple Developer Program ($99/년)** 이 있으면:

| 서비스 | 역할 |
| --- | --- |
| [Codemagic](https://codemagic.io/) | macOS 클라우드에서 빌드 · 인증서/프로비저닝 자동 생성(Mac 불필요) · TestFlight 업로드 |
| [Bitrise](https://bitrise.io/) | macOS 스택 빌드 · 테스터용 설치 링크(Ad Hoc / Development IPA) |

설정 개요:

1. 저장소 연결 · `npm ci` · `npx cap sync ios`  
2. Apple Developer Portal / App Store Connect API 키 연동  
3. **Development** 또는 **Ad Hoc** 프로비저닝 → **서명된 IPA**  
4. TestFlight 또는 Bitrise 설치 링크로 테스터 배포  

**무료 Personal Team만** 있을 때는 Codemagic 자동 서명이 제한적일 수 있어, **경로 A(미서명 IPA + Sideloadly)** 가 현실적입니다.

---

## 경로 C — TestFlight / App Store (팀·유료 계정)

- **$99/년** Developer Program  
- CI(GitHub `macos-*`, Codemagic 등)에서 **서명 + Archive + App Store Connect 업로드**  
- 테스터는 **TestFlight** 앱만 설치 (Sideloadly 불필요)  
- `scripts/mac-archive.sh`는 **Mac 로컬**용; CI에서는 Xcode + API 키 또는 `xcodebuild -exportArchive` 패턴 사용  

---

## 경로 D — 앱 설치 없이 WebGazer만 테스트 (가장 가벼움)

맥·IPA·7일 갱신이 부담이면:

- 배포된 HTTPS 페이지: [https://jolly-gecko-arcade.s-h.day/?v=wg10](https://jolly-gecko-arcade.s-h.day/?v=wg10)  
- iPhone **Safari**에서 열기 (카메라는 사용자 탭 후)  

네이티브 WKWebView 래퍼와 동작은 비슷하지만, **홈 화면 아이콘 앱**은 아닙니다.

---

## “커밋 배포”가 의미하는 것 (이 프로젝트 기준)

| 가능 | 불가능 (맥/Apple SDK 없이) |
| --- | --- |
| `git push` → Actions가 IPA 빌드 | Windows/Linux에서 `.ipa` 직접 컴파일 |
| Artifacts / CI 링크로 IPA 배포 | repo에 서명된 IPA 영구 커밋 (용량·보안·만료) |
| Sideloadly로 기기 설치 | Xcode 없이 App Store 제출 |

**권장 루프:** 코드 push → Actions IPA → Sideloadly 설치 → 카메라/WebGazer 확인 → 7일 전 재설치.

---

## 문제 해결

| 증상 | 확인 |
| --- | --- |
| Actions가 macOS에서 실패 | Run 로그의 `xcodebuild` · SPM 패키지 resolve · Xcode 15+ |
| `mediaDevices` undefined | 설치 후 **카메라·마이크** 권한 · `Info.plist` 문구 (이미 포함) |
| WebGazer 모델 실패 | **Wi‑Fi** (cdn.jsdelivr.net) · 첫 실행 ~10MB 다운로드 |
| Sideloadly 서명 실패 | Bundle ID 충돌 → workflow 입력에서 다른 ID 시도 |
| 7일 후 실행 안 됨 | 정상 · IPA 재설치 또는 SideStore refresh |

---

## 관련 파일

- `.github/workflows/ios-sideload.yml` — 미서명 IPA 빌드  
- `README.md` — Mac 로컬 Xcode · Sideloadly 상세  
- `scripts/mac-archive.sh` — **Mac이 있을 때만** 서명 IPA  

**IPA는 이 Linux 에이전트 VM에서 생성하지 않았습니다.** GitHub에 push한 뒤 Actions run에서 받으세요.
