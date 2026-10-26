// Benchmark report shared by every scenario: per-route latency, RPS and errors, plus the
// machine the run happened on. Written to load/results/ and printed to stdout.

// k6 keeps tag-filtered metrics only for keys referenced in `thresholds`.
// An empty list registers the sub-metric without asserting anything.
const durationKey = (route) => `http_req_duration{name:${route},phase:main}`;
const failedKey = (route) => `http_req_failed{name:${route},phase:main}`;
const ALL_DURATION = "http_req_duration{phase:main}";
const ALL_FAILED = "http_req_failed{phase:main}";

export const SUMMARY_TREND_STATS = ["count", "avg", "p(50)", "p(95)", "p(99)", "max"];

/** Thresholds entries that make the report able to break results down by route. */
export function routeThresholds(routes) {
  const entries = { [ALL_DURATION]: [], [ALL_FAILED]: [] };
  for (const route of routes) {
    entries[durationKey(route)] = [];
    entries[failedKey(route)] = [];
  }
  return entries;
}

const ms = (value) => (value === undefined ? "-" : `${value.toFixed(1)} ms`);
const pct = (rate) => (rate === undefined ? "-" : `${(rate * 100).toFixed(2)}%`);

function row(label, data, durationMetric, failedMetric, seconds) {
  const d = data.metrics[durationMetric]?.values;
  const f = data.metrics[failedMetric]?.values;
  if (!d || !d.count) return `| ${label} | 0 | - | - | - | - | - |`;
  const rps = (d.count / seconds).toFixed(1);
  return `| ${label} | ${d.count} | ${rps} | ${ms(d["p(50)"])} | ${ms(d["p(95)"])} | ${ms(d["p(99)"])} | ${pct(f?.rate)} |`;
}

function thresholdLines(data) {
  const lines = [];
  for (const [metric, { thresholds }] of Object.entries(data.metrics)) {
    for (const [expression, { ok }] of Object.entries(thresholds || {})) {
      lines.push(`- ${ok ? "PASS" : "FAIL"} \`${metric}\` ${expression}`);
    }
  }
  return lines.length ? lines : ["- (none)"];
}

/** Scenario-specific counters (e.g. holds_succeeded) are the correctness numbers of a run. */
function counterLines(data) {
  return Object.entries(data.metrics)
    .filter(([name, metric]) => metric.type === "counter" && !/^(http_|data_|iterations)/.test(name))
    .map(([name, metric]) => `- **${name}:** ${metric.values.count}`);
}

function markdown(scenario, routes, data) {
  const env = (key) => __ENV[key] || "unknown";
  const seconds = data.state.testRunDurationMs / 1000;
  const checks = data.metrics.checks?.values;
  const vusMax = data.metrics.vus_max?.values.max ?? data.metrics.vus_max?.values.value;
  return [
    `# Benchmark: ${scenario}`,
    "",
    `- **Date (UTC):** ${new Date().toISOString()}`,
    `- **Commit:** ${env("GIT_COMMIT")}`,
    // vus_max is only sampled in runs longer than ~1 s.
    `- **Duration:** ${seconds.toFixed(1)} s${vusMax ? `, max ${vusMax} VUs` : ""}`,
    `- **Checks:** ${checks ? `${checks.passes}/${checks.passes + checks.fails} passed` : "none"}`,
    ...counterLines(data),
    "",
    "## Machine",
    "",
    "| | |",
    "|---|---|",
    `| Host | ${env("MACHINE_HOST")} |`,
    `| CPU | ${env("MACHINE_CPU")} |`,
    `| Memory | ${env("MACHINE_MEMORY")} |`,
    `| Docker | ${env("MACHINE_DOCKER")} |`,
    `| Power | ${env("MACHINE_POWER")} |`,
    "",
    "## Results (setup traffic excluded)",
    "",
    "| Route | Requests | RPS | p50 | p95 | p99 | Errors |",
    "|---|---:|---:|---:|---:|---:|---:|",
    ...routes.map((route) => row(`\`${route}\``, data, durationKey(route), failedKey(route), seconds)),
    row("**All**", data, ALL_DURATION, ALL_FAILED, seconds),
    "",
    "## Thresholds",
    "",
    ...thresholdLines(data),
    "",
  ].join("\n");
}

/** export const handleSummary = report("smoke", ROUTES); */
export function report(scenario, routes) {
  return (data) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const text = markdown(scenario, routes, data);
    return {
      stdout: text,
      [`/load/results/${scenario}-${stamp}.md`]: text,
      [`/load/results/${scenario}-${stamp}.json`]: JSON.stringify(data, null, 2),
    };
  };
}
