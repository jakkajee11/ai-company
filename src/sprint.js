/**
 * sprint.js
 *
 * Agile sprint workflow: PO → TL → DEV (Claude Code) → QA
 * Manages state, logging, and Kanban output
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { callAgent, runDevAgent, runDevAgentForTask, runDevFixForTask, parseQaVerdict, parseReviewerVerdict, AGENTS, STAR_WARS_PERSONAS } from './agents.js';
import { isSkipRequested, clearSkipRequest } from './web-server.js';

// จำนวน dev สูงสุดที่รันพร้อมกันได้ — ตั้งผ่าน MAX_DEVS env var, default = ตามจำนวน tasks
const MAX_PARALLEL_DEVS = parseInt(process.env.MAX_DEVS) || Infinity;

// จำนวนรอบสูงสุดที่ QA ส่งงานกลับให้ Dev แก้ได้ — ตั้งผ่าน MAX_QA_CYCLES env var
const MAX_QA_CYCLES = parseInt(process.env.MAX_QA_CYCLES) || 2;

// จำนวนรอบสูงสุดที่ Reviewer ส่งงานกลับให้ Dev แก้ได้ — ตั้งผ่าน MAX_REVIEW_CYCLES env var
const MAX_REVIEW_CYCLES = parseInt(process.env.MAX_REVIEW_CYCLES) || 2;

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
      blocked: [],  // งานที่ QA ไม่ผ่านหลังครบรอบสูงสุด — รอ human review
      done: [],
    },
    outputs: {},
    reviewCycles: [],     // บันทึกรอบที่ Reviewer ส่งงานกลับ: [{ reviewerKey, devKey, round, issues }]
    fixCycles: [],        // บันทึกรอบที่ QA ส่งงานกลับ: [{ qaKey, devKey, round, issues }]
    needsHumanReview: [], // งานที่ต้องการ human review: [{ task, qaKey, qaRound, file, issues }]
  };

  // Notify progress bar to initialize
  onProgress({ type: 'sprint:start', sprint });

  // ── Agent name map: agentKey → Star Wars character name ──
  // Populated as agents are created; used by sprintLog for display names.
  const agentNames = {
    po: STAR_WARS_PERSONAS.po.character,
    tl: STAR_WARS_PERSONAS.tl.character,
  };

  // Helper: log + notify
  const sprintLog = (agentKey, message, decision = null) => {
    const entry = {
      timestamp: new Date().toISOString(),
      agent: agentNames[agentKey] || AGENTS[agentKey]?.name || agentKey,
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

  let poOutput = '';
  if (isSkipRequested?.('po')) {
    sprintLog('po', '⏭️ Skipped by user');
    clearSkipRequest?.();
    poOutput = '[Skipped by user]';
  } else {
    poOutput = await callAgent('po',
      `Requirement: ${requirement}\nMode: ${mode}`,
      { persona: STAR_WARS_PERSONAS.po.identity }
    );
  }
  sprint.outputs.po = poOutput;
  onProgress({ type: 'output', agent: 'po', content: poOutput });

  // Parse user stories dynamically from PO output
  const userStories = parseUserStories(poOutput);
  addCards(userStories, 'backlog');
  sprintLog('po', `User stories created: ${userStories.length} stories added to backlog`);

  // ── Phase 2: Tech Lead ──────────────────────────────────────────────────────
  onProgress({ type: 'phase', agent: 'tl', phase: 'Architecture & Task Breakdown' });
  sprintLog('tl', 'Designing architecture and breaking down dev tasks',
    'Chose layered architecture — testable, maintainable, maps well to team tasks');

  let tlOutput = '';
  if (isSkipRequested?.('tl')) {
    sprintLog('tl', '⏭️ Skipped by user');
    clearSkipRequest?.();
    tlOutput = '[Skipped by user]';
  } else {
    tlOutput = await callAgent('tl',
      `Requirement: ${requirement}\n\nUser stories from PO:\n${poOutput}`,
      { persona: STAR_WARS_PERSONAS.tl.identity }
    );
  }
  sprint.outputs.tl = tlOutput;
  onProgress({ type: 'output', agent: 'tl', content: tlOutput });
  sprintLog('tl', 'Architecture defined. ADR logged.',
    'See ADR section in output for decision rationale');

  // ── กำหนดทีม Developer จาก TL output ─────────────────────────────────────
  const devTasks = parseDevTasks(tlOutput);
  addCards(devTasks, 'backlog');
  const devTaskIds = devTasks.map(t => t.id);

  // จำนวน dev agents ที่จะ spawn — ไม่เกิน MAX_DEVS และไม่เกินจำนวน tasks จริง
  const numDevs = Math.max(1, Math.min(devTasks.length, MAX_PARALLEL_DEVS));
  const devPersonas = STAR_WARS_PERSONAS.dev;
  const devAgents = devTasks.slice(0, numDevs).map((task, i) => {
    const persona = devPersonas[i % devPersonas.length];
    return {
      key: `dev-${i}`,
      name: persona.character,
      persona,
      task,
    };
  });
  // Register dev names in the name map
  devAgents.forEach(a => { agentNames[a.key] = a.name; });

  // แจ้งทุก layer ให้รู้ว่า team มีกี่คน ก่อนเริ่ม DEV phase
  onProgress({ type: 'team:setup', devAgents });
  sprintLog('tl',
    `Team assembled: ${numDevs} developer${numDevs > 1 ? 's' : ''} running in parallel`,
    devAgents.map(a => a.name).join(', ')
  );

  // ── Phase 3: Developer(s) — parallel ─────────────────────────────────────
  moveCard(devTaskIds.slice(0, numDevs), 'inProgress');

  const devResults = await Promise.all(
    devAgents.map(async ({ key, name, persona, task }) => {
      onProgress({
        type: 'phase',
        agent: key,
        phase: mode === 'execute' ? `Implementing: ${task.title.slice(0, 30)}` : 'Planning implementation',
      });
      sprintLog(key,
        mode === 'execute' ? `Starting: ${task.title}` : `Planning: ${task.title}`,
        mode === 'execute' ? 'Running Claude Code subprocess' : 'Simulation mode'
      );

      // แต่ละ dev ได้ directory ของตัวเอง (ถ้ามีหลาย dev)
      const taskDir = numDevs > 1 ? join(projectDir, key) : projectDir;

      const output = await runDevAgentForTask(task, requirement, tlOutput, taskDir, {
        mode,
        agentKey: key,
        persona: persona?.identity,
        sprintLog: (msg, decision) => sprintLog(key, msg, decision),
      });

      onProgress({ type: 'output', agent: key, content: output });
      sprintLog(key, mode === 'execute' ? 'Implementation complete' : 'Plan documented');
      return { key, task, output, taskDir };
    })
  );

  sprint.outputs.dev = devResults.reduce((acc, { key, output }) => ({ ...acc, [key]: output }), {});
  moveCard(devTaskIds, 'review');

  // ── Phase 4: Code Review — 1 reviewer per dev, parallel ──────────────────────
  const reviewerPersonas = STAR_WARS_PERSONAS.reviewer;
  const reviewerAgents = devResults.map((result, i) => {
    const persona = reviewerPersonas[i % reviewerPersonas.length];
    return {
      key: `reviewer-${i}`,
      name: persona.character,
      persona,
      devResult: result,
    };
  });
  // Register reviewer names
  reviewerAgents.forEach(a => { agentNames[a.key] = a.name; });

  // แจ้งทุก layer ก่อนเริ่ม Review phase
  onProgress({ type: 'reviewer-team:setup', reviewerAgents });
  sprintLog('reviewer',
    `Code review team: ${reviewerAgents.length} reviewer(s) running in parallel`,
    reviewerAgents.map(a => a.name).join(', ')
  );

  // ── Reviewer ↔ Dev feedback loop — each reviewer runs in parallel ────────────
  const reviewResults = await Promise.all(
    reviewerAgents.map(async ({ key: reviewerKey, persona: reviewerPersona, devResult }) => {
      const devKey = devResult.key;
      // Look up dev persona for fix calls
      const devPersonaForReview = devAgents.find(a => a.key === devKey)?.persona;
      let currentDevOutput = devResult.output;
      let reviewOutput = '';
      let verdict = { passed: false, issues: [], notes: '' };
      let reviewRound = 0;

      while (reviewRound <= MAX_REVIEW_CYCLES) {
        reviewRound++;
        const isFirstRound = reviewRound === 1;
        const isFinalRound = reviewRound > MAX_REVIEW_CYCLES;

        // ── Code Review ──
        onProgress({
          type: 'phase',
          agent: reviewerKey,
          phase: isFirstRound
            ? `Reviewing: ${devResult.task.title.slice(0, 30)}`
            : `Re-reviewing (round ${reviewRound}): ${devResult.task.title.slice(0, 22)}`,
        });
        sprintLog(reviewerKey,
          isFirstRound
            ? `Code review: ${devResult.task.title}`
            : `Re-reviewing after fixes (round ${reviewRound}): ${devResult.task.title}`,
          'Checking: requirements, bugs, security, performance, resource management, best practices'
        );

        const reviewContext = mode === 'simulate'
          ? `Feature: ${requirement}\n\nArchitecture:\n${tlOutput}\n\nTask: ${devResult.task.title}\n\nNote: Simulation mode — review the implementation plan.`
          : `Feature: ${requirement}\n\nArchitecture:\n${tlOutput}\n\nTask: ${devResult.task.title}\n\nImplementation:\n${currentDevOutput}`;

        reviewOutput = await callAgent('reviewer', reviewContext, { persona: reviewerPersona?.identity });
        verdict = parseReviewerVerdict(reviewOutput);
        onProgress({ type: 'output', agent: reviewerKey, content: reviewOutput });

        if (verdict.passed) {
          sprintLog(reviewerKey,
            `✓ Review PASSED (round ${reviewRound})`,
            isFirstRound ? 'Code approved — forwarding to QA' : `Approved after ${reviewRound - 1} fix round(s)`
          );
          break;
        }

        // Review FAILED
        sprintLog(reviewerKey,
          `✗ Review FAILED — ${verdict.issues.length} issue(s) found (round ${reviewRound})`,
          verdict.issues.slice(0, 3).join(' | ')
        );

        if (isFinalRound) {
          sprintLog(reviewerKey,
            `⚠ Max review cycles (${MAX_REVIEW_CYCLES}) reached — forwarding to QA with known issues`,
            `Unresolved: ${verdict.issues.length} issue(s)`
          );
          break;
        }

        // ── Send back to Dev for fixes ────────────────────────────────────────
        sprint.reviewCycles.push({ reviewerKey, devKey, round: reviewRound, issues: verdict.issues });

        sprintLog(devKey,
          `Received ${verdict.issues.length} review issue(s) to fix (round ${reviewRound})`,
          verdict.issues.map((issue, i) => `${i + 1}. ${issue}`).join(' | ')
        );

        moveCard([devResult.task.id], 'inProgress');
        onProgress({
          type: 'phase',
          agent: devKey,
          phase: `Fixing review issues (round ${reviewRound}): ${devResult.task.title.slice(0, 20)}`,
        });

        currentDevOutput = await runDevFixForTask(
          devResult.task,
          currentDevOutput,
          verdict.issues,
          devResult.taskDir,
          {
            mode,
            agentKey: devKey,
            persona: devPersonaForReview?.identity,
            sprintLog: (msg, decision) => sprintLog(devKey, msg, decision),
          }
        );

        onProgress({ type: 'output', agent: devKey, content: currentDevOutput });
        sprintLog(devKey,
          `Review fixes applied (round ${reviewRound}) — returning to reviewer`,
          `Fixed ${verdict.issues.length} issue(s)`
        );

        sprint.outputs.dev[devKey] = currentDevOutput;
        moveCard([devResult.task.id], 'review');
      } // end while

      return {
        key: reviewerKey, devResult, reviewOutput, reviewRound,
        passed: verdict.passed, finalDevOutput: currentDevOutput,
      };
    })
  );

  sprint.outputs.review = reviewResults.reduce(
    (acc, { key, reviewOutput }) => ({ ...acc, [key]: reviewOutput }), {}
  );
  sprint.outputs.reviewStats = reviewResults.reduce(
    (acc, { key, reviewRound, passed }) => ({ ...acc, [key]: { rounds: reviewRound, passed } }), {}
  );

  // สร้าง devResults ที่อัพเดตแล้วสำหรับ QA (output อาจเปลี่ยนหลัง review cycles)
  const reviewedDevResults = devResults.map(result => {
    const rr = reviewResults.find(r => r.devResult.key === result.key);
    return (rr && rr.finalDevOutput !== result.output)
      ? { ...result, output: rr.finalDevOutput }
      : result;
  });

  // ── Phase 5: QA — 1 QA per dev, with feedback loop back to Dev ──────────────
  const qaPersonas = STAR_WARS_PERSONAS.qa;
  const qaAgents = reviewedDevResults.map((result, i) => {
    const persona = qaPersonas[i % qaPersonas.length];
    return {
      key: `qa-${i}`,
      name: persona.character,
      persona,
      devResult: result,
    };
  });
  // Register QA names
  qaAgents.forEach(a => { agentNames[a.key] = a.name; });

  // แจ้งทุก layer ก่อนเริ่ม QA phase
  onProgress({ type: 'qa-team:setup', qaAgents });
  sprintLog('qa',
    `QA team assembled: ${qaAgents.length} engineer${qaAgents.length > 1 ? 's' : ''} running in parallel`,
    qaAgents.map(a => a.name).join(', ')
  );

  // Kanban cards สำหรับ QA — 1 test card + 1 security card ต่อ dev
  const qaCards = qaAgents.flatMap(({ key, devResult }) => [
    { id: `${key}-test`, title: `Tests: ${devResult.task.title.slice(0, 28)}`, agent: 'qa' },
    { id: `${key}-sec`,  title: `Security: ${devResult.task.title.slice(0, 24)}`, agent: 'qa' },
  ]);
  addCards(qaCards, 'inProgress');

  // ── QA ↔ Dev feedback loop — each QA agent runs in parallel ─────────────────
  const qaResults = await Promise.all(
    qaAgents.map(async ({ key: qaKey, persona: qaPersona, devResult }) => {
      const devKey = devResult.key;
      // Dev and reviewer personas for fix/re-review calls within this QA loop
      const devPersonaForQa       = devAgents.find(a => a.key === devKey)?.persona;
      const reviewerPersonaForQa  = reviewerAgents.find(a => a.devResult.key === devKey)?.persona;
      let currentDevOutput = devResult.output;
      let qaOutput = '';
      let verdict = { passed: false, issues: [], tests: '' };
      let qaRound = 0;

      // Loop: QA review → (if FAIL) Dev fix → repeat up to MAX_QA_CYCLES fix rounds
      // Total QA reviews = MAX_QA_CYCLES + 1  (e.g. 2 fix cycles = 3 QA reviews)
      while (qaRound <= MAX_QA_CYCLES) {
        qaRound++;
        const isFirstRound = qaRound === 1;
        const isFinalRound = qaRound > MAX_QA_CYCLES;

        // ── QA review ──
        onProgress({
          type: 'phase',
          agent: qaKey,
          phase: isFirstRound
            ? `Testing: ${devResult.task.title.slice(0, 30)}`
            : `Re-testing (round ${qaRound}): ${devResult.task.title.slice(0, 22)}`,
        });
        sprintLog(qaKey,
          isFirstRound
            ? `Testing: ${devResult.task.title}`
            : `Re-testing after fixes (round ${qaRound}): ${devResult.task.title}`,
          'Checking: correctness, error handling, security, code quality'
        );

        const qaContext = mode === 'simulate'
          ? `Feature: ${requirement}\n\nArchitecture:\n${tlOutput}\n\nNote: Simulation mode — write tests based on the architecture plan.`
          : `Feature: ${requirement}\n\nArchitecture:\n${tlOutput}\n\nTask: ${devResult.task.title}\n\nImplementation:\n${currentDevOutput}`;

        qaOutput = await callAgent('qa', qaContext, { persona: qaPersona?.identity });
        verdict = parseQaVerdict(qaOutput);
        onProgress({ type: 'output', agent: qaKey, content: qaOutput });

        if (verdict.passed) {
          sprintLog(qaKey,
            `✓ PASSED (round ${qaRound})`,
            isFirstRound ? 'No issues found' : `Passed after ${qaRound - 1} fix round(s)`
          );
          break; // QA satisfied — exit loop
        }

        // QA FAILED
        sprintLog(qaKey,
          `✗ FAILED — ${verdict.issues.length} issue(s) found (round ${qaRound})`,
          verdict.issues.slice(0, 3).join(' | ')
        );

        if (isFinalRound) {
          // Max fix cycles reached — save to blocked for human review
          sprintLog(qaKey,
            `⛔ Max QA cycles (${MAX_QA_CYCLES}) reached — task blocked for human review`,
            `Unresolved: ${verdict.issues.length} issue(s)`
          );

          // Save to needsHumanReview for separate file
          sprint.needsHumanReview.push({
            taskId: devResult.task.id,
            taskTitle: devResult.task.title,
            devKey,
            qaKey,
            qaRound,
            issues: verdict.issues,
            currentImplementation: currentDevOutput,
            taskDir: devResult.taskDir,
          });

          // Move to blocked column instead of done
          moveCard([devResult.task.id], 'blocked');
          break;
        }

        // ── Send back to Dev for fixes ────────────────────────────────────────
        sprint.fixCycles.push({
          qaKey, devKey, round: qaRound,
          issues: verdict.issues,
        });

        sprintLog(devKey,
          `Received ${verdict.issues.length} issue(s) from QA (round ${qaRound}) — will fix then pass through reviewer before returning to QA`,
          verdict.issues.map((issue, i) => `${i + 1}. ${issue}`).join(' | ')
        );

        // Move dev task card back to inProgress visually
        moveCard([devResult.task.id], 'inProgress');

        onProgress({
          type: 'phase',
          agent: devKey,
          phase: `Fixing QA issues (round ${qaRound}): ${devResult.task.title.slice(0, 22)}`,
        });

        currentDevOutput = await runDevFixForTask(
          devResult.task,
          currentDevOutput,
          verdict.issues,
          devResult.taskDir,
          {
            mode,
            agentKey: devKey,
            persona: devPersonaForQa?.identity,
            sprintLog: (msg, decision) => sprintLog(devKey, msg, decision),
          }
        );

        onProgress({ type: 'output', agent: devKey, content: currentDevOutput });
        sprintLog(devKey,
          `Fixes applied (round ${qaRound}) — sending to reviewer before returning to QA`,
          `Fixed ${verdict.issues.length} QA issue(s)`
        );

        sprint.outputs.dev[devKey] = currentDevOutput;
        moveCard([devResult.task.id], 'review');

        // ── Reviewer must re-review every Dev fix before code returns to QA ──
        const reviewerKey = `reviewer-${devKey.split('-')[1]}`;
        let reReviewRound = 0;

        while (reReviewRound <= MAX_REVIEW_CYCLES) {
          reReviewRound++;
          const isReviewFinal = reReviewRound > MAX_REVIEW_CYCLES;

          onProgress({
            type: 'phase',
            agent: reviewerKey,
            phase: reReviewRound === 1
              ? `Re-reviewing after QA fix ${qaRound}: ${devResult.task.title.slice(0, 22)}`
              : `Re-reviewing (attempt ${reReviewRound}) after QA fix ${qaRound}`,
          });
          sprintLog(reviewerKey,
            reReviewRound === 1
              ? `Re-reviewing code after QA fix round ${qaRound} — must pass before returning to QA`
              : `Re-reviewing (attempt ${reReviewRound}) after QA fix round ${qaRound}`,
            'Checking: requirements, bugs, security, performance, best practices'
          );

          const reReviewContext = mode === 'simulate'
            ? `Feature: ${requirement}\n\nArchitecture:\n${tlOutput}\n\nTask: ${devResult.task.title}\n\nNote: Simulation mode — re-review after QA fix round ${qaRound}.`
            : `Feature: ${requirement}\n\nArchitecture:\n${tlOutput}\n\nTask: ${devResult.task.title}\n\nImplementation (after QA fix round ${qaRound}):\n${currentDevOutput}`;

          const reReviewOutput = await callAgent('reviewer', reReviewContext, { persona: reviewerPersonaForQa?.identity });
          const reVerdict = parseReviewerVerdict(reReviewOutput);
          onProgress({ type: 'output', agent: reviewerKey, content: reReviewOutput });

          if (reVerdict.passed) {
            sprintLog(reviewerKey,
              `✓ Re-review PASSED — code approved, returning to QA (round ${qaRound + 1})`,
              reReviewRound === 1 ? 'Quality verified after QA fix' : `Approved on attempt ${reReviewRound}`
            );
            break;
          }

          // Re-review FAILED
          sprintLog(reviewerKey,
            `✗ Re-review FAILED — ${reVerdict.issues.length} issue(s) found`,
            reVerdict.issues.slice(0, 3).join(' | ')
          );

          if (isReviewFinal) {
            sprintLog(reviewerKey,
              `⚠ Max review attempts reached after QA fix — forwarding to QA with known issues`,
              `Unresolved: ${reVerdict.issues.length} issue(s)`
            );
            break;
          }

          // Dev must fix reviewer issues before going back to QA
          sprint.reviewCycles.push({
            reviewerKey, devKey, round: reReviewRound,
            issues: reVerdict.issues, context: `qa-fix-${qaRound}`,
          });

          sprintLog(devKey,
            `Received ${reVerdict.issues.length} reviewer issue(s) after QA fix (reviewer attempt ${reReviewRound})`,
            reVerdict.issues.map((issue, i) => `${i + 1}. ${issue}`).join(' | ')
          );

          moveCard([devResult.task.id], 'inProgress');
          onProgress({
            type: 'phase',
            agent: devKey,
            phase: `Fixing reviewer issues after QA fix ${qaRound}: ${devResult.task.title.slice(0, 18)}`,
          });

          currentDevOutput = await runDevFixForTask(
            devResult.task,
            currentDevOutput,
            reVerdict.issues,
            devResult.taskDir,
            {
              mode,
              agentKey: devKey,
              persona: devPersonaForQa?.identity,
              sprintLog: (msg, decision) => sprintLog(devKey, msg, decision),
            }
          );

          onProgress({ type: 'output', agent: devKey, content: currentDevOutput });
          sprintLog(devKey,
            `Reviewer fixes applied (after QA fix ${qaRound}) — re-sending to reviewer`,
            `Fixed ${reVerdict.issues.length} reviewer issue(s)`
          );
          sprint.outputs.dev[devKey] = currentDevOutput;
          moveCard([devResult.task.id], 'review');
        } // end reviewer re-review loop

      } // end QA while

      // ── Write final test file ─────────────────────────────────────────────
      if (mode !== 'simulate' && existsSync(devResult.taskDir)) {
        const testDir = join(devResult.taskDir, '__tests__');
        if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
        writeFileSync(join(testDir, 'sprint.test.js'), verdict.tests || qaOutput);
        sprintLog(qaKey, `Tests written to ${devKey}/__tests__/sprint.test.js`);
      } else if (mode === 'simulate') {
        sprintLog(qaKey, 'Test plan generated (simulation — no files written)');
      }

      return { key: qaKey, devResult, qaOutput, qaRound, passed: verdict.passed };
    })
  );

  sprint.outputs.qa = qaResults.reduce(
    (acc, { key, qaOutput }) => ({ ...acc, [key]: qaOutput }), {}
  );
  sprint.outputs.qaStats = qaResults.reduce(
    (acc, { key, qaRound, passed }) => ({ ...acc, [key]: { rounds: qaRound, passed } }), {}
  );

  const allTaskIds = [...userStories.map(s => s.id), ...devTaskIds];
  moveCard(allTaskIds, 'done');
  moveCard(qaCards.map(c => c.id), 'done');

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

  // Save blocked tasks to separate file for human review
  if (sprint.needsHumanReview && sprint.needsHumanReview.length > 0) {
    const blockedMd = buildNeedsHumanReviewLog(sprint);
    writeFileSync(join(outputDir, 'needs-human-review.md'), blockedMd);
  }
}

function buildMarkdownLog(sprint) {
  // ── Review summary line ──────────────────────────────────────────────────────
  const reviewStatsSummary = sprint.outputs.reviewStats
    ? Object.entries(sprint.outputs.reviewStats).map(([key, s]) =>
        `${key}: ${s.passed ? '✓ PASSED' : '✗ FAILED'} in ${s.rounds} round(s)`
      ).join(', ')
    : null;

  // ── Review cycles section ────────────────────────────────────────────────────
  const reviewCycleLines = [];
  if (sprint.reviewCycles && sprint.reviewCycles.length > 0) {
    reviewCycleLines.push(`## Code Review ↔ Dev Fix Cycles`, ``);
    sprint.reviewCycles.forEach(({ reviewerKey, devKey, round, issues }) => {
      reviewCycleLines.push(
        `### Round ${round}: ${reviewerKey} → ${devKey}`,
        ``,
        `Issues returned to dev:`,
        ...issues.map(i => `- ${i}`),
        ``
      );
    });
    reviewCycleLines.push(`---`, ``);
  }

  // ── QA summary line ──────────────────────────────────────────────────────────
  const qaStatsSummary = sprint.outputs.qaStats
    ? Object.entries(sprint.outputs.qaStats).map(([key, s]) =>
        `${key}: ${s.passed ? '✓ PASSED' : '✗ FAILED'} in ${s.rounds} round(s)`
      ).join(', ')
    : null;

  // ── Fix cycles section ───────────────────────────────────────────────────────
  const fixCycleLines = [];
  if (sprint.fixCycles && sprint.fixCycles.length > 0) {
    fixCycleLines.push(`## QA ↔ Dev Fix Cycles`, ``);
    sprint.fixCycles.forEach(({ qaKey, devKey, round, issues }) => {
      fixCycleLines.push(
        `### Round ${round}: ${qaKey} → ${devKey}`,
        ``,
        `Issues returned to dev:`,
        ...issues.map(i => `- ${i}`),
        ``
      );
    });
    fixCycleLines.push(`---`, ``);
  }

  const lines = [
    `# Sprint Log`,
    ``,
    `- **Started:** ${sprint.startedAt}`,
    `- **Completed:** ${sprint.completedAt || 'In progress'}`,
    `- **Mode:** ${sprint.mode}`,
    `- **Requirement:** ${sprint.requirement}`,
    ...(sprint.reviewCycles?.length > 0
      ? [`- **Review Cycles:** ${sprint.reviewCycles.length} (Max allowed: ${MAX_REVIEW_CYCLES})`]
      : []),
    ...(reviewStatsSummary ? [`- **Review Results:** ${reviewStatsSummary}`] : []),
    ...(sprint.fixCycles?.length > 0
      ? [`- **QA Fix Cycles:** ${sprint.fixCycles.length} (Max allowed: ${MAX_QA_CYCLES})`]
      : []),
    ...(qaStatsSummary ? [`- **QA Results:** ${qaStatsSummary}`] : []),
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
    ...(typeof sprint.outputs.dev === 'object' && sprint.outputs.dev !== null
      ? Object.entries(sprint.outputs.dev).flatMap(([key, output]) => [
          `### ${key}`, '', output, '',
        ])
      : [sprint.outputs.dev || '']
    ),
    ``,
    `---`,
    ``,
    ...reviewCycleLines,
    `## Code Review Output`,
    ``,
    ...(typeof sprint.outputs.review === 'object' && sprint.outputs.review !== null
      ? Object.entries(sprint.outputs.review).flatMap(([key, output]) => {
          const stats = sprint.outputs.reviewStats?.[key];
          const badge = stats
            ? ` — ${stats.passed ? '✓ PASSED' : '✗ FAILED'} in ${stats.rounds} round(s)`
            : '';
          return [`### ${key}${badge}`, '', output, ''];
        })
      : [sprint.outputs.review || '(no review output)']
    ),
    ``,
    `---`,
    ``,
    ...fixCycleLines,
    `## QA Output`,
    ``,
    ...(typeof sprint.outputs.qa === 'object' && sprint.outputs.qa !== null
      ? Object.entries(sprint.outputs.qa).flatMap(([key, output]) => {
          const stats = sprint.outputs.qaStats?.[key];
          const badge = stats
            ? ` — ${stats.passed ? '✓ PASSED' : '✗ FAILED'} in ${stats.rounds} round(s)`
            : '';
          return [`### ${key}${badge}`, '', '```javascript', output, '```', ''];
        })
      : ['```javascript', sprint.outputs.qa || '', '```']
    ),
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
    `| Backlog | In Progress | Review | Blocked | Done |`,
    `|---------|-------------|--------|---------|------|`,
    buildKanbanTable(sprint.kanban),
    ...(sprint.needsHumanReview && sprint.needsHumanReview.length > 0 ? [
      ``,
      `### ⚠️ Blocked Tasks Requiring Human Review`,
      ``,
      `See **needs-human-review.md** for details on ${sprint.needsHumanReview.length} blocked task(s).`,
    ] : []),
  ];
  return lines.join('\n');
}

// ─── Build needs-human-review.md for blocked tasks ─────────────────────────────

function buildNeedsHumanReviewLog(sprint) {
  const lines = [
    `# 🚨 Needs Human Review`,
    ``,
    `> **Sprint**: ${sprint.requirement.slice(0, 80)}...`,
    `> **Started**: ${sprint.startedAt}`,
    `> **Completed**: ${sprint.completedAt}`,
    `> **Mode**: ${sprint.mode}`,
    ``,
    `---`,
    ``,
    `## Summary`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Total Tasks | ${Object.values(sprint.kanban).flat().length} |`,
    `| Blocked Tasks | ${sprint.needsHumanReview.length} |`,
    `| Completed | ${sprint.kanban.done.length} |`,
    ``,
    `---`,
    ``,
  ];

  // Add each blocked task
  sprint.needsHumanReview.forEach((task, index) => {
    lines.push(
      `## 📋 Blocked Task #${index + 1}: ${task.taskTitle}`,
      ``,
      `| Field | Value |`,
      `|-------|-------|`,
      `| Task ID | \`${task.taskId}\` |`,
      `| Developer | \`${task.devKey}\` |`,
      `| QA Agent | \`${task.qaKey}\` |`,
      `| QA Rounds | ${task.qaRound} |`,
      `| Task Directory | \`${task.taskDir}\` |`,
      ``,
      `### ❌ Unresolved Issues (${task.issues.length})`,
      ``,
      ...task.issues.map((issue, i) => `${i + 1}. ${issue}`),
      ``,
      `### 📝 Current Implementation`,
      ``,
      '```javascript',
      task.currentImplementation.slice(0, 3000) + (task.currentImplementation.length > 3000 ? '\n... (truncated)' : ''),
      '```',
      ``,
      `### 💡 Suggested Actions`,
      ``,
      `1. Review the unresolved issues above`,
      `2. Check the implementation in \`${task.taskDir}\``,
      `3. Apply manual fixes or provide additional context to dev team`,
      `4. Re-run QA after fixes are applied`,
      ``,
      `---`,
      ``
    );
  });

  lines.push(
    `## 🔧 How to Fix`,
    ``,
    `1. **Review**: Read through each blocked task's issues above`,
    `2. **Locate**: Find the implementation files in the task directory`,
    `3. **Fix**: Apply manual corrections to resolve the issues`,
    `4. **Test**: Run tests to verify the fixes work`,
    `5. **Document**: Update this file with resolution notes`,
    ``,
    `---`,
    ``,
    `*Generated by AI Software Company Sprint System*`
  );

  return lines.join('\n');
}

// ─── Dynamic card parsers ──────────────────────────────────────────────────────

/**
 * Parse user stories from PO output.
 * Looks for "As a..." lines; falls back to generic cards if none found.
 */
