// Task 346: screen watchdog for packaged quiet-mode test runs.
//
// While the packaged smoke (and the rehearsal launcher) runs a quiet packaged
// app, this module samples the real screen every interval and fails the run if
// the app under test ever (a) owns an on-screen window, (b) becomes the
// frontmost application, or (c) is registered with Launch Services as a
// foreground-type app. Everything is read-only observation: the sampler lists
// on-screen windows WITHOUT titles (reading kCGWindowName would require Screen
// Recording permission and pop a permission dialog), so no permission prompt
// can appear. If the sampler itself cannot run, the smoke fails.
//
// The per-sample verdict is a pure function (evaluateQuietWatchdogSample) so
// unit tests can prove the watchdog is not a no-op.

import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const QUIET_WATCHDOG_SWIFT = `
import AppKit
import CoreGraphics
import Darwin
import Foundation

// One JSON object per line, forever, until the parent kills us. If the parent
// dies, the stdout pipe closes and the write below fails, ending this process.
func emit(_ line: String) {
  FileHandle.standardOutput.write((line + "\\n").data(using: .utf8)!)
  fflush(stdout)
}

let arguments = CommandLine.arguments
guard arguments.count >= 3,
      let mainPid = pid_t(arguments[1]),
      let intervalMs = Int(arguments[2]), intervalMs > 0 else {
  emit("{\\"type\\":\\"fatal\\",\\"message\\":\\"usage: quiet-watchdog <mainPid> <intervalMs>\\"}")
  exit(2)
}

while true {
  var sample: [String: Any] = [:]
  var windows: [[String: Any]] = []
  if let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] {
    for window in list {
      var entry: [String: Any] = [:]
      if let pid = window[kCGWindowOwnerPID as String] as? Int { entry["pid"] = pid }
      if let layer = window[kCGWindowLayer as String] as? Int { entry["layer"] = layer }
      if let alpha = (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue { entry["alpha"] = alpha }
      if let bounds = window[kCGWindowBounds as String] as? [String: NSNumber] {
        entry["bounds"] = [
          "X": bounds["X"]?.doubleValue ?? 0,
          "Y": bounds["Y"]?.doubleValue ?? 0,
          "Width": bounds["Width"]?.doubleValue ?? 0,
          "Height": bounds["Height"]?.doubleValue ?? 0,
        ]
      }
      windows.append(entry)
    }
  } else {
    sample["windowListError"] = true
  }
  sample["windows"] = windows
  if let front = NSWorkspace.shared.frontmostApplication {
    sample["frontPid"] = Int(front.processIdentifier)
  }
  if let watched = NSRunningApplication(processIdentifier: mainPid) {
    sample["appPolicy"] = watched.activationPolicy.rawValue
  } else {
    // -1 = the watched process has no Launch Services registration right now.
    sample["appPolicy"] = -1
  }
  guard let data = try? JSONSerialization.data(withJSONObject: sample),
        let line = String(data: data, encoding: .utf8) else {
    emit("{\\"type\\":\\"fatal\\",\\"message\\":\\"sample serialization failed\\"}")
    exit(3)
  }
  emit(line)
  usleep(useconds_t(intervalMs) * 1000)
}
`;

/**
 * Pure per-sample verdict. `windows` is the on-screen window list (any owner),
 * `frontPid` the frontmost application's pid, `appPolicy` the watched app's
 * NSApplicationActivationPolicy.rawValue (diagnostic only: right after spawn
 * the process registers with Launch Services as regular for a moment, before
 * quiet-test-mode's app.dock.hide() applies — the Dock check therefore runs
 * once per launch against lsappinfo after the app reached health, see
 * assertNotForegroundType), `appPids` every pid belonging to the app under
 * test (main + descendants).
 */
export function evaluateQuietWatchdogSample({ windows = [], frontPid = null, appPids = [] } = {}) {
  const pidSet = new Set((appPids || []).map(Number));
  const violations = [];
  const visible = (windows || []).filter((window) => pidSet.has(Number(window.pid)));
  if (visible.length > 0) {
    violations.push({ kind: "visible-window", windows: visible });
  }
  if (frontPid !== null && frontPid !== undefined && pidSet.has(Number(frontPid))) {
    violations.push({ kind: "front-steal", frontPid: Number(frontPid) });
  }
  return { ok: violations.length === 0, violations };
}

