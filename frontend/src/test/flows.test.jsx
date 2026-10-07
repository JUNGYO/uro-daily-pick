import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
const mock = vi.hoisted(() => ({
  auth: {},
  from: vi.fn(),
  rpc: vi.fn(),
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithOAuth: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
  setProfile: vi.fn(),
  picks: vi.fn(),
}));
vi.mock("../lib/auth", () => ({ useAuth: () => mock.auth }));
vi.mock("../lib/supabase", () => ({
  supabase: {
    from: mock.from,
    rpc: mock.rpc,
    auth: {
      signUp: mock.signUp,
      signInWithPassword: mock.signInWithPassword,
      signInWithOAuth: mock.signInWithOAuth,
      resetPasswordForEmail: mock.resetPasswordForEmail,
      updateUser: mock.updateUser,
    },
  },
}));
vi.mock("../lib/recommendations", () => ({ getDailyPicks: mock.picks }));
import Login from "../pages/Login";
import Onboarding from "../pages/Onboarding";
import Settings from "../pages/Settings";
import Collections from "../pages/Collections";
import DailyPick from "../pages/DailyPick";
import ResetPassword from "../pages/ResetPassword";

function query(result) {
  const q = {
    then(resolve, reject) {
      return Promise.resolve(typeof result === "function" ? result() : result).then(resolve, reject);
    },
  };
  for (const method of ["select", "single", "eq", "order", "in", "update", "insert", "delete"])
    q[method] = vi.fn(() => q);
  return q;
}
function show(component, entry = "/test") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/test" element={component} />
        <Route path="/" element={<h1>Saved workspace</h1>} />
        <Route path="/library" element={<h1>Reader library</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  mock.auth = {
    user: { id: "reader", email: "reader@example.test" },
    profile: {
      id: "reader",
      name: "Reader",
      keywords: [],
      preferred_journals: [],
      preferred_study_types: [],
      email_digest: true,
      digest_frequency: "daily",
    },
    setProfile: mock.setProfile,
  };
  mock.from.mockReturnValue(query({ data: [], error: null }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("keeps email sign-in and safe return without reviving the removed OAuth provider", async () => {
  vi.stubEnv("VITE_EMAIL_AUTH_READY", "false");
  vi.stubEnv("VITE_KAKAO_AUTH_READY", "true"); // A stale deployment flag must have no effect.
  mock.auth = { user: null, loading: false };
  mock.signInWithPassword
    .mockResolvedValueOnce({ error: new Error("Invalid login credentials") })
    .mockResolvedValueOnce({ error: null });
  show(<Login />, "/test?next=%2Flibrary");
  expect(screen.queryByText(/카카오|kakao/i)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign up" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Forgot password?" })).toBeVisible();
  expect(screen.queryByRole("link", { name: /요약 체험/ })).not.toBeInTheDocument();
  expect(screen.queryByText(/공개 요약/)).not.toBeInTheDocument();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), "reader@example.test");
  await user.type(screen.getByLabelText("Password"), "existing-password");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("이메일 또는 비밀번호가 일치하지 않습니다");
  expect(screen.getByLabelText("Email")).toHaveValue("reader@example.test");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("heading", { name: "Reader library" })).toBeVisible();
  expect(mock.signInWithPassword).toHaveBeenLastCalledWith({
    email: "reader@example.test",
    password: "existing-password",
  });
  expect(mock.signInWithOAuth).not.toHaveBeenCalled();
});
it("registers directly from a signup link despite the obsolete deployment flag", async () => {
  vi.stubEnv("VITE_EMAIL_AUTH_READY", "false");
  mock.auth = { user: null, loading: false };
  mock.signUp.mockResolvedValue({ data: { session: { user: { id: "new-reader" } } }, error: null });
  show(<Login />, "/test?mode=signup&next=%2Flibrary");
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Name"), "New Reader");
  await user.type(screen.getByLabelText("Email"), "new@example.test");
  await user.type(screen.getByLabelText("Password"), "new-password");
  await user.click(screen.getByRole("button", { name: "Get started" }));
  expect(await screen.findByRole("heading", { name: "Reader library" })).toBeVisible();
  expect(mock.signUp).toHaveBeenCalledWith({
    email: "new@example.test",
    password: "new-password",
    options: {
      data: { name: "New Reader" },
      emailRedirectTo: expect.stringContaining("login?next=%2Flibrary"),
    },
  });
});
it("shows recovery failure honestly, retries, and preserves the login destination", async () => {
  vi.stubEnv("VITE_EMAIL_AUTH_READY", "false");
  mock.auth = { user: null, loading: false };
  mock.resetPasswordForEmail
    .mockResolvedValueOnce({ error: { code: "email_address_not_authorized" } })
    .mockResolvedValueOnce({ error: null });
  show(<Login />, "/test?mode=forgot&next=%2Flibrary");
  const user = userEvent.setup();
  expect(screen.queryByLabelText("Password")).not.toBeInTheDocument();
  await user.type(screen.getByLabelText("Email"), "reader@example.test");
  await user.click(screen.getByRole("button", { name: "Send reset link" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("메일 발송 설정 확인");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Send reset link" }));
  expect(await screen.findByRole("status")).toHaveTextContent("등록된 이메일이라면");
  expect(mock.resetPasswordForEmail).toHaveBeenLastCalledWith("reader@example.test", {
    redirectTo: expect.stringMatching(/\/reset-password$/),
  });
  await user.click(screen.getByRole("button", { name: "Back to sign in" }));
  expect(screen.getByLabelText("Email")).toHaveValue("reader@example.test");
  mock.signInWithPassword.mockResolvedValue({ error: null });
  await user.type(screen.getByLabelText("Password"), "new-password");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("heading", { name: "Reader library" })).toBeVisible();
});
it("releases a stalled request without claiming success or submitting duplicates", async () => {
  vi.useFakeTimers();
  mock.auth = { user: null, loading: false };
  mock.signInWithPassword.mockReturnValue(new Promise(() => {}));
  show(<Login />);
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "reader@example.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "existing-password" } });
  const form = screen.getByRole("button", { name: "Continue" }).closest("form");
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(mock.signInWithPassword).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "처리 중…" })).toBeDisabled();
  await act(() => vi.advanceTimersByTimeAsync(15001));
  expect(screen.getByRole("alert")).toHaveTextContent("서버 응답을 확인하지 못했습니다");
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  expect(screen.queryByText("Saved workspace")).not.toBeInTheDocument();
});
it("sends expired reset links back to the recovery form", () => {
  mock.auth = { user: null, loading: false };
  show(<ResetPassword />);
  expect(screen.getByRole("link", { name: "Request another reset link" })).toHaveAttribute(
    "href",
    "/login?mode=forgot",
  );
});
it("highlights a standalone AI mention without splitting Affairs and keeps the summary visible", async () => {
  const title =
    "Active Surveillance Use for Favorable-Risk Prostate Cancer in a Veterans Affairs Population.";
  mock.picks.mockResolvedValue([
    {
      id: 1,
      paper_id: 1,
      paper: {
        id: 1,
        title,
        abstract: "DNA mismatch repair remains available. An AI tool was evaluated in Veterans Affairs.",
        authors: [],
        structured_data: {},
        qa_data: [],
      },
      reasons: { reasons: [], matched_terms: ["AI"] },
    },
  ]);
  const { container } = show(<DailyPick />);
  await screen.findByRole("button", { name: "Like paper" });
  expect([...container.querySelectorAll("mark")].map((el) => el.textContent)).toEqual(["AI"]);
  expect(screen.getByRole("region", { name: "본문 기반 세 줄 요약" })).toBeVisible();
  expect(screen.getByText("원문이 아직 확보되지 않아 본문 기반 요약을 제공할 수 없습니다.")).toBeVisible();
});
it("shows confirmation instructions when signup does not create a session", async () => {
  mock.auth = { user: null, loading: false };
  mock.signUp.mockResolvedValue({ data: { session: null }, error: null });
  show(<Login />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Sign up" }));
  await user.type(screen.getByLabelText("Email"), "reader@example.test");
  await user.type(screen.getByLabelText("Password"), "strong-password");
  await user.click(screen.getByRole("button", { name: "Get started" }));
  expect(await screen.findByRole("status")).toHaveTextContent("confirm your account");
  expect(screen.queryByText("Saved workspace")).not.toBeInTheDocument();
});
it("keeps onboarding topics after a failed save and advances only after persistence", async () => {
  let result = { error: new Error("Offline") };
  mock.from.mockImplementation(() => query(() => result));
  show(<Onboarding />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Prostate Cancer/i }));
  await user.click(screen.getByRole("button", { name: "Start" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
  expect(screen.getByRole("button", { name: /Prostate Cancer/i })).toHaveAttribute("aria-pressed", "true");
  expect(mock.setProfile).not.toHaveBeenCalled();
  result = { data: { ...mock.auth.profile, onboarding_done: true } };
  await user.click(screen.getByRole("button", { name: "Start" }));
  expect(await screen.findByRole("heading", { name: "Saved workspace" })).toBeVisible();
});
it("reports settings failure without committing profile state", async () => {
  mock.from.mockImplementation((table) =>
    query(table === "profiles" ? { error: new Error("Save unavailable") } : { data: [] }),
  );
  show(<Settings />);
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText("Name"));
  await user.type(screen.getByLabelText("Name"), "Updated reader");
  await user.click(screen.getByRole("button", { name: "Save settings" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Save unavailable");
  expect(mock.setProfile).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Name")).toHaveValue("Updated reader");
});
it("does not create a phantom collection when insert fails", async () => {
  mock.from.mockImplementation(() => {
    const q = query(() =>
      q.insert.mock.calls.length ? { error: new Error("Insert unavailable") } : { data: [] },
    );
    return q;
  });
  show(<Collections />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New" }));
  await user.type(screen.getByLabelText("Collection name"), "Trial review");
  await user.click(screen.getByRole("button", { name: "Create" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Insert unavailable");
  expect(screen.queryByRole("button", { name: "Trial review" })).not.toBeInTheDocument();
});
it("leaves a paper unliked when feedback persistence fails", async () => {
  mock.picks.mockResolvedValue([
    {
      id: 1,
      paper_id: 1,
      rec_date: "2026-09-13",
      paper: {
        id: 1,
        title: "Trial paper",
        authors: [],
        abstract: "Research text",
        structured_data: {},
        qa_data: [],
      },
      reasons: { reasons: [], matched_terms: [] },
    },
  ]);
  mock.rpc.mockResolvedValue({ error: new Error("Offline") });
  show(<DailyPick />);
  const user = userEvent.setup();
  const button = await screen.findByRole("button", { name: "Like paper" });
  await user.click(button);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Could not save feedback"));
  expect(button).toHaveAttribute("aria-pressed", "false");
});
it("does not send mismatched replacement passwords", async () => {
  show(<ResetPassword />);
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("New password"), "password-one");
  await user.type(screen.getByLabelText("Confirm password"), "password-two");
  await user.click(screen.getByRole("button", { name: "Update password" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("match");
  expect(mock.updateUser).not.toHaveBeenCalled();
});
