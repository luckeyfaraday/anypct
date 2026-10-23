// Games on the community board. Each game module default-exports one object with this shape, so the submit
// command and the site never contain game-specific code:
//   id, name                      stable id ('minecraft') and display name
//   disclaimer                    shown on the game's pages: no affiliation with its publisher
//   files                         the run files a submission uploads, always including video.mp4 and
//                                 events.jsonl (the harness log); others are copied from the run directory
//   courses                       [{id, course, clock}]: id as the harness writes it into manifest.scenario.id,
//                                 course and clock as the board it ranks on
//   group(manifest)               -> {course, clock}: the board a run ranks on
//   startStateHash(manifest)      -> hash of the state every run starts from (world snapshot, savestate, …)
//   wallMs(result)                -> wall time the run took, which the video must cover
//   check({manifest,result,events}) -> {reasons, score, rescored}: game-specific checks and the score in [0, 1]
//   timeline(events)              -> [{kind: 'checkpoint'|'death'|'area', ms, label}] for the run page
import minecraft from './minecraft/index.mjs';

export const GAMES={[minecraft.id]:minecraft};

export function getGame(id){
  const game=Object.hasOwn(GAMES,id)?GAMES[id]:null;
  if(!game)throw new Error(`unknown game ${JSON.stringify(id)}`);
  return game;
}
// Minecraft's harness predates the game field, so its manifests have none.
export const gameOf=manifest=>manifest?.game??'minecraft';

export function listCourses(){
  return Object.values(GAMES).flatMap(game=>game.courses.map(c=>({game:game.id,...c})));
}
