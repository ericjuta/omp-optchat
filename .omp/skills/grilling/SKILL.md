---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round. Then wait for the user's answers before the next round.

## Asking a round

- **Multiple-choice frontier questions** with discrete options (2-5 each): ask them in one `ask` tool call, one question per item, with each option's `recommended` flag set on your recommended answer. Put the rationale for the recommendation in the question text, not in a hidden note.
- **Open questions** (no fixed set of answers) and any question that needs more than a choice: number them and give your recommended answer in markdown. Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

## Facts versus decisions

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, docs, running code), start a `task` subagent to find it (default agent, or `scout` for read-only lookups). Don't ask the user for anything you could look up yourself. Give each subagent the exact question and the files or URLs to check, and ask it to report the answer with a tag: **runtime-observed**, **source-read**, or **[INFERENCE]**.

Subagent results auto-deliver; you do not wait for them. A running exploration is an unsettled prerequisite, so only the questions downstream of it wait for its report; ask the rest of the frontier now. When the report lands, recompute the frontier.

The _decisions_ are the user's: put each to them and wait. Never answer a decision question yourself, even when the answer seems obvious; record your recommendation and let the user accept or change it.

## Done

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
