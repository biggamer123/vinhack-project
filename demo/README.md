# Inkwell

A small blogging platform, built as the demo repository for Blast Radius. It is sized so every
view has something real to show:

| Where | What to look at |
| --- | --- |
| Graph | `trace`, `recordChange` and `legacyExport` - called everywhere, untested, edited constantly |
| UNUSED chip | `src/utils/deprecated.js`, `LegacyBanner`, `useLocalDrafts`, `weeklyReportV1`, `plainTextFallback` |
| Coverage | `coverage/lcov.info` - format/render/validate fully covered, comments and cache partly, telemetry/audit/legacy not at all |
| Git history | six people, a GitHub-merged PR (noreply email), churn concentrated in a few hotspots |
| Features | commits written as `feature(comments): ...`, `bug fix: ...`, `security(auth): ...` |
| Backups | the `blastradiusbackups` branch, plus resets, stashes and a cherry-pick in the reflog |
| Schemas | `db/migrations/*.sql` (Postgres), `prisma/schema.prisma` (analytics), `src/models/*.model.js` (Mongo) |
| DevOps | `docker-compose.yml` with api, web, mailer (Go), Postgres, Redis, Mongo, nginx and Mailpit |

Layout:

```
src/            Node API (routes, auth, comments, cache, feed, admin, db)
web/            React + TanStack Query frontend
services/mailer Go worker that sends queued email
db/migrations   SQL schema
prisma/         analytics schema
test/           jest tests (coverage/lcov.info is the coverage report)
```

The git history is generated: `npm run setup:demo` in the Blast Radius repository rebuilds it
with `scripts/build-demo.js`.
