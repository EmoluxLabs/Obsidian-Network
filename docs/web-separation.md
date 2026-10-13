# Three websites, three ports, three vhosts

| Public hostname | What it is | Internal address | Service |
| --- | --- | --- | --- |
| `https://obsmainnet.us.ci` | the main platform (landing page, Mine OBS, wallet, explorer, ONS, account) | `127.0.0.1:8789` | `obsidian-interface@mainnet` |
| `https://app.obsmainnet.us.ci` | the Web App (`obsidian-app-web`) | `127.0.0.1:8790` | `obsidian-app-web@mainnet` |
| `https://wallet.obsmainnet.us.ci` | the Wallet web app (`obsidian-wallet-web`) | `127.0.0.1:8791` | `obsidian-wallet-web@mainnet` |

Each is its **own process on its own port**, reached through **its own nginx vhost** with its own `server_name`, its
own certificate and its own upstream. Nothing chooses a page by looking at the hostname inside one process, and users
only ever see the three HTTPS names, never a port. Everything lives in
[`deployment/web-separation/`](../deployment/web-separation/): `nginx/`, `systemd/`, `env/` and `scripts/`.

Nothing here touches the node, the chain, genesis, wallets, keystores or accounts. The platform keeps its data
directory; the app and wallet services hold no state at all.

## What was checked, and what the cause was

The platform answers `/` with the landing page. That is what the code does and what a run of it returns: the
interface serves `landing/index.html` for `/`, and `mine/`, `wallet/`, `app/` only under their own paths. So a root
domain that shows Mine OBS is not produced by the platform process; it is produced by how the hostname reached a
process. On a single server with one default site and several names, three things produce exactly that, and they
are the things this layout removes:

1. **A hostname with no vhost of its own.** nginx hands it to the default site, or to whichever vhost loads first.
2. **An old vhost that still claims the name.** nginx honours the first `server_name` match in load order and ignores
   the later one, so an old file can keep answering for a name the new file was meant to own. `install.sh` finds and
   (on request) disables such files.
3. **One upstream shared by several names**, so the page depends on the path the visitor happened to open.

Which of these happened on the live machine cannot be known from the repository, and it has not been looked at:
read the live nginx with `sudo nginx -T | grep -nE 'server_name|proxy_pass|default_server'` and compare it with the
table above.

## Before anything: are the three ports free?

```bash
bash deployment/web-separation/scripts/check-ports.sh        # run it with sudo to see the owning process
```

It lists each port as `FREE`, `IN USE by the expected service` or `IN USE by something else` (with a suggested free
replacement for **that service only**), and flags any of the three that listens on a public address. Exit status 1
means act before continuing. To replace a port, change it in that one service's settings file, below, and run
`install.sh` again: it rewrites the matching `upstream` line from the settings. For the platform's port, also change
`OBSIDIAN_PLATFORM_URL` in the two other settings files.

## Install (the live site is unchanged until step 4)

All commands run on the VPS. Code is expected in `/opt/obsidian/` (the interface and its site directories, plus
`obsidian-app-web` and `obsidian-wallet-web`, both built).

1. **Certificates**, one per hostname (nginx must be running; the stock default site serves the challenge):

   ```bash
   sudo certbot certonly --webroot -w /var/www/html -d obsmainnet.us.ci
   sudo certbot certonly --webroot -w /var/www/html -d app.obsmainnet.us.ci
   sudo certbot certonly --webroot -w /var/www/html -d wallet.obsmainnet.us.ci
   ```

   The `app.` and `wallet.` DNS records must point at this server first. Behind Cloudflare use its origin
   certificates or keep the proxy off until the certificates are issued.

2. **Settings.** Back up `/etc/obsidian` (`install.sh` does this too), then:
   * `/etc/obsidian/mainnet/interface.env`: add the lines of `env/platform.env.example` (port 8789, loopback, trust
     proxy). Keep every other line.
   * create `/etc/obsidian/mainnet/app-web.env` and `wallet-web.env` from `env/app-web.env.example` and
     `env/wallet-web.env.example`.

3. **Nginx files, not yet live.** The script backs up `/etc/nginx` and `/etc/obsidian` to
   `/var/backups/obsidian-web/<time>/`, installs the vhosts and the two unit templates, reads the three ports from the
   settings of step 2, refuses if an old vhost still claims one of the names, runs `nginx -t`, and restores the backup
   itself if that fails. It neither reloads nginx nor touches a service, so the running site is unchanged:

   ```bash
   sudo bash deployment/web-separation/scripts/install.sh                      # stops and lists any old vhost that claims a name
   sudo bash deployment/web-separation/scripts/install.sh --disable-conflicts  # takes those out of load order (reversible)
   ```

