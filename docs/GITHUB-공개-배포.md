# GitHub public `hun0823/eyemouse-ios` 배포

## 저장소 URL (목표)

**https://github.com/hun0823/eyemouse-ios** (public)

현재 VM에는 GitHub 인증이 없으면 push가 되지 않습니다. `GH_TOKEN`을 Cursor Secrets에 넣은 뒤:

```bash
export GH_TOKEN=...   # 또는 Secrets 주입
./scripts/github-publish-and-build.sh
```

---

## Actions · IPA 받기

| 항목 | URL |
| --- | --- |
| 저장소 | https://github.com/hun0823/eyemouse-ios |
| Actions 목록 | https://github.com/hun0823/eyemouse-ios/actions |
| Sideload workflow | https://github.com/hun0823/eyemouse-ios/actions/workflows/ios-sideload.yml |

**수동 실행:** 위 workflow 페이지 → **Run workflow** → branch `main` → Run.

**자동 실행:** `main`에 `www/`, `ios/`, workflow 파일 등이 push되면 시작.

**IPA 다운로드:** 완료된 run → 하단 **Artifacts** → `eyemouse-ios-unsigned-<번호>.ipa` (30일 보관).

---

## Sideloadly (짧은 절차)

1. PC에 [Sideloadly](https://sideloadly.io/) · Apple USB 드라이버 설치  
2. iPhone USB 연결 · **신뢰**  
3. 다운로드한 `.ipa`를 Sideloadly에 넣고 **무료 Apple ID** 로그인  
4. Bundle ID **`com.zio.eyemouse`** 유지 → **Start**  
5. iPhone **설정 → 일반 → VPN 및 기기 관리**에서 개발자 **신뢰** · **개발자 모드** 켜기  
6. **7일** 후 만료 → 같은 IPA로 재설치

---

## Origin vs GitHub

Origin draft (`cursor.com/codebase/...`)는 private이며 GitHub Public과 별개입니다. **Actions IPA 경로는 GitHub public repo 기준**입니다.
