# Any% harness

The open harness behind [Any%](https://anypct.dev), where AI agents play real games start to finish. Minecraft is the first game. Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.

A local benchmark for **planning and tool use** in real Minecraft Java. Every model receives the same structured observations and bounded action tools. A separate referee checks server-owned evidence. The dashboard shows live Minecraft, action traces, telemetry replays, and comparable results.

The first course is a **set-seed sprint**, not full vanilla progression: Java 1.16.5, seed `8398967436125155523`, Survival, Peaceful, empty inventory, and a supplied naturally active End portal. Ten minutes is the time limit. A ten-minute model completion has **not** been demonstrated by this harness. The portal's existence has been checked locally; route and difficulty calibration remain open.

The second course, **speedrun**, uses the documented Java 1.16.1 set-seed speedrun world (seed `2483313382402348964`; human set-seed runs on 1.16.1 finish in under two minutes). A local audit on the official server confirmed a taiga village with beds and an iron golem about 100 blocks from spawn, a ruined portal beside it, and a stronghold about 1,500 blocks away whose End portal has three eyes and **one naturally active portal block** at (1007, 24, 1152); a Survival player standing in it reaches the End. That makes a Peaceful attempt possible without eyes of ender. Its 30-minute cap is exploratory, not a calibrated completion time. The same seed audited on 1.16.5 produced identical structure positions; 1.16.1 is kept because the speedrun community documents it.

## Courses

The full speedrun course measures everything at once, so its dragon fight gets only the last few minutes of a run. **Stage courses** start from the same frozen 1.16.1 world with a fixed start state applied before the clock starts (and before the referee is armed, so setup earns nothing):

| Course | Start | Goal | Cap |
|---|---|---|---|
| `speedrun-dragon` | End arrival platform, entered through the stronghold portal; iron sword and pickaxe, bow and 64 arrows, 64 cobblestone, 6 beds, bread | Kill the dragon and leave through the exit portal | 10 min |
| `speedrun-reentry` | Surface above the stronghold beside a pre-dug one-block shaft (y 77 to the portal at y 24); stone pickaxe, 16 cobblestone, bread | Be alive in the End for 5 s (1.16.1 keeps fall distance through the portal: the full drop kills on arrival) | 8 min |
| `speedrun-overworld` | Spawn, empty inventory | Be alive in the End for 5 s | 20 min |
| `speedrun-nether` | Inside the Nether fortress near the blaze spawner, Easy, iron armour worn, sword, pickaxe, blocks, bread | Hold six blaze rods | 10 min |

Deaths respawn at a stage-specific point (beside the portal, or at the start) so a stage keeps producing data. Harder tiers: `speedrun-normal` (the full course on Normal) and the unpublished-seed courses below. `speedrun-paused` and `speedrun-dragon-paused` are paused-clock variants.

**Score v2.** Every result has `score.value` in [0, 1]: the mean over a course's segments, where a segment reached at time *t* earns `1 − 0.5·t/T` and a segment not reached earns half its partial progress (share of the distance to a landmark closed, dragon health removed, or goal items held). Any checkpoint therefore beats any partial credit, and reaching it sooner scores higher. The leaderboard shows the mean, range and a t-based 95% interval per comparable group; runs recorded before score v2 are rescored from their saved checkpoints and marked as such. Results also report End crystals destroyed (a crystal counts once its pillar is loaded and it is gone) and seconds alive in the End.

## Clocks

On the default **real clock** the world runs while the model thinks. On the **paused clock** (`"clock": "paused"`) the server runs Fabric with Carpet (pinned, checksummed; `tick freeze`) and the world is frozen between tool calls: every mutating action runs to completion or its time slice and returns its result with a fresh observation, `wait` runs the world, and only that game time counts toward the deadline. A wall-clock cap (3× the course time) bounds thinking. Players still tick on a frozen Carpet server, so the harness turns natural regeneration off while frozen (thinking cannot heal; the regeneration timer restarts after each pause) and the controller spaces attacks by course time so short calls cannot beat the cooldown. Burning, drowning and status effects still run during a freeze. The real-clock prompt is unchanged; the paused prompt and tool descriptions explain the blocking contract.

## Quick start

Requirements: Node.js 22+, Java 17, approximately 2 GB heap per Minecraft server, and disk space for preserved worlds. Commands run from this directory. No Docker is required.

```powershell
npm ci
# Only use this flag if you accept https://aka.ms/MinecraftEULA.
npm run bench -- setup --accept-eula
npm run bench -- prepare --scenario sprint
npm run bench -- prepare --scenario speedrun
```

`setup` downloads the official Mojang server and verifies its published SHA-1. `prepare` creates a clean, hashed world snapshot and refuses to overwrite an existing one. In this workspace, setup and the sprint snapshot are already present under ignored `data/`.

Run a model through a chat-completions-compatible endpoint (OpenRouter supports several model families):

```powershell
$env:BENCH_API_KEY = 'YOUR_KEY'
npm run bench -- run --model 'PROVIDER/MODEL_ID' --viewer
```

Set `BENCH_BASE_URL` or pass `--base-url` for another compatible endpoint. This version does not implement native Anthropic Messages or OpenAI Responses adapters. Keys are read from the environment, never from checked-in files or model logs. Provider inference is billed by that provider; no paid requests run during installation or tests.

For an external agent:

```powershell
npm run bench -- run --external --viewer
```

To use an already signed-in Claude Code installation:

```powershell
npm run bench:claude -- --model opus --effort high
npm run bench:claude -- --model claude-opus-5-5 --effort high --scenario speedrun
```

This starts a fresh attempt with the course's deadline and a live viewer. Claude receives only the benchmark's 20 MCP tools: built-in shell, filesystem, browser, and delegation tools are removed. The runner records the resolved model ID and CLI version, disables custom hooks and skills, and uses a fresh working directory. Set `BENCH_CLAUDE` to the native executable path if your installation differs from this machine's npm installation. Authentication stays with Claude Code; no credentials are extracted.

Claude Code runs have their own protocol group because they use its native context management instead of the direct API runner's 24-exchange window. The runner uses the same scenario, action limits, course clock and turn cap. App runs use each app's own output limits (Codex sets none; a 2,048-token cap made Claude Code abort the whole session when one thinking turn ran over it); the per-call output budget applies to the neutral runner. Subscription usage consumes the signed-in account's allowance; any CLI cost estimate is recorded separately from billed cost.

To use an already signed-in Codex CLI (ChatGPT login):

```powershell
npm run bench:codex -- --model gpt-6-astra --effort high --scenario speedrun
npm run bench:codex -- --scenario speedrun --seconds 60 --fixture   # wiring check, never scored
```

Codex runs with `--ignore-user-config` (your other MCP servers and plugins are not loaded), an ephemeral session, a read-only sandbox, web search off, and shell, browser, image, app, plugin, and multi-agent features disabled. The Minecraft server's tools are pre-approved. Any shell, file-change, web-search, or non-Minecraft MCP call ends the run as a configuration error. One difference remains and is recorded in the manifest: this Codex version hides MCP tools unless its code mode is on, and code mode lets the model script several Minecraft tool calls in one turn. Its runtime was audited to have no filesystem, process, or network APIs. Codex reports token usage only when its turn ends, so runs stopped by the deadline have incomplete token counts, and it does not report per-request model calls.

This prints the agent API address and writes its private bearer token to `data/control.json`. The timer begins on the first observation/action, with a three-minute connection window. An external agent can use HTTP or launch the MCP bridge:

```json
{
  "mcpServers": {
    "minecraft-bench": {
      "command": "node",
      "args": ["/path/to/anypct/src/mcp.mjs"]
    }
  }
}
```

The MCP bridge reads the active local connection file. For a remote isolated agent, supply `BENCH_AGENT_URL` and `BENCH_AGENT_TOKEN` explicitly through its environment. The service itself binds to loopback; expose it only through an authenticated tunnel if required.

The three HTTP routes are:

```text
GET  /tools                       Tool schemas and scenario (does not start clock)
GET  /observe                     First call starts the clock
POST /tool                       {"name":"mine","arguments":{"position":[2,71,0]}}
Authorization: Bearer <run token>
```

Mutating tools return an action ID immediately. `observe` and `wait` report the current action and its eventual result. An accepted action is not a completed action. `cancel` stops it before another mutating action is admitted.

## Viewing results

```powershell
npm run ui
```

Dashboard: **http://127.0.0.1:8123**. It is read-only. The Evaluations tab contains model attempts; Test fixtures contains controlled integration tests. No illustrative scores or simulated model victories are inserted.

### 3D replay

```powershell
cd replay; npm install; cd ..   # once: its own package, so the benchmark's dependency hash is unchanged
npm run replay                   # http://127.0.0.1:8124
```

The dashboard's **3D replay** button opens a finished run on port 8124 on the same host. The replay loads the run's final saved world read-only and rewinds it to the replay time by undoing later block changes. Runs recorded since block logging (`block` events: block changes within 48 blocks of the player) rewind exactly; earlier runs rewind only the agent's `mine`, `place`, and `pillar` results. Cameras: chase, first person, overhead. Controls: play/pause (space), ±10 s (arrows), 1–32× speed, and a scrub bar marked with checkpoints and deaths. The HUD shows health, held item, current action, dragon state, and the model's latest message. Visible mobs and the dragon come from the recorded observations, so they appear only when the agent could see them. This is a reconstruction from telemetry, not video.

With `--viewer`, a separate loopback server renders the live bot world using Prismarine Viewer. It never sends clicks or actions to the bot. This is a third-party renderer, not the official client. The stored replay is a time-indexed **telemetry replay**, not a full video or a deterministic re-simulation. For real game footage, see the next section.

### In-game footage

Real Minecraft footage of a run, seen through the bot's eyes with the vanilla HUD, hand, hotbar, menus, chat and toasts:

```powershell
# 1. Record: preload the network recorder into any runner (it only listens; it lives outside src/, so the
#    run keeps the same protocol hash as unrecorded runs). Streams go to data/recordings
#    (or BENCH_RECORD_DIR).
node --import ./record/attach.mjs scripts/run-claude.mjs --scenario speedrun --model claude-opus-5-5 --effort high --no-viewer
# 2. Play it into a real client and capture the window (MP4 in data/footage/<run-id>/,
#    or BENCH_FOOTAGE_DIR; the vanilla client installs into data/client or BENCH_CLIENT_DIR)
node record/play.mjs --run <run-id>            # --from/--to <course seconds> for a clip
```

The recorder (`record/attach.mjs`) writes every packet the bot's client received, unchanged, plus the packets the bot sent. `record/play.mjs` installs a vanilla client of the run's version into `data/client` (or `BENCH_CLIENT_DIR`) (from Mojang, SHA-1 checked; your own `.minecraft` is only read for asset files). It launches the client offline as the bot and serves the recording to it from a local stand-in server. The client therefore receives exactly what the bot received: world, mobs, dragon, boss bar, inventory, health, deaths and respawns. The bot's own actions are replayed from its outgoing packets, because a server never echoes them to the player: movement (driven through the client's own physics, so it stays smoothly interpolated), looking, swings, hotbar changes, dig cracks and closed menus. ffmpeg captures the window with Windows Graphics Capture, then cuts the clip to start `--lead` seconds (default 2) before the course clock. `footage.json` records the timing.

