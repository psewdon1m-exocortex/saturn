import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("Saturn web root is missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
