# Sentinel Treasury — Frontend Design Spec

**Scope:** the dashboard described in §10 of the technical spec.
**Status:** direction locked (dark command-center). Per-panel patterns drafted from reference review. Open decisions tracked in §11.
**Companion docs:** `Sentinel-Treasury-Technical-Spec.md` (data shapes, demo flow), `Sentinel-Treasury-Build-Resources.md` (libraries, endpoints).

---

## 1. Design north star

The dashboard has exactly one job: make a non-expert *instantly* see that an AI agent **perceived → decided → acted with real money under hard limits → and proved it**, and feel the 3-second demo beat land — price shock → agents argue → consensus → live `deploy_hash` → green `✔ on-chain` receipt.

Everything below is in service of that. The agent is the protagonist; the UI is its stage. When a choice is unclear, pick the option that makes the perceive→decide→act→prove story more legible.

"Minimalist" here does **not** mean few elements — there are nine panels of dense live data. It means **ruthless hierarchy**: one protagonist on screen at a time, everything else quiet.

---

## 2. Aesthetic direction

- **Dark command-center.** Near-black surfaces, cards with almost-invisible borders, a faint ambient corner glow. Reads naturally for an autonomous on-chain agent and lets the climax moments (`✔ on-chain`, the live `deploy_hash`) pop.
- **Data is the decoration.** Hashes, basis points, USD figures, and the `deploy_hash` are the texture. No gratuitous gradients, illustrations, or marketing glow *inside* the dense dashboard.
- **Calm density.** Borrow the structure of a trading terminal, not its volume. No ALL-CAPS walls, no rainbow sliders, no flashing.
- **Restraint as trust.** A treasury that manages real money should look composed. Sobriety is a feature.

---

## 3. Information architecture & layout

A persistent **top bar** plus a **three-zone body**. The eye reads left → center → right as **state → reasoning → proof**, which is the perceive→decide→act→prove loop laid out in space.

```
┌─────────────────────────────────────────────────────────────────────┐
│ TOP BAR:  ◆ Sentinel   [Perceive·Decide·Act·Prove stepper]           │
│           [Scenario · demo]   [Pause]   Testnet · vault funded       │
├──────────────┬──────────────────────────────────┬───────────────────┤
│ STATE & TRUST│       LIVE REASONING → ACTION     │       PROOF       │
│ (left rail)  │            (center, wide)         │    (right rail)   │
│              │                                   │                   │
│ Allocation   │   Debate  (Scout/Risk/Treasury,   │   Receipt feed    │
│ Guardrails   │            consensus / fallback)  │   (append-only,   │
│ x402 meter   │   Decision card                   │    verify ↗)      │
│              │   Action card (TransactionV1,     │                   │
│              │     live deploy_hash, cspr.live↗) │                   │
└──────────────┴──────────────────────────────────┴───────────────────┘
```

| Zone | Loop role | Panels (§10) | Temperament |
|---|---|---|---|
| Top bar | where-are-we + controls | Loop visualizer (2), Scenario (9), Pause | Persistent, calm |
| Left rail | **state & trust** | Allocation (1), Guardrails (7), x402 meter (8) | Quiet, slow-changing |
| Center | **reasoning → action** | Debate (3), Decision (4), Action (5) | **Protagonist** — the only thing that moves |
| Right rail | **proof** | Receipt feed (6) | Accumulates; the payoff |

Rationale: the center column is the only protagonist, so the allocation / guardrails / x402 / receipt panels sit quieter around it. The loop stepper lives in the top bar as a persistent "where are we in the cycle" indicator. The scenario trigger gets its own visibly-tagged demo treatment (see §8).

**Responsive:** below ~1100px, collapse the two rails beneath the center column (state → reasoning → action → proof, stacked) so the narrative order survives. The dashboard is a presentation surface first; desktop is the primary target.

---

## 4. Visual language

### 4.1 Color — semantic, not decorative

The product has a built-in color meaning we exploit instead of defaulting to "green because crypto." **Color encodes regime and result**, so a glance reads as state.

