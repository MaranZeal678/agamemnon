import { useHashRoute } from "./api";
import { Marketing } from "./pages/Marketing";
import { Dashboard } from "./pages/Dashboard";
import { AiOps } from "./pages/AiOps";

export function App() {
  const hash = useHashRoute();
  const route = hash.replace(/^#/, "") || "/";

  return (
    <div>
      <header className="mf-header">
        <div className="mf-header-inner">
          <a className="mf-logo" href="#/" style={{ textDecoration: "none" }}>
            <div className="mark">M</div>
            <div className="word">
              MERIDIAN FREIGHT
              <small>BROKERAGE OPERATIONS</small>
            </div>
          </a>
          <div className="mf-userbox">
            Signed in as <b>ops.dispatch</b>
            <br />
            Terminal: <b>CHI-04</b> · Shift: Nights
          </div>
        </div>
      </header>

      <nav className="mf-nav">
        <div className="mf-nav-inner">
          <a href="#/" className={route === "/" ? "active" : ""}>
            Home
          </a>
          <a href="#/dispatch" className={route === "/dispatch" ? "active" : ""}>
            Dispatch Board
          </a>
          <a href="#/ai-ops" className={route === "/ai-ops" ? "active" : ""}>
            AI Operations
          </a>
          <a href="#/" onClick={(e) => e.preventDefault()}>
            Carriers
          </a>
          <a href="#/" onClick={(e) => e.preventDefault()}>
            Billing
          </a>
          <a href="#/" onClick={(e) => e.preventDefault()}>
            Reports
          </a>
        </div>
      </nav>

      {route === "/dispatch" ? <Dashboard /> : route === "/ai-ops" ? <AiOps /> : <Marketing />}

      <footer className="mf-footer">
        Meridian Freight Brokerage, LLC · MC-472019 · DOT-1580372 · 4400 W Diversey Ave, Chicago IL
        60639
        <br />
        Internal operations portal v3.8.2 · © 2011–2026 Meridian Freight · Support ext. 4041
      </footer>
    </div>
  );
}
