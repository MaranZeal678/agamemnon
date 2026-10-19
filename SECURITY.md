# Security policy

Agamemnon is a security boundary for AI agents, so we take reports seriously and
would rather hear about a problem early than late.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request.**

Report privately through GitHub: the repository's **Security** tab →
**Report a vulnerability**. If that is unavailable, email
contact@elamaran.co with "SECURITY" in the subject.

Please include:

- what an attacker can do, and what they need first (an agent token, an
  operator token, local access, a malicious extension…);
- the steps or a minimal script that reproduces it;
- the commit or version you tested.

We aim to acknowledge reports within a few days, keep you updated while we work
on a fix, and credit you when it is disclosed, unless you would rather stay
anonymous. Please give us a reasonable chance to fix the issue before you
disclose it publicly.

## What is in scope

The open code: the kernel, broker, connectors, MCP server, hooks and CLI. We are
most interested in anything that breaks the safety loop, for example:

- an effect that runs without the approvals its admission required;
- an approval that applies to a different effect than the one previewed
  (binding or precondition drift);
- an agent obtaining a real credential from the broker or vault;
- an agent reaching operator or admin endpoints, or approving its own effects;
- tampering with the audit chain or receipts without detection;
- a broker extension overriding a core route or reaching `/v1/admin/`;
- selective revert losing a later human edit.

## Known limits (not vulnerabilities by themselves)

These are documented design limits; see [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md)
and "Honest limits" in [docs/GEN2.md](docs/GEN2.md):

- **Hooks are advisory.** Safety rests on agents not holding real credentials.
- **Extensions are trusted code.** They run inside the broker process with full
  access, like any dependency you install.
- **Single node.** The broker runs as one process on SQLite.

A way to turn one of these limits into a concrete bypass of the broker is still
worth reporting.

## Supported versions

Security fixes go to the latest release and the `master` branch.
