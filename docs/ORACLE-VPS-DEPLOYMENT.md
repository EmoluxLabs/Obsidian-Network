# Deploying Obsidian Network on an Oracle Cloud free-tier server

A complete, copy-paste walkthrough for putting a node and the interface on a
free Oracle Cloud instance, with a real domain and HTTPS. Written for someone
whose only other computer is an Android phone running Termux.

Companion to `docs/DEPLOYMENT-GUIDE.md` (concepts) and `docs/node-operator.md`
(day-to-day operation). Read the warnings — two of them will cost you hours if
you skip them.

---

## 0. Decide what you are launching

**Do not point `obsmainnet.us.ci` at a devnet or testnet node.** The node
advertises that domain in `/network` as mainnet's official interface. Serving a
practice chain there trains people to trust the wrong thing — and that domain
is what they will later use to check a wallet address.

Use subdomains while testing:

| Hostname | Points at | When |
|---|---|---|
| `testnet.obsmainnet.us.ci` | your Oracle box, `--network testnet` | now |
| `obsmainnet.us.ci` | nothing yet | only at real launch |

---

## 1. Create the Oracle Cloud instance

Oracle's Always Free tier gives you either 4 Ampere ARM cores with 24 GB RAM
(one or more instances sharing that), or two tiny AMD instances. The ARM one is
far better for this and still free.

1. Sign up at `https://cloud.oracle.com`. A card is required for identity
   verification; Always Free resources are not charged. **Do not upgrade to
   Pay As You Go** unless you intend to pay.
2. Menu → **Compute** → **Instances** → **Create instance**.
3. Name: `obsidian-node-1`.
4. **Image and shape** → Change image → **Canonical Ubuntu 22.04**.
5. Change shape → **Ampere** → `VM.Standard.A1.Flex` → **2 OCPUs, 12 GB**
   (leaves room for a second node later and stays inside Always Free).
6. **Networking**: keep the default VCN, and tick **Assign a public IPv4
   address**.
7. **Add SSH keys** → *Paste public keys*. From Termux:

   ```bash
   ssh-keygen -t ed25519 -C "obsidian-oracle"
   cat ~/.ssh/id_ed25519.pub
   ```

   Paste the whole `ssh-ed25519 AAAA… obsidian-oracle` line.
8. Create. Note the **public IP address**.

> **"Out of capacity" is the normal Ampere experience.** Free ARM capacity is
> often exhausted in a region. Retry later, or try a different availability
> domain, or fall back to `VM.Standard.E2.1.Micro` (AMD, 1 GB RAM) — which is
> enough for one node, per `docs/node-operator.md` §1, but tight if you also
> run the interface.

---

## 2. Open the ports — **in two places**

This is the single most common Oracle mistake. Oracle filters traffic **twice**:
in the cloud Security List *and* in the instance's own iptables. Opening one
and not the other looks exactly like a broken node.

### 2a. Cloud side

Instance page → **Virtual cloud network** → **Security Lists** → *Default
Security List* → **Add Ingress Rules**:

| Source CIDR | Protocol | Destination port | Why |
|---|---|---|---|
| `0.0.0.0/0` | TCP | `18631` | testnet P2P (use `8631` for mainnet) |
| `0.0.0.0/0` | TCP | `80` | HTTP, for certificate issuance |
| `0.0.0.0/0` | TCP | `443` | HTTPS |

Do **not** open the RPC port (18630/8630). Nothing outside the box should
reach it.

### 2b. Instance side

```bash
ssh ubuntu@YOUR_PUBLIC_IP

sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 18631 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

`netfilter-persistent save` is what survives a reboot. Without it the rules
vanish and the node silently stops peering after the next restart.

---

## 3. Harden the server

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl ca-certificates unzip
sudo timedatectl set-ntp true
timedatectl status          # must say: System clock synchronized: yes
```

Clock discipline is not optional: Proof of Time rejects blocks more than 60
seconds ahead of the receiving node's clock.

```bash
sudo adduser --system --group --home /var/lib/obsidian-node obsidian
sudo mkdir -p /opt/obsidian /etc/obsidian
```

Oracle's Ubuntu image already disables password SSH. Confirm:

```bash
sudo grep -E 'PasswordAuthentication|PermitRootLogin' /etc/ssh/sshd_config
```

