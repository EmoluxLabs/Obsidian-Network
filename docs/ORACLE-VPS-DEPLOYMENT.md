# Hosting Obsidian Network on Oracle Cloud — free tier and paid

A complete, copy-paste walk-through for putting Obsidian Network nodes and interfaces on an
Oracle Cloud server, with HTTPS, from an account that does not exist yet. It works the same for
the **free tier** and for a **paid** account: the differences are called out where they matter,
and §1 says which to choose. It is written for someone whose only other computer is an Android
phone running Termux, and it works from a laptop just as well.

Companion documents: [LAUNCH-GUIDE.md](LAUNCH-GUIDE.md) (the commands for each network on a
phone or any machine), [node-operator.md](node-operator.md) (day-to-day operation),
[mainnet-launch.md](mainnet-launch.md) (the mainnet runbook).

**What you end up with.** One Ubuntu server running, for each network you choose, **one node**
(`obsidian-node@<network>`) and **one interface** (`obsidian-interface@<network>`) as systemd
services, with nginx and a Let's Encrypt certificate in front of each interface. The text after
the `@` is the network, and it is used three times: as `--network`, as the name of that network's
settings folder, and as the name of its data folder. Two networks therefore can never share a
chain, a key or a settings file, however you copy and paste.

---

## 0. Decide before you click anything

### 0.1 What belongs on which tier

| Network | Free-tier server | Paid server | Notes |
| --- | --- | --- | --- |
| devnet | yes | yes | throwaway; fine on the smallest machine |
| staging | yes | yes | a dress rehearsal of a release |
| testnet | yes | yes | public rehearsal; the free tier is a reasonable home |
| mainnet | **no, not on its own** | yes, as **one of at least three** independent operators | see below |

**Mainnet needs at least three independent operators on independent infrastructure**
([mainnet-launch.md](mainnet-launch.md)). One server — free or paid — is one operator's node, never
the network. A free-tier machine in particular has no service-level agreement and can be reclaimed
when it looks idle (§1), which is acceptable for a rehearsal and not for the chain people hold value on.

### 0.2 Hostnames: one per network, and mainnet's names stay mainnet's

Use a separate hostname for every network you publish, for example `devnet.example.com`,
`testnet.example.com`, `staging.example.com` and `mainnet.example.com` (use a domain you own).
**Never point mainnet's official hostnames at a test network.** People use those names to check a
wallet address; a practice chain answering at them trains everyone to trust the wrong thing. (A
node enforces this on its side: only a mainnet node advertises mainnet's domains in `/network`.)

### 0.3 What you need

* An Oracle Cloud account (a payment card is required for identity verification even on the free tier).
* A domain name whose DNS you can edit, for HTTPS. Without one you can still run everything and reach it over an SSH tunnel (§9).
* A way to SSH: Termux on Android (`pkg install openssh`) or any laptop terminal.
* About an hour the first time.

---

## 1. Free tier or paid — the facts

Checked on 2026-10-04 against Oracle's page *Always Free Resources* (last updated by Oracle on
2026-06-12) and Oracle's published list prices. **Oracle changes these terms: before you rely on a
number, read your own limits in the Console — Governance & Administration → Tenancy Management →
Limits, Quotas and Usage — and the current page.**

### The free tier ("Always Free")

| Resource | What you get |
| --- | --- |
| Arm compute, `VM.Standard.A1.Flex` | the first 1,500 OCPU-hours and 9,000 GB-hours a month, which Oracle states is **2 OCPUs and 12 GB of memory** in total: one VM of 2 OCPU / 12 GB, or two VMs of 1 OCPU / 6 GB |
| AMD compute, `VM.Standard.E2.1.Micro` | up to two VMs, each 1/8 OCPU (burstable) and **1 GB** of memory, up to 50 Mbps, created in one availability domain only |
| Disk | 200 GB in total for boot and block volumes together; the minimum boot volume is about 50 GB; five volume backups |
| Network | 10 TB a month of outbound transfer; two VCNs; a public IPv4 address per VM |
| Region | Always Free resources must be created in your **home region**, which you pick at sign-up and cannot change |

Older guides (and older versions of this one) say "4 OCPUs and 24 GB". Oracle's current page says
2 and 12. Stay inside what your Console's Limits page shows.

Three things about the free tier matter for a blockchain node:

1. **"Out of host capacity".** Free Arm capacity is often exhausted in a region. Oracle's advice is to try another
   availability domain, wait and retry, or upgrade to Pay As You Go.
2. **Idle reclamation.** Oracle may reclaim an idle Always Free instance: one for which, over 7 days, CPU use at the
   95th percentile is under 20%, network use is under 20%, and (Arm only) memory use is under 20%. **A node that
   produces a block every five seconds is light, and will usually look idle by that definition.** Treat a free-tier
   node as something that can disappear: keep backups (§10) and keep the node identity key off the machine too.
3. **No service-level agreement.** Fine for devnet, staging and testnet; not for the chain people hold value on.

### The paid tier ("Pay As You Go")

Upgrading keeps the free allowance above (Oracle says it does not charge for Always Free resources
after you upgrade, only for use *above* the limits) and adds:

* access to every shape, and a much better chance of getting capacity than on the free tier alone;
* resizing a flexible VM (OCPUs and memory) with a reboot, no rebuild;
* Oracle support and the ability to run in several regions;
* **a card that is billed**, so set a budget alert before you create anything (§2).

