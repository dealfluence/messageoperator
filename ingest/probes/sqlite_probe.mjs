/**
 * B-phase storage probe: does Node's built-in node:sqlite exist here and does
 * its bundled SQLite include FTS5? Decides the metadata/index engine without a
 * native npm dependency.
 */
let mod;
try {
  mod = await import("node:sqlite");
} catch (e) {
  console.log(JSON.stringify({ node_sqlite: false, error: e.message }));
  process.exit(0);
}
const { DatabaseSync } = mod;
const db = new DatabaseSync(":memory:");
const info = { node_sqlite: true, node: process.version };
try {
  const row = db.prepare("select sqlite_version() as v").get();
  info.sqlite_version = row.v;
} catch (e) {
  info.version_error = e.message;
}
try {
  db.exec("create virtual table t using fts5(body)");
  db.exec("insert into t(body) values ('hello archived elisa world')");
  const hit = db
    .prepare("select count(*) c from t where t match ?")
    .get("elisa");
  info.fts5 = true;
  info.fts5_match_count = hit.c;
} catch (e) {
  info.fts5 = false;
  info.fts5_error = e.message;
}
try {
  db.exec("create table j(id integer primary key, doc text)");
  db.prepare("insert into j(doc) values (?)").run(JSON.stringify({ a: 1 }));
  const r = db.prepare("select json_extract(doc,'$.a') a from j").get();
  info.json1 = r.a === 1;
} catch (e) {
  info.json1 = false;
  info.json1_error = e.message;
}
db.close();
console.log(JSON.stringify(info));
