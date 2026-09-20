# Specialist Reviewer Activation Catalog

The orchestrator reads the full diff and uses judgment (not keyword matching) to decide which specialists to activate. This catalog defines the signals to reason about.

## Always-On (no condition required)

The base /check skill runs as always-on. Specialist reviewers are additive.

## Conditional Specialists

### Security Reviewer

**Agent file:** `agents/reviewer-security.md`
**Activate at:** Standard or Deep depth

Activate when the diff changes code an attacker could reach or influence: trust-boundary input, auth or crypto, credentials, or query/shell/path construction.

**Do not activate** for: pure UI changes, config file updates, test-only changes, documentation.

### Architecture Reviewer

**Agent file:** `agents/reviewer-architecture.md`
**Activate at:** Standard or Deep depth

Activate when the diff changes how modules relate: boundaries, public APIs or signatures, cross-module dependencies, or a major dependency, rather than logic inside one module.

**Do not activate** for: single-file bug fixes, test additions, style changes, documentation updates.

## Adversarial Pass (Deep only)

No dedicated agent file. When the environment has an agent facility, the orchestrator runs the four angles as parallel agents, each blind to the others' findings; otherwise it runs them as an extra reasoning pass after all findings are collected.

**Activate at:** Deep depth only; the Deep criteria live in SKILL.md's Scope table.

Adversarial pass asks: "If I wanted to break this system through this specific diff, what would I do?"

Four attack angles:
1. **Assumption violation** -- What does this code assume is always true? (format, ordering, range) What happens when it is not?
2. **Composition failures** -- What breaks when this new code interacts with the existing system under concurrent load or partial failure?
3. **Cascade construction** -- What sequence of valid operations leads to an invalid state?
4. **Abuse cases** -- What happens on the 1000th request, during a deployment, with two users editing the same resource simultaneously?

Report adversarial findings with confidence score; the suppression threshold lives in SKILL.md's Adversarial Pass section.
