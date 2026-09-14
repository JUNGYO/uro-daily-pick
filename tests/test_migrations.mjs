// Run against an isolated PostgreSQL engine; never connects to Supabase.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const { PGlite } = await import(
  process.env.PGLITE_MODULE
    ? pathToFileURL(process.env.PGLITE_MODULE).href
    : pathToFileURL(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../frontend/node_modules/@electric-sql/pglite/dist/index.js",
        ),
      ).href
);
const db = new PGlite();
const migrations = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../supabase/migrations",
);
const admin = "00000000-0000-0000-0000-000000000001";
const reader = "00000000-0000-0000-0000-000000000002";
const unconfirmed = "00000000-0000-0000-0000-000000000003";
const functions = [
  "admin_stats()",
  "admin_daily_activity()",
  "admin_top_papers(10)",
  "admin_popular_keywords()",
  "admin_journal_dist()",
  "admin_user_engagement()",
  "admin_fulltext_status()",
];
try {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated;
  `);
  for (const file of (await readdir(migrations))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    if (file.startsWith("011_") || file.startsWith("012_") || file.startsWith("013_")) continue; // Test upgrades in order below.
    if (file.startsWith("008_")) {
      let encoded = ["Prostatic Neoplasms", "Randomized Controlled Trial"];
      for (let depth = 0; depth < 21; depth++)
        encoded = JSON.stringify(encoded);
      await db.query(
        "INSERT INTO public.papers(id,pmid,title,mesh_terms) VALUES(9000,'9000','Legacy encoding fixture',$1::jsonb)",
        [JSON.stringify(encoded)],
      );
    }
    await db.exec(
      (await readFile(path.join(migrations, file), "utf8")).replace(
        /^\uFEFF/,
        "",
      ),
    );
    if (file.startsWith("008_")) {
      assert.deepEqual(
        (await db.query("SELECT mesh_terms FROM public.papers WHERE id=9000"))
          .rows[0].mesh_terms,
        ["Prostatic Neoplasms", "Randomized Controlled Trial"],
      );
      await db.exec("DELETE FROM public.papers WHERE id=9000");
    }
  }
  await db.exec(`
    GRANT USAGE ON SCHEMA public TO anon, authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
    INSERT INTO auth.users VALUES
      ('${admin}', 'crazyslime@gmail.com', now(), '{}'),
      ('${reader}', 'reader@example.test', now(), '{}'),
      ('${unconfirmed}', 'crazyslime@gmail.com', null, '{}');
    INSERT INTO public.papers (pmid, title) VALUES ('1', 'Local test paper');
  `);
  async function asUser(role, id) {
    await db.exec(`SET ROLE ${role}`);
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [
      id,
    ]);
  }
  for (const [role, uid] of [
    ["anon", ""],
    ["authenticated", reader],
    ["authenticated", unconfirmed],
  ]) {
    await asUser(role, uid);
    for (const fn of functions) {
      await assert.rejects(db.query(`SELECT public.${fn}`), { code: "42501" });
    }
  }
  await asUser("authenticated", admin);
  for (const fn of functions) await db.query(`SELECT public.${fn}`);
  await asUser("authenticated", reader);
  await db.query("SELECT public.upsert_feedback($1, 1, 'like')", [reader]);
  assert.equal(
    (await db.query("SELECT action FROM public.feedbacks")).rows[0].action,
    "like",
  );
  await db.query("SELECT public.upsert_feedback($1, 1, 'none')", [reader]);
  assert.equal(
    (await db.query("SELECT * FROM public.feedbacks")).rows.length,
    0,
  );
  await assert.rejects(
    db.query("SELECT public.upsert_feedback($1, 1, 'like')", [admin]),
    { code: "42501" },
  );
  await assert.rejects(
    db.query("SELECT public.upsert_feedback($1, 1, 'unknown')", [reader]),
    {
      code: "22023",
    },
  );
  await db.query("SELECT public.set_paper_feedback(1, 'like')");
  await db.query("SELECT public.set_paper_feedback(1, 'like')");
  assert.equal(
    (await db.query("SELECT * FROM public.collection_papers")).rows.length,
    1,
  );
  assert.equal(
    (
      await db.query(
        "SELECT * FROM public.collections WHERE system_key = 'liked'",
      )
    ).rows.length,
    1,
  );
  await db.query("SELECT public.set_paper_feedback(1, 'none')");
  assert.equal(
    (await db.query("SELECT * FROM public.collection_papers")).rows.length,
    0,
  );
  await assert.rejects(
    db.query("SELECT public.set_paper_feedback(999, 'like')"),
    { code: "23503" },
  );
  assert.equal(
    (await db.query("SELECT * FROM public.feedbacks")).rows.length,
    0,
  );
  await assert.rejects(
    db.query(
      "SELECT public.replace_daily_recommendations($1, current_date, '[]')",
      [reader],
    ),
    { code: "42501" },
  );
  await assert.rejects(
    db.query("SELECT public.store_paper_fulltext(1, '{}')"),
    { code: "42501" },
  );
  await db.exec(
    "RESET ROLE; GRANT USAGE ON SCHEMA public TO service_role; GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;",
  );
  await asUser("service_role", "");
  const validRecs = JSON.stringify([{ paper_id: 1, score: 5, reasons: {} }]);
  await db.query(
    "SELECT public.replace_daily_recommendations($1, current_date, $2)",
    [reader, validRecs],
  );
  await assert.rejects(
    db.query(
      "SELECT public.replace_daily_recommendations($1, current_date, $2)",
      [reader, JSON.stringify([{ paper_id: 999, score: 1 }])],
    ),
    { code: "23503" },
  );
  assert.equal(
    (await db.query("SELECT paper_id FROM public.recommendations")).rows[0]
      .paper_id,
    1,
  );
  await db.query("SELECT public.store_paper_fulltext(1, $1)", [
    JSON.stringify({
      source: "test",
      content_text: "Local fixture. ".repeat(50),
      content_hash: "a".repeat(64),
      sections: [],
    }),
  ]);
  await db.query(
    "INSERT INTO public.email_deliveries(user_id,delivery_date,frequency,payload) VALUES ($1,current_date,'daily','{}')",
    [reader],
  );
  await assert.rejects(
    db.query("SELECT public.store_paper_fulltext(1, $1)", [
      JSON.stringify({
        source: "test",
        content_hash: "a".repeat(64),
        sections: [],
      }),
    ]),
    { code: "22023" },
  );
  await asUser("authenticated", reader);
  assert.equal(
    (await db.query("SELECT * FROM public.paper_fulltexts")).rows.length,
    0,
  );
  assert.equal(
    (await db.query("SELECT * FROM public.email_deliveries")).rows.length,
    0,
  );
  assert.equal(
    (await db.query("SELECT fulltext_available FROM public.papers")).rows[0]
      .fulltext_available,
    true,
  );
  await asUser("authenticated", unconfirmed);
  assert.equal(
    (await db.query("SELECT * FROM public.recommendations")).rows.length,
    0,
  );
  await db.exec("RESET ROLE");
  // A local worker can publish only a matching catalog body, using its own token.
  const worker = "00000000-0000-0000-0000-000000000009";
  const token = "synthetic-worker-token-".repeat(3);
  const sha = (value) => createHash("sha256").update(value).digest("hex");
  const body = "Synthetic methods, results, and study limitations. ".repeat(60);
  const document = {
    content_text: body,
    content_hash: sha(body),
    sections: [{ title: "Methods", text: body }],
    source_url: "https://link.springer.com/article/10.1000/fixture",
  };
  await db.query(
    "INSERT INTO app_private.institution_workers(id,name,token_hash) VALUES($1,$2,$3)",
    [worker, "test worker", sha(token)],
  );
  await db.exec(
    "INSERT INTO public.papers(id,pmid,doi,title) VALUES(999,'999','10.1000/fixture','Institution fixture')",
  );
  const publish = (
    credential = token,
    doc = document,
    doi = "10.1000/fixture",
  ) =>
    db.query(
      "SELECT public.publish_institution_fulltext($1,$2,$3,$4,$5) AS stored",
      [worker, credential, "999", doi, JSON.stringify(doc)],
    );
  await asUser("anon", "");
  await assert.rejects(publish("invalid"), { code: "42501" });
  await assert.rejects(
    publish(token, { ...document, content_hash: "a".repeat(64) }),
    { code: "22023" },
  );
  await assert.rejects(
    publish(token, {
      ...document,
      source_url: "https://link.springer.com.evil.test/article",
    }),
    { code: "22023" },
  );
  await assert.rejects(publish(token, document, "10.1000/wrong"), {
    code: "P0002",
  });
  assert.equal((await publish()).rows[0].stored, true);
  assert.equal((await publish()).rows[0].stored, false);
  await assert.rejects(
    db.query("SELECT * FROM app_private.institution_workers"),
    { code: "42501" },
  );
  await db.exec("RESET ROLE");
  const sourceHash = sha("fulltext\nInstitution fixture\n" + body);
  await db.query(
    "UPDATE public.papers SET summary_basis='fulltext',summary_source_hash=$1,summarized_at=now() WHERE id=999",
    [sourceHash],
  );
  await assert.rejects(
    db.query("UPDATE public.papers SET summary_source_hash=$1 WHERE id=999", [
      "b".repeat(64),
    ]),
    { code: "23514" },
  );
  await db.exec("UPDATE public.papers SET title='Changed title' WHERE id=999");
  assert.equal(
    (
      await db.query(
        "SELECT summary_source_hash FROM public.papers WHERE id=999",
      )
    ).rows[0].summary_source_hash,
    null,
  );
  await db.query(
    "UPDATE public.papers SET summary_source_hash=$1,summarized_at=now() WHERE id=999",
    [sha("fulltext\nChanged title\n" + body)],
  );
  await db.query(
    "UPDATE public.paper_fulltexts SET content_text=$1,content_hash=$2 WHERE paper_id=999",
    [body + " changed", sha(body + " changed")],
  );
  assert.equal(
    (await db.query("SELECT summarized_at FROM public.papers WHERE id=999"))
      .rows[0].summarized_at,
    null,
  );
  await db.exec("UPDATE app_private.institution_workers SET enabled=false");
  await asUser("anon", "");
  await assert.rejects(publish(), { code: "42501" });
  await db.exec("RESET ROLE");
  await db.exec(await readFile(path.join(migrations,"011_z8_local_fulltext.sql"),"utf8"));
  await db.exec("UPDATE app_private.institution_workers SET enabled=true");
  await asUser("anon", "");
  await assert.rejects(publish(), {code:"42883"});
  const source = {content_hash:sha(body),characters:body.length,section_count:2,source_url:document.source_url};
  const derived = {summary_ko:"연구 설계를 확인했다.\n주요 결과를 확인했다.\n단일 기관 연구의 한계가 있다.",structured_data:{study_design:"Cohort",sample_size:"Not reported",key_finding:"Synthetic result",population:"Synthetic population"},qa_data:[{q:"한계는?",a:"단일 기관."}],clinical_relevance:3,summary_model:"spark/nvidia/Qwen3.8-27B-NVFP4",summary_source_hash:sha('fulltext\nChanged title\n'+body)};
  const sendSummary=(summary=derived,metadata=source,credential=token)=>db.query('SELECT public.publish_institution_summary($1,$2,$3,$4,$5,$6,$7)',[worker,credential,'999','10.1000/fixture','Changed title',JSON.stringify(metadata),JSON.stringify(summary)]);
  await assert.rejects(sendSummary(derived,source,'invalid'),{code:'42501'});
  await assert.rejects(sendSummary(derived,{...source,content_text:body}),{code:'22023'});
  await assert.rejects(sendSummary({...derived,summary_ko:'Only one line'}),{code:'22023'});
  await sendSummary();
  await sendSummary();
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT fulltext_storage FROM public.papers WHERE id=999')).rows[0].fulltext_storage,'z8');
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM app_private.local_fulltext_sources WHERE paper_id=999')).rows[0].n,1);
  await assert.rejects(db.query("SELECT public.store_paper_fulltext(1,$1)",[JSON.stringify(document)]),{code:'42501'});
  // Moving a legacy body requires a matching local-copy receipt and preserves its summary.
  await asUser('anon','');
  const archive=(await db.query('SELECT public.institution_cloud_archive($1,$2) AS item',[worker,token])).rows[0].item;
  const archiveHash=sha(archive.document.content_text);
  const archiveSourceHash=sha('fulltext\n'+archive.paper.title+'\n'+archive.document.content_text);
  await assert.rejects(db.query('SELECT public.confirm_local_fulltext_archive($1,$2,$3,$4,$5)',[worker,token,archive.paper.pmid,'b'.repeat(64),archiveSourceHash]),{code:'23514'});
  await db.query('SELECT public.confirm_local_fulltext_archive($1,$2,$3,$4,$5)',[worker,token,archive.paper.pmid,archiveHash,archiveSourceHash]);
  await db.exec('RESET ROLE');
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM public.paper_fulltexts WHERE paper_id=$1',[archive.paper.id])).rows[0].n,0);
  assert.equal((await db.query('SELECT fulltext_available FROM public.papers WHERE id=$1',[archive.paper.id])).rows[0].fulltext_available,true);
  await db.exec(`
    ALTER TABLE public.profiles ADD COLUMN digest_email boolean;
    UPDATE public.profiles SET digest_email = false WHERE id = '${reader}';
    UPDATE public.profiles SET digest_email = true, name = '[DELETED]' WHERE id = '${unconfirmed}';
  `);
  await db.exec(
    await readFile(path.join(migrations, "007_digest_preferences.sql"), "utf8"),
  );
  assert.deepEqual(
    (await db.query("SELECT email_digest FROM public.profiles ORDER BY id"))
      .rows,
    [{ email_digest: false }, { email_digest: false }, { email_digest: false }],
  );
  await asUser("authenticated", reader);
  await db.query("SELECT public.delete_own_account()");
  await db.exec("RESET ROLE");
  assert.equal(
    (await db.query("SELECT * FROM auth.users WHERE id = $1", [reader])).rows
      .length,
    0,
  );
  for (const table of [
    "profiles",
    "feedbacks",
    "recommendations",
    "collections",
    "email_deliveries",
  ]) {
    assert.equal(
      (
        await db.query(
          `SELECT * FROM public.${table} WHERE ${table === "profiles" ? "id" : "user_id"} = $1`,
          [reader],
        )
      ).rows.length,
      0,
    );
  }
  assert.equal(
    (await db.query("SELECT * FROM auth.users WHERE id = $1", [admin])).rows
      .length,
    1,
  );
  await db.exec(await readFile(path.join(migrations,"012_catalog_backfill.sql"),"utf8"));
  await db.query("INSERT INTO public.catalog_backfill_jobs(job_key,query) VALUES($1,$2)",["a".repeat(64),"Example[Journal]"]);
  await asUser("anon","");
  await assert.rejects(db.query("SELECT * FROM public.catalog_backfill_jobs"),{code:"42501"});
  await assert.rejects(db.query("SELECT public.catalog_backfill_status()"),{code:"42501"});
  await asUser("authenticated",unconfirmed);
  await assert.rejects(db.query("SELECT public.admin_catalog_status()"),{code:"42501"});
  await asUser("authenticated",admin);
  assert.equal((await db.query("SELECT public.admin_catalog_status() AS status")).rows[0].status.shards.pending,1);
  await db.exec("RESET ROLE");
  await db.exec(await readFile(path.join(migrations,"013_catalog_capacity.sql"),"utf8"));
  await asUser("anon","");
  await assert.rejects(db.query("SELECT public.catalog_storage_status()"),{code:"42501"});
  await assert.rejects(db.query("SELECT * FROM app_private.catalog_capacity"),{code:"42501"});
  await asUser("authenticated",unconfirmed);
  await assert.rejects(db.query("SELECT public.admin_catalog_status()"),{code:"42501"});
  await asUser("authenticated",admin);
  const storage=(await db.query("SELECT public.admin_catalog_status() AS status")).rows[0].status.storage;
  assert.equal(storage.budget_bytes,450*1024*1024);
  assert.ok(storage.database_bytes>0);
  await db.exec("RESET ROLE");
  console.log(
    "PASS: all 13 migrations; private catalog capacity/checkpoints, summary publication, verified Z8 archival, role isolation, provenance, feedback and account deletion",
  );
} finally {
  await db.close();
}
