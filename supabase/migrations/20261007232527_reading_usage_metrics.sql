BEGIN;

-- Versioned definitions; never reinterpret legacy dwell rows as these observations.
CREATE TABLE app_private.reader_usage_policy (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), started_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO app_private.reader_usage_policy DEFAULT VALUES;
CREATE TABLE app_private.reader_content_sessions (
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 session_id uuid NOT NULL, paper_id bigint NOT NULL REFERENCES public.papers(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('summary','original')),
 started_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
 active_seconds integer NOT NULL DEFAULT 0 CHECK(active_seconds BETWEEN 0 AND 7200),
 sampled_sections integer[] NOT NULL DEFAULT '{}' CHECK(cardinality(sampled_sections)<=20),
 qualified_at timestamptz, PRIMARY KEY(user_id,session_id)
);
CREATE INDEX reader_content_window ON app_private.reader_content_sessions(started_at,user_id);
CREATE INDEX reader_content_paper ON app_private.reader_content_sessions(paper_id);
CREATE TABLE app_private.reader_usage_actions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
 paper_id bigint REFERENCES public.papers(id) ON DELETE SET NULL,
 project_id bigint REFERENCES public.collections(id) ON DELETE SET NULL,
 kind text NOT NULL CHECK(kind IN ('save','like','note','project_add','screening','extraction','reference_export','writing','document_export')),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reader_usage_action_window ON app_private.reader_usage_actions(created_at,user_id);
CREATE INDEX reader_usage_action_user ON app_private.reader_usage_actions(user_id,paper_id,created_at);
CREATE INDEX reader_usage_action_paper ON app_private.reader_usage_actions(paper_id);
CREATE INDEX reader_usage_action_project ON app_private.reader_usage_actions(project_id);
ALTER TABLE app_private.reader_usage_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.reader_content_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_private.reader_usage_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON app_private.reader_usage_policy,app_private.reader_content_sessions,app_private.reader_usage_actions FROM PUBLIC,anon,authenticated;

CREATE FUNCTION public.record_reader_content(p_pmid text,p_kind text,p_session uuid,p_seconds integer DEFAULT 0,p_sections integer[] DEFAULT '{}')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid=auth.uid(); pid bigint; previous app_private.reader_content_sessions; sampled integer[];
BEGIN
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=actor) THEN
  RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
 IF p_session IS NULL OR p_pmid IS NULL OR p_pmid !~ '^[0-9]{1,10}$' OR p_kind IS NULL OR p_kind NOT IN ('summary','original')
 OR p_seconds IS NULL OR p_seconds NOT BETWEEN 0 AND 7200 OR p_sections IS NULL OR cardinality(p_sections)>20
 OR EXISTS(SELECT 1 FROM unnest(p_sections) n WHERE n IS NULL OR n NOT BETWEEN 0 AND 19) THEN
  RAISE EXCEPTION 'Invalid content observation' USING ERRCODE='22023'; END IF;
 SELECT id INTO pid FROM public.papers WHERE pmid=p_pmid AND
  CASE WHEN p_kind='summary' THEN public.paper_ready(papers) ELSE fulltext_available END;
 IF pid IS NULL THEN RAISE EXCEPTION 'Content unavailable' USING ERRCODE='22023'; END IF;
 INSERT INTO app_private.reader_content_sessions(user_id,session_id,paper_id,kind)
 VALUES(actor,p_session,pid,p_kind) ON CONFLICT DO NOTHING;
 SELECT * INTO previous FROM app_private.reader_content_sessions WHERE user_id=actor AND session_id=p_session FOR UPDATE;
 IF previous.paper_id<>pid OR previous.kind<>p_kind THEN RAISE EXCEPTION 'Session does not match' USING ERRCODE='22023'; END IF;
 IF p_seconds>extract(epoch FROM now()-previous.started_at)+5 THEN
  RAISE EXCEPTION 'Observation exceeds elapsed time' USING ERRCODE='22023'; END IF;
 SELECT coalesce(array_agg(DISTINCT n ORDER BY n),'{}') INTO sampled FROM unnest(previous.sampled_sections||p_sections) n;
 -- Cumulative snapshots can arrive out of order or be retried without adding time twice.
 UPDATE app_private.reader_content_sessions SET active_seconds=greatest(active_seconds,p_seconds),
  sampled_sections=sampled,last_seen_at=now(),qualified_at=CASE
   WHEN qualified_at IS NOT NULL THEN qualified_at
   WHEN greatest(active_seconds,p_seconds)>=CASE WHEN kind='summary' THEN 30 ELSE 60 END AND cardinality(sampled)>0 THEN now()
   ELSE NULL END
 WHERE user_id=actor AND session_id=p_session;
