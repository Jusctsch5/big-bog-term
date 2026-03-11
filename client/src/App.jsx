import { useState, useEffect, useRef, useCallback } from "react";

const BACKEND = "";           // relative — works via Vite proxy
const WS_URL  = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/terminal`;
const STORAGE_KEY_HISTORY = "term:history";

function uid() { return Math.random().toString(36).slice(2, 9); }
function b64enc(s) { return btoa(unescape(encodeURIComponent(s))); }
function b64dec(s) { try { return decodeURIComponent(escape(atob(s))); } catch { return atob(s); } }

// ── Single terminal pane with real SSH over WebSocket ─────────────────────────
function TerminalPane({ connection, history, onCommand }) {
  const [lines, setLines]     = useState([]);
  const [input, setInput]     = useState("");
  const [histIdx, setHistIdx] = useState(-1);
  const [status, setStatus]   = useState("disconnected"); // connecting|connected|disconnected|error
  const [search, setSearch]   = useState({ active:false, query:"", match:"" });
  const wsRef    = useRef(null);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  // ── Connect / disconnect on mount ──────────────────────────────────────────
  useEffect(() => {
    if (!connection) return;
    setLines([`Connecting to ${connection.name} (${connection.user}@${connection.host}:${connection.port})…`]);
    setStatus("connecting");

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: "connect",
        host: connection.host,
        port: connection.port,
        user: connection.user,
        identityFile: connection.identityFile,
        cols: 220, rows: 50,
      }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "data") {
        setLines(l => [...l, b64dec(msg.data)]);
      } else if (msg.type === "status") {
        setStatus(msg.status);
        if (msg.status === "connected") setLines(l => [...l, "── connected ──\r\n"]);
        if (msg.status === "disconnected") setLines(l => [...l, "\r\n── session ended ──"]);
      } else if (msg.type === "error") {
        setStatus("error");
        setLines(l => [...l, `\r\nError: ${msg.message}`]);
      }
    };

    ws.onclose = () => setStatus("disconnected");

    return () => { ws.close(); };
  }, [connection?.name]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:"smooth" }); }, [lines]);
  useEffect(() => { inputRef.current?.focus(); }, []);

  // ── Send keystroke ─────────────────────────────────────────────────────────
  const send = useCallback((text) => {
    wsRef.current?.send(JSON.stringify({ type:"data", data: b64enc(text) }));
  }, []);

  // ── Submit command ─────────────────────────────────────────────────────────
  const submit = useCallback((cmd) => {
    onCommand(cmd);
    send(cmd + "\n");
    setInput("");
    setHistIdx(-1);
  }, [send, onCommand]);

  function handleKeyDown(e) {
    // Ctrl-R
    if (e.ctrlKey && e.key === "r") {
      e.preventDefault();
      setSearch(s => ({ active:!s.active, query:"", match:"" }));
      return;
    }
    // Ctrl-C / Ctrl-D etc — forward raw
    if (e.ctrlKey && !search.active) {
      const ctrlMap = { c:"\x03", d:"\x04", z:"\x1a", l:"\x0c", a:"\x01", e:"\x05", u:"\x15", k:"\x0b" };
      if (ctrlMap[e.key]) { e.preventDefault(); send(ctrlMap[e.key]); return; }
    }
    if (search.active) {
      if (e.key === "Escape") { setSearch({ active:false, query:"", match:"" }); return; }
      if (e.key === "Enter")  { setInput(search.match); setSearch({ active:false, query:"", match:"" }); return; }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(histIdx + 1, history.length - 1);
      setHistIdx(next);
      setInput(history[history.length - 1 - next] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = Math.max(histIdx - 1, -1);
      setHistIdx(next);
      setInput(next === -1 ? "" : history[history.length - 1 - next] ?? "");
    } else if (e.key === "Enter") {
      submit(input);
    } else if (e.key === "Tab") {
      e.preventDefault();
      send("\t"); // forward tab for remote completion
    }
  }

  function handleSearchChange(e) {
    const q = e.target.value;
    const matches = history.filter(h => h.includes(q));
    setSearch(s => ({ ...s, query:q, match: matches[matches.length-1] ?? "" }));
  }

  const statusColor = { connected:"#56d364", connecting:"#f0883e", disconnected:"#8b949e", error:"#f85149" }[status];

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", background:"#0d1117", color:"#c9d1d9", fontFamily:"'Fira Mono','Courier New',monospace", fontSize:13 }}>
      {/* status bar */}
      <div style={{ background:"#161b22", borderBottom:"1px solid #30363d", padding:"2px 12px", fontSize:11, color:statusColor, display:"flex", justifyContent:"space-between" }}>
        <span>● {status}</span>
        <span style={{ color:"#8b949e" }}>{connection?.user}@{connection?.host}:{connection?.port}</span>
      </div>
      {/* output */}
      <div style={{ flex:1, overflowY:"auto", overflowX:"auto", padding:"8px 12px", whiteSpace:"pre", minWidth:0, lineHeight:1.5 }}>
        {lines.map((l, i) => <span key={i}>{l}</span>)}
        <div ref={bottomRef} />
      </div>
      {/* i-search */}
      {search.active && (
        <div style={{ background:"#161b22", borderTop:"1px solid #30363d", padding:"4px 12px", display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ color:"#f0883e" }}>i-search:</span>
          <input autoFocus value={search.query} onChange={handleSearchChange} onKeyDown={handleKeyDown}
            style={{ flex:1, background:"transparent", border:"none", outline:"none", color:"#c9d1d9", fontFamily:"inherit", fontSize:13 }} placeholder="search history…" />
          {search.match && <span style={{ color:"#79c0ff", fontSize:12 }}>{search.match}</span>}
          <span style={{ color:"#8b949e", fontSize:11 }}>↵ select · Esc cancel</span>
        </div>
      )}
      {/* input */}
      <div style={{ display:"flex", alignItems:"center", borderTop:"1px solid #30363d", padding:"6px 12px", background:"#161b22" }}>
        <span style={{ color:"#56d364", marginRight:6 }}>{connection?.user}@{connection?.host}:~$</span>
        <input ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
          style={{ flex:1, background:"transparent", border:"none", outline:"none", color:"#c9d1d9", fontFamily:"inherit", fontSize:13 }}
          spellCheck={false} autoComplete="off" />
      </div>
    </div>
  );
}

// ── Split view ─────────────────────────────────────────────────────────────────
function SplitView({ panes, connection, history, onCommand, onClose }) {
  return (
    <div style={{ display:"flex", flexDirection:"row", height:"100%", gap:2 }}>
      {panes.map(p => (
        <div key={p.id} style={{ flex:1, minWidth:0, position:"relative", border:"1px solid #30363d" }}>
          {panes.length > 1 && (
            <button onClick={() => onClose(p.id)} style={{ position:"absolute", top:4, right:6, zIndex:10, background:"transparent", border:"none", color:"#8b949e", cursor:"pointer", fontSize:12 }}>✕</button>
          )}
          <TerminalPane connection={connection} history={history} onCommand={onCommand} />
        </div>
      ))}
    </div>
  );
}

// ── App ────────────────────────────────────────────────────────────────────────
export default function App() {
  const [hosts, setHosts]     = useState([]);
  const [history, setHistory] = useState([]);
  const [tabs, setTabs]       = useState([]);
  const [activeTab, setActiveTab] = useState(null);
  const [backendOk, setBackendOk] = useState(null);
  const loaded = useRef(false);

  // load history from storage + fetch hosts from backend
  useEffect(() => {
    (async () => {
      try { const r = await window.storage.get(STORAGE_KEY_HISTORY); if (r) setHistory(JSON.parse(r.value)); } catch {}
      loaded.current = true;
      // probe backend
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

  useEffect(() => {
    if (!loaded.current) return;
    window.storage.set(STORAGE_KEY_HISTORY, JSON.stringify(history.slice(-500))).catch(()=>{});
  }, [history]);

  const addCommand = useCallback((cmd) => {
    setHistory(h => [...h.filter(x => x !== cmd), cmd]);
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
          {/* new tab picker */}
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
          <SplitView panes={activeTabObj.panes} connection={activeTabObj.conn}
            history={history} onCommand={addCommand} onClose={closePane} />
        )}
      </div>
    </div>
  );
}

const btn = { background:"transparent", border:"1px solid #30363d", borderRadius:6, color:"#c9d1d9", cursor:"pointer", padding:"4px 10px", fontSize:12, fontFamily:"inherit" };