Limits:
- Only 1.16.1 is verified. A 1.16.5 client started offline never connected, probably because 1.16.4+ checks multiplayer permissions with the account.
- The game renders about 30 fps on this laptop, so the 60 fps video repeats frames.
- The capture window sits on top of other windows while it records, but never takes focus.

Artifacts are retained under `data/runs/<run-id>/`:

- `manifest.json`: scenario, snapshot hash, source/dependency hashes, clock/observation rules, model settings.
- `events.jsonl`: actions, observations, referee milestones, model request/response messages, usage, and result.
- `result.json`: outcome, eligibility, completion/death/tick metrics, checks, and persistent evidence.
- `server/world/`: preserved final world and player data for inspection.

The dashboard exports only public run artifacts. It does not serve the private connection file, server RCON password, or arbitrary paths. Event logs include prompts and model outputs; review them before publishing. Nothing is uploaded automatically.

## Community submissions

Runs on the community board are played on the submitter's own machine and uploaded with a screen recording of the whole run. Community courses are the speedrun family on the 1.16.1 set seed: `speedrun`, `speedrun-dragon`, `speedrun-reentry`, `speedrun-overworld` and `speedrun-nether`. `speedrun-paused` and `speedrun-dragon-paused` rank on the paused-clock track. Each system is ranked by its mean score v2 over at least 3 runs that a moderator has approved.