Node.js 22:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version      # must be >= 20.10
```

---

## 4. Get the software onto the box

Three ways. Pick one — §9 explains which to pick if you want the source
private.

**A. Upload a release archive from your phone (no Git on the server):**

```bash
# in Termux
scp ~/Obsidian-Network/releases/obsidian-node-operator-1.1.0.tar.gz ubuntu@YOUR_IP:/tmp/
scp ~/Obsidian-Network/releases/obsidian-interface-selfhost-1.1.0.tar.gz ubuntu@YOUR_IP:/tmp/
scp ~/Obsidian-Network/releases/SHA256SUMS ubuntu@YOUR_IP:/tmp/
```

```bash
# on the server
cd /tmp && sha256sum -c SHA256SUMS 2>/dev/null | grep -E 'node-operator|selfhost'
sudo mkdir -p /opt/obsidian/core /opt/obsidian/interface
sudo tar -xzf obsidian-node-operator-1.1.0.tar.gz -C /opt/obsidian/core --strip-components=1
sudo tar -xzf obsidian-interface-selfhost-1.1.0.tar.gz -C /opt/obsidian/interface
```

**B. Clone a public repository** (simplest, source is public anyway):

```bash
sudo git clone https://github.com/EmoluxLabs/Obsidian-Network.git /opt/obsidian/src
```

**C. Clone a private repository with a deploy key** — see §9.

Install runtime dependencies and build:

```bash
cd /opt/obsidian/core && sudo npm ci --omit=dev
# the interface has zero runtime dependencies: nothing to install
```

---

## 5. Node identity and configuration

```bash
sudo sh -c "head -c 32 /dev/urandom | base64 > /etc/obsidian/keystore.pass"
sudo chmod 600 /etc/obsidian/keystore.pass
sudo chown obsidian:obsidian /etc/obsidian/keystore.pass

sudo -u obsidian OBSIDIAN_KEYSTORE_PASSPHRASE_FILE=/etc/obsidian/keystore.pass \
  node /opt/obsidian/core/dist/index.js keygen \
  --network testnet --data-dir /var/lib/obsidian-node
```

Back up `/var/lib/obsidian-node/node-key.json` **and** the passphrase, stored
separately. Chain data can be re-synced from peers; an identity cannot be
regenerated.

```bash
sudo tee /etc/obsidian/node.env >/dev/null <<'EOF'
OBSIDIAN_NETWORK=testnet
OBSIDIAN_DATA_DIR=/var/lib/obsidian-node
OBSIDIAN_KEYSTORE=/var/lib/obsidian-node/node-key.json
OBSIDIAN_KEYSTORE_PASSPHRASE_FILE=/etc/obsidian/keystore.pass
OBSIDIAN_RPC_HOST=127.0.0.1
OBSIDIAN_RPC_PORT=18630
OBSIDIAN_P2P_HOST=0.0.0.0
OBSIDIAN_P2P_PORT=18631
OBSIDIAN_PUBLIC_HOST=YOUR_PUBLIC_IP
OBSIDIAN_LOG_JSON=true
EOF
sudo chmod 640 /etc/obsidian/node.env
```

`OBSIDIAN_RPC_HOST=127.0.0.1` is deliberate: RPC stays on loopback, and the
interface — running on the same box — is the only thing that reads it.

---

## 6. Run both as services

The repository ships both unit files.

```bash
sudo install -m 0644 /opt/obsidian/core/deployment/systemd/obsidian-node.service \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now obsidian-node
sudo systemctl status obsidian-node
sudo journalctl -u obsidian-node -f
```

Interface environment:

```bash
sudo tee /etc/obsidian/interface.env >/dev/null <<'EOF'
OBSIDIAN_NODE_URLS=http://127.0.0.1:18630
OBSIDIAN_INTERFACE_HOST=127.0.0.1
OBSIDIAN_INTERFACE_PORT=8788
OBSIDIAN_INTERFACE_DATA_DIR=/var/lib/obsidian-interface
OBSIDIAN_INTERFACE_TRUST_PROXY=true
OBSIDIAN_INTERFACE_ALLOWED_ORIGINS=https://testnet.obsmainnet.us.ci
OBSIDIAN_GOOGLE_CLIENT_ID=
OBSIDIAN_GENESIS_INVITE_HASH=
EOF
sudo chmod 640 /etc/obsidian/interface.env
sudo mkdir -p /var/lib/obsidian-interface
sudo chown obsidian:obsidian /var/lib/obsidian-interface

sudo install -m 0644 \
  /opt/obsidian/interface/obsidian-interface/deployment/systemd/obsidian-interface.service \
  /etc/systemd/system/ 2>/dev/null || true
sudo systemctl daemon-reload
sudo systemctl enable --now obsidian-interface
```

`TRUST_PROXY=true` is correct **only** because nginx terminates TLS in front
(§7). Never set it on a directly exposed port.

Add more nodes later by pointing `OBSIDIAN_NODE_URLS` at several of them,
comma-separated — the interface health-checks and fails over.

---

## 7. Domain, nginx and HTTPS

In the Cloudflare dashboard for `obsmainnet.us.ci`:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `testnet` | your Oracle public IP | **DNS only (grey cloud)** at first |

Grey cloud first so `certbot` can reach the server directly. Switch to orange
afterwards if you want Cloudflare in front.

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
sudo install -m 0644 \
  /opt/obsidian/interface/obsidian-interface/deployment/nginx/obsidian-interface.conf \
  /etc/nginx/sites-available/obsidian
sudo ln -sf /etc/nginx/sites-available/obsidian /etc/nginx/sites-enabled/obsidian
sudo rm -f /etc/nginx/sites-enabled/default
sudo nano /etc/nginx/sites-available/obsidian     # set server_name
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx -d testnet.obsmainnet.us.ci
```