List prices, as published (confirm in Oracle's cost estimator before you commit):

| Item | Price |
| --- | --- |
| Arm `VM.Standard.A1.Flex` | USD 0.01 per OCPU-hour and USD 0.0015 per GB-hour |
| AMD `VM.Standard.E4.Flex` | USD 0.025 per OCPU-hour and USD 0.0015 per GB-hour |
| Block volume | about USD 0.0255 per GB-month |
| Outbound data | the first 10 TB a month free, then about USD 0.0085 per GB |

Worked examples for a 730-hour month, so you can redo the sums yourself:

* **Arm, 2 OCPU / 12 GB, on a Pay As You Go account:** inside the free allowance, so about **USD 0**.
* **Arm, 4 OCPU / 24 GB:** 4 × 0.01 × 730 + 24 × 0.0015 × 730 = USD 29.20 + USD 26.28 = USD 55.48, less the free allowance
  (1,500 × 0.01 + 9,000 × 0.0015 = USD 28.50) ≈ **USD 27 a month**.
* **AMD, 2 OCPU / 16 GB (E4.Flex):** 2 × 0.025 × 730 + 16 × 0.0015 × 730 = USD 36.50 + USD 17.52 ≈ **USD 54 a month**.

### A new account starts with a Free Trial

A new Oracle account normally begins with a Free Trial (credits for about 30 days). When it ends, only
Always Free resources keep running unless you upgrade. **Do not build a host on a paid shape during the
trial and forget to upgrade**: Oracle reclaims what is not Always Free after a grace period.

### Which should you pick?

| You want | Pick |
| --- | --- |
| to learn, run devnet or staging, or a hobby testnet node | **Free tier**, one Arm VM of 2 OCPU / 12 GB (or the AMD micro for a single network) |
| a testnet node that stays up, or a better chance of getting a VM | **Pay As You Go** with the same 2 OCPU / 12 GB Arm VM (about USD 0) and a budget alert |
| a mainnet node as one of several independent operators | **Pay As You Go**, a VM in its own right, in a region that differs from the other operators', with backups and monitoring |

How much machine a node needs. Measured on this release, with a young chain: a node used about 75 MB of
memory and an interface about 65 MB, so one network (both) is about 140 MB, and all four networks with their
interfaces about 560 MB, with under 1 MB of chain on disk after several minutes and almost no CPU. The 1 GB AMD
micro runs **one** network if you add the swap file in §5 (the operating system and `npm` need the rest); the
2 OCPU / 12 GB Arm VM runs all four with room to spare. How memory and disk grow with chain length has **not**
been measured at mainnet scale, so size mainnet with headroom and watch `df -h` and `free -m`.

---

## 2. Create the Oracle account

1. Sign up at <https://www.oracle.com/cloud/free/>. Choose your **home region** with care: it cannot be
   changed, and Always Free resources exist only there. Pick by distance and by capacity; from West Africa
   that usually means Frankfurt, London or Johannesburg.
2. Verify the card. On the free tier it is not charged for Always Free resources.
3. **If you intend to use a paid account**, upgrade now: profile menu (top right) → your tenancy →
   **Upgrade** → **Pay As You Go**, then **before creating anything** go to Billing & Cost Management →
   **Budgets** → **Create budget** (for example USD 5 a month, alert at 80% to your email). This is your
   protection against a resize or a stray volume turning into a surprise bill.

---

## 3. Create the server

In the Console: ☰ menu → **Compute** → **Instances** → **Create instance**. Both tiers use the same flow.

1. **Name:** `obsidian-1`.
2. **Image:** *Change image* → **Canonical Ubuntu 24.04** (the one marked *Always Free eligible*). The commands
   below assume Ubuntu; the SSH user is `ubuntu`.
3. **Shape:** *Change shape*, then choose by tier:

   | Tier | Shape | Settings |
   | --- | --- | --- |
   | Free, recommended | **Ampere** → `VM.Standard.A1.Flex` | **2 OCPUs, 12 GB** (one VM) |
   | Free, fallback | **Specialty and previous generation** → `VM.Standard.E2.1.Micro` | fixed 1/8 OCPU, 1 GB; one network only |
   | Paid | `VM.Standard.A1.Flex` (any size) or `VM.Standard.E4.Flex` | pick OCPUs and memory; see §1 for the price |

4. **Networking:** keep *Create new virtual cloud network* and *Create new public subnet*, and make sure
   **Assign a public IPv4 address** is ticked.
5. **SSH keys:** *Paste public keys*. Make a key on your phone or laptop and paste the **public** half:

   ```bash
   # in Termux or any terminal
   ssh-keygen -t ed25519 -C "obsidian-oracle"
   cat ~/.ssh/id_ed25519.pub
   ```

   Paste the whole `ssh-ed25519 AAAA… obsidian-oracle` line. Keep the private key (`~/.ssh/id_ed25519`)
   to yourself and back it up: it is the only way in.
6. **Boot volume:** the default (about 50 GB) is plenty for a rehearsal. On a paid account choose 100 GB or
   more for mainnet, and tick *Use in-transit encryption*.
7. **Create.** Wait for the state to read *Running* and note the **public IP address**.

> **"Out of host capacity for shape VM.Standard.A1.Flex"** is a normal answer on the free tier. Try a different
> *availability domain* in the same form, try again in an hour or at a quiet time of day, drop to 1 OCPU / 6 GB,
> or fall back to the AMD micro. Upgrading to Pay As You Go also helps and still costs about nothing for a
> 2 OCPU / 12 GB VM.

**Optional, paid or free: a reserved public IP.** An ordinary public IP stays with the VM for its life but is lost
if you terminate it. To keep one address across rebuilds, Networking → **IP management** → **Reserved public IPs**
→ **Reserve public IP address**, then attach it to the VM's network interface. Do this before you publish DNS.

Connect:

```bash
ssh ubuntu@YOUR_PUBLIC_IP
```

---

## 4. Open the ports — in two places

Oracle filters traffic **twice**: in the cloud (the VCN's security list) *and* in the server's own firewall.
Opening only one looks exactly like a broken node. Open **only** what each network needs:

| What | Port | Open to the internet? |
| --- | --- | --- |
| SSH | 22 | already open |
| HTTP (certificate checks, redirect to HTTPS) | 80 | yes |
| HTTPS (the interfaces) | 443 | yes |
| devnet node P2P | 38631 | yes, if you run devnet |
| staging node P2P | 28631 | yes, if you run staging |
| testnet node P2P | 18631 | yes, if you run testnet |
| mainnet node P2P | 8631 | yes, if you run mainnet |
| **any node RPC** (38630, 28630, 18630, 8630) | | **never** — loopback only |
| **any interface port** (38788, 28788, 18788, 8788) | | **never** — nginx reaches it on loopback |

### 4a. The cloud side

Console → ☰ → **Networking** → **Virtual cloud networks** → your VCN → **Security** → *Default Security List
for …* → **Add Ingress Rules**. For each row you need, add: *Source type* CIDR · *Source CIDR* `0.0.0.0/0` ·
*IP protocol* TCP · *Destination port range* the port (one rule per port; leave *Source port range* empty).

### 4b. The server side

Ubuntu images on Oracle ship an iptables rule set that rejects everything not allowed. Insert accepts at the
top, for the ports you chose in 4a (edit the list to match; this example is HTTP, HTTPS and testnet P2P):

```bash
for port in 80 443 18631; do
  sudo iptables -I INPUT 1 -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
done
sudo netfilter-persistent save      # without this the rules vanish at the next reboot
sudo iptables -S INPUT | head -12   # your ACCEPT lines should be at the top
```

If `netfilter-persistent` is not found: `sudo apt install -y iptables-persistent`, then run the save again.

---

## 5. Prepare the server

```bash
sudo apt update && sudo apt -y upgrade
sudo apt install -y git curl ca-certificates nginx certbot iptables-persistent unattended-upgrades
sudo timedatectl set-ntp true
timedatectl status | grep -i "synchronized"     # must say: System clock synchronized: yes
```

Clock discipline is not optional: Proof of Time rejects blocks more than 60 seconds ahead of the
receiving node's clock.

**Node.js 22** (Ubuntu's own package is too old; the node needs 20.10 or newer):

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version          # v22.x
which node              # /usr/bin/node — the systemd units expect exactly this path
```

**A service account** and the folders the units expect:

```bash
sudo adduser --system --group --no-create-home --home /var/lib/obsidian obsidian
sudo mkdir -p /opt/obsidian /etc/obsidian
```

**On the 1 GB AMD micro only: add swap**, because `npm` and a busy node can run out of memory otherwise:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
free -m
```

Oracle's Ubuntu image already allows SSH keys only; confirm with
`sudo grep -E '^(PasswordAuthentication|PermitRootLogin)' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*`.

---

## 6. Install Obsidian from the verified archives

The server runs **release archives**, not a source checkout: built artefacts, a checksum you can verify, and
no build tools on the machine. Pick one way to get them onto the server.

**A. Clone the public repository on the server (simplest):**

```bash
git clone --depth 1 --branch arena/414b663a-obsidian-network https://github.com/EmoluxLabs/Obsidian-Network.git ~/obsidian-src
```

**B. Copy the archives from your phone or laptop (no Git on the server):**

```bash
# on the phone/laptop, in the folder holding the cloned repository's releases/
scp releases/obsidian-node-operator-1.7.0.tar.gz releases/obsidian-interface-selfhost-1.7.0.tar.gz \
    releases/SHA256SUMS ubuntu@YOUR_PUBLIC_IP:~/
```

**C. A private repository:** see §11 for a read-only deploy key, then do A.

Then verify and install (for A the archives are in `~/obsidian-src/releases`; for B they are in `~`):

```bash
cd ~/obsidian-src/releases            # for option B: cd ~
sha256sum -c SHA256SUMS 2>&1 | grep -E 'node-operator|interface-selfhost'     # both must say OK

sudo tar xzf obsidian-node-operator-1.7.0.tar.gz      -C /opt/obsidian --no-same-owner
sudo tar xzf obsidian-interface-selfhost-1.7.0.tar.gz -C /opt/obsidian --no-same-owner
sudo chown -R root:root /opt/obsidian
cd /opt/obsidian/obsidian-core && sudo npm ci --omit=dev --no-audit --no-fund
```

`--no-same-owner` stops the archive's own file owners from being applied, and `chown root:root` makes the code
read-only to the service account. `--omit=dev` installs only the runtime libraries (six small packages, no native code) and no build tools.

```bash
ls /opt/obsidian                                   # obsidian-core obsidian-interface obsidian-network.sh new-genesis-invite.mjs landing ...
node /opt/obsidian/obsidian-core/dist/index.js version
sudo install -m 0644 /opt/obsidian/obsidian-core/deployment/systemd/obsidian-node@.service \
  /opt/obsidian/obsidian-interface/deployment/systemd/obsidian-interface@.service /etc/systemd/system/
sudo systemctl daemon-reload
```

The two `@` files are installed once and serve every network.

---

## 7. Run a network

**Each network has its own section. Follow only the one you are running.** Run several by doing the
sections one after another; they share nothing but the server. Before each section: you did §4 for its P2P
port, and you have your server's public address in a variable (run this again in every new SSH session):

```bash
PUBLIC_IP=$(curl -4 -s https://ifconfig.me); echo "$PUBLIC_IP"
```

### 7.1 Devnet

Chain id **7780** · addresses start `dobs1` · node RPC **38630** (loopback only) · node P2P **38631** (public) ·
interface **38788** (loopback only, behind nginx) · services `obsidian-node@devnet` and `obsidian-interface@devnet`

Devnet is the throwaway network. Nothing on it has value, which makes it the place to try this whole section before doing it for a network that matters.

**a. The node's settings**

```bash
sudo install -d -m 0750 -o root -g obsidian /etc/obsidian/devnet
# a generated passphrase, readable only by root and the service (fine for a test network)
sudo sh -c 'umask 037; head -c 18 /dev/urandom | base64 > /etc/obsidian/devnet/keystore.pass'
sudo chown root:obsidian /etc/obsidian/devnet/keystore.pass
sudo tee /etc/obsidian/devnet/node.env >/dev/null <<EOF
OBSIDIAN_KEYSTORE_PASSPHRASE_FILE=/etc/obsidian/devnet/keystore.pass
OBSIDIAN_NODE_NAME=devnet-1
OBSIDIAN_RPC_HOST=127.0.0.1
OBSIDIAN_P2P_HOST=0.0.0.0
OBSIDIAN_PUBLIC_HOST=${PUBLIC_IP}
EOF
sudo chown root:obsidian /etc/obsidian/devnet/node.env && sudo chmod 0640 /etc/obsidian/devnet/node.env
```

The first devnet node is the seed: with no `OBSIDIAN_SEED_NODES` it simply waits for others. To follow nodes that already exist, add a line to `/etc/obsidian/devnet/node.env` with their **P2P** addresses on this network, for example `OBSIDIAN_SEED_NODES=203.0.113.10:38631` (a documentation address: use the real one). Never list another network's peer: it would be refused with `ERR_WRONG_NETWORK`.

**b. Start the node and check it**

```bash
sudo systemctl enable --now obsidian-node@devnet
sudo systemctl status obsidian-node@devnet --no-pager
journalctl -u obsidian-node@devnet -n 20 --no-pager          # "p2p listening", then "produced block"
curl -s localhost:38630/status                               # networkId obsidian-devnet-1, chainId 7780, height climbing
```

**c. The interface's settings, and its Genesis Invitation**

```bash
sudo tee /etc/obsidian/devnet/interface.env >/dev/null <<EOF
OBSIDIAN_INTERFACE_HOST=127.0.0.1
OBSIDIAN_INTERFACE_TRUST_PROXY=true
EOF
sudo chown root:obsidian /etc/obsidian/devnet/interface.env && sudo chmod 0640 /etc/obsidian/devnet/interface.env

# Mint this network's Genesis Invitation: the CODE is printed once (write it on paper), the HASH is
# appended to the settings file. Never reuse an invitation on another network.
node /opt/obsidian/new-genesis-invite.mjs --json | sudo node -e '
  const { code, hash } = JSON.parse(require("fs").readFileSync(0, "utf8"));
  require("fs").appendFileSync(process.argv[1], "OBSIDIAN_GENESIS_INVITE_HASH=" + hash + "\n");
  console.log("\nGENESIS INVITATION for devnet — shown once, write it on paper:\n\n    " + code + "\n");
' /etc/obsidian/devnet/interface.env

sudo systemctl enable --now obsidian-interface@devnet
curl -s localhost:38788/api/auth/config        # genesisInvite: configured true, redeemed false
```

**d. HTTPS for this interface**

Point a DNS **A** record for your hostname at the server's public IP (a *DNS only* / grey-cloud record if
the zone is on Cloudflare), wait until `getent hosts devnet.example.com` shows the address, then:

```bash
DOMAIN=devnet.example.com

# One-time, shared by every network: the rate-limit zones the interface config refers to.
sudo tee /etc/nginx/conf.d/obsidian-limits.conf >/dev/null <<'EOF'
limit_req_zone $binary_remote_addr zone=obsidian_auth:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=obsidian_api:10m  rate=600r/m;
EOF

# 1. a temporary port-80 site, only so Let's Encrypt can check you control the name
sudo tee /etc/nginx/sites-available/obsidian-devnet >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
EOF
sudo ln -sf /etc/nginx/sites-available/obsidian-devnet /etc/nginx/sites-enabled/obsidian-devnet
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# 2. the certificate (renews itself; the hook reloads nginx when it does)
sudo certbot certonly --webroot -w /var/www/html -d "${DOMAIN}" --deploy-hook 'systemctl reload nginx'

# 3. the real site: the shipped config with this network's name, port and upstream
sudo sed -e "s/obsidian\.example/${DOMAIN}/g" \
         -e "s/127\.0\.0\.1:[0-9]*;.*/127.0.0.1:38788;/" \
         -e "s/obsidian_interface/obsidian_interface_devnet/g" \
  /opt/obsidian/obsidian-interface/deployment/nginx/obsidian-interface.conf \
  | sudo tee /etc/nginx/sites-available/obsidian-devnet >/dev/null
sudo nginx -t && sudo systemctl reload nginx
```

The shipped config uses `listen 443 ssl http2;`, which every nginx version accepts (newer ones print a
harmless deprecation notice), so `nginx -t` should report `syntax is ok`. If it reports anything else, fix that
before you reload.

**e. Check it end to end**

```bash
curl -s https://devnet.example.com/api/health                    # healthyNodes 1
curl -s https://devnet.example.com/api/nodes                     # network devnet, genesisMismatch false
curl -s -o /dev/null -w '%{http_code}\n' https://devnet.example.com/wallet/    # 200
```

Then open **https://devnet.example.com/app/** in a browser and register the first account with the invitation code.
The wallet works here because the page is on HTTPS.


---

### 7.2 Testnet

Chain id **7778** · addresses start `tobs1` · node RPC **18630** (loopback only) · node P2P **18631** (public) ·
interface **18788** (loopback only, behind nginx) · services `obsidian-node@testnet` and `obsidian-interface@testnet`

Testnet is the public rehearsal: mainnet's rules with coins that have no value. This is the network most people should host on the free tier.

**a. The node's settings**

```bash
sudo install -d -m 0750 -o root -g obsidian /etc/obsidian/testnet
# a generated passphrase, readable only by root and the service (fine for a test network)
sudo sh -c 'umask 037; head -c 18 /dev/urandom | base64 > /etc/obsidian/testnet/keystore.pass'
sudo chown root:obsidian /etc/obsidian/testnet/keystore.pass
sudo tee /etc/obsidian/testnet/node.env >/dev/null <<EOF
OBSIDIAN_KEYSTORE_PASSPHRASE_FILE=/etc/obsidian/testnet/keystore.pass
OBSIDIAN_NODE_NAME=testnet-1
OBSIDIAN_RPC_HOST=127.0.0.1
OBSIDIAN_P2P_HOST=0.0.0.0
OBSIDIAN_PUBLIC_HOST=${PUBLIC_IP}
EOF
sudo chown root:obsidian /etc/obsidian/testnet/node.env && sudo chmod 0640 /etc/obsidian/testnet/node.env
```

The first testnet node is the seed: with no `OBSIDIAN_SEED_NODES` it simply waits for others. To follow nodes that already exist, add a line to `/etc/obsidian/testnet/node.env` with their **P2P** addresses on this network, for example `OBSIDIAN_SEED_NODES=203.0.113.10:18631` (a documentation address: use the real one). Never list another network's peer: it would be refused with `ERR_WRONG_NETWORK`.

**b. Start the node and check it**

```bash
sudo systemctl enable --now obsidian-node@testnet
sudo systemctl status obsidian-node@testnet --no-pager
journalctl -u obsidian-node@testnet -n 20 --no-pager          # "p2p listening", then "produced block"
curl -s localhost:18630/status                               # networkId obsidian-testnet-1, chainId 7778, height climbing
```

**c. The interface's settings, and its Genesis Invitation**

```bash
sudo tee /etc/obsidian/testnet/interface.env >/dev/null <<EOF
OBSIDIAN_INTERFACE_HOST=127.0.0.1
OBSIDIAN_INTERFACE_TRUST_PROXY=true
EOF
sudo chown root:obsidian /etc/obsidian/testnet/interface.env && sudo chmod 0640 /etc/obsidian/testnet/interface.env

# Mint this network's Genesis Invitation: the CODE is printed once (write it on paper), the HASH is
# appended to the settings file. Never reuse an invitation on another network.
node /opt/obsidian/new-genesis-invite.mjs --json | sudo node -e '
  const { code, hash } = JSON.parse(require("fs").readFileSync(0, "utf8"));
  require("fs").appendFileSync(process.argv[1], "OBSIDIAN_GENESIS_INVITE_HASH=" + hash + "\n");
  console.log("\nGENESIS INVITATION for testnet — shown once, write it on paper:\n\n    " + code + "\n");
' /etc/obsidian/testnet/interface.env

sudo systemctl enable --now obsidian-interface@testnet
curl -s localhost:18788/api/auth/config        # genesisInvite: configured true, redeemed false
```

**d. HTTPS for this interface**

Point a DNS **A** record for your hostname at the server's public IP (a *DNS only* / grey-cloud record if
the zone is on Cloudflare), wait until `getent hosts testnet.example.com` shows the address, then:

```bash
DOMAIN=testnet.example.com

# One-time, shared by every network: the rate-limit zones the interface config refers to.
sudo tee /etc/nginx/conf.d/obsidian-limits.conf >/dev/null <<'EOF'
limit_req_zone $binary_remote_addr zone=obsidian_auth:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=obsidian_api:10m  rate=600r/m;
EOF

# 1. a temporary port-80 site, only so Let's Encrypt can check you control the name
sudo tee /etc/nginx/sites-available/obsidian-testnet >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
EOF
sudo ln -sf /etc/nginx/sites-available/obsidian-testnet /etc/nginx/sites-enabled/obsidian-testnet
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# 2. the certificate (renews itself; the hook reloads nginx when it does)
sudo certbot certonly --webroot -w /var/www/html -d "${DOMAIN}" --deploy-hook 'systemctl reload nginx'

# 3. the real site: the shipped config with this network's name, port and upstream
sudo sed -e "s/obsidian\.example/${DOMAIN}/g" \
         -e "s/127\.0\.0\.1:[0-9]*;.*/127.0.0.1:18788;/" \
         -e "s/obsidian_interface/obsidian_interface_testnet/g" \
  /opt/obsidian/obsidian-interface/deployment/nginx/obsidian-interface.conf \
  | sudo tee /etc/nginx/sites-available/obsidian-testnet >/dev/null
sudo nginx -t && sudo systemctl reload nginx
```

The shipped config uses `listen 443 ssl http2;`, which every nginx version accepts (newer ones print a
harmless deprecation notice), so `nginx -t` should report `syntax is ok`. If it reports anything else, fix that
before you reload.

**e. Check it end to end**

```bash
curl -s https://testnet.example.com/api/health                    # healthyNodes 1
curl -s https://testnet.example.com/api/nodes                     # network testnet, genesisMismatch false
curl -s -o /dev/null -w '%{http_code}\n' https://testnet.example.com/wallet/    # 200
```

Then open **https://testnet.example.com/app/** in a browser and register the first account with the invitation code.
The wallet works here because the page is on HTTPS.


---

### 7.3 Staging

Chain id **7779** · addresses start `sobs1` · node RPC **28630** (loopback only) · node P2P **28631** (public) ·
interface **28788** (loopback only, behind nginx) · services `obsidian-node@staging` and `obsidian-interface@staging`

Staging is the dress rehearsal for a release: run the exact build you intend to ship, on a chain nobody depends on, before it reaches testnet or mainnet.

**a. The node's settings**

```bash
sudo install -d -m 0750 -o root -g obsidian /etc/obsidian/staging
# a generated passphrase, readable only by root and the service (fine for a test network)
sudo sh -c 'umask 037; head -c 18 /dev/urandom | base64 > /etc/obsidian/staging/keystore.pass'
sudo chown root:obsidian /etc/obsidian/staging/keystore.pass
sudo tee /etc/obsidian/staging/node.env >/dev/null <<EOF
OBSIDIAN_KEYSTORE_PASSPHRASE_FILE=/etc/obsidian/staging/keystore.pass
OBSIDIAN_NODE_NAME=staging-1
OBSIDIAN_RPC_HOST=127.0.0.1
OBSIDIAN_P2P_HOST=0.0.0.0
OBSIDIAN_PUBLIC_HOST=${PUBLIC_IP}
EOF
sudo chown root:obsidian /etc/obsidian/staging/node.env && sudo chmod 0640 /etc/obsidian/staging/node.env
```

The first staging node is the seed: with no `OBSIDIAN_SEED_NODES` it simply waits for others. To follow nodes that already exist, add a line to `/etc/obsidian/staging/node.env` with their **P2P** addresses on this network, for example `OBSIDIAN_SEED_NODES=203.0.113.10:28631` (a documentation address: use the real one). Never list another network's peer: it would be refused with `ERR_WRONG_NETWORK`.

**b. Start the node and check it**

```bash
sudo systemctl enable --now obsidian-node@staging
sudo systemctl status obsidian-node@staging --no-pager
journalctl -u obsidian-node@staging -n 20 --no-pager          # "p2p listening", then "produced block"
curl -s localhost:28630/status                               # networkId obsidian-staging-1, chainId 7779, height climbing
```

**c. The interface's settings, and its Genesis Invitation**

```bash
sudo tee /etc/obsidian/staging/interface.env >/dev/null <<EOF
OBSIDIAN_INTERFACE_HOST=127.0.0.1
OBSIDIAN_INTERFACE_TRUST_PROXY=true
EOF
sudo chown root:obsidian /etc/obsidian/staging/interface.env && sudo chmod 0640 /etc/obsidian/staging/interface.env

# Mint this network's Genesis Invitation: the CODE is printed once (write it on paper), the HASH is
# appended to the settings file. Never reuse an invitation on another network.
node /opt/obsidian/new-genesis-invite.mjs --json | sudo node -e '
  const { code, hash } = JSON.parse(require("fs").readFileSync(0, "utf8"));
  require("fs").appendFileSync(process.argv[1], "OBSIDIAN_GENESIS_INVITE_HASH=" + hash + "\n");
  console.log("\nGENESIS INVITATION for staging — shown once, write it on paper:\n\n    " + code + "\n");
' /etc/obsidian/staging/interface.env

sudo systemctl enable --now obsidian-interface@staging
curl -s localhost:28788/api/auth/config        # genesisInvite: configured true, redeemed false
```

**d. HTTPS for this interface**

Point a DNS **A** record for your hostname at the server's public IP (a *DNS only* / grey-cloud record if
the zone is on Cloudflare), wait until `getent hosts staging.example.com` shows the address, then:

