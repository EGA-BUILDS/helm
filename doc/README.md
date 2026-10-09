# Helm

A private software execution hub: prepare issues in Linear, launch one through the existing T3 environment, observe progress and preserve notes/history. Planning stays in ChatGPT; code review/testing and Git authorization remain in T3 and repository tools.

## Status
Initial development. Remote starter uses Next.js 16.4.0 and React 19.3.0. Local VM setup has Convex 1.46.0 and a working development health query, but the updated provider production build failed. That local setup has not yet been published. The MVP is not complete.

## Development
Read [HELM_DEVELOPMENT.md](HELM_DEVELOPMENT.md) and AGENTS.md before editing. Owner authorized verified incremental commits directly to main during the personal MVP build; no feature branch/PR required. Main pushes can trigger Vercel. Keep sensitive operations protected and dispatch disabled until their runtime gates pass.

Use Node 24.x and the pinned pnpm version in package.json. After secure environment setup:
```bash
pnpm install --frozen-lockfile
pnpm dev
```

Do not commit env files, tokens, .vercel account files or raw credential-bearing logs. Production backend mapping is separate from personal dev.

## Plan and specifications
- [Linear project](https://linear.app/egawilldoit/project/helm-07d536a4c04f)
- [PRD](docs/PRD.md)
- [TRD](docs/TRD.md)
- [Implementation plan](docs/IMPLEMENTATION_PLAN.md)
- [Ten implementation issues](docs/ISSUES.md)

Start with [EGA-676](docs/issues/EGA-676.md): preserve local setup and fix the Next.js provider prerender error. Then prove hosted T3 integration before building dispatch.

## MVP boundary
Owner login; one project/connections; issue readiness; one isolated issue launch; observed activity/T3 handoff; manual blocker notes; persistent history. No autonomous feature scheduler, parallel-agent UI, Linear writeback, automated merging or shipping tracker.

