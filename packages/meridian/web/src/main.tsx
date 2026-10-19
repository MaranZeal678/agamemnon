// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Elamaran Elangovan

import React from "react";
import { createRoot } from "react-dom/client";
import "./meridian.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
