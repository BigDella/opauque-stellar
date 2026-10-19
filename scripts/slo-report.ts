/**
 * SLO measurement + periodic report for the testnet ASP, relayer, and reputation
 * publisher. See docs/testnet-slos.md for the objective definitions, rationale, and
 * measurement-source writeup this script implements.
 *
 * Each run:
 *   1. Takes one live sample per service — on-chain event timestamps/counts for the
 *      ASP and relayer (via Soroban RPC `getEvents`), and the publisher's local
 *      inbox backlog (+ an optional HTTP health probe).
 *   2. Appends that sample to ops/slo/<service>.jsonl (gitignored; accumulates
 *      across periodic runs so trailing-window stats become meaningful over time —
 *      run this on a schedule, e.g. hourly via cron, rather than once).
 *   3. Recomputes trailing-window latency (p95) and availability from the
 *      accumulated samples and prints a pass/fail table against the objectives.
 *
 * Usage:
 *   npx tsx scripts/slo-report.ts
 *   npx tsx scripts/slo-report.ts --network testnet --window 7d
 *   npx tsx scripts/slo-report.ts --publisher-url http://127.0.0.1:8790 --json
 *
 * Cron example (hourly):
 *   0 * * * * cd /path/to/opaque-stellar && npx tsx scripts/slo-report.ts >> ops/slo/report.log 2>&1
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rpc, xdr } from "@stellar/stellar-sdk";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SLO_DIR = join(ROOT, "ops", "slo");

/**
 * Objective definitions — single source of truth. docs/testnet-slos.md mirrors
 * these numbers in prose; update both together if either changes.
 *
 * `latencySeconds` is compared against the trailing-window p95 of accumulated
 * sample lag. `availabilityTarget` is compared against the trailing-window
 * fraction of samples that met the latency objective (for the relayer, against
 * the live on-chain job completion rate instead — see the relayer sampler).
 */
const OBJECTIVES = {
  asp: {
    label: "ASP publication",
    latencySeconds: 120,
    availabilityTarget: 0.99,
    source: "Soroban RPC getEvents on privacyPool (Deposit, AspRootPublished, StateRootPublished)",
  },
  relayer: {
    label: "Relayer completion",
    latencySeconds: 300,
    availabilityTarget: 0.95,
    source: "Soroban RPC getEvents on relayerRegistry (JobCreated, JobSubmitted, JobSlashed)",
  },
  publisher: {
    label: "Publisher latency",
    latencySeconds: 300,
    availabilityTarget: 0.99,
    source: "Publisher local data dir (inbox backlog age) + optional /health probe",
  },
};

const DEFAULT_LOOKBACK_LEDGERS = 4000; // ~5.5h at 5s/ledger; bounds live RPC query cost per run
const MAX_EVENT_PAGES = 50;

function parseArgs(argv) {
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  return {
    network: opt("network", "testnet"),
    windowMs: parseDuration(opt("window", "24h")),
    lookbackLedgers: Number(opt("lookback-ledgers", DEFAULT_LOOKBACK_LEDGERS)),
    publisherUrl: opt("publisher-url", process.env.SLO_PUBLISHER_URL),
    publisherDataDir: opt("publisher-data-dir", join(ROOT, "publisher", "data")),
    aspUrl: opt("asp-url", process.env.SLO_ASP_URL),
    json: argv.includes("--json"),
  };
}

function parseDuration(raw) {
  const m = /^(\d+)(s|m|h|d)$/.exec(String(raw).trim());
  if (!m) throw new Error(`Invalid duration "${raw}" (expected e.g. 24h, 7d, 30m)`);
  const n = Number(m[1]);
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
  return n * unitMs;
}

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

// ── Sample log ───────────────────────────────────────────────────────────────

function appendSample(service, sample) {
  mkdirSync(SLO_DIR, { recursive: true });
  appendFileSync(join(SLO_DIR, `${service}.jsonl`), `${JSON.stringify(sample)}\n`);
}

function readSamples(service, sinceMs) {
  const path = join(SLO_DIR, `${service}.jsonl`);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const samples = [];
  for (const line of lines) {
    try {
      const s = JSON.parse(line);
      if (Date.parse(s.at) >= sinceMs) samples.push(s);
    } catch {
      /* skip malformed line */
    }
  }
  return samples;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// ── Soroban RPC helpers ──────────────────────────────────────────────────────

async function latestEventTime(server, contractId, topicName, startLedger) {
  const topic = xdr.ScVal.scvSymbol(topicName).toXDR("base64");
  const filters = [{ type: "contract", contractIds: [contractId], topics: [[topic, "*"]] }];
  let cursor;
  let prevCursor;
  let count = 0;
  let latestCloseTime = null;

  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const res = cursor
      ? await server.getEvents({ cursor, filters, limit: 100 })
      : await server.getEvents({ startLedger, filters, limit: 100 });
    for (const ev of res.events ?? []) {
      count++;
      if (!latestCloseTime || ev.ledgerClosedAt > latestCloseTime) latestCloseTime = ev.ledgerClosedAt;
    }
    cursor = res.cursor;
    if (!cursor || cursor === prevCursor) break;
    prevCursor = cursor;
  }
  return { count, latestCloseTime };
}

