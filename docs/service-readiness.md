# 서비스 개선 및 운영 반영 기록

검증일: 2026-09-13. 기존 공개 가입 서비스를 기준으로 구현했습니다. **로컬 코드와 테스트를 완료했으며, 운영 DB migration·GitHub 배포·실제 이메일 발송은 수행하지 않았습니다.**

## 완료한 변경

| 영역 | 변경 |
|---|---|
| 인증 | 가입 이메일 확인 안내, 프로필 로딩 재시도, 계정 전환 시 이전 프로필 배제, 비밀번호 재설정 실패 처리 |
| 추천 | 과거 날짜에 현재 추천을 넣던 오류 수정, JSON 정규화, 모바일 상세·뒤로가기, 저장 실패 시 피드백 상태 유지 |
| 컬렉션 | 생성·삭제 확인, 논문 검색·추가·제거, 실패 표시, 이전 조회 응답 무시 |
| 설정 | DB 성공 이후에만 저장 표시, 주제·저자·저널 알림을 추천에 반영, 확인된 계정 이메일 변경 |
| 개인정보 | 신규 계정의 명시적 메일 수신 선택, 본인 계정과 관련 사용자 데이터의 연쇄 삭제, 개인정보·연구 이용 안내 |
| 접근성 | 초점·입력 이름·토글 상태·키보드 스크롤·색 대비·작은 화면·움직임 줄이기 |
| 분류 | 임상 단계만으로 RCT를 추정하지 않음, 출판 유형을 태그로 덮어쓰던 오류 수정 |
| 요약 | 형식 검증·재시도, 초록/원문 구분, 모델·시각·입력 hash, 3,000자 임의 절단 제거 |
| DB | 관리자 RPC 권한, 원자적 피드백/컬렉션 저장, 원자적 추천 교체, 원문·메일 payload 비공개 |
| 메일 | 확인된 계정 주소, 주간 7일 논문 중복 제거, 사용자·날짜별 발송 기록·idempotency |
| 운영 | 순차 배치·오류 종료·pagination, 의존성 고정·Node 24·lock 설치·CI 통과 후 배포 |

미확인 별도 다이제스트 주소에는 발송하지 않습니다. `digest_email_address` 컬럼은 기존 호환성을 위해 남겨 두지만 발송에는 확인된 계정 이메일을 사용합니다. 기존 수신 설정은 유지하고 신규 계정 기본값만 false로 바꿉니다.

## 검증

- 프론트엔드 단위·사용자 흐름 13개 통과.
- Python 파이프라인·원문·발송 계약 테스트 22개 통과.
- PGlite PostgreSQL에서 9개 migration 통과: 익명/일반 사용자/미확인 관리자 접근, 트랜잭션 롤백, 비공개 RLS, 계정 삭제 cascade.
- Chrome 5개 회귀 테스트 통과: 1440px·390px·320px의 10개 화면, axe WCAG A/AA 위반·문서 가로 넘침 0건, 모바일 피드백·뒤로가기, 컬렉션 생성·논문 추가·삭제.
- 프로덕션 빌드 통과, 화면별 lazy loading. `npm audit`의 알려진 프론트엔드 취약점 0건.
- Z8 공개 원문 실험: PMID `39668103` / PMC `11862828`, XML 38,985자·11개 섹션 추출. DB 게시·모델 전송 없음.
- 기관 ScienceDirect HTML 접근은 앞선 실험에서 확인. Elsevier 공식 API 연결 코드는 구현했지만 키가 없어 실제 기관 API 응답은 미검증.

## 운영 반영 순서

1. **DB 이력·백업:** 기존 schema와 migration 이력을 확인합니다. `files/`의 미완성 프로토타입 SQL을 운영 migration과 혼합하지 않습니다. 복구 가능한 백업을 확보합니다.
2. **Migration:** 기존 `001`–`005` 이후 `006_rpc_authorization.sql`, `007_digest_preferences.sql`, `008_service_contracts.sql`, `009_fulltext_storage.sql`을 순서대로 한 번 적용합니다. JSON 정규화·인덱스 생성이 있어 배치와 겹치지 않는 시간에 반영합니다.
3. **인증:** Supabase 이메일 확인·이메일 변경 확인을 활성화합니다. 앱 루트, `reset-password`, `settings` URL을 redirect 허용 목록에 등록하고 운영 SMTP·가입 rate limit을 점검합니다.
4. **환경변수:** 아래 설정을 등록합니다. `FROM_EMAIL`은 Resend에서 검증된 발신 도메인의 주소가 필수입니다.
5. **Staging 실행:** 메일을 제외한 수집·분류·요약·추천을 먼저 실행합니다. 과거 오분류는 `RECLASSIFY_ALL=true`로 분류 작업을 한 번 실행해 재계산할 수 있습니다. PubMed 요청과 DB 수정이 발생합니다.
6. **실제 계정 확인:** 가입 확인 → 온보딩 → 추천·피드백 → 컬렉션 → 비밀번호·이메일 확인 → 테스트 계정 삭제. 운영자가 관리하는 수신 계정으로 메일과 재실행 중복 방지를 확인합니다.
7. **배포:** DB 계약을 먼저 반영한 후 프론트엔드·workflow를 배포합니다. CI 실패 시 Pages 배포를 중단합니다. `python scripts/check_service.py`로 API 계약과 최근 수집 시각을 읽기 전용으로 확인합니다.