```bash
DOMAIN=staging.example.com

# One-time, shared by every network: the rate-limit zones the interface config refers to.
sudo tee /etc/nginx/conf.d/obsidian-limits.conf >/dev/null <<'EOF'
limit_req_zone $binary_remote_addr zone=obsidian_auth:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=obsidian_api:10m  rate=600r/m;
EOF

# 1. a temporary port-80 site, only so Let's Encrypt can check you control the name
sudo tee /etc/nginx/sites-available/obsidian-staging >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
EOF
sudo ln -sf /etc/nginx/sites-available/obsidian-staging /etc/nginx/sites-enabled/obsidian-staging
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# 2. the certificate (renews itself; the hook reloads nginx when it does)
sudo certbot certonly --webroot -w /var/www/html -d "${DOMAIN}" --deploy-hook 'systemctl reload nginx'

# 3. the real site: the shipped config with this network's name, port and upstream
sudo sed -e "s/obsidian\.example/${DOMAIN}/g" \
         -e "s/127\.0\.0\.1:[0-9]*;.*/127.0.0.1:28788;/" \
         -e "s/obsidian_interface/obsidian_interface_staging/g" \
  /opt/obsidian/obsidian-interface/deployment/nginx/obsidian-interface.conf \
  | sudo tee /etc/nginx/sites-available/obsidian-staging >/dev/null
sudo nginx -t && sudo systemctl reload nginx
```

