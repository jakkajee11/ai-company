/**
 * sprint.js
 *
 * Agile sprint workflow: PO → TL → DEV (Claude Code) → QA
 * Manages state, logging, and Kanban output
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { callAgent, runDevAgent, AGENTS } from './agents.js';

// ─── Sprint runner ─────────────────────────────────────────────────────────────

/**
 * Run a full sprint
 * @param {string} requirement
 * @param {object} opts - { mode, projectDir, outputDir, onProgress }
 */
export async function runSprint(requirement, opts = {}) {
  const {
    mode = 'execute',
    projectDir = resolve('output/project'),
    outputDir = resolve('output'),
    onProgress = () => {},
  } = opts;

  const sprint = {
    id: Date.now(),
    startedAt: new Date().toISOString(),
    requirement,
    mode,
    log: [],
    kanban: {
      backlog: [],
      inProgress: [],
      review: [],
      done: [],
    },
    outputs: {},
  };

  // Notify progress bar to initialize
  onProgress({ type: 'sprint:start', sprint });

  // Helper: log + notify
  const sprintLog = (agentKey, message, decision = null) => {
    const entry = {
      timestamp: new Date().toISOString(),
      agent: AGENTS[agentKey]?.name || agentKey,
      message,
      decision,
    };
    sprint.log.push(entry);
    onProgress({ type: 'log', ...entry });
  };

  const moveCard = (ids, toCol) => {
    ids.forEach(id => {
      Object.keys(sprint.kanban).forEach(col => {
        sprint.kanban[col] = sprint.kanban[col].filter(c => c.id !== id);
      });
      sprint.kanban[toCol].push({ id });
      onProgress({ type: 'kanban', id, column: toCol });
    });
  };

  const addCards = (cards, col) => {
    cards.forEach(c => {
      sprint.kanban[col].push(c);
      onProgress({ type: 'kanban', id: c.id, column: col, title: c.title, agent: c.agent });
    });
  };

  // ── Phase 1: Product Owner ──────────────────────────────────────────────────
  onProgress({ type: 'phase', agent: 'po', phase: 'User Story Planning' });
  sprintLog('po', 'Analyzing requirement and creating user stories',
    'Prioritize by user value and dependency order');

  addCards([
    { id: 'us-0', title: 'Core feature story', agent: 'po' },
    { id: 'us-1', title: 'Auth / access story', agent: 'po' },
    { id: 'us-2', title: 'Error handling story', agent: 'po' },
  ], 'backlog');

  const poOutput = await callAgent('po',
    `Requirement: ${requirement}\nMode: ${mode}`
  );
  sprint.outputs.po = poOutput;
  onProgress({ type: 'output', agent: 'po', content: poOutput });
  sprintLog('po', 'User stories created and backlog populated');

  // ── Phase 2: Tech Lead ──────────────────────────────────────────────────────
  onProgress({ type: 'phase', agent: 'tl', phase: 'Architecture & Task Breakdown' });
  sprintLog('tl', 'Designing architecture and breaking down dev tasks',
    'Chose layered architecture — testable, maintainable, maps well to team tasks');

  addCards([
    { id: 'dev-0', title: 'Core service', agent: 'tl' },
    { id: 'dev-1', title: 'Data layer', agent: 'tl' },
    { id: 'dev-2', title: 'API / interface layer', agent: 'tl' },
  ], 'backlog');

  const tlOutput = await callAgent('tl',
    `Requirement: ${requirement}\n\nUser stories from PO:\n${poOutput}`
  );
  sprint.outputs.tl = tlOutput;
  onProgress({ type: 'output', agent: 'tl', content: tlOutput });
  sprintLog('tl', 'Architecture defined. ADR logged.',
    'See ADR section in output for decision rationale');

  // ── Phase 3: Developer (Claude Code) ────────────────────────────────────────
  onProgress({ type: 'phase', agent: 'dev', phase: mode === 'execute' ? 'Implementation (Claude Code)' : 'Implementation Plan' });
  moveCard(['dev-0', 'dev-1'], 'inProgress');
  sprintLog('dev',
    mode === 'execute'
      ? 'Claude Code subprocess starting — writing files to project directory'
      : 'Planning implementation approach',
    mode === 'execute'
      ? 'Running: claude --print --dangerously-skip-permissions in project dir'
      : 'Simulation mode: no files written'
  );

  const devOutput = await runDevAgent(requirement, tlOutput, projectDir, {
    mode,
    sprintLog,
  });
  sprint.outputs.dev = devOutput;
  onProgress({ type: 'output', agent: 'dev', content: devOutput });
  moveCard(['dev-0', 'dev-1', 'dev-2'], 'review');
  sprintLog('dev', mode === 'execute' ? 'Implementation complete. Files written to project dir.' : 'Plan documented.');

  // ── Phase 4: QA ─────────────────────────────────────────────────────────────
  onProgress({ type: 'phase', agent: 'qa', phase: 'Test Generation' });
  addCards([
    { id: 'qa-0', title: 'Unit + integration tests', agent: 'qa' },
    { id: 'qa-1', title: 'Security edge cases', agent: 'qa' },
  ], 'inProgress');
  sprintLog('qa', 'Generating test suite', 'Coverage: happy path, edge cases, error handling, security');

  const qaOutput = await callAgent('qa',
    `Feature: ${requirement}\n\nArchitecture:\n${tlOutput}\n\nImplementation:\n${devOutput}`
  );
  sprint.outputs.qa = qaOutput;
  onProgress({ type: 'output', agent: 'qa', content: qaOutput });

  // Write test file to project
  if (mode === 'execute' && existsSync(projectDir)) {
    const testDir = join(projectDir, '__tests__');
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, 'sprint.test.js'), qaOutput);
  }

  moveCard(['dev-0', 'dev-1', 'dev-2', 'us-0', 'us-1', 'us-2'], 'done');
  moveCard(['qa-0'], 'done');
  moveCard(['qa-1'], 'review');
  sprintLog('qa', 'Test suite created. Written to __tests__/sprint.test.js');

  // ── Finalize ────────────────────────────────────────────────────────────────
  sprint.completedAt = new Date().toISOString();
  const duration = Math.round(
    (new Date(sprint.completedAt) - new Date(sprint.startedAt)) / 1000
  );
  sprintLog('po', `Sprint complete in ${duration}s`, `Mode: ${mode}. All ${Object.values(sprint.kanban).flat().length} tasks processed.`);

  // Save sprint log
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
  saveSprint(sprint, outputDir);

  onProgress({ type: 'done', sprint });
  return sprint;
}

