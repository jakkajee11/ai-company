/**
 * agents.js
 *
 * PO, TL, QA  → Anthropic SDK (claude-sonnet)
 * DEV         → Claude Code subprocess (claude code --print)
 *               เขียน code จริง, สร้าง files จริง ใน project directory
 */

import Anthropic from '@anthropic-ai/sdk';
import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

// ─── Anthropic client ──────────────────────────────────────────────────────────

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─── Agent definitions ─────────────────────────────────────────────────────────

export const AGENTS = {
  po: {
    name: 'Product Owner',
    abbr: 'PO',
    color: 'magenta',
    model: 'claude-sonnet-4-6',
    maxTokens: 900,
    systemPrompt: `You are a Product Owner in an Agile software team.
Analyze requirements and produce:
1. A brief summary (2-3 sentences)
2. Exactly 3-4 user stories: "As a [user], I want [feature] so that [benefit]"
3. Acceptance criteria for each story (2-3 bullets)
4. Key risks or unknowns (1-2 items)
Be concise and actionable. Output plain text, no markdown headers.`,
  },

  tl: {
    name: 'Tech Lead',
    abbr: 'TL',
    color: 'green',
    model: 'claude-sonnet-4-6',
    maxTokens: 1200,
    systemPrompt: `You are a Tech Lead / Dev Lead in an Agile team.
Given a requirement and user stories from the PO, produce:
1. Recommended tech stack with one-line justification per item
2. High-level architecture (3-5 components, how they connect)
3. Developer sub-tasks grouped BY USER STORY — 1 developer owns 1 story completely.
   Each developer implements ALL sub-tasks for their story. No story is shared between developers.

   REQUIRED FORMAT — repeat this block for EACH user story:
   ---
   US-X Owner: Dev [N]
   Sub-tasks for US-X:
     Task: [sub-task name]
     Files: [specific file paths]
     Functions: [key function names]
     ---
     Task: [sub-task name]
     Files: [specific file paths]
     Functions: [key function names]
   ---

   Design 1-3 sub-tasks per user story. Each sub-task must use files that belong ONLY to that story's module.

4. One Architecture Decision Record (ADR):
   Decision: [what]
   Because: [why]
   Trade-off: [what we give up]

5. **Story Boundary Strategy** — CRITICAL: zero merge conflicts between developers:
   - Assign each user story to a distinct module/folder (e.g. src/auth/, src/api/, src/data/)
   - No two stories write to the same file
   - Shared utilities go in src/shared/ — assign ownership to one story's developer

6. **Project Scaffold Structure** — MUST include this section.
   You are responsible for creating the project structure. Developers MUST build on this scaffold only.
===SCAFFOLD===
src/
  index.js
  config/
    config.js
===END_SCAFFOLD===

The scaffold must support parallel development with minimal overlap.
Each file should be a separate line with proper indentation.
Output plain text. Be specific about file paths and function names.`,
  },

  reviewer: {
    name: 'Code Reviewer',
    abbr: 'CR',
    color: 'cyan',
    model: 'claude-sonnet-4-6',
    maxTokens: 1200,
    systemPrompt: `You are a Senior Code Reviewer in an Agile engineering team.
Review the implementation carefully for:
1. Requirement alignment — does it fully and correctly implement what was specified?
2. Bugs — logic errors, off-by-one, null/undefined risks, unhandled edge cases, race conditions
3. Security — injection vulnerabilities, missing auth/authz, data exposure, insecure operations
4. Performance — N+1 queries, inefficient algorithms, blocking I/O, unnecessary computation
5. Resource management — memory leaks, unclosed connections, missing cleanup, improper error propagation
6. Best practices — SOLID principles, proper error handling, clear naming, code duplication

You MUST respond in EXACTLY this format:

VERDICT: PASS
(or write VERDICT: FAIL if any significant issues must be fixed before testing)

ISSUES:
- [specific issue with file/function reference and brief fix suggestion]
(omit the ISSUES section entirely when VERDICT is PASS)

REVIEW NOTES:
[2-4 sentence summary: what you reviewed, overall quality, and any non-blocking observations]`,
  },

  qa: {
    name: 'QA Engineer',
    abbr: 'QA',
    color: 'yellow',
    model: 'claude-sonnet-4-6',
    maxTokens: 1400,
    systemPrompt: `You are a QA Engineer. Review the implementation and produce a structured report.

Review the code for:
1. Correctness — does it match the stated requirements?
2. Error handling — null/undefined checks, edge cases, input validation
3. Security — injection, auth bypass, data exposure, unsafe operations
4. Code quality — obvious bugs, missing logic, incomplete implementation

You MUST respond in EXACTLY this format (all three sections required):

VERDICT: PASS
(or write VERDICT: FAIL if any issues were found)

ISSUES:
- describe each specific issue with file/function reference if possible
(omit the ISSUES section entirely when VERDICT is PASS)

TESTS:
\`\`\`javascript
// complete Jest test file here
\`\`\`

The TESTS section must always be present and contain a complete, runnable Jest file.
Use describe/it blocks. Mock external deps with jest.mock(). Cover: happy path, edge cases, errors, security.`,
  },
};

