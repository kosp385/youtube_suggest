# 여행지 유튜브 분석기

유튜브 영상을 자동으로 수집하고 Claude AI가 맛집·호텔·관광지를 정리해주는 분석 도구입니다.

## 실행 방법

### 1. VS Code에서 바로 열기
```bash
# 폴더를 VS Code로 열기
code travel-analyzer

# 또는 폴더 안에서
code .
```

### 2. Live Server로 실행 (추천)
VS Code 확장 프로그램 **Live Server** 설치 후:
- `index.html` 우클릭 → **Open with Live Server**
- 브라우저에서 `http://localhost:5500` 자동 열림

### 3. 간단하게 열기 (API 없이 데모)
`index.html`을 브라우저에 그냥 드래그해도 데모 모드는 실행됩니다.

---

## API 키 발급

### Claude API Key
1. https://console.anthropic.com 접속
2. API Keys → Create Key
3. `sk-ant-...` 형식의 키 복사

### YouTube Data API Key
1. https://console.cloud.google.com 접속
2. 새 프로젝트 생성
3. API 및 서비스 → 라이브러리 → "YouTube Data API v3" 검색 → 사용 설정
4. 사용자 인증 정보 → API 키 생성

> **참고**: YouTube API는 하루 10,000 유닛 무료. 검색 1회 = 100 유닛 소모.
> 도시 1개 분석 시 약 600~1,200 유닛 사용 (하루 8~16개 도시 분석 가능).

---

## 기능

- **유튜브 자동 검색**: 최근 1년 영상만 필터링
- **협찬 영상 필터**: 제목/설명에서 협찬 키워드 자동 감지 및 제외
- **한국어 + 현지어**: 두 언어로 동시 검색해 더 다양한 정보 수집
- **Claude AI 분석**: 장소명, 추천 이유, 가격대, 방문 팁 자동 추출
- **JSON 저장**: 분석 결과를 JSON 파일로 저장/복사
- **카테고리 필터**: 맛집/호텔/관광지 별도 보기

---

## 파일 구조

```
travel-analyzer/
├── index.html   # 메인 HTML
├── style.css    # 스타일
├── app.js       # 로직 (YouTube API + Claude API)
└── README.md    # 이 파일
```

---

## 주의사항

- API 키는 브라우저 로컬스토리지에만 저장되며 외부로 전송되지 않습니다
- CORS 이슈가 발생하면 Live Server 사용을 권장합니다
- YouTube API 할당량 초과 시 다음날 자정(태평양 시간) 초기화됩니다
