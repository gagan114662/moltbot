---
name: bug-bounty
description: "Automated bug bounty hunting swarm. Runs security scans against authorized programs on HackerOne/Bugcrowd, generates vulnerability reports, and tracks submissions. ONLY targets authorized programs with explicit scope."
---

# Bug Bounty Swarm

Automated security scanning and vulnerability reporting for authorized bug bounty programs. The swarm coordinates multiple specialized agents to find and report security vulnerabilities.

## Architecture

```
Bug Bounty Controller (you)
├── 1. Program Scout — find high-value programs
├── 2. Recon Agent — enumerate attack surface
├── 3. Web Scanner — find vulnerabilities
└── 4. Report Writer — generate submission-ready reports
```

## When to Use

- User asks to "find bug bounties", "scan for vulnerabilities", "hunt bugs"
- Scheduled cron job targeting new programs
- Revenue optimizer identifies high-payout programs

## Safety Rules (MANDATORY)

1. **ONLY scan targets listed in the program's scope** — never scan out-of-scope assets
2. **Check excluded scope** — many programs exclude staging, internal APIs, etc.
3. **Respect rate limits** — don't DoS the target (use --rate-limit flags)
4. **Run in Docker sandbox** — every scan runs in `moltbot/sandbox-kali` container
5. **Log everything** — all scans logged to engagement results directory
6. **No destructive testing** — no data modification, no account takeover, no file uploads unless explicitly in scope

## Step 1: Program Scout

Find high-value bug bounty programs to target.

```bash
# Research HackerOne programs via their public directory
# Look for: high bounties, broad scope, low competition
parallel-cli research run "Find bug bounty programs on HackerOne that:
1. Have bounty tables paying $1000+ for critical findings
2. Have web application scope (not just mobile)
3. Are actively accepting submissions
4. Have response times under 7 days
List each program with: name, URL, scope summary, bounty range, and response time." \
  --processor pro-fast --json -o /tmp/bounty-programs
```

### Manual Program Research

```bash
# Use browser to check HackerOne directory
# Navigate to: https://hackerone.com/directory/programs
# Filter: bounties enabled, type: web, response efficiency: good
```

### Program Selection Criteria

| Factor           | Weight | Good Signal                                      |
| ---------------- | ------ | ------------------------------------------------ |
| Bounty range     | 30%    | $1K+ critical, $500+ high                        |
| Scope breadth    | 25%    | Multiple domains, APIs, web apps                 |
| Response time    | 20%    | < 7 days to triage                               |
| Competition      | 15%    | < 100 reports in last 90 days                    |
| Tech stack match | 10%    | PHP, Node.js, Python, Java (known vuln patterns) |

## Step 2: Recon Agent

Enumerate the attack surface for a selected program.

```bash
# Create a security sandbox engagement
# Use tool: security_sandbox with action: create_engagement
# target_scope: [domains from program scope]
# tools: ["subfinder", "httpx", "nmap", "amass"]

# Step 2a: Subdomain enumeration
# security_sandbox action: run_scan
# scan_tool: subfinder
# scan_target: target.com

# Step 2b: HTTP probing — which subdomains are alive?
# security_sandbox action: run_scan
# scan_tool: httpx
# scan_target: target.com

# Step 2c: Port scanning on discovered hosts
# security_sandbox action: run_scan
# scan_tool: nmap
# scan_target: discovered-host.target.com
# scan_args: "-sV -sC --top-ports 1000"
```

### Recon Output Format

```json
{
  "target": "target.com",
  "subdomains": ["api.target.com", "admin.target.com", "staging.target.com"],
  "live_hosts": [
    { "host": "api.target.com", "status": 200, "tech": ["nginx", "node.js"] },
    { "host": "admin.target.com", "status": 403, "tech": ["apache", "php"] }
  ],
  "open_ports": [{ "host": "api.target.com", "ports": [80, 443, 8080] }],
  "attack_surface_score": 7.5
}
```

## Step 3: Web Scanner

Run vulnerability scans against discovered attack surface.

```bash
# Step 3a: Nuclei — YAML-based vulnerability scanning (fast, broad coverage)
# security_sandbox action: run_scan
# scan_tool: nuclei
# scan_target: api.target.com
# scan_args: "-severity critical,high,medium"

# Step 3b: SQLMap — SQL injection testing on discovered endpoints
# security_sandbox action: run_scan
# scan_tool: sqlmap
# scan_target: "https://api.target.com/endpoint?param=test"
# scan_args: "--batch --level=3 --risk=2"

# Step 3c: Nikto — web server misconfiguration scanning
# security_sandbox action: run_scan
# scan_tool: nikto
# scan_target: api.target.com

# Step 3d: Directory bruteforcing
# security_sandbox action: run_scan
# scan_tool: ffuf
# scan_target: api.target.com
```

