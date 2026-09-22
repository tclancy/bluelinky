# bluelinky

An unofficial nodejs API wrapper for Hyundai BlueLink

[![npm](https://img.shields.io/npm/v/bluelinky.svg)](https://www.npmjs.com/package/bluelinky)
[![Discord](https://img.shields.io/discord/652755205041029120)](https://discord.gg/HwnG8sY)

## This Fork

This fork contains a fuel monitoring tool built on top of the Bluelink API.
`monitor-fuel.js` checks a 2020 Hyundai Santa Fe for two low-fuel thresholds
and sends a push notification (via ntfy) when the level drops below them.
A Dockerfile and docker-compose setup run the monitor as a cron job on the homelab.

See [WHATS_FUEL.md](WHATS_FUEL.md) for detailed history.

## Homelab Deployment

Credentials are managed via **Ansible Vault** in the
[homelab](https://github.com/tclancy/homelab) repo. Never commit a `.env` file.

### How credentials work

Secrets live in `ansible/group_vars/plexpi/vault.yml` (encrypted). Plain-text
variable names in `vars.yml` reference them as `{{ vault_bluelinky_* }}`. An
Ansible template (`bluelinky.env.j2`) renders the `.env` file on deploy.

To add or rotate a credential:

```bash
# Add a new vault entry
ansible-vault encrypt_string 'value' --name 'vault_bluelinky_username'
# Then paste into vault.yml and run:
itguy deploy bluelinky
```

### Deploying

```bash
itguy deploy bluelinky          # pulls latest code, templates .env, restarts container
itguy deploy bluelinky --force  # force-recreate (rebuilds image from source)
```

### itguy integration

Add to `~/.config/itguy/itguy.toml` on plexpi:

```toml
[services.bluelinky]
tag = "bluelinky"
strategy = "image-pull"
compose_dir = "/home/pi/bluelinky/deployment"
```

> **The checkout is `/home/pi/bluelinky`, not `/home/pi/fuelbot`.** This block
> said `fuelbot` until 2026-09-22 and no such directory has ever existed on the
> box. It was copied out of here into a parsons-pulse design memo and became
> one of the two candidate paths that homelab #498 was sent to go and find.
> Checked on the box: `ls /home/pi/fuelbot` is a `No such file or directory`,
> and the running container reports
> `com.docker.compose.project.working_dir=/home/pi/bluelinky`.
>
> Two further things are true on the box today and are NOT described by this
> block: there is no `~/.config/itguy/itguy.toml` at all, and the container is
> running from an untracked `docker-compose.yml` at the checkout root rather
> than from `deployment/docker-compose.yml`. Left as-is rather than quietly
> "corrected" here, because reconciling them is a deploy change and not a docs
> change.

### Machine-readable status (`npm run status-json`)

```sh
npm run status-json
{"vehicle":"2020 SANTA FE","range_miles":88,"reported_at":"2026-09-19T11:04:00.000Z"}
```

One JSON object on stdout, for
[parsons-pulse](https://github.com/tclancy/parsons-pulse)'s fuel producer,
which runs it as `FUEL_STATUS_COMMAND` and posts the result to the fridge
dashboard. On the box that command is:

```sh
docker exec bluelinky-fuel-monitor npm run --silent status-json
```

**It does not call Hyundai.** It reads the newest row of the SQLite history
that `monitor.ts` already writes hourly, so it costs no extra API traffic, no
12V drain, and no second copy of the credentials. It opens the database
read-only.

Exit codes, which are the diagnostic:

| Code | Meaning                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| 0    | a JSON object on stdout                                                      |
| 1    | the database could not be opened, or its newest row has no `car_reported_at` |

`reported_at` is **`checks.car_reported_at`** — when the _car_ last reported to
Hyundai — and never `checks.ts`, which is when the monitor ran. The dashboard
asks both questions separately: it greys the row when the producer stops
(3h15m) and dates the number when the car goes quiet (3 days). Mapping check
time onto `reported_at` would collapse the second into the first, so a car that
has not phoned home in a week would render as a confident, fresh number.

Rows written before that column existed have a null in it and are **not**
emitted; falling back to `ts` is exactly the bug above. After a rebuild the
first `monitor.ts` tick (hourly, top of the hour) writes a usable row, and
until then the command exits 1 — which the producer reads as an unreachable
car, not as a healthy tick.

Deploying this needs an image **rebuild**, not a restart: the Dockerfile
`COPY . .`s the source in, so a plain `docker compose restart` re-runs the old
image.

```sh
cd /home/pi/bluelinky && git pull && docker compose up -d --build
```

## Install

```sh
npm install bluelinky
```

## Example

```javascript
const { BlueLinky } = require('bluelinky');

const client = new BlueLinky({
  username: 'someguy@example.com',
  password: 'hunter1',
  brand: 'hyundai',
  region: 'US',
  pin: '1234',
});

client.on('ready', async () => {
  const vehicle = client.getVehicle('5NMS55555555555555');
  try {
    const response = await vehicle.lock();
    console.log(response);
  } catch (err) {
    // log the error from the command invocation
  }
});

client.on('error', async err => {
  // something went wrong with login
});
```

## Debug locally

Ensure you have a `config.json` that matches the structure of the following, with your account details

```json
{
  "username": "email",
  "password": "password",
  "pin": "pin",
  "brand": "kia" or "hyundai",
  "vin": "vin",
  "useInfo": false
}
```

Run an install for all the dependencies, `npm install`

Now you can invoke the debug.ts script with `npm run debug`

### Git hooks

This repo uses [pre-commit](https://pre-commit.com) for lint/format checks at
both commit and push time. The hook types are declared in
`.pre-commit-config.yaml`, but installing them is local machine state:

```
pre-commit install
```

Re-run it even if you have installed before — the push hook was only declared
in #12, and `pre-commit install` does not add hook types retroactively.

## Documentation

Checkout out the [docs](https://bluelinky.readme.io) for more info.

Important information for login problems:

- If you experience login problems, please logout from the app on your phone and login again. You might need to ' upgrade ' your account to a generic Kia/Hyundai account, or create a new password or PIN.
- After you migrated your Bluelink account to a generic Hyundai account, or your UVO account to a generic Kia account, make sure that both accounts have the same credentials (userid and password) to avoid confusion in logging in.

### EU specific options

EU has specific Bluelinky options :

- `language`: The language to use when login into the system, it will also change the laguage of your mobile app. `en` by default.
- `stampMode`: _Advanced_ The kind of stamping mechanism to use (`LOCAL` | `DISTANT`). `DISTANT` by default. :warning: though `LOCAL` seems to work properly, it's in beta for now.
- `stampFile`: _Advanced_ The `DISTANT` stamp source to use. `https://raw.githubusercontent.com/neoPix/bluelinky-stamps/master/${brand}-${appId}.v2.json` by default.

### Custom Stamps

In the EU region, stamps are used to sign every API queries. These stamps have a 1 week validity. Those stamps are using a tricky algorithm and cannot be replicated by Bluelinky and have to be generated by an external solution. An http call is performed to get the existing tokens. It is possible to specify an other path using the `stampFile` option. This path can be a local file prefixed by `file://` or from any webserver.

By default the case is 24H, but it can but customized at will. A nice trick is to run you own stamp generator http server and querying it regularly (with low cache timeout) for fresh stamps.

The JSON file must respect [this format](https://github.com/neoPix/bluelinky-stamps/blob/master/kia.json)

## Supported Features

- Lock
- Unlock
- Start (with climate control)
- Stop
- Status (full, parsed, cached)
- odometer
- location
- startCharge
- monthlyReport
- tripInfo
- EV: driveHistory
- EV: getChargeTargets
- EV: setChargeLimits

## Supported Regions

| [Regions](https://github.com/Hacksore/bluelinky/wiki/Regions)

## Show your support

Give a ⭐️ if this project helped you!

## Warnings

Using Bluelinky may result in draining your 12V battery when refreshing from the car too often.
Make sure you have read and understood the terms of use of your Kia or Hyundai account before using Bluelinky.