The shipped config uses `listen 443 ssl http2;`, which every nginx version accepts (newer ones print a
harmless deprecation notice), so `nginx -t` should report `syntax is ok`. If it reports anything else, fix that
before you reload.

**e. Check it end to end**

```bash
curl -s https://staging.example.com/api/health                    # healthyNodes 1
curl -s https://staging.example.com/api/nodes                     # network staging, genesisMismatch false
curl -s -o /dev/null -w '%{http_code}\n' https://staging.example.com/wallet/    # 200
```

Then open **https://staging.example.com/app/** in a browser and register the first account with the invitation code.
The wallet works here because the page is on HTTPS.


---

### 7.4 Mainnet

Chain id **7777** · addresses start `obs1` · node RPC **8630** (loopback only) · node P2P **8631** (public) ·
interface **8788** (loopback only, behind nginx) · services `obsidian-node@mainnet` and `obsidian-interface@mainnet`

**Mainnet is real, and one server is one operator.** Read [mainnet-launch.md](mainnet-launch.md) first (the bootstrap set, genesis verification, monitoring, rollback, the launch checklist). The differences from the test networks below are deliberate: you choose the key passphrase yourself (mainnet refuses a generated one stored beside the key it protects), you take the other operators' P2P addresses as seeds, and the official hostnames are used here and nowhere else.