### Vulnerability Classification

| Severity | CVSS     | Examples                                 | Bounty Range |
| -------- | -------- | ---------------------------------------- | ------------ |
| Critical | 9.0-10.0 | RCE, SQLi with data access, auth bypass  | $3K-20K      |
| High     | 7.0-8.9  | Stored XSS, IDOR with PII access, SSRF   | $1K-5K       |
| Medium   | 4.0-6.9  | Reflected XSS, info disclosure, CSRF     | $200-1K      |
| Low      | 0.1-3.9  | Self-XSS, minor info leak, best practice | $50-200      |

## Step 4: Report Writer

Generate HackerOne-quality vulnerability reports.

### Report Template

```markdown
## Title

[Vulnerability Type] in [Component] allows [Impact]

## Summary

A [vulnerability type] vulnerability was discovered in [component/endpoint].
An attacker can exploit this to [impact description].

## Severity

**CVSS Score:** [X.X] ([Critical/High/Medium/Low])
**CVSS Vector:** [vector string]

## Steps to Reproduce

1. Navigate to [URL]
2. [Detailed step]
3. [Detailed step]
4. Observe [vulnerable behavior]

### Proof of Concept
```

[curl command or HTTP request that demonstrates the vulnerability]

```

## Impact

[Describe what an attacker could achieve]
- [Specific impact 1]
- [Specific impact 2]

## Suggested Remediation

[How to fix the vulnerability]
- [Fix step 1]
- [Fix step 2]

## Supporting Material

- [Screenshot/evidence file names]
- [Additional technical details]
```

### Report Quality Checklist

- [ ] Clear, descriptive title
- [ ] Accurate severity/CVSS rating
- [ ] Reproducible steps (anyone can follow them)
- [ ] Working PoC (curl commands preferred)
- [ ] Impact statement (business impact, not just technical)
- [ ] Remediation suggestions
- [ ] No duplicate — check existing reports first

## Full Workflow Example

```
1. Run Program Scout → select "Acme Corp" (scope: *.acme.com, bounty: $500-$10K)

2. Create engagement:
   security_sandbox action: create_engagement
   target_scope: ["acme.com"]
   tools: ["subfinder", "httpx", "nmap", "nuclei", "sqlmap"]

3. Run recon:
   subfinder → found 15 subdomains
   httpx → 8 are alive
   nmap → api.acme.com has port 8080 open (unusual)

4. Run scans:
   nuclei on api.acme.com → found: exposed .git directory (medium)
   sqlmap on api.acme.com/search?q=test → confirmed SQL injection (critical!)

5. Write report:
   Title: "SQL Injection in /search endpoint allows database extraction"
   CVSS: 9.8 (Critical)
   Steps: curl command demonstrating the injection
   Impact: Full database read access including user PII

6. Log revenue:
   revenue_tracker action: log_revenue
   type: bounty
   division: security_swarm
   amount_usd: 5000
   agent_chain: ["program-scout", "recon-subfinder", "sqlmap-agent", "report-writer"]
   program: "HackerOne/acme-corp"

7. Destroy engagement:
   security_sandbox action: destroy_engagement
```

## Testing (Before Live Targets)

Test the swarm against authorized practice targets:

1. **scanme.nmap.org** — NMAP's official test target
2. **testhtml5.vulnweb.com** — Acunetix test site
3. **juice-shop.herokuapp.com** — OWASP Juice Shop
4. **HackTheBox** — Legal CTF platform

## Revenue Tracking

Every bounty payment flows through the revenue tracker:

- `revenue_tracker action: log_revenue` with `type: bounty`
- Agent chain captures attribution for all contributing agents
- Payment via PayPal (vandan@getfoolish.com) or platform payout

## Error Recovery

| Error             | Recovery                                                         |
| ----------------- | ---------------------------------------------------------------- |
| Container timeout | Increase `max_duration_seconds`, split target into smaller scans |
| Tool crashes      | Check container logs, restart with different tool flags          |
| Out-of-scope scan | STOP immediately, verify scope, adjust `target_scope`            |
| Duplicate finding | Check program's existing reports before submission               |
| Rate limited      | Add delays between scans, use `--rate-limit` flags               |
