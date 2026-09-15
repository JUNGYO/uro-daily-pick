import { useEffect, useRef, useState } from "react";
import { readOriginalImage } from "../lib/fulltext";

export default function ArticleFigure({ figure, pmid, userId }) {
  const box = useRef(null);
  const dialog = useRef(null);
  const [visible, setVisible] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!globalThis.IntersectionObserver) {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || figure.status !== "ready") return;
    const controller = new AbortController();
    let active = true,
      objectUrl;
    setResult(null);
    setError("");
    const timer = setTimeout(() => controller.abort(), 25000);
    readOriginalImage(pmid, figure.asset_id, userId, controller.signal)
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setResult({ url: objectUrl, userId, assetId: figure.asset_id });
      })
      .catch(() => {
        if (active) setError("그림을 불러오지 못했습니다. 다시 시도해 주세요.");
      })
      .finally(() => clearTimeout(timer));
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [visible, figure.asset_id, figure.status, pmid, userId, retry]);
  const url = result?.userId === userId && result?.assetId === figure.asset_id ? result.url : null;
  const preview = figure.content_type !== "image/tiff";
  return (
    <figure ref={box} className="panel mb-5 min-w-0">
      <figcaption className="mb-3">
        <h3 className="font-semibold text-text1">{figure.label || "그림"}</h3>
        <p className="text-sm text-text2 mt-2 leading-relaxed break-words">{figure.caption}</p>
      </figcaption>
      {figure.status !== "ready" ? (
        <p className="help-text">이 그림은 준비 중입니다.</p>
      ) : error ? (
        <div role="alert">
          <p className="text-sm text-text2">{error}</p>
          <button type="button" className="text-accent min-h-11" onClick={() => setRetry((n) => n + 1)}>
            그림 다시 불러오기
          </button>
        </div>
      ) : !url ? (
        <p role="status" className="help-text">
          그림을 불러오는 중…
        </p>
      ) : (
        <>
          {preview && (
            <img src={url} alt={figure.label || "논문 그림"} className="w-full h-auto rounded bg-white" />
          )}
          <div className="flex flex-wrap gap-4 mt-3">
            {preview && (
              <button
                type="button"
                className="text-accent min-h-11"
                onClick={() => dialog.current.showModal()}
              >
                크게 보기
              </button>
            )}
            <a
              className="text-accent min-h-11 inline-flex items-center"
              href={url}
              download={`${pmid}-${figure.key}.${figure.content_type.split("/")[1]}`}
            >
              이미지 다운로드
            </a>
          </div>
          {!preview && <p className="help-text">이 그림은 TIFF 파일로 내려받아 확인할 수 있습니다.</p>}
          {preview && (
            <dialog
              ref={dialog}
              aria-label={`${figure.label || "그림"} 확대 보기`}
              className="rounded-xl p-4 w-[95vw] max-w-6xl max-h-[95vh] bg-card text-text1 backdrop:bg-black/60"
            >
              <form method="dialog" className="flex justify-end mb-3">
                <button className="btn-secondary min-h-11">닫기</button>
              </form>
              <img src={url} alt={figure.label || "논문 그림"} className="max-w-full h-auto bg-white" />
              <p className="text-sm mt-3 break-words">{figure.caption}</p>
            </dialog>
          )}
        </>
      )}
    </figure>
  );
}
