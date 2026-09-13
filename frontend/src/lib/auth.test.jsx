import { it, expect, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";
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
  await act(async () => resolveFirst({ data: { id: "first", name: "First reader" } }));
  expect(screen.queryByText("First reader")).not.toBeInTheDocument();
  await act(async () => mock.listener("SIGNED_OUT", null));
  expect(await screen.findByText("Signed out")).toBeVisible();
});
