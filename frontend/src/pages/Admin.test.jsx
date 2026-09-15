import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
const mock = vi.hoisted(() => ({ user: null, rpc: vi.fn(), signals: [] }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: mock.user }) }));
vi.mock("../lib/supabase", () => ({ supabase: { rpc: mock.rpc } }));
import Admin from "./Admin";

function query(result) {
  const promise = Promise.resolve(result);
  promise.abortSignal = (signal) => {
    mock.signals.push(signal);
    return promise;
  };
  return promise;
}
function response(name) {
  return {
    data:
      name === "admin_stats"
        ? { total_papers: 138225, total_users: 9 }
        : name === "admin_catalog_status"
          ? { catalog_papers: 138225, qwen_summaries: 427, awaiting_qwen: 137798 }
          : name === "admin_fulltext_status"
            ? { local_bodies: 427, ready_summaries: 427, workers: [] }
            : [],
  };
}
beforeEach(() => {
  mock.user = { id: "owner", email: "crazyslime@gmail.com" };
  mock.signals = [];
  mock.rpc.mockReset().mockImplementation((name) => query(response(name)));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("keeps successful panels visible and retries only the failed catalog", async () => {
  let failed = true;
  mock.rpc.mockImplementation((name) =>
    query(name === "admin_catalog_status" && failed ? { error: { code: "57014" } } : response(name)),
  );
  render(<Admin />);
  expect(await screen.findByText("138225")).toBeVisible();
  const catalog = within(screen.getByRole("region", { name: "전체 문헌 수집" }));
  expect(await catalog.findByRole("alert")).toBeVisible();
  expect(catalog.queryByText(/전체 목록 0/)).not.toBeInTheDocument();
  failed = false;
  const count = mock.rpc.mock.calls.length;
  fireEvent.click(catalog.getByRole("button", { name: "다시 시도" }));
  expect(await catalog.findByText(/전체 목록 138225/)).toBeVisible();
  expect(mock.rpc.mock.calls.length).toBe(count + 1);
  expect(catalog.queryByRole("alert")).not.toBeInTheDocument();
});

it("bounds a hanging request while other panels finish and aborts it", async () => {
  vi.useFakeTimers();
  mock.rpc.mockImplementation((name) =>
    query(name === "admin_catalog_status" ? new Promise(() => {}) : response(name)),
  );
  render(<Admin />);
  await act(async () => {});
  expect(screen.getByText("138225")).toBeVisible();
  await act(async () => {
    vi.advanceTimersByTime(15001);
  });
  expect(within(screen.getByRole("region", { name: "전체 문헌 수집" })).getByRole("alert")).toHaveTextContent(
    "조회 시간이 초과",
  );
  expect(mock.signals.some((signal) => signal.aborted)).toBe(true);
});

it("preserves previous results with a visible stale label when refresh fails", async () => {
  render(<Admin />);
  await screen.findByText("138225");
  mock.rpc.mockImplementation(() => query({ error: { code: "57014" } }));
  fireEvent.click(screen.getByRole("button", { name: "상태 새로고침" }));
  const stats = within(screen.getByRole("region", { name: "서비스 이용 현황" }));
  await stats.findByRole("alert");
  expect(stats.getByText("138225")).toBeVisible();
  expect(stats.getByText(/이전 조회 결과/)).toBeVisible();
});

it("does not query for a reader and clears results on sign-out", async () => {
  mock.user = { id: "reader", email: "reader@example.test" };
  const view = render(<Admin />);
  expect(screen.getByText("Access denied")).toBeVisible();
  expect(mock.rpc).not.toHaveBeenCalled();
  mock.user = { id: "owner", email: "CrazySlime@gmail.com" };
  view.rerender(<Admin />);
  await screen.findByText("138225");
  mock.user = null;
  view.rerender(<Admin />);
  expect(screen.queryByText("138225")).not.toBeInTheDocument();
  expect(mock.signals.every((signal) => signal.aborted)).toBe(true);
});

it("treats a null stats response as failure but a null list as empty", async () => {
  mock.rpc.mockImplementation(() => query({ data: null }));
  render(<Admin />);
  expect(
    await within(screen.getByRole("region", { name: "서비스 이용 현황" })).findByRole("alert"),
  ).toBeVisible();
  expect(await screen.findByText("No likes yet")).toBeVisible();
});
