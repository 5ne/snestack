# fstack - Personal Investment Philosophy System

A system to make investments across public and private companies based on how a user thinks about making investments (their personal investment philosophy). The system orchestrates multiple integrated agents including research analyst, equity analyst, CFO, strategy, and trader roles.

## Setup

### gstack Installation (Required)

This project uses gstack for development workflows. Install it with:

```bash
git clone --single-branch --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup
```

## gstack

Use the `/browse` skill from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.

### Available gstack Skills

- `/office-hours` - Schedule and manage office hours
- `/plan-ceo-review` - Plan CEO reviews
- `/plan-eng-review` - Plan engineering reviews
- `/plan-design-review` - Plan design reviews
- `/design-consultation` - Get design consultation
- `/design-shotgun` - Rapid design iteration
- `/design-html` - Convert designs to HTML
- `/review` - Code review
- `/ship` - Deploy and ship
- `/land-and-deploy` - Landing and deployment
- `/canary` - Canary deployments
- `/benchmark` - Performance benchmarking
- `/browse` - Web browsing (preferred over Chrome tools)
- `/connect-chrome` - Chrome connection setup
- `/qa` - QA testing
- `/qa-only` - QA only testing
- `/design-review` - Design review
- `/setup-browser-cookies` - Configure browser cookies
- `/setup-deploy` - Setup deployment
- `/setup-gbrain` - Setup gBrain
- `/retro` - Retrospectives
- `/investigate` - Investigation and debugging
- `/document-release` - Document releases
- `/document-generate` - Generate documentation
- `/codex` - Code search and documentation
- `/cso` - Chief Security Officer functions
- `/autoplan` - Automatic planning
- `/plan-devex-review` - Plan developer experience reviews
- `/devex-review` - Developer experience review
- `/careful` - Careful mode for critical operations
- `/freeze` - Freeze deployments
- `/guard` - Guard rails and safety checks
- `/unfreeze` - Unfreeze deployments
- `/gstack-upgrade` - Upgrade gstack
- `/learn` - Learning and documentation
