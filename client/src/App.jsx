import { useState, useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const BACKEND = "";           // relative — works via Vite proxy
const TERMINAL_COLS = 2000;   // wide enough that lines never wrap in practice; viewport scrolls horizontally
const WS_URL  = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/terminal`;

function uid() { return Math.random().toString(36).slice(2, 9); }
function b64enc(s) { return btoa(unescape(encodeURIComponent(s))); }

// ── Single terminal pane — xterm.js + SSH over WebSocket ──────────────────────
function TerminalPane({ connection }) {
  const outerRef    = useRef(null); // observed for layout changes
  const containerRef = useRef(null); // xterm mount point (inline-block, sizes to canvas)
  const [status, setStatus] = useState("disconnected");

  useEffect(() => {
    if (!connection || !containerRef.current) return;
    setStatus("connecting");

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

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    // Initial fit: use fitAddon for first render, then lock to TERMINAL_COLS
    fitAddon.fit();
    term.resize(TERMINAL_COLS, term.rows);

    // Ctrl+Shift+Up/Down → scroll one line without forwarding to PTY
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

    // On layout change: keep rows fitted to viewport height, cols fixed.
    // Observe outerRef (not containerRef) to avoid looping — containerRef
    // is inline-block and changes size whenever xterm resizes its canvas.
    const ro = new ResizeObserver(() => {
      const dims = fitAddon.proposeDimensions();
      if (dims) term.resize(TERMINAL_COLS, dims.rows);
    });
    ro.observe(outerRef.current);

    const ws = new WebSocket(WS_URL);

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
      if (msg.type === "data") {
        term.write(Uint8Array.from(atob(msg.data), c => c.charCodeAt(0)));
      } else if (msg.type === "status") {
        setStatus(msg.status);
      } else if (msg.type === "error") {
        setStatus("error");
        term.writeln(`\r\nError: ${msg.message}`);
      }
    };

    ws.onclose = () => setStatus("disconnected");

    // Keyboard input → SSH
    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "data", data: b64enc(data) }));
    });

    // Terminal resize → SSH pty resize
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });

    // Right-click: copy selection if text is selected, paste if nothing is selected
    const onContextMenu = (e) => {
      e.preventDefault();
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel);
        term.clearSelection();
      } else {
        navigator.clipboard.readText().then(t => term.paste(t));
      }
    };
    containerRef.current.addEventListener("contextmenu", onContextMenu);

    return () => {
      containerRef.current?.removeEventListener("contextmenu", onContextMenu);
      ro.disconnect();
      ws.close();
      term.dispose();
    };
  }, [connection?.name]);

  const statusColor = { connected:"#56d364", connecting:"#f0883e", disconnected:"#8b949e", error:"#f85149" }[status];

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", background:"#0d1117" }}>
      <div style={{ background:"#161b22", borderBottom:"1px solid #30363d", padding:"2px 12px", fontSize:11, color:statusColor, display:"flex", justifyContent:"space-between", flexShrink:0 }}>
        <span>● {status}</span>
        <span style={{ color:"#8b949e" }}>{connection?.user}@{connection?.host}:{connection?.port}</span>
      </div>
      <div ref={outerRef} style={{ flex:1, position:"relative" }}>
        <div style={{ position:"absolute", inset:0, overflowX:"auto", overflowY:"hidden" }}>
          <div ref={containerRef} style={{ height:"100%", display:"inline-block", verticalAlign:"top" }} />
        </div>
      </div>
    </div>
  );
}

// ── Split view ─────────────────────────────────────────────────────────────────
function SplitView({ panes, connection, onClose }) {
  return (
    <div style={{ display:"flex", flexDirection:"row", height:"100%", gap:2 }}>
      {panes.map(p => (
        <div key={p.id} style={{ flex:1, minWidth:0, position:"relative", border:"1px solid #30363d", height:"100%" }}>
          {panes.length > 1 && (
            <button onClick={() => onClose(p.id)} style={{ position:"absolute", top:4, right:6, zIndex:10, background:"transparent", border:"none", color:"#8b949e", cursor:"pointer", fontSize:12 }}>✕</button>
          )}
          <TerminalPane connection={connection} />
        </div>
      ))}
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────────
export default function App() {
  const [hosts, setHosts]     = useState([]);
  const [tabs, setTabs]       = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [backendOk, setBackendOk] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${BACKEND}/hosts`);
        const h = await r.json();
        setHosts(h);
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

  const activeTabObj = tabs.find(t => t.id === activeTab);

  function newTab(conn) {
    const t = { id: uid(), conn: conn ?? hosts[0], panes: [{ id: uid() }] };
    setTabs(ts => [...ts, t]);
    setActiveTab(t.id);
  }

  function closeTab(id) {
    setTabs(ts => {
      const next = ts.filter(t => t.id !== id);
      if (activeTab === id && next.length) setActiveTab(next[next.length-1].id);
      return next.length ? next : ts;
    });
  }

  function splitPane() {
    setTabs(ts => ts.map(t => t.id === activeTab ? { ...t, panes: [...t.panes, { id: uid() }] } : t));
  }

  function closePane(paneId) {
    setTabs(ts => ts.map(t => t.id === activeTab ? { ...t, panes: t.panes.filter(p => p.id !== paneId) } : t));
  }

  if (backendOk === false) return (
    <div style={{ height:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#0d1117", color:"#f85149", fontFamily:"monospace", textAlign:"center", padding:40 }}>
      <div>
        <div style={{ fontSize:32, marginBottom:16 }}>⚠ Backend not running</div>
        <div style={{ color:"#8b949e", lineHeight:2 }}>
          Start it with:<br/>
          <code style={{ color:"#79c0ff" }}>node server.js</code><br/><br/>
          Then reload this page.
        </div>
      </div>
    </div>
  );

  if (backendOk === null) return (
    <div style={{ height:"100vh", display:"flex", alignItems:"center", justifyContent:"center", background:"#0d1117", color:"#8b949e", fontFamily:"monospace" }}>
      Connecting to backend…
    </div>
  );

  return (
    <div style={{ height:"100vh", display:"flex", flexDirection:"column", background:"#0d1117", color:"#c9d1d9" }}>
      {/* tab bar */}
      <div style={{ display:"flex", alignItems:"center", background:"#161b22", borderBottom:"1px solid #30363d", padding:"0 8px", gap:4, flexShrink:0 }}>
        <div style={{ display:"flex", flex:1, overflowX:"auto", gap:2, padding:"4px 0" }}>
          {tabs.map(t => (
            <div key={t.id} onClick={() => setActiveTab(t.id)}
              style={{ display:"flex", alignItems:"center", gap:6, padding:"4px 12px", borderRadius:6, cursor:"pointer",
                background: t.id === activeTab ? "#0d1117" : "transparent",
                border: t.id === activeTab ? "1px solid #30363d" : "1px solid transparent", whiteSpace:"nowrap", fontSize:12 }}>
              <span style={{ color: t.id === activeTab ? "#79c0ff" : "#8b949e" }}>⬛ {t.conn?.name}</span>
              {tabs.length > 1 && <span onClick={e => { e.stopPropagation(); closeTab(t.id); }} style={{ color:"#8b949e", fontSize:10, cursor:"pointer" }}>✕</span>}
            </div>
          ))}
          <select onChange={e => { if (e.target.value) { newTab(hosts.find(h => h.name === e.target.value)); e.target.value=""; } }}
            style={{ background:"#161b22", border:"1px solid #30363d", borderRadius:6, color:"#c9d1d9", padding:"2px 8px", fontSize:12, cursor:"pointer" }}>
            <option value="">＋ New tab…</option>
            {hosts.map(h => <option key={h.name} value={h.name}>{h.name}</option>)}
          </select>
        </div>
        <button onClick={splitPane} style={btn}>⊞ Split</button>
      </div>

      {/* terminal */}
      <div style={{ flex:1, overflow:"hidden" }}>
        {activeTabObj && (
          <SplitView panes={activeTabObj.panes} connection={activeTabObj.conn} onClose={closePane} />
        )}
      </div>
    </div>
  );
}

const btn = { background:"transparent", border:"1px solid #30363d", borderRadius:6, color:"#c9d1d9", cursor:"pointer", padding:"4px 10px", fontSize:12, fontFamily:"inherit" };
