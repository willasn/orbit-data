import { useEffect } from "react";
import { useStore } from "./store";
import LeftPanel from "./components/LeftPanel";
import MainArea from "./components/ChatView";
import SqlEditorPanel from "./components/SqlEditorPanel";
import SettingsView from "./components/SettingsView";
import ConnectionDialog from "./components/ConnectionDialog";
import CreateObjectDialog from "./components/CreateObjectDialog";
import AskDialog from "./components/AskDialog";
import PanelResizer from "./components/PanelResizer";
import AutoUpdateBanner from "./components/AutoUpdateBanner";

export default function App() {
  const {
    init,
    view,
    showLeft,
    showRight,
    leftWidth,
    rightWidth,
    setPaneWidth,
    toast,
    createTarget,
  } = useStore();
  const activeTabKind = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.kind);

  useEffect(() => {
    init().catch((e) => console.error("初始化失败", e));
  }, [init]);

  return (
    <div className="app-shell">
      {view === "chat" ? (
        <div className="app-columns">
          <LeftPanel />
          {showLeft && (
            <PanelResizer side="left" width={leftWidth} onResize={(w) => setPaneWidth("left", w)} />
          )}
          <MainArea />
          {showRight && (
            <PanelResizer side="right" width={rightWidth} onResize={(w) => setPaneWidth("right", w)} />
          )}
          {showRight && <SqlEditorPanel disabled={activeTabKind === "messaging" || activeTabKind === "storage"} />}
        </div>
      ) : (
        <SettingsView />
      )}
      <ConnectionDialog />
      {createTarget && <CreateObjectDialog key={`${createTarget.connId}:${createTarget.kind}:${createTarget.database ?? ""}`} />}
      <AskDialog />
      <AutoUpdateBanner />
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
