# Contributing to Agamemnon

Thanks for wanting to help. Agamemnon sits between AI agents and production
systems, so changes are reviewed for safety first and features second.

## How we work

- **Found a bug?** Open an issue with what happened, what you expected, and a
  minimal reproduction (the effect request, the broker's response, versions).
- **Want a feature or a new connector?** Open an issue describing the problem
  first. Don't start with code; agree on the approach in the issue.
- **Typos, broken links, small doc fixes, obvious one-line bugs:** open a pull
  request directly.
- **Everything else:** wait until the issue has an agreed approach, then open a
  pull request that links it (`Fixes #123`). Pull requests for unagreed changes
  may be closed so the discussion can happen in the issue.
- **Security problems** never go in public issues. See [SECURITY.md](SECURITY.md).

## What you can contribute to

Everything under the [Apache License 2.0](LICENSE): the kernel, broker,
connectors, MCP server, hooks, CLI, bench, deploy files and docs.

The proprietary packages listed in [NOTICE](NOTICE) (`agamemnon-guard`,
`halcyon`, `desktop`, `northwind-bank`, `console`, `agamemnon/console`) do not
take outside pull requests. Bug reports about them are welcome.

## Sign your commits (DCO)

Every commit must carry a `Signed-off-by` line, certifying the
[Developer Certificate of Origin](https://developercertificate.org): that you
wrote the change or otherwise have the right to submit it under Apache-2.0.

```bash
git commit -s -m "broker: refuse effects on a frozen target"
```

There is no CLA. Contributions are accepted under the same Apache-2.0 licence
as the rest of the open code.

## Development setup

Requirements: Node 24, and PostgreSQL 14 on `127.0.0.1:5432` for the database
tests.

```bash
npm install
make test-all    # kernel, policy, broker (live Postgres), MCP, hooks, CLI
make bench       # Agent Incident Replay Bench
```

Database tests skip themselves when Postgres is unreachable. Point them at
another server with `AGM_TEST_PG_ADMIN_URL=postgres://user@host:port/postgres`.

## What a good pull request looks like

- **Small and focused:** one issue per pull request.
- **Tested:** a test that fails before your change and passes after. A change to
  admission, binding, verification or revert needs a test that shows the unsafe
  case is refused, not only that the safe case works.
- **Matches the code around it:** the kernel stays dependency-free; follow the
  naming, comment density and idioms of the file you are editing.
- **Licensed:** new source files start with
  `// SPDX-License-Identifier: Apache-2.0` and `// Copyright 2026 <you>`.
- **Honest:** if a change makes a claim (in docs, logs or the bench), it must be
  true and checked. See "What we claim — and what we don't" in the README.

## AI-assisted contributions

Using AI tools is fine. What matters is that a person is accountable:

- **Disclose it** in one line in the pull request description.
- **Own it:** you can explain every line and answer review questions yourself.
- **Keep a human in the loop:** no agent-opened pull requests or agent-posted
  comments. Pull requests that look unreviewed will be closed.
