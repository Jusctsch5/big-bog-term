import { useState, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const BACKEND      = "";
const TERMINAL_COLS = 2000;
const WS_URL       = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/terminal`;

// Reserve space for Electron's native title-bar overlay controls (~138 px on Windows)
const isElectron   = navigator.userAgent.includes("Electron");

function uid()     { return Math.random().toString(36).slice(2, 9); }
function b64enc(s) { return btoa(unescape(encodeURIComponent(s))); }

// ── Commands menu ──────────────────────────────────────────────────────────────
function CommandMenuItem({ item, onSelect, depth = 0 }) {
  const [expanded, setExpanded] = useState(false);
  const pl = 10 + depth * 14;
  const rowBase = {
    padding: "5px 10px", paddingLeft: pl, cursor: "pointer",
    fontSize: 12, color: "#c9d1d9", display: "flex", alignItems: "center",
    gap: 6, userSelect: "none",
  };
  const hover = (e, on) => { e.currentTarget.style.background = on ? "#21262d" : ""; };

  if (item.type === "folder") {
    return (
      <div>
        <div style={rowBase} onClick={() => setExpanded(x => !x)}
          onMouseEnter={e => hover(e, true)} onMouseLeave={e => hover(e, false)}>
          <span style={{ fontSize: 9, color: "#8b949e", width: 8 }}>{expanded ? "▾" : "▸"}</span>
          <span style={{ fontSize: 11 }}>📁</span>
          <span>{item.name}</span>
        </div>
        {expanded && item.children?.map((child, i) =>
          <CommandMenuItem key={i} item={child} onSelect={onSelect} depth={depth + 1} />
        )}
      </div>
    );
  }

  return (
    <div style={{ ...rowBase, paddingLeft: pl + 22 }}
      onClick={() => onSelect(item.command)}
      onMouseEnter={e => hover(e, true)} onMouseLeave={e => hover(e, false)}>
      {item.name}
    </div>
  );
}

function CommandsDropdown({ commands, onSelect }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => setOpen(o => !o)} title="Commands"
        style={{ ...btn, padding: "3px 9px", fontSize: 13, opacity: open ? 1 : 0.75 }}>▾</button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0,
          background: "#161b22", border: "1px solid #30363d", borderRadius: 6,
          zIndex: 200, minWidth: 220, maxHeight: 400, overflowY: "auto",
          boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
        }}>
          {commands.length === 0
            ? <div style={{ padding: "10px 14px", color: "#8b949e", fontSize: 12, lineHeight: 1.6 }}>
                No commands configured.<br />
                Edit <code style={{ color: "#79c0ff" }}>commands.json</code> to add some.
              </div>
            : commands.map((item, i) =>
                <CommandMenuItem key={i} item={item} depth={0}
                  onSelect={(cmd) => { onSelect(cmd); setOpen(false); }} />
              )
          }
        </div>
      )}
    </div>
  );
}

// ── Single terminal pane — xterm.js + SSH over WebSocket ──────────────────────
function TerminalPane({ connection, pendingCommand }) {
  const outerRef     = useRef(null);
  const containerRef = useRef(null);
  const termRef      = useRef(null);
  const wsRef        = useRef(null);
  const [vscroll, setVscroll] = useState({ pos: 0, total: 0, rows: 0 });

  // Inject a command into the live SSH session
  useEffect(() => {
    if (!pendingCommand?.text) return;
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: "data", data: b64enc(pendingCommand.text + "\r") }));
  }, [pendingCommand?.nonce]);

  useEffect(() => {
    if (!connection || !containerRef.current) return;

    const term = new Terminal({
      theme: {
        background: "#0d1117", foreground: "#c9d1d9", cursor: "#c9d1d9",
        selectionBackground: "#264f78",
        black: "#484f58",   red: "#ff7b72",   green: "#3fb950",  yellow: "#d29922",
        blue: "#58a6ff",    magenta: "#bc8cff", cyan: "#39c5cf",  white: "#b1bac4",
        brightBlack: "#6e7681", brightRed: "#ffa198",  brightGreen: "#56d364",
        brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff",
        brightCyan: "#56d4dd",  brightWhite: "#f0f6fc",
      },
      fontFamily: "'Fira Mono','Courier New',monospace",
      fontSize: 13,
      lineHeight: 1.5,
      cursorBlink: true,
    });

    termRef.current = term;

    function syncVscroll() {
      const buf = term.buffer.active;
      setVscroll({ pos: buf.viewportY, total: buf.length, rows: term.rows });
    }

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    term.resize(TERMINAL_COLS, term.rows);

    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey) {
        if (e.shiftKey) {
          if (e.key === "ArrowUp")   { term.scrollLines(-1); return false; }
          if (e.key === "ArrowDown") { term.scrollLines(1);  return false; }
        }
        if (!e.shiftKey && e.key === "v") {
          navigator.clipboard.readText().then(t => term.paste(t));
          return false;
        }
      }
      return true;
    });

    const ro = new ResizeObserver(() => {
      const dims = fitAddon.proposeDimensions();
      if (dims && dims.rows > 0) term.resize(TERMINAL_COLS, dims.rows);
    });
    ro.observe(outerRef.current);

    term.onScroll(syncVscroll);
    term.onWriteParsed(syncVscroll);
    term.onResize(syncVscroll);

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "connect",
        host: connection.host, port: connection.port,
        user: connection.user, identityFile: connection.identityFile,
        cols: term.cols, rows: term.rows,
      }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "data")
        term.write(Uint8Array.from(atob(msg.data), c => c.charCodeAt(0)));
    };

    ws.onclose = () => { wsRef.current = null; };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "data", data: b64enc(data) }));
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });

    const onContextMenu = (e) => {
      e.preventDefault();
      const sel = term.getSelection();
      if (sel) { navigator.clipboard.writeText(sel); term.clearSelection(); }
      else      { navigator.clipboard.readText().then(t => term.paste(t)); }
    };
    containerRef.current.addEventListener("contextmenu", onContextMenu);

    return () => {
      containerRef.current?.removeEventListener("contextmenu", onContextMenu);
      ro.disconnect();
      ws.close();
      term.dispose();
      termRef.current = null;
      wsRef.current   = null;
    };
  }, [connection?.name]);

  // Overlay scrollbar geometry
  const scrollable = Math.max(0, vscroll.total - vscroll.rows);
  const thumbRatio = scrollable > 0 ? vscroll.rows / vscroll.total : 1;
  const thumbTop   = scrollable > 0 ? (vscroll.pos / scrollable) * (1 - thumbRatio) : 0;

  function handleVScrollClick(e) {
    const t = termRef.current;
    if (!t) return;
    const buf = t.buffer.active;
    const sc  = Math.max(0, buf.length - t.rows);
    if (sc <= 0) return;
    const rect   = e.currentTarget.getBoundingClientRect();
    const target = Math.round(((e.clientY - rect.top) / rect.height) * sc);
    t.scrollLines(target - buf.viewportY);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#0d1117" }}>
      <div ref={outerRef} style={{ flex: 1, position: "relative" }}>
        <div className="term-hscroll"
          style={{ position: "absolute", inset: 0, overflowX: "auto", overflowY: "hidden" }}>
          <div ref={containerRef}
            style={{ height: "100%", display: "inline-block", verticalAlign: "top" }} />
        </div>
        {scrollable > 0 && (
          <div onClick={handleVScrollClick}
            style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 8, zIndex: 10,
              cursor: "pointer", background: "rgba(13,17,23,0.6)", borderLeft: "1px solid #30363d" }}>
            <div style={{ position: "absolute", left: 0, right: 0,
              top: `${thumbTop * 100}%`, height: `${thumbRatio * 100}%`,
              background: "rgba(201,209,217,0.35)", borderRadius: 4, pointerEvents: "none" }} />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Split view ─────────────────────────────────────────────────────────────────
function SplitView({ panes, connection, onClose, pendingCommand }) {
  return (
    <div style={{ display: "flex", flexDirection: "row", height: "100%", gap: 2 }}>
      {panes.map((p, i) => (
        <div key={p.id}
          style={{ flex: 1, minWidth: 0, position: "relative", border: "1px solid #30363d", height: "100%" }}>
          {panes.length > 1 && (
            <button onClick={() => onClose(p.id)}
              style={{ position: "absolute", top: 4, right: 6, zIndex: 10, background: "transparent",
                border: "none", color: "#8b949e", cursor: "pointer", fontSize: 12 }}>✕</button>
          )}
          {/* Only first pane in the active tab receives injected commands */}
          <TerminalPane connection={connection} pendingCommand={i === 0 ? pendingCommand : undefined} />
        </div>
      ))}
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────────
export default function App() {
  const [hosts, setHosts]         = useState([]);
  const [commands, setCommands]   = useState([]);
  const [tabs, setTabs]           = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [backendOk, setBackendOk] = useState(null);
  const [pendingCommand, setPendingCommand] = useState(null);
  const [showNewTabMenu, setShowNewTabMenu] = useState(false);
  const newTabMenuRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const [hostsRes, cmdsRes] = await Promise.all([
          fetch(`${BACKEND}/hosts`),
          fetch(`${BACKEND}/commands`),
        ]);
        const h = await hostsRes.json();
        const c = await cmdsRes.json();
        setHosts(h);
        setCommands(Array.isArray(c) ? c : []);
        setBackendOk(true);
        if (h.length) {
          const t = { id: uid(), conn: h[0], panes: [{ id: uid() }] };
          setTabs([t]);
          setActiveTab(t.id);
        }
      } catch {
        setBackendOk(false);
      }
    })();
  }, []);

  // Close the new-tab host picker when clicking outside it
  useEffect(() => {
    if (!showNewTabMenu) return;
    const close = (e) => { if (!newTabMenuRef.current?.contains(e.target)) setShowNewTabMenu(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showNewTabMenu]);

  function newTab(conn) {
    const t = { id: uid(), conn: conn ?? hosts[0], panes: [{ id: uid() }] };
    setTabs(ts => [...ts, t]);
    setActiveTab(t.id);
    setShowNewTabMenu(false);
  }

  function closeTab(id) {
    setTabs(ts => {
      const next = ts.filter(t => t.id !== id);
      if (activeTab === id && next.length) setActiveTab(next[next.length - 1].id);
      return next.length ? next : ts;
    });
  }

  function splitPane() {
    setTabs(ts => ts.map(t => t.id === activeTab
      ? { ...t, panes: [...t.panes, { id: uid() }] } : t));
  }

  function closePane(paneId) {
    setTabs(ts => ts.map(t => t.id === activeTab
      ? { ...t, panes: t.panes.filter(p => p.id !== paneId) } : t));
  }

  function handleCommandSelect(cmd) {
    setPendingCommand({ text: cmd, nonce: uid() });
  }

  if (backendOk === false) return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0d1117", color: "#f85149", fontFamily: "monospace", textAlign: "center", padding: 40 }}>
      <div>
        <div style={{ fontSize: 32, marginBottom: 16 }}>⚠ Backend not running</div>
        <div style={{ color: "#8b949e", lineHeight: 2 }}>
          Start it with:<br />
          <code style={{ color: "#79c0ff" }}>node server.js</code><br /><br />
          Then reload this page.
        </div>
      </div>
    </div>
  );

  if (backendOk === null) return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "#0d1117", color: "#8b949e", fontFamily: "monospace" }}>
      Connecting to backend…
    </div>
  );

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "#0d1117", color: "#c9d1d9" }}>

      {/* ── Tab bar (Windows-Terminal-style: one slim bar, no separate title) ── */}
      {/* WebkitAppRegion drag lets the user move the window by clicking empty space */}
      <div style={{ display: "flex", alignItems: "center", background: "#161b22",
        borderBottom: "1px solid #30363d", padding: "0 4px", gap: 2, flexShrink: 0, height: 36,
        WebkitAppRegion: "drag",
        paddingRight: isElectron ? 148 : 4 /* leave room for native min/max/close */ }}>

        {/* Commands dropdown — far left */}
        <div style={{ WebkitAppRegion: "no-drag", flexShrink: 0 }}>
          <CommandsDropdown commands={commands} onSelect={handleCommandSelect} />
        </div>

        {/* Scrollable tab strip — no-drag so tab clicks and horizontal scroll work */}
        <div style={{ display: "flex", flex: 1, overflowX: "auto", alignItems: "center",
          gap: 1, padding: "4px 0", minWidth: 0, WebkitAppRegion: "no-drag" }}>
          {tabs.map(t => (
            <div key={t.id} onClick={() => setActiveTab(t.id)}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 10px",
                borderRadius: 4, cursor: "pointer", flexShrink: 0, fontSize: 12,
                background: t.id === activeTab ? "#0d1117" : "transparent",
                border:     t.id === activeTab ? "1px solid #30363d" : "1px solid transparent" }}>
              <span style={{ color: t.id === activeTab ? "#79c0ff" : "#8b949e" }}>{t.conn?.name}</span>
              {tabs.length > 1 && (
                <span onClick={e => { e.stopPropagation(); closeTab(t.id); }}
                  style={{ color: "#8b949e", fontSize: 10, cursor: "pointer", lineHeight: 1 }}>✕</span>
              )}
            </div>
          ))}
        </div>

        {/* + new tab */}
        <div ref={newTabMenuRef} style={{ position: "relative", flexShrink: 0, WebkitAppRegion: "no-drag" }}>
          <button onClick={() => hosts.length > 1 ? setShowNewTabMenu(m => !m) : newTab()}
            title="New tab" style={{ ...btn, padding: "1px 9px", fontSize: 18, lineHeight: 1 }}>+</button>
          {showNewTabMenu && (
            <div style={{ position: "absolute", top: "calc(100% + 4px)", right: 0,
              background: "#161b22", border: "1px solid #30363d", borderRadius: 6,
              zIndex: 200, minWidth: 180, boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}>
              {hosts.map(h => (
                <div key={h.name} onClick={() => newTab(h)}
                  style={{ padding: "7px 14px", cursor: "pointer", fontSize: 12, color: "#c9d1d9" }}
                  onMouseEnter={e => { e.currentTarget.style.background = "#21262d"; }}
                  onMouseLeave={e => { e.currentTarget.style.background = ""; }}>
                  {h.name}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Split */}
        <div style={{ WebkitAppRegion: "no-drag", flexShrink: 0 }}>
          <button onClick={splitPane} style={btn}>⊞ Split</button>
        </div>
      </div>

      {/* ── Terminal area — all tabs mounted, inactive hidden ── */}
      <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
        {tabs.map(tab => (
          <div key={tab.id} style={{ position: "absolute", inset: 0, flexDirection: "column",
            display: tab.id === activeTab ? "flex" : "none" }}>
            <SplitView panes={tab.panes} connection={tab.conn} onClose={closePane}
              pendingCommand={tab.id === activeTab ? pendingCommand : undefined} />
          </div>
        ))}
      </div>
    </div>
  );
}

const btn = {
  background: "transparent", border: "1px solid #30363d", borderRadius: 6,
  color: "#c9d1d9", cursor: "pointer", padding: "4px 10px", fontSize: 12, fontFamily: "inherit",
};
