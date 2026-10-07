import { StrictMode } from "react";
import { render, fireEvent, screen, act } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("./supabase", () => ({ supabase: api }));
import { recordPaperOpen, usePaperOpenLinks } from "./paperOpen";

function Links({ user = { id: "reader" } }) {
  usePaperOpenLinks(user);
  return (
    <div onClick={(event) => event.preventDefault()} onAuxClick={(event) => event.preventDefault()}>
      <a href="/papers/1234?tab=study">
        <span>Paper</span>
      </a>
      <a href="/fulltext/1234?source=hash#p-0000001">Original</a>
      <a href="https://doi.org/10.1234/test" data-paper-open="publisher" data-paper-pmid="1234">
        Publisher
      </a>
      <a href="https://other.test/papers/1234">Other site</a>
      <a href="/papers/1234" download>
        Download
      </a>
      <a href="/papers/1234" aria-disabled="true">
        Disabled
      </a>
      <a href="/library">Library</a>
    </div>
  );
}
beforeEach(() => api.rpc.mockResolvedValue({ data: null, error: null }));

it("does not turn mounting, rerendering or elapsed time into opens", async () => {
  const view = render(
    <StrictMode>
      <Links />
    </StrictMode>,
  );
  view.rerender(
    <StrictMode>
      <Links />
    </StrictMode>,
  );
  fireEvent(document, new Event("visibilitychange"));
  fireEvent(window, new Event("popstate"));
  expect(api.rpc).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Paper"), { button: 0, detail: 1 });
  expect(api.rpc).toHaveBeenCalledTimes(1);
  expect(api.rpc).toHaveBeenCalledWith("record_reader_open", {
    p_pmid: "1234",
    p_kind: "detail",
    p_event_id: expect.any(String),
  });
});
it("counts deliberate repeat actions and deduplicates a browser double-click", () => {
  render(<Links />);
  fireEvent.click(screen.getByText("Paper"), { detail: 1 });
  fireEvent.click(screen.getByText("Paper"), { detail: 2 });
  fireEvent.click(screen.getByText("Paper"), { detail: 1 });
  expect(api.rpc).toHaveBeenCalledTimes(2);
  expect(api.rpc.mock.calls[0][1].p_event_id).not.toBe(api.rpc.mock.calls[1][1].p_event_id);
});
it("counts keyboard, modified and middle clicks on detail, original and publisher links", () => {
  render(<Links />);
  fireEvent.click(screen.getByText("Paper"), { detail: 0 });
  fireEvent.click(screen.getByText("Original"), { detail: 1, ctrlKey: true });
  fireEvent(
    screen.getByText("Publisher"),
    new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1, detail: 1 }),
  );
  expect(api.rpc.mock.calls.map(([, args]) => args.p_kind)).toEqual(["detail", "original", "publisher"]);
});
it("ignores right-clicks, downloads, disabled links and unrelated navigation", () => {
  render(<Links />);
  fireEvent.click(screen.getByText("Paper"), { button: 2 });
  for (const name of ["Other site", "Download", "Disabled", "Library"])
    fireEvent.click(screen.getByText(name));
  expect(api.rpc).not.toHaveBeenCalled();
});
it("removes listeners on signout and does not send offline or invalid identities", async () => {
  const view = render(<Links />);
  view.rerender(<Links user={null} />);
  fireEvent.click(screen.getByText("Paper"));
  for (const args of [
    [null, "1234", "detail"],
    [{ id: "reader", offline: true }, "1234", "detail"],
    [{ id: "reader" }, "bad", "detail"],
    [{ id: "reader" }, "1234", "fake"],
  ]) {
    expect(await recordPaperOpen(...args)).toBe(false);
  }
  expect(api.rpc).not.toHaveBeenCalled();
});
it("does not block navigation or claim a stored click when the request fails", async () => {
  api.rpc.mockResolvedValue({ error: new Error("Offline") });
  await act(async () => expect(await recordPaperOpen({ id: "reader" }, "1234", "original")).toBe(false));
  expect(api.rpc).toHaveBeenCalledTimes(1);
});
