# crow-ai.dev — Website & Product Research

Research: November 2026, session `elusive-magnetic-cormorant-of-novelty`.
Primary sources throughout (official docs, blogs, pricing pages, GitHub/crates.io APIs).
Caveats: the search backend was rate-degraded during this run, so most evidence is
direct fetches; Hetzner CPX11 pricing and OpenSRS reseller terms are flagged unverified.

## The vision being researched

Customers buy a domain (Cloudflare) and DigitalOcean resources *through us*, provisioned
on **their** droplet, in **their** name:

- PDS at `pds.their-site` — the identity / SSO anchor
- crow-cli + IDE on the box
- dashboard with atproto login
- tangled knots + spindles (forge + CI)
- Okta-style app catalog (langfuse, grafana, …) with per-app SSO
- WASM hosting
- WireGuard home-lab mirroring, droplet as fallback

Model: up-front setup fee; providers charged in the customer's name; the recurring fee
is for the **managed version only**. Stop paying → keep the infrastructure.

**Control-plane framing (Thomas, 2026-11-21):** the control plane is hosted on the
**customer's side**, not ours. crow-ai.dev is thin — a payments ledger, a one-shot script
dispatcher (setup / update / disconnect), and a fleet of support crow agents. Everything
on the droplet (dashboard, PDS, tangled, crow IDE, apps) is open source and administered
there. The disconnect button works **by construction**: we stop billing and stop firing
scripts; nothing proprietary runs on their box. The managed version's value *is* the
support: **our crow agents talk to their crow agents** to diagnose, fix, and deploy
across the mesh of managed services — so the agent-mesh research (grants, durable
mailboxes, authenticated cross-host delivery) is the **managed-support transport**, not
a separate product.

---

## 1. tangled.sh — the forge layer

### knot = git server AND atproto PDS, one Rust binary

