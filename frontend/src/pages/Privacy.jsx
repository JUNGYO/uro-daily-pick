import { Link } from "react-router-dom";

export default function Privacy() {
  return (
    <main className="page-shell max-w-3xl">
      <Link to="/welcome" className="text-accent underline text-sm">
        Uro Daily Pick
      </Link>
      <h1 className="page-title mt-6">개인정보와 연구 이용 안내</h1>
      <div className="panel space-y-6 text-sm leading-relaxed">
        <section>
          <h2 className="section-title">계정과 읽기 기록</h2>
          <p>
            로그인 제공자의 계정 식별자, 제공된 이메일, 프로필, 관심 분야, 저장한 논문, 읽기 기록, 의견과 알림
            설정을 Supabase에 저장합니다. 로그인, 맞춤 추천과 읽던 위치 복원에 사용합니다. 검색 알림은 서비스
            안에서 확인할 수 있습니다. 이메일 전달이 설정된 경우에만 Resend를 통해 요약 메일을 발송합니다.
          </p>
        </section>
        <section>
          <h2 className="section-title">논문 요약과 근거</h2>
          <p>
            본문을 확보한 논문은 설정된 모델로 요약합니다. 일부 이전 요약에는 Google Gemini가 사용됐습니다.
            원문과 그림은 운영자의 별도 보관소에, 요약·서지정보·근거 위치는 Supabase에 저장합니다. 모델은
            요약을 위해 본문을 처리합니다. 요약은 맥락을 빠뜨리거나 오류를 포함할 수 있어 연결된 근거와 원문을
            함께 확인해야 합니다. 이 서비스는 연구 읽기 도구이며 환자별 진료 조언을 제공하지 않습니다.
          </p>
        </section>
        <section>
          <h2 className="section-title">개인 메모와 공유 프로젝트</h2>
          <p>
            개인 메모와 읽기 기록은 본인만 볼 수 있습니다. 프로젝트에 작성한 메모와 논문 목록은 초대를 수락한
            구성원에게 공유됩니다. 소유자가 읽기 또는 편집 권한을 정하며 언제든 접근을 해제할 수 있습니다.
            프로젝트를 공유해도 보관된 원문에 대한 열람 권한은 추가되지 않습니다.
          </p>
        </section>
        <section>
          <h2 className="section-title">연구 자료와 문서 내보내기</h2>
          <p>
            프로젝트의 연구 질문, 비교 항목, 직접 수정한 값과 서론·고찰 메모를 저장하며 프로젝트 구성원의
            권한을 동일하게 적용합니다. 본문에서 추출한 값은 직접 수정한 값과 구분하여 보관합니다.
            Word·CSV·RIS 파일에는 선택한 프로젝트 자료가 포함됩니다.
          </p>
          <p>
            Google Docs로 내보내기를 선택하면 Google 승인 후 새 문서를 본인의 Drive에 만듭니다. 이 기능은
            앱에서 만든 문서에 필요한 drive.file 권한만 요청하며, 다른 Drive 파일을 읽거나 Zotero 라이브러리를
            동기화하지 않습니다. Google 접근 토큰은 내보내기에만 일시적으로 사용하며 서버나 브라우저 저장소에
            보관하지 않습니다. Google에 만든 문서는 Drive에서 직접 관리·삭제할 수 있으며, Google 계정의 연결된
            앱 설정에서 권한을 해제할 수 있습니다.
          </p>
        </section>
        <section>
          <h2 className="section-title">기기 저장과 삭제</h2>
          <p>
            ‘이 기기에 요약 저장’을 선택한 항목의 요약과 서지정보만 브라우저에 보관합니다. 원문과 그림은
            오프라인 저장 대상이 아닙니다. 내 서재에서 기기 저장을 지우거나 로그아웃하면 해당 계정의 기기
            요약이 삭제됩니다. 공유 기기에서는 사용 후 로그아웃하세요. 직접 내보낸 인용 파일이나 내려받은
            그림은 기기에서 별도로 삭제해야 합니다.
          </p>
        </section>
        <section>
          <h2 className="section-title">원문 열람과 계정 관리</h2>
          <p>
            서비스 가입이 저널 구독 권한을 부여하지는 않습니다. 출판사 원문은 기관 구독이 필요할 수 있습니다.
            보관소의 원문과 그림은 운영자가 허용한 계정에 한해 로그인 확인 후 암호화 연결로 제공하며 브라우저
            캐시를 금지합니다. 프로필·검색어·메모에는 환자 정보를 입력하지 마세요. 설정에서 관심 분야와 알림을
            변경하고 계정을 삭제할 수 있습니다. 계정 삭제 시 계정에 연결된 프로필, 읽기 기록, 개인 메모, 소유
            프로젝트, 추천과 전달 기록이 삭제됩니다. 인프라 백업과 공급자 로그는 각 서비스의 보존 설정을
            따릅니다.
          </p>
        </section>
        <Link to="/settings" className="inline-block text-accent underline">
          계정 설정 열기
        </Link>
      </div>
    </main>
  );
}
