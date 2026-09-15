import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import { checked } from "./data";
import { rpc } from "./workspace";
import { useResource } from "../components/ReaderUI";

// One day's bounded recommendation queue. Detail requests are deduplicated and only
// the adjacent article is prefetched; private state never enters persistent storage.
export function useDailyReader(uid, day, requestedPmid, active = true) {
  const queue = useResource(
    async () => ({ uid, day, cards: await rpc("reader_daily", { p_day: day }) }),
    [uid, day],
  );
  const session = useMemo(() => ({ cache: new Map(), pending: new Map(), opened: new Set() }), [uid, day]);
  const currentSession = useRef(session);
  currentSession.current = session;
  const [states, setStates] = useState({});
  const [opinions, setOpinions] = useState({});
  const [reasons, setReasons] = useState({});
  const [scores, setScores] = useState({});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const automaticWrite = useRef(null);
  const manualWrite = useRef(false);
  const [automaticRevision, setAutomaticRevision] = useState(0);
  const cards = queue.data?.uid === uid && queue.data?.day === day ? queue.data.cards : [];
  const index = Math.max(
    0,
    cards.findIndex((p) => p.pmid === requestedPmid),
  );
  const selected = cards[index];

  function load(pmid) {
    if (session.cache.has(pmid)) return Promise.resolve(session.cache.get(pmid));
    if (!session.pending.has(pmid)) {
      const request = rpc("reader_paper", { p_pmid: pmid })
        .then((result) => {
          if (!result?.paper)
            throw new Error("이 문헌을 불러올 수 없습니다. 다른 문헌을 선택하거나 다시 시도해 주세요.");
          session.cache.set(pmid, result);
          return result;
        })
        .finally(() => session.pending.delete(pmid));
      session.pending.set(pmid, request);
    }
    return session.pending.get(pmid);
  }
  const loadedDetail = useResource(() => (selected ? load(selected.pmid) : null), [session, selected?.pmid]);
  const loadedId = loadedDetail.data?.paper?.id;
  // A cached detail can resolve just after a write. Committed state takes precedence
  // over that earlier snapshot, including while returning rapidly to the same paper.
  const detail = {
    ...loadedDetail,
    data: loadedDetail.data
      ? {
          ...loadedDetail.data,
          state: states[loadedId] || loadedDetail.data.state,
          opinion: opinions[loadedId] ?? loadedDetail.data.opinion,
        }
      : null,
  };

  useEffect(() => {
    setStates({});
    setOpinions({});
    setReasons({});
    setScores({});
    setNotice(null);
  }, [session]);
  useEffect(() => {
    if (!cards.length) return;
    let live = true;
    checked(
      supabase
        .from("recommendations")
        .select("paper_id,reasons,score")
        .eq("user_id", uid)
        .eq("rec_date", day)
        .in(
          "paper_id",
          cards.map((p) => p.id),
        )
        .limit(5),
    )
      .then((rows) => {
        if (live) {
          setReasons(Object.fromEntries((rows || []).map((r) => [r.paper_id, r.reasons])));
          setScores(Object.fromEntries((rows || []).map((r) => [r.paper_id, r.score])));
        }
      })
      .catch(() => {}); // The server's recommendation explanation remains available.
    checked(
      supabase
        .from("feedbacks")
        .select("paper_id,action")
        .eq("user_id", uid)
        .in(
          "paper_id",
          cards.map((p) => p.id),
        )
        .limit(5),
    )
      .then((rows) => {
        // A late initial read must not overwrite an opinion changed in this session.
        if (live)
          setOpinions((previous) => ({
            ...Object.fromEntries((rows || []).map((row) => [row.paper_id, row.action])),
            ...previous,
          }));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [queue.data, uid, day]);
  useEffect(() => {
    if (!detail.data?.paper) return;
    const adjacent = cards[index + 1];
    if (adjacent) load(adjacent.pmid).catch(() => {});
  }, [detail.data?.paper?.id, queue.data]);

  function updateCached(paperId, values) {
    for (const [pmid, value] of session.cache) {
      if (value.paper.id === paperId) session.cache.set(pmid, { ...value, ...values });
    }
    if (currentSession.current !== session) return;
    if (values.state) setStates((previous) => ({ ...previous, [paperId]: values.state }));
    if (values.opinion !== undefined) setOpinions((previous) => ({ ...previous, [paperId]: values.opinion }));
    detail.setData((previous) => (previous?.paper?.id === paperId ? { ...previous, ...values } : previous));
  }

  useEffect(() => {
    const data = detail.data;
    if (
      !active ||
      busy ||
      lock.current ||
      !data?.paper ||
      session.opened.has(data.paper.id) ||
      data.paper.pmid !== selected?.pmid ||
      (data.state?.reading_state && data.state.reading_state !== "unread")
    )
      return;
    // Serialize the automatic "reading" marker with explicit save/read actions.
    // A slow response always updates the paper that initiated it.
    const paperId = data.paper.id;
    session.opened.add(paperId);
    lock.current = true;
    automaticWrite.current = rpc("update_reader_state", {
      p_paper_id: paperId,
      p_patch: { reading_state: "reading" },
    })
      .then((state) => updateCached(paperId, { state }))
      .catch(() => {})
      .finally(() => {
        automaticWrite.current = null;
        lock.current = false;
        setAutomaticRevision((n) => n + 1);
      });
  }, [detail.data?.paper?.id, busy, active, automaticRevision]);

  async function commit(paperId, patch, opinion, previous, message) {
    // Retain a click that arrives between rendering and the automatic reading marker.
    // The initiating paper ID and patch are captured before this wait.
    if (manualWrite.current) return;
    manualWrite.current = true;
    setBusy(true);
    setNotice(null);
    try {
      if (automaticWrite.current) await automaticWrite.current;
      lock.current = true;
      if (opinion !== undefined) {
        await rpc("reader_opinion", { p_paper_id: paperId, p_action: opinion });
        updateCached(paperId, { opinion });
      } else {
        const state = await rpc("update_reader_state", { p_paper_id: paperId, p_patch: patch });
        updateCached(paperId, { state });
      }
      if (currentSession.current === session)
        setNotice({ message, undo: previous ? { paperId, ...previous } : null });
    } catch (e) {
      if (currentSession.current === session)
        setNotice({ message: e.message || "저장하지 못했습니다. 다시 시도해 주세요.", error: true });
    } finally {
      manualWrite.current = false;
      lock.current = false;
      setBusy(false);
    }
  }
  function change(patch, message) {
    const p = detail.data?.paper;
    if (!p) return;
    const state = detail.data.state || {};
    const old = Object.fromEntries(
      Object.keys(patch).map((key) => [key, state[key] ?? (key === "saved" ? false : "unread")]),
    );
    return commit(p.id, patch, undefined, { patch: old }, message);
  }
  function opinion(value) {
    const p = detail.data?.paper;
    if (!p) return;
    const old = detail.data.opinion || "none";
    return commit(
      p.id,
      undefined,
      value === old ? "none" : value,
      { opinion: old },
      "추천 의견을 반영했습니다.",
    );
  }
  function undo() {
    const previous = notice?.undo;
    if (previous)
      return commit(previous.paperId, previous.patch, previous.opinion, null, "변경을 되돌렸습니다.");
  }
  return {
    queue,
    cards,
    index,
    selected,
    detail,
    states,
    opinions,
    reasons,
    scores,
    change,
    opinion,
    undo,
    notice,
    setNotice,
    busy,
  };
}
