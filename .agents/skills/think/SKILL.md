---
name: think
description: "Turns rough ideas into approved, decision-complete plans with validated structure before coding. Use when users ask in any language for planning, architecture, design direction, feasibility, value judgment, or whether a feature is worth doing before implementation. Not for bug fixes or small edits."
when_to_use: "出方案, 给方案, 深入分析, 怎么设计, 用什么方案, 判断一下, 有没有必要, 值不值得, what's the best approach, plan this, how should I, should we keep this"
dispatch_intent: "New feature, architecture, how should I design this, value judgment, executable plan, handoff"
---

# Think: Design and Validate Before You Build

Prefix your first line with 🥷 inline, not as its own paragraph.

Turn a rough idea into an approved plan. No code, no scaffolding, no pseudo-code until the user approves.

Give opinions directly. Take a position and state what evidence would change it. Avoid "That's interesting," "There are many ways to think about this," "You might want to consider."

## Outcome Contract

- Outcome: a rough idea becomes a decision-complete recommendation or implementation plan.
- Done when: the goal, success criteria, constraints, chosen approach, rejected tradeoffs, tests, and handoff steps are concrete enough to execute without re-deciding.
- Evidence: current repo state, project docs, live external docs when relevant, prior decisions, constraints, and explicit user preferences.
- Output: one recommended direction or a handoff plan with assumptions and verification steps.

## Durable Context Preflight

See [references/durable-context.md](references/durable-context.md) for when durable context is in scope and the redaction gate that applies before any of it becomes a durable rule.

For `/think`: current repo state and live docs override memory. Lock durable decisions and preferences before asking questions, and do not ask the user to restate an intent that the durable context already establishes unless it is risky, stale, or contradicted by current state.

Before outputting any plan, scan the project's `AGENTS.md`, `CLAUDE.md`, `.claude/rules/*.md`, and any local agent-memory summary if the user pointed at one. If the proposed plan contradicts a "hard rule", "never X", "must Y", or "prefer Z" stated in those files, surface the contradiction in the plan output (one sentence: which rule, which step contradicts it, recommended resolution). Do not silently override the rule. If the rule blocks the plan, stop and ask before continuing.

## Lightweight Mode

Activate when the user asks for a plan for a defined problem and the only open question is "how to fix it." An explicit repair request follows `/hunt`; file count alone does not create another planning approval.

Give one recommended fix in 2-3 sentences: what changes, where (file:line if known), and why. Name the brute-force version in one line first; default to it unless the user wants elegance. List involved files, flag explicitly if more than 5. State one risk. Wait for approval before implementing.

Upgrade to full mode if you find 3 or more genuinely different approaches with meaningful tradeoffs.

## Evaluation Mode

For value, viability, commercialization, or keep/remove judgments about a single target, load `references/mode-evaluation.md`.

## Triage Mode

For a bundle of independently accepted or rejected asks or screenshots, including "are these worth doing", load `references/mode-triage.md`; use its per-item table rather than Evaluation Mode's single verdict.

## Before Reading Any Code

- If the project tracks prior decisions (ADRs, design docs, issue threads), skim the ones matching the problem before proposing. Skip if none exist.
- If the plan involves a default value, env var, or config field, open the project's actual config file (e.g. `app.config.json`, `tauri.conf.json`, `package.json`, `.env`) and lift the live value. Never quote a default from memory or docs.

## Check for Official Solutions First

