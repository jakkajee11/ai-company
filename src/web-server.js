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
  skipRequested: null,  // { agent: 'po' | 'tl' | 'dev-xxx' | ... }
  // Scaffold state
  scaffoldReady: false,
  scaffoldFiles: [],
  devBlocked: true,
  devBlockReason: 'Waiting for Tech Lead to create project structure',
};

let wss = null;
let httpServer = null;
let _sprintStartHandler = null;

// ─── Sprint Handler Registration ─────────────────────────────────────────────

export function setSprintHandler(fn) {
  _sprintStartHandler = fn;
}

// ─── Skip Agent Control ───────────────────────────────────────────────────────

export function isSkipRequested(agentKey) {
  return sprintState.skipRequested?.agent === agentKey;
}

export function clearSkipRequest() {
  sprintState.skipRequested = null;
}

export function requestSkip(agentKey) {
  sprintState.skipRequested = { agent: agentKey, timestamp: Date.now() };
  broadcast({ type: 'skip:requested', agent: agentKey });
}

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

      // Handle incoming messages from client
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'skip:agent' && msg.agent) {
            requestSkip(msg.agent);
          }
        } catch (e) {
          // Ignore invalid messages
        }
      });

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
  // Strip query string / hash so route matching is always clean
  const urlPath = (req.url || '/').split('?')[0].split('#')[0];
  const url = urlPath === '/' ? '/dashboard.html' : urlPath;

  // API endpoint for current state
  if (url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sprintState));
    return;
  }

  // API endpoint to start a sprint from the UI
  if (url === '/api/sprint/start' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { requirement, mode } = JSON.parse(body || '{}');

        if (sprintState.status === 'running') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'A sprint is already running' }));
          return;
        }
        if (!requirement?.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'requirement is required' }));
          return;
        }
        if (!_sprintStartHandler) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Sprint handler not configured' }));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

        // Run sprint asynchronously
        _sprintStartHandler(requirement.trim(), (mode || 'execute')).catch((err) => {
          console.error('Sprint error:', err.message);
          sprintState.status = 'error';
          broadcast({ type: 'error', error: err.message, state: sprintState });
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });
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
    // Scaffold state
    scaffoldReady: false,
    scaffoldFiles: [],
    devBlocked: true,
    devBlockReason: 'Waiting for Tech Lead to create project structure',
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
        // Update kanban state — preserve ALL existing card fields (subtasks, type, etc.)
        const { id, column, title, agent } = event;

        // Find existing card data before removing
        let existingCard = null;
        Object.keys(sprintState.kanban).forEach((col) => {
          const found = sprintState.kanban[col].find((c) => c.id === id);
          if (found) existingCard = found;
        });

        // Remove from all columns
        Object.keys(sprintState.kanban).forEach((col) => {
          sprintState.kanban[col] = sprintState.kanban[col].filter((c) => c.id !== id);
        });

        // Re-insert preserving all existing fields
        if (column && sprintState.kanban[column]) {
          sprintState.kanban[column].push({
            ...(existingCard || {}),   // preserve subtasks, type, assignedDev, etc.
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

      case 'kanban:subtask': {
        // Attach a TL sub-task to a user story card
        const { storyId, subtask } = event;
        const storyCard = Object.values(sprintState.kanban).flat().find(c => c.id === storyId);
        if (storyCard) {
          if (!storyCard.subtasks) storyCard.subtasks = [];
          // Avoid duplicates
          if (!storyCard.subtasks.find(s => s.id === subtask.id)) {
            storyCard.subtasks.push(subtask);
          }
        }
        broadcast({ type: 'kanban:subtask', storyId, subtask, kanban: sprintState.kanban });
        break;
      }

      case 'kanban:dev-assigned': {
        // Record which dev is assigned to a user story (and which sub-task they're working on)
        const { storyId: assignStoryId, devName, taskId } = event;
        const storyCard = Object.values(sprintState.kanban).flat().find(c => c.id === assignStoryId);
        if (storyCard) {
          storyCard.assignedDev = devName;
          // Update sub-task status to in-progress
          const sub = storyCard.subtasks?.find(s => s.id === taskId);
          if (sub) sub.status = 'in-progress';
        }
        broadcast({ type: 'kanban:dev-assigned', storyId: assignStoryId, devName, taskId, kanban: sprintState.kanban });
        break;
      }

      case 'scaffold:created': {
        sprintState.scaffoldReady = event.created;
        sprintState.scaffoldFiles = event.files || [];
        sprintState.devBlocked = !event.created;
        sprintState.devBlockReason = event.created ? null : 'Scaffold creation failed';
        broadcast({
          type: 'scaffold:created',
          files: event.files,
          created: event.created,
          state: sprintState,
        });
        break;
      }

      case 'dev:waiting': {
        sprintState.devBlocked = true;
        sprintState.devBlockReason = event.reason || 'Waiting for project scaffold';
        broadcast({
          type: 'dev:waiting',
          reason: event.reason,
          state: sprintState,
        });
        break;
      }

      case 'dev:unblocked': {
        sprintState.devBlocked = false;
        sprintState.devBlockReason = null;
        sprintState.scaffoldReady = true;
        sprintState.scaffoldFiles = event.scaffoldFiles || [];
        broadcast({
          type: 'dev:unblocked',
          scaffoldFiles: event.scaffoldFiles,
          state: sprintState,
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
