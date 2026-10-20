# Stage N: <short title>

> One report per stage. Raw runs come from `npm run load -- <scenario>` (written to
> `load/results/`, not committed); paste the relevant tables here.

## Scenario

- **Scenario:** `<name>` (`load/scenarios/<name>.js`): what it proves, in one line
- **Shape:** VUs, ramp, duration
- **Flags:** e.g. `HOLD_STRATEGY=naive` vs `HOLD_STRATEGY=atomic`
- **Commit / tag:** before `<sha>`, after `<sha>`

## Machine

| | |
|---|---|
| Host | |
| CPU | |
| Memory | |
| Docker | |

## Results

| Route | Metric | Before | After |
|---|---|---:|---:|
| `<route>` | RPS | | |
| | p50 / p95 / p99 | | |
| | Errors (excl. expected 409/429) | | |

**Correctness:** seats sold twice, double charges, issued orders without tickets: before / after.

## Analysis

What the numbers show, why, and the trade-off accepted.

**Current bottleneck:** where the next limit is, and how it was identified.
