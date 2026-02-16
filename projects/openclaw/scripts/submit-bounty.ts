#!/usr/bin/env npx tsx
/**
 * submit-bounty.ts — Submit HackerOne reports autonomously
 *
 * Usage:
 *   npx tsx scripts/submit-bounty.ts <program-handle> <report-file>
 *   npx tsx scripts/submit-bounty.ts 8x8-bounty ~/.openclaw/workspace/evidence/engagements/8x8-recon/HACKERONE-SUBMISSION.md
 *
 * First run: prompts for HackerOne API credentials (stored securely).
 * Subsequent runs: uses stored credentials.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const SECRETS_DIR = path.join(process.env.HOME ?? "/tmp", ".openclaw", "workspace", "secrets");
const CREDS_FILE = path.join(SECRETS_DIR, "hackerone-credentials.json");
const SUBMISSIONS_DIR = path.join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "workspace",
  "integrations",
  "hackerone",
);
const SUBMISSIONS_FILE = path.join(SUBMISSIONS_DIR, "submissions.jsonl");
const REVENUE_FILE = path.join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "workspace",
  "metrics",
  "revenue.jsonl",
);

// --- Credential Management ---

interface Credentials {
  api_identifier: string;
  api_token: string;
}

function loadCredentials(): Credentials | null {
  try {
    return JSON.parse(fs.readFileSync(CREDS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveCredentials(creds: Credentials): void {
  fs.mkdirSync(SECRETS_DIR, { recursive: true });
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
  fs.chmodSync(CREDS_FILE, 0o600);
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function getCredentials(): Promise<Credentials> {
  const existing = loadCredentials();
  if (existing) {
    console.log(`Using stored credentials (${CREDS_FILE})`);
    return existing;
  }

  console.log("\nHackerOne API credentials not found.");
  console.log("Generate them at: https://hackerone.com/settings/api_token/edit\n");

  const api_identifier = await prompt("API Identifier: ");
  const api_token = await prompt("API Token: ");

  if (!api_identifier || !api_token) {
    console.error("Both API Identifier and Token are required.");
    process.exit(1);
  }

  const creds = { api_identifier, api_token };
  saveCredentials(creds);
  console.log(`Credentials saved to ${CREDS_FILE} (mode 600)\n`);
  return creds;
}

// --- Report Parsing ---

interface ParsedReport {
  title: string;
  summary: string;
  impact: string;
  severity: string;
  weakness: string;
  steps: string;
  fix: string;
  full_description: string;
}

function parseReportFile(filePath: string): ParsedReport {
  const content = fs.readFileSync(filePath, "utf-8");
  const sections: Record<string, string> = {};
  let currentSection = "";
  let currentContent: string[] = [];

  for (const line of content.split("\n")) {
    if (line.startsWith("## ")) {
      if (currentSection) {
        sections[currentSection] = currentContent.join("\n").trim();
      }
      currentSection = line.replace("## ", "").trim().toLowerCase();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  if (currentSection) {
    sections[currentSection] = currentContent.join("\n").trim();
  }

  // Extract severity from the severity section
  const severityText = sections["severity"] ?? "";
  let severity = "medium";
  if (/critical/i.test(severityText)) {
    severity = "critical";
  } else if (/high/i.test(severityText)) {
    severity = "high";
  } else if (/medium/i.test(severityText)) {
    severity = "medium";
  } else if (/low/i.test(severityText)) {
    severity = "low";
  }

  // Build full description for HackerOne
  const description = [
    sections["summary"] ?? "",
    "",
    "## Steps to Reproduce",
    sections["steps to reproduce"] ?? "",
    "",
    "## Impact",
    sections["impact"] ?? "",
    "",
    "## Suggested Fix",
    sections["suggested fix"] ?? "",
    "",
    "## Supporting Material",
    sections["supporting material"] ?? "",
    "",
    "## Additional Context",
    sections["additional context"] ?? "",
  ]
    .join("\n")
    .trim();

  return {
    title: sections["title"] ?? "Untitled Report",
    summary: sections["summary"] ?? "",
    impact: sections["impact"] ?? "",
    severity,
    weakness: sections["weakness"] ?? "",
    steps: sections["steps to reproduce"] ?? "",
    fix: sections["suggested fix"] ?? "",
    full_description: description,
  };
}

// --- HackerOne API ---

async function verifyCredentials(creds: Credentials): Promise<boolean> {
  const auth = Buffer.from(`${creds.api_identifier}:${creds.api_token}`).toString("base64");

  const resp = await fetch("https://api.hackerone.com/v1/hackers/me", {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${auth}`,
    },
  });

  if (resp.ok) {
    const data = (await resp.json()) as {
      data?: { attributes?: { username?: string } };
    };
    console.log(`Authenticated as: ${data.data?.attributes?.username ?? "unknown"}`);
    return true;
  }

  console.error(`Auth failed: ${resp.status} ${resp.statusText}`);
  return false;
}

async function submitReport(
  creds: Credentials,
  programHandle: string,
  report: ParsedReport,
): Promise<{ id: string; url: string } | null> {
  const auth = Buffer.from(`${creds.api_identifier}:${creds.api_token}`).toString("base64");

  // Map CWE string to weakness_id if we can extract it
  const cweMatch = report.weakness.match(/CWE-(\d+)/);

  const body: Record<string, unknown> = {
    data: {
      type: "report",
      attributes: {
        team_handle: programHandle,
        title: report.title,
        vulnerability_information: report.full_description,
        impact: report.impact,
        severity_rating: report.severity,
        ...(cweMatch ? { weakness_id: Number.parseInt(cweMatch[1], 10) } : {}),
      },
    },
  };

  console.log(`\nSubmitting to program: ${programHandle}`);
  console.log(`Title: ${report.title}`);
  console.log(`Severity: ${report.severity}`);
  console.log(`Description length: ${report.full_description.length} chars\n`);

  const resp = await fetch("https://api.hackerone.com/v1/hackers/reports", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify(body),
  });

  const data = (await resp.json()) as {
    data?: { id?: string; attributes?: { title?: string; state?: string } };
    errors?: Array<{ title?: string; detail?: string }>;
  };

  if (resp.status === 201 && data.data?.id) {
    const reportId = data.data.id;
    const url = `https://hackerone.com/reports/${reportId}`;
    console.log(`Report submitted successfully!`);
    console.log(`Report ID: ${reportId}`);
    console.log(`URL: ${url}`);
    console.log(`State: ${data.data.attributes?.state ?? "new"}`);
    return { id: reportId, url };
  }

  console.error(`\nSubmission failed: ${resp.status} ${resp.statusText}`);
  if (data.errors) {
    for (const err of data.errors) {
      console.error(`  - ${err.title}: ${err.detail}`);
    }
  } else {
    console.error(JSON.stringify(data, null, 2));
  }
  return null;
}

// --- Logging ---

function logSubmission(
  programHandle: string,
  report: ParsedReport,
  result: { id: string; url: string },
): void {
  // Log to submissions.jsonl
  fs.mkdirSync(SUBMISSIONS_DIR, { recursive: true });
  const entry = {
    timestamp: new Date().toISOString(),
    report_id: result.id,
    program: programHandle,
    title: report.title,
    severity: report.severity,
    status: "submitted",
    hackerone_url: result.url,
  };
  fs.appendFileSync(SUBMISSIONS_FILE, JSON.stringify(entry) + "\n");
  console.log(`\nLogged to ${SUBMISSIONS_FILE}`);

  // Log pending bounty to revenue.jsonl
  const revenueDir = path.dirname(REVENUE_FILE);
  fs.mkdirSync(revenueDir, { recursive: true });
  const revenueEntry = {
    timestamp: new Date().toISOString(),
    type: "bounty_pending",
    division: "bug_bounty",
    platform: "hackerone",
    program: programHandle,
    amount: 0,
    currency: "USD",
    report_id: result.id,
    description: `Submitted: ${report.title}`,
    status: "pending_triage",
  };
  fs.appendFileSync(REVENUE_FILE, JSON.stringify(revenueEntry) + "\n");
  console.log(`Logged pending bounty to ${REVENUE_FILE}`);
}

// --- Main ---

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log("Usage: npx tsx scripts/submit-bounty.ts <program-handle> <report-file>");
    console.log("");
    console.log("Example:");
    console.log(
      "  npx tsx scripts/submit-bounty.ts 8x8-bounty ~/.openclaw/workspace/evidence/engagements/8x8-recon/HACKERONE-SUBMISSION.md",
    );
    process.exit(1);
  }

  const [programHandle, reportFile] = args;
  const resolvedPath = reportFile.startsWith("~")
    ? reportFile.replace("~", process.env.HOME ?? "/tmp")
    : reportFile;

  if (!fs.existsSync(resolvedPath)) {
    console.error(`Report file not found: ${resolvedPath}`);
    process.exit(1);
  }

  // 1. Get credentials
  const creds = await getCredentials();

  // 2. Verify credentials
  console.log("Verifying HackerOne credentials...");
  if (!(await verifyCredentials(creds))) {
    console.error("\nDelete stored credentials and try again:");
    console.error(`  rm ${CREDS_FILE}`);
    process.exit(1);
  }

  // 3. Parse report
  console.log(`\nParsing report: ${resolvedPath}`);
  const report = parseReportFile(resolvedPath);

  // 4. Submit
  const result = await submitReport(creds, programHandle, report);

  if (result) {
    // 5. Log
    logSubmission(programHandle, report, result);
    console.log("\nDone! Your first bounty report is submitted.");
  } else {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
