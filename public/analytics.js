// Renders the /analytics page from cmd/hopreach-shareapi's /api/analytics
// endpoint. Hand-rolled SVG charts, no charting library — consistent with
// the rest of this project's dependency-light frontend. Nothing here ever
// touches a visitor's IP address, user agent, or any other identifying
// data: the payload is entirely aggregate infrastructure/anonymous-count
// data (see internal/analytics's package doc).

const SVG_NS = "http://www.w3.org/2000/svg";

function el(tag, attrs, children) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  (children || []).forEach((c) => e.appendChild(c));
  return e;
}

function fmtBytes(n) {
  if (!n) return "unknown";
  const gb = n / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(n / 1e6).toFixed(0)} MB`;
}

function fmtDuration(s) {
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// downsample keeps at most `max` points, evenly spaced, so a chart stays
// readable and fast to render even with analytics.MaxLinesDefault (20,000)
// worth of history behind it — recent trend matters far more here than
// showing literally every sample.
function downsample(arr, max) {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

// lineChart draws one or more series (each { points: [{x, y}], color, label })
// on a shared x/y scale. x values are millis-since-epoch, y values are
// whatever unit the caller wants (already normalized to a 0..yMax range by
// the caller if it wants a fixed scale, otherwise auto-scaled here).
function lineChart(container, series, opts) {
  container.innerHTML = "";
  const allPoints = series.flatMap((s) => s.points);
  if (allPoints.length === 0) {
    const p = document.createElement("div");
    p.className = "an-empty";
    p.textContent = opts.emptyText || "No data yet.";
    container.appendChild(p);
    return;
  }

  const width = Math.max(container.clientWidth || 700, 320);
  const height = opts.height || 220;
  const padL = 46, padR = 12, padT = 12, padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const xs = allPoints.map((p) => p.x);
  const ys = allPoints.map((p) => p.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = 0;
  const yMax = opts.yMax != null ? opts.yMax : Math.max(...ys) * 1.1 || 1;

  const sx = (x) => padL + (xMax === xMin ? plotW / 2 : ((x - xMin) / (xMax - xMin)) * plotW);
  const sy = (y) => padT + plotH - (y / yMax) * plotH;

  const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}` });

  // gridlines + y-axis labels
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const y = padT + (plotH / gridLines) * i;
    svg.appendChild(el("line", { x1: padL, x2: width - padR, y1: y, y2: y, stroke: "var(--border)", "stroke-width": 1 }));
    const val = yMax - (yMax / gridLines) * i;
    const label = el("text", { x: padL - 6, y: y + 4, "text-anchor": "end", fill: "var(--text-muted)", "font-size": 10 });
    label.textContent = opts.yLabel ? opts.yLabel(val) : val.toFixed(0);
    svg.appendChild(label);
  }

  // x-axis labels: first and last timestamp only, to avoid clutter
  [xMin, xMax].forEach((x, i) => {
    const label = el("text", {
      x: sx(x), y: height - 6,
      "text-anchor": i === 0 ? "start" : "end",
      fill: "var(--text-muted)", "font-size": 10,
    });
    label.textContent = new Date(x).toLocaleDateString();
    svg.appendChild(label);
  });

  series.forEach((s) => {
    if (s.points.length === 0) return;
    if (s.bars) {
      // Bar series (plan-shares-per-day): one rect per point.
      const barW = Math.max(2, plotW / s.points.length - 2);
      s.points.forEach((p) => {
        const x = sx(p.x) - barW / 2;
        const y = sy(p.y);
        svg.appendChild(el("rect", { x, y, width: barW, height: padT + plotH - y, fill: s.color }));
      });
      return;
    }
    const d = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
    svg.appendChild(el("path", { d, fill: "none", stroke: s.color, "stroke-width": 2 }));
    if (opts.dots) {
      s.points.forEach((p) => {
        svg.appendChild(el("circle", { cx: sx(p.x), cy: sy(p.y), r: 2.5, fill: s.color }));
      });
    }
  });

  container.appendChild(svg);

  if (opts.legend !== false) {
    const legend = document.createElement("div");
    legend.className = "an-legend";
    series.forEach((s) => {
      const span = document.createElement("span");
      const i = document.createElement("i");
      i.style.background = s.color;
      span.appendChild(i);
      span.appendChild(document.createTextNode(s.label));
      legend.appendChild(span);
    });
    container.appendChild(legend);
  }
}

