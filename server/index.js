const express = require("express");
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "50mb" }));

// ── Database setup ──────────────────────────────────────────────────────────
const DB_DIR = process.env.DB_DIR || path.join(__dirname, "../data");
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

const db = new Database(path.join(DB_DIR, "calfilter.db"));

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    uid         TEXT PRIMARY KEY,
    summary     TEXT,
    description TEXT,
    location    TEXT,
    organizer   TEXT,
    attendees   TEXT,
    start_ts    INTEGER,
    end_ts      INTEGER,
    all_day     INTEGER,
    status      TEXT,
    categories  TEXT,
    raw_dtstart TEXT,
    raw_dtend   TEXT,
    updated_at  INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER DEFAULT (unixepoch())
  );
`);

// ── Prepared statements ─────────────────────────────────────────────────────
const stmts = {
  upsertEvent: db.prepare(`
    INSERT INTO events
      (uid, summary, description, location, organizer, attendees,
       start_ts, end_ts, all_day, status, categories, raw_dtstart, raw_dtend, updated_at)
    VALUES
      (@uid, @summary, @description, @location, @organizer, @attendees,
       @start_ts, @end_ts, @all_day, @status, @categories, @raw_dtstart, @raw_dtend, unixepoch())
    ON CONFLICT(uid) DO UPDATE SET
      summary=excluded.summary, description=excluded.description,
      location=excluded.location, organizer=excluded.organizer,
      attendees=excluded.attendees, start_ts=excluded.start_ts,
      end_ts=excluded.end_ts, all_day=excluded.all_day,
      status=excluded.status, categories=excluded.categories,
      raw_dtstart=excluded.raw_dtstart, raw_dtend=excluded.raw_dtend,
      updated_at=unixepoch()
  `),

  getAllEvents: db.prepare(`SELECT * FROM events ORDER BY start_ts ASC`),

  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()
  `),
  deleteSetting: db.prepare(`DELETE FROM settings WHERE key = ?`),

  deleteAllEvents: db.prepare(`DELETE FROM events`),
  deleteEvent:     db.prepare(`DELETE FROM events WHERE uid = ?`),
};

// ── Serialisation helpers ───────────────────────────────────────────────────
function rowToEvent(row) {
  return {
    uid:         row.uid,
    summary:     row.summary     || "",
    description: row.description || "",
    location:    row.location    || "",
    organizer:   row.organizer   || "",
    attendees:   row.attendees   || "",
    start:       row.start_ts ? new Date(row.start_ts).toISOString() : null,
    end:         row.end_ts   ? new Date(row.end_ts).toISOString()   : null,
    allDay:      row.all_day === 1,
    status:      row.status      || "",
    categories:  row.categories  || "",
    raw:         { dtstart: row.raw_dtstart || "", dtend: row.raw_dtend || "" },
  };
}

function eventToRow(ev) {
  return {
    uid:         ev.uid         || "",
    summary:     ev.summary     || "",
    description: ev.description || "",
    location:    ev.location    || "",
    organizer:   ev.organizer   || "",
    attendees:   ev.attendees   || "",
    start_ts:    ev.start ? new Date(ev.start).getTime() : null,
    end_ts:      ev.end   ? new Date(ev.end).getTime()   : null,
    all_day:     ev.allDay ? 1 : 0,
    status:      ev.status      || "",
    categories:  ev.categories  || "",
    raw_dtstart: ev.raw?.dtstart || "",
    raw_dtend:   ev.raw?.dtend   || "",
  };
}

// ── API Routes ──────────────────────────────────────────────────────────────

// GET /api/events  — return all events as uid→event map
app.get("/api/events", (req, res) => {
  const rows = stmts.getAllEvents.all();
  const store = {};
  for (const row of rows) store[row.uid] = rowToEvent(row);
  res.json(store);
});

// POST /api/events/merge  — upsert a batch of events
// Body: { events: [ ...eventObjects ] }
app.post("/api/events/merge", (req, res) => {
  const { events } = req.body;
  if (!Array.isArray(events)) return res.status(400).json({ error: "events must be an array" });

  const upsertMany = db.transaction((evs) => {
    for (const ev of evs) stmts.upsertEvent.run(eventToRow(ev));
  });

  try {
    upsertMany(events);
    res.json({ ok: true, count: events.length });
  } catch (err) {
    console.error("merge error", err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/events  — wipe all events
app.delete("/api/events", (req, res) => {
  stmts.deleteAllEvents.run();
  res.json({ ok: true });
});

// DELETE /api/events/:uid  — delete one event
app.delete("/api/events/:uid", (req, res) => {
  stmts.deleteEvent.run(req.params.uid);
  res.json({ ok: true });
});

// GET /api/settings  — return all settings as key→value map
app.get("/api/settings", (req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const out = {};
  for (const row of rows) {
    try { out[row.key] = JSON.parse(row.value); }
    catch { out[row.key] = row.value; }
  }
  res.json(out);
});

// PUT /api/settings/:key
app.put("/api/settings/:key", (req, res) => {
  const { value } = req.body;
  stmts.setSetting.run(req.params.key, JSON.stringify(value));
  res.json({ ok: true });
});

// DELETE /api/settings/:key
app.delete("/api/settings/:key", (req, res) => {
  stmts.deleteSetting.run(req.params.key);
  res.json({ ok: true });
});

// DELETE /api/all  — nuclear option: wipe everything
app.delete("/api/all", (req, res) => {
  stmts.deleteAllEvents.run();
  db.prepare("DELETE FROM settings").run();
  res.json({ ok: true });
});

// ── Serve React static build ────────────────────────────────────────────────
const STATIC_DIR = path.join(__dirname, "../client/dist");
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR));
  app.get("*", (req, res) => res.sendFile(path.join(STATIC_DIR, "index.html")));
} else {
  app.get("/", (req, res) => res.send("API is running. Frontend not built yet."));
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✓ Calendar Filter server running on http://0.0.0.0:${PORT}`);
  console.log(`  Database: ${path.join(DB_DIR, "calfilter.db")}`);
});