| Meaning | Color | Used for |
|---|---|---|
| Calm / healthy / confirmed | **Green** | Calm regime pill, `Stake` (grow) actions, `✔ on-chain` receipts, consensus reached |
| Elevated / caution | **Amber** | Elevated regime pill, fallback-engaged flag, "near cap" warnings |
| Stressed / defensive / failed | **Coral-red** | Stressed regime pill, `SwapToStable` (de-risk) actions, `Reverted` results |
| In-progress / neutral action | **Info (cool blue) / white** | Agent currently signing/submitting, active loop stage, `NoOp`/`Skipped` |
| Structure | **Neutral grays** | Surfaces, borders, inactive states, secondary text |

Notes:
- **One accent per quiet column.** Borrow Stella's trick: a column of neutral cards with a single accented card draws the eye. Use it to make the *current regime* or *drift* the focal point of the left rail — not to paint every card.
- Green appears for both "calm regime" and "on-chain confirmed." That overlap is intentional and consistent (both mean "good"), not a conflict.
- Keep the green ambient glow *off* the dense panels; reserve any glow for the README / submission landing page only.

### 4.2 Typography

A two-family pairing does almost all the work:

- **UI grotesk** for everything human-readable (labels, headings, prose, agent rationale). A clean neutral grotesk — Inter / Geist / similar. Two weights only: regular and medium.
- **Monospace** for every machine value: `deploy_hash`, contract addresses, amounts, basis points, hashes, timestamps. The mono is what makes the dashboard read "on-chain" without any extra chrome — it's the cheapest, highest-impact decision in the doc. JetBrains Mono / Geist Mono / IBM Plex Mono.

Sentence case throughout. No ALL-CAPS (the reference terminals over-use it).

### 4.3 Surface, density, spacing

- Near-black page; cards one step lighter with 0.5px borders that are almost invisible.
- Generous internal padding; let panels breathe so density never reads as clutter.
- Numbers right-aligned in any tabular context; round every displayed float.
- Corner radius consistent (medium for controls, large for cards).

### 4.4 Motion discipline

**Only two things ever move,** so that motion *means* "the agent is thinking / acting":

1. The **loop stepper** advancing through Perceive → Decide → Act → Prove.
2. The **debate** streaming in turn by turn.

Plus two punctuation moments: the `deploy_hash` appearing live in the Action card, and the green receipt badge **snapping in** to the feed (the payoff). Everything else is static. `Pause` produces an immediate, unmistakable visual lock (dim the center column + a paused banner).

---

## 5. Panel specifications

Each panel: what it shows · data source (from the technical spec) · reference borrowed · key states.

### 5.1 Allocation panel `(left rail)`
- **Shows:** live sCSPR / csprUSD / CSPR weights in USD; target vs. actual; drift. Default bands: Calm ~60/40, Stressed ~20/80; small fixed CSPR buffer (50–100) excluded from allocation math.
- **Data:** `AllocationBps {scspr, csprusd, cspr}` (sums to 10000); USD normalization via Styks TWAP (§7.1).
- **Reference:** Stella stat-card column + single accented card for the focal metric (current regime / drift).
- **States:** within-band (neutral), drifting (target vs. actual diverge), rebalancing (post-action animates toward target).

### 5.2 Loop visualizer `(top bar)`
- **Shows:** Perceive → Decide → Act → Prove with per-stage live status and timing.
- **Data:** orchestrator loop state.
- **Reference:** process/pipeline stepper patterns.
- **States:** active stage highlighted (info/white); completed stages quiet; idle between cycles.

