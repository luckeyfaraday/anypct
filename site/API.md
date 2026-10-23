# Submission API

The site is game-neutral: a run belongs to a game (`minecraft` today), and every game-specific rule lives in that game's module under `community/games/` (see `community/games/index.mjs` for the interface). Course ids are unique only within a game. The site never accepts or serves game files: the only uploads are the four bundle files below.

The contract between `npm run bench:submit` (`community/submit.mjs`) and the site. Every `/api` route except `GET /api/courses` needs `Authorization: Bearer <submit token>` (a token created on the profile page, shown once, stored as a SHA-256 hash). Errors are `{"error": "<message for the submitter>"}` with a 4xx status.

## `GET /api/me`

```json
{ "user": { "id": "u_…", "name": "player-k3q7x", "role": "member", "termsAccepted": true,
            "waitlist": { "status": "waiting", "place": 12 } },
  "systems": [ { "slug": "my-agent", "name": "My Agent", "version": 1, "board": "open" } ],
  "terms": { "version": "2026-10-22", "url": "https://…/terms" } }
```

`termsAccepted` is true only when the user has accepted the current `TERMS_VERSION` (`community/bundle.mjs`). `POST /api/runs` refuses with 403 until they have.

`waitlist.status` is `none` (never joined), `waiting` or `admitted`; `place` is the person's position in line while waiting, otherwise `null`. Early access is first come, first served: an admin sets the number of open seats, and people are admitted automatically in signup order. Only admitted testers, moderators and admins can submit. Everyone else gets 403 from `POST /api/runs` and sees the boards read-only.

## `POST /api/runs`

Opens a submission. Body:

```json
{ "game": "minecraft",
  "system": "my-agent",
  "runId": "speedrun-2026-10-20T14-28-39-425Z-50ff25fb",
  "withheld": true,
  "videoSeconds": 1432.6,
  "files": [ { "name": "manifest.json", "size": 2048, "sha256": "…" },
             { "name": "result.json",   "size": 4096, "sha256": "…" },
             { "name": "events.jsonl",  "size": 5242880, "sha256": "…" },
             { "name": "video.mp4",     "size": 912000000, "sha256": "…" } ] }
```

`files` is exactly the game's declared run files, `filesFor(game, tier)` in `community/bundle.mjs` (Minecraft: `manifest.json`, `result.json`, `events.jsonl`, `video.mp4`; FireRed will add an input log). `videoSeconds` is measured by the CLI with ffprobe, or `null` when ffprobe is missing. `events.jsonl` is the version that will be published (already withheld when `withheld` is true). `game` must be a registered game and must match the uploaded manifest (`manifest.game`, or `minecraft` when absent). Course, clock, score, model and the start-state hash (`startStateHash`: a world snapshot for Minecraft, a savestate for later games) are read by the site from the uploaded files, never from this body.

Responses: `201 { "id": "r_…", "partSize": 52428800, "url": "https://…/runs/r_…" }`; `409` when this user already submitted `runId`; `400` for a malformed body or a system that isn't theirs.

## `PUT /api/runs/:id/files/:name/parts/:n`

Raw bytes of part `n` (from 1), each exactly `partSize` except the last. The site writes them to R2 as a multipart upload under `runs/<id>/<name>`. Response: `{ "partNumber": n, "etag": "…" }`.

## `POST /api/runs/:id/complete`

Body: `{ "parts": { "<name>": [ { "partNumber": 1, "etag": "…" } ] } }`. The site completes each multipart upload, checks every size and the SHA-256 of the three JSON files, then runs `checkBundle` from `community/bundle.mjs` (which hands game-specific checks and scoring to the game's module) and `findSecrets` over `events.jsonl`. It rejects a `video.mp4` whose bytes 4–8 are not `ftyp`. It also checks that `videoSeconds` covers the run's wall time (the game module's `wallMs(result)`) minus 5 s.

Response: `{ "id": "r_…", "status": "pending" | "rejected", "score": 0.2831, "rescored": false, "reasons": [], "url": "…" }`. A rejected run keeps its reasons; a pending run waits for a moderator.

## `GET /api/courses`

Public: approved games and their categories, read from the `games` and `categories` tables. Optionally filtered with `?game=minecraft`:

```json
{ "games": [ { "id": "minecraft", "name": "Minecraft", "tier": "official" } ],
  "courses": [ { "game": "minecraft", "id": "speedrun-dragon-paused", "course": "speedrun-dragon", "clock": "paused" } ],
  "terms": "2026-10-22" }
```

`id` is the course as the game's harness names it; `course` and `clock` are the board it ranks on. Boards are keyed by game, course, clock and board.

## Two tiers

Games are rows in a `games` table, each with a `disclaimer` shown on its pages (no affiliation with the publisher; official games take it from their module): `tier` is `official` (a module in `community/games/`, seeded with its courses as categories, runs rechecked by the module) or `community` (proposed by a user, live once an admin approves it). Each game has categories (`game`, `slug`, `name`, `rules` markdown, `goal`, `timing`: `score` | `time` | `custom`, `better`: `higher` | `lower` for custom, `clock`). `runs.game` and `runs.course` reference those rows. A run on a community game carries a "community" badge because nothing rechecks it.

| Tier | Files | Check on complete | Score |
| --- | --- | --- | --- |
| official | The game module's `files` (Minecraft: `manifest.json`, `result.json`, `events.jsonl`, `video.mp4`) | `checkBundle` | Recomputed by the game module |
| community | `COMMUNITY_FILES` (`agent-log.jsonl`, `video.mp4`) | `checkCommunityBundle` (`community/agent-log.md`: valid log, model and scaffold disclosed, every action traced to a model response, credential scan, video covers the run) | Entered by a moderator of that game when approving |

`POST /api/runs` for a community game takes `"game"`, `"category"` and `"files"` with exactly `COMMUNITY_FILES`. The web upload page uses the same three run routes with the session cookie instead of a bearer token. It strips withheld prompts in the browser, using `withholdEvent`, before anything is uploaded, so withheld text never reaches the site.

Ranking per category, over at least 3 approved runs of a system: `score` by mean, higher first; `time` by mean, lower first; `custom` by mean in the category's `better` direction.

## Games, categories and moderators

Session-cookie routes (the bearer token works too).

| Route | Who | Body / effect |
| --- | --- | --- |
| `POST /api/games` | Any signed-in member who accepted the terms | `{name, slug, platform, versionNote, description, categories:[…]}` creates a `community` game with `status: proposed` |
| `POST /api/games/:slug/decision` | Admin | `{decision: "approve" \| "reject" \| "archive", reason}` |
| `POST /api/games/:slug/categories` | Admin, that game's moderators, or the proposer while the game is still `proposed` | `{slug, name, rules, goal, timing, better?, clock}` |
| `PATCH /api/games/:slug/categories/:category` | Same | Any of those fields |
| `PUT` / `DELETE /api/games/:slug/moderators/:userId` | Admin | Appoints or removes a moderator for that game |
| `POST /api/runs/:id/decision` | Admin, or a moderator of the run's game | `{decision: "approve" \| "reject", reason, value?}`. `value` (a score in [0, 1], a time in ms, or a custom number) is required to approve a community run and refused on an official one |

Official games can't be proposed, edited or archived through these routes; their categories come from the modules. A moderator can decide runs only in their own games; admins can override any decision.