// ─── Star Wars Personas ────────────────────────────────────────────────────────
//  11 characters, same technical skills per role, different identity & voice.
//  Each entry has: character (display name), title, identity (prepended to systemPrompt)

export const STAR_WARS_PERSONAS = {
  po: {
    character: 'Princess Leia Organa',
    title: 'Senator & Rebel Alliance Leader',
    identity: `You are Princess Leia Organa — Senator of Alderaan and leader of the Rebel Alliance.
You represent the users and fight relentlessly for what they truly need.
You speak with clarity, urgency, and conviction. Your requirements are precise and purposeful.
You cut through ambiguity and prioritize ruthlessly because the mission matters.`,
  },

  tl: {
    character: 'Obi-Wan Kenobi',
    title: 'Jedi Master & Chief Architect',
    identity: `You are Obi-Wan Kenobi — Jedi Master and Chief Architect of the engineering team.
You design systems with elegance, foresight, and measured wisdom.
You speak calmly and precisely. Trade-offs are considered carefully and documented with gravity.
Your architecture is clean, purposeful, and built to last.`,
  },

  dev: [
    {
      character: 'Luke Skywalker',
      title: 'Jedi Developer',
      identity: `You are Luke Skywalker — idealistic Jedi Developer.
You believe in clean code and doing things the right way.
You are determined and will not abandon a hard problem.
The Force guides you toward elegant, purposeful solutions.`,
    },
    {
      character: 'Han Solo',
      title: 'Maverick Developer',
      identity: `You are Han Solo — pragmatic, quick-thinking Maverick Developer.
"I know" is your catchphrase. You cut through complexity and find the fastest path to working software.
You handle edge cases the way you dodge TIE fighters: instinctively and effectively.
You don't overthink — you ship.`,
    },
    {
      character: 'Lando Calrissian',
      title: 'Administrator Developer',
      identity: `You are Lando Calrissian — charismatic Administrator Developer.
You find creative solutions others overlook. Your code is elegant, readable, and has a certain style.
You work well under pressure and turn complex challenges into smooth implementations.`,
    },
  ],

  reviewer: [
    {
      character: 'Yoda',
      title: 'Grand Master Code Reviewer',
      identity: `You are Yoda — Grand Master Code Reviewer, eight hundred years of engineering wisdom you carry.
What others miss, you see. When writing review notes, occasionally use inverted sentence structure as Yoda would.
Thorough and wise your reviews are, yet concise. Let nothing slip past, you will not.`,
    },
    {
      character: 'Mace Windu',
      title: 'High Council Code Reviewer',
      identity: `You are Mace Windu — High Council Code Reviewer.
You have no patience for substandard work. Either the code meets the standard or it does not — there is no middle ground.
Your reviews are direct, strict, and uncompromising. Every flaw is identified with authority and precision.`,
    },
    {
      character: 'Qui-Gon Jinn',
      title: 'Senior Code Reviewer',
      identity: `You are Qui-Gon Jinn — thoughtful Senior Code Reviewer.
You look beyond the surface to the true intent of the code.
You are thorough but balanced, carefully distinguishing critical defects from minor observations.
You guide developers toward better solutions with wisdom and patience.`,
    },
  ],

  qa: [
    {
      character: 'R2-D2',
      title: 'Astromech QA Unit',
      identity: `You are R2-D2 — elite Astromech QA Unit.
You systematically probe every system pathway, protocol, and interface.
Your diagnostic circuits find bugs others cannot. You are thorough, relentless, and accurate.
Translate your beep-boop diagnostics into precise technical findings.`,
    },
    {
      character: 'C-3PO',
      title: 'Protocol QA Droid',
      identity: `You are C-3PO — Protocol QA Droid, fluent in over six million forms of software failure.
You are meticulous, detail-oriented, and enumerate every possible failure mode.
You may express concern about the odds. Your reports cover every edge case and protocol deviation comprehensively.
"I must warn you, sir" is an appropriate opener when issues are found.`,
    },
    {
      character: 'Darth Vader',
      title: 'Dark Lord of QA',
      identity: `You are Darth Vader — Dark Lord of QA.
You are relentless, methodical, and show no mercy to broken code.
"I find your lack of test coverage disturbing." You pursue every flaw with the full power of the Dark Side.
Your verdict is final. Your standards are absolute. Weakness in code, you will find.`,
    },
  ],
};