function renderTopStats(data) {
  const el = document.getElementById("an-top-stats");
  const parts = [];
  if (data.version) parts.push(`version ${data.version}`);
  parts.push(data.gpu_worker_connected ? "remote GPU: connected" : "remote GPU: not connected");
  el.textContent = parts.join(" · ");
}

function renderHardware(data) {
  const container = document.getElementById("an-hardware");
  if (!data.hardware || data.hardware.length === 0) {
    container.innerHTML = '<div class="an-empty">No hardware info recorded yet — appears after the next coverage run / worker connection.</div>';
    return;
  }
  const table = document.createElement("table");
  table.className = "an-table";
  table.innerHTML = "<tr><th>Box</th><th>CPU</th><th>RAM</th><th>GPU</th></tr>";
  data.hardware.forEach((h) => {
    const row = document.createElement("tr");
    const boxLabel = h.box === "website" ? "Website box" : "Remote GPU worker";
    row.innerHTML = `<td>${boxLabel}</td><td>${h.cpu_model || "unknown"}</td><td>${fmtBytes(h.total_bytes)}</td><td>${h.gpu_adapter || "none / CPU only"}</td>`;
    table.appendChild(row);
  });
  container.innerHTML = "";
  container.appendChild(table);
}

function renderRuns(data) {
  const runs = data.runs || [];
  const summary = document.getElementById("an-runs-summary");
  const chart = document.getElementById("an-runs-chart");

  if (runs.length === 0) {
    summary.innerHTML = '<div class="an-empty">No coverage runs recorded yet.</div>';
    chart.innerHTML = "";
    return;
  }

  const successes = runs.filter((r) => r.success).length;
  const avgDuration = runs.reduce((s, r) => s + r.duration_seconds, 0) / runs.length;
  const last = runs[runs.length - 1];

  summary.innerHTML = "";
  const row = document.createElement("div");
  row.className = "an-summary-row";
  row.innerHTML = `
    <div><strong>${runs.length}</strong>total runs</div>
    <div><strong>${((successes / runs.length) * 100).toFixed(0)}%</strong>succeeded</div>
    <div><strong>${fmtDuration(avgDuration)}</strong>avg duration</div>
    <div><strong>${last.success ? "✓" : "✗"}</strong>last run (${fmtDate(last.finished_at)})</div>
  `;
  summary.appendChild(row);

  const recent = downsample(runs, 200);
  lineChart(chart, [
    {
      label: "Run duration (successful)",
      color: "#4ade80",
      points: recent.filter((r) => r.success).map((r) => ({ x: new Date(r.finished_at).getTime(), y: r.duration_seconds })),
    },
    {
      label: "Run duration (failed)",
      color: "#f87171",
      points: recent.filter((r) => !r.success).map((r) => ({ x: new Date(r.finished_at).getTime(), y: r.duration_seconds })),
    },
  ], { dots: true, yLabel: (v) => fmtDuration(v), emptyText: "No runs yet." });

  renderRunsList(runs);
}

// renderRunsList shows the most recent runs newest-first as a plain table —
// the chart above is good for spotting a trend, this is for looking up
// "did last night's run actually succeed, and which specific tier failed."
// Each tier is its own job (often dispatched to the remote GPU box), so it
// can fail independently of the others — shown per tier, not just once for
// the whole run.
function renderRunsList(runs) {
  const list = document.getElementById("an-runs-list");
  const maxRows = 25;
  const recent = runs.slice(-maxRows).reverse();

  const table = document.createElement("table");
  table.className = "an-table";
  table.innerHTML = "<tr><th>Finished</th><th>Duration</th><th>Result</th><th>Version</th><th>Tiers</th></tr>";
  recent.forEach((r) => {
    const row = document.createElement("tr");
    const result = r.success ? "✓ success" : `✗ failed${r.error ? `: ${escapeHtml(r.error)}` : ""}`;
    const tiers = (r.tiers || []).map((t) => {
      const mark = t.success ? "✓" : "✗";
      const label = t.success ? `${t.name} (${t.backend})` : `${t.name}${t.error ? `: ${escapeHtml(t.error)}` : ""}`;
      return `${mark} ${label}`;
    }).join(", ") || "—";
    row.innerHTML = `<td>${fmtDate(r.finished_at)}</td><td>${fmtDuration(r.duration_seconds)}</td><td>${result}</td><td>${r.version || "—"}</td><td>${tiers}</td>`;
    table.appendChild(row);
  });

  list.innerHTML = "";
  list.appendChild(table);
  if (runs.length > maxRows) {
    const note = document.createElement("div");
    note.className = "an-note";
    note.textContent = `Showing the most recent ${maxRows} of ${runs.length} runs.`;
    list.appendChild(note);
  }
}