4. **Services.** Moving the platform to 8789 is the only step that touches a running service (the interface process,
   not the node; a few seconds). Until nginx is reloaded in step 5 the old vhost still points at the old port, so do
   steps 4 and 5 back to back:

   ```bash
   sudo systemctl restart obsidian-interface@mainnet
   sudo systemctl enable --now obsidian-app-web@mainnet obsidian-wallet-web@mainnet
   bash deployment/web-separation/scripts/verify.sh local     # all three on this machine, before nginx is involved
   ```

5. **Go live and check the public names** (from the VPS, and again from another network with the server's public
   address, to prove the internal ports are closed from outside):

   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   bash deployment/web-separation/scripts/verify.sh public
   PUBLIC_IP=<server public address> bash deployment/web-separation/scripts/verify.sh public   # run from OUTSIDE
   ```

   It reads each page's own `<title>`, requires 200 with no redirect, checks that every root-relative asset loads from
   the same site, that HTTP answers `301` to the same host over HTTPS, that a certificate is served for each name,
   and that the three names serve three different pages. The wallet host must answer `404` on account routes.

Keep the old platform setting (port 8788 in the backed-up `interface.env`) and the old vhost file until step 5 passes.

## Rollback

```bash
sudo bash deployment/web-separation/scripts/rollback.sh /var/backups/obsidian-web/<time>   # files + nginx -t
sudo systemctl reload nginx
# platform back on its old port: the backup holds the old settings file
sudo tar -C / -xpf /var/backups/obsidian-web/<time>/etc-obsidian.tar && sudo systemctl restart obsidian-interface@mainnet
sudo systemctl disable --now obsidian-app-web@mainnet obsidian-wallet-web@mainnet     # optional
```

`rollback.sh` removes only the files `install.sh` created and restores the rest from the backup. It never stops or
starts a service, and never touches chain data, wallets, keystores or genesis.

## How the sites talk to each other

* The Web App and the Wallet web app call the platform **server to server** on `127.0.0.1:8789`
  (`OBSIDIAN_PLATFORM_URL`); the browser only ever talks to its own hostname, so there is no cross-origin API call
  and no CORS exception to add. The Web App's own origin check compares `Origin` with `Host`, which is why every
  vhost sets `Host $host`.
* One account system, one claim state: both products reach the **same** platform, so an account and its mining
  claims are the same wherever you sign in. A session cookie belongs to the hostname that set it, so signing in on
  `app.` does not sign you in on `obsmainnet.us.ci`; accounts and claims are shared, sessions are not.
* The wallet host forwards `/api/rpc` only (chain reads and transaction relay); sign-in and account routes are not
  exposed there.
* `obsmainnet.us.ci` and its subdomains are already trusted origins for chain reads
  ([trusted-domains.md](trusted-domains.md)); nothing about CORS or allowed origins was loosened.
* None of the three uses WebSockets, so no `Upgrade` handling is configured.
* The platform's own `/mine/`, `/wallet/` and `/app/` pages remain part of the main platform; `/` is the landing page.

## What a failure looks like

| Symptom | Likely cause | Check |
| --- | --- | --- |
| a hostname shows another site's page | an old vhost claims the name, or a vhost lists the wrong upstream | `sudo nginx -T \| grep -nE 'server_name\|proxy_pass'`; `install.sh` names conflicts |
| `502` on one hostname only | that service is down, or nginx's upstream port differs from the service's port | `systemctl status`, `check-ports.sh`, the `upstream` lines in `conf.d/obsidian-web.conf` |
| the Web App starts and exits with code 3 | its platform is on another network | `OBSIDIAN_PLATFORM_URL` points at the mainnet platform |
| sign-in fails behind the proxy with 429 for everyone | `TRUST_PROXY` is off, so every visitor shares one address | `OBSIDIAN_INTERFACE_TRUST_PROXY=true`, `APP_TRUST_PROXY=true` |
| `nginx -t` fails on a certificate path | a certificate was not issued yet | step 1 |
| port in use at start (`EADDRINUSE`) | something else holds it | `check-ports.sh`, then the replacement procedure above |

## Tested where

The repository tests (`tests/scripts/web-separation.test.mjs`, `scripts/check-nginx-conf.py`, and the app server's
default bind address) read the shipped files and run `install.sh` and `rollback.sh` against a scratch tree with a stand-in
for nginx. The nginx files are checked against nginx's directive grammar, not by nginx itself, and certificates,
DNS, systemd and the live hostnames can only be tested on the server with the commands above.