// ─── Save sprint artifacts ─────────────────────────────────────────────────────

function saveSprint(sprint, outputDir) {
  // JSON
  writeFileSync(
    join(outputDir, 'sprint-log.json'),
    JSON.stringify(sprint, null, 2)
  );

  // Markdown log
  const md = buildMarkdownLog(sprint);
  writeFileSync(join(outputDir, 'sprint-log.md'), md);
}

function buildMarkdownLog(sprint) {
  const lines = [
    `# Sprint Log`,
    ``,
    `- **Started:** ${sprint.startedAt}`,
    `- **Completed:** ${sprint.completedAt || 'In progress'}`,
    `- **Mode:** ${sprint.mode}`,
    `- **Requirement:** ${sprint.requirement}`,
    ``,
    `---`,
    ``,
    `## Product Owner Output`,
    ``,
    sprint.outputs.po || '',
    ``,
    `---`,
    ``,
    `## Tech Lead Output`,
    ``,
    sprint.outputs.tl || '',
    ``,
    `---`,
    ``,
    `## Developer Output`,
    ``,
    sprint.outputs.dev || '',
    ``,
    `---`,
    ``,
    `## QA Output`,
    ``,
    '```javascript',
    sprint.outputs.qa || '',
    '```',
    ``,
    `---`,
    ``,
    `## Activity Log`,
    ``,
    ...sprint.log.map(e => {
      const time = e.timestamp.slice(11, 19);
      const decision = e.decision ? `\n  > Decision: ${e.decision}` : '';
      return `- \`${time}\` **${e.agent}**: ${e.message}${decision}`;
    }),
    ``,
    `---`,
    ``,
    `## Sprint Board (Final State)`,
    ``,
    `| Backlog | In Progress | Review | Done |`,
    `|---------|-------------|--------|------|`,
    buildKanbanTable(sprint.kanban),
  ];
  return lines.join('\n');
}

function buildKanbanTable(kanban) {
  const cols = ['backlog', 'inProgress', 'review', 'done'];
  const maxLen = Math.max(...cols.map(c => kanban[c]?.length || 0));
  if (maxLen === 0) return '| — | — | — | — |';
  return Array.from({ length: maxLen }, (_, i) =>
    `| ${cols.map(c => kanban[c]?.[i]?.id || '').join(' | ')} |`
  ).join('\n');
}
