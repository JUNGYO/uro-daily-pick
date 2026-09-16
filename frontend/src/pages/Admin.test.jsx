import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
const mock = vi.hoisted(() => ({ user: null, rpc: vi.fn(), signals: [] }));
vi.mock("../lib/auth", () => ({ useAuth: () => ({ user: mock.user }) }));
vi.mock("../lib/supabase", () => ({ supabase: { rpc: mock.rpc } }));
import Admin from "./Admin";
import AdminPanel from "../components/AdminPanel";

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
          ? {
              catalog_papers: 138225,
              automatic_papers: 90000,
              originals_acquired: 500,
              summaries_ready: 427,
              archived_papers: 48225,
              qwen_summaries: 427,
              awaiting_qwen: 89573,
            }
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
  vi.restoreAllMocks();
});

it("keeps successful panels visible and retries only the failed catalog", async () => {
  let failed = true;
  mock.rpc.mockImplementation((name) =>
    query(name === "admin_catalog_status" && failed ? { error: { code: "57014" } } : response(name)),
  );
  render(<Admin />);
  expect(await screen.findByText("138225")).toBeVisible();
  const catalog = within(screen.getByRole("region", { name: "문헌 처리 현황" }));
  expect(await catalog.findByRole("alert")).toBeVisible();
  expect(catalog.queryByText(/문헌 정보 등록/)).not.toBeInTheDocument();
  failed = false;
  const count = mock.rpc.mock.calls.length;
  fireEvent.click(catalog.getByRole("button", { name: "다시 시도" }));
  expect(await catalog.findByText("90,000")).toBeVisible();
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
  expect(within(screen.getByRole("region", { name: "문헌 처리 현황" })).getByRole("alert")).toHaveTextContent(
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

it("polls only collection and worker status, preserving visible data during background refresh", async () => {
  vi.useFakeTimers();
  render(<Admin />);
  await act(async () => {});
  const callsBefore = mock.rpc.mock.calls.map(([name]) => name);
  let complete;
  mock.rpc.mockImplementation((name) =>
    query(
      name === "admin_catalog_status"
        ? new Promise((resolve) => {
            complete = resolve;
          })
        : response(name),
    ),
  );
  await act(async () => {
    vi.advanceTimersByTime(30000);
  });
  expect(
    mock.rpc.mock.calls
      .slice(callsBefore.length)
      .map(([name]) => name)
      .sort(),
  ).toEqual(["admin_catalog_status", "admin_fulltext_status"]);
  const catalog = within(screen.getByRole("region", { name: "문헌 처리 현황" }));
  expect(catalog.getByText("90,000")).toBeVisible();
  expect(catalog.queryByRole("status")).not.toBeInTheDocument();
  await act(async () => {
    complete({ data: { ...response("admin_catalog_status").data, automatic_papers: 90001 } });
  });
  expect(catalog.getByText("90,001")).toBeVisible();
  mock.rpc.mockImplementation((name) =>
    query(name === "admin_catalog_status" ? { error: { code: "57014" } } : response(name)),
  );
  await act(async () => {
    vi.advanceTimersByTime(30000);
  });
  expect(catalog.getByText("90,001")).toBeVisible();
  expect(catalog.getByRole("alert")).toBeVisible();
  expect(catalog.getByText(/이전 조회 결과/)).toBeVisible();
  for (const name of callsBefore.filter(
    (name) => !["admin_catalog_status", "admin_fulltext_status"].includes(name),
  )) {
    expect(mock.rpc.mock.calls.filter(([called]) => called === name)).toHaveLength(
      callsBefore.filter((called) => called === name).length,
    );
  }
});

it("pauses status polling while hidden and refreshes immediately on returning", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const view = render(
    <AdminPanel title="Status" rpc="status" pollMs={30000}>
      {(data) => <p>{data.count}</p>}
    </AdminPanel>,
  );
  await act(async () => {
    vi.advanceTimersByTime(90000);
  });
  expect(mock.rpc).not.toHaveBeenCalled();
  mock.rpc.mockImplementation(() => query({ data: { count: 10 } }));
  await act(async () => {
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
  });
  expect(screen.getByText("10")).toBeVisible();
  visibility.mockReturnValue("hidden");
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => {
    vi.advanceTimersByTime(90000);
  });
  expect(mock.rpc).toHaveBeenCalledTimes(1);
  mock.rpc.mockImplementation(() => query(new Promise(() => {})));
  await act(async () => {
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
  });
  expect(mock.rpc).toHaveBeenCalledTimes(2);
  const pendingSignal = mock.signals.at(-1);
  view.unmount();
  expect(pendingSignal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => {
    vi.advanceTimersByTime(90000);
  });
  expect(mock.rpc).toHaveBeenCalledTimes(2);
});

it("never overlaps a slow poll, even across visibility changes, and retries after its deadline", async () => {
  vi.useFakeTimers();
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  mock.rpc
    .mockImplementationOnce(() => query({ data: { count: 10 } }))
    .mockImplementation(() => query(new Promise(() => {})));
  const view = render(
    <AdminPanel title="Status" rpc="status" pollMs={1000}>
      {(data) => <p>{data.count}</p>}
    </AdminPanel>,
  );
  await act(async () => {});
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  expect(mock.rpc).toHaveBeenCalledTimes(2);
  visibility.mockReturnValue("hidden");
  fireEvent(document, new Event("visibilitychange"));
  visibility.mockReturnValue("visible");
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => {
    vi.advanceTimersByTime(14000);
  });
  expect(mock.rpc).toHaveBeenCalledTimes(2);
  expect(mock.signals.at(-1).aborted).toBe(false);
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  expect(mock.signals.at(-1).aborted).toBe(true);
  expect(screen.getByText("10")).toBeVisible();
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  expect(mock.rpc).toHaveBeenCalledTimes(3);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("manual refresh aborts the old request and a panel without polling never refreshes on its own", async () => {
  vi.useFakeTimers();
  let stale;
  mock.rpc.mockImplementationOnce(() =>
    query(
      new Promise((resolve) => {
        stale = resolve;
      }),
    ),
  );
  const content = (data) => <p>{data.count}</p>;
  const view = render(
    <AdminPanel title="Stats" rpc="status" refresh={0}>
      {content}
    </AdminPanel>,
  );
  const oldSignal = mock.signals[0];
  mock.rpc.mockImplementation(() => {
    expect(oldSignal.aborted).toBe(true);
    return query({ data: { count: 20 } });
  });
  await act(async () => {
    view.rerender(
      <AdminPanel title="Stats" rpc="status" refresh={1}>
        {content}
      </AdminPanel>,
    );
  });
  expect(screen.getByText("20")).toBeVisible();
  await act(async () => {
    stale({ data: { count: 1 } });
    vi.advanceTimersByTime(90000);
    fireEvent(document, new Event("visibilitychange"));
  });
  expect(screen.getByText("20")).toBeVisible();
  expect(screen.queryByText("1")).not.toBeInTheDocument();
  expect(mock.rpc).toHaveBeenCalledTimes(2);
});
