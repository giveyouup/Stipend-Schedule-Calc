import { useState, useEffect, useCallback, useRef } from "react";
import * as XLSX from "xlsx";

// ─────────────────────────────────────────────
// API CLIENT
// Thin wrapper around fetch — all data lives on the server.
// ─────────────────────────────────────────────
const api = {
  async getEvents() {
    const r = await fetch("/api/events");
    if (!r.ok) throw new Error("Failed to load events");
    const store = await r.json();
    // Rehydrate ISO date strings → Date objects
    for (const ev of Object.values(store)) {
      ev.start = ev.start ? new Date(ev.start) : null;
      ev.end   = ev.end   ? new Date(ev.end)   : null;
    }
    return store;
  },

  async mergeEvents(eventsArray) {
    const r = await fetch("/api/events/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events: eventsArray }),
    });
    if (!r.ok) throw new Error("Merge failed");
    return r.json();
  },

  async deleteAllEvents() {
    const r = await fetch("/api/events", { method: "DELETE" });
    if (!r.ok) throw new Error("Delete failed");
  },

  async getSettings() {
    const r = await fetch("/api/settings");
    if (!r.ok) throw new Error("Failed to load settings");
    return r.json();
  },

  async setSetting(key, value) {
    await fetch(`/api/settings/${key}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
  },

  async deleteSetting(key) {
    await fetch(`/api/settings/${key}`, { method: "DELETE" });
  },

  async clearAll() {
    await fetch("/api/all", { method: "DELETE" });
  },
};

// ─────────────────────────────────────────────
// STIPEND GROUPS
// ─────────────────────────────────────────────
const STIPEND_GROUPS = ["Main OR Call", "Other G", "APS", "BR", "NIR", "ROC"];
const GROUP_COLOR = {
  "Main OR Call": "#c084fc",
  "Other G":      "#a78bfa",
  "APS":          "#f59e0b",
  "BR":           "#38bdf8",
  "NIR":          "#fb7185",
  "ROC":          "#a3e635",
};

function getStipendGroup(code) {
  if (code === "APS") return "APS";
  if (code === "BR")  return "BR";
  if (code === "NIR") return "NIR";
  if (code === "ROC") return "ROC";
  if (/^G\d+$/.test(code)) {
    const n = parseInt(code.slice(1), 10);
    return (n === 1 || n === 2) ? "Main OR Call" : "Other G";
  }
  return null;
}

// ─────────────────────────────────────────────
// US FEDERAL HOLIDAY CALCULATOR
// ─────────────────────────────────────────────
function getFederalHolidaysWithNames(year) {
  const result = [];
  const nthWeekday = (y, m, weekday, n) => {
    let count = 0;
    for (let d = 1; d <= 31; d++) {
      const dt = new Date(y, m-1, d);
      if (dt.getMonth() !== m-1) break;
      if (dt.getDay() === weekday) { count++; if (count === n) return dt; }
    }
  };
  const lastWeekday = (y, m, weekday) => {
    for (let d = 31; d >= 1; d--) {
      const dt = new Date(y, m-1, d);
      if (dt.getMonth() !== m-1) continue;
      if (dt.getDay() === weekday) return dt;
    }
  };
  const observed = dt => {
    const day = dt.getDay();
    if (day === 6) return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()-1);
    if (day === 0) return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()+1);
    return dt;
  };
  const fixed = (m, d) => observed(new Date(year, m-1, d));
  const add = (dt, name) => { if (dt) result.push({ date: fmtDate(dt), name }); };
  add(fixed(1,1),               "New Year's Day");
  add(nthWeekday(year,1,1,3),   "MLK Day");
  add(nthWeekday(year,2,1,3),   "Presidents' Day");
  add(lastWeekday(year,5,1),    "Memorial Day");
  add(fixed(6,19),              "Juneteenth");
  add(fixed(7,4),               "Independence Day");
  add(nthWeekday(year,9,1,1),   "Labor Day");
  add(nthWeekday(year,10,1,2),  "Columbus Day");
  add(fixed(11,11),             "Veterans Day");
  add(nthWeekday(year,11,4,4),  "Thanksgiving");
  add(fixed(12,25),             "Christmas Day");
  return result;
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function fmtYYYYMM(date) {
  if (!date) return "";
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}`;
}

function buildFederalHolidayMap(years) {
  const map = {};
  for (const y of years)
    for (const { date, name } of getFederalHolidaysWithNames(y))
      map[date] = name;
  return map;
}

function buildActiveHolidaySet(federalMap, disabledFederal, customDates) {
  const set = new Set();
  for (const date of Object.keys(federalMap))
    if (!disabledFederal.has(date)) set.add(date);
  for (const d of customDates) set.add(d);
  return set;
}

function isWeekendOrHoliday(date, holidaySet) {
  if (!date) return false;
  const dow = date.getDay();
  if (dow === 0 || dow === 6) return true;
  return holidaySet.has(fmtDate(date));
}

// ─────────────────────────────────────────────
// ICS PARSER — returns uid→event map
// ─────────────────────────────────────────────
function parseICS(text) {
  const events = {};
  const blocks = text.split("BEGIN:VEVENT");
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const get = key => {
      const re = new RegExp(`^${key}(?:;[^:]*)?:(.+)$`, "m");
      const m = block.match(re);
      return m ? m[1].replace(/\\n/g,"\n").replace(/\\,/g,",").trim() : "";
    };
    const parseDate = raw => {
      if (!raw) return null;
      const digits = raw.replace(/[^\d]/g,"");
      const y=digits.slice(0,4), mo=digits.slice(4,6), d=digits.slice(6,8);
      const h=digits.slice(9,11)||"00", mi=digits.slice(11,13)||"00";
      if (!y) return null;
      return new Date(`${y}-${mo}-${d}T${h}:${mi}:00`);
    };
    const dtstart = get("DTSTART"), dtend = get("DTEND");
    const uid = get("UID") || `no-uid-${i}`;
    events[uid] = {
      uid,
      summary:     get("SUMMARY"),
      description: get("DESCRIPTION"),
      location:    get("LOCATION"),
      organizer:   get("ORGANIZER").replace(/^mailto:/i,""),
      attendees: (() => {
        const ms = [...block.matchAll(/^ATTENDEE(?:;[^:]*)?:(.+)$/gm)];
        return ms.map(m => m[1].replace(/^mailto:/i,"")).join("; ");
      })(),
      start:   parseDate(dtstart),
      end:     parseDate(dtend),
      allDay:  dtstart.length === 8,
      status:  get("STATUS"),
      categories: get("CATEGORIES"),
      raw: { dtstart, dtend },
    };
  }
  return events;
}

// ─────────────────────────────────────────────
// MERGE ENGINE
// ─────────────────────────────────────────────
const DIFF_FIELDS = ["summary","description","location","organizer","status","categories"];
const FIELD_LABELS = { summary:"Title", description:"Description", location:"Location", organizer:"Organizer", status:"Status", categories:"Categories", start:"Date" };

function diffEvents(oldEv, newEv) {
  const diffs = [];
  for (const f of DIFF_FIELDS) {
    const o = (oldEv[f] || "").trim();
    const n = (newEv[f] || "").trim();
    if (o !== n) diffs.push({ field:f, old:o, new:n });
  }
  const oldStart = oldEv.start ? fmtDate(oldEv.start) : "";
  const newStart = newEv.start ? fmtDate(newEv.start) : "";
  if (oldStart !== newStart) diffs.push({ field:"start", old:oldStart, new:newStart });
  return diffs;
}

