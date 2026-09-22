# Engine B — the Telegram copy engine (`telegram-sfxauusd1-copy-v1`)

Written for the operator running this application and for the next engineer
to touch it.

## What it is

A second, independent strategy engine inside the same application as the RSI
M1/M5 engine (Engine A). It copies structured trade signals published by one
Telegram channel, `@SFxauusd1`, onto the same MT5 DEMO account.

The two engines share an account and a database. They share no strategy rule,
no magic number, no table and no schedule.

## The one thing to understand

**Engine A's trading schedule does not apply to Engine B.**

Engine A pauses new entries 14:00–19:00 and 23:30–01:00 Beirut, and stops
entering on Friday at 23:00. Those are Engine A strategy rules. A valid, fresh
Telegram signal published at 14:05, 16:00, 18:59 or 00:30 Beirut is executed
then. There is no `SCHEDULE_BLOCKED` outcome in this engine, and the
availability verdict type has no member that could express one.

What Engine B does still require is that an order is physically possible: the
terminal connected to the right DEMO account and permitted to trade, the
broker's XAUUSD session genuinely open, the symbol tradable, a fresh
executable quote, and enough free margin.

## The runtime path

```
@SFxauusd1 publishes
  → MTProto update (GramJS, user session)      gramjs-client.ts
  → receipt instant captured at the edge
  → channel identity verified by numeric id    channel-guard.ts
  → raw ingestion recorded                     ingestion.service.ts
  → parser                                     parser.ts
  → duplicate / freshness / TP1 / legs         execution.service.ts
  → leg rows PENDING, claimed by the collector leg-queue.service.ts
  → MT5 order_send, source SL and TP           collector: executor.py
  → reconciliation against broker truth        reconciliation.service.ts
```

Nothing polls. Updates are pushed by Telegram and processed on arrival; a
30-second poll would spend a quarter of the 60-second budget doing nothing.

## The rules

| Rule | Value |
|---|---|
| Source | `@SFxauusd1`, verified by **numeric channel id**, not username |
| Message must contain | symbol, one direction, explicit entry, explicit SL, ≥1 TP |
| Lifetime | 60 s from **publication**, re-checked before **each leg**, and again at collector claim and at `order_send` |
| Size | 0.01 lot **per take profit** |
| Positions | one independent position per take profit, one signal group |
| Entry protection | **adverse only** — `TELEGRAM_MAX_ADVERSE_ENTRY_DEVIATION_USD`, default $1.50 |
| Favourable movement | always allowed, up to TP1 |
| TP1 | nearest target; once reached, the signal is permanently spent |
| Duplicates | exact `(channelId, messageId)` + semantic repost within 30 min |
| Occupancy | one Telegram signal group at a time (legs of one signal coexist) |
| Magic number | `262610210` |

Brackets are **copied**, not computed. Engine B does not build Engine A's
$5/$5 bracket; it submits the stop and targets the channel published, and
refuses if the broker would reject them rather than widening them to fit.

### TP1 and favourable entry, concretely

For `SELL 4338, SL 4348, TP1 4329, TP2 4300`:

| Market | Result |
|---|---|
| 4338 | eligible (at the published entry) |
| 4337, 4335, 4330 | eligible — favourable, moving toward the target |
| 4339.50 | eligible — $1.50 adverse, at the bound |
| 4341 | refused — `TELEGRAM_ADVERSE_ENTRY_DEVIATION` |
| 4329 or below | cancelled — `TELEGRAM_TP1_ALREADY_REACHED` |
| touched 4328, back to 4334 | still cancelled — the touch is a permanent latch |

Mirrored for BUY. A touch between legs cancels the remaining legs and leaves
the already-submitted ones alone; Engine B does not close leg 1 because leg 2
was cancelled.

## Outcomes you will see

| Outcome | Meaning |
|---|---|
| `SUBMITTED` | at least one leg reached the broker |
| `DISCARDED_NOT_SOURCE` | another channel, chat or DM; not recorded as a signal |
| `DISCARDED_NOT_A_SIGNAL` | chat, commentary or a results post |
| `TELEGRAM_DUPLICATE_SIGNAL` | same message or same trade reposted; consumed |
| `TELEGRAM_SIGNAL_EXPIRED` | past 60 s; consumed permanently |
| `TELEGRAM_TP1_ALREADY_REACHED` | the move has happened; group cancelled |
| `TELEGRAM_MARKET_CLOSED` | broker XAUUSD closed or unknown; consumed permanently |
| `TELEGRAM_UNAVAILABLE` | permissions, quote, symbol, kill switch or recovery |
| `TELEGRAM_LEGS_REFUSED` | adverse deviation, or the broker would reject a level |
| `TELEGRAM_INSUFFICIENT_MARGIN` | checked for the whole group, against shared account margin |
| `TELEGRAM_OCCUPIED` | another signal group is in flight |
| `TELEGRAM_NOT_SUBMITTING_MODE` | every gate passed; mode is OFF/SHADOW or the engine switch is off |