In Cloudflare → **SSL/TLS** → set **Full (strict)**, and enable **Always Use
HTTPS**.

Verify from your phone:

```bash
curl -s https://testnet.obsmainnet.us.ci/api/rpc?path=/status
```

---

## 8. Verify the deployment

```bash
curl -s localhost:18630/status
curl -s localhost:18630/peers
curl -s localhost:18630/supply | grep -o '"invariantOk":[a-z]*'
curl -s localhost:18630/params | grep -o '"paramsHash":"[^"]*"'
node /opt/obsidian/core/scripts/check-invariants.mjs 2>/dev/null || true
```

Then from outside, confirm P2P is actually reachable — a node nobody can dial
is a node that contributes nothing:

```bash
# from Termux
nc -vz YOUR_PUBLIC_IP 18631
```

If that fails, you missed §2a or §2b.

---

## 9. Keeping the source private

**Read this before making the repository private.** Hiding the code does not
protect the network, and for a blockchain it works against you:

- **Secrets are not in the repository.** `.env` is gitignored; the server holds
  the keystore passphrase and the Genesis Invitation
  *hash*. Nothing in Git unlocks anything. If a secret ever does land in a
  commit, making the repo private does not fix it — rotate the secret.
- **Users cannot verify what they run.** The project's whole argument is
  "verify, don't trust": reproducible genesis, a PARAMS_HASH every node must
  match, `/audit/compliance`, checksummed releases. All of that assumes someone
  can read the source.
- **Other operators need the code.** Decentralisation means three independent
  operators running nodes. They cannot run what they cannot fetch.
- **It does not hide the protocol.** Anyone who connects to your P2P port sees
  the wire format, the genesis id and the params hash.

**What legitimately justifies privacy:** you are not ready to announce, and you
would rather nobody found a half-finished project. That is reasonable — but it
is temporary, and it should be stated as such.

### If you still want it private

GitHub → repository → **Settings** → **General** → **Danger Zone** → *Change
repository visibility* → **Private**.

Then the server needs credentials to clone. Use a **deploy key**, which grants
read-only access to one repository and nothing else:

```bash
# on the server
sudo -u obsidian ssh-keygen -t ed25519 -f /var/lib/obsidian-node/.ssh/deploy -N ""
sudo cat /var/lib/obsidian-node/.ssh/deploy.pub
```

GitHub → repository → **Settings** → **Deploy keys** → **Add deploy key** →
paste → leave *Allow write access* **unticked**.

```bash
sudo -u obsidian tee -a /var/lib/obsidian-node/.ssh/config >/dev/null <<'EOF'
Host github-obsidian
  HostName github.com
  User git
  IdentityFile /var/lib/obsidian-node/.ssh/deploy
  IdentitiesOnly yes
EOF

sudo -u obsidian git clone git@github-obsidian:EmoluxLabs/Obsidian-Network.git \
  /opt/obsidian/src
```

Never put a personal access token in a clone URL on a server: it ends up in
`.git/config`, in shell history and in process listings, and it usually carries
far more access than one repository.

### The better answer: don't put source on the server at all

Deploy **release archives** (§4A). The server then holds built artifacts, no
Git remote, no credentials, and nothing to leak. You keep the source wherever
you like, and what runs in production is a checksummed archive you can verify —
which is what `docs/mainnet-launch.md` §1.1 requires anyway.

---

## 10. Operating it

```bash
sudo systemctl status obsidian-node obsidian-interface
sudo journalctl -u obsidian-node -n 100
sudo journalctl -u obsidian-node -f
sudo systemctl restart obsidian-node
df -h && free -m
```

**Backups** — the irreplaceable file is the node identity:

```bash
sudo tar -czf ~/node-key-backup.tar.gz -C /var/lib/obsidian-node node-key.json
# then copy it off the server, and store the passphrase somewhere else entirely
```

**Updates:**

```bash
sudo systemctl stop obsidian-node
# replace /opt/obsidian/core from a newly verified archive
sudo systemctl start obsidian-node
curl -s localhost:18630/status
```

**Oracle-specific trap:** Always Free instances can be reclaimed if they are
idle for long periods. A node producing blocks is not idle, but an instance you
stop for a week may be. Do not treat free capacity as a guarantee for mainnet.

---

## 11. Known limitations of this setup

- **One server is one point of failure.** Mainnet needs three independent
  operators on independent infrastructure. One Oracle box is a testnet.
- **Oracle Always Free has no SLA.** Fine for a testnet; not a mainnet plan.
- **No monitoring stack ships with this project.** Poll `/status`, `/peers` and
  `/supply` yourself — see `docs/DEPLOYMENT-GUIDE.md` §D11.
- **Release signing is not implemented.** Checksums prove integrity, not
  authorship.
