Type: grilling
Status: open
Blocked by: 01

# Which System One gates ship, on by default, and with which thresholds

## Question

The ExecPlan builds four gates (rules ledger, prefetch, value score, tool gate), each behind its own flag. Decide:

1. Which gates default on. Resolved 2026-10-11 by the user: all four default on, with per-gate `--no-optchat-*` opt-outs (plan Decision Log).
2. Thresholds: rule add 0.8 (`--optchat-rule-add`), tool-gate ask 0.3 (`--optchat-tool-ask`), prefetch top-k 8 and minimum 0.5 (`--optchat-prefetch-k`, `--optchat-prefetch-min`), and the value-hint bound of 2 s. Confirm or replace each.
3. Whether the tool gate blocks without a UI (the plan says yes), and whether an ask band returns for rules (the plan says no: announce and remove instead).
4. Whether the demo needs any gate on by default.

Weigh demo value, risk, and what ticket 01 finds about Jev's limits from this host. Record each answer as an `## Answer` section, and fold it into the ExecPlan's Decision Log.