- `knot-server` is a single **Rust** binary (migrated from Go): git over SSH + HTTPS +
  LFS, built-in SSH server — and it **is the atproto PDS for every repo it hosts**.
  Each repo gets its own `did:plc`; the knot holds the rotation + signing keys.
  Issues, PRs, and comments are atproto records in the repo DID's account.
  (https://docs.tangled.org/knots/)
- **No SQL database.** State lives in bare git repos sharded by DID; ACLs and records
  are signed COBs under `refs/cobs/*`; a meta-repo lives under the knot's `did:web`.
- Keystore sealed with `KNOT_MASTER_KEY`. **Lose it = lose control of every repo DID on
  the knot.** This is the operational custody liability of the whole design.

### Self-hosting a knot

- Needs: Linux, a DNS name (that *is* its identity), your DID, Caddy for TLS.
  NixOS module or Docker `atcr.io/tangled.org/knot:2`; listens on :5555.
  (https://docs.tangled.org/self-hosting/knot/)
- **New repos default to SHA-256 object format — cannot interop with GitHub's SHA-1.**
  Set `git.object_format="sha1"` if you want GitHub mirroring.
- Admission closed by default. SSH push auth = `org.tangled.key.sshKey` records in the
  user's PDS; HTTPS push via service-auth token. No server-side hooks. Repack every 6h.

### spindle = CI

- knot emits `sh.tangled.pipeline` records; spindle subscribes over WebSocket.
  Workflows are YAML in `.tangled/workflows/*.yml`; nixpkgs deps via Nixery.
  Docker engine (blog Aug 2025, https://tangled.org/blog/ci/), **plus a QEMU/KVM microVM
  engine as of the Jun 16 2026 blog**.
- Self-host needs Linux + KVM or Docker, recent git, a public TLS hostname, and an
  EC P-256 signing key. Has secrets, **OIDC federation**, webhooks, quotas, S3 artifacts.
  (https://docs.tangled.org/spindles/self-hosting/)

### Surface area

- Self-hostable: knot, spindle, frontend, indexer, PDS
  (https://docs.tangled.org/self-hosting/). Bobbin = diskless API-only AppView (Jul 2026).
- PRs are immutable rounds; stacked PRs; Jujutsu support
  (https://docs.tangled.org/comparison-with-github/).

### Funding & traction (primary source)

- **€3.8M (~$4.5M) seed, Mar 2 2026**, led by byFounders + Bain Capital Crypto + Antler;
  angels include **Thomas Dohmke (ex-GitHub CEO)** and **Avery Pennarun (Tailscale)**.
  Tangled Labs Oy. 7k+ users, 5k+ repos. (https://tangled.org/blog/seed/)
- **Gleam moved its primary hosting to Tangled**
  (https://www.developersdigest.tech/blog/gleam-tangled-atproto-code-hosting).
  Vouch web-of-trust (Mitchell Hashimoto).

**Read:** daily-driver plausible and funded, but: SHA-256 interop gotcha, nix/jj-centric
culture, no revenue path yet, and the master-key custody problem. Build on it; don't bet
the company on their roadmap.

---

## 2. PDS as SSO anchor — the hard one

### Footprint

- Reference PDS: **1GB RAM / 1 CPU / 20GB SSD, 1–20 users**, Docker compose + Caddy,
  ports 80/443, wildcard DNS. (https://github.com/bluesky-social/pds)
  Fits on a $6–12 droplet alongside everything else.

### atproto OAuth ≠ OIDC

- atproto OAuth (https://atproto.com/specs/oauth): the PDS is the Resource Server and
  usually the **Authorization Server** too (or a separate **"entryway"** AS fronts
  multiple PDSes). OAuth 2.1 profile: **PKCE + DPoP + PAR mandatory**, client_id is a URL
  pointing at a client-metadata document, `atproto` scope required.
- The spec itself says OIDC "does not enable authentication of atproto identities in a
  secure and generic way."
- **The killer line** (https://atproto.com/guides/oauth-patterns): *"atproto OAuth is not
  compatible with OIDC, which requires a pre-established relationship."*
  → A PDS **cannot directly be the IdP for langfuse/grafana/etc.** Those apps speak
  vanilla OIDC with pre-registered clients; atproto OAuth is discovery-first and
  DPoP-bound. A bridge is mandatory, not optional.

### The bridge exists — and is vibe-coded

- **`apenwarr/atlogin`** (https://github.com/apenwarr/atlogin, 89★, updated 2026-11-19):
  Go, *"OIDC provider that logs in with ATProto"*. Email→handle conversion, WebFinger for
  own-domain handles, hosted atlogin.net option, demonstrated with Tailscale OIDC.
  README, verbatim: **"vibe-coded and has never been security reviewed."**
  Author: **Avery Pennarun** — Tailscale co-founder, also a Tangled angel. Small world.
- Others in the space: riversheher/ATConnect, NaomiAmethyst/ianthe (PDS with OIDC SSO),
  Rust crate `atproto-oauth-aip` (7,912 downloads; its repo is hosted on tangled).

### The boring, proven SSO layer

- **authentik** (https://docs.goauthentik.io): OAuth2/OIDC/SAML/LDAP/SCIM/Proxy/RADIUS
  providers; OAuth/SAML/LDAP *sources* for upstream Google/Okta/MS. The Proxy provider
  does forward-auth for apps that have no auth at all.
- **Authelia**
  (https://www.authelia.com/configuration/identity-providers/openid-connect/):
  OIDC provider + Duo/TOTP/WebAuthn 2FA.

**Architecture that falls out:** PDS (identity of record) → atlogin-style atproto→OIDC
bridge → authentik/Authelia (fleet IdP) → per-app OIDC/LDAP/forward-auth. The bridge is
the only novel security-critical component, and the only existing implementation is
self-declared unreviewed. Budget a security review or a rewrite.

---

## 3. Buying domains programmatically — the suspicion was outdated

### Cloudflare Registrar API: EXISTS (beta)

- **Beta since Apr 15 2026** (https://blog.cloudflare.com/registrar-api-beta;
  https://developers.cloudflare.com/registrar/registrar-api/, updated Sep 16 2026).
- Endpoints: search, domain-check, `POST /accounts/{id}/registrar/registrations`.
  Only required field: the domain name. WHOIS privacy free by default. Registrant =
  account default contact **or inline contact details**. Charges the account's default
  payment method. **At-cost pricing.** Already in Cloudflare's MCP by default.
- **Beta gaps: subset of TLDs; NO renewals, transfers, or contact updates via API.**
  Premium domains need explicit fee acknowledgement.
- "In the customer's name," two ways: (a) their Cloudflare account, token-delegated to
  us; (b) our account with their registrant contact inline. (a) is cleaner for the
  keep-your-infra promise.

### Alternatives

- **Porkbun API** (https://porkbun.com/api/json/v3/documentation): full
  register/renew/transfer/DNS/contacts, OpenAPI spec, first-party MCP, free sandbox.
  .com **$11.81** (Nov 2026, via https://we.inc/blog/how-much-does-a-domain-cost).
  The pragmatic fallback covering the beta's renewal/transfer gaps.
- **Namecheap API** is gated: 20+ domains OR $50 balance OR $50 spend/2yr; resell path
  is WHMCS (KB 754/10502). Friction, not a blocker.
- Cloudflare .com ≈ **$11 at-cost**. OpenSRS: unverified (SSL error on fetch).

---

## 4. DigitalOcean in the customer's name

- **DO OAuth API** (https://docs.digitalocean.com/reference/api/oauth-api/, verified
  Oct 20 2026): authorization-code flow, access to DO **teams**, confidential AND public
  clients (PKCE, dynamic client registration for MCP).
- **Precedent: xCloud** — the customer OAuth-authorizes xCloud into THEIR DigitalOcean
  account; xCloud provisions servers there
  (https://xcloud.host/docs/how-to-setup-your-server-with-digital-ocean/).
  "Charge providers in your name" is a solved pattern: OAuth delegation, customer stays
  the account holder.
- **DO affiliate: 10% RECURRING** via Awin; referral bonus $25 after $25 spend
  (https://www.digitalocean.com/affiliates). A real margin lever on top of the managed fee.
- Droplet pricing (https://www.digitalocean.com/pricing/droplets):

  | $/mo | RAM | disk | transfer |
  |------|-----|------|----------|
  | $4   | 512MiB | 10GiB | — |
  | **$6**  | 1GiB | 25GiB | 1TB |
  | **$12** | 2GiB | 50GiB | 2TB |
  | $18  | 2GiB / 2 vCPU | 60GiB | — |

  Per-second billing since Jan 1 2026. Spaces: $5/mo, 250GB + 1TB transfer.
  (Volumes per-GiB price not captured.)
- **Hetzner** (https://www.hetzner.com/cloud/cost-optimized/, raw HTML Nov 2026):
  CAX11 (2 ARM vCPU / 4GB / 40GB / 20TB) **€5.99–6.49/mo**; CAX21 (4 / 8GB / 80GB)
  €8.99–10.99. CPX11 listed €17.49–17.99 on /european-cloud/ — **suspicious, treat as
  unverified**. **No official reseller program**; third-party HostBill/FrontPanel modules
  exist. Cheaper boxes, but no clean "in their name" delegation story.
- **UpCloud HAS an official white-label program**: wholesale pricing + Partner API
  (https://upcloud.com/white-label-hub/). The only provider found with a first-party
  resell path.

---

## 5. Prior art & pricing

| Product | Stars | Price | Notes |
|---|---|---|---|
| Coolify | 66,326 | free self-host; Cloud $5/mo (2 servers, +$3/extra) | 280+ apps; cloud is panel-only |
| Dokploy | 38,635 | **$4.50/mo/server** | **Agency: white-label, user provisioning, audit logs, MSA/SLA**; MCP + AI-app sandbox w/ SSO/multitenancy |
| CapRover | 15,213 | free | 346 apps, aging |
| Cloudron | — | Free (2 apps); **Pro €15/mo yearly / €30 monthly**; Max €25/€50 | see below |
| Elestio (elest.io) | — | from $11/mo; ~$17/mo per app | 400+ tools, 100 regions, **BYOVM** |
| PikaPods | — | ~$2–4/mo per app, $1/pod min | 200 apps, hourly prepaid |
| runtipi | 9,749 | free | homeserver |
| CasaOS | 37,681 | free | personal cloud |
| YunoHost | 2,996 | free | own forge |
| Sandstorm | — | — | news through 2026-10-30, alive; historical LDAP/SAML |

Sources: https://dokploy.com/pricing; https://help.pikapods.com/faq/account;
comparison snapshot (Jun 2026):
https://dev.to/vikasprogrammer/i-compared-6-platforms-for-deploying-self-hosted-apps-in-2026-3j8.
Elestio customers include eu-LISA, 1Password, Government of Ireland.
Note: **elest.io**, not elestio.io — the latter doesn't resolve.

### Cloudron is the closest template

- https://www.cloudron.io/pricing.html — ALL plans include updates, per-app backups,
  firewall, email, **SSO**. ~$22/mo all-in with a VPS.
- **"We do not have access to your server"** — the box *pulls* updates; the vendor never
  holds SSH. Exactly the trust posture our model needs.
- Cloudron **is an OIDC provider AND an LDAP server**
  (https://docs.cloudron.io/user-directory/); per-app SSO configured at install, OIDC
  preferred over LDAP, user/group access control (https://docs.cloudron.io/apps/).

**Nobody bundles forge + atproto identity + IDE + app catalog + home mirroring.**
Closest single pieces: Cloudron (catalog+SSO+ownership), Dokploy Agency (white-label),
Elestio BYOVM (managed-on-your-VM), xCloud (OAuth-into-your-cloud).

---

## 6. Self-hosted GitHub economics

- **Gitea runs on a Pi 3**; docs recommend **2 cores + 1GB RAM** for small teams
  (https://docs.gitea.com/). A $6–12 droplet hosts forge + CI + PDS + dashboard with
  room to spare.
- **Forgejo already has the retention controls** the model needs
  (https://forgejo.org/docs/v15.0/admin/actions/): `LOG_RETENTION_DAYS=365`,
  **`ARTIFACT_RETENTION_DAYS=90`** defaults, per-workflow `retention-days`, cron cleanup,
  a **soft-quota** feature, and package cleanup rules
  (https://forgejo.org/docs/latest/user/packages/). CI disk-bloat is a solved config
  problem, not an engineering project.
- **The GitHub subsidy is real**: Free tier = unlimited public/private repos,
  **2,000 CI min/mo**, 500MB packages; **Actions on public repos is completely free**
  (https://github.com/pricing; docs.github.com Actions billing). Do not compete on free
  OSS CI — compete on private workloads, ownership, and agents.

---

## 7. Home-lab mirroring with fallback

- **Tailscale Funnel is NOT the answer**
  (https://tailscale.com/kb/1223/funnel, Jan 20 2026): still **beta**, **ts.net domain
  only — no custom domains**, ports 443/8443/10000 only, non-configurable bandwidth
  limits. Customer subdomains rule it out.
- **headscale** (https://headscale.net/): open-source self-hosted Tailscale control
  server, single tailnet. **NetBird** (https://netbird.io/): open-source WireGuard
  zero-trust, self-hostable, free tier 5 users / 100 machines.
- **The practical pattern**: WireGuard tunnel home→droplet + **Caddy `reverse_proxy`
  active/passive health checks** (`health_uri`, `fail_duration`, `max_fails`,
  `lb_try_duration` —
  https://caddyserver.com/docs/caddyfile/directives/reverse_proxy). Home box is primary;
  when it fails health checks the droplet serves the fallback. All pieces exist; the
  failover semantics and DNS/TLS wiring are ours to build.

---

## 8. App catalog + per-app auth

- **Cloudron's model is the template**: catalog install wires SSO per app at install
  time, OIDC preferred, LDAP fallback, user/group ACLs (§5).
- **authentik/Authelia are the practical fleet IdP** (§2); authentik's Proxy provider
  covers apps with no auth via forward-auth.
- "Our vibe-coded authenticator" = an atlogin-style atproto→OIDC bridge in front of
  authentik/Authelia. Note the irony: **atlogin literally describes itself as vibe-coded
  and never security-reviewed** — if we ship that pattern, the review is on us.
- **All of this runs customer-side, open source** (control-plane framing above): PDS,
  bridge, authentik/Authelia, and the catalog live on their droplet and are administered
  there. The vendor holds no SSH keys and no app credentials — Cloudron's "we do not
  have access to your server" is our architecture, not just our policy.
- **The vendor's only access path is the agent mesh** (managed tier): our support crow
  agents reach their crow agents through explicit, deny-by-default grants with durable,
  authenticated delivery — not shared admin creds. Disconnect = grants revoked, scripts
  stop; the auth stack keeps running untouched.

---

## Synthesis

### Three hardest problems (ranked, re-ranked for the customer-side control plane)

1. **PDS → OIDC bridge for arbitrary apps.** Unchanged: the spec says atproto OAuth is
   not OIDC-compatible; every catalog app expects vanilla OIDC. The only existing bridge
   (atlogin) is self-declared vibe-coded and unreviewed. It ships as customer-side open
   source, so the security review is on us before we ship it, not after.
2. **The agent-mesh support transport.** The recurring fee rides on our crow agents
   safely diagnosing, fixing, and deploying on customer boxes: deny-by-default grants,
   durable mailboxes/outboxes, authenticated cross-host delivery (Ed25519 + mTLS per the
   mesh sketch). This was "a separate product" in the earlier framing; it is now the
   core mechanism of the managed tier — and the trust surface customers are buying.
3. **One-shot provisioning + mirroring, as customer-side scripts.** With no hosted
   control plane, the orchestration lives in idempotent setup/update/disconnect scripts:
   Cloudflare Registrar beta gaps (no renewals/transfers/contact-updates), DO OAuth
   token lifecycle, knot master-key custody/escrow, and the WireGuard + Caddy
   custom-domain failover semantics (Funnel can't do custom domains). Each piece exists;
   the script layer that composes them — and disconnects cleanly — is the build.

### Three "already exists, just wire it" wins

1. **Domain purchase**: Cloudflare Registrar API beta (at-cost, already in their MCP) +
   Porkbun API as the full-lifecycle fallback. Wireable today.
2. **"In your name" cloud**: DO OAuth API + xCloud precedent + **10% recurring
   affiliate**. Solved pattern with a margin kicker — and with the thin vendor it's the
   *only* infra relationship we have.
3. **Catalog + SSO + CI economics, and most of the support transport**: Cloudron's
   OIDC/LDAP catalog model, authentik/Authelia as fleet IdP, Forgejo retention defaults —
   all on $6–12 droplets, all customer-side. The mesh transport also has existing hooks:
   crow-cli already has `wake`/`claim_deliveries` and the crow backend has
   delegations/outbox; the sketch adds one `mailbox/deliver` hook.

### Business-model precedent read (candid)

- The shape has working precedent: **Cloudron €15–25/mo with "we do not have access to
  your server"**, **Dokploy Agency white-label**, **Elestio BYOVM**, xCloud/SpinupWP.
  The thin-vendor framing is *more* capital-efficient than any of them: no hosted
  control plane to operate, nothing proprietary on the box, and **disconnect works by
  construction** (stop billing, stop firing scripts) rather than by policy. Cloudron's
  trust slogan is literally our architecture.
- **Support-ticket economics are agent-to-agent triage, not human ops.** The managed
  fee buys our support crow agents talking to their crow agents over the mesh —
  diagnose, fix, deploy — so the marginal cost of a ticket trends toward compute, not
  headcount. That is the margin story. Candid caveat: no precedent found for managed
  hosting whose support staff is agents; the grant model (deny-by-default, audited,
  revocable) is the trust product, and a human fallback path is probably needed early.
- **Nobody bundles the full package** (identity + forge + IDE + catalog + mirror +
  agent support). Every individual piece is commoditized; the moat is the integration,
  the atproto identity story, and the support mesh.
- **GitHub's free public-repo CI is a real subsidy barrier.** Compete on ownership,
  private workloads, and agent-native workflows — not on free OSS CI.
- Tangled is funded ($4.5M, Dohmke + Pennarun angels) with no revenue path yet: a fine
  substrate, a risky dependency. With the customer-side control plane, the knot
  master-key custody sits with the customer by construction — our job is the
  backup/escrow UX in the setup script, and disconnect means they keep the keys.

### Unverified / flagged

- Hetzner CPX11 €17.49–17.99 figure (scraped from a JS-rendered page; suspicious).
- OpenSRS reseller terms (SSL error; never fetched).
- DO Volumes per-GiB pricing (not captured).
