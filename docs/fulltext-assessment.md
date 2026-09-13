# Z8 원문 수집 검토 — 2026-09-13

## 결론과 실제 확인 범위

현재 PC는 HP Z8 G4 Workstation이다. Z8의 브라우저에서 ScienceDirect가 기관 구독 접근을 인식했다. 따라서 기관망에서 원문을 수집하는 방향은 타당하다. 모든 저널의 다운로드 권한이나 자동 수집 성공률까지 검증한 것은 아니다.

| 검사 | 결과 |
| --- | --- |
| Europe PMC 검색 API | Z8에서 정상 연결, PMID/DOI/원문 링크 조회 성공 |
| European Urology, DOI `10.1016/j.eururo.2026.07.017` | 기관 인증 및 `Full text access` 확인, HTML 본문 4,255자 추출 확인 |
| 위 논문의 PDF 링크 | 내려온 파일은 PDF가 아닌 HTML 자동화 확인 페이지. 직접 HTTP 요청도 403. PDF 다운로드 성공으로 기록하면 안 됨 |
| DOI `10.1016/j.eururo.2026.08.012` | HTML 본문·Methods·Results·Discussion·표 접근 확인. 검색 API는 구독 필요로 표시했지만 출판사 페이지는 OA로 표시함 |
| Python 네트워크 | 기본 requests는 일부 도메인에서 기관 인증서 검증 오류. Windows 신뢰 저장소를 사용하는 Python SSL context는 인증서 검증을 통과했으나 PDF 요청은 403 |

첫 번째 논문은 접근 검사용 Letter이다. 현재 추천 파이프라인에서 Letter를 제외하는 정책을 변경하지 않았다. PDF 파일 자체의 텍스트·표 추출 품질은 아직 실물 파일로 검증하지 못했다. TLS 검증을 끄거나 사이트 확인 절차를 우회하지 않았다.

## 기존 코드의 상태

운영 파이프라인은 `scripts/fetch_papers.py`에서 PubMed 제목·초록을 수집하고, `scripts/summarize_papers.py`에서 초록의 앞 3,000자만 요약한다. 원문 다운로드 단계는 없다.

`files/server.py`, `files/004_fulltext.sql`, `files/summarize_papers_v2.py`는 Git에서 제외된 초안이며 현재 workflow에서 실행되지 않는다. 이 초안은 다음 보완이 필요하다.

