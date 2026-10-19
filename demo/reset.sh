#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Elamaran Elangovan
# Cold demo state (board back to 412,000, Convex feed cleared). Delegates to the
# canonical reset. Kept here because the demo folder is where a presenter looks.
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/reset.sh"