### 5.3 Debate panel `(center — the protagonist)`
- **Shows:** streaming Scout / Risk / Treasury turns (proposal → critique → revision), a **consensus** badge, and a **fallback** flag when the rule engine takes over.
- **Data:** `Decision.transcript: DeliberationTurn[]` (verbatim); `RiskVerdict` (regime, riskScore 0–100, drivers, hardLimits, rationale); `AllocationProposal` (targetBps, action, expectedSlippageBps, rationale). `source: 'llm' | 'fallback'`.
- **Reference:** AI-agent / copilot trace UIs (this panel has the least crypto prior art — pull it from AI tooling, not DeFi dashboards).
- **States:** streaming; consensus reached (green badge); fallback engaged (amber flag, `consensus:false`); revision round in progress.

### 5.4 Decision card `(center)`
- **Shows:** chosen regime, target bps, the single concrete action, expected slippage.
- **Data:** `Decision.regime`, `finalAction: RebalanceAction`, `AllocationProposal.expectedSlippageBps`.
- **Reference:** trading-terminal order summary (calmed down).
- **States:** proposed → confirmed by consensus → handed to execution.

### 5.5 Action card `(center)`
- **Shows:** the `TransactionV1` being signed/submitted; the **live `deploy_hash`**; a **cspr.live Testnet** deep link.
- **Data:** `RebalanceAction {kind, asset, amount, target, minOut}`; execution status (signing → submitted → finalized) via casper-js-sdk; `deploy_hash`.
- **Reference:** BET SAFU order panel — one unmistakable commit zone + the live-ticking "this is happening now" texture.
- **States:** building → signing (bounded agent key) → submitted (hash appears) → finalized → reverted (coral).

### 5.6 Receipt feed `(right rail)`
- **Shows:** append-only list, newest on top; one-click **verify** (recompute blake2b hashes + open the deploy on cspr.live).
- **Data:** `Receipt {action_id, timestamp, action_kind, regime, perception_hash, decision_hash, pre/post_alloc_bps, amount, notional_usd, target, deploy_hash, result, cspr_usd_twap}`; result ∈ Success | Reverted | Skipped.
- **Reference:** Vaulta "Recent Withdraws" list — swap Success/Failed badges for `✔ on-chain` / `Reverted` / `Skipped`.
- **States:** new receipt snaps in (green); verify in progress; verified (hashes match); reverted (coral). Append-only — nothing ever edits or disappears.

### 5.7 Guardrail panel `(left rail)`
- **Shows:** per-action cap, daily cap **used / remaining**, contract whitelist, slippage ceiling, agent-key weights (1 / 3), owner **Pause** button.
- **Data:** `PolicyConfig`, `day_spent_usd` / `day_remaining_usd`, `whitelist`, associated-key weights (§4.3).
- **Reference:** Vaulta "Daily Limit · $1,200 used from $2,000" segmented meter — the single best find for this panel; use it almost unchanged for the daily cap.
- **States:** healthy; approaching cap (amber); paused (Pause active dims the whole center column).

### 5.8 x402 meter `(left rail)`
- **Shows:** paid pulls this session, CSPR spent, last settle tx.
- **Data:** x402 client log; settle `deploy_hash`.
- **Reference:** usage-meter / credits-balance patterns; keep it small.
- **States:** idle; paid pull in progress; budget guard tripped (amber).

### 5.9 Scenario controls `(top bar — demo only)`
- **Shows:** inject a labelled price-shock / liquidity-crunch to trigger a cycle.
- **Data:** scenario injection into the perception layer.
- **Reference:** none — deliberately styled *apart* from the real controls.
- **States:** see §8 (honesty treatment). Must never look like a "real" control.

---

## 6. Component & state inventory

Small, reusable atoms used across panels:

- **Regime pill:** Calm (green) · Elevated (amber) · Stressed (coral).
- **Result badge:** `✔ on-chain` (green) · `Reverted` (coral) · `Skipped` (neutral).
- **Source flag:** `consensus` (green) · `fallback` (amber).
- **Action chip:** Stake / SwapToRisk (green-leaning grow) · SwapToStable / Unstake (coral-leaning protect) · NoOp (neutral).
- **Hash chip:** monospace, truncated (`0x7f…a3`), copy + cspr.live link.
- **Cap meter:** segmented used/remaining bar (Vaulta pattern).
- **Loop stage:** active / done / idle.

