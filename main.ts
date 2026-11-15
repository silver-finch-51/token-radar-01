// Launch Radar: a token-radar-01 entry (Node 22, standard library only, no build step).
//
//   node main.ts [--input <snapshot.json|directory>] [--output <directory>]
//
// The program reads the sealed snapshot (default /input/snapshot.json; outside the grader's
// container MAKEFUN_OUTPUT_DIR stands in for /output), values every pre-token protocol with
// the comparables model in lib/model.ts, and writes into the output directory:
//
//   board.json    the ranked board: one row per protocol, implied value and farm plan each
//   data.js       the dashboard's whole dataset as window.RADAR, so the page needs no network
//   dashboard/    this repository's dashboard, copied as it stands
//   screenshots/  this repository's three screenshots of the page, copied as they stand
//   dossier.json  the judge's dossier, written last with the vendored buildDossier, byte for
//                 byte what the scorer rebuilds from the same output directory
//
// The run is deterministic: nothing in it reads a clock, a random source or the network, so
// two runs over the same snapshot write the same bytes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoDir = fileURLToPath(new URL('.', import.meta.url));

/** The gate's caps, restated so the program refuses before the scorer has to. */
const GATE = {
  text_max_bytes: 65_536,
  screenshots_max: 4,
  screenshot_max_bytes: 524_288,
  dashboard_max_files: 400,
  dashboard_max_bytes: 4_194_304,
  board_max_bytes: 8_388_608,
};

/** A dossier image's name: letters, digits and . _ -, 1 to 128 characters, no leading dot. */
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function fail(message: string): never {
  process.stderr.write(`launch radar: ${message}\n`);
  process.exit(1);
}

/** Read a --flag's value from the arguments, in either --flag value or --flag=value form. */
function flagValue(name: string): string | null {
  const prefix = `--${name}=`;
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i]!;
    if (a === `--${name}` && i + 1 < process.argv.length) return process.argv[i + 1]!;
    if (a.startsWith(prefix)) return a.slice(prefix.length);
  }
  return null;
}

const inputArg = flagValue('input') ?? '/input';
const inputPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputPath)) {
  fail(`no snapshot at ${inputPath}: pass --input <snapshot.json|directory> or mount the sealed snapshot at /input`);
}
const outputDir = flagValue('output') ?? process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

let snapshot;
try {
  snapshot = parseSnapshot(readFileSync(inputPath, 'utf8'));
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
const radar = buildRadar(snapshot!);
const board = radar.rows;
const issue = boardIssue(board, snapshot!);
if (issue !== null) fail(`the model produced a board the gate refuses: ${issue}`);

mkdirSync(outputDir, { recursive: true });

const boardJson = `${JSON.stringify({ rows: board })}\n`;
if (Buffer.byteLength(boardJson, 'utf8') > GATE.board_max_bytes) fail('board.json exceeds the gate size cap');
writeFileSync(join(outputDir, 'board.json'), boardJson);
writeFileSync(join(outputDir, 'data.js'), dataScript(radar));

/** Copy a directory tree of regular files into the output, skipping dot names; returns the files. */
function copyTree(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  const copied: string[] = [];
  const walk = (src: string, dst: string, rel: string): void => {
    mkdirSync(dst, { recursive: true });
    for (const name of readdirSync(src).sort()) {
      if (name.startsWith('.')) continue;
      const s = join(src, name);
      const d = join(dst, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      if (statSync(s).isDirectory()) walk(s, d, r);
      else if (statSync(s).isFile()) {
        copyFileSync(s, d);
        copied.push(r);
      }
    }
  };
  walk(from, to, '');
  return copied;
}

const dashFiles = copyTree(join(repoDir, 'dashboard'), join(outputDir, 'dashboard'));
if (!dashFiles.includes('index.html')) fail('dashboard/ holds no index.html');
if (!dashFiles.some((f) => f.endsWith('.css'))) fail('dashboard/ holds no .css file');
if (!dashFiles.some((f) => f.endsWith('.js'))) fail('dashboard/ holds no .js file');

const shots = copyTree(join(repoDir, 'screenshots'), join(outputDir, 'screenshots'));
if (shots.length < 3 || shots.length > GATE.screenshots_max) {
  fail(`screenshots/ holds ${shots.length} files: hand in 3 or 4, the board, a detail view and a filtered view`);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
}

// Written last, from the finished output directory, exactly as the scorer rebuilds it.
writeFileSync(
  join(outputDir, 'dossier.json'),
  buildDossier(outputDir, {
    text_max_bytes: GATE.text_max_bytes,
    screenshots: { max: GATE.screenshots_max, max_bytes: GATE.screenshot_max_bytes },
    dashboard: { max_files: GATE.dashboard_max_files, max_bytes: GATE.dashboard_max_bytes },
  }),
);

process.stdout.write(
  `launch radar: scanned ${radar.stats.protocols_scanned} protocols, ${radar.stats.pretoken_found} record no token, ` +
    `board of ${radar.stats.board_rows} rows (${radar.stats.watchlist_rows} watchlist, ${radar.stats.early_rows} early), ` +
    `${radar.stats.live_rows} traded comparables\n` +
    `launch radar: wrote board.json, data.js, dashboard/ (${dashFiles.length} files), screenshots/ (${shots.length} images) and dossier.json to ${outputDir}\n`,
);
