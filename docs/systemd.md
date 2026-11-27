# Running Picord as a systemd service

Picord ships a systemd template unit at [`contrib/systemd/picord@.service`](../contrib/systemd/picord@.service). The instance name is the access mode, so one file starts the server in any mode:

> **重大历史摘要**：2026-11-27 全面统一服务名称、数据目录与模板单元为 `picord`（`picord@.service` / `/var/lib/picord`），正式替代早期的 `pi-pocket@.service`，详见 [重大演进历史](changelog-history.md)。

```bash
sudo systemctl enable --now picord@lan
```

The modes are `local`, `lan`, `cloudflare`, `tailscale`, and `tailscale-serve`. [Remote access](running.md#remote-access) explains who can connect in each one.

Enable one instance at a time. Every instance uses the same port and data folder, and a second launcher on that folder now refuses to start (it names the pid that holds it) rather than adopting the first one's Tailscale Serve mount.

## Before you start

- Node.js 22.19 or newer, installed for the whole system and found through `PATH`. A copy in a home folder, such as one from `nvm` or `mise`, is not visible to the service.
- A checkout of Picord with its packages installed (`npm install`).
- A user for the service. Give it an account of its own: agents run commands as this user, and anyone who can steer a session can run them too.

The access mode also needs its own tools:

- `local`: nothing. Listens on `127.0.0.1`.
- `lan`: the port open in the firewall (TCP 8787 by default). Plain http.
- `cloudflare`: `cloudflared` on `PATH`, or in `/var/lib/picord/bin`. The service has no terminal, so it cannot download it. Run Picord once in a terminal as the service user, or install it yourself. The quick tunnel address changes each time the launcher starts.
- `tailscale`: Tailscale connected (`tailscale up`). Listens on the Tailscale address only.
- `tailscale-serve`: Tailscale 1.52 or newer, `tailscaled` running, HTTPS certificates enabled in the tailnet, and the service user as its operator (`sudo tailscale set --operator=picord`, unless the service runs as root). The launcher adds the mapping and removes one it made. It also removes one that a crashed run made, which it knows by its receipt (`serve-mount.json` in the data folder). When it cannot, a start in another mode on that port stops and says how to free it, as the mapping would keep the app on the tailnet. A mapping with no receipt, such as one you made yourself, is left where it is: free it by hand with `tailscale serve --https=443 --set-path=/ off` if you need to.

The unit starts after `tailscaled` but does not start it, as the other modes do not need it: for `tailscale` and `tailscale-serve`, keep `tailscaled` enabled.

Provider sign-in does not need a terminal: sign in from the app's Providers sheet after the first start.

## Install

From the checkout:

```bash
sudo useradd --system --user-group --create-home --home-dir /var/lib/picord picord
sudo mkdir -p /srv/picord
sudo chown picord: /srv/picord
sudo cp contrib/systemd/picord@.service /etc/systemd/system/
```

Edit the copy in `/etc/systemd/system/` when your paths differ:

- `PICORD_HOME` is the checkout, `/opt/picord` in the unit. It must contain `bin/picord.js`.
- `HOME` and `--data` are `/var/lib/picord`: Pi's config, sign-ins, database, uploads, and extensions live there.
- `WorkingDirectory` and `--cwd` are `/srv/picord`: new sessions start there, and it must be writable by the service user.

Then start an instance:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now picord@lan
```

To run as an existing user instead, change `User`, `Group`, and `HOME` together, and point `--data` at a folder that user can write. Remove `StateDirectory` when the data folder is not `/var/lib/picord`.

## Read the sign-in link

The owner's sign-in link is in the log and is printed again on every start. It is the key to this server, so keep it private:

```bash
journalctl -u picord@lan | grep '/login?token='
```

Open it once per browser. A cookie lasts a year.

## Use

```bash
systemctl status picord@lan
journalctl -u picord@lan -f
sudo systemctl restart picord@lan
sudo systemctl stop picord@lan
```

To change the access mode, disable the old instance first:

```bash
sudo systemctl disable --now picord@local
sudo systemctl enable --now picord@lan
```

The data folder stays the same, so sessions, people, and settings carry over.

## Settings and secrets

Put provider keys and other secrets in `/etc/picord.env`, one `KEY=VALUE` per line, and keep it readable by root only (`0600`). The unit reads it when the file exists. `PATH` must include the commands that the launcher and the agents use, such as `node`, `git`, `gh`, `tailscale`, and `cloudflared`.

The unit runs with `NoNewPrivileges=yes` and `PrivateTmp=yes`. Remove those lines if agents must use `sudo` or share the host's `/tmp`.

## Updating

Stop the service, back up the data folder, update the checkout, install its packages, and start the service again:

```bash
sudo systemctl stop picord@lan
sudo cp -a /var/lib/picord /var/lib/picord.backup
git pull
npm install
sudo systemctl start picord@lan
```

If the unit file changed, copy it again and run `sudo systemctl daemon-reload` before starting.

Menu → **Update Picord** can also update the checkout from the app, when the service user owns it (`sudo chown -R picord: /opt/picord`). With the checkout owned by another user, as in the steps above, the sheet only says when a new version is out. A global npm install (`npm install -g picord`) updates from the sheet the same way, when the service user can write the folder that holds the package. An update from the app does not back up the data folder: for a release whose notes have a warning, back it up first, as above.

## When it does not start

The launcher has no terminal under systemd, so it uses the mode from `--access` and never shows its menu. When that mode is not ready, it exits with a message:

```bash
journalctl -u picord@lan -n 30 --no-pager
```

Check the prerequisites above: `cloudflared` for a tunnel, a connected Tailscale, or the operator for Tailscale Serve. A port already in use is another common cause.