---

## 7. The demo choreography (the 3-second beat)

The layout must choreograph §15.1 so the climax is unmistakable, reading roughly center-top → center → right:

1. Scenario injected → loop stepper jumps to **Perceive**; x402 meter ticks one paid pull.
2. **Debate** streams: Scout snapshot → Risk flags `Stressed` → Treasury proposes 20/80.
3. **Consensus** badge snaps green in the debate panel → stepper advances to **Act**.
4. **Action card** shows the `TransactionV1`; the live **`deploy_hash`** appears.
5. Stepper hits **Prove**; a green **`✔ on-chain` receipt** snaps into the feed with a **verify ↗** link.
6. (Reverse) calm scenario → agent **stakes** back toward 60/40 → second receipt.
7. Owner presses **Pause** → center column dims, paused banner → unpause.

The choreography is the product demo. Design the timing so a viewer's eye is pulled through those five steps without instruction.

---

## 8. Honesty treatment

Per §15.3, the injected **market event** is the only simulated thing; everything downstream (reasoning, the capped on-chain tx, the x402 settlement, the receipt) is real on Testnet. The UI must make this honest:

- Scenario controls are **visibly labelled `demo`** and styled distinctly from real controls (warning-tinted, separated, never blended into the live action bar).
- A small persistent `Testnet` tag in the top bar.
- The receipt feed shows real `deploy_hash` links so the "real" half is always one click from verification.

---

## 9. Reference board (Dribbble)

| Image | Borrow | Avoid |
|---|---|---|
| **Stella** (defi) | Shell: near-black restrained cards, faint corner glow; stat-card column; single-accented-card focal trick; green/red chart styling | — (this is the base register) |
| **Vaulta** (fintech) | **Daily-limit segmented meter** → guardrail daily cap; "Recent Withdraws" status-badge list → receipt feed | Card/credit-card visuals; consumer warmth |
| **BET SAFU** (trading terminal) | Order-panel commit zone → Action card; live sub-second ticking → deploy texture; dense-table structure | ALL-CAPS everywhere; rainbow slider; overall volume |
| **Multichain** (web3) | File under **README / submission landing**: dark + green glow brand mood, bright-green CTA, highlighted-tier emphasis | Keep marketing glow *out* of the dense dashboard |

**Through-line:** all four are dark → shell decision is dark. Three use green as generic "profit"; we upgrade green to *semantic* (calm/confirmed) and pair it with coral (stressed/reverted), per §4.1.

---

## 10. Implementation hooks

From the build-resources doc, so the design is buildable:

- **Framework:** React / Next.js.
- **Wallet connect + signing patterns:** CSPR.click (`docs.cspr.click`) for the demo's manual owner actions (Pause/unpause).
- **Live feed:** CSPR.cloud **Streaming API (SSE)** drives the receipt feed, loop stepper, and balance updates in real time.
- **Charts:** Recharts / Chart.js for the allocation panel and any drift-over-time view.
- **Receipt verify:** blake2b (`blakejs`) + `canonicalize` to recompute `perception_hash` / `decision_hash` client-side; cspr.live Testnet deep links for the on-chain half.
- **Explorer links:** `testnet.cspr.live` for every `deploy_hash`.

---

## 11. Open decisions

1. **Exact accent for "calm vs. confirmed" green** — one green or two distinct greens for regime vs. on-chain status. (Leaning: one green, context disambiguates.)
2. **Font choices** — pick the final grotesk + mono pair from the §4.2 candidates.
3. **Drift visualization** — donut + delta bars vs. a small drift-over-time line in the allocation panel.
4. **Receipt density** — Vaulta-style compact list vs. a denser BET-SAFU-style table once receipts accumulate.
5. **Left vs. right rail for proof** — current draft puts proof on the right (reads last); revisit if the demo eye-path wants it center-adjacent.

---

*Captured from the design planning session. Next step: re-render the zoning wireframe in the dark palette with real weighting, then build out panel by panel.*
