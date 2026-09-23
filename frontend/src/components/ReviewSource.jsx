import { useState } from "react";

export default function ReviewSource({ name, initialHash = "", fixed = false, onChange = () => {} }) {
  const [hash, setHash] = useState(initialHash),
    [fileName, setFileName] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="review-source">
      <input type="hidden" name={name} value={hash} />
      <p>
        {hash ? "출처 버전 확인됨" : "원문 파일을 선택해 출처 버전을 기록하세요."}
        {fileName && ` · ${fileName}`}
      </p>
      {!fixed && (
        <label>
          원문·보충자료 파일 선택
          <input
            type="file"
            disabled={busy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 100_000_000) {
                setError("100 MB 이하의 파일을 선택하세요.");
                return;
              }
              setBusy(true);
              setError("");
              try {
                const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
                setHash(Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join(""));
                setFileName(file.name);
                onChange();
              } catch {
                setError("파일 식별값을 만들지 못했습니다.");
              } finally {
                setBusy(false);
                e.target.value = "";
              }
            }}
          />
        </label>
      )}
      {!fixed && (
        <p className="reader-muted">
          이 선택으로 파일을 업로드하지 않습니다. 파일이 변경되었는지 확인할 식별값만 기록합니다.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {hash && (
        <details>
          <summary>출처 식별값</summary>
          <code className="review-hash">{hash}</code>
        </details>
      )}
    </div>
  );
}