function renderMemory(data) {
  const samples = data.memory_samples || [];
  const chart = document.getElementById("an-memory-chart");
  const byBox = {};
  samples.forEach((s) => {
    (byBox[s.box] = byBox[s.box] || []).push(s);
  });

  const colors = { website: "#38bdf8", gpu_worker: "#fb923c" };
  const labels = { website: "Website box", gpu_worker: "Remote GPU worker" };
  const series = Object.keys(byBox).map((box) => ({
    label: `${labels[box] || box} — available memory`,
    color: colors[box] || "#a78bfa",
    points: downsample(byBox[box], 300).map((s) => ({ x: new Date(s.time).getTime(), y: s.available_bytes / 1e9 })),
  }));

  lineChart(chart, series, { yLabel: (v) => `${v.toFixed(0)}GB`, emptyText: "No memory samples yet — collected every few minutes while this box is running." });
}

function renderShares(data) {
  const shares = data.plan_shares || [];
  const chart = document.getElementById("an-shares-chart");
  if (shares.length === 0) {
    chart.innerHTML = '<div class="an-empty">No plans have been shared yet.</div>';
    return;
  }
  // Aggregate to one count per calendar day.
  const perDay = {};
  shares.forEach((s) => {
    const day = new Date(s.time).toISOString().slice(0, 10);
    perDay[day] = (perDay[day] || 0) + 1;
  });
  const days = Object.keys(perDay).sort();
  const points = days.map((d) => ({ x: new Date(d).getTime(), y: perDay[d] }));
  lineChart(chart, [{ label: "Plans shared per day", color: "#c084fc", points, bars: true }], { yLabel: (v) => v.toFixed(0) });
}

function renderBackend(data) {
  const container = document.getElementById("an-backend");
  const runs = data.runs || [];
  const perBackend = {};
  // Only successful tiers count toward "typical duration" — a failed
  // tier's own duration is just how long it ran before failing, not a
  // representative sample of that backend's real performance.
  runs.forEach((r) => (r.tiers || []).filter((t) => t.success).forEach((t) => {
    const b = t.backend || "unknown";
    perBackend[b] = perBackend[b] || { count: 0, totalS: 0 };
    perBackend[b].count++;
    perBackend[b].totalS += t.duration_seconds;
  }));

  container.innerHTML = "";
  if (Object.keys(perBackend).length === 0) {
    container.innerHTML = '<div class="an-empty">No tier timing recorded yet.</div>';
  } else {
    const table = document.createElement("table");
    table.className = "an-table";
    table.innerHTML = "<tr><th>Backend</th><th>Tiers run</th><th>Avg duration</th></tr>";
    Object.keys(perBackend).sort().forEach((b) => {
      const row = document.createElement("tr");
      const avg = perBackend[b].totalS / perBackend[b].count;
      row.innerHTML = `<td>${b}</td><td>${perBackend[b].count}</td><td>${fmtDuration(avg)}</td>`;
      table.appendChild(row);
    });
    container.appendChild(table);
  }

  // Simple bottleneck heuristic: a box spending most of its recent samples
  // with little headroom (available memory well below its own total) is
  // flagged, since that's the condition that forces smaller chunk budgets
  // and slower tiled passes (see compute.Engine.effectiveChunkBudgetBytes).
  const samples = data.memory_samples || [];
  const byBox = {};
  samples.forEach((s) => {
    if (!s.total_bytes) return;
    (byBox[s.box] = byBox[s.box] || []).push(s.available_bytes / s.total_bytes);
  });
  const notes = [];
  Object.keys(byBox).forEach((box) => {
    const ratios = byBox[box];
    const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    if (avgRatio < 0.2) {
      const label = box === "website" ? "the website box" : "the remote GPU worker";
      notes.push(`${label} has averaged only ${(avgRatio * 100).toFixed(0)}% free memory recently — likely the tighter constraint on chunk sizing between the two boxes.`);
    }
  });
  if (notes.length > 0) {
    const p = document.createElement("div");
    p.className = "an-note";
    p.textContent = notes.join(" ");
    container.appendChild(p);
  }
}

async function main() {
  let data;
  try {
    const res = await fetch("/api/analytics");
    data = await res.json();
  } catch (e) {
    document.getElementById("an-content").innerHTML = '<div class="an-empty">Could not load analytics data.</div>';
    return;
  }
  renderTopStats(data);
  renderHardware(data);
  renderRuns(data);
  renderMemory(data);
  renderBackend(data);
  renderShares(data);
}

main();