// ─── Non-DEV agents: call Anthropic API directly ──────────────────────────────

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export async function callAgent(agentKey, userMessage, opts = {}) {
  const agent = AGENTS[agentKey];
  // Prepend Star Wars persona identity before the technical system prompt
  const systemPrompt = opts.persona
    ? `${opts.persona}\n\n---\n\n${agent.systemPrompt}`
    : agent.systemPrompt;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.messages.create({
        model: agent.model,
        max_tokens: agent.maxTokens,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });
      return response.content[0].text;
    } catch (err) {
      lastError = err;
      const status = err.status ?? err.statusCode;
      const isRetryable = RETRYABLE_STATUS.has(status) || err.message?.includes('timeout');

      if (!isRetryable || attempt === MAX_RETRIES) break;

      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      console.error(`[${agent.abbr}] API error (${status ?? err.message}) — retry ${attempt}/${MAX_RETRIES - 1} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  throw new Error(`[${agent.abbr}] Failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

// ─── DEV agent: run Claude Code as subprocess ─────────────────────────────────

/**
 * runDevAgentForTask — Developer agent สำหรับ 1 task (ใช้ใน parallel mode)
 *
 * @param {object} task         - { title, files } task จาก TL
 * @param {string} requirement  - original user requirement
 * @param {string} tlOutput     - tech lead's full architecture plan
 * @param {string} taskDir      - directory สำหรับ task นี้โดยเฉพาะ
 * @param {object} opts         - { mode, sprintLog, agentKey }
 */
export async function runDevAgentForTask(task, requirement, tlOutput, taskDir, opts = {}) {
  const { mode = 'execute', sprintLog, persona } = opts;

  if (!existsSync(taskDir)) mkdirSync(taskDir, { recursive: true });

  writeFileSync(
    join(taskDir, 'TASK_CONTEXT.md'),
    buildTaskContext(task, requirement, tlOutput, mode, persona)
  );

  if (mode === 'simulate') return await callSimulateDevTask(task, requirement, tlOutput, persona);

  return await runClaudeCodeForTask(task, requirement, tlOutput, taskDir, sprintLog, persona);
}

async function callSimulateDevTask(task, requirement, tlOutput, persona) {
  const baseSystem = `You are a Senior Developer. You OWN a complete user story and must describe your implementation plan for ALL its sub-tasks.
Be specific about file names and function signatures. Do NOT write full code.`;
  const system = persona ? `${persona}\n\n---\n\n${baseSystem}` : baseSystem;
  const devOnlySubtasks = (task.subtasks || []).filter(st => !st.type || st.type === 'dev');
  const subtaskLines = devOnlySubtasks.map((st, i) => `${i + 1}. ${st.title}`).join('\n');
  const subtasksBlock = subtaskLines ? `\nSub-tasks (implement ALL):\n${subtaskLines}\n` : '';
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    system,
    messages: [{
      role: 'user',
      content: `Requirement: ${requirement}\n\nYour user story: ${task.title}${subtasksBlock}\n${task.files ? `Files: ${task.files}` : ''}\n\nArchitecture:\n${tlOutput}\n\nDescribe your full implementation plan for this story.`,
    }],
  });
  return response.content[0].text;
}

async function runClaudeCodeForTask(task, requirement, tlOutput, taskDir, sprintLog, persona) {
  const devPrompt = buildClaudeCodeTaskPrompt(task, requirement, tlOutput, persona);
  writeFileSync(join(taskDir, '.cc-prompt.txt'), devPrompt);

  if (!isClaudeCodeAvailable()) return fallbackDevTaskOutput(task, requirement, tlOutput, taskDir, persona);

  try {
    const result = spawnSync('claude', ['--print', '--dangerously-skip-permissions'], {
      input: devPrompt,
      encoding: 'utf8',
      cwd: taskDir,
      timeout: 120_000,
      env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    });

    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `Exit code ${result.status}`);

    const output = result.stdout?.trim() || '(no output)';
    const files = listCreatedFiles(taskDir);
    if (files.length > 0) sprintLog?.(`Created ${files.length} files: ${files.join(', ')}`);
    return output;
  } catch (err) {
    sprintLog?.(`Claude Code unavailable (${err.message}) — using API fallback`);
    return fallbackDevTaskOutput(task, requirement, tlOutput, taskDir);
  }
}

async function fallbackDevTaskOutput(task, requirement, tlOutput, taskDir, persona) {
  const baseSystem = `You are a Senior Developer. You OWN a complete user story — implement ALL its sub-tasks.
Use Tech Lead's scaffold structure. Do NOT create your own project.
Respond in this format for EACH file:

===FILE: path/to/file.ts===
[file contents]
===END===

Write clean, production-ready code. Include ALL files needed for your user story.`;
  const system = persona ? `${persona}\n\n---\n\n${baseSystem}` : baseSystem;
  const devOnlySubtasks = (task.subtasks || []).filter(st => !st.type || st.type === 'dev');
  const subtaskLines = devOnlySubtasks.map((st, i) => `${i + 1}. ${st.title}`).join('\n');
  const subtasksBlock = subtaskLines ? `\nSub-tasks (implement ALL):\n${subtaskLines}\n` : '';
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system,
    messages: [{
      role: 'user',
      content: `Requirement: ${requirement}\n\nYour user story: ${task.title}${subtasksBlock}\n${task.files ? `Files: ${task.files}` : ''}\n\nArchitecture:\n${tlOutput}\n\nImplement all sub-tasks for your story.`,
    }],
  });
  const output = response.content[0].text;
  writeGeneratedFiles(output, taskDir);
  return output;
}

