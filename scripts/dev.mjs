#!/usr/bin/env node

import { spawn } from 'child_process';
import { watch } from 'chokidar';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = dirname(__dirname);

let appProcess = null;
let isBuilding = false;

function killAppProcess() {
  if (appProcess) {
    console.log('Stopping app...');
    try {
      process.kill(-appProcess.pid, 'SIGTERM');
    } catch {
      appProcess.kill('SIGTERM');
    }
    appProcess = null;
  }
}

function startApp() {
  console.log('Starting app...');
  appProcess = spawn('pnpm', ['start'], {
    stdio: 'inherit',
    cwd: projectRoot,
    detached: true,
    env: { ...process.env },
  });

  appProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.log(`App exited with code ${code}`);
    }
    appProcess = null;
  });
}

async function rebuild() {
  if (isBuilding) {
    console.log('Build already in progress...');
    return;
  }

  isBuilding = true;
  killAppProcess();

  console.log('Building...');
  const buildProcess = spawn('pnpm', ['build'], {
    stdio: 'inherit',
    cwd: projectRoot,
  });

  buildProcess.on('exit', (code) => {
    isBuilding = false;
    if (code === 0) {
      console.log('Build complete');
      startApp();
    } else {
      console.log('Build failed');
    }
  });
}

const watcher = watch(['src', 'config'], {
  cwd: projectRoot,
  ignoreInitial: true,
});

console.log('Watching for changes in src/ and config/...');

let debounceTimer = null;

watcher.on('all', (event, path) => {
  console.log(`${event}: ${path}`);
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(rebuild, 300);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  killAppProcess();
  watcher.close();
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', () => {
  killAppProcess();
  watcher.close();
  process.exit(0);
});

rebuild();
