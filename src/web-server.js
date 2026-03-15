/**
 * web-server.js
 *
 * Real-time web dashboard for AI Software Company
 * Run with: node src/web-server.js
 * Or with sprint: node src/cli.js --web "requirement"
 */

import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── State Management ────────────────────────────────────────────────────────

// สร้าง phases เริ่มต้น — dev agents จะถูกเพิ่มแบบ dynamic เมื่อได้รับ team:setup
function makeInitialPhases() {
  return {
    po: { status: 'pending', output: '', startTime: null, duration: 0, name: 'Product Owner' },
    tl: { status: 'pending', output: '', startTime: null, duration: 0, name: 'Tech Lead' },
    // dev agents และ QA agents จะถูกเพิ่มแบบ dynamic ผ่าน team:setup และ qa-team:setup
  };
}

let sprintState = {
  status: 'idle',
  requirement: '',
  mode: 'execute',
  startedAt: null,
  completedAt: null,
  currentPhase: null,
  devAgents: [],
  reviewerAgents: [],
  qaAgents: [],
  phaseOrder: ['po', 'tl'],  // dev → reviewer → QA agents insert แบบ dynamic
  phases: makeInitialPhases(),
  kanban: { backlog: [], inProgress: [], review: [], blocked: [], done: [] },
  logs: [],
  connectedClients: 0,
};

let wss = null;
let httpServer = null;

// ─── WebSocket Server ────────────────────────────────────────────────────────

export function startWebServer(port = 3456) {
  return new Promise((resolve) => {
    httpServer = createServer(handleHTTPRequest);

    wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', (ws) => {
      sprintState.connectedClients = wss.clients.size;
      broadcast({ type: 'client:count', count: sprintState.connectedClients });

      // Send current state to new client
      ws.send(JSON.stringify({ type: 'state:full', state: sprintState }));

      ws.on('close', () => {
        sprintState.connectedClients = wss.clients.size;
        broadcast({ type: 'client:count', count: sprintState.connectedClients });
      });
    });

    httpServer.listen(port, () => {
      console.log(`\n  Dashboard: http://localhost:${port}\n`);
      resolve({ port, broadcast, resetState });
    });
  });
}

// ─── HTTP Handler ─────────────────────────────────────────────────────────────

function handleHTTPRequest(req, res) {
  const url = req.url === '/' ? '/dashboard.html' : req.url;

  // API endpoint for current state
  if (url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sprintState));
    return;
  }

  // Serve static files
  const filePath = join(__dirname, 'web', url);
  if (existsSync(filePath)) {
    const ext = filePath.split('.').pop();
    const contentTypes = {
      html: 'text/html',
      css: 'text/css',
      js: 'application/javascript',
      json: 'application/json',
    };
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    res.end(readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// ─── Broadcast ───────────────────────────────────────────────────────────────

function broadcast(message) {
  const data = JSON.stringify(message);
  wss?.clients.forEach((client) => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(data);
    }
  });
}

// ─── State Management for Sprint ──────────────────────────────────────────────

export function resetState(requirement, mode) {
  sprintState = {
    status: 'idle',
    requirement: requirement || '',
    mode: mode || 'execute',
    startedAt: null,
    completedAt: null,
    currentPhase: null,
    devAgents: [],
    reviewerAgents: [],
    qaAgents: [],
    phaseOrder: ['po', 'tl'],
    phases: makeInitialPhases(),
    kanban: { backlog: [], inProgress: [], review: [], blocked: [], done: [] },
    logs: [],
    connectedClients: sprintState.connectedClients,
  };
  broadcast({ type: 'state:full', state: sprintState });
}

// ─── Progress Handler for Sprint Integration ─────────────────────────────────

