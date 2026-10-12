import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
const mock = vi.hoisted(() => ({
  assurance: vi.fn(),
  list: vi.fn(),
  enroll: vi.fn(),
  verify: vi.fn(),
  unenroll: vi.fn(),
  rpc: vi.fn(),
  callback: null,
}));
vi.mock("../lib/supabase", () => ({
  supabase: {
    rpc: mock.rpc,
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: mock.assurance,
        listFactors: mock.list,
        enroll: mock.enroll,
        challengeAndVerify: mock.verify,
        unenroll: mock.unenroll,
      },
      onAuthStateChange: (callback) => {
        mock.callback = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    },
  },
}));
import AdminMfaGate from "./AdminMfaGate";
const factor = { id: "synthetic-factor", status: "verified", factor_type: "totp" };
const setup = () =>
  render(
    <AdminMfaGate>
      <p>Private administrator data</p>
    </AdminMfaGate>,
  );
beforeEach(() => {
  vi.resetAllMocks();
  mock.assurance.mockResolvedValue({ data: { currentLevel: "aal1" } });
  mock.list.mockResolvedValue({ data: { all: [] } });
  mock.rpc.mockResolvedValue({ data: { verified: true } });
  mock.enroll.mockResolvedValue({
    data: {
      id: factor.id,
      totp: { qr_code: '<svg xmlns="http://www.w3.org/2000/svg"/>', secret: "SYNTHETIC-TEST-ONLY" },
    },
  });
});
afterEach(cleanup);
it("does not enroll automatically or mount private content before a server-verified session", async () => {
  setup();
  await screen.findByRole("button", { name: "인증 앱 등록 시작" });
  expect(mock.enroll).not.toHaveBeenCalled();
  expect(mock.rpc).not.toHaveBeenCalled();
  expect(screen.queryByText("Private administrator data")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "인증 앱 등록 시작" }));
  expect(await screen.findByAltText("인증 앱 등록 QR 코드")).toHaveAttribute(
    "src",
    expect.stringContaining("data:image/svg+xml"),
  );
  fireEvent.focus(window);
  expect(await screen.findByAltText("인증 앱 등록 QR 코드")).toBeVisible();
  mock.verify.mockResolvedValueOnce({ error: { code: "mfa_verification_failed" } });
  fireEvent.change(screen.getByLabelText("인증 앱의 6자리 번호"), { target: { value: "111111" } });
  fireEvent.click(screen.getByRole("button", { name: "인증하고 관리자 화면 열기" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("인증번호가 맞지 않습니다");
  expect(screen.getByLabelText("인증 앱의 6자리 번호")).toHaveValue("");
  mock.verify.mockImplementationOnce(async () => {
    mock.assurance.mockResolvedValue({ data: { currentLevel: "aal2" } });
    mock.list.mockResolvedValue({ data: { all: [factor] } });
    mock.callback("MFA_CHALLENGE_VERIFIED");
    return { data: {} };
  });
  fireEvent.change(screen.getByLabelText("인증 앱의 6자리 번호"), { target: { value: "222222" } });
  fireEvent.click(screen.getByRole("button", { name: "인증하고 관리자 화면 열기" }));
  expect(await screen.findByText("Private administrator data")).toBeVisible();
  expect(mock.rpc).toHaveBeenCalledWith("admin_security_status");
  expect(screen.queryByText("SYNTHETIC-TEST-ONLY")).toBeNull();
});
it("challenges enrolled administrators and fails closed when the server rejects AAL2", async () => {
  mock.list.mockResolvedValue({ data: { all: [factor] } });
  setup();
  expect(await screen.findByLabelText("인증 앱의 6자리 번호")).toBeVisible();
  expect(screen.queryByRole("button", { name: "인증 앱 등록 시작" })).toBeNull();
  mock.assurance.mockResolvedValue({ data: { currentLevel: "aal2" } });
  mock.rpc.mockResolvedValue({ error: { code: "42501" } });
  act(() => mock.callback("TOKEN_REFRESHED"));
  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.queryByText("Private administrator data")).toBeNull();
});
it("discards a late privileged result after an auth state change", async () => {
  let resolve;
  mock.assurance.mockResolvedValue({ data: { currentLevel: "aal2" } });
  mock.list.mockResolvedValue({ data: { all: [factor] } });
  mock.rpc.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  setup();
  await waitFor(() => expect(mock.rpc).toHaveBeenCalled());
  mock.assurance.mockResolvedValue({ data: { currentLevel: "aal1" } });
  act(() => mock.callback("SIGNED_IN"));
  await screen.findByLabelText("인증 앱의 6자리 번호");
  await act(async () => resolve({ data: { verified: true } }));
  expect(screen.queryByText("Private administrator data")).toBeNull();
});
it("clears private content on assurance downgrade and offers retry after network failure", async () => {
  mock.assurance.mockResolvedValue({ data: { currentLevel: "aal2" } });
  mock.list.mockResolvedValue({ data: { all: [factor] } });
  setup();
  await screen.findByText("Private administrator data");
  mock.assurance.mockRejectedValue(new Error("Network failure"));
  act(() => mock.callback("TOKEN_REFRESHED"));
  expect(screen.queryByText("Private administrator data")).toBeNull();
  await screen.findByRole("alert");
  mock.assurance.mockResolvedValue({ data: { currentLevel: "aal1" } });
  fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await screen.findByLabelText("인증 앱의 6자리 번호");
});
it("removes only unfinished factors after an explicit action", async () => {
  mock.list.mockResolvedValue({ data: { all: [{ ...factor, status: "unverified" }] } });
  mock.unenroll.mockResolvedValue({ data: {} });
  setup();
  await screen.findByRole("button", { name: "미완료 등록 지우기" });
  expect(mock.unenroll).not.toHaveBeenCalled();
  // A factor verified in another tab must survive the fresh cleanup check.
  mock.list.mockResolvedValue({
    data: { all: [factor, { ...factor, id: "unfinished", status: "unverified" }] },
  });
  fireEvent.click(screen.getByRole("button", { name: "미완료 등록 지우기" }));
  await waitFor(() => expect(mock.unenroll).toHaveBeenCalledTimes(1));
  expect(mock.unenroll).toHaveBeenCalledWith({ factorId: "unfinished" });
});
