import { it, expect, vi } from "vitest";
import { render, screen, act, waitFor, cleanup } from "@testing-library/react";
const mock = vi.hoisted(() => ({ listener: null, from: vi.fn(), getSession: vi.fn() }));
vi.mock("./supabase", () => ({
  supabase: {
    from: mock.from,
    auth: {
      getSession: mock.getSession,
      onAuthStateChange: (fn) => {
        mock.listener = fn;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    },
  },
}));
import { AuthProvider, useAuth } from "./auth";
function View() {
  const auth = useAuth();
  return <div>{auth.loading ? "Loading" : auth.error || auth.profile?.name || "Signed out"}</div>;
}
it("does not expose the previous account profile after an auth change", async () => {
  sessionStorage.setItem("uro-research-draft:first:42", "private draft");
  let resolveFirst;
  const first = new Promise((resolve) => {
    resolveFirst = resolve;
  });
  mock.getSession.mockResolvedValue({ data: { session: { user: { id: "first" } } } });
  mock.from.mockImplementation(() => {
    let uid;
    const q = {
      select() {
        return q;
      },
      eq(_, value) {
        uid = value;
        return q;
      },
      single() {
        return uid === "first" ? first : Promise.resolve({ data: { id: "second", name: "Second reader" } });
      },
    };
    return q;
  });
  render(
    <AuthProvider>
      <View />
    </AuthProvider>,
  );
  await waitFor(() => expect(mock.from).toHaveBeenCalled());
  await act(async () => mock.listener("SIGNED_IN", { user: { id: "second" } }));
  expect(await screen.findByText("Second reader")).toBeVisible();
  expect(sessionStorage.getItem("uro-research-draft:first:42")).toBeNull();
  sessionStorage.setItem("uro-research-draft:second:99", "new private draft");
  await act(async () => resolveFirst({ data: { id: "first", name: "First reader" } }));
  expect(screen.queryByText("First reader")).not.toBeInTheDocument();
  await act(async () => mock.listener("SIGNED_OUT", null));
  expect(await screen.findByText("Signed out")).toBeVisible();
  expect(sessionStorage.getItem("uro-research-draft:second:99")).toBeNull();
});

it("keeps device-only identity through INITIAL_SESSION and clears it on sign out", async () => {
  cleanup();
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  localStorage.setItem("uro-offline-active", "offline-reader");
  localStorage.setItem("uro-offline:offline-reader", '[{"id":1}]');
  localStorage.setItem(
    "uro-profile:offline-reader",
    JSON.stringify({ id: "offline-reader", name: "Device reader" }),
  );
  try {
    render(
      <AuthProvider>
        <View />
      </AuthProvider>,
    );
    expect(await screen.findByText("Device reader")).toBeVisible();
    await act(async () => mock.listener("INITIAL_SESSION", null));
    expect(screen.getByText("Device reader")).toBeVisible();
    await act(async () => mock.listener("SIGNED_OUT", null));
    expect(await screen.findByText("Signed out")).toBeVisible();
    expect(localStorage.getItem("uro-offline:offline-reader")).toBeNull();
    expect(localStorage.getItem("uro-profile:offline-reader")).toBeNull();
    expect(localStorage.getItem("uro-offline-active")).toBeNull();
  } finally {
    cleanup();
    online.mockRestore();
    localStorage.clear();
  }
});
