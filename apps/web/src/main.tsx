import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/700.css";
import { App } from "./app.js";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("Saturn web root is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
