import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { getAgentBridge } from "./agent";
import { initLanguage } from "./i18n/bootstrap";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");

// 首屏前读一次语言（不 await：读不到就保持中文默认，不阻塞渲染）。
void initLanguage(getAgentBridge());

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
