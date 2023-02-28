#!/usr/bin/env node
/**
 * Copyright 2018 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
// @ts-check

const debug = require('debug');
const pptr = require('puppeteer-core');
const os = require('os');
const path = require('path');
const fs = require('fs');
const {spawn, fork} = require('child_process');
const readline = require('readline');
const rimraf = require('rimraf');

const downloadDir = path.join(os.tmpdir(), 'bisect-chrome');
const browserFetcher = new pptr.BrowserFetcher({
  path: downloadDir,
  useMacOSARMBinary: true,
});

const COLOR_RESET = '\x1b[0m';
const COLOR_RED = '\x1b[31m';
const COLOR_GREEN = '\x1b[32m';
const COLOR_YELLOW = '\x1b[33m';

const argv = require('minimist')(process.argv.slice(2), {});
const defaultMinimumRevision = 305043;
// 305043 breaks macos because 64 bit
// 493957 breaks puppeteer because Browser.getVersion

const help = `
Usage:
  npx bisect-chrome [--manual] [--good <revision>] [--bad <revision>] [--shell <shell script>] [<script>]

Parameters:
  --manual  manually respond with "good" or "bad" instead of running script
  --good    revision that is known to be GOOD
  --bad     revision that is known to be BAD
  --shell   a shell script to run instead of a script path
  <script>  path to a node script or executable that returns a non-zero code for BAD and 0 for GOOD

Example:
  npx bisect-chrome --good 577361 --bad 599821 simple.js
  npx bisect-chrome --good 577361 --bad 599821 --shell "npm run ctest"
  npx bisect-chrome --manual --good 577361 --bad 599821

Note: the script exposes Chromium executable path as \`CRPATH\` environment variabble.

Use https://omahaproxy.appspot.com/ to find revisions.
`;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});
const promptAsync = (question) => new Promise(resolve => rl.question(question, resolve));

(async () => {
  if (argv.h || argv.help) {
    console.log(help);
    process.exit(0);
  }

  const maxRevision = await lastRevision();
  const getRevisionArgument = (name, defaultValue) => {
    if (!(name in argv))
      return defaultValue;
    if (typeof argv[name] !== 'number') {
      console.log(COLOR_RED + `ERROR: expected --${name} argument to be a number` + COLOR_RESET);
      console.log(help);
      process.exit(1);
    }
    if (argv[name] <= defaultMinimumRevision) {
      console.log(COLOR_RED + `ERROR: expected --${name} argument to be larger than ${defaultMinimumRevision} ` + COLOR_RESET);
      console.log(help);
      process.exit(1);
    }
    if (argv[name] >= maxRevision) {
      console.log(COLOR_RED + `ERROR: expected --${name} argument to be smaller than ${maxRevision} ` + COLOR_RESET);
      console.log(help);
      process.exit(1);
    }
    return argv[name];
  };
  const good = getRevisionArgument('good', defaultMinimumRevision);
  const bad = getRevisionArgument('bad', maxRevision);
  const isManual = !!argv['manual'];
  const shellCmd = argv['shell'];

  const scriptPath = argv._[0] ? path.resolve(argv._[0]) : path.join(__dirname, 'default.js');
  if (!isManual && !fs.existsSync(scriptPath)) {
    console.log(COLOR_RED + 'ERROR: Expected to be given a path to a script to run' + COLOR_RESET);
    console.log(help);
    process.exit(1);
  }
  await bisect(shellCmd, scriptPath, good, bad, isManual);
})()

async function bisect(shellCmd, scriptPath, good, bad, isManual) {
  const span = Math.abs(good - bad);
  console.log(`Bisecting ${COLOR_YELLOW}${span}${COLOR_RESET} revisions in ${COLOR_YELLOW}~${span.toString(2).length}${COLOR_RESET} iterations`);

  while (true) {
    const middle = Math.round((good + bad) / 2);
    const revision = await findDownloadableRevision(middle, good, bad);
    if (!revision || revision === good || revision === bad)
      break;
    const shouldRemove = !browserFetcher.revisionInfo(revision).local;
    const info = await downloadRevision(revision);
    if (!info) {
      console.log(COLOR_RED + 'ERROR: Failed to download revision' + COLOR_RESET);
      process.exit(1);
    }
    let exitCode = undefined;
    if (isManual) {
      console.log(`CRPATH='${info.executablePath}'`);
      while (exitCode === undefined) {
        const answer = (await promptAsync('Was it good? (g)ood/(b)ad: ')).trim().toLowerCase();
        if (answer === 'g' || answer === 'good')
          exitCode = 0;
        else if (answer === 'b' || answer === 'bad')
          exitCode = 1;
        else
          console.log(`unknown response - "${answer}". Expected one of good/bad`);
      }
    } else {
      const env = {
        ...process.env,
        CRPATH: info.executablePath,
        PUPPETEER_EXECUTABLE_PATH: info.executablePath,
      };
      exitCode = await runScript(shellCmd, scriptPath, env);
    }
    if (shouldRemove)
      await browserFetcher.remove(revision);
    let outcome;
    if (exitCode) {
      bad = revision;
      outcome = COLOR_RED + 'BAD' + COLOR_RESET;
    } else {
      good = revision;
      outcome = COLOR_GREEN + 'GOOD' + COLOR_RESET;
    }
    const span = Math.abs(good - bad);
    let fromText = '';
    let toText = '';
    if (good < bad) {
      fromText = COLOR_GREEN + good + COLOR_RESET;
      toText = COLOR_RED + bad + COLOR_RESET;
    } else {
      fromText = COLOR_RED + bad + COLOR_RESET;
      toText = COLOR_GREEN + good + COLOR_RESET;
    }
    console.log(`- ${COLOR_YELLOW}r${revision}${COLOR_RESET} was ${outcome}. Bisecting [${fromText}, ${toText}] - ${COLOR_YELLOW}${span}${COLOR_RESET} revisions and ${COLOR_YELLOW}~${span.toString(2).length}${COLOR_RESET} iterations`);
  }

  const [fromSha, toSha] = await Promise.all([
    revisionToSha(Math.min(good, bad)),
    revisionToSha(Math.max(good, bad)),
  ]);
  console.log(`RANGE: https://chromium.googlesource.com/chromium/src/+log/${fromSha}..${toSha}`);
}

function runScript(shellCmd, scriptPath, env) {
  const log = debug('bisect:runscript');
  log('Running script');
  let child;
  if (shellCmd) {
    child = spawn(shellCmd, {
      stdio: 'inherit',
      shell: true,
      env,
    });
  } else {
    if (scriptPath.endsWith('.js'))
      child = fork(scriptPath, [], { stdio: 'inherit', env })
    else
      child = spawn(scriptPath, [], { stdio: 'inherit', env })
  }
  return new Promise((resolve, reject) => {
    child.on('error', err => reject(err));
    child.on('exit', code => resolve(code));
  });
}

async function downloadRevision(revision) {
  const log = debug('bisect:download');
  log(`Downloading ${revision}`);
  let progressBar = null;
  let lastDownloadedBytes = 0;
  return await browserFetcher.download(revision, (downloadedBytes, totalBytes) => {
    if (!progressBar) {
      const ProgressBar = require('progress');
      progressBar = new ProgressBar(`- downloading Chromium r${revision} - ${toMegabytes(totalBytes)} [:bar] :percent :etas `, {
        complete: '=',
        incomplete: ' ',
        width: 20,
        total: totalBytes,
      });
    }
    const delta = downloadedBytes - lastDownloadedBytes;
    lastDownloadedBytes = downloadedBytes;
    progressBar.tick(delta);
  });
  function toMegabytes(bytes) {
    const mb = bytes / 1024 / 1024;
    return `${Math.round(mb * 10) / 10} Mb`;
  }
}

async function findDownloadableRevision(rev, from, to) {
  const log = debug('bisect:findrev');
  const min = Math.min(from, to);
  const max = Math.max(from, to);
  log(`Looking around ${rev} from [${min}, ${max}]`);
  if (await browserFetcher.canDownload(rev))
    return rev;
  let down = rev;
  let up = rev;
  while (min <= down || up <= max) {
    const [downOk, upOk] = await Promise.all([
      down > min ? probe(--down) : Promise.resolve(false),
      up < max ? probe(++up) : Promise.resolve(false),
    ]);
    if (downOk)
      return down;
    if (upOk)
      return up;
  }
  return null;

  async function probe(rev) {
    const result = await browserFetcher.canDownload(rev);
    log(`  ${rev} - ${result ? 'OK' : 'missing'}`);
    return result;
  }
}

async function revisionToSha(revision) {
  const json = await fetchJSON('https://cr-rev.appspot.com/_ah/api/crrev/v1/redirect/' + revision);
  return json.git_sha;
}

async function lastRevision() {
  const revision = await fetchJSON('https://www.googleapis.com/download/storage/v1/b/chromium-browser-snapshots/o/Linux_x64%2FLAST_CHANGE?alt=media');
  return revision;
}

/**
 * @param {string} url
 * @return {!Promise<!Object>}
 */
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const agent = url.startsWith('https://') ? require('https') : require('http');
    const req = agent.request(url, {
      headers: {
        'Content-Type': 'application/json'
      }
    }, (res) => {
      let result = '';
      res.setEncoding('utf8');
      res.on('data', chunk => result += chunk);
      res.on('end', () => resolve(JSON.parse(result)));
    });
    req.on('error', err => reject(err));
    req.end();
  });
}