function buildClaudeCodeTaskPrompt(task, requirement, tlOutput, persona) {
  const identityBlock = persona ? `${persona}\n\n---\n\n` : '';

  // Build sub-tasks section — dev-only sub-tasks (type: 'dev' or no type)
  const devOnlySubtasks = (task.subtasks || []).filter(st => !st.type || st.type === 'dev');
  const subtaskLines = devOnlySubtasks.map((st, i) =>
    `${i + 1}. ${st.title}${st.files ? `\n   Files: ${st.files}` : ''}`
  ).join('\n');
  const subtasksSection = subtaskLines
    ? `\n## Sub-tasks from Tech Lead (implement ALL of these)\n${subtaskLines}\n`
    : '';

  return `${identityBlock}You are a Developer agent in an AI Agile team.
You OWN the entire user story below — you must implement ALL of its sub-tasks from start to finish.
No other developer will touch this story. You are fully responsible for its delivery.

## Your User Story
${task.id ? `ID: ${task.id.toUpperCase()}` : ''}
${task.title}
${subtasksSection}
${task.files ? `\nAll files to create:\n${task.files}` : ''}

## Overall requirement (context only)
${requirement}

## Architecture & Scaffold from Tech Lead
${tlOutput}

## CRITICAL: Project Structure Rules
1. Tech Lead has already created the project scaffold above. You MUST NOT create your own project structure.
2. Build ONLY on the existing files and directories defined in the scaffold.
3. Do NOT run npm init, git init, or create top-level directories — those belong to Tech Lead.
4. If the scaffold directory does not exist yet, STOP and output: "WAITING: Tech Lead scaffold not ready."
5. Implement ALL sub-tasks listed above — this is your complete responsibility.
6. Do NOT touch files assigned to other developers' user stories.
7. Write clean, production-ready code with error handling and brief file-level comments.

Start implementing now.`;
}

function buildTaskContext(task, requirement, tlOutput, mode, persona) {
  const identityBlock = persona
    ? `## Identity\n${persona}\n\n`
    : '';
  const storyRef = task.id
    ? `## User Story Ownership\nYou own ${task.id.toUpperCase()} completely — implement ALL sub-tasks below.\n\n`
    : '';

  const devOnlySubtasksForCtx = (task.subtasks || []).filter(st => !st.type || st.type === 'dev');
  const subtaskLines = devOnlySubtasksForCtx.map((st, i) =>
    `${i + 1}. ${st.title}${st.files ? ` (${st.files})` : ''}`
  ).join('\n');
  const subtasksSection = subtaskLines
    ? `## Sub-tasks to Implement (all yours)\n${subtaskLines}\n\n`
    : '';

  return `# Task Context
Generated: ${new Date().toISOString()}
Mode: ${mode}

${identityBlock}${storyRef}${subtasksSection}## User Story Title
${task.title}
${task.files ? `\nAll files: ${task.files}` : ''}

## IMPORTANT: Use Tech Lead's scaffold — do not create your own project structure.

## Requirement
${requirement}

## Architecture & Scaffold (from Tech Lead)
${tlOutput}
`;
}

// ─── QA Sub-task Designer ──────────────────────────────────────────────────────

/**
 * designQaSubtasks — QA agent designs its own test sub-tasks for a user story.
 * Called AFTER TL creates dev sub-tasks, so QA can see what dev will build.
 *
 * @param {object} story             - { id, title } user story
 * @param {object[]} devSubtasks     - dev sub-tasks from TL (array of { id, title })
 * @param {string} requirement       - original user requirement
 * @param {string} qaPersonaIdentity - QA persona identity string (optional)
 * @returns {Promise<object[]>}      - array of QA sub-tasks: { id, title, status, type }
 */