function computeMerge(store, incoming, fromKey, toKey) {
  const added = [], changed = [], unchanged = [];
  for (const [uid, newEv] of Object.entries(incoming)) {
    const evKey = newEv.start
      ? `${newEv.start.getFullYear()}-${String(newEv.start.getMonth()+1).padStart(2,"0")}`
      : null;
    if (evKey && fromKey && evKey < fromKey) continue;
    if (evKey && toKey   && evKey > toKey)   continue;
    if (!store[uid]) {
      added.push(newEv);
    } else {
      const diffs = diffEvents(store[uid], newEv);
      if (diffs.length > 0) changed.push({ uid, old: store[uid], incoming: newEv, diffs });
      else unchanged.push(uid);
    }
  }
  return { added, changed, unchanged };
}

// ─────────────────────────────────────────────
// STIPEND SPREADSHEET PARSER
// ─────────────────────────────────────────────
function parseStipendXLSX(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const wb = XLSX.read(e.target.result, { type: "array" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
        const map = {};
        for (const row of rows) {
          if (row.length < 2) continue;
          const key = String(row[0]??"").trim().toUpperCase();
          const val = parseFloat(row[1]);
          if (key && !isNaN(val)) map[key] = val;
        }
        resolve(map);
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// ─────────────────────────────────────────────
// STIPEND CALCULATION
// ─────────────────────────────────────────────
const FIXED_CODES = new Set(["APS","BR","NIR","ROC"]);
const WEEKEND_SENSITIVE = code => code === "APS" || /^G\d+$/.test(code);

function extractStipendCodes(title) {
  if (!title) return [];
  const tokens = title.toUpperCase().split(/[\s\-,\/()]+/);
  const matched = [];
  for (const t of tokens) {
    if (!t) continue;
    if (FIXED_CODES.has(t) || /^G\d+$/.test(t)) matched.push(t);
  }
  return [...new Set(matched)];
}

function calcEventStipend(event, stipendMap, holidaySet) {
  if (!stipendMap || !Object.keys(stipendMap).length)
    return { codes:[], details:[], total:0, isWeekend:false };
  if (!holidaySet) holidaySet = new Set();
  const codes = extractStipendCodes(event.summary);
  if (!codes.length) return { codes:[], details:[], total:0, isWeekend:false };

  const weekend = isWeekendOrHoliday(event.start, holidaySet);
  let total = 0;
  const details = [];
  for (const code of codes) {
    let amount = 0, rateKey = code;
    if (WEEKEND_SENSITIVE(code)) {
      const key = code + (weekend ? "_WEEKEND" : "_WEEKDAY");
      if (stipendMap[key] !== undefined)       { amount = stipendMap[key]; rateKey = key; }
      else if (stipendMap[code] !== undefined) { amount = stipendMap[code]; }
    } else {
      const wkdKey = code+"_WEEKDAY", wkeKey = code+"_WEEKEND";
      if (weekend && stipendMap[wkeKey] !== undefined)       { amount = stipendMap[wkeKey]; rateKey = wkeKey; }
      else if (!weekend && stipendMap[wkdKey] !== undefined) { amount = stipendMap[wkdKey]; rateKey = wkdKey; }
      else if (stipendMap[code] !== undefined)               { amount = stipendMap[code]; }
    }
    if (amount > 0) { total += amount; details.push({ code, rateKey, amount, group: getStipendGroup(code) }); }
  }
  return { codes: details.map(d=>d.code), details, total, isWeekend: weekend };
}

// ─────────────────────────────────────────────
// MONTHLY SUMMARY PIVOT
// ─────────────────────────────────────────────
function buildMonthlySummary(eventsArr, getMapForMonth, holidaySet) {
  const byMonth = {};
  for (const e of eventsArr) {
    if (!e.start) continue;
    const key = fmtYYYYMM(e.start);
    if (!byMonth[key]) { byMonth[key] = { count:0, total:0, byGroup:{} }; for (const g of STIPEND_GROUPS) byMonth[key].byGroup[g] = 0; }
    byMonth[key].count++;
    const { details, total } = calcEventStipend(e, getMapForMonth(key), holidaySet);
    byMonth[key].total += total;
    for (const d of details) if (d.group) byMonth[key].byGroup[d.group] = (byMonth[key].byGroup[d.group]||0) + d.amount;
  }
  return Object.entries(byMonth).sort(([a],[b])=>a.localeCompare(b)).map(([key,data]) => {
    const [yr,mo] = key.split("-").map(Number);
    return { month: key, key, label:`${MONTH_NAMES[mo-1]} ${yr}`, ...data };
  });
}

// ─────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────
function exportToXLSX(eventsArr, getMapForMonth, holidaySet) {
  const wb = XLSX.utils.book_new();
  const rows = eventsArr.map(e => {
    const { details, total, isWeekend } = calcEventStipend(e, getMapForMonth(fmtYYYYMM(e.start)), holidaySet);
    return {
      "Title":         e.summary,
      "Start":         e.start ? e.start.toLocaleString() : e.raw?.dtstart,
      "End":           e.end   ? e.end.toLocaleString()   : e.raw?.dtend,
      "All Day":       e.allDay ? "Yes" : "No",
      "Day Type":      e.start ? (isWeekend ? "Weekend/Holiday" : "Weekday") : "",
      "Stipend Codes": details.map(d=>d.rateKey).join(", "),
      "Stipend ($)":   total || "",
      "Location":      e.location,
      "Description":   e.description,
      "Organizer":     e.organizer,
    };
  });
  const ws1 = XLSX.utils.json_to_sheet(rows);
  ws1["!cols"] = [{wch:40},{wch:22},{wch:22},{wch:10},{wch:18},{wch:28},{wch:12},{wch:28},{wch:50},{wch:28}];
  XLSX.utils.book_append_sheet(wb, ws1, "Filtered Events");
  const summary = buildMonthlySummary(eventsArr, getMapForMonth, holidaySet);
  if (summary.length) {
    const summaryRows = summary.map(row => {
      const out = { "Month":row.label, "Events":row.count, "Total ($)":row.total };
      for (const g of STIPEND_GROUPS) out[g+" ($)"] = row.byGroup[g] || "";
      return out;
    });
    const tot = { "Month":"TOTAL", "Events":eventsArr.length, "Total ($)":summary.reduce((s,r)=>s+r.total,0) };
    for (const g of STIPEND_GROUPS) tot[g+" ($)"] = summary.reduce((s,r)=>s+(r.byGroup[g]||0),0) || "";
    summaryRows.push(tot);
    const ws2 = XLSX.utils.json_to_sheet(summaryRows);
    ws2["!cols"] = [{wch:18},{wch:10},{wch:12},...STIPEND_GROUPS.map(()=>({wch:16}))];
    XLSX.utils.book_append_sheet(wb, ws2, "Monthly Summary");
  }
  XLSX.writeFile(wb, "filtered_calendar_events.xlsx");
}

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function storeToArray(store) {
  return Object.values(store).sort((a,b) => (a.start?.getTime()??0) - (b.start?.getTime()??0));
}
function getMonthOptions(store) {
  const seen = new Set();
  for (const e of Object.values(store))
    if (e.start) seen.add(`${e.start.getFullYear()}-${String(e.start.getMonth()+1).padStart(2,"0")}`);
  return [...seen].sort();
}
function getEventYears(store) {
  const ys = new Set();
  for (const e of Object.values(store)) if (e.start) ys.add(e.start.getFullYear());
  return [...ys];
}
function filterByDateRange(arr, fromKey, toKey) {
  return arr.filter(e => {
    if (!e.start) return false;
    const key = `${e.start.getFullYear()}-${String(e.start.getMonth()+1).padStart(2,"0")}`;
    if (fromKey && key < fromKey) return false;
    if (toKey   && key > toKey)   return false;
    return true;
  });
}

// ─────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────
export default function App() {
  // ── Server-backed state ──
  const [eventStore,             setEventStore]             = useState({});
  const [stipendVersions,        setStipendVersions]        = useState([]);
  const [monthVersionAssignments,setMonthVersionAssignments] = useState({});
  const [disabledFederal,        setDisabledFederal]        = useState(new Set());
  const [customHolidayInput, setCustomHolidayInput] = useState("");

  // ── Loading state ──
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false); // shows "Saving…" indicator

  // ── Ephemeral UI ──
  const [fileName,         setFileName]         = useState("");
  const [fromMonth,        setFromMonth]        = useState("");
  const [toMonth,          setToMonth]          = useState("");
  const [editingStipend,   setEditingStipend]   = useState(null);
  const [editingValue,     setEditingValue]     = useState("");
  const [showHolidayPanel, setShowHolidayPanel] = useState(false);
  const [activeTab,        setActiveTab]        = useState("events");
  const [dragOver,         setDragOver]         = useState(false);
  const [dragOverS,        setDragOverS]        = useState(false);

  // ── Stipend version label prompt ──
  const [showLabelModal,    setShowLabelModal]    = useState(false);
  const [pendingStipendMap, setPendingStipendMap] = useState(null);
  const [pendingLabel,      setPendingLabel]      = useState("");
  const [pendingFileName,   setPendingFileName]   = useState("");
  const [selectedVersionId, setSelectedVersionId] = useState(null);

  // ── Import / merge modal ──
  const [pendingParsed,  setPendingParsed]  = useState(null);
  const [importFrom,     setImportFrom]     = useState("");
  const [importTo,       setImportTo]       = useState("");
  const [showImportModal,setShowImportModal]= useState(false);

  // ── Diff review modal ──
  const [mergeResult,    setMergeResult]    = useState(null);
  const [acceptedChanges,setAcceptedChanges]= useState({});
  const [showDiffModal,  setShowDiffModal]  = useState(false);

  const fileRef    = useRef();
  const stipendRef = useRef();

  // ── Load all data from server on mount ──
  useEffect(() => {
    Promise.all([api.getEvents(), api.getSettings()])
      .then(([store, settings]) => {
        setEventStore(store);
        if (settings.stipendVersions) {
          setStipendVersions(settings.stipendVersions);
        } else if (settings.stipendMap) {
          const migrated = [{
            id: crypto.randomUUID(),
            label: settings.stipendFileName || "Imported rates",
            map: settings.stipendMap,
            uploadedAt: Date.now(),
          }];
          setStipendVersions(migrated);
          api.setSetting("stipendVersions", migrated);
          api.deleteSetting("stipendMap");
          api.deleteSetting("stipendFileName");
        }
        if (settings.monthVersionAssignments) setMonthVersionAssignments(settings.monthVersionAssignments);
        if (settings.disabledFederal) setDisabledFederal(new Set(settings.disabledFederal));
        if (settings.customHolidays)  setCustomHolidayInput(settings.customHolidays);

        // Restore last view range, or default to full span
        const opts = getMonthOptions(store);
        if (opts.length) {
          setFromMonth(settings.fromMonth || opts[0]);
          setToMonth(settings.toMonth   || opts[opts.length-1]);
        }
      })
      .catch(err => console.error("Failed to load from server:", err))
      .finally(() => setLoading(false));
  }, []);

  // ── Persist settings to server whenever they change ──
  // Debounced so rapid edits don't spam the API
  const saveSettingDebounced = useCallback(
    debounce((key, value) => api.setSetting(key, value), 600),
    []
  );

  // Persist view range
  useEffect(() => {
    if (fromMonth) saveSettingDebounced("fromMonth", fromMonth);
  }, [fromMonth]);
  useEffect(() => {
    if (toMonth)   saveSettingDebounced("toMonth", toMonth);
  }, [toMonth]);
  useEffect(() => {
    saveSettingDebounced("disabledFederal", [...disabledFederal]);
  }, [disabledFederal]);
  useEffect(() => {
    saveSettingDebounced("customHolidays", customHolidayInput);
  }, [customHolidayInput]);
  useEffect(() => {
    if (stipendVersions.length > 0) saveSettingDebounced("stipendVersions", stipendVersions);
  }, [stipendVersions]);
  useEffect(() => {
    if (Object.keys(monthVersionAssignments).length > 0)
      saveSettingDebounced("monthVersionAssignments", monthVersionAssignments);
  }, [monthVersionAssignments]);

  // ── Derived ──
  const customDates  = customHolidayInput.split(/[\s,;]+/).map(s=>s.trim()).filter(s=>/^\d{4}-\d{2}-\d{2}$/.test(s));
  const eventYears   = getEventYears(eventStore);
  const federalMap   = buildFederalHolidayMap(eventYears);
  const holidaySet   = buildActiveHolidaySet(federalMap, disabledFederal, customDates);
  const monthOptions = getMonthOptions(eventStore);
  const allEventsArr = storeToArray(eventStore);
  const filtered     = filterByDateRange(allEventsArr, fromMonth, toMonth);
  const hasStore     = Object.keys(eventStore).length > 0;

  function getStipendMapForMonth(month) {
    const vid = monthVersionAssignments[month];
    const v = vid
      ? stipendVersions.find(v => v.id === vid)
      : stipendVersions.at(-1);
    return v?.map ?? {};
  }

  const monthlySummary = filtered.length > 0 && stipendVersions.length > 0 ? buildMonthlySummary(filtered, getStipendMapForMonth, holidaySet) : [];
  const totalStipend = filtered.reduce((s,e) => s + calcEventStipend(e, getStipendMapForMonth(fmtYYYYMM(e.start)), holidaySet).total, 0);
  const weekendCount = filtered.filter(e => isWeekendOrHoliday(e.start,holidaySet)).length;
  const groupTotals  = Object.fromEntries(STIPEND_GROUPS.map(g=>[g, monthlySummary.reduce((s,r)=>s+(r.byGroup[g]||0),0)]));
  const importOpts   = pendingParsed ? getMonthOptions(pendingParsed) : [];

  // ── Auto-assign latest version to unassigned months ──
  useEffect(() => {
    if (!stipendVersions.length) return;
    const latest = stipendVersions.at(-1).id;
    const updates = {};
    for (const { month } of monthlySummary) {
      if (!monthVersionAssignments[month]) updates[month] = latest;
    }
    if (Object.keys(updates).length) {
      setMonthVersionAssignments(prev => ({ ...prev, ...updates }));
    }
  }, [monthlySummary, stipendVersions]);

  // ── ICS load ──
  const loadICS = file => {
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = e => {
      try {
        const parsed = parseICS(e.target.result);
        const opts = getMonthOptions(parsed);
        setPendingParsed(parsed);
        setImportFrom(opts[0] || "");
        setImportTo(opts[opts.length-1] || "");
        setShowImportModal(true);
      } catch { alert("Failed to parse ICS file."); }
    };
    reader.readAsText(file);
  };

  // ── Confirm import range → compute merge ──
  const confirmImportRange = () => {
    setShowImportModal(false);
    const result = computeMerge(eventStore, pendingParsed, importFrom, importTo);
    if (result.changed.length > 0) {
      const acc = {};
      result.changed.forEach(c => { acc[c.uid] = true; });
      setAcceptedChanges(acc);
      setMergeResult(result);
      setShowDiffModal(true);
    } else {
      applyMerge(result, {});
    }
  };

  // ── Apply merge → send to server ──
  const applyMerge = async (result, accepted) => {
    const toSave = [
      ...result.added,
      ...result.changed.filter(c => accepted[c.uid]).map(c => c.incoming),
    ];

    setShowDiffModal(false);
    setMergeResult(null);
    setPendingParsed(null);

    if (toSave.length === 0) return;

    setSaving(true);
    try {
      await api.mergeEvents(toSave);
      // Refresh store from server to stay in sync
      const freshStore = await api.getEvents();
      setEventStore(freshStore);

      // Set view range to imported span if store was previously empty
      if (!hasStore) {
        setFromMonth(importFrom);
        setToMonth(importTo);
      }
    } catch (err) {
      alert("Failed to save events: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  // ── Stipend ──
  const loadStipend = async file => {
    if (!file) return;
    try {
      const map = await parseStipendXLSX(file);
      setPendingStipendMap(map);
      setPendingLabel(file.name.replace(/\.[^.]+$/, ""));
      setPendingFileName(file.name);
      setShowLabelModal(true);
    } catch { alert("Failed to parse stipend spreadsheet."); }
  };

  const confirmStipendLabel = async () => {
    const newVersion = {
      id: crypto.randomUUID(),
      label: pendingLabel.trim() || pendingFileName.replace(/\.[^.]+$/, "") || "Rates",
      map: pendingStipendMap,
      uploadedAt: Date.now(),
    };
    const newVersions = [...stipendVersions, newVersion];
    setStipendVersions(newVersions);
    setSelectedVersionId(newVersion.id);
    setShowLabelModal(false);
    setSaving(true);
    await api.setSetting("stipendVersions", newVersions);
    setSaving(false);
  };

  const startEditStipend = (key, val) => { setEditingStipend(key); setEditingValue(String(val)); };
  const commitEditStipend = key => {
    const val = parseFloat(editingValue);
    if (!isNaN(val) && val >= 0) {
      const vid = selectedVersionId || stipendVersions.at(-1)?.id;
      const newVersions = stipendVersions.map(v =>
        v.id === vid ? { ...v, map: { ...v.map, [key]: val } } : v
      );
      setStipendVersions(newVersions);
    }
    setEditingStipend(null);
  };

  // ── Holidays ──
  const toggleFederalHoliday = date => {
    setDisabledFederal(prev => {
      const next = new Set(prev);
      next.has(date) ? next.delete(date) : next.add(date);
      return next;
    });
  };

  // ── Clear all ──
  const clearAllData = async () => {
    if (!window.confirm("Clear ALL saved data — events, stipend rates, holiday settings? This cannot be undone.")) return;
    setSaving(true);
    await api.clearAll();
    setEventStore({});
    setStipendVersions([]);
    setMonthVersionAssignments({});
    setSelectedVersionId(null);
    setDisabledFederal(new Set());
    setCustomHolidayInput("");
    setFromMonth("");
    setToMonth("");
    setSaving(false);
  };

  // ── Drag handlers ──
  const onDropICS = useCallback(e => { e.preventDefault(); setDragOver(false); const f=e.dataTransfer.files[0]; if(f) loadICS(f); }, []);
  const onDropS   = useCallback(e => { e.preventDefault(); setDragOverS(false); const f=e.dataTransfer.files[0]; if(f) loadStipend(f); }, []);

  // ── Loading screen ──
  if (loading) {
    return (
      <div style={{ minHeight:"100vh", background:"#0f1117", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"'DM Mono',monospace", color:"#64748b", fontSize:13 }}>
        <div style={{ textAlign:"center" }}>
          <div style={{ fontSize:32, marginBottom:16 }}>📅</div>
          Loading…
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight:"100vh", background:"#0f1117", fontFamily:"'DM Mono','Courier New',monospace", color:"#e2e8f0" }}>

      {/* ════ IMPORT RANGE MODAL ════ */}
      {showImportModal && pendingParsed && (() => {
        const previewCount = Object.values(pendingParsed).filter(e => {
          if (!e.start) return false;
          const k = `${e.start.getFullYear()}-${String(e.start.getMonth()+1).padStart(2,"0")}`;
          return (!importFrom||k>=importFrom) && (!importTo||k<=importTo);
        }).length;
        return (
          <Modal title="Select Import Range" onClose={()=>setShowImportModal(false)}>
            <p style={modalSubText}>
              File contains <strong style={{color:"#a78bfa"}}>{Object.keys(pendingParsed).length}</strong> events across {importOpts.length} months.
              {hasStore && <> Store already has <strong style={{color:"#34d399"}}>{Object.keys(eventStore).length}</strong> events — this will <em>merge</em>.</>}
            </p>
            <div style={{ display:"grid", gridTemplateColumns:"1fr auto 1fr", gap:8, alignItems:"end", marginBottom:14 }}>
              <div>
                <div style={modalLabel}>From</div>
                <select value={importFrom} onChange={e=>setImportFrom(e.target.value)} style={{...selectStyle,width:"100%"}}>
                  {importOpts.map(k=>{ const[yr,mo]=k.split("-").map(Number); return <option key={k} value={k}>{MONTH_NAMES[mo-1]} {yr}</option>; })}
                </select>
              </div>
              <span style={{color:"#475569",paddingBottom:8}}>→</span>
              <div>
                <div style={modalLabel}>To</div>
                <select value={importTo} onChange={e=>setImportTo(e.target.value)} style={{...selectStyle,width:"100%"}}>
                  {importOpts.map(k=>{ const[yr,mo]=k.split("-").map(Number); return <option key={k} value={k}>{MONTH_NAMES[mo-1]} {yr}</option>; })}
                </select>
              </div>
            </div>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginBottom:16 }}>
              {[...new Set(importOpts.map(k=>k.slice(0,4)))].map(yr=>(
                <button key={yr} onClick={()=>{setImportFrom(`${yr}-01`);setImportTo(`${yr}-12`);}} style={{...quickBtnStyle,background:"rgba(99,102,241,0.1)",border:"1px solid rgba(99,102,241,0.25)"}}>{yr}</button>
              ))}
              <button onClick={()=>{setImportFrom(importOpts[0]);setImportTo(importOpts[importOpts.length-1]);}} style={{...quickBtnStyle,background:"rgba(99,102,241,0.1)",border:"1px solid rgba(99,102,241,0.25)"}}>All</button>
            </div>
            <div style={{ fontSize:11, color:"#64748b", marginBottom:18 }}>
              Will process <strong style={{color:"#f1f5f9"}}>{previewCount}</strong> events in this range.
            </div>
            <ModalFooter>
              <GhostBtn onClick={()=>setShowImportModal(false)}>Cancel</GhostBtn>
              <PrimaryBtn onClick={confirmImportRange}>Continue →</PrimaryBtn>
            </ModalFooter>
          </Modal>
        );
      })()}

      {/* ════ DIFF REVIEW MODAL ════ */}
      {showDiffModal && mergeResult && (
        <Modal title={`Review Changes (${mergeResult.changed.length} updated · ${mergeResult.added.length} new)`} onClose={()=>{ setShowDiffModal(false); applyMerge(mergeResult,acceptedChanges); }} wide>
          <p style={modalSubText}>
            These events already exist but have changed. Check the ones to update — unchecked events keep their current version.
          </p>
          <div style={{ display:"flex", gap:14, marginBottom:12, flexWrap:"wrap" }}>
            {mergeResult.added.length>0 && <span style={{ fontSize:11, background:"rgba(52,211,153,0.1)", border:"1px solid rgba(52,211,153,0.25)", color:"#34d399", borderRadius:5, padding:"3px 10px" }}>✚ {mergeResult.added.length} new events added automatically</span>}
            {mergeResult.unchanged.length>0 && <span style={{ fontSize:11, background:"rgba(100,116,139,0.1)", border:"1px solid rgba(100,116,139,0.2)", color:"#64748b", borderRadius:5, padding:"3px 10px" }}>○ {mergeResult.unchanged.length} unchanged</span>}
          </div>
          <div style={{ display:"flex", gap:8, marginBottom:12 }}>
            <button onClick={()=>{ const a={}; mergeResult.changed.forEach(c=>{a[c.uid]=true;}); setAcceptedChanges(a); }} style={{...quickBtnStyle,background:"rgba(99,102,241,0.1)",border:"1px solid rgba(99,102,241,0.25)"}}>Accept all</button>
            <button onClick={()=>setAcceptedChanges({})} style={{...quickBtnStyle,background:"rgba(100,116,139,0.1)",border:"1px solid rgba(100,116,139,0.2)",color:"#64748b"}}>Reject all</button>
          </div>
          <div style={{ maxHeight:400, overflowY:"auto", display:"flex", flexDirection:"column", gap:10 }}>
            {mergeResult.changed.map(c => {
              const accepted = !!acceptedChanges[c.uid];
              return (
                <div key={c.uid} style={{ background:accepted?"rgba(99,102,241,0.07)":"rgba(100,116,139,0.05)", border:`1px solid ${accepted?"rgba(99,102,241,0.3)":"#1e2535"}`, borderRadius:8, padding:"12px 14px", opacity:accepted?1:0.65, transition:"all 0.15s" }}>
                  <div style={{ display:"flex", alignItems:"flex-start", gap:10, marginBottom:10 }}>
                    <input type="checkbox" checked={accepted} onChange={()=>setAcceptedChanges(prev=>({...prev,[c.uid]:!prev[c.uid]}))} style={{ marginTop:2, accentColor:"#6366f1", cursor:"pointer", flexShrink:0 }} />
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ color:"#f1f5f9", fontWeight:600, fontSize:13, marginBottom:2, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.incoming.summary||"(no title)"}</div>
                      <div style={{ color:"#64748b", fontSize:11 }}>{c.incoming.start ? c.incoming.start.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}) : ""}</div>
                    </div>
                    <span style={{ fontSize:10, background:accepted?"rgba(99,102,241,0.2)":"rgba(100,116,139,0.15)", color:accepted?"#a78bfa":"#64748b", borderRadius:4, padding:"2px 8px", flexShrink:0 }}>
                      {accepted?"Will update":"Keep old"}
                    </span>
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", gap:6, marginLeft:26 }}>
                    {c.diffs.map(diff => (
                      <div key={diff.field} style={{ display:"grid", gridTemplateColumns:"80px 1fr 1fr", gap:8, fontSize:11, alignItems:"start" }}>
                        <span style={{ color:"#475569", textTransform:"uppercase", fontSize:9, letterSpacing:"0.05em", paddingTop:2 }}>{FIELD_LABELS[diff.field]||diff.field}</span>
                        <div style={{ background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.15)", borderRadius:4, padding:"3px 7px", color:"#fca5a5", wordBreak:"break-word" }}>
                          <span style={{ fontSize:9, color:"#7f1d1d", display:"block", marginBottom:2 }}>OLD</span>
                          {diff.old || <em style={{opacity:0.4}}>empty</em>}
                        </div>
                        <div style={{ background:"rgba(52,211,153,0.08)", border:"1px solid rgba(52,211,153,0.15)", borderRadius:4, padding:"3px 7px", color:"#6ee7b7", wordBreak:"break-word" }}>
                          <span style={{ fontSize:9, color:"#064e3b", display:"block", marginBottom:2 }}>NEW</span>
                          {diff.new || <em style={{opacity:0.4}}>empty</em>}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          <ModalFooter>
            <GhostBtn onClick={()=>{ setShowDiffModal(false); setPendingParsed(null); }}>Cancel import</GhostBtn>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize:11, color:"#64748b" }}>{Object.values(acceptedChanges).filter(Boolean).length} of {mergeResult.changed.length} updates accepted</span>
              <PrimaryBtn onClick={()=>applyMerge(mergeResult,acceptedChanges)}>Apply merge</PrimaryBtn>
            </div>
          </ModalFooter>
        </Modal>
      )}

      {/* ════ STIPEND VERSION LABEL MODAL ════ */}
      {showLabelModal && (
        <Modal title="Name this stipend version" onClose={() => { setShowLabelModal(false); setPendingStipendMap(null); }}>
          <p style={modalSubText}>
            Give this rate table a name so you can identify it when assigning rates to months.
          </p>
          <div style={{ marginBottom:16 }}>
            <div style={modalLabel}>Version label</div>
            <input
              autoFocus
              value={pendingLabel}
              onChange={e => setPendingLabel(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") confirmStipendLabel(); }}
              style={{ width:"100%", background:"#0f1117", border:"1px solid #2d3748", borderRadius:6, color:"#e2e8f0", padding:"8px 10px", fontSize:12, fontFamily:"inherit", boxSizing:"border-box", outline:"none" }}
              placeholder="e.g. 2024 Q1 rates"
            />
          </div>
          <ModalFooter>
            <GhostBtn onClick={() => { setShowLabelModal(false); setPendingStipendMap(null); }}>Cancel</GhostBtn>
            <PrimaryBtn onClick={confirmStipendLabel}>Save version →</PrimaryBtn>
          </ModalFooter>
        </Modal>
      )}

      {/* ════ HEADER ════ */}
      <div style={{ borderBottom:"1px solid #2d3748", padding:"18px 40px", display:"flex", alignItems:"center", gap:16 }}>
        <div style={{ width:36, height:36, borderRadius:8, background:"linear-gradient(135deg,#6366f1,#a78bfa)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>📅</div>
        <div>
          <div style={{ fontSize:17, fontWeight:700, letterSpacing:"-0.02em", color:"#f1f5f9" }}>Calendar Filter</div>
          <div style={{ fontSize:11, color:"#64748b" }}>Extract events · Calculate stipends · Export to Excel</div>
        </div>
        <div style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:12 }}>
          {saving && <span style={{ fontSize:11, color:"#475569" }}>Saving…</span>}
          {hasStore && !saving && (
            <span style={{ fontSize:11, color:"#475569" }}>💾 {Object.keys(eventStore).length} events</span>
          )}
          {(hasStore || stipendVersions.length > 0) && (
            <button onClick={clearAllData} style={{ background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.2)", color:"#f87171", padding:"4px 12px", borderRadius:5, cursor:"pointer", fontSize:11, fontFamily:"inherit" }}>
              Clear all data
            </button>
          )}
        </div>
      </div>

      <div style={{ padding:"24px 40px", maxWidth:1100, margin:"0 auto" }}>

        {/* Upload row */}
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:16, marginBottom:16 }}>
          <DropZone
            label={hasStore
              ? <><span style={{color:"#a78bfa"}}>{fileName||"Calendar loaded"}</span><br/><span style={{color:"#64748b",fontSize:11}}>{Object.keys(eventStore).length} events · drop to merge</span></>
              : <><span style={{color:"#a78bfa"}}>.ics</span> calendar file</>}
            sublabel={!hasStore?"Google Calendar → Settings → Import & Export":null}
            icon="📅" dragOver={dragOver}
            onDragOver={e=>{e.preventDefault();setDragOver(true);}}
            onDragLeave={()=>setDragOver(false)}
            onDrop={onDropICS} onClick={()=>fileRef.current.click()}
          />
          <input ref={fileRef} type="file" accept=".ics" style={{display:"none"}} onChange={e=>loadICS(e.target.files[0])} />

          <DropZone
            label={stipendVersions.length > 0
              ? <><span style={{color:"#34d399"}}>{stipendVersions.length} rate version{stipendVersions.length!==1?"s":""}</span><br/><span style={{color:"#64748b",fontSize:11}}>{stipendVersions.map(v=>v.label).join(", ")} · drop to add</span></>
              : <><span style={{color:"#34d399"}}>.xlsx</span> stipend rates</>}
            sublabel={!stipendVersions.length?"Rows: TYPE_WEEKDAY / TYPE_WEEKEND, amount":"Drop a new file to add version"}
            icon="💰" dragOver={dragOverS} accent="#34d399"
            onDragOver={e=>{e.preventDefault();setDragOverS(true);}}
            onDragLeave={()=>setDragOverS(false)}
            onDrop={onDropS} onClick={()=>stipendRef.current.click()}
          />
          <input ref={stipendRef} type="file" accept=".xlsx,.xls,.csv" style={{display:"none"}} onChange={e=>loadStipend(e.target.files[0])} />
        </div>

        {/* Stipend rates (versioned, editable) */}
        {stipendVersions.length > 0 && (() => {
          const vid = selectedVersionId && stipendVersions.find(v => v.id === selectedVersionId)
            ? selectedVersionId
            : stipendVersions.at(-1)?.id;
          const ver = stipendVersions.find(v => v.id === vid);
          return (
            <div style={{ background:"#0d1a14", border:"1px solid #1a3329", borderRadius:8, padding:"10px 14px", marginBottom:14 }}>
              <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, flexWrap:"wrap" }}>
                <div style={{ fontSize:10, color:"#4b7a64", textTransform:"uppercase", letterSpacing:"0.07em", flexShrink:0 }}>Stipend Rates</div>
                <select
                  value={vid || ""}
                  onChange={e => setSelectedVersionId(e.target.value)}
                  style={{ ...selectStyle, fontSize:11, padding:"3px 8px" }}
                >
                  {stipendVersions.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                </select>
                <button
                  onClick={() => {
                    const newLabel = prompt("Rename version:", ver?.label || "");
                    if (newLabel && newLabel.trim()) {
                      setStipendVersions(stipendVersions.map(v => v.id === vid ? { ...v, label: newLabel.trim() } : v));
                    }
                  }}
                  style={{ ...quickBtnStyle, background:"rgba(52,211,153,0.08)", border:"1px solid rgba(52,211,153,0.2)", color:"#34d399", fontSize:10 }}
                >Rename</button>
                <button
                  onClick={() => {
                    if (stipendVersions.length <= 1) return;
                    if (!window.confirm(`Delete version "${ver?.label}"?`)) return;
                    const newVersions = stipendVersions.filter(v => v.id !== vid);
                    setStipendVersions(newVersions);
                    setSelectedVersionId(newVersions.at(-1)?.id || null);
                  }}
                  disabled={stipendVersions.length <= 1}
                  style={{ ...quickBtnStyle, background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.2)", color:stipendVersions.length<=1?"#475569":"#f87171", fontSize:10, cursor:stipendVersions.length<=1?"not-allowed":"pointer" }}
                >Delete</button>
                <span style={{ color:"#334155", fontWeight:400, fontSize:10, marginLeft:"auto" }}>· click any amount to edit</span>
              </div>
              {ver && (
                <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
                  {Object.entries(ver.map).map(([k,val]) => {
                    const isWknd=k.endsWith("_WEEKEND"), isWkdy=k.endsWith("_WEEKDAY");
                    const color=isWknd?"#f59e0b":isWkdy?"#34d399":"#94a3b8";
                    const bg=isWknd?"rgba(245,158,11,0.1)":isWkdy?"rgba(52,211,153,0.1)":"rgba(148,163,184,0.1)";
                    const border=isWknd?"rgba(245,158,11,0.3)":isWkdy?"rgba(52,211,153,0.3)":"rgba(148,163,184,0.2)";
                    return (
                      <span key={k} style={{ background:bg, border:`1px solid ${border}`, borderRadius:5, padding:"3px 10px", fontSize:11, color, display:"inline-flex", alignItems:"center", gap:4 }}>
                        {k}
                        {editingStipend===k
                          ? <input autoFocus type="number" value={editingValue} onChange={e=>setEditingValue(e.target.value)} onBlur={()=>commitEditStipend(k)} onKeyDown={e=>{ if(e.key==="Enter") commitEditStipend(k); if(e.key==="Escape") setEditingStipend(null); }} style={{ width:60, background:"#0f1117", border:"1px solid "+border, borderRadius:4, color, padding:"1px 5px", fontSize:11, fontFamily:"inherit", outline:"none" }} />
                          : <span onClick={()=>startEditStipend(k,val)} style={{ opacity:0.85, cursor:"text", borderBottom:"1px dashed "+border, paddingBottom:1 }} title="Click to edit">${val}</span>
                        }
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })()}

        {/* Date range filter */}
        {hasStore && monthOptions.length > 0 && (
          <div style={{ background:"#141720", border:"1px solid #1e2535", borderRadius:10, padding:"14px 18px", marginBottom:14 }}>
            <div style={{ fontSize:10, color:"#64748b", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:10 }}>View Range</div>
            <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:11, color:"#94a3b8" }}>From</span>
                <select value={fromMonth} onChange={e=>setFromMonth(e.target.value)} style={selectStyle}>
                  {monthOptions.map(k=>{ const[yr,mo]=k.split("-").map(Number); return <option key={k} value={k}>{MONTH_NAMES[mo-1]} {yr}</option>; })}
                </select>
              </div>
              <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                <span style={{ fontSize:11, color:"#94a3b8" }}>To</span>
                <select value={toMonth} onChange={e=>setToMonth(e.target.value)} style={selectStyle}>
                  {monthOptions.map(k=>{ const[yr,mo]=k.split("-").map(Number); return <option key={k} value={k}>{MONTH_NAMES[mo-1]} {yr}</option>; })}
                </select>
              </div>
              <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
                {[...new Set(monthOptions.map(k=>k.slice(0,4)))].map(yr => {
                  const active=fromMonth===`${yr}-01`&&toMonth===`${yr}-12`;
                  return <button key={yr} onClick={()=>{setFromMonth(`${yr}-01`);setToMonth(`${yr}-12`);}} style={{...quickBtnStyle,background:active?"rgba(99,102,241,0.3)":"rgba(99,102,241,0.08)",border:`1px solid ${active?"#6366f1":"rgba(99,102,241,0.2)"}`}}>{yr}</button>;
                })}
                <button onClick={()=>{ if(monthOptions.length){setFromMonth(monthOptions[0]);setToMonth(monthOptions[monthOptions.length-1]);} }} style={{...quickBtnStyle,background:"rgba(99,102,241,0.08)",border:"1px solid rgba(99,102,241,0.2)"}}>All</button>
              </div>
              <span style={{ marginLeft:"auto", fontSize:11, color:"#64748b" }}>
                <span style={{color:"#f1f5f9",fontWeight:700}}>{filtered.length}</span> events
                {stipendVersions.length>0&&totalStipend>0&&<> · <span style={{color:"#34d399",fontWeight:700}}>${totalStipend.toFixed(2)}</span></>}
                {filtered.length>0&&<> · <span style={{color:"#f59e0b"}}>{weekendCount}</span> wkd/hol</>}
              </span>
            </div>
          </div>
        )}

        {/* Holiday panel */}
        <div style={{ marginBottom:14 }}>
          <button onClick={()=>setShowHolidayPanel(p=>!p)} style={{ background:"rgba(99,102,241,0.08)", border:"1px solid rgba(99,102,241,0.2)", color:"#818cf8", padding:"5px 14px", borderRadius:6, cursor:"pointer", fontSize:11, fontFamily:"inherit", display:"flex", alignItems:"center", gap:6 }}>
            🗓 {showHolidayPanel?"Hide":"Manage"} Holidays
            {disabledFederal.size>0&&<span style={{background:"#ef4444",color:"#fff",borderRadius:10,padding:"1px 7px",fontSize:10}}>{disabledFederal.size} off</span>}
            {customDates.length>0&&<span style={{background:"#6366f1",color:"#fff",borderRadius:10,padding:"1px 7px",fontSize:10}}>{customDates.length} custom</span>}
          </button>
          {showHolidayPanel && (
            <div style={{ marginTop:10, background:"#141720", border:"1px solid #1e2535", borderRadius:10, padding:"16px" }}>
              <div style={{ fontSize:11, color:"#64748b", marginBottom:12, lineHeight:1.6 }}>Click any holiday to toggle it on/off. Disabled holidays are treated as regular weekdays.</div>
              {eventYears.length>0 && (
                <div style={{ marginBottom:16 }}>
                  <div style={{ fontSize:10, color:"#475569", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:10 }}>Federal Holidays — click to enable/disable</div>
                  {eventYears.sort().map(yr => {
                    const yearDates=Object.entries(federalMap).filter(([d])=>d.startsWith(String(yr))).sort(([a],[b])=>a.localeCompare(b));
                    return (
                      <div key={yr} style={{ marginBottom:10 }}>
                        <div style={{ fontSize:10, color:"#334155", marginBottom:6 }}>{yr}</div>
                        <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                          {yearDates.map(([date,name]) => {
                            const disabled=disabledFederal.has(date);
                            const dt=new Date(date+"T12:00:00");
                            return <button key={date} onClick={()=>toggleFederalHoliday(date)} style={{ background:disabled?"rgba(71,85,105,0.15)":"rgba(99,102,241,0.1)", border:`1px solid ${disabled?"#334155":"rgba(99,102,241,0.3)"}`, borderRadius:5, padding:"4px 10px", fontSize:10, color:disabled?"#475569":"#818cf8", cursor:"pointer", fontFamily:"inherit", textDecoration:disabled?"line-through":"none", transition:"all 0.12s" }}>{name} · {dt.toLocaleDateString(undefined,{month:"short",day:"numeric"})}</button>;
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <div>
                <div style={{ fontSize:10, color:"#475569", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:6 }}>Custom Holiday Dates (YYYY-MM-DD)</div>
                <textarea value={customHolidayInput} onChange={e=>setCustomHolidayInput(e.target.value)} placeholder="e.g. 2024-11-29, 2025-04-18" style={{ width:"100%", background:"#0f1117", border:"1px solid #2d3748", borderRadius:6, color:"#e2e8f0", padding:"8px 10px", fontSize:11, fontFamily:"inherit", resize:"vertical", minHeight:52, boxSizing:"border-box" }} />
                {customDates.length>0&&<div style={{ marginTop:8, display:"flex", flexWrap:"wrap", gap:6 }}>{customDates.map(d=>{ const dt=new Date(d+"T12:00:00"); return <span key={d} style={{ background:"rgba(245,158,11,0.1)", border:"1px solid rgba(245,158,11,0.3)", borderRadius:4, padding:"2px 8px", fontSize:10, color:"#f59e0b" }}>★ {dt.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})}</span>; })}</div>}
              </div>
            </div>
          )}
        </div>

        {/* Export */}
        {hasStore && filtered.length>0 && (
          <div style={{ display:"flex", justifyContent:"flex-end", marginBottom:14 }}>
            <button onClick={()=>exportToXLSX(filtered,getStipendMapForMonth,holidaySet)} style={{ background:"linear-gradient(135deg,#6366f1,#7c3aed)", border:"none", color:"#fff", padding:"8px 22px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit", fontWeight:600 }}>⬇ Export to Excel</button>
          </div>
        )}

        {/* Tabs */}
        {hasStore && filtered.length > 0 && (
          <>
            <div style={{ display:"flex", gap:2, borderBottom:"1px solid #1e2535" }}>
              {["events",...(stipendVersions.length>0?["summary"]:[])].map(tab=>(
                <button key={tab} onClick={()=>setActiveTab(tab)} style={{ background:activeTab===tab?"#141720":"transparent", border:"1px solid "+(activeTab===tab?"#1e2535":"transparent"), borderBottom:activeTab===tab?"1px solid #141720":"1px solid transparent", borderRadius:"6px 6px 0 0", color:activeTab===tab?"#f1f5f9":"#64748b", padding:"7px 18px", fontSize:11, cursor:"pointer", fontFamily:"inherit", textTransform:"uppercase", letterSpacing:"0.06em", fontWeight:600, marginBottom:-1 }}>
                  {tab==="events"?`Events (${filtered.length})`:"Monthly Summary"}
                </button>
              ))}
            </div>

            {activeTab==="events" && (
              <div style={{ background:"#141720", borderRadius:"0 8px 8px 8px", border:"1px solid #1e2535", overflow:"hidden" }}>
                <div style={{ overflowX:"auto", maxHeight:440, overflowY:"auto" }}>
                  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                    <thead>
                      <tr style={{ background:"#0f1117", position:"sticky", top:0, zIndex:1 }}>
                        {["Title","Date","Day Type","Stipend Applied","Stipend ($)","Location"].map(h=><th key={h} style={thStyle}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0,300).map((e,i) => {
                        const { details, total, isWeekend } = calcEventStipend(e, getStipendMapForMonth(fmtYYYYMM(e.start)), holidaySet);
                        return (
                          <tr key={e.uid||i} style={{ borderBottom:"1px solid #1a2030", background:i%2===0?"transparent":"rgba(255,255,255,0.01)" }}>
                            <td style={cellStyle}>{e.summary||"—"}</td>
                            <td style={{...cellStyle,whiteSpace:"nowrap",color:"#a78bfa"}}>{e.start?e.start.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}):"—"}</td>
                            <td style={{...cellStyle,whiteSpace:"nowrap"}}>{e.start?<span style={{color:isWeekend?"#f59e0b":"#34d399",fontSize:10,fontWeight:600}}>{isWeekend?"⛅ WKD/HOL":"📅 WEEKDAY"}</span>:"—"}</td>
                            <td style={{...cellStyle,color:details.length?"#fbbf24":"#475569",fontSize:11}}>{details.length?details.map(d=>d.rateKey).join(", "):"—"}</td>
                            <td style={{...cellStyle,color:total>0?"#34d399":"#475569",fontWeight:total>0?700:400}}>{total>0?`$${total.toFixed(2)}`:"—"}</td>
                            <td style={cellStyle}>{e.location||"—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {filtered.length>300&&<div style={{ padding:"7px 14px", color:"#64748b", fontSize:11, borderTop:"1px solid #1e2535" }}>Showing first 300 of {filtered.length}. All will be exported.</div>}
              </div>
            )}

            {activeTab==="summary" && stipendVersions.length > 0 && (
              <div style={{ background:"#141720", borderRadius:"0 8px 8px 8px", border:"1px solid #1e2535", overflow:"hidden" }}>
                <div style={{ overflowX:"auto" }}>
                  <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                    <thead>
                      <tr style={{ background:"#0f1117" }}>
                        <th style={thStyle}>Month</th>
                        <th style={{...thStyle,color:"#34d399"}}>Stipend Rates</th>
                        <th style={thStyle}>Events</th>
                        {STIPEND_GROUPS.map(g=><th key={g} style={{...thStyle,color:GROUP_COLOR[g]||"#94a3b8"}}>{g}</th>)}
                        <th style={{...thStyle,color:"#34d399"}}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthlySummary.map((row,i)=>(
                        <tr key={row.key} style={{ borderBottom:"1px solid #1a2030", background:i%2===0?"transparent":"rgba(255,255,255,0.01)" }}>
                          <td style={{...cellStyle,color:"#f1f5f9",fontWeight:600,whiteSpace:"nowrap"}}>{row.label}</td>
                          <td style={{...cellStyle,whiteSpace:"nowrap"}}>
                            <select
                              value={monthVersionAssignments[row.month] || stipendVersions.at(-1)?.id || ""}
                              onChange={e => setMonthVersionAssignments(prev => ({ ...prev, [row.month]: e.target.value }))}
                              style={{ ...selectStyle, fontSize:11, padding:"3px 8px" }}
                            >
                              {stipendVersions.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
                            </select>
                          </td>
                          <td style={{...cellStyle,color:"#94a3b8",textAlign:"center"}}>{row.count}</td>
                          {STIPEND_GROUPS.map(g=><td key={g} style={{...cellStyle,textAlign:"right",color:row.byGroup[g]>0?"#e2e8f0":"#334155",fontVariantNumeric:"tabular-nums"}}>{row.byGroup[g]>0?`$${row.byGroup[g].toFixed(2)}`:"—"}</td>)}
                          <td style={{...cellStyle,color:"#34d399",fontWeight:700,textAlign:"right",fontVariantNumeric:"tabular-nums"}}>${row.total.toFixed(2)}</td>
                        </tr>
                      ))}
                      <tr style={{ borderTop:"2px solid #2d3748", background:"#0f1117" }}>
                        <td style={{...cellStyle,color:"#f1f5f9",fontWeight:700}}>TOTAL</td>
                        <td style={cellStyle}></td>
                        <td style={{...cellStyle,color:"#f1f5f9",fontWeight:700,textAlign:"center"}}>{filtered.length}</td>
                        {STIPEND_GROUPS.map(g=><td key={g} style={{...cellStyle,textAlign:"right",color:groupTotals[g]>0?"#e2e8f0":"#334155",fontWeight:600,fontVariantNumeric:"tabular-nums"}}>{groupTotals[g]>0?`$${groupTotals[g].toFixed(2)}`:"—"}</td>)}
                        <td style={{...cellStyle,color:"#34d399",fontWeight:700,fontSize:13,textAlign:"right",fontVariantNumeric:"tabular-nums"}}>${totalStipend.toFixed(2)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}

        {hasStore && filtered.length===0 && <div style={{ textAlign:"center", padding:"48px 24px", color:"#475569", fontSize:13 }}>No events in selected range.</div>}
        {!hasStore && <div style={{ textAlign:"center", padding:"64px 24px", color:"#334155", fontSize:13 }}>Upload a calendar export to get started.</div>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// SIMPLE DEBOUNCE
// ─────────────────────────────────────────────
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ─────────────────────────────────────────────
// MODAL PRIMITIVES
// ─────────────────────────────────────────────
function Modal({ title, children, onClose, wide=false }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.75)", zIndex:200, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
      <div style={{ background:"#1a1f2e", border:"1px solid #2d3748", borderRadius:14, padding:"28px 32px", width:wide?700:460, maxWidth:"95vw", maxHeight:"90vh", display:"flex", flexDirection:"column" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:16 }}>
          <div style={{ fontSize:15, fontWeight:700, color:"#f1f5f9" }}>{title}</div>
          <button onClick={onClose} style={{ background:"transparent", border:"none", color:"#64748b", fontSize:20, cursor:"pointer", lineHeight:1, padding:0 }}>×</button>
        </div>
        <div style={{ overflowY:"auto", flex:1 }}>{children}</div>
      </div>
    </div>
  );
}
function ModalFooter({ children }) {
  return <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginTop:20, paddingTop:16, borderTop:"1px solid #1e2535" }}>{children}</div>;
}
function PrimaryBtn({ onClick, children }) {
  return <button onClick={onClick} style={{ background:"linear-gradient(135deg,#6366f1,#7c3aed)", border:"none", color:"#fff", padding:"8px 20px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit", fontWeight:600 }}>{children}</button>;
}
function GhostBtn({ onClick, children }) {
  return <button onClick={onClick} style={{ background:"transparent", border:"1px solid #2d3748", color:"#94a3b8", padding:"7px 16px", borderRadius:6, cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>{children}</button>;
}

function DropZone({ label, sublabel, icon, dragOver, onDragOver, onDragLeave, onDrop, onClick, accent="#6366f1" }) {
  return (
    <div onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop} onClick={onClick}
      style={{ border:`2px dashed ${dragOver?accent:"#2d3748"}`, borderRadius:10, padding:"22px 20px", textAlign:"center", cursor:"pointer", background:dragOver?`${accent}0d`:"#141720", transition:"all 0.15s ease" }}>
      <div style={{ fontSize:24, marginBottom:6 }}>{icon}</div>
      <div style={{ color:"#94a3b8", fontSize:13 }}>{label}</div>
      {sublabel && <div style={{ color:"#475569", fontSize:11, marginTop:4 }}>{sublabel}</div>}
    </div>
  );
}

const selectStyle  = { background:"#0f1117", border:"1px solid #2d3748", borderRadius:6, color:"#e2e8f0", padding:"6px 10px", fontSize:12, fontFamily:"'DM Mono',monospace", outline:"none", cursor:"pointer" };
const quickBtnStyle= { color:"#a78bfa", padding:"4px 12px", borderRadius:5, cursor:"pointer", fontSize:11, fontFamily:"inherit", fontWeight:600 };
const thStyle      = { padding:"9px 14px", textAlign:"left", color:"#64748b", fontWeight:600, borderBottom:"1px solid #1e2535", fontSize:10, textTransform:"uppercase", letterSpacing:"0.04em", whiteSpace:"nowrap" };
const cellStyle    = { padding:"8px 14px", color:"#cbd5e1", maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" };
const modalSubText = { fontSize:12, color:"#64748b", marginBottom:16, lineHeight:1.7, marginTop:0 };
const modalLabel   = { fontSize:10, color:"#475569", textTransform:"uppercase", letterSpacing:"0.07em", marginBottom:5 };