**a. The node's settings**

```bash
sudo install -d -m 0750 -o root -g obsidian /etc/obsidian/mainnet
# a passphrase YOU choose (12+ characters) and keep a copy of somewhere else; the file is for restarts
read -r -s -p "Mainnet keystore passphrase (12+ characters): " P; echo
sudo sh -c 'umask 037; cat > /etc/obsidian/mainnet/keystore.pass' <<<"$P"; unset P
sudo chown root:obsidian /etc/obsidian/mainnet/keystore.pass
sudo tee /etc/obsidian/mainnet/node.env >/dev/null <<EOF
OBSIDIAN_KEYSTORE_PASSPHRASE_FILE=/etc/obsidian/mainnet/keystore.pass
OBSIDIAN_NODE_NAME=mainnet-1
OBSIDIAN_RPC_HOST=127.0.0.1
OBSIDIAN_P2P_HOST=0.0.0.0
OBSIDIAN_PUBLIC_HOST=${PUBLIC_IP}
EOF
sudo chown root:obsidian /etc/obsidian/mainnet/node.env && sudo chmod 0640 /etc/obsidian/mainnet/node.env
```

Add the other operators' **P2P** addresses as seeds: a line `OBSIDIAN_SEED_NODES=203.0.113.10:8631,203.0.113.11:8631` in `/etc/obsidian/mainnet/node.env` (documentation addresses: use the real ones). Give them yours, and keep your own P2P port open. Do not start the first mainnet node until the checklist in [mainnet-launch.md](mainnet-launch.md) says to.

