# 홀덤 토너먼트 승률·액션 계산기 (근사)

6인 토너먼트(BB 앤티 1bb)에서 내 포지션·핸드·스택과 상대 액션을 입력하면
169개 핸드의 액션 빈도, EV, 승률, 팟 획득 확률을 보여주는 계산기예요.
**근사 계산**이며 GTO 솔버 결과가 아니에요.

- 파일 하나(`index.html`)로 동작, 서버 없음. 계산은 Web Worker에서 실행.
- **ICM(순위 점수)**: 남은 인원(최대 6명)의 순위 점수로 칩 가치를 환산. 기본 점수 1~6등 `8,5,3,2,1,0`.
- **PWA**: 안드로이드 크롬에서 열고 "홈 화면에 추가"하면 앱처럼 설치되고 오프라인에서도 동작.

## 폰에 설치 (GitHub Pages)

1. 이 저장소 → Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `(root)` → Save
2. 1~2분 뒤 `https://huskey38.github.io/POKERTEST/` 접속
3. 안드로이드 크롬 메뉴(⋮) → **앱 설치** 또는 **홈 화면에 추가**

수정 후 배포할 때는 `sw.js`의 `VERSION`을 올려야 폰에 새 버전이 반영돼요.

## 파일

| 파일 | 내용 |
|---|---|
| `index.html` | 화면 + 계산 엔진 + 데이터(JSON 블록: 레인지, 사이즈, 상대 대응, 빈도, 좁히기, EV) |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA 설치·오프라인 캐시 |
| `holdem-calculator-claude-code-tasks.md` | 원래 작업 지시서 |

앱 안 "⋯ 예제·저장·도구 → 자체 검증"에서 테스트를 실행할 수 있어요.
