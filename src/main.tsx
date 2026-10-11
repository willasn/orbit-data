import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// 桌面应用:禁用浏览器原生右键菜单
document.addEventListener("contextmenu", (e) => e.preventDefault(), { capture: true });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