**b. Start the node and check it**

```bash
sudo systemctl enable --now obsidian-node@mainnet
sudo systemctl status obsidian-node@mainnet --no-pager
journalctl -u obsidian-node@mainnet -n 20 --no-pager          # "p2p listening", then "produced block"
curl -s localhost:8630/status                               # networkId obsidian-mainnet-1, chainId 7777, height climbing
```

**c. The interface's settings, and its Genesis Invitation**

```bash
sudo tee /etc/obsidian/mainnet/interface.env >/dev/null <<EOF
OBSIDIAN_INTERFACE_HOST=127.0.0.1
OBSIDIAN_INTERFACE_TRUST_PROXY=true
EOF
sudo chown root:obsidian /etc/obsidian/mainnet/interface.env && sudo chmod 0640 /etc/obsidian/mainnet/interface.env

# Mint this network's Genesis Invitation: the CODE is printed once (write it on paper), the HASH is
# appended to the settings file. Never reuse an invitation on another network.
node /opt/obsidian/new-genesis-invite.mjs --json | sudo node -e '
  const { code, hash } = JSON.parse(require("fs").readFileSync(0, "utf8"));
  require("fs").appendFileSync(process.argv[1], "OBSIDIAN_GENESIS_INVITE_HASH=" + hash + "\n");
  console.log("\nGENESIS INVITATION for mainnet — shown once, write it on paper:\n\n    " + code + "\n");
' /etc/obsidian/mainnet/interface.env

sudo systemctl enable --now obsidian-interface@mainnet
curl -s localhost:8788/api/auth/config        # genesisInvite: configured true, redeemed false
```

