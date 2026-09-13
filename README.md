# Uro Daily Pick

비뇨의학 논문 수집, 개인화 추천, 한국어 AI 요약, 연구 컬렉션, 이메일 다이제스트 서비스입니다. React/Vite, Supabase, Python 배치 작업을 사용합니다.

## 실행

Node.js 24 (`.nvmrc`)와 Python 3.12를 사용합니다.

```sh
python -m venv .venv
# 가상환경을 활성화한 후
python -m pip install -r scripts/requirements-dev.txt
cd frontend
npm ci
npm run dev
```

설정 항목은 루트와 `frontend/`의 `.env.example`을 참고하세요. Python 작업은 환경변수를 읽으며 `.env` 파일을 자동으로 읽지 않습니다. 프론트엔드 설정을 생략하면 기존 운영 Supabase의 공개 URL/키를 사용합니다. 개발 데이터 쓰기에는 별도 staging 프로젝트를 설정하세요. 서비스 키·모델 키·출판사 키는 `VITE_*` 변수에 넣지 않습니다.

## 검증

```sh
python -m unittest discover -s tests -v
cd frontend
npm run check
npx playwright install chromium
npm run test:e2e
```

테스트는 운영 DB·Gemini·Resend에 접속하지 않습니다. Windows의 설치된 Chrome을 사용하려면 `$env:PLAYWRIGHT_CHANNEL = 'chrome'`을 설정합니다. 자세한 범위는 [테스트 안내](tests/README.md)를 참고하세요.

## 데이터 흐름

매일 06:00 KST에 `daily-fetch.yml`이 수집 → 분류 → 요약 → 추천 → 메일을 순서대로 실행합니다. 이전 단계가 실패하면 다음 단계는 실행되지 않습니다. 추천·메일 전용 workflow는 수동 실행용이며 모든 배치는 같은 동시 실행 그룹을 사용합니다.

Z8 원문 작업기는 공개 원문, Elsevier 공식 API, 권한 있는 로컬 PDF/HTML/XML 파일을 지원합니다. 파싱된 원문은 서비스 역할만 접근하는 저장소에 보관합니다.

```sh
# 공개 원문 다운로드·파싱만 확인 (DB 저장 없음)
python scripts/fulltext.py --pmid 39668103

# 기관에서 받은 파일의 파싱 결과를 비공개 저장 (서비스 환경변수 필요)
python scripts/fulltext.py --pmid YOUR_PMID --input "C:/Downloads/article.pdf" --publish

# 기관망/기관 토큰과 Elsevier API 키가 준비된 경우
python scripts/fulltext.py --pmid YOUR_PMID --provider elsevier --publish
```

요약 작업은 `SUMMARY_SOURCE=fulltext`로 실행하며 비공개 테이블에서 준비된 본문만 Gemini에 보냅니다. 원문이 없는 논문은 대기 상태로 남고 초록으로 대체하지 않습니다. `SUMMARY_PMID`로 지정한 논문의 본문이 없으면 작업이 실패합니다. 화면은 검증된 본문 요약을 목적·설계, 결과, 한계의 세 줄로 표시하고, 기존 초록 요약은 출처를 구분해 접어서 보관합니다. 별도의 이전 방식 실행이 필요할 때만 `SUMMARY_SOURCE=abstract`를 명시하며, 이 모드는 기존 본문 요약을 덮어쓰지 않습니다.

새 DB는 migration `001`부터 `009`까지, 기존 `005` 적용 DB는 `006`–`009`를 순서대로 한 번 적용합니다. GitHub Pages 배포는 CI 검증 후 진행됩니다. [운영 반영 안내](docs/service-readiness.md)와 [원문 접근 조사](docs/fulltext-assessment.md)에 설정·검증 범위·제한을 정리했습니다.
