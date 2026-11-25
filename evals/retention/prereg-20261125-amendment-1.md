# Amendment 1 to prereg-20261125.md (2026-11-25)

Written after two paid cells and before any view-arm answer was seen.

## What happened

- `s1-512-off` completed: 23 of 24 correct, no compaction, $1.18.
- `s1-512-on-128000` failed during the memory build, before any question was asked: "seeding did not settle", with 10 refused compressor admissions. It spent $0.50 on compressor calls. Its artifact is kept as `cell-s1-512-on-128000.failed-1.json`, and its spend counts against the budget.

## Cause

The driver passed `--compressor-share 0.25` with an $8 cap, so the build host could reserve $2. The runner holds every in-flight compressor call at the worst case of a main-model fallback call ($0.26). Eight concurrent calls need $2.10, so the runner refused admissions. OptChat treats a refused call as a provider failure and pauses the compressor, and the runner reports a stall after 120 seconds without progress. This is a fault in the driver's limits, not a finding about the view.

## Change

- Every on-arm cell: cap $12 instead of $8, and `--compressor-share 0.4` instead of 0.25. The build host can then reserve $4.80.
- The failed cell is rerun under its original name.

Nothing else changes: the total cap stays $40, and the models, corpus, lengths, arms, seeds, report and decision rules stay as preregistered. With the larger caps the budget may stop before a third seed completes.