**A closed market is terminal.** The signal is recorded, skipped and consumed.
It is never queued for reopening and never replayed on Monday. This is true of
weekend closure too — Engine B has no Friday cutoff of its own and does not
inherit Engine A's.

## Controls

| Variable / file | Effect |
|---|---|
| `TELEGRAM_ENGINE_ENABLED` | the engine's own on/off switch; **default false** |
| `TELEGRAM_ENGINE_EXECUTION_MODE` | `OFF` / `SHADOW` / `DEMO` |
| `TELEGRAM_ENGINE_EXECUTION_ENABLED` | collector-side: whether it places Telegram legs |
| `TELEGRAM_ENGINE_KILL_SWITCH` | emergency stop for Engine B alone |
| `V2_GLOBAL_KILL_SWITCH` | shared emergency stop (see caveat below) |
| `TELEGRAM_MAX_ADVERSE_ENTRY_DEVIATION_USD` | adverse entry bound, default 1.50 |

Both `TELEGRAM_ENGINE_ENABLED=true` **and** mode `DEMO` are required before a
leg can reach the broker. Turning either off blocks new entries while leaving
reconciliation and management of existing Telegram positions running.

`XAUUSD_M1M5_KILL_SWITCH` is Engine A's and does **not** stop Engine B.
`V2_GLOBAL_KILL_SWITCH` currently stops Engine B only — wiring it into Engine
A would be a change to Engine A, which is frozen. That is a deliberate gap,
recorded here rather than papered over.

Operator commands:

```
bash deploy/m1m5.sh telegram-auth       # one-time interactive sign-in
bash deploy/m1m5.sh telegram-ready      # pre-flight checks
bash deploy/m1m5.sh telegram-status     # ingestion + reconciliation state
bash deploy/m1m5.sh telegram-logs       # follow ingestion
bash deploy/m1m5.sh telegram-enable     # turn DEMO execution on (asks first)
bash deploy/m1m5.sh telegram-disable    # turn execution off
bash deploy/m1m5.sh telegram-kill on    # emergency stop, Engine B only
```

## Ingestion and the Telegram session

The transport is **GramJS** (`telegram` on npm): a pure-TypeScript MTProto
client, using a **user session**. A bot cannot read a public channel it does
not administer, so a bot token cannot do this job; the existing notification
bot is untouched and remains outbound-only.

The session is written by `telegram-auth` to
`TELEGRAM_INGEST_SESSION_PATH` — inside the runtime volume that every V2
container mounts at the same path — with mode `0600`. It therefore survives
container restart, image rebuild, `docker compose up`, and a VPS reboot: you
authenticate once, not once per deploy.

An MTProto session string is an authorization key equivalent to being logged
in as that Telegram account. It is never committed, never baked into an image
(`.dockerignore` and `.gitignore` both exclude it), never returned by an API,
never rendered on the dashboard and never logged. The only facts any surface
may state about it are that it exists, when it was created, and whether its
file permissions are correct. `test/telegram-engine/secrets.spec.ts` enforces
that.

Source channel identity is resolved once, at authentication, to a numeric id,
and every incoming message is matched against it. A username is not trusted:
channels can be renamed and freed usernames can be claimed. Private chats,
groups, Saved Messages and every other channel the account can see are
refused at the edge.

## Ownership

Engine B opens positions under magic `262610210`. Engine A liquidates and
manages by selecting **its own** magic numbers (`262610200`, `262610201`), so
Telegram positions are excluded from Engine A's Friday liquidation
structurally rather than by a remembered condition. The module asserts the two
registries are disjoint at construction.

Several Telegram legs share one magic by design, so the magic cannot identify
a leg. Each leg carries a 14-character idempotency tag in its MT5 order
comment; that is what recovery matches on. A Telegram-magic position whose tag
matches no known leg is reported as unattributable, is **never adopted**, and
blocks `recoveryComplete`.

## Reconciliation and `recoveryComplete`

`recoveryComplete` is a stored fact written by a reconciliation pass, read by
the execution path, and never assumed. It becomes true only when:

- the collector reported a **complete** broker snapshot, and
- no leg is left unresolved, and
- no unattributable Telegram-magic position exists.

**A position missing from a snapshot is not a closure** unless the snapshot
was complete. An incomplete snapshot and an empty account are indistinguishable
otherwise, and treating one as the other would mark live positions closed and
release a signal group that should stay held.

Until a pass has genuinely run, Engine B refuses to execute. This is why the
engine is safe to deploy before it is safe to enable.

## What is not implemented

- **Close instructions.** `Close buy` and similar are not parsed as orders and
  will not act on positions. If wanted, that is a separate, deliberate feature.
- **Telegram-specific Friday policy.** Engine B has none, by instruction.
- **Automatic reaction to edits after execution.** An edit arriving after legs
  are submitted is recorded and surfaced; nothing is duplicated, reversed,
  modified or closed on its own.
