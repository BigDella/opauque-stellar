#!/usr/bin/env bash
# validate-workflow-scripts.sh — CI gate that catches `npm run <script>`
# references in GitHub Actions workflows whose target package.json lacks
# that script.  Prevents the class of bug where a workflow references a
# script that was never added (see: audit:supply-chain, test:a11y).
#
# Usage:  ./scripts/validate-workflow-scripts.sh
# Exit 0 = all referenced scripts exist; exit 1 = at least one missing.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

node -e '
const fs = require("fs");
const path = require("path");

const repoRoot = process.argv[1];
const workflowDir = path.join(repoRoot, ".github/workflows");

const workflowFiles = fs.readdirSync(workflowDir)
  .filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))
  .map(f => path.join(workflowDir, f));

let errors = 0;

function validateActionPins(lines, relFile) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*#/.test(line)) continue;
    const match = line.match(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/);
    if (!match || match[1].startsWith("./")) continue;
    const [, reference] = match[1].split("@");
    if (!reference || !/^[a-f0-9]{40}$/i.test(reference)) {
      console.error(`ERROR: ${relFile}:${index + 1} uses an action that is not pinned to a full commit SHA: ${match[1]}`);
      errors++;
      continue;
    }
    if (!/#\s+(?:v?\d|master|stable)\b/.test(line)) {
      console.error(`ERROR: ${relFile}:${index + 1} action pin is missing its version comment: ${match[1]}`);
      errors++;
    }
  }
}

for (const file of workflowFiles) {
  const content = fs.readFileSync(file, "utf8");
  const relFile = path.relative(repoRoot, file);
  const lines = content.split("\n");
  validateActionPins(lines, relFile);

  // Parse steps: group consecutive lines that belong to the same step.
  // A step starts with a line matching /^\s+- (name|run|uses):/.
  // All lines until the next step start (at the same or lesser indent) belong to the current step.
  let currentStepLines = [];
  let stepStartIndent = -1;

  function flushStep() {
    if (currentStepLines.length === 0) return;
    processStep(currentStepLines, relFile);
    currentStepLines = [];
    stepStartIndent = -1;
  }

  function processStep(stepLines, relFile) {
    // Find working-directory and all npm run invocations in this step
    let workingDir = null;
    for (const { line, lineNum } of stepLines) {
      const wdMatch = line.match(/^\s+working-directory:\s+(\S+)/);
      if (wdMatch) workingDir = wdMatch[1];
    }

    for (const { line, lineNum } of stepLines) {
      if (/^\s*#/.test(line)) continue;
      const match = line.match(/npm\s+run\s+([a-zA-Z0-9:_@.\/-]+)/);
      if (!match) continue;

      const scriptName = match[1];

      // --prefix overrides working-directory
      const prefixMatch = line.match(/--prefix\s+(\S+)/);
      let pkgJsonPath;
      if (prefixMatch) {
        pkgJsonPath = path.join(repoRoot, prefixMatch[1], "package.json");
      } else if (workingDir) {
        pkgJsonPath = path.join(repoRoot, workingDir, "package.json");
      } else {
        pkgJsonPath = path.join(repoRoot, "package.json");
      }

      if (!fs.existsSync(pkgJsonPath)) {
        console.error(`ERROR: ${relFile}:${lineNum} references npm run ${scriptName} but ${path.relative(repoRoot, pkgJsonPath)} does not exist`);
        errors++;
        continue;
      }

      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
      if (!pkg.scripts || !pkg.scripts[scriptName]) {
        console.error(`ERROR: ${relFile}:${lineNum} runs "npm run ${scriptName}" but it is not defined in ${path.relative(repoRoot, pkgJsonPath)}`);
        errors++;
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Detect step boundaries: lines like "      - name:" or "      - run:" or "      - uses:"
    const stepBoundary = line.match(/^(\s*)-\s+(name|run|uses):/);
    if (stepBoundary) {
      const indent = stepBoundary[1].length;
      if (stepStartIndent === -1) {
        stepStartIndent = indent;
      }
      if (indent === stepStartIndent) {
        flushStep();
      }
    }
    currentStepLines.push({ line, lineNum: i + 1 });
  }
  flushStep();
}

if (errors > 0) {
  console.error(`\nFound ${errors} undefined script(s) referenced in workflows.`);
  console.error("Add the missing scripts to the relevant package.json or fix the workflow.");
  process.exit(1);
}

console.log("All npm run scripts referenced in workflows are defined.");
' "$REPO_ROOT"
