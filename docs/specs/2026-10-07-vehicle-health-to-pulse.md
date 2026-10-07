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
satisfied — typed, nullable columns, no generic table.

**D2 — The wire contract is additive and optional on the bluelinky side.** `REQUIRED_STATUS_FIELDS`
stays `vehicle, range_miles, reported_at`. New keys:

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
existed), never defaulted — the same rule `fuel_percent` follows today. Pulse's producer turns an
absent key into an explicit `null` in the hub payload, matching the house "required but nullable"
contract in `fuel/validation.py`. Consequence: the two repos can ship in **either order** without
breaking the live producer.

**D3 — TPMS lamp lit ⇒ card AMBER, not RED.** A lit lamp is "check your tires today", not "you
will be stranded". It never overrides a RED fuel verdict (ADR-005 ordered cascade). Battery % does
not drive a verdict — there is no measured baseline for what "low" is on this car's 12V yet.
_Override this here if you disagree before the Pulse card ticket is picked up._

## Plan

| #   | Repo             | Ticket                                                                           | Depends on |
| --- | ---------------- | -------------------------------------------------------------------------------- | ---------- |
| 1   | bluelinky        | Store 12V battery % per check; emit battery + TPMS in `status-json`              | —          |
| 2   | parsons-pulse    | Ingest battery + TPMS on `fuel.Reading` (model, migration, validation, producer) | — (D2)     |
| 3   | parsons-pulse    | Show TPMS + battery on the fuel card                                             | 2          |
| —   | homelab / plexpi | Redeploy bluelinky container and Pulse after 1 and 2 merge                       | 1, 2       |

Done when the fridge card shows the live 12V % and TPMS state for the Santa Fe, and a forced
lamp in a test fixture renders AMBER.
