// Keep actionable account errors separate from a generic service failure.
export function authErrorMessage(error) {
  const code = error?.code;
  const message = String(error?.message || "");
  if (code === "invalid_credentials" || /invalid login credentials/i.test(message))
    return "이메일 또는 비밀번호가 일치하지 않습니다. 다시 확인하거나 아래 Forgot password?에서 비밀번호를 재설정해 주세요.";
  if (code === "email_not_confirmed" || /email not confirmed/i.test(message))
    return "이메일 인증이 필요합니다. 가입 안내 메일의 인증 링크를 확인해 주세요.";
  if (code === "user_already_exists" || /already registered/i.test(message))
    return "이미 가입된 이메일입니다. Sign in으로 로그인하거나 비밀번호를 재설정해 주세요.";
  if (code === "weak_password") return "더 안전한 비밀번호를 입력해 주세요. 8자 이상으로 설정해 주세요.";
  if (code === "email_address_invalid") return "이메일 주소를 확인해 주세요.";
  if (code === "signup_disabled")
    return "현재 서버에서 회원가입을 허용하지 않고 있습니다. 잠시 후 다시 시도해 주세요.";
  if (error?.status === 429 || /rate_limit|over_.*rate/.test(code || "") || /rate limit/i.test(message))
    return "요청이 많아 잠시 제한되었습니다. 잠시 후 다시 시도해 주세요.";
  if (code === "email_address_not_authorized" || /sending.*email|email.*not authorized/i.test(message))
    return "인증 메일을 보내지 못했습니다. 서비스의 메일 발송 설정 확인이 필요합니다.";
  if (/timed out|failed to fetch|network/i.test(message))
    return "서버 응답을 확인하지 못했습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요.";
  return "요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.";
}
