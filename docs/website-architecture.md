 1→# crow-ai.dev — "a website for setting up websites"
 2→
 3→Transcribed from the whiteboard (webcam 4, 2026-11-21). The product: a user
 4→signs up at crow-ai.dev, pays via Stripe, and gets a hosted instance
 5→provisioned on DigitalOcean with a domain (Cloudflare), a crow agent + IDE,
 6→a PDS, and tangled — with offboarding that disconnects cleanly and transfers
 7→payments directly.
 8→
 9→```mermaid
10→flowchart TD
11→    site["https://crow-ai.dev"]
12→    lb["LOAD BALANCER / INGRESS<br/>(nginx? caddy?)"]
13→    site <--> lb
14→
15→    cf(["Cloudflare"])
16→    docean(["DigitalOcean"])
17→    stripe(["Stripe<br/>(payment processor)"])
18→
19→    lb --- dns["DNS service<br/>allocates domains<br/>via Cloudflare API"]
20→    lb --- user["User service<br/>service for user info"]
21→    lb --- resource["Resource service<br/>DigitalOcean API for building<br/>out hosted instances for users"]
22→    lb --- payments["Payments service<br/>processing payments for users /<br/>charge for our service"]
23→    lb --- agent["Agent service<br/>setting up agents/IDE<br/>on instances"]
24→    lb --- pds["PDS<br/>setting up PDS<br/>on instances"]
25→    lb --- tangled["Tangled service<br/>setting up tangled<br/>on instances"]
26→
27→    cf --> dns
28→    docean --> dns
29→    docean --> resource
30→    stripe --> payments
31→
32→    user --> db[("DB")]
33→    payments --> off["Offboarding service<br/>disconnect users,<br/>transfer payments directly"]
34→    off --> stripe
35→```
36→
37→## Reading of the board
38→
39→- **crow-ai.dev** sits behind one **load balancer / ingress** — the board
40→  leaves the choice open: *nginx? caddy?*
41→- Seven services hang off the ingress bus: **DNS**, **User**, **Resource**,
42→  **Payments**, **Agent**, **PDS**, **Tangled**.
43→- **External providers** (ellipses on the board): Cloudflare (domains/DNS),
44→  DigitalOcean (instances), Stripe (payments).
45→- **User service** owns the database (the cylinder).
46→- **Offboarding service** hangs below payments: disconnect users, transfer
47→  payments directly (back out through Stripe).
48→- The three "on instances" services (Agent, PDS, Tangled) configure what
49→  Resource provisions — the instance itself is implied, not drawn as a box.
## The control-plane split (Thomas's correction, 2026-11-21)

The control plane lives on THEIR side. crow-ai.dev is thin: a payments
ledger, a one-shot script dispatcher, and a fleet of support agents.
Everything installed on the customer's droplet — dashboard, PDS, tangled,
crow IDE, apps — is open source and administered on their side.

- We charge an up-front setup fee, then charge providers in the customer's
  name (their card, their accounts). Our recurring fee is for the managed
  version only.
- The disconnect/"fuck off" button works by construction: we stop billing
  and stop firing scripts. Nothing proprietary runs on their box, so there
  is nothing to take away. Exit is not a promise, it's the absence of a
  dependency.
- The managed version's value IS the support: our crow agents talk to their
  crow agents to diagnose, fix, and deploy across the mesh of managed
  services. Support tickets are the product, not a cost center.

```mermaid
flowchart LR
    subgraph ours["crow-ai.dev — thin"]
        billing["Payments ledger<br/>(Stripe)"]
        dispatch["One-shot script dispatcher<br/>setup / update / disconnect"]
        support["Support crow agents"]
    end
    subgraph theirs["Their droplet — thick, all open source"]
        cp["Control plane / dashboard"]
        pds2["PDS (identity/SSO)"]
        knot["tangled knot + spindle"]
        ide["crow IDE + local crow agent"]
        apps["Their apps"]
    end
    providers(["Cloudflare / DigitalOcean<br/>billed in customer's name"])
    billing --> providers
    dispatch -->|"signed, idempotent one-shot scripts"| cp
    support <-->|"mesh: granted agent-to-agent mail"| ide
    cp --- pds2
    cp --- knot
    cp --- ide
    cp --- apps
```

The agent mesh from the earlier research is not a separate product — it is
the managed-support transport: per-customer grants (customer consents to our
support agent addressing their agent), durable mailboxes as the ticket
queue, authenticated cross-host delivery. The script channel and the agent
channel share one security model: node keys, signed payloads, deny-by-default
grants.