async function resolveStartLedger(server, lookbackLedgers) {
  const latest = (await server.getLatestLedger()).sequence;
  let start = Math.max(1, latest - lookbackLedgers);
  try {
    const health = await server.getHealth();
    const oldest = Number(health.oldestLedger);
    if (start < oldest) start = oldest;
  } catch {
    /* health unavailable; best-effort start ledger stands */
  }
  return start;
}

// ── Samplers ─────────────────────────────────────────────────────────────────

/** Lag = time since the more-recent of the two event streams, when the "trigger"
 * stream (deposits/jobs created) is currently ahead of the "publish" stream. */
function computeLag(triggerTime, publishTime, now) {
  if (!triggerTime) return 0; // nothing has ever happened; no backlog
  if (publishTime && publishTime >= triggerTime) return 0; // fully caught up
  return (now - Date.parse(triggerTime)) / 1000;
}

async function sampleAsp(server, manifest, lookbackLedgers, aspUrl) {
  const poolId = manifest.contracts?.privacyPool?.id;
  if (!poolId) return { ok: false, reason: "privacyPool not deployed in manifest" };

  const startLedger = await resolveStartLedger(server, lookbackLedgers);
  const [deposit, aspRoot, stateRoot] = await Promise.all([
    latestEventTime(server, poolId, "Deposit", startLedger),
    latestEventTime(server, poolId, "AspRootPublished", startLedger),
    latestEventTime(server, poolId, "StateRootPublished", startLedger),
  ]);
  const publishTime = [aspRoot.latestCloseTime, stateRoot.latestCloseTime].filter(Boolean).sort().pop() ?? null;
  const now = Date.now();
  const lagSeconds = computeLag(deposit.latestCloseTime, publishTime, now);

  let healthOk = null;
  if (aspUrl) {
    try {
      const res = await fetch(`${aspUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(5000) });
      healthOk = res.ok;
    } catch {
      healthOk = false;
    }
  }

  return {
    ok: true,
    at: new Date(now).toISOString(),
    lagSeconds,
    depositEvents: deposit.count,
    publishEvents: aspRoot.count + stateRoot.count,
    healthOk,
  };
}

async function sampleRelayer(server, manifest, lookbackLedgers) {
  const registryId = manifest.contracts?.relayerRegistry?.id;
  if (!registryId) return { ok: false, reason: "relayerRegistry not deployed in manifest" };

  const startLedger = await resolveStartLedger(server, lookbackLedgers);
  const [created, submitted, slashed] = await Promise.all([
    latestEventTime(server, registryId, "JobCreated", startLedger),
    latestEventTime(server, registryId, "JobSubmitted", startLedger),
    latestEventTime(server, registryId, "JobSlashed", startLedger),
  ]);
  const now = Date.now();
  const lagSeconds = computeLag(created.latestCloseTime, submitted.latestCloseTime, now);
  const completionRate = created.count > 0 ? submitted.count / created.count : null;

  return {
    ok: true,
    at: new Date(now).toISOString(),
    lagSeconds,
    jobsCreated: created.count,
    jobsSubmitted: submitted.count,
    jobsSlashed: slashed.count,
    completionRate,
  };
}

async function samplePublisher(dataDir, publisherUrl) {
  const inboxDir = join(dataDir, "inbox");
  const now = Date.now();
  let lagSeconds = 0;
  let pendingCount = 0;

  if (existsSync(inboxDir)) {
    for (const name of readdirSync(inboxDir).filter((f) => f.endsWith(".json"))) {
      try {
        const commitment = JSON.parse(readFileSync(join(inboxDir, name), "utf8"));
        if (!commitment.submittedAt) continue;
        pendingCount++;
        const age = (now - Date.parse(commitment.submittedAt)) / 1000;
        if (age > lagSeconds) lagSeconds = age;
      } catch {
        /* skip malformed inbox file */
      }
    }
  }

  let healthOk = null;
  if (publisherUrl) {
    try {
      const res = await fetch(`${publisherUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(5000) });
      healthOk = res.ok;
    } catch {
      healthOk = false;
    }
  }

  return {
    ok: true,
    at: new Date(now).toISOString(),
    lagSeconds,
    pendingCount,
    healthOk,
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

function summarize(service, freshSample, windowMs) {
  if (freshSample.ok) appendSample(service, freshSample);
  const objective = OBJECTIVES[service];
  const since = Date.now() - windowMs;
  const samples = readSamples(service, since);
  const lagValues = samples.map((s) => s.lagSeconds).filter((v) => typeof v === "number");
  const p95Lag = percentile(lagValues, 95);
  const withinLatency = lagValues.filter((v) => v <= objective.latencySeconds).length;
  const latencyAvailability = lagValues.length > 0 ? withinLatency / lagValues.length : null;

  let availability = latencyAvailability;
  if (service === "relayer") {
    const rates = samples.map((s) => s.completionRate).filter((v) => typeof v === "number");
    if (rates.length > 0) availability = rates.reduce((a, b) => a + b, 0) / rates.length;
  }

  return {
    service,
    objective,
    sampleCount: samples.length,
    p95LagSeconds: p95Lag,
    latencyPass: p95Lag === null ? null : p95Lag <= objective.latencySeconds,
    availability,
    availabilityPass: availability === null ? null : availability >= objective.availabilityTarget,
    freshSample,
  };
}

function fmtSeconds(v) {
  if (v === null || v === undefined) return "n/a";
  return v < 120 ? `${v.toFixed(0)}s` : `${(v / 60).toFixed(1)}m`;
}

function fmtPct(v) {
  return v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

function fmtPass(v) {
  if (v === null) return "— (insufficient data)";
  return v ? "PASS" : "FAIL";
}

/** Activity this run's live sample actually observed, so a 0s lag from genuine
 * idleness isn't mistaken for confirmed evidence of a healthy pipeline. */
function activityLine(service, s) {
  if (!s.ok) return null;
  switch (service) {
    case "asp":
      return `${s.depositEvents} Deposit / ${s.publishEvents} root-publish event(s) observed${s.healthOk === null ? "" : s.healthOk ? ", /health OK" : ", /health FAILED"}`;
    case "relayer":
      return `${s.jobsCreated} created / ${s.jobsSubmitted} submitted / ${s.jobsSlashed} slashed job event(s) observed`;
    case "publisher":
      return `${s.pendingCount} leaf/leaves pending in local inbox${s.healthOk === null ? "" : s.healthOk ? ", /health OK" : ", /health FAILED"}`;
    default:
      return null;
  }
}

function noActivity(service, s) {
  if (!s.ok) return false;
  if (service === "asp") return s.depositEvents === 0;
  if (service === "relayer") return s.jobsCreated === 0;
  return false;
}

function printReport(results, windowMs) {
  const windowLabel = `${(windowMs / 3_600_000).toFixed(1)}h`;
  console.log(`\nOpaque testnet SLO report — trailing ${windowLabel} window, ${results[0]?.sampleCount ?? 0} sample(s) minimum\n`);
  for (const r of results) {
    console.log(`## ${r.objective.label}`);
    console.log(`  Measurement source: ${r.objective.source}`);
    console.log(`  Samples in window:  ${r.sampleCount}`);
    console.log(
      `  Latency:      p95=${fmtSeconds(r.p95LagSeconds)} objective=≤${fmtSeconds(r.objective.latencySeconds)} → ${fmtPass(r.latencyPass)}`,
    );
    console.log(
      `  Availability: actual=${fmtPct(r.availability)} objective=≥${fmtPct(r.objective.availabilityTarget)} → ${fmtPass(r.availabilityPass)}`,
    );
    const activity = activityLine(r.service, r.freshSample);
    if (activity) console.log(`  This run:     ${activity}`);
    if (!r.freshSample.ok) {
      console.log(`  ⚠ Could not take a fresh sample this run: ${r.freshSample.reason}`);
    } else if (noActivity(r.service, r.freshSample)) {
      console.log(
        `  ⚠ No triggering activity in the lookback window — 0s lag reflects an idle window, not confirmed evidence of a healthy pipeline under load.`,
      );
    }
    console.log("");
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const manifestPath = join(ROOT, "deployments", "v1", `${opts.network}.json`);
  if (!existsSync(manifestPath)) fail(`Missing manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const rpcUrl = manifest.rpcUrl;
  if (!rpcUrl) fail(`No rpcUrl in ${manifestPath}`);

  const server = new rpc.Server(rpcUrl);

  const [aspSample, relayerSample, publisherSample] = await Promise.all([
    sampleAsp(server, manifest, opts.lookbackLedgers, opts.aspUrl).catch((err) => ({ ok: false, reason: err?.message ?? String(err) })),
    sampleRelayer(server, manifest, opts.lookbackLedgers).catch((err) => ({ ok: false, reason: err?.message ?? String(err) })),
    samplePublisher(opts.publisherDataDir, opts.publisherUrl).catch((err) => ({ ok: false, reason: err?.message ?? String(err) })),
  ]);

  const results = [
    summarize("asp", aspSample, opts.windowMs),
    summarize("relayer", relayerSample, opts.windowMs),
    summarize("publisher", publisherSample, opts.windowMs),
  ];

  if (opts.json) {
    console.log(JSON.stringify({ network: opts.network, windowMs: opts.windowMs, results }, null, 2));
    return;
  }

  printReport(results, opts.windowMs);

  const anyFail = results.some((r) => r.latencyPass === false || r.availabilityPass === false);
  if (anyFail) process.exitCode = 1;
}

main().catch((err) => fail(err?.message ?? String(err)));
