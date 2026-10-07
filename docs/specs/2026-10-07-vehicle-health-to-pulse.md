# Vehicle health → Parsons Pulse: scope and plan

Status: proposed 2026-10-07 · Owner: Tom · Repos: `tclancy/bluelinky`, `tclancy/parsons-pulse`

## Ask

> Expand the checks to include tire pressure, battery level and oil level/pressure and report those to Parsons Pulse.

## What the car actually reports (measured, not assumed)

One read-only probe on 2026-10-07 21:24 UTC: `vehicle.status({ refresh: false, parsed: false })`
from inside `bluelinky-fuel-monitor` on plexpi (2020 Santa Fe, US region, server-cached status,
car not woken). Full key set of the response:

`dateTime, acc, defrostStatus, transCond, doorLockStatus, doorOpen, battery{batSoc, batState, sjbDeliveryMode}, vehicleLocation, ign3, ignitionStatus, lowFuelLight, sideBackWindowHeat, dte{unit, value}, engine, hoodOpen, airConditionStatus, steerWheelHeat, trunkOpen, doorLock, airTemp, sleepModeCheck, defrost, tirePressureLamp{…FrontLeft, …FrontRight, …RearLeft, …RearRight, …All}, trunkOpenStatus`

| Asked for            | Available?                                                   | Field                                                                                                                         |
| -------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Tire pressure        | **Warning lamps only** — no PSI/kPa anywhere in the response | `tirePressureLamp.*` (0/1) — already parsed to `chassis.tirePressureWarningLamp` and already stored hourly in `tpms_readings` |
| Battery level        | **Yes** — 12V battery state of charge, `84` at probe time    | `battery.batSoc` — already parsed to `engine.batteryCharge12v`, never stored                                                  |
| Oil level / pressure | **No.** No oil field of any kind                             | —                                                                                                                             |

This is one car, one configuration (US, cached status, ICE). A `refresh: true` status might carry more,
but it wakes the car and costs 12V battery, so it was not probed and is not proposed.

## Scope

**In**

1. bluelinky stores the 12V battery % with every hourly check.
2. bluelinky's `status-json` emits the 12V battery % and the four-plus-all TPMS lamps alongside fuel.
3. Pulse's fuel `Reading` carries those values (nullable), and the producer passes them through.
4. Pulse's fuel card shows them: a lit TPMS lamp turns the card AMBER; battery % is drawer detail.

**Out**

- Oil level / pressure — the API does not report it. Revisit only if a probe of a `refresh: true` status, or a different model year, shows a field.
- Tire PSI — same reason.
- New ntfy/SMS alerts on low 12V battery. Pulse is the surface asked for; bluelinky already alerts on TPMS.
- Renaming Pulse's `fuel` domain to `car`/`vehicle`. Worth doing if the card keeps growing; not now.
- Other fields in the response (doors, hood, `lowFuelLight`). Easy later, not asked for.

## Design decisions

**D1 — Widen `fuel.Reading`, don't add a Pulse domain.** Same car, same producer, same timer, same
`reported_at`: these values are facts about the one poll the row already records. A separate
domain would need its own producer invoking the same command on the same tick. ADR-001 is
satisfied — typed, nullable columns, no generic table. No admin registration (`fuel/admin.py`,
ADR-002).

**D2 — Two boundaries, two different rollout rules.**

_bluelinky → producer (status document)._ Additive and optional. `REQUIRED_STATUS_FIELDS` stays
`vehicle, range_miles, reported_at`. New keys:

```json
{
  "vehicle": "Santa Fe",
  "range_miles": 236,
  "reported_at": "2026-10-07T21:24:54Z",
  "battery_12v_percent": 84,
  "tire_pressure_warning": {
    "front_left": false,
    "front_right": false,
    "rear_left": false,
    "rear_right": false,
    "all": false
  }
}
```

A key is **omitted** when the newest check has no value for it (rows written before the column
existed). The producer picks fields by name, so an old producer ignores new keys and a new producer
reads absent keys as `None`. This boundary really is either-order.

Known gap: `american.vehicle.ts` coerces the lamps with `!!`, so a response with no
`tirePressureLamp` block is stored as "all lamps off", not "unknown". Accepted — the probe shows
this car always sends the block — but "never defaulted" is not true end-to-end for TPMS.

_Producer → hub (payload)._ **Not either-order.** `core/validation.py` 400s unknown keys and missing
keys, and `producer/spool.py` dead-letters every 4xx silently. The producer (plexpi checkout,
Ansible `pulse-producers`) and the hub (`itguy deploy parsons-pulse`) are separate deploy units.
So the new hub payload keys go in a fuel `OPTIONAL` set (`validate_payload(..., optional=...)`,
precedent `qos/validation.py`) for the rollout, and come back out once plexpi's producer is
upgraded. The producer flattens and sanitises: a non-bool lamp, a non-numeric or out-of-range
battery, or a non-object `tire_pressure_warning` becomes `None`, so one bad optional field can
never cost the range reading.

Hub payload keys: `battery_12v_percent`, `tpms_front_left`, `tpms_front_right`, `tpms_rear_left`,
`tpms_rear_right`, `tpms_all`. Battery matches `fuel_percent` exactly: 0–100 `CheckConstraint`,
validator range rule, `round()` in the producer.

**D3 — A lit TPMS lamp ⇒ card `Colour.YELLOW`, not RED.** No new `Colour` member. A lit lamp
is not "you will be stranded". The ADR-005 cascade order is unchanged: GREY states first, then RED
fuel, then YELLOW (fuel or tires). Card wording:

- Specific wheels lit → name them ("Tire pressure light: front left"). Only `tpms_all` lit →
  "Tire pressure light on". Never claim "all tires": `tirePressureWarningLampAll` is plausibly
  the dash master lamp, not "all four are low" — unverified.
- When fuel and tires are both yellow, the range phrase stays the headline and tires become a fact.
- The fuel row's fixed `wobbly_phrase="is getting low"` (`dashboard/views.py`) would make the page
  headline say "Fuel is getting low" for a full tank with a tire light. It must become `""` or
  state-aware, and `tests/test_ledger.py`'s pinned phrase map is updated on purpose.
- No instructions on the card ("check your tires", "inflate", "add air") — add them to
  `INSTRUCTION_SMELLS` with the row.
- Battery % is drawer detail only. No verdict: there is no measured baseline for "low" on this
  car's 12V.

_Override D3 here before parsons-pulse#144 is picked up._

## Plan

| #   | Repo          | Work                                                                                                                                                                | Depends on |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | bluelinky     | #16 Store 12V battery % per check; emit battery + TPMS in `status-json`                                                                                             | —          |
| 2   | parsons-pulse | #143 Ingest battery + TPMS on `fuel.Reading` (OPTIONAL rollout, producer)                                                                                           | —          |
| 3   | parsons-pulse | #144 Show TPMS + battery on the fuel card                                                                                                                           | 2          |
| 4   | deploy (Tom)  | Hub via `itguy deploy parsons-pulse` → plexpi producer via `ansible-playbook … --tags pulse-producers --limit plexpi` → rebuild `bluelinky-fuel-monitor` (any time) | 1, 2       |
| 5   | parsons-pulse | #145 Empty fuel `OPTIONAL` once plexpi's producer is upgraded                                                                                                       | 4          |

Done when the fridge card shows the live 12V % and TPMS state for the Santa Fe, a lamp forced in a
test fixture renders YELLOW without the page headline saying fuel is low, and fuel's `OPTIONAL` is
empty again.