1. Unpaywall에서 URL만 찾아도 `fetched`로 저장한다. 실제 파일 다운로드·본문 검증·파싱 성공 후에만 완료 처리해야 한다.
2. Elsevier 요청에 `view=FULL`이 없다. 공식 API의 기본 view는 `META`이며, API 키와 기관의 이용 권한이 필요하다. HTTP 200만으로 본문 수집 성공을 판정할 수 없다. [Elsevier API](https://dev.elsevier.com/documentation/ArticleRetrievalAPI.wadl)
3. Wiley 응답을 문자열/XML로 다룬다. 공식 TDM 경로는 PDF로 리디렉션하므로 바이너리 다운로드와 PDF 파서가 필요하다. 기관 구독자는 별도 TDM 토큰을 발급받는 경로가 있다. [Wiley TDM](https://onlinelibrary.wiley.com/library-info/resources/text-and-datamining)
4. Springer의 현재 초안은 OA API만 사용한다. 구독 원문을 다루는 별도 접근 경로를 검토해야 한다. [Springer API 설명](https://support.springernature.com/en/support/solutions/articles/6000195668-springerlink-api-details)
5. XML 파싱 실패 시 응답 원문을 본문처럼 반환한다. 로그인 페이지·확인 페이지·메타데이터만 있는 응답을 성공으로 저장할 수 있다.
6. raw XML과 본문을 공개 읽기가 허용된 `papers` 테이블에 추가한다. 구독 원문 저장소는 공개 메타데이터와 분리해야 한다.
7. v2 요약기를 그대로 교체하면 현재의 structured data·clinical relevance·Q&A 출력 계약이 유지되지 않는다. 초록 기반/원문 기반 출처도 함께 저장해야 한다.
8. DB 저장 실패 확인, 파일 크기 제한, 재시도 간격, 동일 논문 중복 처리 방지와 본문 변경 시 재요약 기준이 필요하다.

## 제안하는 구현

```text
GitHub Actions: PubMed 수집 → 분류 → 기존 초록 요약 → 추천 → 이메일
                                 ↓ 원문 수집 대상 큐
Z8 worker: 기관 접근 확인 → 원문 확보 → 파싱 → 비공개 저장 → 요약 보강
```

- **1차 대상:** 실제 추천된 논문부터 소량 수집한다. Z8이 꺼져 있거나 원문 접근에 실패해도 기존 추천·이메일은 초록 요약으로 동작하게 한다.
- **원문 경로:** PMC/Europe PMC에서 XML을 받을 수 있으면 우선 사용한다. 구독 논문은 Z8에서 출판사 공식 API를 연결한다. 브라우저의 HTML 본문 추출은 현재 확인된 보조 경로이며, 지원되는 다운로드/API 경로와 구분한다. [Europe PMC](https://europepmc.org/RestfulWebService), [PMC 데이터 접근](https://pmc.ncbi.nlm.nih.gov/tools/textmining/)
- **파싱:** XML은 섹션·문단·표·캡션을 구조화하고, PDF는 파일 헤더와 문서 파싱을 확인한 뒤 페이지별 텍스트를 추출한다. 스캔 문서는 OCR 필요 상태로 구분한다. 표·수치의 문맥과 페이지/섹션 위치를 보존한다.
- **상태:** `queued → downloaded → parsed`를 분리한다. `access_required`, `challenge`, `retryable_error`, `ocr_required`를 따로 기록한다. URL만 확보한 경우 완료로 보지 않는다.
- **저장:** `paper_fulltexts` 같은 비공개 테이블/스토리지에 원본, 파싱 결과, SHA-256, 출처 URL, 취득 시각, 문서 형식과 파서 버전을 둔다. `papers`에는 공개 가능한 출처 메타데이터와 요약만 둔다.
- **요약:** 기존 JSON 출력 구조를 유지하며 `summary_basis`, `source_hash`, 근거 섹션을 추가한다. 구독 원문의 외부 모델 전송 가능 범위를 확인한 뒤 처리 위치를 정한다.
- **실행:** Z8의 별도 로컬 작업으로 운영한다. 이후 필요하면 Windows 작업 스케줄러 또는 기관망의 전용 runner에 연결한다. 현재 자동 실행 작업을 새로 등록하지는 않았다.

## 다음 연결에 필요한 사항

Z8의 ScienceDirect 브라우저 기관 접근은 확인됐다. 현재 작업 환경에서 Elsevier API 키/기관 토큰, Wiley TDM 토큰, Supabase 서비스 키가 설정되어 있는 것은 확인되지 않았다. 먼저 Elsevier API 키를 연결해 원문 `FULL` 응답을 검증하고, Wiley 등은 각 저널의 지원 경로별로 넓히는 것이 적절하다. 브라우저에서 읽힌다는 사실만으로 API 접근까지 확인된 것으로 취급하지 않는다.

## 이번 오류 수정의 운영 반영

새 DB에는 `001`부터 `007`까지 순서대로 적용한다. 기존 DB에는 적용 이력을 확인한 뒤 `006_rpc_authorization.sql`, `007_digest_preferences.sql`을 적용하고 프런트엔드/workflow를 배포한다. `007`은 과거에 수동 추가된 `digest_email` 컬럼이 있으면 설정을 `email_digest`로 이관한다. 마이그레이션은 적용 이력으로 관리하고 반복 실행하지 않는다.

정기 실행은 한국 시간 06:00에 하나의 workflow를 시작하고 수집 → 분류 → 요약 → 추천 → 발송 순으로 진행한다. 이메일 시각은 앞 단계 완료 시점에 따라 달라진다. 기존 추천 전용·이메일 전용 workflow는 수동 실행용으로 유지한다. 앞 단계 오류는 실패 종료 코드로 보고하며 뒤 단계는 실행하지 않는다.

운영 DB 마이그레이션·배포·실제 이메일 발송은 이 검토에서 수행하지 않았다.


## Implementation follow-up

The service upgrade now includes `scripts/fulltext.py`: Europe PMC OA download, Elsevier FULL XML request, local PDF/HTML/XML parsing, and private publishing through migrations 008 and 009. The earlier design notes above remain an assessment, not a claim that every proposed provider or status state has shipped. Current rollout instructions and limitations are in [service-readiness.md](service-readiness.md). Existing databases at migration 005 need 006 through 009, not only 006 and 007.
