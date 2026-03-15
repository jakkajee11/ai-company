#!/usr/bin/env node
/**
 * cli.js
 *
 * Terminal interface สำหรับ AI Software Company
 * รันใน Claude Code ได้เลย:
 *
 *   node src/cli.js
 *   node src/cli.js "Build a REST API for task management"
 *   node src/cli.js --mode simulate "Design a payment service"
 *   node src/cli.js --help
 */

import { createInterface } from 'readline';
import { resolve, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { runSprint } from './sprint.js';
import { AGENTS } from './agents.js';
import { startWebServer, createWebProgressHandler, resetState } from './web-server.js';

// ─── ANSI colors (simple, no deps needed) ──────────────────────────────────────

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  po:      '\x1b[35m',   // magenta
  tl:      '\x1b[32m',   // green
  dev:     '\x1b[34m',   // blue
  qa:      '\x1b[33m',   // yellow
  sys:     '\x1b[36m',   // cyan
  success: '\x1b[32m',
  warn:    '\x1b[33m',
  error:   '\x1b[31m',
  gray:    '\x1b[90m',
  white:   '\x1b[37m',
  bgPo:    '\x1b[45m',   // magenta bg
  bgTl:    '\x1b[42m',   // green bg
  bgDev:   '\x1b[44m',   // blue bg
  bgQa:    '\x1b[43m',   // yellow bg
};

const AGENT_COLORS = { po: C.po, tl: C.tl, dev: C.dev, qa: C.qa };
const AGENT_BG_COLORS = { po: C.bgPo, tl: C.bgTl, dev: C.bgDev, qa: C.bgQa };

// ─── Progress Bar System ────────────────────────────────────────────────────────

const PHASES = ['po', 'tl', 'dev', 'qa'];
const PHASE_LABELS = { po: 'Product Owner', tl: 'Tech Lead', dev: 'Developer', qa: 'QA Engineer' };
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

let progressState = {
  currentPhase: null,
  phaseStartTime: null,
  sprintStartTime: null,
  spinnerInterval: null,
  spinnerFrame: 0,
  isThinking: false,
};

function startProgressBar() {
  progressState.sprintStartTime = Date.now();
  renderProgressBar();
}

function stopProgressBar() {
  if (progressState.spinnerInterval) {
    clearInterval(progressState.spinnerInterval);
    progressState.spinnerInterval = null;
  }
}

function renderProgressBar() {
  const { currentPhase, isThinking, spinnerFrame } = progressState;
  const lines = [];

  // Build progress bar
  const barWidth = 20;
  const currentIndex = currentPhase ? PHASES.indexOf(currentPhase) : -1;

  lines.push('');
  lines.push(`${C.dim}┌${'─'.repeat(60)}┐${C.reset}`);
  lines.push(`${C.dim}│${C.reset}  Sprint Progress                                              ${C.dim}│${C.reset}`);

  // Progress bar line
  let barLine = `${C.dim}│${C.reset}  `;
  PHASES.forEach((phase, i) => {
    const isActive = phase === currentPhase;
    const isDone = currentIndex > i || (currentIndex === i && !isThinking);
    const color = AGENT_COLORS[phase];
    const bgColor = AGENT_BG_COLORS[phase];
    const label = phase.toUpperCase();

    if (isDone) {
      barLine += `${bgColor}${C.white}${C.bold} ✓ ${label} ${C.reset} `;
    } else if (isActive) {
      const spinner = isThinking ? SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length] : '●';
      barLine += `${bgColor}${C.white}${C.bold} ${spinner} ${label} ${C.reset} `;
    } else {
      barLine += `${C.dim} ○ ${label} ${C.reset} `;
    }
  });
  barLine = barLine.padEnd(61) + `${C.dim}│${C.reset}`;
  lines.push(barLine);

  // Current phase info
  if (currentPhase) {
    const phaseLabel = PHASE_LABELS[currentPhase];
    const color = AGENT_COLORS[currentPhase];
    const elapsed = progressState.phaseStartTime ? Math.round((Date.now() - progressState.phaseStartTime) / 1000) : 0;
    const totalElapsed = Math.round((Date.now() - progressState.sprintStartTime) / 1000);
    const status = isThinking ? 'working...' : 'complete';

    lines.push(`${C.dim}│${C.reset}                                                              ${C.dim}│${C.reset}`);
    lines.push(`${C.dim}│${C.reset}  ${color}${C.bold}${phaseLabel}${C.reset} — ${status.padEnd(20)} ${C.gray}Phase: ${elapsed}s | Total: ${totalElapsed}s${C.reset}`.padEnd(61) + `${C.dim}│${C.reset}`);
  }

  lines.push(`${C.dim}└${'─'.repeat(60)}┘${C.reset}`);
  lines.push('');

  // Move cursor up and reprint
  const output = lines.join('\n');
  process.stdout.write(`\x1b[${lines.length}A${output}`);
}

