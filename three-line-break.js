(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ThreeLineBreak = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const LINE_COUNT = 3;

  // Closing-price line break: time advances only when a new line forms.
  // Reversals must break the range of the last three formed lines, not days.
  function build(rows) {
    const byTime = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const time = row?.time ?? row?.date;
      if (typeof time !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(time) ||
          !Number.isFinite(row.close) || row.close <= 0) continue;
      const timestamp = Date.parse(`${time}T00:00:00Z`);
      if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== time) continue;
      byTime.set(time, { time, close: row.close });
    }
    const daily = [...byTime.values()].sort((a, b) => a.time.localeCompare(b.time));
    const lines = [];
    if (!daily.length) return lines;
    const baseline = daily[0].close;
    for (const row of daily.slice(1)) {
      const last = lines[lines.length - 1];
      if (!last) {
        if (row.close !== baseline) lines.push(line(row.time, baseline, row.close));
        continue;
      }
      const recent = lines.slice(-LINE_COUNT);
      const up = last.close > last.open;
      const continuation = up ? row.close > last.high : row.close < last.low;
      const reversal = up
        ? row.close < Math.min(...recent.map((item) => item.low))
        : row.close > Math.max(...recent.map((item) => item.high));
      if (continuation || reversal) lines.push(line(row.time, continuation ? last.close : last.open, row.close));
    }
    return lines;
  }
  function line(time, open, close) {
    return { time, open, high: Math.max(open, close), low: Math.min(open, close), close };
  }
  // Keep indicators calculated on daily bars; sample only formed-line dates so
  // the chart does not reintroduce empty sessions into the compressed timeline.
  function project(indicator, lines) {
    const times = new Set(lines.map((row) => row.time));
    return indicator.filter((row) => times.has(row.time));
  }
  return { LINE_COUNT, build, project };
});