**d. HTTPS for this interface**

Point a DNS **A** record for your hostname at the server's public IP (a *DNS only* / grey-cloud record if
the zone is on Cloudflare), wait until `getent hosts mainnet.example.com` shows the address, then:

```bash
DOMAIN=mainnet.example.com

# One-time, shared by every network: the rate-limit zones the interface config refers to.
sudo tee /etc/nginx/conf.d/obsidian-limits.conf >/dev/null <<'EOF'
limit_req_zone $binary_remote_addr zone=obsidian_auth:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=obsidian_api:10m  rate=600r/m;
EOF

# 1. a temporary port-80 site, only so Let's Encrypt can check you control the name
sudo tee /etc/nginx/sites-available/obsidian-mainnet >/dev/null <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
EOF
sudo ln -sf /etc/nginx/sites-available/obsidian-mainnet /etc/nginx/sites-enabled/obsidian-mainnet
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# 2. the certificate (renews itself; the hook reloads nginx when it does)
sudo certbot certonly --webroot -w /var/www/html -d "${DOMAIN}" --deploy-hook 'systemctl reload nginx'

# 3. the real site: the shipped config with this network's name, port and upstream
sudo sed -e "s/obsidian\.example/${DOMAIN}/g" \
         -e "s/127\.0\.0\.1:[0-9]*;.*/127.0.0.1:8788;/" \
         -e "s/obsidian_interface/obsidian_interface_mainnet/g" \
  /opt/obsidian/obsidian-interface/deployment/nginx/obsidian-interface.conf \
  | sudo tee /etc/nginx/sites-available/obsidian-mainnet >/dev/null
sudo nginx -t && sudo systemctl reload nginx
```

The shipped config uses `listen 443 ssl http2;`, which every nginx version accepts (newer ones print a
harmless deprecation notice), so `nginx -t` should report `syntax is ok`. If it reports anything else, fix that
before you reload.

**e. Check it end to end**

```bash
curl -s https://mainnet.example.com/api/health                    # healthyNodes 1
curl -s https://mainnet.example.com/api/nodes                     # network mainnet, genesisMismatch false
curl -s -o /dev/null -w '%{http_code}\n' https://mainnet.example.com/wallet/    # 200
```

Then open **https://mainnet.example.com/app/** in a browser and register the first account with the invitation code.
The wallet works here because the page is on HTTPS.

---

## 8. Several networks on one server

Do §7 once per network; each gets its own settings folder (`/etc/obsidian/<network>/`), data folder
(`/var/lib/obsidian/<network>/`), services, ports and hostname, and a service for one network can only
see its own. List everything that is running:

```bash
systemctl list-units 'obsidian-*' --no-pager
sudo ls /etc/obsidian /var/lib/obsidian
```

`sudo systemctl stop obsidian-interface@testnet obsidian-node@testnet` stops testnet and nothing else.

---

## 9. Verify from outside (and without a domain)