| 위치 | 설정 |
|---|---|
| GitHub secrets / Z8 | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` |
| GitHub secrets | `GEMINI_API_KEY`, `RESEND_API_KEY` |
| GitHub variables | `FROM_EMAIL` 필수. `APP_URL`은 기본 기존 Pages URL |
| GitHub variables | `GEMINI_MODEL` 기본 `gemini-2.5-pro`, `SUMMARY_BATCH_SIZE` 기본 100 |
| Summary source | workflow의 `SUMMARY_SOURCE=fulltext`; 준비된 본문만 요약, 초록 대체 없음 |
| GitHub variables / Z8 | `NCBI_EMAIL` |
| Z8 | `ELSEVIER_API_KEY`, 필요한 경우 `ELSEVIER_INST_TOKEN` |
| 프론트엔드 staging | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` — 공개 키만 사용 |

## 장애 복구

메일 payload는 최초 요청 전에 고정하고 같은 payload·키로 재시도합니다. `sent`는 다시 보내지 않습니다. Resend idempotency는 24시간 유지되므로 23시간이 지난 `pending`은 자동 재시도를 거절합니다. Resend 기록과 대조해 실제 발송 여부를 확인한 뒤 처리해야 합니다. 중복 방지 기록을 지우고 무작정 재실행하지 않습니다. [Resend 공식 문서](https://resend.com/docs/dashboard/emails/idempotency-keys)

수집 부분 실패 시 성공한 논문을 보존하고 작업은 실패로 보고합니다. 요약 예산을 넘는 대기 논문 수를 로그로 출력하며 다음 실행에서 이어갑니다. 실패한 원문 import는 기존 정상 본문을 덮어쓰지 않습니다. `check_service.py`는 새 논문이 없는 기간에도 오래된 수집 시각을 보고할 수 있어 배치 로그와 함께 판단합니다. 브라우저 강제 종료 시 마지막 읽기 구간은 누락될 수 있습니다.

## 원문 작업기와 검증 한계

- Europe PMC OA XML, Elsevier `view=FULL` XML, 권한 있는 로컬 PDF/HTML/XML을 지원합니다. 원문은 서비스 역할 전용 테이블에 저장하며 프론트엔드에는 요약·출판사 링크만 표시합니다.
- 입력 20MB, PDF 300페이지, 추출 60만자 제한. 로그인/접근 확인 HTML, 초록만 있는 JATS, 텍스트 없는 스캔 PDF는 정상 게시하지 않습니다.
- 로컬 파일과 PMID의 일치는 운영자가 확인해야 합니다. 복잡한 PDF 표·수식·다단 편집·스캔 OCR의 정확한 복원을 보장하지 않습니다. 본문 길이만으로 모든 출판사 HTML의 완전성을 판별할 수 없습니다.
- 기관 API 권한은 브라우저 구독 권한과 별도입니다. Wiley 등 다른 출판사의 자동 TDM 연결과 Z8 무인 스케줄은 구성하지 않았습니다. 로컬 파일 import를 사용할 수 있습니다. [Elsevier 공식 API](https://dev.elsevier.com/documentation/ArticleRetrievalAPI.wadl)
- 실제 Supabase 인증 메일·발신 도메인·기관 API·운영 복구는 staging 확인이 필요합니다. 자동 접근성 검사만으로 완전한 접근성을 보장하지 않습니다.
- 현재 배치 추천 후보 500편·최근 읽기 200건, 신규 사용자 화면 후보 300편입니다. 대규모 사용자 부하·상용 모니터링·백업 복원 훈련은 검증 범위에 포함되지 않습니다.

## 추가 운영 점검 — 2026-09-13

GitHub 원격 main의 450b960 커밋과 2026-08-01 운영 실패 로그를 확인했습니다. 당시 요약 작업은 Supabase HTTP 522로 종료됐습니다. 해당 원격 변경의 재시도 의도를 공통 DB 조회 함수에 통합해 522·일시적 네트워크 오류·빈 JSON 응답을 최대 4회 처리하고, 권한 오류는 즉시 실패하도록 했습니다. 분류·요약 조회는 100개씩 나누고 원문 본문은 논문별로 읽습니다. 실제 운영 DB 계약과 수집 시각 검사에 실패하면 Pages 배포를 중단합니다.

운영 Supabase 관리 화면은 로그인 대기 중이며, 운영 DB 변경·인증 설정·배포·실제 발송 완료를 의미하지 않습니다.

공개 서비스 URL은 HTTP 200으로 응답했지만 운영 Supabase의 인증 설정 및 공개 논문 조회는 모두 HTTP 504를 반환했습니다. 관리 화면에서 프로젝트 상태를 확인하고 DB가 복구된 뒤 migration과 실제 계정 검증을 진행해야 합니다.

Supabase 새 secret API 키와 기존 service_role JWT를 모두 지원합니다. 새 키는 apikey 헤더로만 보내고 JWT만 Bearer 인증에 사용합니다. [공식 API 키 문서](https://supabase.com/docs/guides/getting-started/api-keys)