export function createWebProgressHandler() {
  return (event) => {
    switch (event.type) {
      case 'sprint:start':
        sprintState.status = 'running';
        sprintState.startedAt = new Date().toISOString();
        broadcast({ type: 'state:start', state: sprintState });
        break;

      case 'team:setup': {
        // dev agents เพิ่มหลัง tl ใน phaseOrder
        sprintState.devAgents = event.devAgents;
        event.devAgents.forEach(({ key, name }) => {
          if (!sprintState.phases[key]) {
            sprintState.phases[key] = { status: 'pending', output: '', startTime: null, duration: 0, name };
            sprintState.phaseOrder.push(key);
          }
        });
        broadcast({ type: 'team:setup', devAgents: event.devAgents, state: sprintState });
        break;
      }

      case 'reviewer-team:setup': {
        // Reviewer agents เพิ่มหลัง dev agents ใน phaseOrder
        sprintState.reviewerAgents = event.reviewerAgents;
        event.reviewerAgents.forEach(({ key, name }) => {
          if (!sprintState.phases[key]) {
            sprintState.phases[key] = {
              status: 'pending', output: '', startTime: null, duration: 0,
              name, fixRound: 0,
            };
            sprintState.phaseOrder.push(key);
          }
        });
        broadcast({ type: 'reviewer-team:setup', reviewerAgents: event.reviewerAgents, state: sprintState });
        break;
      }

      case 'qa-team:setup': {
        // QA agents เพิ่มต่อท้าย phaseOrder (หลัง reviewer agents)
        sprintState.qaAgents = event.qaAgents;
        event.qaAgents.forEach(({ key, name }) => {
          if (!sprintState.phases[key]) {
            sprintState.phases[key] = { status: 'pending', output: '', startTime: null, duration: 0, name };
            sprintState.phaseOrder.push(key);
          }
        });
        broadcast({ type: 'qa-team:setup', qaAgents: event.qaAgents, state: sprintState });
        break;
      }

      case 'phase': {
        const prevPhase = sprintState.currentPhase;
        if (prevPhase && sprintState.phases[prevPhase] && prevPhase !== event.agent) {
          // Accumulate duration for the phase that was running before (don't overwrite if re-activated)
          const elapsed = Date.now() - (sprintState.phases[prevPhase].startTime || Date.now());
          sprintState.phases[prevPhase].duration =
            (sprintState.phases[prevPhase].duration || 0) + elapsed;
        }

        sprintState.currentPhase = event.agent;

        // auto-create phase entry ถ้าเป็น agent ที่ไม่รู้จัก (ป้องกัน silent skip)
        if (!sprintState.phases[event.agent]) {
          sprintState.phases[event.agent] = {
            status: 'pending', output: '', startTime: null, duration: 0,
            name: event.agent, fixRound: 0,
          };
        }

        // ถ้า phase นี้เคย complete แล้วถูก re-activate (Dev ถูกส่งกลับมาแก้)
        const wasComplete = sprintState.phases[event.agent].status === 'complete';
        if (wasComplete) {
          sprintState.phases[event.agent].fixRound =
            (sprintState.phases[event.agent].fixRound || 0) + 1;
        }

        sprintState.phases[event.agent].status = 'running';
        sprintState.phases[event.agent].startTime = Date.now();
        sprintState.phases[event.agent].currentPhaseLabel = event.phase;

        broadcast({
          type: 'phase:start',
          agent: event.agent,
          phase: event.phase,
          reactivated: wasComplete,
          fixRound: sprintState.phases[event.agent].fixRound,
          state: sprintState,
        });
        break;
      }

      case 'output':
        if (!sprintState.phases[event.agent]) {
          sprintState.phases[event.agent] = { status: 'pending', output: '', startTime: Date.now(), duration: 0, name: event.agent };
        }
        sprintState.phases[event.agent].status = 'complete';
        sprintState.phases[event.agent].output = event.content;
        sprintState.phases[event.agent].duration =
          Date.now() - (sprintState.phases[event.agent].startTime || Date.now());

        broadcast({
          type: 'phase:output',
          agent: event.agent,
          content: event.content,
          state: sprintState,
        });
        break;

      case 'log':
        sprintState.logs.push({
          timestamp: event.timestamp || new Date().toISOString(),
          agent: event.agent,
          message: event.message,
          decision: event.decision,
        });

        broadcast({
          type: 'log',
          entry: {
            timestamp: event.timestamp,
            agent: event.agent,
            message: event.message,
            decision: event.decision,
          },
        });
        break;

      case 'kanban': {
        // Update kanban state
        const { id, column, title, agent } = event;

        // Remove from all columns first
        Object.keys(sprintState.kanban).forEach((col) => {
          sprintState.kanban[col] = sprintState.kanban[col].filter((c) => c.id !== id);
        });

        // Add to new column
        if (column && sprintState.kanban[column]) {
          const existingCard = Object.values(sprintState.kanban)
            .flat()
            .find((c) => c.id === id);
          sprintState.kanban[column].push({
            id,
            title: title || existingCard?.title || '',
            agent: agent || existingCard?.agent || '',
          });
        }

        broadcast({
          type: 'kanban',
          id,
          column,
          title,
          kanban: sprintState.kanban,
        });
        break;
      }

      case 'done':
        sprintState.status = 'complete';
        sprintState.completedAt = event.sprint?.completedAt || new Date().toISOString();

        // Mark any remaining phase durations
        Object.keys(sprintState.phases).forEach((phase) => {
          if (sprintState.phases[phase].status === 'running') {
            sprintState.phases[phase].status = 'complete';
            sprintState.phases[phase].duration =
              Date.now() - (sprintState.phases[phase].startTime || Date.now());
          }
        });

        broadcast({
          type: 'sprint:done',
          sprint: event.sprint,
          state: sprintState,
        });
        break;

      case 'error':
        sprintState.status = 'error';
        broadcast({ type: 'error', error: event.error, state: sprintState });
        break;
    }
  };
}

// ─── Standalone Mode ─────────────────────────────────────────────────────────

async function standalone() {
  const port = process.env.PORT || 3456;
  await startWebServer(port);

  console.log('  Press Ctrl+C to stop');
  console.log('  Waiting for sprint to start...\n');
}

// Run standalone if called directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  standalone().catch(console.error);
}