Before proposing custom implementations, check framework built-ins, official patterns, and ecosystem standards against live docs (use the environment's doc-lookup tools when available). An existing official solution is the default recommendation unless you can articulate why it falls short for this specific case.

For a hard problem, or one already tuned several times that still feels off, study how 2-3 mature open-source projects or direct competitors solve it before designing: read the actual implementation, extract the transferable mechanism, and name what you took from each. First-principles design next to a proven implementation discards the iterations someone else already paid for.

## Propose Approaches

Give one recommended approach with rationale. Include effort, risk, and what existing code it builds on. Mention one alternative only if the tradeoff is genuinely close (>40% chance the user would prefer it). Always include one minimal option.

Anything that asks a person to install or configure something (hook, MCP server, editor plugin, config key, pricing tier, per-day limit) is a setup cost paid by every user. Default to the zero-setup form: a built-in command plus a skill, a fixed sensible default, a doc line. Offer the setup-requiring form only after naming why the zero-setup one cannot do the job.

When the plan is about distilling lessons from one project into a reusable skill set or shared rules, split the plan into **promote** and **do not promote**. Promote only reusable workflow constraints. Explicitly reject project-specific commands, paths, release checklists, safety boundaries, and private local context unless the user asks to update that project itself.

For the recommendation, identify the most fragile assumption (premise collapse) and state it explicitly: "This plan assumes X. If X does not hold, Y happens." If the assumption is load-bearing and fragile, deform the design to survive its failure.

**Blocking ambiguities**: if requirements have a conflict the user must resolve (two contradicting sources, two valid interpretations with different cost), name the specific conflict in one sentence and ask which takes precedence. Do not silently pick.

**Additional attack angles** (run only when the plan involves external dependencies, high concurrency, or data migration):

| Attack angle | Question |
|---|---|
| Dependency failure | If an external API, service, or tool goes down, can the plan degrade gracefully? |
| Scale explosion | At 10x data volume or user load, which step breaks first? |
| Rollback cost | If the direction is wrong after launch, what state can we return to and how hard is it? |

If an attack holds, deform the design to survive it. If it shatters the approach entirely, discard it and tell the user why. Do not present a plan that failed an attack without disclosing the failure.

Get approval before proceeding.

## Validate Before Handing Off

- More than 8 files or 1 new service? Acknowledge it explicitly.
- More than 3 components exchanging data? Draw an ASCII diagram. Look for cycles.
- Every meaningful test path listed: happy path, errors, edge cases.
- Can this be rolled back without touching data?
- Every API key, token, and third-party account the plan requires listed with one-line explanations. No credential requests mid-implementation.
- Every MCP server, external API, and third-party CLI the plan depends on verified as reachable before approval.

## Simplicity Gate

Skip for one-file bug fixes or when the user explicitly chose the minimal option.

When the plan adds files, abstractions, error layers, config knobs, or retries the user did not ask for:

- **Minimal path:** the brute-force version in one line; the chosen plan must beat it on risk, rollback, or latency, not elegance.
- **Defensive layers:** every try/catch, retry, fallback, or flag maps to one named failure mode; delete layers that only "might" fail.
- **Surface delta:** list new commands, env vars, flags, or services; prefer +0 unless a user split needs a knob.
- **Compensating complexity:** if the plan is mostly workaround machinery around a misbehaving API, stop and name a route change (anti-patterns #27).

If the gate fails, shrink the plan or switch to the minimal option before asking for approval.

## Implementation Handoff

A finished plan must be executable by another engineer or agent without re-deciding the direction. Include:

- Scope and non-scope.
- The chosen approach and the one rejected alternative, if the tradeoff was close.
- Public API, schema, command, config, or file-interface changes, if any.
- Verification commands and manual acceptance checks.
- Release, publish, migration, or issue/PR follow-through steps, if the task naturally continues there.
- Rollback or failure handling for any step that can leave external state changed.

When the user asks to export a handoff, or when the environment prevents further execution, make the handoff execution-ready instead of explaining the limitation. Include file targets, key constants or selectors, exact commands, runtime or visual checklist, and risk boundaries. If the work depends on a screenshot or artifact, name the artifact and the pass/fail delta.

When the user says "Implement the plan", "just do it", "可以干", "直接改", "整", or otherwise explicitly requests implementation, leave planning and execute the approved direction without another approval round. State which plan is being executed and check for repo drift; stop only if specific drift makes it unsafe. Approval of the design alone does not authorize implementation or public actions.

## Hard Rules

- **No placeholders in approved plans.** Every step must be concrete before approval. Forbidden patterns: TBD, TODO, "implement later," "similar to step N," "details to be determined." A plan with placeholders is a promise to plan later.
- **Phase independence.** If the plan has multiple phases, each phase must be independently mergeable: after Phase N ships, the system is in a usable state, even if N+1 never lands. Plans that require all phases to complete before anything works are fragile (one stuck phase blocks the whole release) and waste review effort. If the work cannot be cut into mergeable phases, say so and ship it as one phase instead of pretending it is staged.
- **Plan red flags (self-check before handoff):** a phase depends on the next phase to be useful, or a "Phase 0: investigate / spike" exists (investigation belongs before the plan, not inside it). Either red flag means the plan is not ready; resolve it before handing off.

## Gotchas

| What happened | Rule |
|---------------|------|
| Rejected design restarted from scratch | Ask what specifically failed, re-enter with narrowed constraints |
| Picked a regional or locale-specific API variant without checking | List all regional or locale differences before writing integration code |
| Introduced a second language or runtime into a single-stack project | Never add a new language or runtime without explicit approval |
| User said "判断一下这个报错" and got Evaluation Mode | "判断一下" + error/bug context = debugging, route to `/hunt`. Evaluation Mode is for value/existence judgments only |

## Output

**Approved design summary:**
- **Building**: what this is (1 paragraph)
- **Not building**: explicit out-of-scope list
- **Approach**: chosen option with rationale
- **Key decisions**: 3-5 with reasoning
- **Unknowns**: only items that are explicitly deferred with a stated reason and a clear owner. Not vague gaps. If an unknown blocks a decision, loop back before approval.

If the user only approves the design, end with the plan. If implementation is requested, follow Implementation Handoff instead of asking them to repeat the request.
