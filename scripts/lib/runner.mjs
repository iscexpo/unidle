// Oracle construction, CHECK execution, and EXPECT matching.
// Zero dependencies. Node 16+.

import { spawn } from "node:child_process";
import { Worker } from "node:worker_threads";
import { statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const REGEX_TIMEOUT_MS = 250;
export const DEFAULT_TIMEOUT_SECONDS = 120;

function executableCandidates(name) {
  if (process.platform !== "win32") return [name];
  if (/\.[A-Za-z0-9]+$/.test(name)) return [name];
  const extensions = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [name, ...extensions.map((extension) => name + extension.toLowerCase()), ...extensions.map((extension) => name + extension.toUpperCase())];
}

// Resolve the command shell exactly the way the checker does, so reporting
// and audit tools describe the same execution surface. Throws when unresolvable.
export function resolveShellOrThrow(raw) {
  const requested = raw || process.env.UNIDLE_SHELL || (process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh");
  const containsSeparator = requested.includes("/") || requested.includes("\\") || isAbsolute(requested);
  const candidates = [];
  if (containsSeparator) candidates.push(resolve(process.cwd(), requested));
  else {
    for (const directory of String(process.env.PATH || "").split(delimiter).filter(Boolean)) {
      for (const name of executableCandidates(requested)) candidates.push(join(directory, name));
    }
  }
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* keep looking */ }
  }
  throw new Error("cannot resolve command shell " + JSON.stringify(requested) + " from PATH");
}

// The approval identity hashes this exact object, key order included, so any
// change to its shape re-keys every existing approval by design.
export function createOracle({ shell, timeoutSeconds, pathValue, resolveCwd }) {
  return function oracle(file, gate) {
    return {
      schema: 1,
      check: gate.check,
      expect: gate.expect,
      cwd: resolveCwd(gate, file),
      shell,
      timeoutMs: timeoutSeconds * 1000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      regexTimeoutMs: REGEX_TIMEOUT_MS,
      platform: process.platform,
      path: pathValue,
    };
  };
}

// Matching happens in a disposable worker so catastrophic backtracking
// cannot hang the checker.
export function safeRegexMatch(expectation, output) {
  if (expectation.kind === "text") return Promise.resolve({ matched: output.includes(expectation.value) });
  return new Promise((done) => {
    const worker = new Worker(new URL("./regex-worker.mjs", import.meta.url));
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      done(value);
    };
    const timer = setTimeout(() => finish({ matched: false, error: "EXPECT regex exceeded " + REGEX_TIMEOUT_MS + "ms" }), REGEX_TIMEOUT_MS);
    worker.once("message", (message) => finish(message));
    worker.once("error", (error) => finish({ matched: false, error: error.message }));
    worker.once("exit", (code) => { if (code !== 0) finish({ matched: false, error: "EXPECT worker exited " + code }); });
    worker.postMessage({ source: expectation.source, flags: expectation.flags, output });
  });
}

export function createRunner({ shell, timeoutSeconds }) {
  function runCheck(task) {
    return new Promise((done) => {
      const chunks = { stdout: [], stderr: [] };
      let bytes = 0;
      let overflow = false;
      let timedOut = false;
      let spawnError = null;
      let closed = false;
      let closeStreamsTimer = null;
      let child;

      const stopChild = () => {
        if (closeStreamsTimer) return;
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }
        // A descendant that escaped the shell can otherwise keep inherited pipes
        // open forever. We still settle through the child's close event, after
        // giving stdio a short grace period to drain.
        closeStreamsTimer = setTimeout(() => {
          try { child.stdout.destroy(); } catch { /* closed */ }
          try { child.stderr.destroy(); } catch { /* closed */ }
        }, 1000);
      };

      const capture = (stream, chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const remaining = MAX_OUTPUT_BYTES - bytes;
        if (remaining > 0) chunks[stream].push(buffer.subarray(0, remaining));
        bytes += buffer.length;
        if (bytes > MAX_OUTPUT_BYTES && !overflow) {
          overflow = true;
          stopChild();
        }
      };

      try {
        child = spawn(task.gate.check, {
          cwd: task.cwd,
          shell,
          windowsHide: true,
          detached: process.platform !== "win32",
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        done({ ...task, ok: false, output: "", exitCode: null, signal: null, matched: false, error: error.message });
        return;
      }
      child.stdout.on("data", (chunk) => capture("stdout", chunk));
      child.stderr.on("data", (chunk) => capture("stderr", chunk));
      child.once("error", (error) => { spawnError = error; });
      const timer = setTimeout(() => {
        timedOut = true;
        stopChild();
      }, timeoutSeconds * 1000);
      child.once("close", async (exitCode, signal) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        if (closeStreamsTimer) clearTimeout(closeStreamsTimer);
        const stdout = Buffer.concat(chunks.stdout).toString("utf8");
        const stderr = Buffer.concat(chunks.stderr).toString("utf8");
        const output = stdout + (stdout && stderr ? "\n" : "") + stderr;
        const match = timedOut || overflow || spawnError
          ? { matched: false }
          : await safeRegexMatch(task.gate.expectation, output);
        const error = timedOut ? "timed out after " + timeoutSeconds + "s"
          : overflow ? "output exceeded " + MAX_OUTPUT_BYTES + " bytes"
            : spawnError ? spawnError.message
              : match.error || null;
        done({
          ...task, output, exitCode, signal, matched: Boolean(match.matched), error,
          ok: !error && exitCode === 0 && Boolean(match.matched),
        });
      });
    });
  }

  async function runRolling(tasks, limit) {
    const results = new Array(tasks.length);
    let next = 0;
    async function worker() {
      for (;;) {
        const index = next++;
        if (index >= tasks.length) return;
        results[index] = await runCheck(tasks[index]);
      }
    }
    const workers = [];
    for (let index = 0; index < Math.min(limit, tasks.length); index++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  return { runCheck, runRolling };
}
