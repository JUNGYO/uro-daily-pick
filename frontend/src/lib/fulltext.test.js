import { afterEach, expect, test, vi } from "vitest";
vi.mock("./supabase", () => ({ supabase: { auth: { getSession: vi.fn() } } }));
import { supabase } from "./supabase";
import { canReadOriginal, fulltextOrigin, readOriginal } from "./fulltext";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

test("destinations are deployment-controlled HTTPS origins", () => {
  for (const value of [
    "",
    "http://host.test",
    "https://a@host.test",
    "https://host.test/path",
    "https://host.test?x=1",
  ]) {
    vi.stubEnv("VITE_FULLTEXT_ORIGIN", value);
    expect(fulltextOrigin()).toBe("");
  }
  vi.stubEnv("VITE_FULLTEXT_ORIGIN", "https://host.test:8443/");
  expect(fulltextOrigin()).toBe("https://host.test:8443");
  expect(canReadOriginal({ email: "crazyslime@gmail.com" }, { pmid: "1234", fulltext_storage: "z8" })).toBe(
    true,
  );
  expect(canReadOriginal({ email: "another@example.test" }, { pmid: "1234", fulltext_storage: "z8" })).toBe(
    false,
  );
});

test("session must belong to current user; token stays in Authorization header", async () => {
  vi.stubEnv("VITE_FULLTEXT_ORIGIN", "https://articles.example.test");
  const fetch = vi
    .fn()
    .mockResolvedValue({
      ok: true,
      json: async () => ({ pmid: "1234", title: "Fixture", content_text: "Body" }),
    });
  vi.stubGlobal("fetch", fetch);
  supabase.auth.getSession.mockResolvedValue({
    data: { session: { user: { id: "owner" }, access_token: "fixture-token" } },
  });
  await expect(readOriginal("1234", "different-user")).rejects.toThrow("로그인");
  expect(fetch).not.toHaveBeenCalled();
  await expect(readOriginal("../private", "owner")).rejects.toThrow("논문 번호");
  await readOriginal("1234", "owner");
  expect(fetch).toHaveBeenCalledWith(
    "https://articles.example.test/v1/fulltext/1234",
    expect.objectContaining({
      headers: { Authorization: "Bearer fixture-token" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    }),
  );
});

test("denied account and missing originals show honest errors", async () => {
  vi.stubEnv("VITE_FULLTEXT_ORIGIN", "https://articles.example.test");
  supabase.auth.getSession.mockResolvedValue({
    data: { session: { user: { id: "owner" }, access_token: "fixture-token" } },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
  await expect(readOriginal("1234", "owner")).rejects.toThrow("권한");
  fetch.mockResolvedValue({ ok: false, status: 404 });
  await expect(readOriginal("1234", "owner")).rejects.toThrow("아직 보관");
});