function parseUserStories(poOutput) {
  const lines = poOutput.split('\n');
  const stories = [];
  for (const line of lines) {
    const match = line.match(/as a\s+(.+?),?\s+i want\s+(.+?)(?:\s+so that|$)/i);
    if (match) {
      const title = `As a ${match[1].trim()}: ${match[2].trim()}`.slice(0, 60);
      stories.push({ id: `us-${stories.length}`, title, agent: 'po' });
    }
    if (stories.length >= 5) break;
  }
  // Fallback if PO didn't follow the format
  if (stories.length === 0) {
    return [
      { id: 'us-0', title: 'Core feature story', agent: 'po' },
      { id: 'us-1', title: 'Auth / access story', agent: 'po' },
      { id: 'us-2', title: 'Error handling story', agent: 'po' },
    ];
  }
  return stories;
}

/**
 * Parse dev tasks from TL output.
 * Looks for numbered task names; falls back to generic cards.
 */
function parseDevTasks(tlOutput) {
  const lines = tlOutput.split('\n');
  const tasks = [];
  for (const line of lines) {
    // Match lines like "Task 1: ...", "1. Create authService", "- Task name: ..."
    const match = line.match(/(?:task\s*\d*[:.]?\s*|^\s*\d+[.)]\s+|^\s*[-*]\s+task\s+name:\s*)(.{5,60})/i);
    if (match) {
      const title = match[1].trim().replace(/^name:\s*/i, '').slice(0, 60);
      if (title.length > 4) {
        tasks.push({ id: `dev-${tasks.length}`, title, agent: 'tl' });
      }
    }
    if (tasks.length >= 5) break;
  }
  if (tasks.length === 0) {
    return [
      { id: 'dev-0', title: 'Core service', agent: 'tl' },
      { id: 'dev-1', title: 'Data layer', agent: 'tl' },
      { id: 'dev-2', title: 'API / interface layer', agent: 'tl' },
    ];
  }
  return tasks;
}

function buildKanbanTable(kanban) {
  const cols = ['backlog', 'inProgress', 'review', 'blocked', 'done'];
  const maxLen = Math.max(...cols.map(c => kanban[c]?.length || 0));
  if (maxLen === 0) return '| — | — | — | — | — |';
  return Array.from({ length: maxLen }, (_, i) =>
    `| ${cols.map(c => kanban[c]?.[i]?.id || '').join(' | ')} |`
  ).join('\n');
}
