import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "123-test.apps.googleusercontent.com");
  delete window.google;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Google document export", () => {
  it("requests only drive.file, keeps the token transient and handles denied scope", async () => {
    const { authorizeGoogleExport } = await import("./googleDocsExport");
    let options;
    const requestAccessToken = vi.fn();
    window.google = {
      accounts: {
        oauth2: {
          initTokenClient: vi.fn((input) => {
            options = input;
            return { requestAccessToken };
          }),
          hasGrantedAllScopes: vi.fn(() => true),
        },
      },
    };
    const store = vi.spyOn(Storage.prototype, "setItem");
    const token = authorizeGoogleExport();
    expect(options.scope).toBe("https://www.googleapis.com/auth/drive.file");
    expect(options.include_granted_scopes).toBe(false);
    expect(requestAccessToken).toHaveBeenCalledWith({ prompt: "select_account" });
    options.callback({ access_token: "synthetic-token" });
    await expect(token).resolves.toBe("synthetic-token");
    expect(store).not.toHaveBeenCalled();
    const denied = authorizeGoogleExport();
    options.callback({ error: "access_denied" });
    await expect(denied).rejects.toThrow("승인하지 않아");
  });

  it("creates a native Google document from DOCX and ignores a returned offsite URL", async () => {
    const { uploadGoogleDocument } = await import("./googleDocsExport");
    const fetcher = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ id: "document_123", webViewLink: "https://example.org/invalid" }),
      });
    const result = await uploadGoogleDocument(
      { token: "test", blob: new Blob(["docx"]), title: "연구", exportId: "export-123" },
      fetcher,
    );
    expect(result.url).toBe("https://docs.google.com/document/d/document_123/edit");
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toContain("uploadType=multipart");
    expect(request.method).toBe("POST");
    expect(request.headers.Authorization).toBe("Bearer test");
    expect(request.body.type).toContain("multipart/related");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reconciles a lost create response by export ID without creating twice", async () => {
    const { uploadGoogleDocument } = await import("./googleDocsExport");
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ files: [{ id: "recovered" }] }) });
    await expect(
      uploadGoogleDocument({ token: "test", blob: new Blob(["docx"]), exportId: "one-intent" }, fetcher),
    ).resolves.toEqual({ id: "recovered", url: "https://docs.google.com/document/d/recovered/edit" });
    expect(fetcher.mock.calls.filter(([, options]) => options.method === "POST")).toHaveLength(1);
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get("q")).toContain("value='one-intent'");
  });

  it("rejects invalid IDs before transmission and never guesses an ambiguous document", async () => {
    const { uploadGoogleDocument } = await import("./googleDocsExport");
    const fetcher = vi.fn();
    await expect(
      uploadGoogleDocument({ token: "test", blob: new Blob(), exportId: "bad'id" }, fetcher),
    ).rejects.toThrow("올바르지");
    expect(fetcher).not.toHaveBeenCalled();
    fetcher
      .mockRejectedValueOnce(new Error("lost"))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ files: [{ id: "a" }, { id: "b" }] }) });
    await expect(
      uploadGoogleDocument({ token: "test", blob: new Blob(), exportId: "valid" }, fetcher),
    ).rejects.toThrow("lost");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not create a fallback file after cancellation", async () => {
    const { uploadGoogleDocument } = await import("./googleDocsExport");
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn().mockRejectedValue(new Error("aborted"));
    await expect(
      uploadGoogleDocument(
        { token: "test", blob: new Blob(), exportId: "valid", signal: controller.signal },
        fetcher,
      ),
    ).rejects.toThrow("aborted");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