From your phone or laptop (replace `PUBLIC_IP` and the P2P port with the network's own):

```bash
# the P2P port must be reachable: a node nobody can dial contributes nothing
node -e "require('net').connect(18631,'PUBLIC_IP').on('connect',()=>{console.log('P2P open');process.exit(0)}).on('error',e=>{console.log('P2P closed:',e.code);process.exit(1)})"

# the RPC and interface ports must NOT be reachable from outside: expect a timeout or a refusal
curl -m 5 -s -o /dev/null -w '%{http_code}\n' http://PUBLIC_IP:18630/health || echo "RPC not reachable (good)"
```

If P2P says closed, you missed §4a or §4b. **Without a domain**, reach an interface through an SSH tunnel
instead of publishing it, from the phone or laptop:

```bash
ssh -N -L 18788:127.0.0.1:18788 ubuntu@PUBLIC_IP      # then open http://127.0.0.1:18788 locally
```

(the wallet works on `http://127.0.0.1` because browsers treat it as a secure origin).

---

## 10. Operate it

```bash
systemctl status 'obsidian-*' --no-pager
journalctl -u obsidian-node@testnet -f                  # follow one node (Ctrl-C to stop following)
sudo systemctl restart obsidian-node@testnet            # restart one network's node
df -h / && free -m                                      # disk and memory
```

**Behind Cloudflare (optional).** Switch the record to proxied (orange cloud) only after the certificate is
issued, set SSL/TLS mode to **Full (strict)**, and tell nginx whose word to take for the visitor's address (only
Cloudflare's), or every visitor shares one rate-limit bucket:

```bash
{ curl -fsS https://www.cloudflare.com/ips-v4; echo; curl -fsS https://www.cloudflare.com/ips-v6; } \
  | sed '/^$/d; s/^/set_real_ip_from /; s/$/;/' | sudo tee /etc/nginx/conf.d/cloudflare-realip.conf >/dev/null
echo 'real_ip_header CF-Connecting-IP;' | sudo tee -a /etc/nginx/conf.d/cloudflare-realip.conf >/dev/null
sudo nginx -t && sudo systemctl reload nginx
```

**Never put the P2P port behind Cloudflare or any proxy**: it carries raw TCP, not HTTP, and peers must reach
the node itself. Keep the P2P hostname (if you use one) on a *DNS only* record.

**Backups.** The irreplaceable file is each node's identity key; the chain itself can be re-synced from peers.

```bash
sudo tar -czf ~/testnet-identity-$(date +%F).tar.gz -C /var/lib/obsidian/testnet/node node-key.json
# copy it off the server, and keep the passphrase (/etc/obsidian/testnet/keystore.pass) somewhere else entirely
```

On mainnet also back up each interface's accounts (stop the interface first for a consistent copy):
`sudo tar -czf ~/mainnet-interface-$(date +%F).tar.gz -C /var/lib/obsidian/mainnet interface`. Oracle also keeps
boot-volume backups: Block Storage → Boot Volumes → your volume → **Boot Volume Backups** (five are free).
Store at least one copy of every key **off Oracle**: on the free tier the whole machine can be reclaimed.

**Updating to a new release.** Verify the new archives (§6), then, for each network you run:

```bash
sudo systemctl stop obsidian-interface@testnet obsidian-node@testnet        # every network you run
sudo mv /opt/obsidian /opt/obsidian.old && sudo mkdir /opt/obsidian
# …repeat the tar / chown / npm ci lines of §6 for the new release…
sudo systemctl daemon-reload
sudo systemctl start obsidian-node@testnet obsidian-interface@testnet
curl -s localhost:18630/status                                              # the new version, same chain
```

Data lives in `/var/lib/obsidian/` and settings in `/etc/obsidian/`, so neither is touched. Keep
`/opt/obsidian.old` until the new release has run cleanly, then delete it.

**Monitoring.** Each node serves Prometheus metrics at `GET /metrics` (loopback only, never publish it), and
`obsidian-core/deployment/monitoring/` carries a Prometheus config, alert rules (including `ObsidianNodeDown`),
an Alertmanager routing file with `CHANGE-ME-` placeholders that stop it starting until you name a real
destination, and a Grafana dashboard; see its README. Nothing is watched until you install it. At minimum, poll
`/status` from somewhere that is not this server, and set an Oracle **alarm** (Observability → Alarms) on the
instance's CPU or on its *status check* with a notification to your email.

---

## 11. Keeping the source private

Hiding the code does not protect a blockchain and works against it: users cannot verify what they run,
other operators cannot fetch what they must run, and secrets are not in the repository anyway (`.env`
is ignored; the server holds the key passphrase and the invitation *hash*). If you still want the repository
private, give the server a **read-only deploy key** (one repository, no write access) rather than a personal
access token, which ends up in `.git/config`, shell history and process lists with far more access:

```bash
ssh-keygen -t ed25519 -N "" -f ~/.ssh/obsidian_deploy
cat ~/.ssh/obsidian_deploy.pub
```

GitHub → repository → **Settings** → **Deploy keys** → **Add deploy key** → paste → leave *Allow write access*
**unticked**. Then:

```bash
printf 'Host github-obsidian\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/obsidian_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
git clone --depth 1 --branch arena/414b663a-obsidian-network git@github-obsidian:EmoluxLabs/Obsidian-Network.git ~/obsidian-src
```

The better answer is to keep no source on the server at all: use option B of §6 and copy only the verified archives.

---

## 12. What this setup does not give you

* **One server is one point of failure.** Mainnet needs three independent operators on independent
  infrastructure; one Oracle VM is a testnet, or one operator's node.
* **The free tier has no SLA and can reclaim an idle machine** (§1). Back up keys off Oracle.
* **Nothing is monitored until you install monitoring** (§10).
* **The archives are checksummed, not signed.** `SHA256SUMS` proves integrity, not authorship; the signing
  tooling exists (`scripts/sign-release.sh`, `scripts/verify-release.sh`, [release-verification.md](release-verification.md))
  but no publisher key is held here, and a signature is only worth something when the key belongs to the
  person publishing the release.
* **Capacity at scale is unmeasured.** Watch disk and memory as the chain grows.