```powershell
$env:BENCH_SITE_URL = 'https://…'          # the community site
$env:BENCH_SUBMIT_TOKEN = 'mbs_…'          # created on your profile page
npm run bench:submit -- --run <run id> --system <your system> --video run.mp4 --dry-run
npm run bench:submit -- --run <run id> --system <your system> --video run.mp4 [--withhold-prompts]
```

Before anything is uploaded, `bench:submit` refuses a run in any of these cases:

- It is a fixture, or its course is not on the community list.
- Its saved score disagrees with the score recomputed from its checkpoints.
- A checkpoint is missing from the event log.
- The video is shorter than the run's wall time.
- The files contain anything that looks like a credential, by pattern or by the value of a `*KEY*`/`*TOKEN*`/`*SECRET*` variable in your environment.

Results from before score v2 are rescored from their checkpoints and marked as rescored. `--withhold-prompts` removes model requests entirely and strips text and reasoning from model responses, keeping usage and the tool calls they made. Tool calls, observations, checkpoints, scores and the video stay public. The publishable files are staged in `data/submissions/<run id>/` (with `--dry-run`, nothing more happens). They are then uploaded in parts, together with the video, as described in `site/API.md`. Games without this harness can be submitted too: anyone can propose a community game, and once an admin approves it, its runs go through the site's upload page. They need the full video plus an agent log in the open format in `community/agent-log.md`, which ties every action to an earlier model response. Their results are entered by that game's moderators and carry a "community" badge. The site runs the same checks (`community/bundle.mjs`) on what it receives, and a moderator compares the video with the event log.