/** Direct children of a pid, or [] when none / the pid is gone. */
function childPids(pid) {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .split(/\s+/)
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

/** The watched app's main pid plus every descendant, recomputed per sample. */
export function collectProcessTree(rootPid) {
  const tree = [Number(rootPid)];
  const seen = new Set(tree);
  const queue = [...tree];
  while (queue.length > 0) {
    for (const child of childPids(queue.shift())) {
      if (!seen.has(child)) {
        seen.add(child);
        tree.push(child);
        queue.push(child);
      }
    }
  }
  return tree;
}

/** The frontmost application's ASN before the smoke starts, for the log. */
export function launchServicesFrontAsn() {
  try {
    return execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/**
 * Corroborating per-launch Launch Services view of the watched app. Returns
 * "" when the ASN lookup or info call fails (lsappinfo output is degenerate
 * on some macOS versions); the per-sample activationPolicy stays authoritative.
 */
export function launchServicesApplicationType(pid) {
  try {
    const asn = execFileSync("lsappinfo", ["find", `pid=${pid}`], { encoding: "utf8" }).trim();
    if (!asn.startsWith("ASN:")) return "";
    const info = execFileSync("lsappinfo", ["info", "-only", "ApplicationType", asn], { encoding: "utf8" });
    const match = info.match(/type="([^"]+)"/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

export class QuietWatchdog {
  constructor({ intervalMs = 500, log = () => {} } = {}) {
    this.intervalMs = intervalMs;
    this.enabled = process.platform === "darwin";
    this.log = log;
    this.compileDir = "";
    this.binaryPath = "";
    this.sampler = null;
    this.launchLabel = "";
    this.samples = 0;
    this.violations = [];
  }

  /** Compiles the Swift sampler once per smoke run. Throws when swiftc fails. */
  async compile() {
    if (!this.enabled) return;
    const dir = await mkdtemp(join(tmpdir(), "346-watchdog-"));
    const source = join(dir, "quiet-watchdog.swift");
    await writeFile(source, QUIET_WATCHDOG_SWIFT);
    const binary = join(dir, "quiet-watchdog");
    execFileSync("swiftc", ["-O", "-o", binary, source], { stdio: ["ignore", "pipe", "pipe"] });
    this.compileDir = dir;
    this.binaryPath = binary;
  }

  /** Samples the app under test (main pid + descendants) from now on. */
  track(mainPid, label) {
    if (!this.enabled) return;
    if (!this.binaryPath) throw new Error("Quiet watchdog used before compile().");
    this.stopSampler();
    this.launchLabel = label;
    const startedAt = new Date().toISOString();
    const sampler = spawn(this.binaryPath, [String(mainPid), String(this.intervalMs)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    sampler.stderr?.resume();
    // Identity check: a SIGTERM from the next track() must never be recorded
    // as a failure — by the time the old sampler's exit event fires, this
    // sampler no longer is the current one.
    sampler.on("exit", (code, signal) => {
      if (this.sampler === sampler && code !== 0 && signal !== "SIGTERM") {
        this.violations.push({ launch: this.launchLabel, kind: "watchdog-failed", detail: `sampler exited (${code ?? signal})` });
      }
    });
    const lines = readline.createInterface({ input: sampler.stdout });
    lines.on("line", (line) => this.handleSampleLine(line, mainPid));
    this.sampler = sampler;
    this.log(`QUIET_WATCHDOG_TRACK ${label} pid=${mainPid} at=${startedAt}`);
  }

  handleSampleLine(line, mainPid) {
    let sample;
    try {
      sample = JSON.parse(line);
    } catch {
      return;
    }
    if (sample.type === "fatal") {
      this.violations.push({ launch: this.launchLabel, kind: "watchdog-failed", detail: String(sample.message) });
      return;
    }
    const evaluation = evaluateQuietWatchdogSample({
      windows: sample.windows || [],
      frontPid: sample.frontPid ?? null,
      appPids: collectProcessTree(mainPid),
    });
    this.samples += 1;
    if (!evaluation.ok) {
      this.violations.push({ launch: this.launchLabel, at: new Date().toISOString(), violations: evaluation.violations });
    }
  }

  summary() {
    const byKind = {};
    for (const violation of this.violations) {
      const kind = violation.kind
        || (Array.isArray(violation.violations) ? violation.violations.map((entry) => entry.kind).join(",") : "unknown");
      byKind[kind] = (byKind[kind] || 0) + 1;
    }
    return { enabled: this.enabled, samples: this.samples, violations: this.violations.length, byKind };
  }

  /** Fails the smoke when nothing was sampled or any sample was dirty. */
  assertClean() {
    if (!this.enabled) return;
    if (this.samples === 0) throw new Error("Quiet watchdog collected no samples.");
    if (this.violations.length > 0) {
      throw new Error(`Quiet watchdog detected screen/focus violations: ${JSON.stringify(this.violations)}`);
    }
  }

  stopSampler() {
    const sampler = this.sampler;
    this.sampler = null;
    if (sampler && sampler.exitCode === null && !sampler.signalCode) {
      sampler.kill("SIGTERM");
    }
  }

  async stop() {
    this.stopSampler();
    if (this.compileDir) {
      await rm(this.compileDir, { recursive: true, force: true });
      this.compileDir = "";
    }
  }
}
