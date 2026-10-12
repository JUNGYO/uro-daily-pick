import { expect, it } from "vitest";
import { authErrorMessage } from "./authErrors";
it("explains leaked passwords separately from length failures", () => {
  for (const extra of [{ reasons: ["pwned"] }, { weak_password: { reasons: ["pwned"] } }])
    expect(authErrorMessage({ code: "weak_password", ...extra })).toContain("유출 이력");
  expect(authErrorMessage({ code: "weak_password", reasons: ["length"] })).toContain("8자 이상");
  expect(authErrorMessage({ code: "invalid_credentials" })).toContain("일치하지 않습니다");
});
