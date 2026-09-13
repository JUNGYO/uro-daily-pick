// Run against an isolated PostgreSQL engine; never connects to Supabase.
import assert from "node:assert/strict";
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
const migrations = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../supabase/migrations");
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
  for (const file of (await readdir(migrations)).filter((f) => f.endsWith(".sql")).sort()) {
    if (file.startsWith("008_")) {
      let encoded = ["Prostatic Neoplasms", "Randomized Controlled Trial"];
      for (let depth = 0; depth < 21; depth++) encoded = JSON.stringify(encoded);
      await db.query("INSERT INTO public.papers(id,pmid,title,mesh_terms) VALUES(9000,'9000','Legacy encoding fixture',$1::jsonb)", [JSON.stringify(encoded)]);
    }
    await db.exec((await readFile(path.join(migrations, file), "utf8")).replace(/^\uFEFF/, ""));
    if (file.startsWith("008_")) {
      assert.deepEqual((await db.query("SELECT mesh_terms FROM public.papers WHERE id=9000")).rows[0].mesh_terms,
        ["Prostatic Neoplasms", "Randomized Controlled Trial"]);
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
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [id]);
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
  assert.equal((await db.query("SELECT action FROM public.feedbacks")).rows[0].action, "like");
  await db.query("SELECT public.upsert_feedback($1, 1, 'none')", [reader]);
  assert.equal((await db.query("SELECT * FROM public.feedbacks")).rows.length, 0);
  await assert.rejects(db.query("SELECT public.upsert_feedback($1, 1, 'like')", [admin]), { code: "42501" });
  await assert.rejects(db.query("SELECT public.upsert_feedback($1, 1, 'unknown')", [reader]), {
    code: "22023",
  });
  await db.query("SELECT public.set_paper_feedback(1, 'like')");
  await db.query("SELECT public.set_paper_feedback(1, 'like')");
  assert.equal((await db.query("SELECT * FROM public.collection_papers")).rows.length, 1);
  assert.equal(
    (await db.query("SELECT * FROM public.collections WHERE system_key = 'liked'")).rows.length,
    1,
  );
  await db.query("SELECT public.set_paper_feedback(1, 'none')");
  assert.equal((await db.query("SELECT * FROM public.collection_papers")).rows.length, 0);
  await assert.rejects(db.query("SELECT public.set_paper_feedback(999, 'like')"), { code: "23503" });
  assert.equal((await db.query("SELECT * FROM public.feedbacks")).rows.length, 0);
  await assert.rejects(
    db.query("SELECT public.replace_daily_recommendations($1, current_date, '[]')", [reader]),
    { code: "42501" },
  );
  await assert.rejects(db.query("SELECT public.store_paper_fulltext(1, '{}')"), { code: "42501" });
  await db.exec(
    "RESET ROLE; GRANT USAGE ON SCHEMA public TO service_role; GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;",
  );
  await asUser("service_role", "");
  const validRecs = JSON.stringify([{ paper_id: 1, score: 5, reasons: {} }]);
  await db.query("SELECT public.replace_daily_recommendations($1, current_date, $2)", [reader, validRecs]);
  await assert.rejects(
    db.query("SELECT public.replace_daily_recommendations($1, current_date, $2)", [
      reader,
      JSON.stringify([{ paper_id: 999, score: 1 }]),
    ]),
    { code: "23503" },
  );
  assert.equal((await db.query("SELECT paper_id FROM public.recommendations")).rows[0].paper_id, 1);
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
  await assert.rejects(db.query("SELECT public.store_paper_fulltext(1, $1)", [JSON.stringify({source:"test",content_hash:"a".repeat(64),sections:[]})]), {code:"22023"});
  await asUser("authenticated", reader);
  assert.equal((await db.query("SELECT * FROM public.paper_fulltexts")).rows.length, 0);
  assert.equal((await db.query("SELECT * FROM public.email_deliveries")).rows.length, 0);
  assert.equal(
    (await db.query("SELECT fulltext_available FROM public.papers")).rows[0].fulltext_available,
    true,
  );
  await asUser("authenticated", unconfirmed);
  assert.equal((await db.query("SELECT * FROM public.recommendations")).rows.length, 0);
  await db.exec("RESET ROLE");
  await db.exec(`
    ALTER TABLE public.profiles ADD COLUMN digest_email boolean;
    UPDATE public.profiles SET digest_email = false WHERE id = '${reader}';
    UPDATE public.profiles SET digest_email = true, name = '[DELETED]' WHERE id = '${unconfirmed}';
  `);
  await db.exec(await readFile(path.join(migrations, "007_digest_preferences.sql"), "utf8"));
  assert.deepEqual((await db.query("SELECT email_digest FROM public.profiles ORDER BY id")).rows, [
    { email_digest: false },
    { email_digest: false },
    { email_digest: false },
  ]);
  await asUser("authenticated", reader);
  await db.query("SELECT public.delete_own_account()");
  await db.exec("RESET ROLE");
  assert.equal((await db.query("SELECT * FROM auth.users WHERE id = $1", [reader])).rows.length, 0);
  for (const table of ["profiles", "feedbacks", "recommendations", "collections", "email_deliveries"]) {
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
  assert.equal((await db.query("SELECT * FROM auth.users WHERE id = $1", [admin])).rows.length, 1);
  console.log(
    "PASS: all 9 migrations; role isolation, atomic feedback/recommendations, private full text, digest ledger, account deletion",
  );
} finally {
  await db.close();
}