export async function designQaSubtasks(story, devSubtasks, requirement, qaPersonaIdentity) {
  const baseSystem = `You are a QA Engineer planning test scenarios for a user story.
Given the user story and its developer sub-tasks, design QA-specific sub-tasks:
- Test cases: verify each developer sub-task's expected behavior
- Edge cases: boundary conditions, empty/null inputs, concurrent access
- Validation: security checks, input sanitization, error handling
- Integration: end-to-end flows that span multiple sub-tasks

Each QA sub-task must be a specific, actionable testing activity.

Output EXACTLY in this format — one sub-task per line, 3-4 sub-tasks total:
QA-SUBTASK: [concise test scenario title]
QA-SUBTASK: [concise test scenario title]
QA-SUBTASK: [concise test scenario title]

No extra text, headers, or explanations — just the QA-SUBTASK lines.`;

  const system = qaPersonaIdentity ? `${qaPersonaIdentity}\n\n---\n\n${baseSystem}` : baseSystem;

  const devSubtaskLines = devSubtasks.length > 0
    ? devSubtasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n')
    : '(no dev sub-tasks defined)';

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system,
      messages: [{
        role: 'user',
        content: `Requirement: ${requirement}\n\nUser Story: ${story?.title || 'Unknown'}\n\nDeveloper sub-tasks:\n${devSubtaskLines}\n\nDesign QA sub-tasks for this user story.`,
      }],
    });

    const output = response.content[0].text;
    const qaSubtasks = [];
    let idx = 0;
    output.split('\n').forEach(line => {
      const match = line.match(/QA-SUBTASK:\s*(.+)/i);
      if (match) {
        qaSubtasks.push({
          id: `${story?.id || 'us'}-qa-${idx++}`,
          title: match[1].trim(),
          status: 'pending',
          type: 'qa',
        });
      }
    });

    // Fallback sub-tasks if parsing failed
    if (qaSubtasks.length === 0) {
      return [
        { id: `${story?.id || 'us'}-qa-0`, title: 'Verify acceptance criteria and happy path', status: 'pending', type: 'qa' },
        { id: `${story?.id || 'us'}-qa-1`, title: 'Test edge cases and invalid inputs', status: 'pending', type: 'qa' },
        { id: `${story?.id || 'us'}-qa-2`, title: 'Security and error handling checks', status: 'pending', type: 'qa' },
      ];
    }

    return qaSubtasks;
  } catch (err) {
    // Return safe fallback on error
    return [
      { id: `${story?.id || 'us'}-qa-0`, title: 'Verify acceptance criteria and happy path', status: 'pending', type: 'qa' },
      { id: `${story?.id || 'us'}-qa-1`, title: 'Test edge cases and error handling', status: 'pending', type: 'qa' },
    ];
  }
}

// ─── QA Verdict Parser ─────────────────────────────────────────────────────────

/**
 * Parse structured QA output into verdict + issues + test code.
 *
 * @param {string} qaOutput - raw text from QA agent
 * @returns {{ passed: boolean, issues: string[], tests: string }}
 */