END;
$$;
REVOKE ALL ON FUNCTION public.record_reader_content(text,text,uuid,integer,integer[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_reader_content(text,text,uuid,integer,integer[]) TO authenticated;

-- Called only after the local reference download has been initiated. This does not
-- claim that Zotero imported it or that an author cited it in a finished manuscript.
CREATE FUNCTION public.record_reference_export(p_papers bigint[],p_event uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid=auth.uid(); pid bigint;
BEGIN
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=actor) THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
 IF p_event IS NULL OR p_papers IS NULL OR cardinality(p_papers) NOT BETWEEN 1 AND 100
 OR EXISTS(SELECT 1 FROM unnest(p_papers) n LEFT JOIN public.papers p ON p.id=n WHERE p.id IS NULL) THEN
  RAISE EXCEPTION 'Invalid references' USING ERRCODE='22023'; END IF;
 -- One export operation, even when multiple references are selected.
 pid=CASE WHEN cardinality(p_papers)=1 THEN p_papers[1] ELSE NULL END;
 INSERT INTO app_private.reader_usage_actions(id,user_id,paper_id,kind) VALUES(p_event,actor,pid,'reference_export') ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM app_private.reader_usage_actions WHERE id=p_event AND user_id=actor AND kind='reference_export' AND paper_id IS NOT DISTINCT FROM pid) THEN
  RAISE EXCEPTION 'Export event does not match' USING ERRCODE='22023'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.record_reference_export(bigint[],uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_reference_export(bigint[],uuid) TO authenticated;

-- Successful persisted actions only; neither private note contents nor extracted
-- values enter the analytics ledger. Background worker writes have no auth.uid().
CREATE FUNCTION app_private.capture_reader_usage() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid=auth.uid(); n jsonb=to_jsonb(NEW); o jsonb=CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
 k text; pid bigint; project bigint;
BEGIN
 IF actor IS NULL OR NOT EXISTS(SELECT 1 FROM public.profiles WHERE id=actor) THEN RETURN NEW; END IF;
 pid=(n->>'paper_id')::bigint; project=coalesce(n->>'collection_id',n->>'project_id')::bigint;
 IF TG_TABLE_NAME='reader_states' THEN
  IF (n->>'user_id')::uuid<>actor THEN RETURN NEW; END IF;
  IF NEW.saved AND (TG_OP='INSERT' OR NOT OLD.saved) THEN
   INSERT INTO app_private.reader_usage_actions(user_id,paper_id,kind) VALUES(actor,pid,'save'); END IF;
  IF btrim(NEW.note)<>'' AND n->>'note' IS DISTINCT FROM o->>'note' THEN k='note'; END IF;
 ELSIF TG_TABLE_NAME='feedbacks' THEN
  IF (n->>'user_id')::uuid=actor AND n->>'action'='like' AND n->>'action' IS DISTINCT FROM o->>'action' THEN k='like'; END IF;
 ELSIF TG_TABLE_NAME='collection_papers' THEN k='project_add';
 ELSIF TG_TABLE_NAME='project_notes' THEN
  -- The compatibility writer mirrors this note into research_reference_entries.
  -- Count that durable edit once, even when its trigger executes first.
  IF btrim(n->>'note')<>'' AND n->>'note' IS DISTINCT FROM o->>'note'
   AND NOT EXISTS(SELECT 1 FROM public.research_reference_entries WHERE collection_id=project AND paper_id=pid)
   THEN k='note'; END IF;
 ELSIF TG_TABLE_NAME='research_reference_entries' THEN
  IF n->'user_values'<>'{}'::jsonb AND n->'user_values' IS DISTINCT FROM o->'user_values' THEN k='extraction';
  ELSIF btrim(n->>'note')<>'' AND n->>'note' IS DISTINCT FROM o->>'note' THEN k='note'; END IF;
 ELSIF TG_TABLE_NAME='research_topic_entries' THEN
  IF btrim(n->>'body')<>'' AND n->>'body' IS DISTINCT FROM o->>'body' THEN k='writing'; END IF;
 ELSIF TG_TABLE_NAME='research_document_exports' THEN k='document_export';
 ELSIF TG_TABLE_NAME='review_reports' THEN
  IF (n->>'ta_decision'<>'pending' AND n->>'ta_decision' IS DISTINCT FROM o->>'ta_decision')
   OR (n->>'ft_decision'<>'pending' AND n->>'ft_decision' IS DISTINCT FROM o->>'ft_decision') THEN k='screening'; END IF;
 ELSIF TG_TABLE_NAME='review_observations' THEN
  IF (n-'revision'-'updated_at'-'updated_by') IS DISTINCT FROM (o-'revision'-'updated_at'-'updated_by') THEN
   SELECT paper_id INTO pid FROM public.review_reports WHERE id=(n->>'report_id')::uuid; k='extraction'; END IF;
 END IF;
 IF k IS NOT NULL THEN INSERT INTO app_private.reader_usage_actions(user_id,paper_id,project_id,kind) VALUES(actor,pid,project,k); END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app_private.capture_reader_usage() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER usage_reader_states AFTER INSERT OR UPDATE ON public.reader_states FOR EACH ROW EXECUTE FUNCTION app_private.capture_reader_usage();
CREATE TRIGGER usage_feedbacks AFTER INSERT OR UPDATE ON public.feedbacks FOR EACH ROW EXECUTE FUNCTION app_private.capture_reader_usage();
CREATE TRIGGER usage_collection_papers AFTER INSERT ON public.collection_papers FOR EACH ROW EXECUTE FUNCTION app_private.capture_reader_usage();
CREATE TRIGGER usage_project_notes AFTER INSERT OR UPDATE ON public.project_notes FOR EACH ROW EXECUTE FUNCTION app_private.capture_reader_usage();
CREATE TRIGGER usage_research_reference AFTER INSERT OR UPDATE ON public.research_reference_entries FOR EACH ROW EXECUTE FUNCTION app_private.capture_reader_usage();
CREATE TRIGGER usage_research_topic AFTER INSERT OR UPDATE ON public.research_topic_entries FOR EACH ROW EXECUTE FUNCTION app_private.capture_reader_usage();
CREATE TRIGGER usage_research_export AFTER INSERT ON public.research_document_exports FOR EACH ROW EXECUTE FUNCTION app_private.capture_reader_usage();
CREATE TRIGGER usage_review_reports AFTER INSERT OR UPDATE ON public.review_reports FOR EACH ROW EXECUTE FUNCTION app_private.capture_reader_usage();
CREATE TRIGGER usage_review_observations AFTER INSERT OR UPDATE ON public.review_observations FOR EACH ROW EXECUTE FUNCTION app_private.capture_reader_usage();

CREATE FUNCTION public.admin_reader_usage(p_days integer DEFAULT 7) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' SET statement_timeout='8s' AS $$
DECLARE start_at timestamptz; measured_at timestamptz; result jsonb;
BEGIN
 PERFORM app_private.require_admin();
 IF p_days IS NULL OR p_days NOT IN (7,30) THEN RAISE EXCEPTION 'Invalid period' USING ERRCODE='22023'; END IF;
 SELECT started_at INTO measured_at FROM app_private.reader_usage_policy;
 start_at=((now() AT TIME ZONE 'Asia/Seoul')::date-(p_days-1))::timestamp AT TIME ZONE 'Asia/Seoul';
 WITH sessions AS MATERIALIZED (
  SELECT * FROM app_private.reader_content_sessions WHERE started_at>=greatest(start_at,measured_at)
 ), actions AS MATERIALIZED (
  SELECT * FROM app_private.reader_usage_actions WHERE created_at>=greatest(start_at,measured_at)
 ), touches AS MATERIALIZED (
  SELECT user_id,paper_id,started_at AS at FROM sessions
  UNION ALL SELECT user_id,paper_id,last_seen_at FROM sessions
  UNION ALL SELECT user_id,paper_id,created_at FROM actions
 ), session_totals AS (
  SELECT user_id,count(DISTINCT paper_id) FILTER(WHERE kind='summary') AS summary_papers,
   count(DISTINCT paper_id) FILTER(WHERE kind='original') AS original_papers,
   count(DISTINCT paper_id) FILTER(WHERE qualified_at IS NOT NULL) AS engaged_papers,
   sum(active_seconds) AS active_seconds,count(DISTINCT paper_id) AS viewed_papers FROM sessions GROUP BY user_id
 ), action_totals AS (
  SELECT user_id,count(*) FILTER(WHERE kind IN ('save')) AS saves,
   count(*) FILTER(WHERE kind IN ('like')) AS likes,
   count(*) FILTER(WHERE kind IN ('note')) AS notes,
   count(*) FILTER(WHERE kind IN ('project_add')) AS project_adds,
   count(*) FILTER(WHERE kind IN ('screening')) AS screenings,
   count(*) FILTER(WHERE kind IN ('extraction')) AS extractions,
   count(*) FILTER(WHERE kind IN ('reference_export','document_export')) AS exports,
   count(*) FILTER(WHERE kind IN ('writing')) AS writing FROM actions GROUP BY user_id
 ), activity_totals AS (
  SELECT user_id,count(DISTINCT (at AT TIME ZONE 'Asia/Seoul')::date) AS active_days,max(at) AS last_activity_at FROM touches GROUP BY user_id
 ), first_views AS (
  SELECT user_id,paper_id,min(started_at) AS at FROM sessions GROUP BY user_id,paper_id
 ), last_uses AS (
  SELECT user_id,paper_id,max(created_at) AS at FROM actions
  WHERE kind IN ('save','note','project_add','screening','extraction','reference_export') AND paper_id IS NOT NULL GROUP BY user_id,paper_id
 ), conversions AS (
  SELECT v.user_id,count(*) AS used_after_view FROM first_views v JOIN last_uses a USING(user_id,paper_id) WHERE a.at>=v.at GROUP BY v.user_id
 ), user_rows AS MATERIALIZED (
  SELECT p.id,p.name,coalesce(s.summary_papers,0) AS summary_papers,coalesce(s.original_papers,0) AS original_papers,
   coalesce(s.engaged_papers,0) AS engaged_papers,coalesce(s.active_seconds,0) AS active_seconds,
   coalesce(s.viewed_papers,0) AS viewed_papers,coalesce(t.active_days,0) AS active_days,t.last_activity_at,
   coalesce(c.used_after_view,0) AS used_after_view,
   coalesce(a.saves,0) AS saves,
   coalesce(a.likes,0) AS likes,
   coalesce(a.notes,0) AS notes,
   coalesce(a.project_adds,0) AS project_adds,
   coalesce(a.screenings,0) AS screenings,
   coalesce(a.extractions,0) AS extractions,
   coalesce(a.exports,0) AS exports,
   coalesce(a.writing,0) AS writing
  FROM public.profiles p LEFT JOIN session_totals s ON s.user_id=p.id LEFT JOIN action_totals a ON a.user_id=p.id
  LEFT JOIN activity_totals t ON t.user_id=p.id LEFT JOIN conversions c ON c.user_id=p.id
 ), days AS (
  SELECT generate_series((start_at AT TIME ZONE 'Asia/Seoul')::date,(now() AT TIME ZONE 'Asia/Seoul')::date,'1 day'::interval)::date AS day
 )
 SELECT jsonb_build_object('days',p_days,'measured_since',measured_at,'window_start',greatest(start_at,measured_at),'as_of',now(),
 'active_users',(SELECT count(*) FROM user_rows WHERE active_days>0),
 'viewing_users',(SELECT count(*) FROM user_rows WHERE viewed_papers>0),
 'engaged_users',(SELECT count(*) FROM user_rows WHERE engaged_papers>0),
 'returning_users',(SELECT count(*) FROM user_rows WHERE active_days>=2),
 'usage_users',(SELECT count(DISTINCT user_id) FROM actions WHERE kind<>'like'),
 'viewed_user_papers',(SELECT coalesce(sum(viewed_papers),0) FROM user_rows),
 'used_user_papers',(SELECT coalesce(sum(used_after_view),0) FROM user_rows),
 'users',(SELECT coalesce(jsonb_agg(to_jsonb(u)-'id' ORDER BY last_activity_at DESC NULLS LAST,name),'[]') FROM user_rows u),
 'daily',(SELECT jsonb_agg(jsonb_build_object('day',day,'active_users',(SELECT count(DISTINCT user_id) FROM touches WHERE (at AT TIME ZONE 'Asia/Seoul')::date=day),
   'viewing_users',(SELECT count(DISTINCT user_id) FROM sessions WHERE (started_at AT TIME ZONE 'Asia/Seoul')::date=day),
   'usage_users',(SELECT count(DISTINCT user_id) FROM actions WHERE kind<>'like' AND (created_at AT TIME ZONE 'Asia/Seoul')::date=day)) ORDER BY day) FROM days)
 ) INTO result;
 RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.admin_reader_usage(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_reader_usage(integer) TO authenticated;
COMMIT;
