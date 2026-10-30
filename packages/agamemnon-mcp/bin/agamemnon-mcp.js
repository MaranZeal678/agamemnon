#!/usr/bin/env node
// Agamemnon MCP server launcher
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan
const { main } = await import("../src/server.ts");
await main();
