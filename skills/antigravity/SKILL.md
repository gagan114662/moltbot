---
name: antigravity
description: Google Antigravity (Cloud Code Assist) integration for coding, reviewing, and cloud-native development.
metadata: { "openclaw": { "emoji": "🚀", "requires": { "providers": ["google-antigravity"] } } }
---

# Google Antigravity

Google Cloud Code Assist integration for advanced coding workflows.

## Available Models

| Model                                         | Best For                                  |
| --------------------------------------------- | ----------------------------------------- |
| `google-antigravity/claude-opus-4-5-thinking` | Complex reasoning, architecture decisions |
| `google-antigravity/claude-opus-4-5`          | Code review, thorough analysis            |
| `google-antigravity/claude-sonnet-4-5`        | Fast coding, quick iterations             |
| `google-antigravity/gemini-3`                 | Google-native workloads                   |
| `google-antigravity/gemini-2.5-pro`           | Large context, multimodal                 |

## Quick Start

```bash
# Authenticate first
openclaw models auth login --provider google-antigravity --set-default

# Verify
openclaw models list --provider google-antigravity
```

## Feedback Loop Integration

Antigravity models work seamlessly with the feedback loop:

```json
{
  "feedbackLoop": {
    "coder": "google-antigravity/claude-sonnet-4-5",
    "reviewer": "google-antigravity/claude-opus-4-5-thinking",
    "antigravity": {
      "enabled": true,
      "useThinking": true
    }
  }
}
```

## Tool Schema Requirements

When defining custom tools for Antigravity, follow these guardrails:

```typescript
// ✅ GOOD - Simple object with enum for choices
{
  type: "object",
  properties: {
    action: { type: "string", enum: ["create", "update", "delete"] },
    name: { type: "string" }
  },
  required: ["action", "name"]
}

// ❌ BAD - anyOf/oneOf not supported
{
  type: "object",
  properties: {
    value: { anyOf: [{ type: "string" }, { type: "number" }] }  // FAILS!
  }
}
```

**Rules:**

- Use `enum` for string choices (not `anyOf`/`oneOf`)
- Top-level must be `type: "object"` with `properties`
- Avoid property named `format` (reserved keyword)
- Use `Type.Optional()` instead of `| null`

## Google Cloud Best Practices

When working with GCP services:

### IAM & Security

- Use service accounts with minimal permissions
- Enable audit logging
- Use VPC Service Controls for sensitive workloads

### Cost Optimization

- Use committed use discounts for stable workloads
- Enable auto-scaling with appropriate min/max
- Use preemptible/spot VMs for batch processing

### Architecture

- Use Cloud Run for stateless services
- Use Cloud Functions for event-driven logic
- Use Pub/Sub for async communication
- Use Cloud Storage for object storage

## Coding Patterns

### Cloud Run Service

```bash
antigravity code "Create a Cloud Run service that:
- Handles HTTP requests at /api/v1/users
- Uses Cloud SQL PostgreSQL for persistence
- Implements health checks at /health
- Uses Secret Manager for credentials"
```

### Cloud Function

```bash
antigravity code "Create a Cloud Function that:
- Triggers on Pub/Sub message
- Processes JSON payloads
- Writes results to BigQuery
- Handles errors with exponential backoff"
```

### Terraform Infrastructure

```bash
antigravity code "Generate Terraform for:
- VPC with private subnets
- Cloud SQL instance with read replica
- GKE cluster with node auto-provisioning
- Cloud Armor WAF rules"
```

## Review Patterns

### Security Review

```bash
antigravity review "Check this code for:
- IAM permission issues
- Secrets exposure
- SQL injection
- XSS vulnerabilities
- CORS misconfigurations"
```

### Cost Review

```bash
antigravity review "Analyze for cost optimization:
- Resource sizing
- Auto-scaling settings
- Storage class choices
- Network egress patterns"
```

## Usage Limits

Antigravity uses Google Cloud project quotas:

- Requests per minute: varies by model
- Tokens per request: model-dependent
- Check quotas: `gcloud alpha quotas info --service=cloudcode.googleapis.com`

## Troubleshooting

### Auth Failed

```bash
# Re-authenticate
openclaw models auth login --provider google-antigravity

# Check credentials
gcloud auth application-default print-access-token
```

### Quota Exceeded

```bash
# Check quotas
gcloud alpha quotas info --service=cloudcode.googleapis.com

# Request increase
gcloud alpha quotas update --service=cloudcode.googleapis.com
```

### Model Not Found

```bash
# List available models
openclaw models list --provider google-antigravity

# Check project settings
gcloud services list --enabled | grep cloudcode
```
