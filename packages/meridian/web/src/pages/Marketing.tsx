/*
 * Agamemnon — AI-agent write-path guardian
 * Copyright (c) 2026 Elamaran Elangovan. All rights reserved.
 *
 * Proprietary and confidential. No licence is granted to use, copy, modify,
 * distribute, or run this software beyond local evaluation of this repository
 * as published. See LICENSE at the repository root.
 *
 * ref: AGMN-BOZW-F6BTKX-X3LAO
 */

export function Marketing() {
  return (
    <main className="mf-main">
      <div className="hero">
        <h1>Freight, brokered right.</h1>
        <p>
          Meridian Freight has moved full-truckload and LTL freight for North American shippers
          since 2011. 4,200 vetted carriers, 24/7 dispatch, and a claims ratio under 0.4%. When the
          load has to arrive, brokers call Meridian.
        </p>
      </div>

      <div className="panel">
        <div className="body">
          <div className="services">
            <div className="service">
              <h3>Full Truckload</h3>
              <p>
                Dedicated capacity across 48 states with real-time tracking and guaranteed pickup
                windows. Dry van, reefer, and flatbed.
              </p>
            </div>
            <div className="service">
              <h3>LTL &amp; Partial</h3>
              <p>
                Consolidated less-than-truckload lanes with transparent class-based pricing and
                same-day BOL generation.
              </p>
            </div>
            <div className="service">
              <h3>Managed Dispatch</h3>
              <p>
                Our night desk and AI dispatch tooling keep loads moving while your team sleeps.
                Exception handling, not spreadsheets.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Trusted by shippers &amp; carriers</h2>
        <div className="body">
          <div className="logos">
            <span>NORTHBEND</span>
            <span>Allied Grocers</span>
            <span>CedarWorks</span>
            <span>PrairieCold</span>
            <span>Grant &amp; Hume</span>
            <span>Vantage Retail</span>
          </div>
        </div>
      </div>

      <p className="tiny">
        Operations staff: use the <a className="mf-link" href="#/dispatch">Dispatch Board</a> for
        live load status. Nightly cleanup is handled by{" "}
        <a className="mf-link" href="#/ai-ops">Dispatch Copilot</a>.
      </p>
    </main>
  );
}
