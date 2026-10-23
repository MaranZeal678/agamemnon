#!/usr/bin/env node
// agamemnon CLI launcher
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan
const { main } = await import("../src/cli.ts");
await main();
