const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || "";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
let identityLoading;

export const googleDocsConfigured = () => /\.apps\.googleusercontent\.com$/.test(CLIENT_ID);

export function prepareGoogleDocs() {
  if (!googleDocsConfigured()) return Promise.resolve(false);
  if (window.google?.accounts?.oauth2) return Promise.resolve(true);
  if (identityLoading) return identityLoading;
  identityLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => {
      if (window.google?.accounts?.oauth2) resolve(true);
      else {
        identityLoading = undefined;
        script.remove();
        reject(new Error("Google 연결을 준비하지 못했습니다. 다시 시도해 주세요."));
      }
    };
    script.onerror = () => {
      identityLoading = undefined;
      script.remove();
      reject(new Error("Google 연결을 불러오지 못했습니다. 다시 시도해 주세요."));
    };
    document.head.appendChild(script);
  });
  return identityLoading;
}

// The token is used for this explicit export only. No refresh token or Drive
// contents are saved in localStorage, the service database, or the document.
export function authorizeGoogleExport() {
  if (!googleDocsConfigured())
    throw new Error("Google Docs 연결이 아직 설정되지 않았습니다. Word 파일은 바로 받을 수 있습니다.");
  if (!window.google?.accounts?.oauth2)
    throw new Error("Google 연결을 준비하는 중입니다. 잠시 후 다시 눌러 주세요.");
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      include_granted_scopes: false,
      callback: (result) => {
        if (result.error || !result.access_token)
          return reject(new Error("Google 문서 접근을 승인하지 않아 내보내기를 마치지 못했습니다."));
        if (!window.google.accounts.oauth2.hasGrantedAllScopes(result, SCOPE))
          return reject(new Error("새 문서를 만들기 위한 Google Drive 권한이 필요합니다."));
        resolve(result.access_token);
      },
      error_callback: () =>
        reject(new Error("Google 연결 창이 닫혔거나 열리지 않았습니다. 다시 시도해 주세요.")),
    });
    client.requestAccessToken({ prompt: "select_account" });
  });
}

export async function uploadGoogleDocument({ token, blob, title, exportId, signal }, fetcher = fetch) {
  if (!token || !(blob instanceof Blob) || !/^[a-zA-Z0-9_-]{1,100}$/.test(exportId || ""))
    throw new Error("문서 내보내기 정보가 올바르지 않습니다.");
  const metadata = {
    name: String(title || "연구 자료").slice(0, 180),
    mimeType: "application/vnd.google-apps.document",
    appProperties: { uroExportId: exportId },
  };
  const boundary = "uro-research-" + crypto.randomUUID();
  const body = new Blob(
    [
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify(metadata),
      `\r\n--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.wordprocessingml.document\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`,
    ],
    { type: `multipart/related; boundary=${boundary}` },
  );
  const headers = { Authorization: "Bearer " + token };
  try {
    const response = await fetcher(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink",
      {
        method: "POST",
        headers,
        body,
        signal,
      },
    );
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        throw new Error("Google 문서를 만들 권한을 확인해 주세요. 다시 연결한 뒤 내보낼 수 있습니다.");
      throw new Error("Google 문서를 만들지 못했습니다. Word 파일을 받거나 잠시 후 다시 시도해 주세요.");
    }
    const result = await response.json();
    if (!/^[a-zA-Z0-9_-]+$/.test(result.id || ""))
      throw new Error("Google 문서 생성 결과를 확인할 수 없습니다.");
    return { id: result.id, url: `https://docs.google.com/document/d/${result.id}/edit` };
  } catch (error) {
    // A lost POST response is ambiguous. Reconcile by this one export's ID;
    // never blindly repeat a create and produce duplicate Google documents.
    if (signal?.aborted) throw error;
    const q = `trashed = false and appProperties has { key='uroExportId' and value='${exportId}' }`;
    try {
      const response = await fetcher(
        "https://www.googleapis.com/drive/v3/files?" +
          new URLSearchParams({ q, fields: "files(id)", pageSize: "2" }),
        { headers, signal },
      );
      if (response.ok) {
        const result = await response.json();
        if (result.files?.length === 1 && /^[a-zA-Z0-9_-]+$/.test(result.files[0].id))
          return {
            id: result.files[0].id,
            url: `https://docs.google.com/document/d/${result.files[0].id}/edit`,
          };
      }
    } catch {
      /* Preserve the original export error. */
    }
    throw error;
  }
}
