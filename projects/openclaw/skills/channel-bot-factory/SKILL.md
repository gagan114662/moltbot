---
name: channel-bot-factory
description: "Build and deploy revenue-generating bots across Discord, Telegram, Slack, and other channels. Freemium model with PayPal payments. Scans communities for unmet needs, builds bots from existing skills, deploys and monitors."
---

# Channel Bot Factory

Build, deploy, and manage revenue-generating bots across messaging platforms. Each bot serves a community with a freemium model. The factory breeds new bots based on what works.

## Architecture

```
Channel Bot Factory
├── 1. Community Scanner — find underserved communities
├── 2. Bot Builder — compose from 60+ existing skills
├── 3. Deployer — ship to platform + register
├── 4. Revenue Monitor — track subscriptions, kill losers
└── 5. Optimizer — clone winners to similar communities
```

## When to Use

- User asks to "deploy a bot", "build a Discord/Telegram bot"
- Sensor detects underserved community with bot opportunity
- Revenue optimizer identifies successful bot pattern to clone

## Step 1: Community Scanner

Find communities that need specialized bots.

```bash
# Research communities missing key bot functionality
parallel-cli research run "Find Discord servers and Telegram groups that:
1. Have 1000+ members
2. Are focused on: crypto, gaming, dev tools, cybersecurity, or education
3. Don't have good moderation/utility bots
4. Have active communities (messages daily)
List each with: platform, name/topic, member count, what bot they need." \
  --processor pro-fast --json -o /tmp/community-scan
```

### Opportunity Scoring

| Factor             | Weight | Good Signal                       |
| ------------------ | ------ | --------------------------------- |
| Community size     | 25%    | 1000+ members                     |
| Activity level     | 25%    | Daily messages                    |
| Bot gap            | 30%    | No existing bot for the need      |
| Willingness to pay | 20%    | Premium community or business use |

## Step 2: Bot Builder

Compose a bot from existing Moltbot skills.

### Available Skill Modules (60+)

| Category      | Skills                                  | Bot Use Case                       |
| ------------- | --------------------------------------- | ---------------------------------- |
| Security      | clawdstrike, bug-bounty                 | Security scanning bot              |
| Research      | parallel-deep-research, parallel-search | Research assistant bot             |
| Code          | coding-agent                            | Code review / pair programming bot |
| Health        | healthcheck                             | Server monitoring bot              |
| Media         | camsnap, canvas, video-frames           | Media processing bot               |
| Productivity  | apple-reminders, trello, notion         | Productivity bot                   |
| Communication | summarize                               | Meeting/chat summarizer bot        |

### Bot Template Structure

```
bots/<bot-name>/
├── config.json        # Bot configuration
├── system-prompt.md   # Bot personality and behavior
├── skills.json        # Which skills to compose
└── pricing.json       # Freemium tiers
```

### config.json Template

```json
{
  "name": "SecurityGuard Bot",
  "platform": "discord",
  "description": "Security scanning and monitoring for your server",
  "skills": ["clawdstrike", "healthcheck"],
  "premium_features": ["deep-scan", "scheduled-monitoring", "vulnerability-alerts"],
  "free_features": ["basic-scan", "security-tips"],
  "pricing": {
    "free": { "scans_per_month": 5, "features": ["basic-scan"] },
    "pro": {
      "price_usd": 10,
      "scans_per_month": 100,
      "features": ["deep-scan", "scheduled-monitoring"]
    },
    "enterprise": { "price_usd": 50, "scans_per_month": -1, "features": ["all"] }
  },
  "payment_method": "paypal",
  "payment_email": "vandan@getfoolish.com"
}
```

## Step 3: Deployer

Deploy bot to target platform.

### Discord Bot Deployment

```bash
# 1. Create Discord application at https://discord.com/developers/applications
# 2. Get bot token
# 3. Deploy using existing Discord extension

# The OpenClaw gateway already has Discord support via extensions/discord
# A new bot instance connects through the gateway with its own agent config
```

### Telegram Bot Deployment

```bash
# 1. Create bot via @BotFather on Telegram
# 2. Get bot token
# 3. Deploy using existing Telegram extension (extensions/telegram via grammyjs)

# Telegram supports native payments via Bot Payments API
```

### Deployment Checklist

- [ ] Bot token obtained from platform
- [ ] System prompt configured for community
- [ ] Skills wired and tested
- [ ] Pricing tiers configured
- [ ] Payment link (PayPal) embedded in premium upgrade flow
- [ ] Bot deployed and responding
- [ ] Monitoring active

## Step 4: Revenue Monitor

Track bot performance and revenue.

```bash
# Log subscription revenue
# revenue_tracker action: log_revenue
# type: subscription
# division: channel_bots
# channel: discord
# amount_usd: 10
# description: "SecurityGuard Bot - Pro tier - server: CryptoTraders"
```

### Bot Health Metrics

| Metric            | Healthy | Warning | Kill           |
| ----------------- | ------- | ------- | -------------- |
| Active users/week | 50+     | 10-50   | <10            |
| Commands/day      | 20+     | 5-20    | <5             |
| Revenue/month     | $30+    | $5-30   | $0 for 14 days |
| Error rate        | <5%     | 5-15%   | >15%           |

## Step 5: Optimizer

Clone successful bots, kill failures.

### Clone Strategy

1. Bot earns $30+/month for 30 days → **CLONE** to similar communities
2. Bot earns $0 for 14 days → **KILL** (reclaim compute)
3. Top 10% of bots → analyze what makes them work → template for Factory

### Revenue Targets

| Scale  | Bots | Avg Revenue | Total      |
| ------ | ---- | ----------- | ---------- |
| Seed   | 5    | $20/mo      | $100/mo    |
| Growth | 50   | $25/mo      | $1,250/mo  |
| Scale  | 200  | $30/mo      | $6,000/mo  |
| Empire | 1000 | $30/mo      | $30,000/mo |

## Bot Ideas by Platform

### Discord

- Security scanner for server admins
- Code review bot for dev communities
- Research assistant for study groups
- Moderation + threat detection

### Telegram

- Crypto price alerts + portfolio tracker
- News digest bot (industry-specific)
- Appointment scheduling bot
- Customer support bot for small businesses

### Slack

- DevOps monitoring bridge
- Meeting summarizer
- Competitive intelligence digest
- Onboarding assistant

## Payment Integration

All premium payments go through PayPal:

- **Email:** vandan@getfoolish.com
- **Flow:** Bot sends PayPal.me link → user pays → bot activates premium
- **Verification:** Manual initially, automated via PayPal IPN later

No Stripe. No passwords. No API keys for payment processing.