function updateProgressPhase(agent, isThinking = true) {
  const prevPhase = progressState.currentPhase;
  const changed = prevPhase !== agent;

  // Clear previous spinner interval if phase changed
  if (changed && progressState.spinnerInterval) {
    clearInterval(progressState.spinnerInterval);
    progressState.spinnerInterval = null;
  }

  progressState.currentPhase = agent;
  progressState.isThinking = isThinking;

  if (changed) {
    progressState.phaseStartTime = Date.now();
  }

  // Start spinner animation if thinking
  if (isThinking && !progressState.spinnerInterval) {
    progressState.spinnerInterval = setInterval(() => {
      progressState.spinnerFrame++;
      renderProgressBar();
    }, 80);
  } else if (!isThinking && progressState.spinnerInterval) {
    clearInterval(progressState.spinnerInterval);
    progressState.spinnerInterval = null;
  }

  renderProgressBar();
}

// ─── CLI entrypoint ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // Parse flags
  let mode = 'execute';
  let requirement = '';
  let prdFile = '';
  let webMode = false;
  let webPort = 3456;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode' || args[i] === '-m') {
      mode = args[++i] || 'execute';
    } else if (args[i] === '--prd' || args[i] === '-p') {
      prdFile = args[++i] || '';
    } else if (args[i] === '--web' || args[i] === '-w') {
      webMode = true;
      // Check if next arg is a port number
      const nextArg = args[i + 1];
      if (nextArg && /^\d+$/.test(nextArg)) {
        webPort = parseInt(nextArg, 10);
        i++;
      }
    } else if (!args[i].startsWith('-')) {
      requirement = args.slice(i).join(' ');
      break;
    }
  }

  printBanner();

  // Interactive mode if no requirement given
  if (!requirement) {
    requirement = await promptRequirement();
    if (!mode || mode === 'execute') {
      mode = await promptMode();
    }
  }

  // Load PRD file content
  let prdContent = '';
  if (prdFile && existsSync(prdFile)) {
    prdContent = readFileSync(prdFile, 'utf8').slice(0, 2000);
    print('sys', `PRD loaded: ${prdFile}`);
  }

  const fullRequirement = prdContent
    ? `${requirement}\n\nContext from PRD:\n${prdContent}`
    : requirement;

  // Output directory
  const projectSlug = requirement
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40);
  const outputDir = resolve(`output/${projectSlug}`);
  const projectDir = join(outputDir, 'project');

  print('sys', `Mode: ${C.bold}${mode}${C.reset}`);
  print('sys', `Output: ${C.gray}${outputDir}${C.reset}`);

  // ── Start web server if --web flag ────────────────────────────────────────────
  let webProgressHandler = null;
  if (webMode) {
    print('sys', `Dashboard: ${C.sys}http://localhost:${webPort}${C.reset}`);
    console.log();

    try {
      await startWebServer(webPort);
      resetState(fullRequirement, mode);
      webProgressHandler = createWebProgressHandler();
    } catch (err) {
      console.error(`${C.warn}Warning: Could not start web server: ${err.message}${C.reset}`);
      console.error(`${C.gray}Continuing without web dashboard...${C.reset}`);
      webMode = false;
    }
  } else {
    console.log();
  }

  // ── Run sprint ────────────────────────────────────────────────────────────────
  try {
    await runSprint(fullRequirement, {
      mode,
      projectDir,
      outputDir,
      onProgress: (event) => {
        // Terminal progress
        handleProgress(event);
        // Web dashboard progress
        if (webProgressHandler) {
          webProgressHandler(event);
        }
      },
    });
  } catch (err) {
    console.error(`\n${C.error}✗ Sprint failed: ${err.message}${C.reset}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

// ─── Progress handler ──────────────────────────────────────────────────────────

let currentAgent = null;
let outputBuffer = {};
let progressBarLines = 0;

function handleProgress(event) {
  switch (event.type) {

    case 'sprint:start': {
      // Print initial progress bar with empty lines for placeholder
      console.log('\n\n\n\n\n\n\n\n');
      startProgressBar();
      break;
    }

    case 'phase': {
      // Update progress bar to show current agent working
      updateProgressPhase(event.agent, true);

      // Also print phase header below progress bar
      const color = AGENT_COLORS[event.agent] || C.sys;
      const ag = AGENTS[event.agent];
      console.log();
      console.log(`${color}${C.bold}── ${ag?.name || event.agent}: ${event.phase} ${'─'.repeat(Math.max(0, 50 - event.phase.length))}${C.reset}`);
      currentAgent = event.agent;
      break;
    }

    case 'output': {
      // Mark phase as complete in progress bar
      updateProgressPhase(event.agent, false);

      const color = AGENT_COLORS[event.agent] || C.sys;
      const lines = event.content.split('\n');
      lines.forEach(line => {
        console.log(`  ${color}│${C.reset} ${line}`);
      });
      outputBuffer[event.agent] = event.content;
      break;
    }

    case 'log': {
      const color = AGENT_COLORS[event.agent?.toLowerCase()] || C.gray;
      const time = event.timestamp?.slice(11, 19) || '';
      const decision = event.decision
        ? `\n    ${C.gray}→ ${event.decision}${C.reset}`
        : '';
      // Only show log entries that aren't redundant with phase headers
      if (event.decision) {
        console.log(`  ${C.gray}${time}${C.reset} ${color}${event.agent}${C.reset}${C.gray}: ${event.message}${C.reset}${decision}`);
      }
      break;
    }

    case 'kanban': {
      const colSymbol = { backlog: '○', inProgress: '◎', review: '◑', done: '●' };
      const sym = colSymbol[event.column] || '·';
      if (event.title) {
        console.log(`  ${C.gray}${sym} [${event.column}] ${event.id}: ${event.title}${C.reset}`);
      }
      break;
    }

    case 'done': {
      stopProgressBar();

      const { sprint } = event;
      const duration = sprint.completedAt
        ? Math.round((new Date(sprint.completedAt) - new Date(sprint.startedAt)) / 1000)
        : '?';

      // Print completion summary
      console.log();
      console.log(`${C.success}${C.bold}✓ Sprint complete${C.reset} ${C.gray}(${duration}s)${C.reset}`);
      console.log();

      // Visual summary bar
      const done = sprint.kanban.done?.length || 0;
      const total = Object.values(sprint.kanban).flat().length;
      const percent = total > 0 ? Math.round((done / total) * 100) : 0;
      const filledBar = '█'.repeat(Math.round(percent / 5));
      const emptyBar = '░'.repeat(20 - filledBar.length);

      console.log(`  ${C.dim}Tasks Complete${C.reset}`);
      console.log(`  ${C.success}${filledBar}${C.dim}${emptyBar}${C.reset} ${percent}% (${done}/${total})`);
      console.log();
      console.log(`  Mode:    ${sprint.mode}`);
      console.log(`  Output:  ${C.sys}${sprint.mode === 'execute' ? 'output/project/' : 'output/'}${C.reset}`);
      console.log(`  Log:     ${C.sys}output/sprint-log.md${C.reset}`);

      if (sprint.mode === 'execute') {
        console.log();
        console.log(`${C.gray}Next steps:${C.reset}`);
        console.log(`  cd output/project`);
        console.log(`  npm install`);
        console.log(`  npm test`);
      }
      console.log();
      break;
    }
  }
}

// ─── Interactive prompts ────────────────────────────────────────────────────────

function promptRequirement() {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log(`${C.bold}What would you like to build?${C.reset}`);
    console.log(`${C.gray}Examples:${C.reset}`);
    console.log(`  ${C.gray}• Build a REST API for task management with JWT auth${C.reset}`);
    console.log(`  ${C.gray}• Create a real-time chat service with WebSocket${C.reset}`);
    console.log(`  ${C.gray}• Design a payment integration module with Stripe${C.reset}`);
    console.log();
    rl.question('Requirement: ', answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function promptMode() {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    console.log();
    console.log(`${C.bold}Select mode:${C.reset}`);
    console.log(`  ${C.bold}1${C.reset} execute   — Claude Code writes real files ${C.gray}(default)${C.reset}`);
    console.log(`  ${C.bold}2${C.reset} simulate  — plan only, no files written`);
    console.log(`  ${C.bold}3${C.reset} both      — simulate first, then execute`);
    console.log();
    rl.question('Mode [1]: ', answer => {
      rl.close();
      const map = { '1': 'execute', '2': 'simulate', '3': 'both', '': 'execute' };
      resolve(map[answer.trim()] || 'execute');
    });
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function print(agentKey, msg) {
  const color = AGENT_COLORS[agentKey] || C.sys;
  const name = AGENTS[agentKey]?.name || 'System';
  console.log(`${color}[${name}]${C.reset} ${msg}`);
}

function printBanner() {
  console.log();
  console.log(`${C.bold}  AI Software Company${C.reset}  ${C.gray}Claude Code Edition${C.reset}`);
  console.log(`  ${C.gray}PO → TL → DEV (Claude Code) → QA${C.reset}`);
  console.log();
}

function printHelp() {
  console.log(`
${C.bold}ai-company${C.reset} — AI Agile team with Claude Code as Developer

${C.bold}Usage:${C.reset}
  node src/cli.js                                    interactive
  node src/cli.js "requirement"                      run immediately
  node src/cli.js --mode simulate "requirement"      simulation only
  node src/cli.js --mode execute  "requirement"      full implementation
  node src/cli.js --mode both     "requirement"      simulate then execute
  node src/cli.js --prd file.md   "requirement"      include PRD context
  node src/cli.js --web           "requirement"      with web dashboard
  node src/cli.js --web 8080      "requirement"      web on custom port

${C.bold}Modes:${C.reset}
  execute    PO+TL plan → Claude Code writes real files → QA tests  ${C.gray}(default)${C.reset}
  simulate   All agents describe plans, no files written
  both       Simulate first, then run execute phase

${C.bold}Web Dashboard:${C.reset}
  --web      Start real-time web dashboard at http://localhost:3456
  --web PORT Start dashboard on custom port

${C.bold}Output:${C.reset}
  output/<slug>/project/    Generated source files (execute mode)
  output/<slug>/project/__tests__/  QA test file
  output/<slug>/sprint-log.md       Full sprint log in Markdown
  output/<slug>/sprint-log.json     Machine-readable log

${C.bold}Environment:${C.reset}
  ANTHROPIC_API_KEY    Required — used by PO, TL, QA agents and fallback DEV

${C.bold}Examples:${C.reset}
  node src/cli.js "Build JWT auth API"
  node src/cli.js -m simulate "Design microservice architecture"
  node src/cli.js -m execute -p requirements.md "Build payment service"
  node src/cli.js --web "Build REST API"          # with dashboard
  node src/cli.js --web 8888 "Build REST API"     # custom port
`);
}

// ─── Run ───────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error(`${C.error}Fatal: ${err.message}${C.reset}`);
  process.exit(1);
});