export function parseQaVerdict(qaOutput) {
  // Extract VERDICT line
  const verdictMatch = qaOutput.match(/VERDICT:\s*(PASS|FAIL)/i);
  // Default to PASS if QA agent didn't follow the format (fail-safe)
  const passed = verdictMatch ? verdictMatch[1].toUpperCase() === 'PASS' : true;

  // Extract ISSUES section (between ISSUES: and TESTS:)
  const issues = [];
  const issuesBlock = qaOutput.match(/ISSUES:\n([\s\S]*?)(?=\nTESTS:|$)/i);
  if (issuesBlock) {
    issuesBlock[1].split('\n').forEach(line => {
      const trimmed = line.replace(/^\s*[-*•\d.)]\s*/, '').trim();
      if (trimmed.length > 3) issues.push(trimmed);
    });
  }

  // Extract TESTS section — strip fenced code block markers if present
  const testsBlock = qaOutput.match(/TESTS:\n(?:```(?:javascript|js|typescript|ts)?\n)?([\s\S]*?)(?:```\s*)?$/i);
  const tests = testsBlock
    ? testsBlock[1].replace(/```\s*$/, '').trim()
    : qaOutput; // fallback: treat entire output as tests

  return { passed, issues, tests };
}

// ─── Reviewer Verdict Parser ───────────────────────────────────────────────────

/**
 * Parse structured Code Reviewer output into verdict + issues + notes.
 *
 * @param {string} reviewOutput - raw text from reviewer agent
 * @returns {{ passed: boolean, issues: string[], notes: string }}
 */
export function parseReviewerVerdict(reviewOutput) {
  const verdictMatch = reviewOutput.match(/VERDICT:\s*(PASS|FAIL)/i);
  const passed = verdictMatch ? verdictMatch[1].toUpperCase() === 'PASS' : true;

  const issues = [];
  const issuesBlock = reviewOutput.match(/ISSUES:\n([\s\S]*?)(?=\nREVIEW NOTES:|$)/i);
  if (issuesBlock) {
    issuesBlock[1].split('\n').forEach(line => {
      const trimmed = line.replace(/^\s*[-*•\d.)]\s*/, '').trim();
      if (trimmed.length > 3) issues.push(trimmed);
    });
  }

  const notesBlock = reviewOutput.match(/REVIEW NOTES:\n([\s\S]*)/i);
  const notes = notesBlock ? notesBlock[1].trim() : '';

  return { passed, issues, notes };
}

// ─── DEV Fix Agent ─────────────────────────────────────────────────────────────

/**
 * runDevFixForTask — re-run the developer agent to fix specific QA issues.
 *
 * @param {object} task           - { title, files } the original task
 * @param {string} currentOutput  - dev's previous implementation output
 * @param {string[]} qaIssues     - list of issues found by QA
 * @param {string} taskDir        - task's working directory
 * @param {object} opts           - { mode, sprintLog, agentKey }
 */
export async function runDevFixForTask(task, currentOutput, qaIssues, taskDir, opts = {}) {
  const { mode = 'execute', sprintLog, persona } = opts;

  if (mode === 'simulate') {
    const baseSystem = `You are a Senior Developer fixing code issues raised by review.
Describe concisely how you would address each issue — be specific about file names and functions.
Do NOT write full code in simulate mode.`;
    const system = persona ? `${persona}\n\n---\n\n${baseSystem}` : baseSystem;
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 900,
      system,
      messages: [{
        role: 'user',
        content: buildDevFixUserMessage(task, currentOutput, qaIssues),
      }],
    });
    return response.content[0].text;
  }

  // Write updated context with QA feedback
  writeFileSync(
    join(taskDir, 'QA_FEEDBACK.md'),
    buildQaFeedbackContext(task, qaIssues)
  );

  if (!isClaudeCodeAvailable()) {
    return await fallbackDevFixOutput(task, currentOutput, qaIssues, taskDir, persona);
  }

  const fixPrompt = buildDevFixPrompt(task, currentOutput, qaIssues, persona);
  writeFileSync(join(taskDir, '.cc-fix-prompt.txt'), fixPrompt);

  try {
    const result = spawnSync('claude', ['--print', '--dangerously-skip-permissions'], {
      input: fixPrompt,
      encoding: 'utf8',
      cwd: taskDir,
      timeout: 120_000,
      env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    });

    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `Exit code ${result.status}`);

    const output = result.stdout?.trim() || '(no output)';
    const files = listCreatedFiles(taskDir);
    if (files.length > 0) sprintLog?.(`Fixed ${files.length} file(s): ${files.join(', ')}`);
    return output;
  } catch (err) {
    sprintLog?.(`Claude Code fix failed (${err.message}) — using API fallback`);
    return await fallbackDevFixOutput(task, currentOutput, qaIssues, taskDir, persona);
  }
}

function buildDevFixPrompt(task, currentOutput, qaIssues, persona) {
  const identityBlock = persona ? `${persona}\n\n---\n\n` : '';
  return `${identityBlock}You are a Developer agent. Review issues found in your work and fix them all.

## Your Task
${task.title}

## Issues to Fix
${qaIssues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

## Your Previous Implementation
${currentOutput}

## Instructions
1. Fix EACH issue listed above — address them all
2. Modify the relevant files directly
3. Do NOT change code that is already correct and working
4. After making changes, briefly summarize what you fixed

Fix the issues now.`;
}

function buildDevFixUserMessage(task, currentOutput, qaIssues) {
  return `Task: ${task.title}

QA found these issues in your implementation:
${qaIssues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

Your current implementation:
${currentOutput.slice(0, 800)}${currentOutput.length > 800 ? '\n...(truncated)' : ''}

Describe how you would fix each issue.`;
}

function buildQaFeedbackContext(task, qaIssues) {
  return `# QA Feedback
Generated: ${new Date().toISOString()}

## Task
${task.title}

## Issues to Fix
${qaIssues.map((issue, i) => `${i + 1}. ${issue}`).join('\n')}

## Instructions
Address all issues above. Modify existing files as needed.
`;
}

async function fallbackDevFixOutput(task, currentOutput, qaIssues, taskDir, persona) {
  const baseSystem = `You are a Senior Developer fixing review issues.
Return corrected files using this format for EACH file changed:

===FILE: path/to/file.ts===
[complete corrected file contents]
===END===

Include ONLY files that need changes. Write clean, production-ready code.`;
  const system = persona ? `${persona}\n\n---\n\n${baseSystem}` : baseSystem;
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system,
    messages: [{
      role: 'user',
      content: buildDevFixUserMessage(task, currentOutput, qaIssues),
    }],
  });
  const output = response.content[0].text;
  writeGeneratedFiles(output, taskDir);
  return output;
}

/**
 * runDevAgent — legacy single-dev entry point (ยังคงไว้เพื่อ backward compat)
 *
 * @param {string} requirement   - original user requirement
 * @param {string} tlOutput      - tech lead's architecture plan
 * @param {string} projectDir    - target project directory
 * @param {object} opts          - { mode, sprintLog }
 */
export async function runDevAgent(requirement, tlOutput, projectDir, opts = {}) {
  const { mode = 'execute', sprintLog } = opts;

  // Ensure project directory exists
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }

  // Write context files that Claude Code will read
  const contextFile = join(projectDir, 'SPRINT_CONTEXT.md');
  writeFileSync(contextFile, buildDevContext(requirement, tlOutput, mode));

  if (mode === 'simulate') {
    // Simulate mode: just ask for an implementation plan without writing files
    return await callSimulateDev(requirement, tlOutput);
  }

  // Execute mode: run Claude Code subprocess
  return await runClaudeCode(projectDir, requirement, tlOutput, sprintLog);
}

// ─── Simulate DEV (no file writes) ─────────────────────────────────────────────

async function callSimulateDev(requirement, tlOutput) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: `You are a Senior Developer. Given an architecture plan, describe your implementation approach:
- Which files you would create and why
- Key design patterns and data structures  
- Potential pitfalls and how you'd handle them
Be specific (file names, function signatures). Do NOT write full code — describe the plan clearly.`,
    messages: [{
      role: 'user',
      content: `Requirement: ${requirement}\n\nArchitecture from Tech Lead:\n${tlOutput}\n\nDescribe your implementation plan.`,
    }],
  });
  return response.content[0].text;
}

// ─── Execute DEV via Claude Code ───────────────────────────────────────────────

async function runClaudeCode(projectDir, requirement, tlOutput, sprintLog) {
  // Build the prompt for Claude Code
  const devPrompt = buildClaudeCodePrompt(requirement, tlOutput);

  // Write prompt to file (Claude Code reads it via --print)
  const promptFile = join(projectDir, '.cc-prompt.txt');
  writeFileSync(promptFile, devPrompt);

  // Check if claude CLI is available
  const claudeAvailable = isClaudeCodeAvailable();
  if (!claudeAvailable) {
    return fallbackDevOutput(requirement, tlOutput, projectDir);
  }

  sprintLog?.('DEV', 'Claude Code subprocess starting...', null);

  try {
    // Run: claude --print < prompt.txt
    // --print = non-interactive mode, outputs result to stdout
    const result = spawnSync(
      'claude',
      ['--print', '--dangerously-skip-permissions'],
      {
        input: devPrompt,
        encoding: 'utf8',
        cwd: projectDir,
        timeout: 120_000,           // 2 min max
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
      }
    );

    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || `Exit code ${result.status}`);

    const output = result.stdout?.trim() || '(no output)';

    // Log what files were created
    const createdFiles = listCreatedFiles(projectDir);
    if (createdFiles.length > 0) {
      sprintLog?.('DEV', `Created ${createdFiles.length} files`, createdFiles.join(', '));
    }

    return output;
  } catch (err) {
    // Claude Code not available or failed — fall back to API
    sprintLog?.('DEV', `Claude Code unavailable (${err.message}) — falling back to API`);
    return fallbackDevOutput(requirement, tlOutput, projectDir);
  }
}

// ─── Fallback: DEV via Anthropic API (writes files itself) ─────────────────────

async function fallbackDevOutput(requirement, tlOutput, projectDir) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: `You are a Senior Developer. Write production-ready implementation code.
Respond in this exact format for EACH file:

===FILE: path/to/file.ts===
[file contents here]
===END===

Create all necessary files. Keep each file focused and clean.`,
    messages: [{
      role: 'user',
      content: `Requirement: ${requirement}\n\nArchitecture:\n${tlOutput}\n\nImplement the core files.`,
    }],
  });

  const output = response.content[0].text;

  // Parse and write files from the response
  writeGeneratedFiles(output, projectDir);

  return output;
}

// ─── Prompt builders ───────────────────────────────────────────────────────────

function buildClaudeCodePrompt(requirement, tlOutput) {
  return `You are the Developer agent in an AI Agile team sprint.

## Your task
Implement the following requirement based on the architecture plan below.
You have full access to the filesystem — create all necessary files.

## Requirement
${requirement}

## Architecture plan from Tech Lead
${tlOutput}

## Instructions
1. Create all files specified in the architecture plan
2. Write clean, production-ready code with error handling
3. Add a brief comment at the top of each file explaining its purpose
4. Create a README.md in the project root summarizing what was built
5. If tests are needed, create a __tests__ directory with basic test stubs

Start implementing now. Create the files directly.`;
}

function buildDevContext(requirement, tlOutput, mode) {
  return `# Sprint Context
Generated: ${new Date().toISOString()}
Mode: ${mode}

## Requirement
${requirement}

## Architecture (from Tech Lead)
${tlOutput}

## Instructions for Developer
${mode === 'execute'
  ? '- Implement all files specified above\n- Write production-ready code\n- Add error handling\n- Create README.md'
  : '- This is a simulation — describe implementation plan only'
}
`;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function isClaudeCodeAvailable() {
  try {
    const result = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

function listCreatedFiles(dir) {
  try {
    const result = execSync(`find ${dir} -type f -not -name '.*' -not -name 'SPRINT_CONTEXT.md'`, {
      encoding: 'utf8',
    });
    return result.trim().split('\n').filter(Boolean).map(f => f.replace(dir + '/', ''));
  } catch {
    return [];
  }
}

function writeGeneratedFiles(output, projectDir) {
  const fileRegex = /===FILE: (.+?)===\n([\s\S]*?)===END===/g;
  let match;
  while ((match = fileRegex.exec(output)) !== null) {
    const [, filePath, content] = match;
    const fullPath = join(projectDir, filePath.trim());
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(fullPath, content.trim());
  }
}

// ─── Scaffold Parser & Creator ─────────────────────────────────────────────────

/**
 * Parse scaffold block from TL output and create project structure.
 *
 * @param {string} tlOutput - raw text from TL agent
 * @param {string} projectDir - target project directory
 * @param {object} opts - { mode, sprintLog }
 * @returns {{ files: string[], created: boolean }}
 */
export function parseAndCreateScaffold(tlOutput, projectDir, opts = {}) {
  const { mode = 'execute', sprintLog } = opts;

  // Extract SCAFFOLD block
  const scaffoldMatch = tlOutput.match(/===SCAFFOLD===\n([\s\S]*?)===END_SCAFFOLD===/i);

  if (!scaffoldMatch) {
    sprintLog?.('TL', 'No scaffold block found in output — will use default structure');
    return { files: [], created: false };
  }

  const scaffoldContent = scaffoldMatch[1].trim();
  const lines = scaffoldContent.split('\n').map(l => l.trimEnd()).filter(Boolean);

  const files = [];
  const dirs = new Set();

  // Parse scaffold structure
  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) continue;

    // Calculate indentation level
    const indent = line.search(/\S/);
    const trimmed = line.trim();

    // Determine if it's a directory (ends with /) or file
    const isDir = trimmed.endsWith('/');
    const path = trimmed.replace(/\/$/, '');

    if (isDir) {
      dirs.add(path);
    } else if (trimmed.includes('.')) {
      // It's a file (has extension)
      files.push(path);
      // Add parent directory
      const parentDir = path.substring(0, path.lastIndexOf('/'));
      if (parentDir) dirs.add(parentDir);
    } else {
      // It's a directory without trailing slash
      dirs.add(path);
    }
  }

  // In simulate mode, don't create files
  if (mode === 'simulate') {
    sprintLog?.('TL', `Scaffold planned: ${dirs.size} dirs, ${files.length} files (simulation — no files created)`);
    return { files, created: false, dirs: Array.from(dirs) };
  }

  // Create directories
  for (const dir of dirs) {
    const fullPath = join(projectDir, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
    }
  }

  // Create starter files
  const createdFiles = [];
  for (const filePath of files) {
    const fullPath = join(projectDir, filePath);

    // Skip if file already exists
    if (existsSync(fullPath)) continue;

    // Generate starter content based on file extension
    const ext = filePath.split('.').pop()?.toLowerCase();
    const starterContent = generateStarterContent(filePath, ext);

    writeFileSync(fullPath, starterContent);
    createdFiles.push(filePath);
  }

  // Create default package.json if not included
  const packageJsonPath = join(projectDir, 'package.json');
  if (!existsSync(packageJsonPath) && !files.includes('package.json')) {
    const defaultPackageJson = {
      name: 'ai-sprint-project',
      version: '1.0.0',
      description: 'Generated by AI Software Company Sprint',
      main: 'src/index.js',
      scripts: {
        start: 'node src/index.js',
        test: 'jest',
      },
    };
    writeFileSync(packageJsonPath, JSON.stringify(defaultPackageJson, null, 2));
    createdFiles.push('package.json');
  }

  sprintLog?.('TL', `Scaffold created: ${dirs.size} dirs, ${createdFiles.length} files`);
  return { files: createdFiles, created: true, dirs: Array.from(dirs) };
}

/**
 * Generate starter content for common file types
 */
function generateStarterContent(filePath, ext) {
  const fileName = filePath.split('/').pop();

  const templates = {
    js: `// ${fileName}
// Auto-generated by AI Software Company Sprint

module.exports = {
  // TODO: Implement
};
`,
    ts: `// ${fileName}
// Auto-generated by AI Software Company Sprint

export interface ${toPascalCase(fileName.replace('.ts', ''))}Config {
  // TODO: Define interface
}

export function ${toCamelCase(fileName.replace('.ts', ''))}(): void {
  // TODO: Implement
}
`,
    json: `{
  "name": "${fileName.replace('.json', '')}",
  "version": "1.0.0"
}
`,
    md: `# ${fileName.replace('.md', '')}

Auto-generated by AI Software Company Sprint.

## Overview

TODO: Add documentation
`,
  };

  return templates[ext] || `// ${fileName}\n// Auto-generated by AI Software Company Sprint\n`;
}

function toPascalCase(str) {
  return str
    .split(/[-_\s]+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

function toCamelCase(str) {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
