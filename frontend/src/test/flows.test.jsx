import { afterEach, beforeEach, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
const mock = vi.hoisted(() => ({
  auth: {},
  from: vi.fn(),
  rpc: vi.fn(),
  signUp: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithOAuth: vi.fn(),
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
afterEach(() => vi.unstubAllEnvs());

it("keeps email sign-in and safe return without reviving the removed OAuth provider", async () => {
  vi.stubEnv("VITE_EMAIL_AUTH_READY", "false");
  vi.stubEnv("VITE_KAKAO_AUTH_READY", "true"); // A stale deployment flag must have no effect.
  mock.auth = { user: null, loading: false };
  mock.signInWithPassword
    .mockResolvedValueOnce({ error: new Error("Invalid login credentials") })
    .mockResolvedValueOnce({ error: null });
  show(<Login />, "/test?next=%2Flibrary");
  expect(screen.queryByText(/카카오|kakao/i)).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Sign up" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Forgot password?" })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "공개 요약 체험" })).toHaveAttribute("href", "/preview");
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), "reader@example.test");
  await user.type(screen.getByLabelText("Password"), "existing-password");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Invalid login credentials");
  expect(screen.getByLabelText("Email")).toHaveValue("reader@example.test");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("heading", { name: "Reader library" })).toBeVisible();
  expect(mock.signInWithPassword).toHaveBeenLastCalledWith({
    email: "reader@example.test",
    password: "existing-password",
  });
  expect(mock.signInWithOAuth).not.toHaveBeenCalled();
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