## Neutral harness

`scripts/run-claude.mjs` and `scripts/run-codex.mjs` compare **agent apps**: each app manages context its own way, and Codex can script several tool calls per turn. The **neutral runner** (`npm run bench -- run` / `batch`) gives every model the same prompt, tools, JSON observation messages, 24-exchange history window and output budget through one decision loop, with two provider adapters:

- `"api": "chat-completions"` (default): OpenAI-compatible endpoints (OpenAI, OpenRouter). `maxTokensField` can name `max_completion_tokens` for reasoning models.
- `"api": "anthropic"`: native Messages API. Effort is `output_config.effort`; Claude 5 models think adaptively, and their thinking blocks are passed back unchanged with the tool calls they accompanied. (Anthropic's OpenAI-compatible endpoint ignores `reasoning_effort`, so it cannot match effort.)

`profiles.example.json` holds both models at high effort. Keys come from the environment variable each profile names. Usage records input, cached input, output and reasoning tokens; a profile's `pricing` (USD per million tokens) gives `estimatedCostUsd` when the provider reports no cost. `npm run smoke:neutral` runs the loop against a scripted local model on a real paused-clock server.

## Repeatable comparisons

Copy `profiles.example.json`, replace its model ID, and add model profiles as needed. Each profile can name an environment variable holding its key and provider-specific options. Options cannot replace the shared tools, messages, model, or output-token budget.

```powershell
npm run bench -- batch --profiles profiles.json --repeats 5
npm run bench -- report
```

Trials run round robin and sequentially, each in a fresh copy of the frozen snapshot. Aggregation groups model, course, deadline, and protocol hash. It includes timeouts in the success denominator, separately reports infrastructure failures, and reports Wilson 95% intervals, median successful completion time, and mean route progress. Missing price information stays unknown, never zero. Short `--seconds` runs cannot merge with ten-minute results.

Default budget: 600 wall-clock seconds, 250 provider calls, 2,048 output tokens per call, and the latest 24 complete decision exchanges. Inference and recovery count. API requests stop at the deadline; the world is not accelerated or paused for model thinking. Transient API failures get at most three consecutive attempts, with elapsed time still counted. No failed run is silently retried.

## What the controller does

Tools: `observe`, `move_to`, `move`, `pillar`, `look_at`, `mine`, `place`, `craft`, `recipes`, `open`, `transfer`, `close`, `equip`, `use`, `eat`, `attack`, `smelt`, `respawn`, `wait`, `cancel`.

- Visible blocks and entities within 24 blocks are filtered by line-of-sight raycasts; observations are omnidirectional, not a camera FOV. Useful discovered landmarks persist. Container contents appear only after opening.
- `move_to` uses the pathfinder on loaded collision geometry. It does not automatically mine, build, parkour, or drop more than three blocks. This navigation assistance is shared and disclosed.
- `move` holds movement keys for up to five seconds without pathfinding: face a position, walk in a direction, jump, sprint, or sneak. Walking off a ledge falls with normal fall damage; sneaking stops at edges.
- In the End, `observe` includes `dragon`: boss-bar health whenever the bar is shown, plus the dragon's position, head position, distance, and behaviour (circling, strafing, perched, charging, …) while it is in line of sight at any range. Ordinary entities are still limited to 24 blocks. Breath clouds report their current radius.
- `attack` on the Ender Dragon swings at its nearest visible body part within reach, because vanilla ignores hits on the main dragon entity; the head takes full damage, other parts reduced damage.
- `pillar` jumps and places a block underfoot, up to eight times, to build straight up. Jump-placing needs tick timing that a turn-based model cannot reach through `move` and `place`, so it is one action.
- The model chooses all destinations, recipes, materials, equipment, and combat targets. There is no route script or `kill_dragon` macro.
- One mutating action runs at a time, normally for at most ten seconds. A native operation that will not settle after cancellation faults the controller instead of allowing overlapping actions.
- `wait` lets the world run for up to ten seconds and returns as soon as the running action finishes, so checking on a long action does not cost extra turns.
- `craft.count` means recipe executions, not output-item count. `smelt` starts/collects furnace work; it does not wait for smelting to finish. Bow aiming is explicit via `look_at`, then `use` with a hold duration.

The server admits one unprivileged whitelisted bot. Operator commands and world files are absent from the agent API. Local development processes still share the host filesystem: this is suitable for API-only model evaluation, **not a hardened sandbox for arbitrary adversarial coding agents**. Those need process/container isolation around the same API.

## Victory verification

A small server datapack records the live dragon, its disappearance together with a generated exit portal, and player dimension transitions in private scoreboards. It changes no gameplay rules, health, items, or AI. The supervisor polls these over private RCON. A finish requires, in order and within the wall deadline:

1. A live dragon was observed, then its absence and the naturally generated exit portal.
2. The player changed from the End to the Overworld after the death event.
3. After a clean server save, world NBT confirms `DragonKilled`; player NBT confirms `seenCredits` and Survival mode.

The referee does not trust the model's claims, client disappearance alone, or the kill advancement (which can miss explosion kills). A perched dragon need not enter its flying dying phase, so that phase is recorded only as supplementary evidence. Starting snapshots with a prior dragon kill or seen credits are rejected. The base snapshot stays immutable; its instrumentation is refreshed from the hashed controller source when copied. Polling introduces up to roughly half a second of conservative registration delay at the deadline; late-registered events do not get credit. Snapshot/world generation alone does not make mob AI and network scheduling deterministic.

## Route progress

Success is the primary score. Because most attempts fail, each result also records **route progress**: the share of a course's route checkpoints reached inside the deadline. The route lists only checkpoints every strategy must pass (log, crafting table, pickaxe, the supplied End-portal landmark area, entering the End, damaging the dragon, halving its health, the kill, and the exit). The same datapack records them from server state: item checkpoints from vanilla `inventory_changed` advancements, landmark areas from server-side position selectors (a 33-block column), and dragon damage from the lowest server-side dragon health. Optional items (beds, iron, buckets, flint and steel, blaze rods, pearls, eyes) and the Nether are recorded but never score. Each result also reports the closest server-side distance reached to every supplied landmark, sampled at the referee's 2 Hz poll. Progress never counts as a finish, and runs graded before checkpoints existed are left out of progress averages rather than counted as zero.

Any run labeled `fixture` is permanently ineligible for benchmark success, even when it exercises all positive victory checks. Integration tests use privileged setup only in these isolated fixture worlds.

## Verification and development

```powershell
npm run check
npm test
npm run smoke
# Checkpoint recorders on each course (fixture only):
npm run smoke:milestones -- --scenario speedrun
npm run smoke:milestones -- --scenario sprint
npm run smoke:dragon -- --scenario speedrun
# Stage start states, End time, crystals, endSafe, goal items, score v2, paused clock, eye of ender:
npm run smoke:stages
npm run smoke:neutral
# Map stage needs (portal-room spots, surface, End crystals, Nether spots):
node scripts/audit-stages.mjs --seed 2483313382402348964 --portal=1007,24,1152 --nether=-126,70,171
# Map a seed's structures and End portal in a throwaway world:
npm run audit:seed -- --seed 2483313382402348964 --version 1.16.1
```

The smoke suite starts real servers, verifies gameplay tools and authentication, checks the natural portal, and exercises both positive and negative victory evidence. Its generated wins are **test fixtures**, not model achievements. Unit tests cover ordering, late evidence, cancellation, tool schemas, protocol grouping, and score denominators.

`scenarios/progression.json` is an uncalibrated Normal-difficulty, undisclosed-landmark course. `sprint-turned.json` is a public initial-facing variant. Prepare each separately. These are not a hidden evaluation suite. Before publishing capability rankings, calibrate a reference route, add meaningful held-out resource/route setbacks, freeze those scenarios, and run enough repetitions to estimate uncertainty.

Upstream building blocks: [Mineflayer](https://github.com/PrismarineJS/mineflayer), [Pathfinder](https://github.com/PrismarineJS/mineflayer-pathfinder), [Prismarine Viewer](https://github.com/PrismarineJS/prismarine-viewer). Seed candidate: [rmalde/minecraft-agent](https://github.com/rmalde/minecraft-agent). This project does not copy that agent's route or specialized dragon controller.
